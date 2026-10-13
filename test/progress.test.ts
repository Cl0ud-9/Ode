import { describe, expect, it, vi } from "vitest";
import { cardKey, dataForTrack, progressOf, renderCard } from "../src/card.ts";
import { demoCard } from "../src/demo.ts";
import { landingPage } from "../src/landing.ts";
import { fetchDuration } from "../src/lastfm.ts";
import type { NowPlaying } from "../src/model.ts";
import { settle } from "../src/presence.ts";
import type { Store } from "../src/store.ts";

const now = 1_800_000_000;
const track = { title: "Closer", artist: "The Chainsmokers", album: "Collage", artUrl: null, playedAt: null };
const playing = (since?: number): NowPlaying => ({ user: "u", status: "playing", track, ...(since ? { since } : {}) });
const card = (np: NowPlaying, duration: number | null, still = false, theme: "expressive" | "minimal" = "expressive") => {
  const { data, seed } = dataForTrack(np, null, now, duration);
  return renderCard(data, seed, { theme, mode: "dark", still });
};

describe("where in the song we are", () => {
  it("counts from when the song was first seen playing", () => {
    expect(progressOf(playing(now - 60), 200, now)).toEqual({ elapsed: 60, duration: 200 });
  });

  it("wraps around for a song on repeat instead of overflowing", () => {
    expect(progressOf(playing(now - 250), 200, now)).toEqual({ elapsed: 50, duration: 200 });
  });

  it("draws no progress without a length, a start time, or while not playing", () => {
    expect(progressOf(playing(now - 60), null, now)).toBeUndefined();
    expect(progressOf(playing(now - 60), 12, now)).toBeUndefined(); // too short to be a real length
    expect(progressOf(playing(), 200, now)).toBeUndefined();
    expect(progressOf({ ...playing(now - 60), status: "idle" }, 200, now)).toBeUndefined();
  });

  it("is never negative when the clocks disagree", () => {
    expect(progressOf(playing(now + 5), 200, now)?.elapsed).toBe(0);
  });
});

describe("the Material 3 wavy progress indicator", () => {
  const stopDot = /<circle cx="[\d.]+" cy="228" r="3.5"/;

  it("has a wavy active part, a track and a stop dot while a song with a known length plays", () => {
    const svg = card(playing(now - 60), 200);
    expect(svg).toMatch(stopDot);
    expect(svg).toContain('class="pt '); // the track
    expect(svg).toContain('class="pa '); // the active wave
    expect(svg).toMatch(/@keyframes pgrow/); // and it advances by itself
    expect(svg).toMatch(/pgrow 140s linear forwards/);
  });

  it("keeps both ends still while the wave travels: drift and dash move on one SMIL timeline", () => {
    const svg = card(playing(now - 60), 200);
    expect(svg).toContain("<animateTransform");
    expect(svg).toContain('<animate attributeName="stroke-dashoffset"');
    expect(svg).toMatch(/prefers-reduced-motion:reduce\)\{\.pw\{transform:none!important\}/);
  });

  it("makes up no progress when the length is unknown: a full wave, no stop dot", () => {
    const svg = card(playing(now - 60), null);
    expect(svg).not.toMatch(stopDot);
    expect(svg).not.toContain("pgrow");
  });

  it("is a still frame with ?still=1", () => {
    const svg = card(playing(now - 60), 200, true);
    expect(svg).not.toContain("<animate");
    expect(svg).not.toContain("@keyframes pgrow");
    expect(svg).toMatch(stopDot);
  });

  it("shows the quiet track and its stop dot when nothing is playing", () => {
    const svg = card({ ...playing(), status: "idle", track: { ...track, playedAt: now - 600 } }, 200);
    expect(svg).toMatch(stopDot);
    expect(svg).not.toContain("<animateTransform");
  });

  it("does not overshoot near the end of the song", () => {
    const svg = card(playing(now - 199), 200);
    // The track has no length left; only the dot remains.
    expect(svg).toMatch(/class="pt [^"]*"[^>]*stroke-dasharray="0 9999"/);
  });

  it("is drawn by the minimal theme too", () => {
    expect(card(playing(now - 60), 200, false, "minimal")).toContain("<animateTransform");
  });
});

