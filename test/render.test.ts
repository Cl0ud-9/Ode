import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it } from "vitest";
import { renderCard } from "../src/card.ts";
import { DEMOS, demoCard } from "../src/demo.ts";
import { MODES, THEMES, type CardData } from "../src/model.ts";

const now = 1_800_000_000;

describe("every theme, mode and state", () => {
  for (const theme of THEMES) {
    for (const mode of MODES) {
      for (const demo of DEMOS) {
        it(`${theme}/${mode}/${demo} is valid, safe and light`, () => {
          const { data, seed } = demoCard(demo, now);
          const svg = renderCard(data, seed, { theme, mode, still: false });
          expect(() => new Resvg(svg).render()).not.toThrow();
          expect(svg).not.toMatch(/<script|<foreignObject|javascript:|onload=/i);
          // The only external-looking reference allowed is an embedded data URI.
          for (const m of svg.matchAll(/(?:href|src)="([^"]+)"/g)) {
            expect(m[1]!.startsWith("data:") || m[1]!.startsWith("#")).toBe(true);
          }
          expect(svg).not.toMatch(/url\(["']?https?:/);
          expect(svg.length).toBeLessThan(60_000);
        }, 15_000); // the first render loads resvg and system fonts, which can pass 5 s on a busy machine
      }
    }
  }
});

describe("rendering details", () => {
  const base = demoCard("playing", now);

  it("escapes hostile track metadata", () => {
    const data = { ...base.data, track: { ...base.data.track!, title: `</text><script>alert(1)</script> & "q"`, artist: "A<B", album: "x\u0000y" } };
    for (const theme of THEMES) {
      const svg = renderCard(data, base.seed, { theme, mode: "dark", still: false });
      expect(svg).not.toContain("<script");
      expect(svg).toContain("&lt;");
      expect(svg).not.toContain("\u0000");
      expect(() => new Resvg(svg).render()).not.toThrow();
    }
  });

  it("truncates very long titles and handles CJK and emoji", () => {
    for (const title of ["x".repeat(400), "夜に駆ける夜に駆ける夜に駆ける夜に駆ける夜に駆ける", "🎵🎶".repeat(60)]) {
      const data = { ...base.data, track: { ...base.data.track!, title } };
      const svg = renderCard(data, base.seed, { theme: "expressive", mode: "dark", still: false });
      expect(svg).toContain("…");
      expect(() => new Resvg(svg).render()).not.toThrow();
    }
  });

  it("still mode ships no animation", () => {
    for (const theme of THEMES) {
      const live = renderCard(base.data, base.seed, { theme, mode: "dark", still: false });
      const still = renderCard(base.data, base.seed, { theme, mode: "dark", still: true });
      expect(live).toContain("@keyframes");
      expect(still).not.toContain("@keyframes");
    }
  });

  it("auto mode carries a dark media query, fixed modes do not", () => {
    expect(renderCard(base.data, base.seed, { theme: "expressive", mode: "auto", still: true })).toContain("prefers-color-scheme:dark");
    expect(renderCard(base.data, base.seed, { theme: "expressive", mode: "dark", still: true })).not.toContain("prefers-color-scheme");
  });

  it("is deterministic", () => {
    const a = renderCard(base.data, base.seed, { theme: "expressive", mode: "auto", still: false });
    const b = renderCard(base.data, base.seed, { theme: "expressive", mode: "auto", still: false });
    expect(a).toBe(b);
  });

  it("different tracks get different shapes", () => {
    const other = { ...base.data, seed: base.data.seed + 1 };
    const opts = { theme: "expressive", mode: "dark", still: true } as const;
    expect(renderCard(other, base.seed, opts)).not.toBe(renderCard(base.data, base.seed, opts));
  });
});

describe("long titles", () => {
  it("wraps long titles onto two lines and ellipsises beyond that", async () => {
    const { wrapLines } = await import("../src/util.ts");
    expect(wrapLines("Short", 480, 34, 2)).toEqual(["Short"]);
    const two = wrapLines("ILLAHI x NIGHT CHANGES (MEGA MASHUP)", 480, 33, 2);
    expect(two).toHaveLength(2);
    expect(two.join(" ")).toBe("ILLAHI x NIGHT CHANGES (MEGA MASHUP)");
    const many = wrapLines("word ".repeat(40).trim(), 480, 33, 2);
    expect(many).toHaveLength(2);
    expect(many[1]!.endsWith("…")).toBe(true);
  });

});

describe("album line and fitting", () => {
  it("hides an album that only repeats the title", async () => {
    const { albumLine } = await import("../src/render/common.ts");
    expect(albumLine("Song - Single", "Song")).toBe("");
    expect(albumLine("Song - EP", "song")).toBe("");
    expect(albumLine("Record", "Song")).toBe("Record");
    expect(albumLine("  ", "Song")).toBe("");
  });

  it("never lets fitted text exceed its box, even for wide scripts and emoji", async () => {
    const { fit, textEm } = await import("../src/util.ts");
    for (const s of ["W".repeat(80), "漢字".repeat(40), "🎵".repeat(40), "a b c ".repeat(30), "ÉÀÜ".repeat(30)]) {
      for (const bold of [false, true]) {
        const out = fit(s, 400, 30, false, bold);
        expect(textEm(out, false, bold) * 30).toBeLessThanOrEqual(400 + 1);
      }
    }
  });
});

describe("status copy fits the card unshortened", () => {
  it("never truncates the fixed messages at the expressive card's sizes", async () => {
    const { copyFor } = await import("../src/render/common.ts");
    const { fit } = await import("../src/util.ts");
    const { dataForFailure } = await import("../src/card.ts");
    const cards = [
      dataForFailure("someone", "empty", 0),
      dataForFailure("someone", "not_found", 0),
      dataForFailure("someone", "rate_limited", 0),
      dataForFailure("someone", "upstream", 0),
      { ...dataForFailure("", "not_found", 0), message: "Not a Last.fm username" },
      { ...dataForFailure("", "not_found", 0), message: "Add ?user=your-name" },
      { ...dataForFailure("x", "upstream", 0), message: "No Last.fm key set yet" },
    ];
    for (const d of cards) {
      const c = copyFor(d);
      expect(fit(c.title, 482, 40, false, true), c.title).toBe(c.title);
      expect(fit(c.sub, 490, 30, false, true), c.sub).toBe(c.sub);
      expect(fit(c.meta, 458, 24), c.meta).toBe(c.meta);
    }
  });
});

describe("the name tag", () => {
  it("is shown for every 'last played' age, not just short ones", async () => {
    const { renderCard } = await import("../src/card.ts");
    const { demoCard } = await import("../src/demo.ts");
    const now = 1_800_000_000;
    const { data, seed } = demoCard("idle", now);
    for (const secs of [30, 540, 600, 3 * 3600, 12 * 3600, 36 * 3600, 20 * 86400, 400 * 86400]) {
      for (const user of ["Cl0ud-9", "longer_name"]) {
        const d = { ...data, user, now, track: { ...data.track!, playedAt: now - secs } };
        const svg = renderCard(d, seed, { theme: "expressive", mode: "dark", still: true });
        expect(svg, `${user} after ${secs}s`).toContain(`@${user}`);
      }
    }
  });

  it("is shown on a playing card too", async () => {
    const { renderCard } = await import("../src/card.ts");
    const { demoCard } = await import("../src/demo.ts");
    const { data, seed } = demoCard("playing", 0);
    expect(renderCard(data, seed, { theme: "expressive", mode: "dark", still: true })).toContain("@cloud9");
  });
});

describe("edges and corners", () => {
  const now2 = 1_800_000_000;
  it("every theme displays at whole pixels with the same shape as its drawing, so no strip of background shows at the sides", () => {
    for (const theme of THEMES) {
      const { data, seed } = demoCard("playing", now2);
      const svg = renderCard(data, seed, { theme, mode: "dark", still: true });
      const [, w, h, vw, vh] = svg.match(/width="([\d.]+)" height="([\d.]+)" viewBox="0 0 (\d+) (\d+)"/)!.map(Number);
      expect(Number.isInteger(h)).toBe(true);
      expect(w! / h!).toBeCloseTo(vw! / vh!, 6);
    }
  });

  it("paints the corners outside the rounded card in GitHub's page colour unless asked to keep them clear", () => {
    const { data, seed } = demoCard("playing", now2);
    for (const theme of THEMES) {
      const painted = renderCard(data, seed, { theme, mode: "auto", still: true });
      expect(painted).toContain('class="gh-canvas"');
      expect(painted).toContain(".gh-canvas{fill:#ffffff}@media (prefers-color-scheme:dark){.gh-canvas{fill:#0d1117}}");
      expect(renderCard(data, seed, { theme, mode: "dark", still: true, clearCorners: true })).not.toContain("gh-canvas");
    }
  });
});

describe("how often the song has been played", () => {
  const card = (kind: "idle" | "playing", album: string, plays: number | undefined) => {
    const { data: demo, seed } = demoCard(kind, now);
    const { week: _week, ...data } = demo; // and a week of its own, which has its own tests below
    const { plays: _demo, ...bare } = data.track!; // the demo carries a count of its own
    const track = { ...bare, album, ...(plays === undefined ? {} : { plays }) };
    return renderCard({ ...data, track }, seed, { theme: "expressive", mode: "dark", still: true });
  };

  it("follows the album on the card of a song that is not playing", () => {
    expect(card("idle", "Salt & Static", 42)).toContain("Salt &amp; Static · 42 plays");
    expect(card("idle", "Salt & Static", 1)).toContain("Salt &amp; Static · 1 play<");
    expect(card("idle", "Salt & Static", 1234)).toContain("· 1,234 plays");
  });

  it("is left out when it is not known, and from a card that is playing", () => {
    expect(card("idle", "Salt & Static", undefined)).not.toContain("plays");
    expect(card("idle", "Salt & Static", 0)).not.toContain("plays");
    expect(card("playing", "Salt & Static", 42)).not.toContain("plays");
  });

  it("never costs the album its line: with no room for both, the album stands alone, and with no album nothing is added", () => {
    const long = "A Very Long Album Title That Takes Up The Whole Line And More";
    const svg = card("idle", long, 42);
    expect(svg).not.toContain("plays");
    expect(svg).toContain(">A Very Long Album");
    expect(card("idle", "", 42)).not.toContain("plays");
  });

  it("changes nothing else about the card", () => {
    const strip = (s: string) => s.replace(/ · 42 plays/, "");
    expect(strip(card("idle", "Salt & Static", 42))).toBe(card("idle", "Salt & Static", undefined));
  });
});

describe("the week on the idle card", () => {
  const week = (over: Partial<NonNullable<CardData["week"]>> = {}) => ({ bars: [0, 5, 2, 9, 4, 8, 3], total: 31, streak: 6, ...over });
  const card = (kind: "idle" | "playing", w: CardData["week"] | undefined, theme: "expressive" | "minimal" | "terminal" = "expressive") => {
    const { data: demo, seed } = demoCard(kind, now);
    const { week: _demo, ...data } = demo;
    return renderCard({ ...data, ...(w ? { week: w } : {}) }, seed, { theme, mode: "dark", still: true });
  };
  // A day with plays is a bar (a 9 wide rect), a day with none is a small dot (a circle of radius 2.5).
  const bars = (svg: string) => svg.match(/<rect x="\d+" y="\d+" width="9" height="\d+"|<circle cx="[\d.]+" cy="[\d.]+" r="2\.5"/g) ?? [];

  it("draws seven bars, the total and the streak under the album line", () => {
    const svg = card("idle", week());
    expect(bars(svg)).toHaveLength(7);
    expect(svg).toContain("31 plays this week");
    expect(svg).toContain("6 day streak");
  });

  it("makes the busiest day the tallest, a day with no plays a dot, and today the brightest", () => {
    const svg = card("idle", week());
    const rects = [...svg.matchAll(/<rect x="\d+" y="(\d+)" width="9" height="(\d+)"/g)].map((m) => ({ y: Number(m[1]), h: Number(m[2]) }));
    expect(rects).toHaveLength(6); // seven days, one of them with no plays
    expect(svg).toContain('r="2.5"');
    expect(Math.max(...rects.map((r) => r.h))).toBe(20);
    expect(Math.min(...rects.map((r) => r.h))).toBeGreaterThanOrEqual(9); // never a sliver
    expect(new Set(rects.map((r) => r.y + r.h)).size).toBe(1); // every bar stands on the same line
    expect(svg).toMatch(/class="f-primary" opacity="\.95"\/><text/); // the last bar, today
  });

  it("puts the bars, the total and the chip on one centre line, clear of the card's bottom corners", () => {
    const svg = card("idle", week());
    const chip = svg.match(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="28"/)!;
    const x = Number(chip[1]);
    const y = Number(chip[2]);
    const w = Number(chip[3]);
    expect(y + 14).toBe(220); // centred on the row's line
    expect(y + 28).toBeLessThanOrEqual(250 - 14); // a clear margin below
    expect(x + w).toBe(762); // right edge in line with the @handle
    expect(svg).toMatch(/y="227"[^>]*>31 plays this week/);
  });

  it("is left out when the title takes two lines, which leaves no room for it", () => {
    const { data: demo, seed } = demoCard("idle", now);
    const long = renderCard({ ...demo, track: { ...demo.track!, title: "Midnight Tide Overdrive And The Long Way Home Again" } }, seed, { theme: "expressive", mode: "dark", still: true });
    expect(long).not.toContain("this week");
    expect(long).toContain("Long Way");
  });

  it("says 1 play for a week with one, and leaves the streak chip off below two days", () => {
    const svg = card("idle", week({ bars: [0, 0, 0, 0, 0, 0, 1], total: 1, streak: 1 }));
    expect(svg).toContain("1 play this week");
    expect(svg).not.toContain("streak");
  });

  it("draws nothing for a week with no plays, or when the week is not known", () => {
    for (const svg of [card("idle", week({ bars: [0, 0, 0, 0, 0, 0, 0], total: 0, streak: 0 })), card("idle", undefined)]) {
      expect(bars(svg)).toHaveLength(0);
      expect(svg).not.toContain("this week");
    }
  });

  it("keeps the whole total over the streak chip when both do not fit", () => {
    const svg = card("idle", week({ total: 123456 }));
    expect(svg).toContain("123,456 plays this week");
    expect(svg).not.toContain("day streak");
  });

  it("is never drawn on a card that is playing, nor on the other themes", () => {
    expect(card("playing", week())).not.toContain("this week");
    expect(card("idle", week(), "minimal")).not.toContain("this week");
    expect(card("idle", week(), "terminal")).not.toContain("this week");
  });

  it("adds only the week to the card: the same words, cover and pill, with the text block moved up to make room", () => {
    const words = (svg: string) => [...svg.matchAll(/>([^<>]+)<\/text>/g)].map((m) => m[1]);
    const withWeek = words(card("idle", week()));
    const without = words(card("idle", undefined));
    expect(withWeek.filter((w) => !/this week|day streak/.test(w!))).toEqual(without);
    const image = (svg: string) => svg.match(/<image[^>]*>/)?.[0];
    expect(image(card("idle", week()))).toBe(image(card("idle", undefined)));
  });
});
