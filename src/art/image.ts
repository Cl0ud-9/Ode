import { convertIndexedToRgb, decode as decodePng } from "fast-png";
import jpeg from "jpeg-js";
import { seedFromPixels } from "../palette.ts";
import { bytesToBase64 } from "../util.ts";
import { getBytes } from "./http.ts";
import type { Art } from "./types.ts";

/**
 * The cover is drawn about 110 CSS pixels wide, so 240px is sharp even on a 2x screen. Anything heavier than this
 * is shrunk and re-encoded: the image is most of the card's bytes, and card size is load time.
 */
const COVER_PX = 240;
const SHRINK_ABOVE_BYTES = 24_000;
const MAX_EMBED_BYTES = 60_000;
const JPEG_QUALITY = 82;

export interface Pixels { data: ArrayLike<number>; width: number; height: number }

function mimeOf(b: Uint8Array): "image/jpeg" | "image/png" | null {
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  return null;
}

/** The first bytes, which name the format when it is not one we decode (GIF "47494638", WebP "52494646"). */
const head = (b: Uint8Array) => Array.from(b.subarray(0, 4), (x) => x.toString(16).padStart(2, "0")).join("");

/** RGBA pixels of a JPEG or PNG (including palette PNGs), or null. */
export function decodeToRgba(bytes: Uint8Array): Pixels | null {
  try {
    const mime = mimeOf(bytes);
    if (mime === "image/jpeg") {
      const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 32 });
      return { data: img.data, width: img.width, height: img.height };
    }
    if (mime === "image/png") {
      const img = decodePng(bytes);
      const px = img.width * img.height;
      const out = new Uint8Array(px * 4);
      if (img.palette) {
        // Indexed PNG (Genius serves many covers like this): its samples are palette indexes, not grey levels.
        // Reading them as grey turned colour covers into a noisy grey picture and a grey palette.
        const rgb = convertIndexedToRgb(img);
        const ch = rgb.length / px; // 3, or 4 when the palette carries transparency
        for (let i = 0; i < px; i++) {
          out[i * 4] = rgb[i * ch]!; out[i * 4 + 1] = rgb[i * ch + 1]!; out[i * 4 + 2] = rgb[i * ch + 2]!;
          out[i * 4 + 3] = ch === 4 ? rgb[i * ch + 3]! : 255;
        }
        return { data: out, width: img.width, height: img.height };
      }
      const shift = img.depth === 16 ? 8 : 0;
      for (let i = 0; i < px; i++) {
        const s = i * img.channels;
        const v = (k: number) => (img.data[s + k]! as number) >> shift;
        if (img.channels >= 3) { out[i * 4] = v(0); out[i * 4 + 1] = v(1); out[i * 4 + 2] = v(2); out[i * 4 + 3] = img.channels === 4 ? v(3) : 255; }
        else { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v(0); out[i * 4 + 3] = img.channels === 2 ? v(1) : 255; }
      }
      return { data: out, width: img.width, height: img.height };
    }
  } catch { /* fall through */ }
  return null;
}

/** Area-average downscale (each output pixel is the mean of the block it covers): smooth, no aliasing. */
function downscale(src: ArrayLike<number>, w: number, h: number, maxSide: number): { data: Uint8Array; width: number; height: number } {
  const scale = Math.max(w, h) / maxSide;
  if (scale <= 1) return { data: Uint8Array.from(src as ArrayLike<number>), width: w, height: h };
  const tw = Math.max(1, Math.round(w / scale));
  const th = Math.max(1, Math.round(h / scale));
  const out = new Uint8Array(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor((y * h) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / th));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor((x * w) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / tw));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * w + xx) * 4;
          r += src[i]!; g += src[i + 1]!; b += src[i + 2]!; n++;
        }
      }
      const o = (y * tw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, width: tw, height: th };
}

/** Pixels shrunk to the cover size and encoded as JPEG, or null if encoding fails. */
function toCoverJpeg(px: Pixels): Uint8Array | null {
  try {
    return new Uint8Array(jpeg.encode(downscale(px.data, px.width, px.height, COVER_PX), JPEG_QUALITY).data);
  } catch {
    return null;
  }
}

