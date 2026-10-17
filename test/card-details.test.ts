import { describe, expect, it } from "vitest";
import { cardKey, dataForTrack, renderCard } from "../src/card.ts";
import { demoCard } from "../src/demo.ts";
import { landingPage } from "../src/landing.ts";
import type { NowPlaying, Theme } from "../src/model.ts";

const now = 1_800_000_000;
const track = { title: "Closer", artist: "The Chainsmokers", album: "Collage", artUrl: null, playedAt: null };
const playing: NowPlaying = { user: "u", status: "playing", track };
const idle: NowPlaying = { user: "u", status: "idle", track: { ...track, playedAt: now - 600 } };
const card = (np: NowPlaying, theme: Theme = "expressive", still = false) => {
  const { data, seed } = dataForTrack(np, null, now);
  return renderCard(data, seed, { theme, mode: "dark", still });
};
const dashOf = (svg: string) => Number(svg.match(/class="pa [^"]*"[^>]*stroke-dasharray="([\d.]+) 9999"/)![1]);

describe("the wavy line", () => {
  it("spans the whole bar while a song plays, the same for every song", () => {
    const a = card(playing);
    const b = card({ ...playing, track: { ...track, title: "A much longer song title here" } });
    expect(dashOf(a)).toBeGreaterThan(500); // the full 490px column, measured along the curve
    expect(dashOf(a)).toBe(dashOf(b));
  });

  it("is not a progress bar: no stop dot, no growing part, no track", () => {
    const svg = card(playing);
    expect(svg).not.toMatch(/<circle cx="[\d.]+" cy="228"/);
    expect(svg).not.toContain("pgrow");
    expect(svg).not.toContain('class="pt ');
  });

  it("travels while both ends stay put: drift and dash move on one SMIL timeline", () => {
    const svg = card(playing);
    expect(svg).toContain("<animateTransform");
    expect(svg).toContain('<animate attributeName="stroke-dashoffset"');
    expect(svg).toMatch(/prefers-reduced-motion:reduce\)\{\.pw\{transform:none!important\}/);
  });

  it("is a still frame with ?still=1", () => {
    const svg = card(playing, "expressive", true);
    expect(svg).not.toContain("<animate");
    expect(svg).toContain('class="pa ');
  });

  it("is not drawn at all when nothing plays", () => {
    for (const theme of ["expressive", "minimal"] as const) {
      const svg = card(idle, theme);
      expect(svg).not.toContain('class="pa ');
      expect(svg).not.toContain("<animateTransform");
    }
  });

  it("is drawn by the minimal theme too", () => {
    expect(card(playing, "minimal")).toContain("<animateTransform");
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
  it("stays the same between renders of the same song, so the page does not swap an identical card", () => {
    expect(cardKey(dataForTrack(playing, null, now).data)).toBe(cardKey(dataForTrack(playing, null, now + 30).data));
  });

  it("changes when the song, the cover or the status line changes", () => {
    const base = dataForTrack(playing, null, now).data;
    expect(cardKey({ ...base, track: { ...track, title: "Other" } })).not.toBe(cardKey(base));
    expect(cardKey({ ...base, artDataUri: "data:image/jpeg;base64,AAAA" })).not.toBe(cardKey(base));
    const ago = (s: number) => dataForTrack({ ...idle, track: { ...track, playedAt: now - s } }, null, now).data;
    expect(cardKey(ago(5 * 60))).not.toBe(cardKey(ago(9 * 60))); // "PLAYED 5 MIN AGO" -> "PLAYED 9 MIN AGO"
  });
});

describe("the website", () => {
  it("opens on the instance owner's live card and polls it while the tab is visible", () => {
    const html = landingPage("Cl0ud-9");
    expect(html).toContain('"Cl0ud-9"');
    expect(html).toContain("method:'HEAD'");
    expect(html).toContain("X-Ode-Key");
    expect(html).toContain("visibilitychange");
  });

  it("hands out a snippet with a width and height, so GitHub reserves the space while the card loads", () => {
    const html = landingPage();
    expect(html).toContain('width="480" height="');
    expect(html).toContain("minimal:87");
  });

  it("still works without an owner", () => {
    expect(landingPage()).toContain('q.get(\'user\')??""');
  });
});

describe("consistency across states and scripts", () => {
  it("measures Indic titles by their letters, not their vowel signs, so they are not cut short", async () => {
    const { textEm } = await import("../src/util.ts");
    const hindi = "सम्पूर्ण गीता सार हिन्दी में";
    const marks = [...hindi].filter((c) => /\p{M}/u.test(c)).length;
    expect(marks).toBeGreaterThan(5);
    // Rendered, this title is about 10.5em wide in bold; counting every mark made it over 15em.
    expect(textEm(hindi, false, true)).toBeLessThan(12.5);
    expect(card({ ...playing, track: { ...track, title: hindi, album: "" } })).toContain(`>${hindi}</text>`);
  });

  it("measures emoji as emoji (they were caught by the CJK rule first)", async () => {
    const { textEm } = await import("../src/util.ts");
    expect(textEm("🎧")).toBeCloseTo(1.1 * 1.06, 5);
  });

  it("keeps the album on the minimal card after the song ends", () => {
    expect(card(idle, "minimal")).toContain("The Chainsmokers · Collage");
  });

  it("marks only an album with the disc icon, not the hint on a quiet or offline card", () => {
    const disc = /<circle cx="282" cy="\d+" r="10"/;
    expect(card(playing)).toMatch(disc);
    for (const demo of ["empty", "error"] as const) {
      const { data, seed } = demoCard(demo, now);
      expect(renderCard(data, seed, { theme: "expressive", mode: "dark", still: true })).not.toMatch(disc);
    }
  });
});
