import { describe, expect, it } from "vitest";
import { contrast } from "../src/color.ts";
import { paletteFromSeed, seedFromHash, seedFromPixels, type Scheme } from "../src/palette.ts";

const rgb = (hex: string) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });

function solid(r: number, g: number, b: number, n = 32) {
  const data = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  }
  return { data, w: n, h: n };
}

describe("seedFromPixels", () => {
  it("finds the hue of a saturated image", () => {
    const { data, w, h } = solid(230, 60, 40);
    const seed = seedFromPixels(data, w, h)!;
    expect(seed.h1).toBeGreaterThan(15);
    expect(seed.h1).toBeLessThan(55);
    expect(seed.c1).toBeGreaterThan(0.09);
  });

  it("treats greyscale art as neutral", () => {
    const { data, w, h } = solid(128, 128, 128);
    expect(seedFromPixels(data, w, h)!.neutralC).toBeLessThan(0.01);
  });

  it("ignores fully transparent images", () => {
    const data = new Uint8Array(16 * 16 * 4);
    expect(seedFromPixels(data, 16, 16)).toBeNull();
  });
});

describe("tonal schemes stay readable for any hue", () => {
  const pairs = (s: Scheme): [string, string, number][] => [
    [s.onSurface, s.container, 7],
    [s.onSurface, s.surface, 7],
    [s.onVariant, s.container, 4.5],
    [s.onPrimaryContainer, s.primaryContainer, 7],
    [s.onSecondaryContainer, s.secondaryContainer, 7],
    [s.onPrimary, s.primary, 4.5],
    [s.primary, s.container, 3],
    [s.tertiary, s.container, 3],
  ];

  it("meets contrast targets across a hue sweep and both modes", () => {
    for (let h = 0; h < 360; h += 12) {
      for (const c of [0.03, 0.1, 0.2]) {
        const p = paletteFromSeed({ h1: h, c1: c, h2: (h + 60) % 360, neutralC: 0.012 });
        for (const scheme of [p.light, p.dark]) {
          for (const [fg, bg, min] of pairs(scheme)) {
            expect(contrast(rgb(fg), rgb(bg)), `h=${h} c=${c} ${fg} on ${bg}`).toBeGreaterThanOrEqual(min - 0.05);
          }
        }
      }
    }
  });

  it("hash seeds are deterministic and differ between tracks", () => {
    expect(seedFromHash(12345)).toEqual(seedFromHash(12345));
    expect(seedFromHash(12345).h1).not.toBe(seedFromHash(54321).h1);
  });
});
