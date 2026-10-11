import jpeg from "jpeg-js";
import { decode as decodePng } from "fast-png";
import { type Seed, seedFromPixels } from "./palette.ts";
import { pickArt, type RawImage } from "./lastfm.ts";
import type { Track } from "./model.ts";
import type { Store } from "./store.ts";
import { bytesToBase64, hash } from "./util.ts";

export interface Art { dataUri: string; seed: Seed }

const ALLOWED_HOSTS = new Set(["lastfm.freetls.fastly.net", "lastfm-img2.akamaized.net"]);
const ITUNES_SEARCH = "https://itunes.apple.com/search";
const MAX_EMBED_BYTES = 60_000;

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
    const res = await fetcher(url, { cf: cacheOk(86400), signal: AbortSignal.timeout(3000) } as RequestInit);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length > 0 && buf.length < 400_000 ? buf : null;
  } catch { return null; }
}

/** Fetch a small and a medium copy, derive a palette seed from the small one, and return an embeddable data URI. */
async function embed(small: string, medium: string, fetcher: typeof fetch, strict = false): Promise<Art | null> {
  const [smallBytes, mediumBytes] = small === medium
    ? await getBytes(small, fetcher).then((b) => [b, b] as const)
    : await Promise.all([getBytes(small, fetcher), getBytes(medium, fetcher)]);
  const heavy = !mediumBytes || mediumBytes.length > MAX_EMBED_BYTES;
  if (strict && heavy) return null; // the caller will try a smaller size rather than settle for a blurry thumbnail
  const bytes = heavy ? smallBytes : mediumBytes;
  if (!bytes || !smallBytes) return null;
  const mime = mimeOf(bytes);
  const px = decodeToRgba(smallBytes);
  if (!mime || !px) return null;
  const seed = seedFromPixels(px.data, px.width, px.height);
  if (!seed) return null;
  return { dataUri: `data:${mime};base64,${bytesToBase64(bytes)}`, seed };
}

/** Art straight from a Last.fm image URL. */
export async function loadArt(artUrl: string, fetcher: typeof fetch = fetch): Promise<Art | null> {
  const small = sizedUrl(artUrl, "64s");
  const medium = sizedUrl(artUrl, "174s");
  if (!small || !medium) return null;
  return embed(small, medium, fetcher);
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const sameArtist = (a: string, b: string) => {
  const x = norm(a);
  const y = norm(b);
  return x.length > 0 && y.length > 0 && (x === y || x.includes(y) || y.includes(x));
};

interface ItunesHit { artistName?: string; collectionName?: string; trackName?: string; artworkUrl100?: string }

/** A title without the noise that differs between releases: "(Remastered)", "[Live]", "- Radio Edit", "feat. X". */
const core = (t: string) =>
  norm(t.replace(/[(\[][^)\]]*[)\]]/g, " ").replace(/\s[-–—]\s.*$/, " ").replace(/\b(?:feat|ft)\b.*$/i, " ")) || norm(t);

const LOOKUP_TIMEOUT_MS = 2500;
const UA = "Tidemark/0.1 (+https://github.com/Cl0ud-9/tidemark)";

/** Where a cover came from, reported in the `X-Tidemark-Art` header so a missing one can be explained. */
export type ArtSource = "lastfm" | "lastfm-info" | "pending" | "itunes" | "cache" | "none" | "itunes-blocked";
export interface Resolved {
  art: Art | null;
  source: ArtSource;
  /** What each source said when nothing was found, e.g. `itunes:429`; empty on success. */
  tried?: string[];
}

/** Thrown internally when a catalogue says "slow down", so we stop asking it for a while. */
class Throttled extends Error {}

/** Never cache error pages: an upstream 429 must not stick for an hour. */
const cacheOk = (ttl: number) => ({ cacheTtl: ttl, cacheEverything: true, cacheTtlByStatus: { "200-299": ttl, "300-599": 0 } });

async function json<T>(url: string, fetcher: typeof fetch, headers?: HeadersInit): Promise<T | null> {
  try {
    const init = { headers, cf: cacheOk(3600), signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) } as RequestInit;
    const res = await fetcher(url, init);
    if (res.status === 429 || res.status === 503) throw new Throttled(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof Throttled) throw e;
    return null;
  }
}

async function itunes(term: string, entity: "song" | "album", limit: number, fetcher: typeof fetch): Promise<ItunesHit[]> {
  const q = new URLSearchParams({ term, entity, limit: String(limit) });
  return (await json<{ results?: ItunesHit[] }>(`${ITUNES_SEARCH}?${q}`, fetcher))?.results ?? [];
}

const ARTWORK_RE = /^(https:\/\/[^/]+\.mzstatic\.com\/.+\/)\d+x\d+bb\.(?:jpg|png)$/;

async function artFrom(hit: ItunesHit | undefined, fetcher: typeof fetch): Promise<Art | null> {
  const base = hit?.artworkUrl100?.match(ARTWORK_RE);
  if (!base) return null;
  // Official artwork at a crisp 300px; only if that is too heavy to embed, step down to 200px.
  return (await embed(`${base[1]}64x64bb.jpg`, `${base[1]}300x300bb.jpg`, fetcher, true)) ?? embed(`${base[1]}64x64bb.jpg`, `${base[1]}200x200bb.jpg`, fetcher);
}

export interface ArtOptions {
  /** The background warm-up retries on purpose, so it ignores the "throttled, back off" marker. */
  ignoreCooldown?: boolean;
  /** Last.fm API key: lets us ask Last.fm for the track's canonical album cover (no shared-IP throttling). */
  lastfmKey?: string;
  /** Last resort: use the artist's latest release when the track itself is in no catalogue (edits, mashups). */
  artistCover?: boolean;
}

