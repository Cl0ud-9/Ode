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
  const crisp = sizedUrl(artUrl, "300x300");
  const medium = sizedUrl(artUrl, "174s");
  if (!small || !crisp || !medium) return null;
  return (await embed(small, crisp, fetcher, true)) ?? embed(small, medium, fetcher);
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
export type ArtSource = "lastfm" | "lastfm-info" | "genius" | "pending" | "itunes" | "cache" | "none" | "itunes-blocked";
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
    // Anything that is not a clean answer (429, 403, a 5xx, an HTML error page) is throttling, not "no such
    // track": it must never be remembered as a miss.
    if (res.status === 429 || res.status === 403 || res.status >= 500) throw new Throttled(url);
    if (!res.ok) return null;
    try {
      return (await res.json()) as T;
    } catch {
      throw new Throttled(url);
    }
  } catch (e) {
    // A timeout or network error says nothing about the track: treat it like throttling, never as a miss.
    throw e instanceof Throttled ? e : new Throttled(url);
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
  /** Genius client access token: a source with its own quota, used when Last.fm has no cover. */
  geniusToken?: string;
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

/** A title minus release noise, as Last.fm names the song: "Closer (feat. Halsey)" -> "Closer". */
export const plainTitle = (t: string) =>
  t.replace(/[(\[][^)\]]*[)\]]/g, " ").replace(/\s[-–—]\s.*$/, " ").replace(/\b(?:feat|ft)\b.*$/i, " ").replace(/\s+/g, " ").trim();

const LASTFM_TIMEOUT_MS = 1500;
const LASTFM_API = "https://ws.audioscrobbler.com/2.0/";

interface LfmImages { image?: RawImage[] }
interface LfmAlbumMatch extends LfmImages { name?: string; artist?: string }

/**
 * Last.fm's own catalogue, queried with the existing API key: its quota is ours alone, so unlike iTunes it is
 * not throttled by other tenants sharing an IP. The lookups run in parallel, so this costs one round trip
 * (about 100 to 300 ms), not several.
 *
 *   1. album.getInfo   when the scrobble named an album
 *   2. track.getInfo   with the title as scrobbled, and again without "(feat. X)" and similar
 *   3. album.search    only if those found nothing; accepted only for the same artist and a matching title
 *
 * Earlier entries win: an exact album beats a guess.
 */
async function fromLastfm(track: Pick<Track, "title" | "artist" | "album">, key: string, fetcher: typeof fetch): Promise<Art | null> {
  const call = async <T>(params: Record<string, string>): Promise<T | null> => {
    const q = new URLSearchParams({ ...params, api_key: key, format: "json" });
    const init = { headers: { "User-Agent": UA }, cf: cacheOk(3600), signal: AbortSignal.timeout(LASTFM_TIMEOUT_MS) } as RequestInit;
    try {
      const res = await fetcher(`${LASTFM_API}?${q}`, init);
      if (res.status === 429 || res.status >= 500) throw new Throttled("lastfm");
      const body = (await res.json()) as T & { error?: number };
      if (body?.error === 29) throw new Throttled("lastfm"); // Last.fm's own "rate limit exceeded"
      return body?.error ? null : body;
    } catch (e) {
      throw e instanceof Throttled ? e : new Throttled("lastfm"); // timeout, network error, bad JSON: transient
    }
  };

  const clean = plainTitle(track.title);
  const titles = clean && clean !== track.title ? [track.title, clean] : [track.title];
  const [fromAlbum, ...fromTracks] = await Promise.all([
    track.album.trim()
      ? call<{ album?: LfmImages }>({ method: "album.getinfo", artist: track.artist, album: track.album, autocorrect: "1" }).then((r) => pickArt(r?.album?.image))
      : Promise.resolve(null),
    ...titles.map((t) =>
      call<{ track?: { album?: LfmImages } }>({ method: "track.getinfo", artist: track.artist, track: t, autocorrect: "1" }).then((r) => pickArt(r?.track?.album?.image)),
    ),
  ]);
  let url = [fromAlbum, ...fromTracks].find((u): u is string => !!u) ?? null;

  if (!url) {
    const found = await call<{ results?: { albummatches?: { album?: LfmAlbumMatch | LfmAlbumMatch[] } } }>({
      method: "album.search",
      album: `${clean || track.title} ${track.artist}`,
      limit: "6",
    });
    const raw = found?.results?.albummatches?.album;
    const wanted = core(track.title);
    const hit = (Array.isArray(raw) ? raw : raw ? [raw] : []).find(
      (a) => a.artist && a.name && sameArtist(a.artist, track.artist) && (core(a.name) === wanted || (!!norm(track.album) && norm(a.name).includes(norm(track.album)))) && pickArt(a.image),
    );
    url = hit ? pickArt(hit.image) : null;
  }
  return url ? loadArt(url, fetcher) : null;
}

