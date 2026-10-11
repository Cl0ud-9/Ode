import { describe, expect, it } from "vitest";
import { cacheKey, parseParams } from "../src/params.ts";

const p = (q: string) => parseParams(new URL(`https://x.dev/api/now?${q}`));

describe("parseParams", () => {
  it("applies defaults", () => {
    expect(p("user=rj")).toMatchObject({ user: "rj", invalidUser: false, demo: null, opts: { theme: "expressive", mode: "auto", still: false } });
  });

  it("falls back on unknown values", () => {
    expect(p("user=rj&theme=nope&mode=blue&demo=zzz").opts).toMatchObject({ theme: "expressive", mode: "auto" });
    expect(p("demo=zzz").demo).toBeNull();
  });

  it("flags invalid usernames", () => {
    expect(p("user=a b")).toMatchObject({ user: null, invalidUser: true });
    expect(p("")).toMatchObject({ user: null, invalidUser: false });
  });

  it("cache key ignores junk params and username case", () => {
    expect(cacheKey("https://x.dev", p("user=RJ&cb=123"))).toBe(cacheKey("https://x.dev", p("user=rj")));
    expect(cacheKey("https://x.dev", p("user=rj&theme=terminal"))).not.toBe(cacheKey("https://x.dev", p("user=rj")));
  });
});
