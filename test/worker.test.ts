import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoCover } from "../src/demo.ts";
import worker from "../src/index.ts";

class MemoryCache {
  store = new Map<string, Response>();
  async match(req: Request) {
    return this.store.get(req.url)?.clone();
  }
  async put(req: Request, res: Response) {
    this.store.set(req.url, res);
  }
}

const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} } as unknown as ExecutionContext;
// These tests exercise the plain path for arbitrary users, so they run as an open deployment (see OPEN_TO_ALL).
const env = { LASTFM_API_KEY: "key", OPEN_TO_ALL: "true" };
const get = (path: string, e: { LASTFM_API_KEY?: string; OPEN_TO_ALL?: string; LASTFM_USER?: string } = env) => worker.fetch(new Request(`https://t.dev${path}`), e, ctx);
const flush = () => new Promise((r) => setTimeout(r, 5));

let cache: MemoryCache;
let lastfm: () => Response;
let fetchCalls: string[];

beforeEach(() => {
  cache = new MemoryCache();
  fetchCalls = [];
  (globalThis as unknown as { caches: unknown }).caches = { default: cache };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchCalls.push(url);
    if (url.startsWith("https://ws.audioscrobbler.com/")) return lastfm();
    if (url.includes("lastfm.freetls.fastly.net")) return new Response(demoCover(url.includes("174s") ? 112 : 64));
    return new Response("nope", { status: 404 });
  });
  lastfm = () => playing();
});

afterEach(() => vi.unstubAllGlobals());

const playing = () =>
  Response.json({
    recenttracks: {
      track: [{ name: "Song", artist: { "#text": "Band" }, album: { "#text": "Rec" }, image: [{ "#text": "https://lastfm.freetls.fastly.net/i/u/300x300/abc.png", size: "extralarge" }], "@attr": { nowplaying: "true" } }],
    },
  });

