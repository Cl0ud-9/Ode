import { describe, expect, it } from "vitest";
import { FAST_FOR, MEDIUM_FOR, MEDIUM_MS, SLEEPY_MS, pollDelay } from "../site/pace.js";

describe("how often the page asks about the song", () => {
  it("keeps the server's own pace while the page is being used", () => {
    expect(pollDelay(0)).toBe(4000);
    expect(pollDelay(FAST_FOR - 1, 4000)).toBe(4000);
    expect(pollDelay(0, 20000)).toBe(20000);
  });

  it("slows down in two steps the longer the page sits untouched", () => {
    expect(pollDelay(FAST_FOR, 4000)).toBe(MEDIUM_MS);
    expect(pollDelay(MEDIUM_FOR - 1, 4000)).toBe(MEDIUM_MS);
    expect(pollDelay(MEDIUM_FOR, 4000)).toBe(SLEEPY_MS);
    expect(pollDelay(24 * 3_600_000, 4000)).toBe(SLEEPY_MS);
  });

  it("never asks faster than the server says, or than 4 seconds", () => {
    expect(pollDelay(MEDIUM_FOR, 60000)).toBe(60000);
    expect(pollDelay(0, 1000)).toBe(4000);
    expect(pollDelay(0, null)).toBe(4000);
    expect(pollDelay(0, "garbage")).toBe(4000);
  });

  it("costs a page left open all day about a seventh of what it did", () => {
    const perDay = (idle) => 86_400_000 / pollDelay(idle);
    expect(perDay(0)).toBe(21_600); // what every page did, always
    expect(perDay(MEDIUM_FOR)).toBeLessThan(3000);
  });
});