/**
 * iTunes Search: free and keyless, but Apple throttles it per IP and Workers share IPs, so it often answers
 * 429. Matches must be by the same artist and, for songs, the same title, so a common name never borrows
 * another song's cover.
 */
async function fromItunes(track: Pick<Track, "title" | "artist" | "album">, fetcher: typeof fetch, opts: ArtOptions): Promise<Art | null> {
  const album = norm(track.album);
  const byArtist = (h: ItunesHit) => !!h.artworkUrl100 && !!h.artistName && sameArtist(h.artistName, track.artist);
  // One request in the common case: every call counts against Apple's per-IP limit, so the album search only
  // runs when the song search found nothing usable.
  const wanted = core(track.title);
  const songs = await itunes(`${track.artist} ${track.title}`, "song", 25, fetcher);
  const sameSong = songs.filter(byArtist).filter((h) => h.trackName && core(h.trackName) === wanted);
  // A song hit on the scrobbled album wins, then any release of that song.
  const onAlbum = sameSong.find((h) => album && norm(h.collectionName ?? "").includes(album));
  for (const hit of [onAlbum, sameSong[0]]) {
    const art = await artFrom(hit, fetcher);
    if (art) return art;
  }
  if (album) {
    const albums = await itunes(`${track.artist} ${track.album}`, "album", 10, fetcher);
    const sameAlbum = albums.filter(byArtist).filter((h) => norm(h.collectionName ?? "").includes(album));
    const art = await artFrom(sameAlbum[0], fetcher);
    if (art) return art;
  }
  if (!opts.artistCover) return null;
  const latest = (await itunes(track.artist, "album", 10, fetcher)).filter(byArtist);
  return artFrom(latest[0], fetcher);
}

/** Last.fm's track page often knows the album cover even when the scrobble itself carried none. */
async function fromLastfmInfo(track: Pick<Track, "title" | "artist">, key: string, fetcher: typeof fetch): Promise<Art | null> {
  const q = new URLSearchParams({ method: "track.getinfo", artist: track.artist, track: track.title, api_key: key, autocorrect: "1", format: "json" });
  const res = await json<{ track?: { album?: { image?: RawImage[] } } }>(`https://ws.audioscrobbler.com/2.0/?${q}`, fetcher, { "User-Agent": UA });
  const url = pickArt(res?.track?.album?.image);
  return url ? loadArt(url, fetcher) : null;
}

/** Per-track memory of what was found, so a busy catalogue is asked once, not on every card refresh. */
export interface ArtStore {
  get(key: string): Promise<Art | "none" | null>;
  put(key: string, value: Art | "none", ttl: number): Promise<void>;
}

const HIT_TTL = 7 * 86_400;
const MISS_TTL = 180;
const COOLDOWN_TTL = 60;

/** Adapts a generic key-value store to what the resolver remembers. */
export function artStore(store: Store): ArtStore {
  return {
    async get(k) {
      const v = await store.get<Art | { none: true }>(k);
      if (!v) return null;
      return "none" in v ? "none" : v;
    },
    put: (k, v, ttl) => store.put(k, v === "none" ? { none: true } : v, ttl),
  };
}

/**
 * Best available cover: Last.fm's own, then the catalogues. Null means the card draws its own art.
 * Results (and misses, briefly) are remembered per track; a throttled catalogue is skipped for a minute.
 */
export async function resolveArt(
  track: Pick<Track, "title" | "artist" | "album" | "artUrl">,
  fetcher: typeof fetch = fetch,
  opts: ArtOptions = {},
  store?: ArtStore,
): Promise<Resolved> {
  // Keyed by artist and title only: Last.fm sometimes sends the same song with and without an album.
  const key = hash(`${norm(track.artist)} ${core(track.title)} ${opts.artistCover ? 1 : 0}`).toString(36);

  // A remembered cover is the fast path: one store read, no image fetches, no decoding.
  const remembered = await store?.get(key);
  if (remembered && remembered !== "none") return { art: remembered, source: "cache" };

  const own = track.artUrl ? await loadArt(track.artUrl, fetcher) : null;
  if (own) {
    await store?.put(key, own, HIT_TTL);
    return { art: own, source: "lastfm" };
  }
  if (remembered === "none") return { art: null, source: "none" };

  const sources: [ArtSource, () => Promise<Art | null>][] = [
    ...(opts.lastfmKey ? ([["lastfm-info", () => fromLastfmInfo(track, opts.lastfmKey!, fetcher)]] as [ArtSource, () => Promise<Art | null>][]) : []),
    ["itunes", () => fromItunes(track, fetcher, opts)],
  ];
  let blocked = false;
  const tried: string[] = [];
  for (const [name, run] of sources) {
    if (!opts.ignoreCooldown && (await store?.get(`cooldown-${name}`))) { blocked = true; tried.push(`${name}:backing-off`); continue; }
    try {
      const art = await run();
      if (art) {
        await store?.put(key, art, HIT_TTL);
        return { art, source: name };
      }
      tried.push(`${name}:no-match`);
    } catch (e) {
      if (!(e instanceof Throttled)) { tried.push(`${name}:error`); continue; }
      tried.push(`${name}:429`);
      blocked = true;
      await store?.put(`cooldown-${name}`, "none", COOLDOWN_TTL);
    }
  }
  // A throttled lookup says nothing about the track, so only remember a real miss, and only briefly.
  if (!blocked) await store?.put(key, "none", MISS_TTL);
  return { art: null, source: blocked ? "itunes-blocked" : "none", tried };
}
