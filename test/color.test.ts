import { describe, expect, it } from "vitest";
import { contrast, ensureContrast, lchToRgb, rgbToLch, toHex } from "../src/color.ts";

describe("color", () => {
  it("round-trips sRGB through OKLCH", () => {
    for (const rgb of [{ r: 255, g: 0, b: 0 }, { r: 12, g: 200, b: 90 }, { r: 120, g: 120, b: 120 }, { r: 0, g: 0, b: 0 }]) {
      const back = lchToRgb(rgbToLch(rgb));
      expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(1);
    }
  });

  it("always yields an in-range colour even for impossible chroma", () => {
    const { r, g, b } = lchToRgb({ l: 0.9, c: 0.4, h: 260 });
    for (const v of [r, g, b]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
  });

  it("formats hex", () => {
    expect(toHex({ r: 255, g: 0, b: 128 })).toBe("#ff0080");
  });

  it("ensureContrast reaches the requested ratio on light and dark backgrounds", () => {
    for (const bg of [{ r: 250, g: 248, b: 255 }, { r: 20, g: 20, b: 28 }]) {
      const fg = lchToRgb(ensureContrast({ l: bg.r > 128 ? 0.85 : 0.3, c: 0.1, h: 280 }, bg, 7));
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(7);
    }
  });
});
