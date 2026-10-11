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
        });
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
