import { describe, expect, it } from "vitest";
import { HOLD_FOR, LOOP_DUE, LOOP_MAX, LOOP_MIN, LOOP_SLACK, NEW_PLAY_AFTER, STUCK_AFTER, settle } from "../src/presence.ts";
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
    await settle(c, np(), 1000 + STUCK_AFTER / 2); // looked at now and then while it "plays"
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

describe("the same song played again", () => {
  const playing = (title = "Song", lastScrobbleAt?: number): NowPlaying => ({ ...np(title, "playing"), ...(lastScrobbleAt ? { lastScrobbleAt } : {}) });
  const finished = (title: string, at: number): NowPlaying => ({ ...np(title, "idle"), track: { ...np(title).track, playedAt: at } });

  it("shows a song played again hours later as playing, once it was seen finished", async () => {
    const c = memory();
    await settle(c, playing(), 1000);
    await settle(c, finished("Song", 1000), 1200); // it ended; nothing else was played
    const again = await settle(c, playing(), 1000 + 3 * 3600);
    expect(again.status).toBe("playing");
    // ...and its own clock runs from now, so it is called stuck only STUCK_AFTER later
    expect((await settle(c, playing(), 1000 + 3 * 3600 + STUCK_AFTER / 2)).status).toBe("playing");
  });

  it("shows it as playing even when nobody looked while it was finished (no idle sighting)", async () => {
    const c = memory();
    await settle(c, playing(), 1000);
    expect((await settle(c, playing(), 1000 + 3 * 3600)).status).toBe("playing");
  });

  it("starts the clock again after a gap longer than NEW_PLAY_AFTER", async () => {
    const c = memory();
    await settle(c, playing(), 1000);
    expect((await settle(c, playing(), 1000 + NEW_PLAY_AFTER + 1)).status).toBe("playing");
  });

  it("starts the clock again when something was scrobbled after it started", async () => {
    const c = memory();
    await settle(c, playing(), 1000);
    // Seen every few minutes, so no gap; meanwhile it ended, other songs played, and now it plays again.
    for (let t = 1000; t <= 1000 + STUCK_AFTER; t += 240) await settle(c, playing("Song", t > 1600 ? 1600 : undefined), t);
    expect((await settle(c, playing("Song", 1600), 1000 + STUCK_AFTER + 60)).status).toBe("playing");
    // and stuck detection still works from the new start
    const stuck = await settle(c, playing("Song", 1600), 1600 + STUCK_AFTER + 1);
    expect(stuck.status).toBe("idle");
    expect(stuck.track.playedAt).toBe(1600);
  });

  it("keeps a song on repeat playing, from the scrobble of each play", async () => {
    const c = memory();
    let t = 1000;
    for (let play = 0; play < 8; play++, t += 200) {
      expect((await settle(c, playing("Loop", play ? t - 200 : undefined), t)).status).toBe("playing");
      expect((await settle(c, playing("Loop", play ? t - 200 : undefined), t + 100)).status).toBe("playing");
    }
  });

  it("ignores a scrobble date from the future or from before the clock started", async () => {
    const c = memory();
    await settle(c, playing(), 1000);
    await settle(c, playing("Song", 999_999), 1000 + STUCK_AFTER / 2);
    const out = await settle(c, playing("Song", 500), 1000 + STUCK_AFTER + 1);
    expect(out.status).toBe("idle");
    expect(out.track.playedAt).toBe(1000);
  });

  it("does not hold a finished song over a lagging response that names an older one", async () => {
    const c = memory();
    await settle(c, playing("B"), 1000);
    await settle(c, finished("B", 1000), 1030); // B finished
    const lag = await settle(c, finished("A", 900), 1040); // a stale replica still says A
    expect(lag.status).toBe("idle");
    expect(lag.track.title).toBe("A");
  });

  it("marks a play finished with one write, not one per refresh", async () => {
    let writes = 0;
    const m = new Map<string, unknown>();
    const c: Store = { get: async (k) => (m.get(k) as never) ?? null, put: async (k, v) => { writes++; m.set(k, v); } };
    await settle(c, playing(), 1000);
    for (let t = 1030; t < 1300; t += 5) await settle(c, finished("Song", 1000), t);
    // the play starting, the scrobble remembered for a later loop, and the play marked finished: three, however often it is asked
    expect(writes).toBe(3);
  });
});

