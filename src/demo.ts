import { encode } from "fast-png";
import type { Art } from "./art.ts";
import { decodeToRgba } from "./art.ts";
import { dataForFailure, dataForTrack } from "./card.ts";
import type { CardData } from "./model.ts";
import { seedFromPixels, type Seed } from "./palette.ts";
import { bytesToBase64 } from "./util.ts";

export const DEMOS = ["playing", "idle", "empty", "error", "noart"] as const;
export type Demo = (typeof DEMOS)[number];

/** A procedural "album cover" so demos and tests need no network. */
export function demoCover(size = 112): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  const circles = [
    { x: 0.3, y: 0.35, r: 0.32, c: [255, 120, 70] },
    { x: 0.7, y: 0.6, r: 0.28, c: [240, 60, 130] },
    { x: 0.5, y: 0.9, r: 0.4, c: [90, 50, 160] },
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let r = 30 + 120 * v, g = 20 + 40 * v, b = 80 + 90 * (1 - v);
      for (const c of circles) {
        const dist = Math.hypot(u - c.x, v - c.y);
        if (dist < c.r) {
          const t = 1 - dist / c.r;
          r += (c.c[0]! - r) * t; g += (c.c[1]! - g) * t; b += (c.c[2]! - b) * t;
        }
      }
      const i = (y * size + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return encode({ width: size, height: size, data, depth: 8, channels: 4 });
}

function demoArt(): Art {
  const png = demoCover();
  const px = decodeToRgba(png)!;
  return { dataUri: `data:image/png;base64,${bytesToBase64(png)}`, seed: seedFromPixels(px.data, px.width, px.height)! };
}

export function demoCard(kind: Demo, now: number): { data: CardData; seed: Seed | null } {
  const track = {
    title: "Midnight Tide Overdrive",
    artist: "The Harbour Lights",
    album: "Salt & Static",
    artUrl: null,
  };
  switch (kind) {
    case "playing":
      return dataForTrack({ user: "cloud9", status: "playing", track: { ...track, playedAt: null } }, demoArt(), now);
    case "idle":
      return dataForTrack({ user: "cloud9", status: "idle", track: { ...track, playedAt: now - 3 * 3600, plays: 42 } }, demoArt(), now);
    case "noart":
      return dataForTrack({ user: "cloud9", status: "playing", track: { ...track, playedAt: null } }, null, now);
    case "empty":
      return { data: dataForFailure("cloud9", "empty", now), seed: null };
    default:
      return { data: dataForFailure("cloud9", "upstream", now), seed: null };
  }
}
