import { describe, expect, it } from "vitest";
import { HOLD_FOR, STUCK_AFTER, settle } from "../src/presence.ts";
import type { NowPlaying } from "../src/model.ts";
import { cacheStore, type Store } from "../src/store.ts";

const memory = (): Store => {
  const m = new Map<string, unknown>();
  return { get: async (k) => (m.get(k) as never) ?? null, put: async (k, v) => { m.set(k, v); } };
};

const np = (title = "Song", status: NowPlaying["status"] = "playing"): NowPlaying => ({
  user: "Someone",
  status,
  track: { title, artist: "Band", album: "Record", artUrl: null, playedAt: null },
});

describe("settle", () => {
  it("trusts a track that has only just started playing", async () => {
    const c = memory();
    expect((await settle(c, np(), 1000)).status).toBe("playing");
    expect((await settle(c, np(), 1000 + STUCK_AFTER)).status).toBe("playing");
  });

  it("turns a track that has been 'playing' too long into last-played, dated from first sight", async () => {
    const c = memory();
    await settle(c, np(), 1000);
    const out = await settle(c, np(), 1000 + STUCK_AFTER + 1);
    expect(out.status).toBe("idle");
    expect(out.track.playedAt).toBe(1000);
  });

  it("starts the clock again when the track changes", async () => {
    const c = memory();
    await settle(c, np("One"), 1000);
    expect((await settle(c, np("Two"), 1000 + STUCK_AFTER + 50)).status).toBe("playing");
  });

  it("leaves idle tracks alone and survives a broken cache", async () => {
    const c = memory();
    expect(await settle(c, np("Song", "idle"), 5)).toEqual(np("Song", "idle"));
    const broken = cacheStore({ match: async () => { throw new Error("boom"); }, put: async () => { throw new Error("boom"); } } as unknown as Cache, "https://x.dev");
    expect((await settle(broken, np(), 5)).status).toBe("playing");
  });

  it("keeps each user's clock separate", async () => {
    const c = memory();
    await settle(c, { ...np(), user: "a" }, 0);
    expect((await settle(c, { ...np(), user: "b" }, STUCK_AFTER + 10)).status).toBe("playing");
  });
});

describe("Last.fm dropping the playing flag", () => {
  const playing = (title: string) => np(title, "playing");
  const idle = (title: string) => ({ ...np(title, "idle"), track: { ...np(title).track, playedAt: 500 } });

  it("keeps a track playing through a response that briefly says the previous song was last played", async () => {
    const c = memory();
    await settle(c, playing("B"), 1000); // B is playing
    const flap = await settle(c, idle("A"), 1010); // Last.fm momentarily reports A as the latest scrobble
    expect(flap.status).toBe("playing");
    expect(flap.track.title).toBe("B");
    expect((await settle(c, playing("B"), 1020)).track.title).toBe("B"); // and it recovers
  });

  it("does not flip back and forth across repeated refreshes", async () => {
    const c = memory();
    const seq = [playing("B"), idle("A"), playing("B"), idle("A"), idle("A"), playing("B")];
    const titles: string[] = [];
    for (const [i, n] of seq.entries()) titles.push((await settle(c, n, 2000 + i * 5)).track.title);
    expect(new Set(titles)).toEqual(new Set(["B"]));
  });

  it("stops holding after the window, so a track that really ended is shown as last played", async () => {
    const c = memory();
    await settle(c, playing("B"), 1000);
    const later = await settle(c, idle("A"), 1000 + HOLD_FOR + 1);
    expect(later.status).toBe("idle");
    expect(later.track.title).toBe("A");
  });

  it("shows a finished track as last played, not as still playing", async () => {
    const c = memory();
    await settle(c, playing("B"), 1000);
    const done = await settle(c, idle("B"), 1030); // B was scrobbled: the newest entry is B itself
    expect(done.status).toBe("idle");
    expect(done.track.title).toBe("B");
  });

  it("does not hold anything for a user who was never seen playing", async () => {
    expect((await settle(memory(), idle("A"), 1000)).status).toBe("idle");
  });

  it("writes to the store only when the track changes or about every 45 seconds", async () => {
    let writes = 0;
    const m = new Map<string, unknown>();
    const c: Store = { get: async (k) => (m.get(k) as never) ?? null, put: async (k, v) => { writes++; m.set(k, v); } };
    for (let t = 0; t < 120; t += 5) await settle(c, playing("B"), 1000 + t); // 24 refreshes over two minutes
    expect(writes).toBeLessThanOrEqual(4);
  });
});
