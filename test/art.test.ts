import { describe, expect, it } from "vitest";
import { artStore, loadArt, resolveArt, sizedUrl, type ArtStore } from "../src/art.ts";

const art = async (...a: Parameters<typeof resolveArt>) => (await resolveArt(...a)).art;
import { demoCover } from "../src/demo.ts";

describe("sizedUrl", () => {
  it("swaps the size segment on Last.fm hosts only", () => {
    expect(sizedUrl("https://lastfm.freetls.fastly.net/i/u/300x300/abc.jpg", "64s")).toBe("https://lastfm.freetls.fastly.net/i/u/64s/abc.jpg");
    expect(sizedUrl("https://lastfm.freetls.fastly.net/i/u/abc.jpg", "174s")).toBe("https://lastfm.freetls.fastly.net/i/u/174s/abc.jpg");
    expect(sizedUrl("https://evil.example/i/u/300x300/abc.jpg", "64s")).toBeNull();
    expect(sizedUrl("http://lastfm.freetls.fastly.net/i/u/300x300/abc.jpg", "64s")).toBeNull();
    expect(sizedUrl("not a url", "64s")).toBeNull();
  });
});

describe("loadArt", () => {
  const url = "https://lastfm.freetls.fastly.net/i/u/300x300/abc.png";

  it("embeds the image and derives a seed", async () => {
    const asked: string[] = [];
    const art = await loadArt(url, async (u) => {
      asked.push(String(u));
      return new Response(demoCover(String(u).includes("174s") ? 112 : 64));
    });
    expect(art?.dataUri.startsWith("data:image/png;base64,")).toBe(true);
    expect(asked.sort()).toEqual(["https://lastfm.freetls.fastly.net/i/u/174s/abc.png", "https://lastfm.freetls.fastly.net/i/u/64s/abc.png"]);
    expect(art?.seed.c1).toBeGreaterThan(0.05);
  });

  it("returns null on fetch failure, garbage bytes or foreign hosts", async () => {
    expect(await loadArt(url, async () => new Response("", { status: 404 }))).toBeNull();
    expect(await loadArt(url, async () => new Response(new Uint8Array([1, 2, 3, 4])))).toBeNull();
    expect(await loadArt("https://example.com/i/u/x/a.png", async () => { throw new Error("must not fetch"); })).toBeNull();
  });
});

describe("resolveArt", () => {
  const track = { title: "Song", artist: "The Band", album: "Record", artUrl: null };
  const itunes = (rows: object[]) => async (u: string | URL | Request) => {
    const url = String(u);
    if (url.startsWith("https://itunes.apple.com/search")) return Response.json({ results: rows });
    return new Response(demoCover(url.includes("00x") && !url.includes("64x64") ? 112 : 64));
  };
  const row = (artistName: string, collectionName: string) => ({
    artistName,
    collectionName,
    artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/Music/x/y/100x100bb.jpg",
  });

  it("falls back to the catalogue when Last.fm has no cover, preferring the same album", async () => {
    const asked: string[] = [];
    const f = itunes([row("Someone Else", "Record"), row("The Band", "Greatest Hits"), row("The Band", "Record")]);
    const got = await art(track, async (u) => { asked.push(String(u)); return f(u as string); });
    expect(got?.dataUri.startsWith("data:image/")).toBe(true);
    expect(asked.some((u) => u.endsWith("/300x300bb.jpg"))).toBe(true);
  });

  it("ignores hits by other artists and tolerates failures", async () => {
    expect(await art(track, itunes([row("Someone Else", "Record")]))).toBeNull();
    expect(await art(track, async () => { throw new Error("down"); })).toBeNull();
    expect(await art(track, async () => new Response("nope", { status: 500 }))).toBeNull();
  });

  it("prefers Last.fm's own cover and does not search when it works", async () => {
    const asked: string[] = [];
    await art({ ...track, artUrl: "https://lastfm.freetls.fastly.net/i/u/300x300/abc.png" }, async (u) => { asked.push(String(u)); return new Response(demoCover(64)); });
    expect(asked.every((u) => u.includes("lastfm"))).toBe(true);
  });
});

