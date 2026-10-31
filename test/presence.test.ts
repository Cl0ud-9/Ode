import { describe, expect, it } from "vitest";
import { endedAt, STUCK_EXTRA, STUCK_MAX, stuckAfter, FLAG_OUTLIVES, HOLD_FOR, LOOP_DUE, LOOP_DUE_SEEN, LOOP_MAX, LOOP_MIN, LOOP_SEEN_SLACK, LOOP_SLACK, NEW_PLAY_AFTER, STUCK_AFTER, settle } from "../src/presence.ts";
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

describe("a long track is not called stuck at 20 minutes", () => {
  // looked at once a minute while it "plays", as the presence object does (far more often than that)
  const watch = async (c: Store, title: string, from: number, to: number, length: number) => {
    let out = await settle(c, np(title), from, length);
    for (let t = from + 60; t <= to; t += 60) out = await settle(c, np(title), t, length);
    return out;
  };

  it("lets a track play as long as it is long, and a little more, when its length is known", async () => {
    const mix = 45 * 60;
    const c = memory();
    expect((await watch(c, "Mix", 1000, 1000 + 30 * 60, mix)).status).toBe("playing"); // would have been called stuck at 20 minutes
    expect((await watch(c, "Mix", 1000 + 30 * 60, 1000 + mix + STUCK_EXTRA, mix)).status).toBe("playing");
    const out = await settle(c, np("Mix"), 1000 + mix + STUCK_EXTRA + 1, mix);
    expect(out.status).toBe("idle");
    expect(out.track.playedAt).toBe(1000);
  });

  it("keeps the 20 minutes for a song whose length is unknown or short, so ordinary songs behave as before", async () => {
    expect(stuckAfter()).toBe(STUCK_AFTER);
    expect(stuckAfter(0)).toBe(STUCK_AFTER);
    expect(stuckAfter(210)).toBe(STUCK_AFTER);
    const c = memory();
    await watch(c, "Song", 1000, 1000 + STUCK_AFTER, 210);
    expect((await settle(c, np("Song"), 1000 + STUCK_AFTER + 1, 210)).status).toBe("idle");
  });

  it("caps how long any track may play before it counts as stuck", () => {
    expect(stuckAfter(50 * 3600)).toBe(STUCK_MAX);
    expect(stuckAfter(3600)).toBe(3600 + STUCK_EXTRA);
  });
});

describe("how long ago a finished song was played", () => {
  const finished = (at: number): NowPlaying => ({ ...np("Song", "idle"), track: { ...np("Song").track, playedAt: at } });

  it("counts from when a song of known length ended, not from when it started", () => {
    // started 4 minutes ago and is 4 minutes long: it has only just ended
    expect(endedAt(finished(1000), 240, 1240).track.playedAt).toBe(1240);
    // and 10 minutes after it ended, it ended 10 minutes ago
    expect(endedAt(finished(1000), 240, 1840).track.playedAt).toBe(1240);
  });

  it("never dates the end in the future: a flag that dropped early reads as just now", () => {
    expect(endedAt(finished(1000), 240, 1100).track.playedAt).toBe(1100);
  });

  it("leaves everything else as it was", () => {
    expect(endedAt(finished(1000), 0, 2000)).toEqual(finished(1000)); // length unknown
    expect(endedAt(finished(1000), 5, 2000)).toEqual(finished(1000)); // not a plausible length
    expect(endedAt(finished(1000), 99 * 3600, 2000)).toEqual(finished(1000));
    const playing = np("Song", "playing");
    expect(endedAt(playing, 240, 2000)).toBe(playing); // still playing
    const undated = { ...np("Song", "idle"), track: { ...np("Song").track, playedAt: null } };
    expect(endedAt(undated, 240, 2000)).toBe(undated);
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
    // the next scrobble is due one loop after this one was seen, with little to spare
    const due = 1000 + LOOP + 90 + LOOP * LOOP_DUE_SEEN + LOOP_SEEN_SLACK;
    expect((await settle(c, scrobbled("Loop", 1000 + LOOP), due)).status).toBe("playing");
    expect((await settle(c, scrobbled("Loop", 1000 + LOOP), due + 1)).status).toBe("idle"); // nothing came: it stopped
  });

  it("learns the song's length as the middle of its recent gaps, and rewrites it only when it moves", async () => {
    const m = new Map<string, unknown>();
    const c: Store = { get: async (k) => (m.get(k) as never) ?? null, put: async (k, v) => { m.set(k, v); } };
    await settle(c, scrobbled("Loop", 1000), 1090);
    await settle(c, scrobbled("Loop", 1000 + LOOP), 1000 + LOOP + 90);
    await settle(c, scrobbled("Loop", 1000 + 2 * LOOP + 6), 1000 + 2 * LOOP + 96); // one odd gap among them
    await settle(c, scrobbled("Loop", 1000 + 3 * LOOP + 6), 1000 + 3 * LOOP + 96);
    const lens = [...m.entries()].filter(([k]) => k.startsWith("len-"));
    expect(lens).toHaveLength(1);
    expect((lens[0]![1] as { len: number }).len).toBe(LOOP);
  });

  describe("a loop spotted from the flag outliving the song", () => {
    const playingAt = (title: string): NowPlaying => np(title, "playing");
    // the song is known to be LOOP long from an earlier loop; then, much later, it is played again
    const known = async (c: Store) => {
      await settle(c, scrobbled("Loop", 100), 190);
      await settle(c, scrobbled("Loop", 100 + LOOP), 100 + LOOP + 90);
    };

    it("shows the first repeat as playing at once when the flag was on for much longer than the song", async () => {
      const c = memory();
      await known(c);
      const t0 = 50_000;
      await settle(c, playingAt("Loop"), t0);
      await settle(c, playingAt("Loop"), t0 + LOOP * FLAG_OUTLIVES + 5); // still flagged, well past its length
      const out = await settle(c, scrobbled("Loop", t0 + 10), t0 + LOOP * FLAG_OUTLIVES + 8); // the flag drops, its scrobble is the latest
      expect(out.status).toBe("playing");
    });

    it("does not, when the flag lasted about as long as the song", async () => {
      const c = memory();
      await known(c);
      const t0 = 50_000;
      await settle(c, playingAt("Loop"), t0);
      await settle(c, playingAt("Loop"), t0 + LOOP);
      expect((await settle(c, scrobbled("Loop", t0 + 10), t0 + LOOP + 3)).status).toBe("idle");
    });

    it("gives up on a song whose flag outlasts it with no repeat, and does not do it twice", async () => {
      const c = memory();
      await known(c);
      const run = async (t0: number) => {
        await settle(c, playingAt("Loop"), t0);
        await settle(c, playingAt("Loop"), t0 + LOOP * FLAG_OUTLIVES + 5);
        const first = await settle(c, scrobbled("Loop", t0 + 10), t0 + LOOP * FLAG_OUTLIVES + 8);
        const after = await settle(c, scrobbled("Loop", t0 + 10), t0 + 10 + LOOP * LOOP_DUE + LOOP_SLACK + 1); // no repeat ever came
        return [first.status, after.status];
      };
      expect(await run(50_000)).toEqual(["playing", "idle"]);
      expect(await run(90_000)).toEqual(["idle", "idle"]);
    });

    it("needs a song whose length is known", async () => {
      const c = memory();
      const t0 = 50_000;
      await settle(c, playingAt("Unseen"), t0);
      await settle(c, playingAt("Unseen"), t0 + 600);
      expect((await settle(c, scrobbled("Unseen", t0 + 10), t0 + 610)).status).toBe("idle");
    });
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
