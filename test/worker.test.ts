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
const env = { LASTFM_API_KEY: "key" };
const get = (path: string, e: { LASTFM_API_KEY?: string } = env) => worker.fetch(new Request(`https://t.dev${path}`), e, ctx);
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
  it("serves the landing page, health and 404", async () => {
    expect((await get("/")).headers.get("content-type")).toContain("text/html");
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
    expect(res.headers.get("x-tidemark-state")).toBe("playing");
    expect(svg).toContain("NOW PLAYING");
    expect(svg).toContain("data:image/png;base64,");
    await flush();
    const before = fetchCalls.length;
    const again = await get("/api/now?user=RJ&junk=1");
    expect(again.headers.get("x-tidemark-cache")).toBe("hit");
    expect(fetchCalls.length).toBe(before);
  });

  it("answers bad input with a card, not an error status", async () => {
    for (const q of ["", "?user=a%20b", "?user=../x"]) {
      const res = await get(`/api/now${q}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-tidemark-state")).toBe("bad-user");
    }
  });

  it("says so when the server has no key", async () => {
    const res = await get("/api/now?user=rj", {});
    expect(res.headers.get("x-tidemark-state")).toBe("no-key");
  });

  it("shows the quiet card for an empty history and the error card for unknown users", async () => {
    lastfm = () => Response.json({ recenttracks: { track: [] } });
    expect((await get("/api/now?user=empty")).headers.get("x-tidemark-state")).toBe("empty");
    lastfm = () => Response.json({ error: 6, message: "User not found" }, { status: 404 });
    expect((await get("/api/now?user=ghost")).headers.get("x-tidemark-state")).toBe("not_found");
  });

  it("falls back to a stale good card when Last.fm breaks", async () => {
    const first = await get("/api/now?user=rj&theme=minimal");
    expect(first.headers.get("x-tidemark-state")).toBe("playing");
    await flush();
    // Expire the fresh copy only; keep the day-long stale copy.
    for (const k of [...cache.store.keys()]) if (!k.endsWith("#stale")) cache.store.delete(k);
    lastfm = () => new Response("<html>bad gateway</html>", { status: 502 });
    const res = await get("/api/now?user=rj&theme=minimal");
    expect(res.headers.get("x-tidemark-state")).toBe("stale");
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