describe("the status pill", () => {
  it("hugs its label with even padding whatever font the viewer has", () => {
    const { data, seed } = demoCard("idle", now);
    const svg = renderCard(data, seed, { theme: "expressive", mode: "dark", still: true });
    const label = svg.match(/<text x="(\d+)" y="29" textLength="(\d+)" lengthAdjust="spacing"/)!;
    const pill = svg.match(/<rect width="(\d+)" height="44" rx="22"/)!;
    const left = Number(label[1]);
    const right = Number(pill[1]) - left - Number(label[2]);
    expect(left).toBe(right);
    expect(Number(pill[1])).toBeLessThan(255); // "PLAYED 3 H AGO" was 263 wide, padded 22 on the left and about 60 on the right
  });
});

describe("the card key the website polls", () => {
  it("ignores the progress indicator moving on, so the page does not swap an identical card", () => {
    const a = dataForTrack(playing(now - 60), null, now, 200).data;
    const b = dataForTrack(playing(now - 60), null, now + 30, 200).data;
    expect(cardKey(a)).toBe(cardKey(b));
  });

  it("changes when the song, the cover or the status line changes", () => {
    const base = dataForTrack(playing(now - 60), null, now, 200).data;
    expect(cardKey({ ...base, track: { ...track, title: "Other" } })).not.toBe(cardKey(base));
    expect(cardKey({ ...base, artDataUri: "data:image/jpeg;base64,AAAA" })).not.toBe(cardKey(base));
    const idle = (ago: number) => dataForTrack({ ...playing(), status: "idle", track: { ...track, playedAt: now - ago } }, null, now).data;
    expect(cardKey(idle(5 * 60))).not.toBe(cardKey(idle(9 * 60))); // "PLAYED 5 MIN AGO" -> "PLAYED 9 MIN AGO"
  });
});

describe("the song's length from Last.fm", () => {
  const answer = (body: unknown) => (async () => Response.json(body)) as unknown as typeof fetch;

  it("reads track.getInfo's milliseconds as seconds", async () => {
    expect(await fetchDuration(track, "k", answer({ track: { duration: "214000" } }))).toBe(214);
  });

  it("treats 0, nonsense and failures as unknown", async () => {
    expect(await fetchDuration(track, "k", answer({ track: { duration: "0" } }))).toBeNull();
    expect(await fetchDuration(track, "k", answer({ track: { duration: "9999999" } }))).toBeNull();
    expect(await fetchDuration(track, "k", answer({ error: 6 }))).toBeNull();
    expect(await fetchDuration(track, "k", (async () => { throw new Error("down"); }) as unknown as typeof fetch)).toBeNull();
  });
});

describe("settling", () => {
  const memory = (): Store => {
    const m = new Map<string, unknown>();
    return { get: async (k) => (m.get(k) as never) ?? null, put: async (k, v) => void m.set(k, v) } as Store;
  };

  it("reports when the playing song was first seen, and keeps it on later polls", async () => {
    const store = memory();
    expect((await settle(store, playing(), 1000)).since).toBe(1000);
    expect((await settle(store, playing(), 1030)).since).toBe(1000);
  });

  it("keeps the start time while Last.fm briefly drops the playing flag", async () => {
    const store = memory();
    await settle(store, playing(), 1000);
    const flap = await settle(store, { ...playing(), status: "idle", track: { ...track, title: "Previous", playedAt: 990 } }, 1010);
    expect(flap.status).toBe("playing");
    expect(flap.since).toBe(1000);
  });
});

describe("the website", () => {
  it("opens on the instance owner's live card and polls it while the tab is visible", () => {
    const html = landingPage("Cl0ud-9");
    expect(html).toContain('"Cl0ud-9"');
    expect(html).toContain("method:'HEAD'");
    expect(html).toContain("X-Tidemark-Key");
    expect(html).toContain("visibilitychange");
  });

  it("hands out a snippet with a width and height, so GitHub reserves the space while the card loads", () => {
    const html = landingPage();
    expect(html).toContain('width="480" height="');
    expect(html).toContain("minimal:86");
  });

  it("still works without an owner", () => {
    expect(landingPage()).toContain('q.get(\'user\')??""');
  });
});

vi.restoreAllMocks();
