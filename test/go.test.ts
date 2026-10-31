import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { destination } from "../src/serve/go.ts";

const ctx = { waitUntil: () => {}, passThroughOnException() {} } as unknown as ExecutionContext;
const track = { title: "It's You (feat. A/B)", artist: "Valorant & Co", album: "", artUrl: null, playedAt: null };

describe("where a click on the card goes", () => {
  it("sends the song to its Last.fm page, with spaces as plus signs and everything else encoded", () => {
    expect(destination("Cl0ud-9", { artist: "Daft Punk", title: "One More Time" }, "song")).toBe("https://www.last.fm/music/Daft+Punk/_/One+More+Time");
    expect(destination("Cl0ud-9", track, "song")).toBe("https://www.last.fm/music/Valorant+%26+Co/_/It's+You+(feat.+A%2FB)");
  });

  it("can send it to a search for the song on Spotify, YouTube Music or Apple Music", () => {
    const words = "Valorant%20%26%20Co%20It's%20You%20(feat.%20A%2FB)";
    expect(destination("u", track, "spotify")).toBe(`https://open.spotify.com/search/${words}`);
    expect(destination("u", track, "youtube")).toBe(`https://music.youtube.com/search?q=${words}`);
    expect(destination("u", track, "apple")).toBe(`https://music.apple.com/search?term=${words}`);
  });

  it("sends to the profile when asked to, or when there is no song", () => {
    expect(destination("Cl0ud-9", track, "profile")).toBe("https://www.last.fm/user/Cl0ud-9");
    expect(destination("Cl0ud-9", null, "song")).toBe("https://www.last.fm/user/Cl0ud-9");
  });

  it("never leaves the four sites, whatever a song is called", () => {
    const evil = { artist: "https://evil.example/?", title: "\"><script>//\r\nLocation: https://evil.example" };
    for (const to of ["song", "spotify", "youtube", "apple"] as const) {
      const url = new URL(destination("u", evil, to));
      expect(["www.last.fm", "open.spotify.com", "music.youtube.com", "music.apple.com"]).toContain(url.hostname);
      expect(url.protocol).toBe("https:");
    }
  });
});

describe("/api/go", () => {
  const snapshot = (status: string) => ({
    ok: true,
    np: { user: "Cl0ud-9", status, track },
    art: null, source: "none", tried: [], checkedAt: Date.now(), changedAt: Date.now(),
  });
  const presence = (answer: () => Response | Promise<Response>) =>
    ({ idFromName: (n: string) => n, get: () => ({ fetch: async () => answer() }) }) as unknown as DurableObjectNamespace;
  const go = (q: string, env: object) => worker.fetch(new Request(`https://t.dev/api/go${q}`), env as never, ctx);
  const tracked = { LASTFM_API_KEY: "key", LASTFM_USER: "Cl0ud-9" };

  afterEach(() => vi.unstubAllGlobals());

  it("redirects to the song on the card, from the presence object, and is never cached", async () => {
    const res = await go("?user=Cl0ud-9", { ...tracked, PRESENCE: presence(() => Response.json(snapshot("playing"))) });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(destination("Cl0ud-9", track, "song"));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const spotify = await go("?user=cl0ud-9&to=Spotify", { ...tracked, PRESENCE: presence(() => Response.json(snapshot("idle"))) });
    expect(spotify.headers.get("location")).toBe(destination("cl0ud-9", track, "spotify"));
  });

  it("falls back to the song, and to Last.fm itself when the presence object cannot answer", async () => {
    const bad = await go("?user=Cl0ud-9&to=nonsense", { ...tracked, PRESENCE: presence(() => Response.json(snapshot("playing"))) });
    expect(bad.headers.get("location")).toBe(destination("Cl0ud-9", track, "song"));
    vi.stubGlobal("fetch", async () => Response.json({ recenttracks: { track: [{ name: "Direct", artist: { "#text": "Band" }, album: { "#text": "" }, "@attr": { nowplaying: "true" } }] } }));
    const res = await go("?user=Cl0ud-9", { ...tracked, PRESENCE: presence(() => { throw new Error("overloaded"); }) });
    expect(res.headers.get("location")).toBe("https://www.last.fm/music/Band/_/Direct");
  });

  it("goes to the profile when nothing has been played, or nothing can be found out", async () => {
    const quiet = { ok: false, np: null, reason: "empty", art: null, source: "none", tried: [], checkedAt: Date.now(), changedAt: Date.now() };
    expect((await go("?user=Cl0ud-9", { ...tracked, PRESENCE: presence(() => Response.json(quiet)) })).headers.get("location")).toBe("https://www.last.fm/user/Cl0ud-9");
    expect((await go("?user=Cl0ud-9", { LASTFM_USER: "Cl0ud-9" })).headers.get("location")).toBe("https://www.last.fm/user/Cl0ud-9");
  });

  it("answers not found for a user this deployment does not serve, or a name that is not one", async () => {
    for (const q of ["", "?user=", "?user=someone_else", "?user=../x", "?user=a%20b"]) {
      const res = await go(q, { ...tracked, PRESENCE: presence(() => Response.json(snapshot("playing"))) });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
    }
    // an open deployment serves anyone
    vi.stubGlobal("fetch", async () => Response.json({ recenttracks: { track: [] } }));
    expect((await go("?user=anyone", { LASTFM_API_KEY: "key", OPEN_TO_ALL: "true" })).status).toBe(302);
  });
});