interface GeniusSong {
  title?: string;
  primary_artist?: { name?: string };
  song_art_image_thumbnail_url?: string;
}

/** Genius uses stand-in images for songs without art; those are not covers. */
const isGeniusArt = (url: string | undefined): url is string =>
  !!url && url.startsWith("https://") && !/default_cover|default_avatar|placeholder/i.test(url);

/**
 * Genius, with a free client access token. Its quota belongs to the token, not to an IP, so it is not throttled
 * by other tenants the way iTunes is. Only the small (about 300px) song-art thumbnail is used, and only for the
 * same artist and the same title.
 */
async function fromGenius(track: Pick<Track, "title" | "artist">, token: string, fetcher: typeof fetch): Promise<Art | null> {
  const q = new URLSearchParams({ q: `${plainTitle(track.title) || track.title} ${track.artist}` });
  const res = await json<{ response?: { hits?: { result?: GeniusSong }[] } }>(`https://api.genius.com/search?${q}`, fetcher, {
    Authorization: `Bearer ${token}`,
    "User-Agent": UA,
  });
  const wanted = core(track.title);
  const song = (res?.response?.hits ?? [])
    .map((h) => h.result)
    .find((r) => !!r?.title && !!r.primary_artist?.name && sameArtist(r.primary_artist.name, track.artist) && core(r.title) === wanted && isGeniusArt(r.song_art_image_thumbnail_url));
  const url = song?.song_art_image_thumbnail_url;
  return url ? embed(url, url, fetcher) : null;
}

/** Per-track memory of what was found, so a busy catalogue is asked once, not on every card refresh. */
export interface ArtStore {
  get(key: string): Promise<Art | "none" | null>;
  put(key: string, value: Art | "none", ttl: number): Promise<void>;
}

const HIT_TTL = 7 * 86_400;
const MISS_TTL = 180;
/** How long one source's "no such track" is remembered, so only the throttled sources are retried. */
const SOURCE_MISS_TTL = 600;
const COOLDOWN_MS = 60_000;

/**
 * "This catalogue is throttling us, leave it alone for a minute." Kept in memory, not in KV: it is only a
 * politeness hint, and the warm-up job retries several times a minute, which would burn through KV's free write
 * limit (about 1,000 a day) and starve the writes that matter, the saved covers.
 */
const coolingUntil = new Map<string, number>();
const backingOff = (source: string) => (coolingUntil.get(source) ?? 0) > Date.now();
const backOff = (source: string) => void coolingUntil.set(source, Date.now() + COOLDOWN_MS);
/** For tests. */
export const resetBackoff = () => coolingUntil.clear();

/** Adapts a generic key-value store to what the resolver remembers. */
export function artStore(store: Store): ArtStore {
  return {
    async get(k) {
      // Covers are keyed per track and rarely change, so repeat reads can come from the edge (cold KV reads were
      // measured at 250 to 800ms).
      const v = await store.get<Art | { none: true }>(k, { cacheTtl: 60 });
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
  const key = hash(`${norm(track.artist)}\u0000${core(track.title)}\u0000${opts.artistCover ? 1 : 0}`).toString(36);

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
    ...(opts.lastfmKey ? ([["lastfm-info", () => fromLastfm(track, opts.lastfmKey!, fetcher)]] as [ArtSource, () => Promise<Art | null>][]) : []),
    ...(opts.geniusToken ? ([["genius", () => fromGenius(track, opts.geniusToken!, fetcher)]] as [ArtSource, () => Promise<Art | null>][]) : []),
    ["itunes", () => fromItunes(track, fetcher, opts)],
  ];
  let blocked = false;
  const tried: string[] = [];
  for (const [name, run] of sources) {
    if (!opts.ignoreCooldown && backingOff(name)) { blocked = true; tried.push(`${name}:backing-off`); continue; }
    // This source already answered "no such track" recently: asking again only burns time and quota.
    const missKey = `miss-${name}-${key}`;
    if ((await store?.get(missKey)) === "none") { tried.push(`${name}:known-miss`); continue; }
    try {
      const art = await run();
      if (art) {
        await store?.put(key, art, HIT_TTL);
        return { art, source: name };
      }
      tried.push(`${name}:no-match`);
      await store?.put(missKey, "none", SOURCE_MISS_TTL);
    } catch (e) {
      if (!(e instanceof Throttled)) { tried.push(`${name}:error`); continue; }
      tried.push(`${name}:429`);
      blocked = true;
      if (!opts.ignoreCooldown) backOff(name);
    }
  }
  // A throttled lookup says nothing about the track, so only remember a real miss, and only briefly.
  if (!blocked) await store?.put(key, "none", MISS_TTL);
  return { art: null, source: blocked ? "itunes-blocked" : "none", tried };
}
