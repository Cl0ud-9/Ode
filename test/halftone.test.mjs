import { describe, expect, it } from "vitest";
import { dotRadius, fitSize, step, warmth } from "../site/halftone.js";

describe("halftone footer", () => {
  it("sizes dots by area, clamped to the cell", () => {
    expect(dotRadius(0, 6)).toBe(0);
    expect(dotRadius(-1, 6)).toBe(0);
    expect(dotRadius(1, 6)).toBeCloseTo(3.36);
    expect(dotRadius(2, 6)).toBe(dotRadius(1, 6));
    // A quarter of the coverage is half the radius, so tone stays even.
    expect(dotRadius(0.25, 6)).toBeCloseTo(dotRadius(1, 6) / 2);
  });

  it("pushes a dot away from a nearby pointer", () => {
    const [x, y] = step(100, 100, 0, 0, 100, 100, 90, 100, 80);
    expect(x).toBeGreaterThan(100);
    expect(y).toBeCloseTo(100);
  });

  it("leaves a dot alone when the pointer is out of reach", () => {
    expect(step(100, 100, 0, 0, 100, 100, 300, 100, 80)).toEqual([100, 100, 0, 0]);
  });

  it("brings a displaced dot home and to rest", () => {
    let s = [140, 70, 0, 0];
    for (let i = 0; i < 400; i++) s = step(s[0], s[1], s[2], s[3], 100, 100, -1e5, -1e5, 80);
    expect(Math.abs(s[0] - 100) + Math.abs(s[1] - 100)).toBeLessThan(0.01);
    expect(Math.abs(s[2]) + Math.abs(s[3])).toBeLessThan(0.01);
  });

  it("drags a dot along with a moving pointer", () => {
    const still = step(100, 100, 0, 0, 100, 100, 90, 100, 80);
    const swept = step(100, 100, 0, 0, 100, 100, 90, 100, 80, 0, 20);
    expect(still[3]).toBeCloseTo(0);
    expect(swept[3]).toBeGreaterThan(1);
  });

  it("warms with distance from home, up to 1", () => {
    expect(warmth(0, 0, 0, 0, 28)).toBe(0);
    expect(warmth(14, 0, 0, 0, 28)).toBeCloseTo(0.5);
    expect(warmth(100, 0, 0, 0, 28)).toBe(1);
    expect(warmth(5, 0, 0, 0, 0)).toBe(0);
  });

  it("fits the word to the width, unless that would overflow the height", () => {
    // 200px wide and 70px tall at 100px: a wide, tall stage is limited by its width.
    expect(fitSize(200, 70, 1000, 2000, 0.2)).toBeCloseTo(500);
    // A short stage: the cap above the crop fills 90% of the height instead.
    const size = fitSize(200, 70, 1000, 200, 0.2);
    expect(size).toBeLessThan(500);
    expect((size / 100) * 70 * 0.8).toBeCloseTo(180);
    expect(fitSize(0, 70, 1000, 200, 0.2)).toBe(0);
  });
});