describe("resolveArt matching", () => {
  const mk = (rows: object[]) => async (u: string | URL | Request) => {
    const url = String(u);
    if (url.startsWith("https://itunes.apple.com/search")) {
      const entity = new URL(url).searchParams.get("entity");
      return Response.json({ results: rows.filter((r) => (r as { kind: string }).kind === entity) });
    }
    return new Response(demoCover(url.includes("00x") && !url.includes("64x64") ? 112 : 64));
  };
  const hit = (kind: "song" | "album", artistName: string, trackName: string, collectionName: string) => ({
    kind, artistName, trackName, collectionName,
    artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/Music/x/y/100x100bb.jpg",
  });

  it("does not borrow another song's cover", async () => {
    const f = mk([hit("song", "The Band", "A Different Song", "Other")]);
    expect(await art({ title: "Song", artist: "The Band", album: "", artUrl: null }, f, {})).toBeNull();
  });

  it("matches the same song across release noise like (Remastered) and feat.", async () => {
    const f = mk([hit("song", "The Band", "Song (Remastered 2011)", "Greatest Hits")]);
    expect(await art({ title: "Song - Radio Edit", artist: "The Band", album: "", artUrl: null }, f, {})).not.toBeNull();
    const g = mk([hit("song", "The Band", "Song", "Greatest Hits")]);
    expect(await art({ title: "Song (feat. Someone)", artist: "The Band", album: "", artUrl: null }, g, {})).not.toBeNull();
  });

  it("uses the artist's latest release only when allowed", async () => {
    const f = mk([hit("album", "The Band", "", "Newest")]);
    const t = { title: "Unreleased Mashup", artist: "The Band", album: "", artUrl: null };
    expect(await art(t, f, { artistCover: false })).toBeNull();
    expect(await art(t, f, { artistCover: true })).not.toBeNull();
  });

  it("falls back to the album when the song itself is not listed", async () => {
    const f = mk([hit("album", "The Band", "", "Record (Deluxe)")]);
    expect(await art({ title: "Deep Cut", artist: "The Band", album: "Record", artUrl: null }, f, {})).not.toBeNull();
  });
});

