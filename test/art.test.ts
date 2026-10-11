import { describe, expect, it } from "vitest";
import { loadArt, sizedUrl } from "../src/art.ts";
import { demoCover } from "../src/demo.ts";

describe("sizedUrl", () => {
  it("swaps the size segment on Last.fm hosts only", () => {
    expect(sizedUrl("https://lastfm.freetls.fastly.net/i/u/300x300/abc.jpg", "64s")).toBe("https://lastfm.freetls.fastly.net/i/u/64s/abc.jpg");
    expect(sizedUrl("https://lastfm.freetls.fastly.net/i/u/abc.jpg", "174s")).toBe("https://lastfm.freetls.fastly.net/i/u/174s/abc.jpg");
    expect(sizedUrl("https://evil.example/i/u/300x300/abc.jpg", "64s")).toBeNull();
    expect(sizedUrl("http://lastfm.freetls.fastly.net/i/u/300x300/abc.jpg", "64s")).toBeNull();
    expect(sizedUrl("not a url", "64s")).toBeNull();
  });
});

describe("loadArt", () => {
  const url = "https://lastfm.freetls.fastly.net/i/u/300x300/abc.png";

  it("embeds the image and derives a seed", async () => {
    const asked: string[] = [];
    const art = await loadArt(url, async (u) => {
      asked.push(String(u));
      return new Response(demoCover(String(u).includes("174s") ? 112 : 64));
    });
    expect(art?.dataUri.startsWith("data:image/png;base64,")).toBe(true);
    expect(asked.sort()).toEqual(["https://lastfm.freetls.fastly.net/i/u/174s/abc.png", "https://lastfm.freetls.fastly.net/i/u/64s/abc.png"]);
    expect(art?.seed.c1).toBeGreaterThan(0.05);
  });

  it("returns null on fetch failure, garbage bytes or foreign hosts", async () => {
    expect(await loadArt(url, async () => new Response("", { status: 404 }))).toBeNull();
    expect(await loadArt(url, async () => new Response(new Uint8Array([1, 2, 3, 4])))).toBeNull();
    expect(await loadArt("https://example.com/i/u/x/a.png", async () => { throw new Error("must not fetch"); })).toBeNull();
  });
});