/** A smaller JPEG of the same cover, or null when the original is already small or cannot be decoded. */
export function compactCover(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length <= SHRINK_ABOVE_BYTES) return null;
  const px = decodeToRgba(bytes);
  const out = px && toCoverJpeg(px);
  return out && out.length < bytes.length ? out : null;
}

/** Art from cover bytes already at the right size (a palette seed is derived from them). */
export function artFromJpeg(bytes: Uint8Array): Art | null {
  const px = decodeToRgba(bytes);
  const seed = px && seedFromPixels(px.data, px.width, px.height);
  return seed ? { dataUri: `data:image/jpeg;base64,${bytesToBase64(bytes)}`, seed } : null;
}

/**
 * Fetch a small and a medium copy, derive a palette seed from the small one, and return an embeddable data URI.
 * The medium copy is used even when it is heavy: it is shrunk to a 240px JPEG anyway, which keeps covers sharp
 * (stepping down to a smaller original made them visibly soft on 2x screens). Only if it cannot be used at all
 * does a strict call give up, so the caller can try another size.
 */
export async function embed(small: string, medium: string, fetcher: typeof fetch, strict = false, why?: string[]): Promise<Art | null> {
  const [smallBytes, mediumBytes] = small === medium
    ? await getBytes(small, fetcher, why).then((b) => [b, b] as const)
    : await Promise.all([getBytes(small, fetcher, why), getBytes(medium, fetcher, why)]);
  if (!smallBytes) return null;
  const compact = mediumBytes ? compactCover(mediumBytes) : null;
  const usable = !!mediumBytes && (!!compact || mediumBytes.length <= MAX_EMBED_BYTES) && !!mimeOf(mediumBytes);
  if (strict && !usable) return null;
  const bytes = usable ? mediumBytes! : smallBytes;
  const mime = mimeOf(bytes);
  const px = decodeToRgba(smallBytes);
  if (!mime) return void why?.push(`format-${head(bytes)}`), null;
  if (!px) return void why?.push(mimeOf(smallBytes) ? "decode" : `format-${head(smallBytes)}`), null;
  const seed = seedFromPixels(px.data, px.width, px.height);
  if (!seed) return void why?.push("no-pixels"), null;
  const shrunk = usable ? compact : compactCover(bytes);
  return { dataUri: shrunk ? `data:image/jpeg;base64,${bytesToBase64(shrunk)}` : `data:${mime};base64,${bytesToBase64(bytes)}`, seed };
}

/**
 * Cuts the cover out of a YouTube art-track thumbnail. Topic channels publish every label release as a still video:
 * the official cover, square, centred in a 16:9 frame between two flat, dimmed side panels; the 4:3 thumbnail adds
 * black bars above and below. Measured on real art tracks: 480x360 holds a 270px cover at (105, 45).
 * A music video's frame has detail in those side panels, so it is rejected rather than cropped into a wrong cover.
 */
export function coverFromArtTrack(bytes: Uint8Array): Uint8Array | null {
  const img = decodeToRgba(bytes);
  if (!img) return null;
  const { width: w, height: h, data } = img;
  const side = Math.round((w * 9) / 16);
  const top = Math.round((h - side) / 2);
  const left = Math.round((w - side) / 2);
  if (side > h || left < 8) return null;
  // The side panels of an art track are one flat colour: little variation within each column.
  const lum = (x: number, y: number) => { const i = (y * w + x) * 4; return 0.3 * data[i]! + 0.59 * data[i + 1]! + 0.11 * data[i + 2]!; };
  let spread = 0;
  for (const x of [Math.floor(left / 3), Math.floor(left / 2), w - 1 - Math.floor(left / 3), w - 1 - Math.floor(left / 2)]) {
    let lo = 255, hi = 0;
    for (let y = top + 4; y < top + side - 4; y += 3) { const v = lum(x, y); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    spread = Math.max(spread, hi - lo);
  }
  if (spread > 24) return null;
  const crop = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) crop.set((data as Uint8Array).subarray(((top + y) * w + left) * 4, ((top + y) * w + left + side) * 4), y * side * 4);
  return toCoverJpeg({ data: crop, width: side, height: side });
}