describe("worker routes", () => {
  it("hands the website to the static assets, and serves health and 404", async () => {
    const asked: string[] = [];
    const ASSETS = { fetch: async (r: Request) => (asked.push(new URL(r.url).pathname), new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } })) };
    const site = await worker.fetch(new Request("https://t.dev/"), { ...env, ASSETS } as never, ctx);
    expect(site.headers.get("content-type")).toContain("text/html");
    expect(asked).toEqual(["/"]);
    expect(await (await get("/health")).text()).toBe("ok");
    expect((await get("/nope")).status).toBe(404);
    expect((await worker.fetch(new Request("https://t.dev/api/now", { method: "POST" }), env, ctx)).status).toBe(405);
  });

  it("renders demo cards without a key or network", async () => {
    const res = await get("/api/now?demo=playing", {});
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    expect(await res.text()).toContain("NOW PLAYING");
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("/api/now", () => {
  it("renders a live card with embedded art, then serves repeats from cache", async () => {
    const res = await get("/api/now?user=rj");
    const svg = await res.text();
    expect(res.headers.get("x-ode-state")).toBe("playing art=lastfm");
    expect(svg).toContain("NOW PLAYING");
    expect(svg).toContain("data:image/png;base64,");
    await flush();
    const before = fetchCalls.length;
    const again = await get("/api/now?user=RJ&junk=1");
    expect(again.headers.get("x-ode-cache")).toBe("hit");
    expect(fetchCalls.length).toBe(before);
  });

  it("answers bad input with a card, not an error status", async () => {
    for (const q of ["", "?user=a%20b", "?user=../x"]) {
      const res = await get(`/api/now${q}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-ode-state")).toBe("bad-user");
    }
  });

  it("says so when the server has no key", async () => {
    const res = await get("/api/now?user=rj", { OPEN_TO_ALL: "true" });
    expect(res.headers.get("x-ode-state")).toBe("no-key");
  });

  it("shows the quiet card for an empty history and the error card for unknown users", async () => {
    lastfm = () => Response.json({ recenttracks: { track: [] } });
    expect((await get("/api/now?user=empty")).headers.get("x-ode-state")).toBe("empty");
    lastfm = () => Response.json({ error: 6, message: "User not found" }, { status: 404 });
    expect((await get("/api/now?user=ghost")).headers.get("x-ode-state")).toBe("not_found");
  });

  it("falls back to a stale good card when Last.fm breaks", async () => {
    const first = await get("/api/now?user=rj&theme=minimal");
    expect(first.headers.get("x-ode-state")).toBe("playing art=lastfm");
    await flush();
    // Expire the fresh copy only; keep the day-long stale copy.
    for (const k of [...cache.store.keys()]) if (!k.endsWith("#stale")) cache.store.delete(k);
    lastfm = () => new Response("<html>bad gateway</html>", { status: 502 });
    const res = await get("/api/now?user=rj&theme=minimal");
    expect(res.headers.get("x-ode-state")).toBe("stale");
    expect(await res.text()).toContain("NOW PLAYING");
  });

  it("still renders without art when the cover cannot be fetched", async () => {
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      String(input).includes("fastly.net") ? new Response("", { status: 500 }) : original(input),
    );
    const svg = await (await get("/api/now?user=noart")).text();
    expect(svg).toContain("NOW PLAYING");
    expect(svg).not.toContain("data:image");
  });
});

describe("cover lookups that are slow or throttled", () => {
  const noArt = () =>
    Response.json({ recenttracks: { track: [{ name: "Roslyn", artist: { "#text": "Rishab Rikhiram Sharma" }, album: { "#text": "" }, image: [{ "#text": "", size: "extralarge" }], "@attr": { nowplaying: "true" } }] } });

  it("uses Last.fm's own track info for a cover when the scrobble had none", async () => {
    lastfm = noArt;
    const base = (globalThis as { fetch: typeof fetch }).fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("method=track.getinfo")) {
        return Response.json({ track: { album: { image: [{ "#text": "https://lastfm.freetls.fastly.net/i/u/300x300/zzz.png", size: "extralarge" }] } } });
      }
      if (url.includes("itunes.apple.com") || url.includes("musicbrainz.org")) return new Response("blocked", { status: 429 });
      return base(input);
    });
    const res = await get("/api/now?user=rj");
    expect(res.headers.get("x-ode-state")).toBe("playing art=lastfm-info");
    expect(await res.text()).toContain("<image");
  });

  it("draws the placeholder at once when lookups are slow, and the next card has the cover", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      lastfm = noArt;
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => { release = r; });
      const base = (globalThis as { fetch: typeof fetch }).fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("method=track.getinfo")) {
          await gate;
          return Response.json({ track: { album: { image: [{ "#text": "https://lastfm.freetls.fastly.net/i/u/300x300/zzz.png", size: "extralarge" }] } } });
        }
        return base(input);
      });
      const pending = get("/api/now?user=slow");
      await vi.advanceTimersByTimeAsync(3000);
      const first = await pending;
      expect(first.headers.get("x-ode-state")).toBe("playing art=pending");
      expect(await first.text()).not.toContain("<image");
      release();
      await vi.advanceTimersByTimeAsync(100);
      // A different cache key forces a new render, which finds the cover the background lookup stored.
      const next = await get("/api/now?user=slow&theme=minimal");
      expect(next.headers.get("x-ode-state")).toBe("playing art=cache");
      expect(await next.text()).toContain("<image");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("scheduled warm-up", () => {
  const kv = () => {
    const m = new Map<string, string>();
    return { m, ns: { get: async (k: string) => (m.has(k) ? JSON.parse(m.get(k)!) : null), put: async (k: string, v: string) => { m.set(k, v); } } as unknown as KVNamespace };
  };
  const trackWithoutCover = () =>
    Response.json({ recenttracks: { track: [{ name: "Roslyn", artist: { "#text": "Rishab Rikhiram Sharma" }, album: { "#text": "" }, image: [], "@attr": { nowplaying: "true" } }] } });

  it("stores the current track's official cover so the next card is instant", async () => {
    lastfm = trackWithoutCover;
    const base = (globalThis as { fetch: typeof fetch }).fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("method=track.getinfo")) return Response.json({});
      if (url.includes("itunes.apple.com")) {
        return Response.json({ results: [{ artistName: "Rishab Rikhiram Sharma", trackName: "Roslyn", artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/Music/x/y/100x100bb.jpg" }] });
      }
      if (url.includes("mzstatic.com")) return new Response(demoCover(url.includes("300x300") ? 112 : 64));
      return base(input);
    });
    const { m, ns } = kv();
    const pending: Promise<unknown>[] = [];
    const wctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    await worker.scheduled?.({} as ScheduledController, { LASTFM_API_KEY: "key", LASTFM_USER: "rj", ART: ns }, wctx);
    await Promise.all(pending);
    expect([...m.keys()].some((k) => !k.startsWith("cooldown"))).toBe(true);

    // The card now shows the stored cover without asking any catalogue.
    fetchCalls.length = 0;
    const res = await worker.fetch(new Request("https://t.dev/api/now?user=rj"), { LASTFM_API_KEY: "key", LASTFM_USER: "rj", ART: ns }, ctx);
    expect(res.headers.get("x-ode-state")).toBe("playing art=cache");
    expect(await res.text()).toContain("<image");
    expect(fetchCalls.some((u) => u.includes("itunes.apple.com"))).toBe(false);
  });

  it("does nothing without a user, a key, or with a bad username", async () => {
    const calls = fetchCalls.length;
    for (const e of [{ LASTFM_API_KEY: "k" }, { LASTFM_USER: "rj" }, { LASTFM_API_KEY: "k", LASTFM_USER: "not valid!" }]) {
      await worker.scheduled?.({} as ScheduledController, e, ctx);
    }
    expect(fetchCalls.length).toBe(calls);
  });
});

describe("a Last.fm hiccup", () => {
  it("is retried once before falling back to an error card", async () => {
    let calls = 0;
    lastfm = () => (++calls === 1 ? new Response("bad gateway", { status: 502 }) : playing());
    const res = await get("/api/now?user=hiccup");
    expect(calls).toBe(2);
    expect(res.headers.get("x-ode-state")).toMatch(/^playing/);
  });

  it("gives up after one retry", async () => {
    let calls = 0;
    lastfm = () => { calls++; return new Response("bad gateway", { status: 502 }); };
    const res = await get("/api/now?user=down");
    expect(calls).toBe(2);
    expect(res.headers.get("x-ode-state")).toBe("upstream");
  });
});

describe("how often the website should check", () => {
  it("asks for slow checks of cards that cost a Last.fm call each", async () => {
    const res = await get("/api/now?user=someone");
    expect(res.headers.get("x-ode-poll")).toBe("20000");
  });
});

describe("a deployment serves only its own users by default", () => {
  const own = { LASTFM_API_KEY: "key", LASTFM_USER: "rj" };

  it("draws its owner's card", async () => {
    const res = await get("/api/now?user=rj", own);
    expect(res.headers.get("x-ode-state")).toMatch(/^playing/);
  });

  it("answers anyone else with a private card and never touches its Last.fm key", async () => {
    fetchCalls.length = 0;
    const res = await get("/api/now?user=someone", own);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ode-state")).toBe("private");
    expect(await res.text()).toContain("Get your own card");
    expect(fetchCalls.some((u) => u.includes("audioscrobbler"))).toBe(false);
  });

  it("still shows the demo cards", async () => {
    expect((await get("/api/now?demo=playing", own)).headers.get("x-ode-state")).toBe("demo-playing");
  });

  it("serves anyone when OPEN_TO_ALL is set", async () => {
    const res = await get("/api/now?user=someone", { ...own, OPEN_TO_ALL: "true" });
    expect(res.headers.get("x-ode-state")).toMatch(/^playing/);
  });
});
