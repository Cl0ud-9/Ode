import { describe, expect, it } from "vitest";
import { STUCK_AFTER, settle } from "../src/presence.ts";
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
