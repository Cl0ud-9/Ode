import jpeg from "jpeg-js";
import { decode as decodePng } from "fast-png";
import { type Seed, seedFromPixels } from "./palette.ts";
import { bytesToBase64 } from "./util.ts";

export interface Art { dataUri: string; seed: Seed }

const ALLOWED_HOSTS = new Set(["lastfm.freetls.fastly.net", "lastfm-img2.akamaized.net"]);
const MAX_EMBED_BYTES = 40_000;

/** Last.fm image URLs carry a size segment, e.g. /i/u/300x300/<hash>.jpg. */
export function sizedUrl(url: string, size: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname)) return null;
  const swapped = u.pathname.replace(/\/i\/u\/(?:[^/]+\/)?([^/]+)$/, `/i/u/${size}/$1`);
  if (swapped === u.pathname && !/\/i\/u\//.test(u.pathname)) return null;
  u.pathname = swapped;
  return u.toString();
}

function mimeOf(b: Uint8Array): "image/jpeg" | "image/png" | null {
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  return null;
}

export function decodeToRgba(bytes: Uint8Array): { data: ArrayLike<number>; width: number; height: number } | null {
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

async function getBytes(url: string, fetcher: typeof fetch): Promise<Uint8Array | null> {
  try {
    const res = await fetcher(url, { cf: { cacheTtl: 86400, cacheEverything: true } } as RequestInit);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length > 0 && buf.length < 400_000 ? buf : null;
  } catch { return null; }
}

/** Fetch art, derive a palette seed from a tiny copy, and return an embeddable data URI. */
export async function loadArt(artUrl: string, fetcher: typeof fetch = fetch): Promise<Art | null> {
  const small = sizedUrl(artUrl, "64s");
  const medium = sizedUrl(artUrl, "174s");
  if (!small || !medium) return null;
  const [smallBytes, mediumBytes] = await Promise.all([getBytes(small, fetcher), getBytes(medium, fetcher)]);
  const embed = mediumBytes && mediumBytes.length <= MAX_EMBED_BYTES ? mediumBytes : smallBytes;
  if (!embed || !smallBytes) return null;
  const mime = mimeOf(embed);
  const px = decodeToRgba(smallBytes);
  if (!mime || !px) return null;
  const seed = seedFromPixels(px.data, px.width, px.height);
  if (!seed) return null;
  return { dataUri: `data:${mime};base64,${bytesToBase64(embed)}`, seed };
}
