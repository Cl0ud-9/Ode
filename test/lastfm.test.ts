import { describe, expect, it } from "vitest";
import { USERNAME_RE, fetchNowPlaying, normalize } from "../src/lastfm.ts";

const img = (url: string) => [{ "#text": "", size: "small" }, { "#text": url, size: "extralarge" }];
const track = (extra: object = {}) => ({
  name: "Song",
  artist: { "#text": "Band" },
  album: { "#text": "Record" },
  image: img("https://lastfm.freetls.fastly.net/i/u/300x300/abc.jpg"),
  ...extra,
});

describe("normalize", () => {
  it("reads a now playing track", () => {
    const r = normalize("u", { recenttracks: { track: [track({ "@attr": { nowplaying: "true" } }), track({ date: { uts: "10" } })] } });
    expect(r).toMatchObject({ ok: true, data: { status: "playing", track: { title: "Song", artist: "Band", album: "Record", playedAt: null } } });
  });

  it("reads an idle track with its timestamp", () => {
    const r = normalize("u", { recenttracks: { track: [track({ date: { uts: "1700000000" } })] } });
    expect(r).toMatchObject({ ok: true, data: { status: "idle", track: { playedAt: 1700000000 } } });
  });

  it("accepts a single track object", () => {
    expect(normalize("u", { recenttracks: { track: track() } }).ok).toBe(true);
  });

  it("drops Last.fm's placeholder cover", () => {
    const r = normalize("u", { recenttracks: { track: [track({ image: img("https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png") })] } });
    expect(r.ok && r.data.track.artUrl).toBeNull();
  });

  it("maps errors and empty history", () => {
    expect(normalize("u", { error: 6, message: "User not found" })).toEqual({ ok: false, reason: "not_found" });
    expect(normalize("u", { error: 29 })).toEqual({ ok: false, reason: "rate_limited" });
    expect(normalize("u", { error: 8 })).toEqual({ ok: false, reason: "upstream" });
    expect(normalize("u", { recenttracks: { track: [] } })).toEqual({ ok: false, reason: "empty" });
    expect(normalize("u", {})).toEqual({ ok: false, reason: "upstream" });
  });
});

describe("fetchNowPlaying", () => {
  it("handles network failure, 429 and bad JSON", async () => {
    expect(await fetchNowPlaying("u", "k", () => Promise.reject(new Error("x")))).toEqual({ ok: false, reason: "upstream" });
    expect(await fetchNowPlaying("u", "k", async () => new Response("", { status: 429 }))).toEqual({ ok: false, reason: "rate_limited" });
    expect(await fetchNowPlaying("u", "k", async () => new Response("<html>", { status: 200 }))).toEqual({ ok: false, reason: "upstream" });
  });

  it("parses a 404 user-not-found body", async () => {
    const r = await fetchNowPlaying("u", "k", async () => new Response(JSON.stringify({ error: 6 }), { status: 404 }));
    expect(r).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("USERNAME_RE", () => {
  it("accepts real names and rejects junk", () => {
    for (const ok of ["rj", "Cloud_9", "a-b-c", "user12345678901"]) expect(USERNAME_RE.test(ok)).toBe(true);
    for (const bad of ["", "a", "1abc", "x".repeat(16), "a b", "a&api_key=1", "../x"]) expect(USERNAME_RE.test(bad)).toBe(false);
  });
});
