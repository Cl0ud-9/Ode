import { type Lch, type Rgb, contrast, ensureContrast, lchToRgb, rgbToLch, toHex } from "./color.ts";

/** The few numbers extracted from album art; everything else is derived. */
export interface Seed {
  h1: number; // dominant hue
  c1: number; // dominant chroma (already clamped to a pleasant range)
  h2: number; // accent hue
  neutralC: number; // chroma used for surfaces (tinted greys)
}

export type Role =
  | "surface" | "container" | "containerHigh" | "onSurface" | "onVariant" | "outline"
  | "primary" | "onPrimary" | "primaryContainer" | "onPrimaryContainer"
  | "secondaryContainer" | "onSecondaryContainer" | "tertiary" | "tertiaryContainer"
  | "bgA" | "bgB";

export type Scheme = Record<Role, string>;
export interface Palette { light: Scheme; dark: Scheme; seed: Seed }

const HUE_BINS = 24;

/** Pull a dominant and an accent hue out of RGBA pixels (any size; sampled sparsely). */
export function seedFromPixels(rgba: ArrayLike<number>, width: number, height: number): Seed | null {
  const weight = new Array<number>(HUE_BINS).fill(0);
  const sumC = new Array<number>(HUE_BINS).fill(0);
  const sumX = new Array<number>(HUE_BINS).fill(0);
  const sumY = new Array<number>(HUE_BINS).fill(0);
  const sumN = new Array<number>(HUE_BINS).fill(0);
  let total = 0, chromaSum = 0, counted = 0;
  const step = Math.max(1, Math.floor(Math.min(width, height) / 48));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      if ((rgba[i + 3] ?? 255) < 128) continue;
      const { l, c, h } = rgbToLch({ r: rgba[i]!, g: rgba[i + 1]!, b: rgba[i + 2]! });
      counted++;
      chromaSum += c;
      if (c < 0.03 || l < 0.12 || l > 0.97) continue;
      const w = c * c * Math.max(0.15, 1 - Math.abs(l - 0.6) * 1.4);
      const bin = Math.floor(h / (360 / HUE_BINS)) % HUE_BINS;
      weight[bin]! += w;
      sumC[bin]! += c * w;
      sumX[bin]! += Math.cos((h * Math.PI) / 180) * w;
      sumY[bin]! += Math.sin((h * Math.PI) / 180) * w;
      sumN[bin]! += w;
      total += w;
    }
  }
  if (counted === 0) return null;
  const avgChroma = chromaSum / counted;
  if (total < 1e-4 || avgChroma < 0.025) {
    // Greyscale-ish art: keep it calm and neutral.
    return { h1: 255, c1: 0.03, h2: 255, neutralC: 0.006 };
  }
  const binHue = (b: number) => ((Math.atan2(sumY[b]!, sumX[b]!) * 180) / Math.PI + 360) % 360;
  const binChroma = (b: number) => sumC[b]! / sumN[b]!;
  const order = weight.map((w, b) => [w, b] as const).sort((a, b) => b[0] - a[0]);
  const first = order[0]![1];
  const h1 = binHue(first);
  let h2 = (h1 + 55) % 360;
  for (const [w, b] of order.slice(1)) {
    if (w < order[0]![0] * 0.15) break;
    const d = Math.abs(((binHue(b) - h1 + 540) % 360) - 180);
    if (d >= 40) { h2 = binHue(b); break; }
  }
  const c1 = Math.min(0.2, Math.max(0.09, binChroma(first) * 1.1));
  return { h1, c1, h2, neutralC: Math.min(0.03, Math.max(0.01, c1 * 0.12)) };
}

/** Deterministic fallback seed for art-less tracks. */
export function seedFromHash(n: number): Seed {
  const h1 = n % 360;
  return { h1, c1: 0.13, h2: (h1 + 70 + (n >> 8) % 60) % 360, neutralC: 0.014 };
}

type Tone = number; // 0..100, mapped onto OKLab lightness
const tone = (t: Tone) => Math.pow(t / 100, 0.9) * 0.97 + 0.01; // slight curve so tones feel M3-like

function build(seed: Seed, dark: boolean): Scheme {
  const col = (t: Tone, c: number, h: number): Lch => ({ l: tone(t), c, h });
  const hex = (l: Lch) => toHex(lchToRgb(l));
  const n = seed.neutralC;
  const surfaceL = dark ? col(8, n, seed.h1) : col(98, n, seed.h1);
  const surface = lchToRgb(surfaceL);
  const container = lchToRgb(dark ? col(14, n * 1.2, seed.h1) : col(94, n * 1.2, seed.h1));
  const containerHigh = lchToRgb(dark ? col(20, n * 1.4, seed.h1) : col(90, n * 1.4, seed.h1));

  const primaryContainerL = dark ? col(32, seed.c1 * 0.85, seed.h1) : col(88, seed.c1 * 0.55, seed.h1);
  const primaryContainer = lchToRgb(primaryContainerL);
  const secondaryContainerL = dark ? col(26, seed.c1 * 0.6, seed.h2) : col(90, seed.c1 * 0.45, seed.h2);
  const secondaryContainer = lchToRgb(secondaryContainerL);

  // Art-tinted gradient endpoints for the card background; light enough to keep every text role readable.
  const bgA = dark ? col(17, seed.c1 * 0.42, seed.h1) : col(95, seed.c1 * 0.3, seed.h1);
  const bgB = dark ? col(9, seed.c1 * 0.34, seed.h2) : col(89, seed.c1 * 0.34, seed.h2);
  const tertiaryContainer = lchToRgb(dark ? col(30, seed.c1 * 0.7, seed.h2) : col(86, seed.c1 * 0.5, seed.h2));

  const text = (t: Tone, c: number, h: number, bg: Rgb, min: number) => hex(ensureContrast(col(t, c, h), bg, min));
  return {
    surface: toHex(surface),
    container: toHex(container),
    containerHigh: toHex(containerHigh),
    onSurface: text(dark ? 92 : 10, n, seed.h1, container, 7),
    onVariant: text(dark ? 76 : 36, n * 1.5, seed.h1, container, 4.5),
    outline: text(dark ? 52 : 62, n * 1.5, seed.h1, container, 1.6),
    primary: text(dark ? 80 : 42, seed.c1, seed.h1, container, 3.2),
    onPrimary: text(dark ? 20 : 98, seed.c1 * 0.4, seed.h1, lchToRgb(col(dark ? 80 : 42, seed.c1, seed.h1)), 4.5),
    primaryContainer: toHex(primaryContainer),
    onPrimaryContainer: text(dark ? 92 : 16, seed.c1 * 0.5, seed.h1, primaryContainer, 7),
    secondaryContainer: toHex(secondaryContainer),
    onSecondaryContainer: text(dark ? 90 : 18, seed.c1 * 0.4, seed.h2, secondaryContainer, 7),
    tertiaryContainer: toHex(tertiaryContainer),
    bgA: hex(bgA),
    bgB: hex(bgB),
    tertiary: text(dark ? 80 : 44, seed.c1, seed.h2, container, 3.2),
  };
}

export function paletteFromSeed(seed: Seed): Palette {
  return { light: build(seed, false), dark: build(seed, true), seed };
}

export { contrast };
