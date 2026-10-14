import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBackoff } from "../src/art.ts";
import { demoCover } from "../src/demo.ts";
import worker from "../src/index.ts";
import { POLL_MS, Presence, type Snapshot } from "../src/presence-do.ts";

/** Just enough of DurableObjectState for the presence object: a map and one alarm. */
function fakeState() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    get: async (k: string) => structuredClone(data.get(k)),
    put: async (k: string, v: unknown) => { data.set(k, structuredClone(v)); },
    delete: async (k: string) => data.delete(k),
    getAlarm: async () => alarm,
    setAlarm: async (t: number) => { alarm = t; },
  };
  return { state: { storage } as unknown as DurableObjectState, data, alarmAt: () => alarm };
}

let current: { title: string; artist: string; playing: boolean };
let lastfmFails = false;
let calls: string[];

const recent = () =>
  Response.json({
    recenttracks: {
      track: [{
        name: current.title,
        artist: { "#text": current.artist },
        album: { "#text": "" },
        image: [],
        ...(current.playing ? { "@attr": { nowplaying: "true" } } : { date: { uts: "1700000000" } }),
      }],
    },
  });

beforeEach(() => {
  resetBackoff();
  current = { title: "High", artist: "The Chainsmokers", playing: true };
  lastfmFails = false;
  calls = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const method = url.searchParams.get("method");
    calls.push(method ?? url.hostname);
    if (url.hostname === "ws.audioscrobbler.com") {
      if (method === "user.getrecenttracks") return lastfmFails ? new Response("bad gateway", { status: 502 }) : recent();
      if (method === "track.getinfo") {
        return Response.json({ track: { album: { image: [{ "#text": `https://lastfm.freetls.fastly.net/i/u/300x300/${url.searchParams.get("track")}.png`, size: "extralarge" }] } } });
      }
      return Response.json({ error: 6 });
    }
    if (url.hostname === "lastfm.freetls.fastly.net") return new Response(demoCover(url.pathname.includes("300x300") ? 112 : 64));
    return new Response("", { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const env = { LASTFM_API_KEY: "key" };
const snapshot = async (p: Presence, user = "Cl0ud-9") =>
  (await (await p.fetch(new Request(`https://presence/snapshot?user=${user}`))).json()) as Snapshot;
/** One alarm tick, including the poll it starts in the background. */
const tick = async (p: Presence) => { await p.alarm(); await p.idle(); await new Promise((d) => setTimeout(d, 0)); };
const lookups = () => calls.filter((c) => c === "track.getinfo").length;

describe("presence object", () => {
  it("answers the first request with the current track and its cover, and starts its own polling loop", async () => {
    const { state, alarmAt } = fakeState();
    const p = new Presence(state, env);
    const s = await snapshot(p);
    expect(s.ok).toBe(true);
    expect(s.np?.track.title).toBe("High");
    expect(s.np?.status).toBe("playing");
    expect(s.art?.dataUri.startsWith("data:image/")).toBe(true);
    expect(s.source).toBe("lastfm-info");
    expect(alarmAt()).not.toBeNull();
  });

  it("serves later requests from memory, without asking Last.fm again", async () => {
    const p = new Presence(fakeState().state, env);
    await snapshot(p);
    const before = calls.length;
    for (let i = 0; i < 5; i++) await snapshot(p);
    expect(calls.length).toBe(before);
  });

  it("looks the cover up once per track change, not on every poll", async () => {
    const p = new Presence(fakeState().state, env);
    await snapshot(p);
    const once = lookups();
    await tick(p);
    await tick(p);
    expect(lookups()).toBe(once);

    current = { title: "Closer", artist: "The Chainsmokers", playing: true };
    await tick(p); // the background poll notices the change and fetches the new cover straight away
    const s = await snapshot(p);
    expect(s.np?.track.title).toBe("Closer");
    expect(s.art).not.toBeNull();
    expect(lookups()).toBeGreaterThan(once);
  });

  it("polls every 5 seconds while playing and backs off when idle or failing", async () => {
    const { state, alarmAt } = fakeState();
    const p = new Presence(state, env);
    await snapshot(p);
    let t0 = Date.now();
    await tick(p);
    expect(alarmAt()! - t0).toBeGreaterThanOrEqual(POLL_MS.playing - 50);
    expect(alarmAt()! - t0).toBeLessThan(POLL_MS.idle);

    current = { ...current, playing: false };
    t0 = Date.now();
    await tick(p);
    expect(alarmAt()! - t0).toBeGreaterThanOrEqual(POLL_MS.idle - 50);
  });

  it("keeps the last good state through a short Last.fm outage", async () => {
    const p = new Presence(fakeState().state, env);
    await snapshot(p);
    lastfmFails = true;
    await tick(p);
    const s = await snapshot(p);
    expect(s.ok).toBe(true);
    expect(s.np?.track.title).toBe("High");
  });

  it("reports the outage when there is no good state to fall back on", async () => {
    lastfmFails = true;
    const s = await snapshot(new Presence(fakeState().state, env));
    expect(s.ok).toBe(false);
    expect(s.reason).toBe("upstream");
  });

  it("runs one poll for many simultaneous requests", async () => {
    const p = new Presence(fakeState().state, env);
    await Promise.all(Array.from({ length: 6 }, () => snapshot(p)));
    expect(calls.filter((c) => c === "user.getrecenttracks")).toHaveLength(1);
  });

  it("survives a restart: the saved snapshot is served before the first poll finishes", async () => {
    const { state } = fakeState();
    await snapshot(new Presence(state, env));
    const before = calls.length;
    const s = await snapshot(new Presence(state, env)); // a fresh instance, as after eviction
    expect(s.np?.track.title).toBe("High");
    expect(calls.length).toBe(before);
  });

  it("refuses an invalid user", async () => {
    const res = await new Presence(fakeState().state, env).fetch(new Request("https://presence/snapshot?user=not valid!"));
    expect(res.status).toBe(400);
  });
});

describe("worker with presence objects", () => {
  /** A namespace whose objects are real Presence instances, one per name. */
  function fakeNamespace() {
    const objects = new Map<string, Presence>();
    return {
      idFromName: (name: string) => name,
      get: (id: string) => {
        if (!objects.has(id)) objects.set(id, new Presence(fakeState().state, { LASTFM_API_KEY: "key" }));
        const o = objects.get(id)!;
        return { fetch: (url: string) => o.fetch(new Request(url)) };
      },
    } as unknown as DurableObjectNamespace;
  }
  const ctx = { waitUntil: () => {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const workerEnv = () => ({ LASTFM_API_KEY: "key", LASTFM_USER: "Cl0ud-9", PRESENCE: fakeNamespace() });
  beforeEach(() => {
    (globalThis as unknown as { caches: unknown }).caches = { default: { match: async () => undefined, put: async () => {} } };
  });

  it("serves a tracked user's card from the presence object, with the cover and no Last.fm call on repeat", async () => {
    const e = workerEnv();
    const first = await worker.fetch(new Request("https://t.dev/api/now?user=Cl0ud-9"), e, ctx);
    expect(first.headers.get("x-tidemark-state")).toMatch(/^playing art=lastfm-info via=presence/);
    expect(await first.text()).toContain("<image");
    const before = calls.length;
    const again = await worker.fetch(new Request("https://t.dev/api/now?user=cl0ud-9&theme=minimal"), e, ctx);
    expect(again.status).toBe(200);
    expect(calls.length).toBe(before);
    expect(again.headers.get("server-timing")).toMatch(/presence;dur=/);
  });

  it("lets the website check a tracked user's card often: each check is an in-memory read", async () => {
    const res = await worker.fetch(new Request("https://t.dev/api/now?user=Cl0ud-9"), workerEnv(), ctx);
    expect(res.headers.get("x-tidemark-poll")).toBe("4000");
  });

  it("answers an unchanged reload with a 304", async () => {
    const e = workerEnv();
    const first = await worker.fetch(new Request("https://t.dev/api/now?user=Cl0ud-9&still=1"), e, ctx);
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();
    // An explicit max-age=0: GitHub's proxy ignores a bare no-cache and would hold the card for a minute.
    expect(first.headers.get("cache-control")).toMatch(/max-age=0/);
    const again = await worker.fetch(new Request("https://t.dev/api/now?user=Cl0ud-9&still=1", { headers: { "If-None-Match": etag } }), e, ctx);
    expect(again.status).toBe(304);
  });

  it("uses the plain path for users it does not track", async () => {
    const e = workerEnv();
    const res = await worker.fetch(new Request("https://t.dev/api/now?user=someone"), e, ctx);
    expect(res.headers.get("x-tidemark-state")).not.toMatch(/via=presence/);
  });

  it("the cron keeps each tracked user's polling loop alive", async () => {
    const kicked: string[] = [];
    const ns = { idFromName: (n: string) => n, get: (id: string) => ({ fetch: async (u: string) => { kicked.push(`${id} ${new URL(u).pathname}`); return new Response("ok"); } }) } as unknown as DurableObjectNamespace;
    const waits: Promise<unknown>[] = [];
    await worker.scheduled({} as ScheduledController, { LASTFM_API_KEY: "key", LASTFM_USER: "Cl0ud-9, other_user", PRESENCE: ns }, { waitUntil: (p: Promise<unknown>) => void waits.push(p) } as unknown as ExecutionContext);
    await Promise.all(waits);
    expect(kicked.sort()).toEqual(["cl0ud-9 /kick", "other_user /kick"]);
  });
});

describe("presence object edge cases", () => {
  it("shows a new song at once when its cover is slow, then fills the cover in", async () => {
    const p = new Presence(fakeState().state, env);
    await snapshot(p);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.get("method") === "track.getinfo" && url.searchParams.get("track")?.startsWith("Slow")) await gate;
      return base(input);
    });
    current = { title: "Slow Song", artist: "Band", playing: true };
    await p.alarm(); // returns at once; the poll runs in the background
    const polling = p.idle();
    await new Promise((d) => setTimeout(d, 1_700));
    const early = await snapshot(p); // served from memory while the cover is still on its way
    expect(early.np?.track.title).toBe("Slow Song");
    expect(early.source).toBe("pending");
    expect(early.art).toBeNull();
    release();
    await polling;
    const late = await snapshot(p);
    expect(late.np?.track.title).toBe("Slow Song");
    expect(late.art).not.toBeNull();
  }, 10_000);

  it("stops polling for a user nobody asks about any more, and restarts on the next request", async () => {
    const { state } = fakeState();
    let sets = 0;
    const orig = state.storage.setAlarm.bind(state.storage);
    (state.storage as unknown as { setAlarm: (t: number) => Promise<void> }).setAlarm = async (t: number) => { sets++; await orig(t); };
    const p = new Presence(state, env);
    await snapshot(p);
    const t = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(t + 16 * 60_000);
    try {
      const before = sets;
      await tick(p);
      expect(sets).toBe(before); // no next alarm: the loop has ended
    } finally {
      spy.mockRestore();
    }
  });

  it("treats a different letter case as the same user and does not rewrite it", async () => {
    const { state, data } = fakeState();
    let userWrites = 0;
    const put = state.storage.put.bind(state.storage);
    (state.storage as unknown as { put: (k: string, v: unknown) => Promise<void> }).put = async (k: string, v: unknown) => { if (k === "user") userWrites++; await put(k, v); };
    const p = new Presence(state, env);
    await snapshot(p, "Cl0ud-9");
    await snapshot(p, "cl0ud-9");
    await snapshot(p, "CL0UD-9");
    expect(userWrites).toBe(1);
    expect(data.get("user")).toBe("Cl0ud-9");
  });

  it("the card falls back to the plain path when the presence object fails", async () => {
    const broken = { idFromName: (n: string) => n, get: () => ({ fetch: async () => { throw new Error("overloaded"); } }) } as unknown as DurableObjectNamespace;
    (globalThis as unknown as { caches: unknown }).caches = { default: { match: async () => undefined, put: async () => {} } };
    const ctx = { waitUntil: () => {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const res = await worker.fetch(new Request("https://t.dev/api/now?user=Cl0ud-9"), { LASTFM_API_KEY: "key", LASTFM_USER: "Cl0ud-9", PRESENCE: broken }, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-tidemark-state")).toMatch(/^playing/);
    expect(res.headers.get("x-tidemark-state")).not.toMatch(/via=presence/);
  });

  it("the card falls back when the presence object has no state yet or answers an error", async () => {
    (globalThis as unknown as { caches: unknown }).caches = { default: { match: async () => undefined, put: async () => {} } };
    const ctx = { waitUntil: () => {}, passThroughOnException() {} } as unknown as ExecutionContext;
    for (const answer of [() => Response.json(null), () => new Response("boom", { status: 500 })]) {
      const ns = { idFromName: (n: string) => n, get: () => ({ fetch: async () => answer() }) } as unknown as DurableObjectNamespace;
      const res = await worker.fetch(new Request("https://t.dev/api/now?user=Cl0ud-9"), { LASTFM_API_KEY: "key", LASTFM_USER: "Cl0ud-9", PRESENCE: ns }, ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-tidemark-state")).not.toMatch(/via=presence/);
    }
  });

  it("a tracked user with fallback=artist uses the plain path, which can honour it", async () => {
    (globalThis as unknown as { caches: unknown }).caches = { default: { match: async () => undefined, put: async () => {} } };
    const ctx = { waitUntil: () => {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const ns = { idFromName: (n: string) => n, get: () => ({ fetch: async () => { throw new Error("must not be called"); } }) } as unknown as DurableObjectNamespace;
    const res = await worker.fetch(new Request("https://t.dev/api/now?user=Cl0ud-9&fallback=artist"), { LASTFM_API_KEY: "key", LASTFM_USER: "Cl0ud-9", PRESENCE: ns }, ctx);
    expect(res.status).toBe(200);
  });
});

describe("the alarm handler stays short", () => {
  it("returns before the Last.fm call finishes, so card requests never queue behind it", async () => {
    const p = new Presence(fakeState().state, env);
    await snapshot(p);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (new URL(String(input)).searchParams.get("method") === "user.getrecenttracks") await gate;
      return base(input);
    });
    let returned = false;
    await p.alarm().then(() => { returned = true; });
    expect(returned).toBe(true); // the handler is done although Last.fm has not answered
    const served = await snapshot(p); // and a card request is answered from memory meanwhile
    expect(served.np?.track.title).toBe("High");
    release();
    await p.idle();
  });
});

describe("adding a Genius token does not slow cards down", () => {
  it("card requests stay instant while a slow Genius lookup runs in the background, and never call Genius themselves", async () => {
    const geniusCalls: number[] = [];
    let requestInProgress = false;
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "ws.audioscrobbler.com" && url.searchParams.get("method") !== "user.getrecenttracks" && url.searchParams.get("track")?.startsWith("Split")) {
        return Response.json({ error: 6 }); // Last.fm has no cover for the new song
      }
      if (url.hostname === "api.genius.com") {
        expect(requestInProgress).toBe(false); // never on a card request's path
        // Sources search in parallel, so Genius is also asked about "High"; only the new song's calls count here.
        if (url.searchParams.get("q")?.startsWith("Split")) geniusCalls.push(Date.now());
        await new Promise((d) => setTimeout(d, 2_000)); // a deliberately slow Genius
        return Response.json({ response: { hits: [{ result: { title: "Split (Only U)", primary_artist: { name: "Tiësto" }, song_art_image_thumbnail_url: "https://images.genius.com/split.300x300x1.jpg" } }] } });
      }
      if (url.hostname === "images.genius.com") return new Response(demoCover(112));
      return base(input);
    });

    const p = new Presence(fakeState().state, { LASTFM_API_KEY: "key", GENIUS_TOKEN: "tok" });
    await snapshot(p); // "High", which Last.fm has a cover for

    current = { title: "Split (Only U)", artist: "Tiësto", playing: true };
    await p.alarm(); // returns at once; the poll and the slow Genius lookup run in the background

    // While Genius takes its 2 seconds, card requests keep arriving and must each answer from memory, instantly.
    const timings: number[] = [];
    for (let i = 0; i < 8; i++) {
      requestInProgress = true;
      const t0 = performance.now();
      await snapshot(p);
      timings.push(performance.now() - t0);
      requestInProgress = false;
      await new Promise((d) => setTimeout(d, 200));
    }
    expect(Math.max(...timings)).toBeLessThan(50);

    await p.idle();
    const done = await snapshot(p);
    expect(done.np?.track.title).toBe("Split (Only U)");
    expect(done.source).toBe("genius");
    expect(done.art).not.toBeNull();
    expect(geniusCalls).toHaveLength(1);

    // Later polls of the same song do not ask Genius again: the cover is kept.
    await tick(p);
    await tick(p);
    expect(geniusCalls).toHaveLength(1);
  }, 15_000);
});

describe("the very first request after a deploy", () => {
  it("waits at most about 2 seconds even if the first cover lookup is slow", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (new URL(String(input)).searchParams.get("method") === "track.getinfo") await gate; // a very slow lookup
      return base(input);
    });
    const p = new Presence(fakeState().state, env);
    const t0 = performance.now();
    const s = await snapshot(p);
    const waited = performance.now() - t0;
    expect(waited).toBeLessThan(2_600);
    expect(s.np?.track.title).toBe("High"); // the song is there already
    expect(s.source).toBe("pending"); // and the cover follows
    release();
    await p.idle();
    expect((await snapshot(p)).art).not.toBeNull();
  }, 10_000);
});

describe("a late alarm", () => {
  it("never makes a card request wait for Last.fm while a recent snapshot exists, and catches up in the background", async () => {
    const p = new Presence(fakeState().state, env);
    await snapshot(p); // High
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (new URL(String(input)).searchParams.get("method") === "user.getrecenttracks") await new Promise((d) => setTimeout(d, 600)); // a slow Last.fm
      return base(input);
    });
    current = { title: "Split (Only U)", artist: "Tiësto", playing: true };
    const later = Date.now() + 20_000; // the alarm is late: the snapshot is 20 seconds old
    vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      const t0 = performance.now();
      const stale = await snapshot(p);
      expect(performance.now() - t0).toBeLessThan(100);
      expect(stale.np?.track.title).toBe("High"); // seconds old, answered at once
      await p.idle();
      expect((await snapshot(p)).np?.track.title).toBe("Split (Only U)"); // the background poll caught up
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("a warm card request", () => {
  it("does no storage I/O, so it never queues behind a poll's writes", async () => {
    const { state } = fakeState();
    const p = new Presence(state, env);
    await snapshot(p);
    const s = state.storage as unknown as Record<string, (...a: unknown[]) => unknown>;
    const used: string[] = [];
    for (const name of ["get", "put", "getAlarm", "setAlarm"]) {
      const real = s[name]!;
      s[name] = (...a: unknown[]) => { used.push(name); return real(...a); };
    }
    for (let i = 0; i < 5; i++) await snapshot(p);
    expect(used).toEqual([]);
  });

  it("still restarts a loop that died, on the cron's next kick", async () => {
    const { state, alarmAt } = fakeState();
    const p = new Presence(state, env);
    await snapshot(p);
    await state.storage.setAlarm(null as never); // the alarm chain broke while the object stayed in memory
    expect(alarmAt()).toBeNull();
    await p.fetch(new Request("https://presence/kick?user=Cl0ud-9"));
    expect(alarmAt()).not.toBeNull();
  });
});

describe("new secrets", () => {
  it("restart the object on the cron's next kick, at most once per 10 minutes, and never on a card request", async () => {
    const { settingsPrint } = await import("../src/config.ts");
    const { state } = fakeState();
    let aborted = 0;
    (state as unknown as { abort: () => void }).abort = () => { aborted++; };
    const p = new Presence(state, env);
    const kick = (cfg: string) => p.fetch(new Request(`https://presence/kick?user=Cl0ud-9&cfg=${cfg}`));

    await kick(settingsPrint(env)); // same settings: nothing happens
    expect(aborted).toBe(0);

    const newer = settingsPrint({ ...env, YOUTUBE_API_KEY: "k" });
    expect(newer).not.toBe(settingsPrint(env));
    await snapshot(p); // a card request never restarts anything
    expect(aborted).toBe(0);

    await kick(newer);
    expect(aborted).toBe(1);
    await kick(newer); // a disagreeing rollout cannot make it loop
    expect(aborted).toBe(1);
  });

  it("are fingerprinted without the values and without stray whitespace", async () => {
    const { settingsPrint } = await import("../src/config.ts");
    expect(settingsPrint({ LASTFM_API_KEY: "abc" })).toBe(settingsPrint({ LASTFM_API_KEY: " abc\n" }));
    expect(settingsPrint({ LASTFM_API_KEY: "abc" })).not.toContain("abc");
  });
});

describe("the song's mood", () => {
  it("is looked up once per song and kept in the snapshot", async () => {
    const base = globalThis.fetch;
    let asked = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = new URL(String(input)).searchParams.get("method");
      if (method === "track.gettoptags") {
        asked++;
        return Response.json({ toptags: { tag: [{ name: "edm", count: 100 }] } });
      }
      return base(input, init);
    });
    const p = new Presence(fakeState().state, env);
    expect((await snapshot(p)).mood).toBe("intense");
    await tick(p);
    await tick(p);
    expect((await snapshot(p)).mood).toBe("intense");
    expect(asked).toBe(1);
  });
});