describe("when a catalogue is throttled", () => {
  const track = { title: "Roslyn", artist: "Rishab Rikhiram Sharma", album: "", artUrl: null };
  const memory = (): ArtStore & { data: Map<string, unknown> } => {
    const data = new Map<string, unknown>();
    return {
      data,
      async get(k) { return (data.get(k) as never) ?? null; },
      async put(k, v) { data.set(k, v); },
    };
  };
  const throttled = (calls: string[]) => async (u: string | URL | Request) => {
    calls.push(String(u).split("?")[0]!);
    return new Response("Rate limit exceeded", { status: 429 });
  };

  it("stops asking iTunes for a while after a 429, and reports why", async () => {
    const calls: string[] = [];
    const store = memory();
    const first = await resolveArt(track, throttled(calls), {}, store);
    expect(first).toMatchObject({ art: null, source: "itunes-blocked", tried: ["itunes:429"] });
    const before = calls.length;
    expect(before).toBeGreaterThan(0);
    await resolveArt({ ...track, title: "Another One" }, throttled(calls), {}, store);
    expect(calls.length).toBe(before);
  });

  it("the warm-up job can ignore the back-off marker", async () => {
    const calls: string[] = [];
    const store = memory();
    await resolveArt(track, throttled(calls), {}, store);
    const before = calls.length;
    await resolveArt(track, throttled(calls), { ignoreCooldown: true }, store);
    expect(calls.length).toBeGreaterThan(before);
  });

  it("remembers a found cover per track, then serves it without any network", async () => {
    const store = memory();
    const f = async (u: string | URL | Request) => {
      const url = String(u);
      if (url.includes("itunes.apple.com")) {
        return Response.json({ results: [{ artistName: "Rishab Rikhiram Sharma", trackName: "Roslyn", collectionName: "Roslyn", artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/Music/x/y/100x100bb.jpg" }] });
      }
      return new Response(demoCover(url.includes("300x300") ? 112 : 64));
    };
    expect((await resolveArt(track, f, {}, store)).source).toBe("itunes");
    const again = await resolveArt(track, async () => { throw new Error("must come from memory"); }, {}, store);
    expect(again.source).toBe("cache");
    expect(again.art?.dataUri.startsWith("data:image/")).toBe(true);
  });

  it("asks iTunes for crisp 300px artwork", async () => {
    const asked: string[] = [];
    await resolveArt(track, async (u) => {
      const url = String(u);
      asked.push(url);
      if (url.includes("itunes.apple.com")) return Response.json({ results: [{ artistName: "Rishab Rikhiram Sharma", trackName: "Roslyn", artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/Music/x/y/100x100bb.jpg" }] });
      return new Response(demoCover(url.includes("300x300") ? 112 : 64));
    }, {}, memory());
    expect(asked.some((u) => u.endsWith("/300x300bb.jpg"))).toBe(true);
  });

  it("does not remember a miss caused by throttling, but does remember a real one", async () => {
    const blocked = memory();
    await resolveArt(track, throttled([]), {}, blocked);
    expect([...blocked.data.keys()].some((k) => k !== "cooldown-itunes")).toBe(false);

    const real = memory();
    const none = await resolveArt(track, async () => Response.json({ results: [] }), {}, real);
    expect(none.source).toBe("none");
    expect([...real.data.values()]).toContain("none");
  });

  it("adapts a generic store", async () => {
    const m = new Map<string, unknown>();
    const store = artStore({ get: async (k) => (m.get(k) as never) ?? null, put: async (k, v) => { m.set(k, v); } });
    expect(await store.get("k")).toBeNull();
    await store.put("k", "none", 60);
    expect(await store.get("k")).toBe("none");
  });
});

describe("cover memory key", () => {
  it("treats the same song with and without an album, or with release noise, as one track", async () => {
    const data = new Map<string, unknown>();
    const store: ArtStore = { get: async (k) => (data.get(k) as never) ?? null, put: async (k, v) => { data.set(k, v); } };
    const f = async (u: string | URL | Request) => {
      const url = String(u);
      if (url.includes("itunes.apple.com")) return Response.json({ results: [{ artistName: "Billie Eilish", trackName: "WILDFLOWER", artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/Music/x/y/100x100bb.jpg" }] });
      return new Response(demoCover(url.includes("300x300") ? 112 : 64));
    };
    await resolveArt({ title: "WILDFLOWER", artist: "Billie Eilish", album: "", artUrl: null }, f, {}, store);
    const boom = async () => { throw new Error("must come from memory"); };
    expect((await resolveArt({ title: "Wildflower", artist: "billie eilish", album: "HIT ME HARD AND SOFT", artUrl: null }, boom, {}, store)).source).toBe("cache");
    expect((await resolveArt({ title: "WILDFLOWER (Remastered)", artist: "Billie Eilish", album: "", artUrl: null }, boom, {}, store)).source).toBe("cache");
  });
});

describe("answers that are not a clean result", () => {
  const track = { title: "Closer (feat. Halsey)", artist: "The Chainsmokers", album: "", artUrl: null };
  for (const [name, reply] of [
    ["a 403", () => new Response("Forbidden", { status: 403 })],
    ["a 500", () => new Response("oops", { status: 500 })],
    ["an HTML page served as 200", () => new Response("<html>slow down</html>", { status: 200 })],
  ] as const) {
    it(`treats ${name} as throttling, never as a remembered miss`, async () => {
      const data = new Map<string, unknown>();
      const store: ArtStore = { get: async (k) => (data.get(k) as never) ?? null, put: async (k, v) => { data.set(k, v); } };
      const r = await resolveArt(track, async () => reply(), {}, store);
      expect(r.source).toBe("itunes-blocked");
      expect([...data.entries()].filter(([k, v]) => v === "none" && !k.startsWith("cooldown-"))).toEqual([]);
    });
  }
});
