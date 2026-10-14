import { describe, expect, it } from "vitest";
import { coverOptions, isTracked, secret, settingsPrint, sourceList, trackedUsers } from "../src/config.ts";
import { durableStore, sweepExpired } from "../src/store.ts";

describe("configuration", () => {
  it("reads several tracked users and ignores invalid names", () => {
    expect(trackedUsers({ LASTFM_USER: " Cl0ud-9 , other_user,, not a name " })).toEqual(["Cl0ud-9", "other_user"]);
    expect(isTracked({ LASTFM_USER: "Cl0ud-9" }, "cl0ud-9")).toBe(true);
    expect(isTracked({ LASTFM_USER: "Cl0ud-9" }, "someone")).toBe(false);
  });

  it("trims pasted secrets and treats blank ones as unset", () => {
    expect(secret({ GENIUS_TOKEN: " tok\n" }, "GENIUS_TOKEN")).toBe("tok");
    expect(secret({ GENIUS_TOKEN: "  " }, "GENIUS_TOKEN")).toBeUndefined();
  });

  it("lets only the owner's tracked users spend the YouTube quota; Genius serves everyone", () => {
    const env = { LASTFM_API_KEY: "k", GENIUS_TOKEN: "g", YOUTUBE_API_KEY: "y" };
    expect(coverOptions(env, { tracked: true })).toMatchObject({ lastfmKey: "k", geniusToken: "g", youtubeKey: "y" });
    expect(coverOptions(env, { tracked: false })).toMatchObject({ lastfmKey: "k", geniusToken: "g", youtubeKey: undefined });
    expect(sourceList(coverOptions(env, { tracked: true }))).toBe("lastfm+genius+itunes+youtube");
    expect(sourceList(coverOptions({ LASTFM_API_KEY: "k" }, { tracked: true }))).toBe("lastfm+itunes");
  });

  it("fingerprints the secrets without revealing them, ignoring stray whitespace", () => {
    expect(settingsPrint({ LASTFM_API_KEY: "abc" })).toBe(settingsPrint({ LASTFM_API_KEY: " abc\n" }));
    expect(settingsPrint({ LASTFM_API_KEY: "abc" })).not.toContain("abc");
    expect(settingsPrint({ LASTFM_API_KEY: "abc" })).not.toBe(settingsPrint({ LASTFM_API_KEY: "abc", YOUTUBE_API_KEY: "y" }));
  });
});

/** Just enough of DurableObjectStorage: ordered keys, paged listing, batch delete. */
function memoryStorage() {
  const data = new Map<string, unknown>();
  const storage = {
    get: async (k: string) => data.get(k),
    put: async (k: string, v: unknown) => void data.set(k, v),
    delete: async (k: string | string[]) => { for (const key of Array.isArray(k) ? k : [k]) data.delete(key); return true; },
    list: async ({ startAfter, limit }: { startAfter?: string; limit?: number }) => {
      const keys = [...data.keys()].sort().filter((k) => startAfter === undefined || k > startAfter).slice(0, limit);
      return new Map(keys.map((k) => [k, data.get(k)]));
    },
  };
  return { data, storage: storage as unknown as DurableObjectStorage };
}

describe("clearing expired entries", () => {
  it("removes expired covers and notes, keeps live ones and the object's own state, and walks in pages", async () => {
    const { data, storage } = memoryStorage();
    const store = durableStore(storage);
    for (let i = 0; i < 100; i++) await store.put(`old-${String(i).padStart(3, "0")}`, { cover: i }, -1); // already expired
    await store.put("fresh", { cover: "x" }, 3600);
    await storage.put("snap", { ok: true, checkedAt: 1 }); // not an expiring entry: never touched
    await storage.put("user", "Cl0ud-9");

    let from: string | undefined;
    let removed = 0;
    let rounds = 0;
    do {
      const r = await sweepExpired(storage, from, 64);
      removed += r.removed;
      from = r.next;
      rounds++;
    } while (from && rounds < 10);

    expect(removed).toBe(100);
    expect(rounds).toBe(2);
    expect([...data.keys()].sort()).toEqual(["fresh", "snap", "user"]);
  });
});