describe("a song on repeat that Last.fm stops flagging as playing", () => {
  const scrobbled = (title: string, at: number): NowPlaying => ({ ...np(title, "idle"), track: { ...np(title).track, playedAt: at } });
  const LOOP = 150;

  it("stays shown as playing from the second scrobble of the same song, until the next is due", async () => {
    const c = memory();
    expect((await settle(c, scrobbled("Loop", 1000), 1090)).status).toBe("idle"); // one scrobble tells nothing yet
    const out = await settle(c, scrobbled("Loop", 1000 + LOOP), 1000 + LOOP + 90);
    expect(out.status).toBe("playing");
    expect(out.track.playedAt).toBeNull();
    const due = 1000 + LOOP + LOOP * LOOP_DUE + LOOP_SLACK;
    expect((await settle(c, scrobbled("Loop", 1000 + LOOP), due)).status).toBe("playing");
    expect((await settle(c, scrobbled("Loop", 1000 + LOOP), due + 1)).status).toBe("idle"); // nothing came: it stopped
  });

  it("keeps going for as long as the scrobbles keep coming", async () => {
    const c = memory();
    for (let play = 0; play < 10; play++) {
      const at = 1000 + play * LOOP;
      await settle(c, scrobbled("Loop", at), at + 90); // scrobbled a little over halfway through
      const later = await settle(c, scrobbled("Loop", at), at + LOOP + 60); // the next play is under way, its scrobble not yet in
      if (play) expect(later.status).toBe("playing");
    }
  });

  it("does not take two plays far apart, or a double submission, for a loop", async () => {
    const c = memory();
    await settle(c, scrobbled("Song", 1000), 1090);
    expect((await settle(c, scrobbled("Song", 1000 + LOOP_MAX + 1), 1000 + LOOP_MAX + 100)).status).toBe("idle");
    await settle(c, scrobbled("Dup", 5000), 5090);
    expect((await settle(c, scrobbled("Dup", 5000 + LOOP_MIN - 1), 5000 + LOOP_MIN + 50)).status).toBe("idle");
  });

  it("forgets the loop when another song plays in between", async () => {
    const c = memory();
    await settle(c, scrobbled("A", 1000), 1090);
    await settle(c, scrobbled("A", 1000 + LOOP), 1000 + LOOP + 90); // a loop
    await settle(c, np("B", "playing"), 1000 + 2 * LOOP);
    await settle(c, scrobbled("B", 1000 + 2 * LOOP), 1000 + 2 * LOOP + 400);
    expect((await settle(c, scrobbled("A", 1000 + 3 * LOOP), 1000 + 3 * LOOP + 90)).status).toBe("idle");
  });

  it("ignores a lagging answer that names an older scrobble, and writes once per scrobble", async () => {
    let writes = 0;
    const m = new Map<string, unknown>();
    const c: Store = { get: async (k) => (m.get(k) as never) ?? null, put: async (k, v) => { writes++; m.set(k, v); } };
    await settle(c, scrobbled("Loop", 1000), 1090);
    await settle(c, scrobbled("Loop", 1000 + LOOP), 1000 + LOOP + 90);
    const before = writes;
    expect((await settle(c, scrobbled("Loop", 1000), 1000 + LOOP + 95)).status).toBe("idle");
    for (let t = 0; t < 10; t++) await settle(c, scrobbled("Loop", 1000 + LOOP), 1000 + LOOP + 100 + t * 5);
    expect(writes - before).toBeLessThanOrEqual(1); // the first sight of the song as finished marks it; nothing per refresh
  });
});
