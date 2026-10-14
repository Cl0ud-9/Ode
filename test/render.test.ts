import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it } from "vitest";
import { renderCard } from "../src/card.ts";
import { DEMOS, demoCard } from "../src/demo.ts";
import { MODES, THEMES } from "../src/model.ts";

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
