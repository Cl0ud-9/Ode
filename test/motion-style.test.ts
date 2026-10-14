import { describe, expect, it } from "vitest";
import { cardKey, dataForTrack, renderCard } from "../src/card.ts";
import { demoCard } from "../src/demo.ts";
import { STYLES, type NowPlaying, type Theme } from "../src/model.ts";
import { fetchMood, moodFromTags, type Mood } from "../src/mood.ts";
import { contrast, paletteFromSeed, styleSeed, type Seed } from "../src/palette.ts";
import { cacheKey, parseParams } from "../src/params.ts";

const now = 1_800_000_000;
const rgb = (hex: string) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });
const track = { title: "Closer", artist: "The Chainsmokers", album: "Collage", artUrl: null, playedAt: null };
const playing: NowPlaying = { user: "u", status: "playing", track };
const svgFor = (np: NowPlaying, mood?: Mood, theme: Theme = "expressive") => {
  const { data, seed } = dataForTrack(np, null, now, mood);
  return renderCard(data, seed, { theme, mode: "dark", still: false });
};
const waveDur = (svg: string) => Number(svg.match(/<animateTransform attributeName="transform" type="translate" from="0 0"[^>]*dur="([\d.]+)s"/)![1]);
const eqDur = (svg: string) => Number(svg.match(/animation:eq ([\d.]+)s/)![1]);

describe("the song's mood", () => {
  const tag = (name: string, count: number) => ({ name, count });

  it("is read from the strongest tags", () => {
    expect(moodFromTags([tag("ambient", 100), tag("chillout", 60)])).toBe("calm");
    expect(moodFromTags([tag("Dubstep", 100), tag("EDM", 80)])).toBe("intense");
    expect(moodFromTags([tag("pop", 100), tag("dance", 50)])).toBe("lively");
    expect(moodFromTags([tag("bhajan", 100), tag("devotional", 40)])).toBe("calm");
  });

  it("stays steady when tags are missing, unknown or too weak to call", () => {
    expect(moodFromTags([])).toBe("steady");
    expect(moodFromTags([tag("seen live", 100), tag("favourites", 80)])).toBe("steady");
    expect(moodFromTags([tag("metal", 5)])).toBe("steady");
  });

  it("uses the song's tags, then the artist's, and never fails", async () => {
    const asked: string[] = [];
    const lastfm = (byMethod: Record<string, object>) => (async (u: string | URL | Request) => {
      const method = new URL(String(u)).searchParams.get("method")!;
      asked.push(method);
      return Response.json(byMethod[method] ?? { error: 6 });
    }) as typeof fetch;
    const tags = (...t: [string, number][]) => ({ toptags: { tag: t.map(([name, count]) => ({ name, count })) } });

    expect(await fetchMood(track, "k", lastfm({ "track.gettoptags": tags(["edm", 100]) }))).toBe("intense");
    expect(asked).toEqual(["track.gettoptags"]);
    asked.length = 0;
    expect(await fetchMood(track, "k", lastfm({ "track.gettoptags": tags(), "artist.gettoptags": tags(["ambient", 90]) }))).toBe("calm");
    expect(asked).toEqual(["track.gettoptags", "artist.gettoptags"]);
    expect(await fetchMood(track, "k", (async () => { throw new Error("down"); }) as unknown as typeof fetch)).toBe("steady");
  });

  it("sets the tempo: a calm song's wave travels slowly, an intense one's fast", () => {
    expect(waveDur(svgFor(playing, "calm"))).toBeGreaterThan(waveDur(svgFor(playing)));
    expect(waveDur(svgFor(playing, "intense"))).toBeLessThan(waveDur(svgFor(playing)));
    expect(eqDur(svgFor(playing, "intense"))).toBeLessThan(eqDur(svgFor(playing, "calm")));
    expect(waveDur(svgFor(playing, "intense", "minimal"))).toBeLessThan(waveDur(svgFor(playing, undefined, "minimal")));
  });

  it("only applies while a song plays, and tells the website when it changes the card", () => {
    const idle = dataForTrack({ ...playing, status: "idle", track: { ...track, playedAt: now - 60 } }, null, now, "intense").data;
    expect(idle.mood).toBeUndefined();
    expect(cardKey(dataForTrack(playing, null, now, "calm").data)).not.toBe(cardKey(dataForTrack(playing, null, now).data));
  });
});

describe("colour styles", () => {
  const seed: Seed = { h1: 290, c1: 0.16, h2: 340, neutralC: 0.02 };

  it("follow the Material You variants", () => {
    expect(styleSeed(seed)).toEqual(seed); // content: the cover's own colours
    expect(styleSeed(seed, "tonal").c1).toBeLessThan(seed.c1);
    expect(styleSeed(seed, "vibrant").c1).toBeGreaterThanOrEqual(seed.c1);
    expect(styleSeed(seed, "expressive").h1).toBe((seed.h1 + 240) % 360);
    expect(styleSeed(seed, "fidelity").c1).toBeGreaterThan(seed.c1);
    expect(styleSeed(seed, "mono")).toMatchObject({ c1: 0, neutralC: 0 });
  });

  it("keep every style readable in light and dark", () => {
    for (const style of STYLES) {
      for (const h1 of [0, 60, 120, 200, 290]) {
        const p = paletteFromSeed(styleSeed({ ...seed, h1 }, style));
        for (const scheme of [p.light, p.dark]) {
          expect(contrast(rgb(scheme.onSurface), rgb(scheme.container))).toBeGreaterThanOrEqual(7 - 0.05);
          expect(contrast(rgb(scheme.onPrimaryContainer), rgb(scheme.primaryContainer))).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("are chosen with ?scheme=, ignore unknown values, and are part of the cache key", () => {
    const at = (q: string) => parseParams(new URL(`https://t.dev/api/now?user=cloud9${q}`));
    expect(at("&scheme=vibrant").opts.style).toBe("vibrant");
    expect(at("&scheme=MONO").opts.style).toBe("mono");
    expect(at("&scheme=neon").opts.style).toBe("content");
    expect(cacheKey("https://t.dev", at("&scheme=mono"))).not.toBe(cacheKey("https://t.dev", at("")));
  });
});

describe("the living cover", () => {
  const withCover = (status: "playing" | "idle", still = false, theme: Theme = "expressive") => {
    const demo = demoCard(status, now);
    return renderCard(demo.data, demo.seed, { theme, mode: "dark", still });
  };

  it("drifts, zooms and catches the light while a song plays, in every theme", () => {
    for (const theme of ["expressive", "minimal", "terminal"] as const) {
      const svg = withCover("playing", false, theme);
      expect(svg).toContain('type="scale" values="1.02;1.08;1.02"');
      expect(svg).toContain('class="ls"');
    }
  });

  it("stays still when nothing plays and with ?still=1", () => {
    expect(withCover("idle")).not.toContain('class="lc"');
    expect(withCover("playing", true)).not.toContain('class="lc"');
    expect(withCover("playing", true)).toContain("<image");
  });

  it("is pinned under reduced motion", () => {
    expect(withCover("playing")).toContain("@media (prefers-reduced-motion:reduce){.lc{transform:none!important}.ls{display:none}}");
  });
});
