import jpeg from "jpeg-js";
import { convertIndexedToRgb, decode as decodePng } from "fast-png";
import { type Seed, seedFromPixels } from "./palette.ts";
import { pickArt, type RawImage } from "./lastfm.ts";
import type { Track } from "./model.ts";
import type { Store } from "./store.ts";
import { bytesToBase64, hash } from "./util.ts";

export interface Art { dataUri: string; seed: Seed }

/**
 * Last.fm's image CDN hosts. They have changed before: covers moved to lastfm-img.freetls.fastly.net, and an
 * exact list silently dropped every one of them (the trace said "bad-image(host-...)"). Same /i/u/<size>/ paths.
 */
const LASTFM_IMAGE_HOST = /^lastfm(?:-img\d*)?\.(?:freetls\.fastly\.net|akamaized\.net)$/;
const ITUNES_SEARCH = "https://itunes.apple.com/search";
const MAX_EMBED_BYTES = 60_000;

/** Last.fm image URLs carry a size segment, e.g. /i/u/300x300/<hash>.jpg. */
export function sizedUrl(url: string, size: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:" || !LASTFM_IMAGE_HOST.test(u.hostname)) return null;
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

/** `why`, when given, collects a short reason for each failure, shown in the trace as "bad-image(<reasons>)". */
async function getBytes(url: string, fetcher: typeof fetch, why?: string[]): Promise<Uint8Array | null> {
  try {
    const res = await fetcher(url, { cf: cacheOk(86400), signal: AbortSignal.timeout(3000) } as RequestInit);
    if (!res.ok) return void why?.push(`http-${res.status}`), null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > 0 && buf.length < 400_000) return buf;
    return void why?.push(`size-${buf.length}`), null;
  } catch { return void why?.push("fetch-failed"), null; }
}

/**
 * The cover is drawn about 110 CSS pixels wide, so 240px is sharp even on a 2x screen. Anything heavier than this
 * is shrunk and re-encoded: the image is most of the card's bytes, and card size is load time.
 */
const COVER_PX = 240;
const SHRINK_ABOVE_BYTES = 24_000;
const JPEG_QUALITY = 82;

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

/** A smaller JPEG of the same cover, or null when the original is already small or cannot be decoded. */
export function compactCover(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length <= SHRINK_ABOVE_BYTES) return null;
  const px = decodeToRgba(bytes);
  if (!px) return null;
  try {
    const small = downscale(px.data, px.width, px.height, COVER_PX);
    const out = new Uint8Array(jpeg.encode(small, JPEG_QUALITY).data);
    return out.length < bytes.length ? out : null;
  } catch {
    return null;
  }
}

/**
 * Fetch a small and a medium copy, derive a palette seed from the small one, and return an embeddable data URI.
 * The medium copy is used even when it is heavy: it is shrunk to a 240px JPEG anyway, which keeps covers sharp
 * (stepping down to a smaller original made them visibly soft on 2x screens). Only if it cannot be used at all
 * does a strict call give up, so the caller can try another size.
 */
async function embed(small: string, medium: string, fetcher: typeof fetch, strict = false, why?: string[]): Promise<Art | null> {
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
  // The first bytes name the format when it is not one we decode (GIF "47494638", WebP "52494646").
  const head = (b: Uint8Array) => Array.from(b.subarray(0, 4), (x) => x.toString(16).padStart(2, "0")).join("");
  if (!mime) return void why?.push(`format-${head(bytes)}`), null;
  if (!px) return void why?.push(mimeOf(smallBytes) ? "decode" : `format-${head(smallBytes)}`), null;
  const seed = seedFromPixels(px.data, px.width, px.height);
  if (!seed) return void why?.push("no-pixels"), null;
  const small2 = usable ? compact : compactCover(bytes);
  return { dataUri: small2 ? `data:image/jpeg;base64,${bytesToBase64(small2)}` : `data:${mime};base64,${bytesToBase64(bytes)}`, seed };
}

/** Art straight from a Last.fm image URL. */
export async function loadArt(artUrl: string, fetcher: typeof fetch = fetch, why?: string[]): Promise<Art | null> {
  const small = sizedUrl(artUrl, "64s");
  const crisp = sizedUrl(artUrl, "300x300");
  const medium = sizedUrl(artUrl, "174s");
  if (!small || !crisp || !medium) return void why?.push(`unsized-${hostOf(artUrl)}`), null;
  return (await embed(small, crisp, fetcher, true)) ?? embed(small, medium, fetcher, false, why);
}

const hostOf = (url: string) => { try { const u = new URL(url); return `${u.hostname}${u.pathname.slice(0, 24)}`; } catch { return "invalid"; } };

/** Thrown by a loader whose found cover would not load, carrying why (for the trace). */
class BadImage extends Error {}

// Accents are dropped, not turned into spaces: NFKD splits "ë" into "e" plus a combining mark, and treating that
// mark as a separator made "Tiësto" into "tie sto", so accented artists never matched any catalogue.
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/\p{M}+/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
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
export type ArtSource = "lastfm" | "lastfm-info" | "genius" | "youtube" | "pending" | "itunes" | "cache" | "none" | "itunes-blocked";
export interface Resolved {
  art: Art | null;
  source: ArtSource;
  /** What each source said when nothing was found, e.g. `itunes:429`; empty on success. */
  tried?: string[];
}

/** Thrown internally when a catalogue says "slow down", so we stop asking it for a while. */
class Throttled extends Error {
  /** What to call it in the trace: an HTTP status (429, 401, 503), "bad-reply" or "timeout". */
  readonly why: string | number;
  // A plain field, not a constructor parameter property: Node's type stripping (npm run preview) rejects those.
  constructor(where: string, why: string | number = 429) {
    super(where);
    this.why = why;
  }
}

/** Never cache error pages: an upstream 429 must not stick for an hour. */
const cacheOk = (ttl: number) => ({ cacheTtl: ttl, cacheEverything: true, cacheTtlByStatus: { "200-299": ttl, "300-599": 0 } });

async function json<T>(url: string, fetcher: typeof fetch, headers?: HeadersInit): Promise<T | null> {
  try {
    const init = { headers, cf: cacheOk(3600), signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) } as RequestInit;
    const res = await fetcher(url, init);
    // Anything that is not a clean answer (429, 403, a 5xx, an HTML error page) is throttling, not "no such
    // track": it must never be remembered as a miss.
    // 401 and 403 are about our credentials (a wrong or revoked token), not about the track, so like throttling
    // they must never be remembered as "no such track".
    if (res.status === 401) console.log(`cover source rejected our credentials: ${new URL(url).hostname}`);
    if (res.status === 429 || res.status === 401 || res.status === 403 || res.status >= 500) throw new Throttled(url, res.status);
    if (!res.ok) return null;
    try {
      return (await res.json()) as T;
    } catch {
      throw new Throttled(url, "bad-reply");
    }
  } catch (e) {
    // A timeout or network error says nothing about the track: treat it like throttling, never as a miss.
    throw e instanceof Throttled ? e : new Throttled(url, "timeout");
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

/**
 * A cover a source has found but not yet downloaded. Sources search in parallel, but only the winner's image is
 * fetched and decoded: decoding is the expensive part, and doing it for every source would waste CPU.
 */
type Loader = () => Promise<Art | null>;
/** Asks a source; resolves to a loader for the cover it found, or null when it has none. */
type Find = () => Promise<Loader | null>;

/** Tries each found iTunes hit in order until one embeds. */
const itunesLoader = (hits: (ItunesHit | undefined)[], fetcher: typeof fetch): Loader | null => {
  const usable = hits.filter((h): h is ItunesHit => !!h?.artworkUrl100?.match(ARTWORK_RE));
  if (!usable.length) return null;
  return async () => {
    for (const hit of usable) {
      const art = await artFrom(hit, fetcher);
      if (art) return art;
    }
    return null;
  };
};

export interface ArtOptions {
  /** The background warm-up retries on purpose, so it ignores the "throttled, back off" marker. */
  ignoreCooldown?: boolean;
  /** Last.fm API key: lets us ask Last.fm for the track's canonical album cover (no shared-IP throttling). */
  lastfmKey?: string;
  /** Genius client access token: a source with its own quota, used when Last.fm has no cover. */
  geniusToken?: string;
  /** YouTube Data API key: a last resort that reads the official cover off an "Artist - Topic" art track. */
  youtubeKey?: string;
  /** Last resort: use the artist's latest release when the track itself is in no catalogue (edits, mashups). */
  artistCover?: boolean;
}

/**
 * iTunes Search: free and keyless, but Apple throttles it per IP and Workers share IPs, so it often answers
 * 429. Matches must be by the same artist and, for songs, the same title, so a common name never borrows
 * another song's cover.
 */
async function fromItunes(track: Pick<Track, "title" | "artist" | "album">, fetcher: typeof fetch, opts: ArtOptions): Promise<Loader | null> {
  const album = norm(track.album);
  const byArtist = (h: ItunesHit) => !!h.artworkUrl100 && !!h.artistName && sameArtist(h.artistName, track.artist);
  // One request in the common case: every call counts against Apple's per-IP limit, so the album search only
  // runs when the song search found nothing usable.
  const wanted = core(track.title);
  const songs = await itunes(`${track.artist} ${track.title}`, "song", 25, fetcher);
  const sameSong = songs.filter(byArtist).filter((h) => h.trackName && core(h.trackName) === wanted);
  // A song hit on the scrobbled album wins, then any release of that song.
  const onAlbum = sameSong.find((h) => album && norm(h.collectionName ?? "").includes(album));
  const bySong = itunesLoader([onAlbum, sameSong[0]], fetcher);
  if (bySong) return bySong;
  if (album) {
    const albums = await itunes(`${track.artist} ${track.album}`, "album", 10, fetcher);
    const byAlbum = itunesLoader(albums.filter(byArtist).filter((h) => norm(h.collectionName ?? "").includes(album)).slice(0, 1), fetcher);
    if (byAlbum) return byAlbum;
  }
  if (!opts.artistCover) return null;
  return itunesLoader((await itunes(track.artist, "album", 10, fetcher)).filter(byArtist).slice(0, 1), fetcher);
}

/** A title minus release noise, as Last.fm names the song: "Closer (feat. Halsey)" -> "Closer". */
export const plainTitle = (t: string) =>
  t.replace(/[(\[][^)\]]*[)\]]/g, " ").replace(/\s[-–—]\s.*$/, " ").replace(/\b(?:feat|ft)\b.*$/i, " ").replace(/\s+/g, " ").trim();

/** Cover lookups run in the background, so a slow Last.fm answer is worth waiting for (1.5 s timed out often). */
const LASTFM_TIMEOUT_MS = 2500;
/** How long the scrobble's own cover may take before the other sources are asked too (it usually takes 0.1-0.3 s). */
const OWN_HEAD_START_MS = 700;
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
async function fromLastfm(track: Pick<Track, "title" | "artist" | "album">, key: string, fetcher: typeof fetch): Promise<Loader | null> {
  const call = async <T>(params: Record<string, string>): Promise<T | null> => {
    const q = new URLSearchParams({ ...params, api_key: key, format: "json" });
    const init = { headers: { "User-Agent": UA }, cf: cacheOk(3600), signal: AbortSignal.timeout(LASTFM_TIMEOUT_MS) } as RequestInit;
    try {
      const res = await fetcher(`${LASTFM_API}?${q}`, init);
      if (res.status === 429 || res.status === 401 || res.status === 403 || res.status >= 500) throw new Throttled("lastfm", res.status);
      const body = (await res.json()) as T & { error?: number };
      if (body?.error === 29) throw new Throttled("lastfm"); // Last.fm's own "rate limit exceeded"
      return body?.error ? null : body;
    } catch (e) {
      throw e instanceof Throttled ? e : new Throttled("lastfm", "timeout"); // timeout, network error, bad JSON: transient
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
  const found = url;
  if (!found) return null;
  return async () => {
    const why: string[] = [];
    const art = await loadArt(found, fetcher, why);
    if (!art) throw new BadImage([...new Set(why)].join("+") || "unknown");
    return art;
  };
}

interface GeniusSong {
  title?: string;
  primary_artist?: { name?: string };
  /** Everyone credited, e.g. "Pritam, Arijit Singh & Amitabh Bhattacharya". */
  artist_names?: string;
  song_art_image_thumbnail_url?: string;
}

/** Genius uses stand-in images for songs without art; those are not covers. */
const isGeniusArt = (url: string | undefined): url is string =>
  !!url && url.startsWith("https://") && !/default_cover|default_avatar|placeholder/i.test(url);

/** Genius often credits a song to its composer first ("Kesariya" is listed under Pritam), so any credit counts. */
const creditedTo = (song: GeniusSong, artist: string) =>
  (!!song.primary_artist?.name && sameArtist(song.primary_artist.name, artist)) ||
  (!!song.artist_names && ` ${norm(song.artist_names)} `.includes(` ${norm(artist)} `));

/**
 * Genius, with a free client access token. Its quota belongs to the token, not to an IP, so it is not throttled
 * by other tenants the way iTunes is. Only the small (about 300px) song-art thumbnail is used, and only for the
 * same artist and the same title. An exact title beats one that only matches once "(Remix)" and the like are
 * dropped, so the original wins over a remix. Its search engine sometimes needs the full title, so that is tried
 * second when the short one finds nothing.
 */
async function fromGenius(track: Pick<Track, "title" | "artist">, token: string, fetcher: typeof fetch): Promise<Loader | null> {
  const short = plainTitle(track.title) || track.title;
  const queries = [...new Set([`${short} ${track.artist}`, `${track.title} ${track.artist}`])];
  const exact = norm(track.title);
  const wanted = core(track.title);
  for (const query of queries) {
    const res = await json<{ response?: { hits?: { result?: GeniusSong }[] } }>(`https://api.genius.com/search?${new URLSearchParams({ q: query })}`, fetcher, {
      Authorization: `Bearer ${token}`,
      "User-Agent": UA,
    });
    const songs = (res?.response?.hits ?? [])
      .map((h) => h.result)
      .filter((r): r is GeniusSong => !!r?.title && creditedTo(r, track.artist) && core(r.title) === wanted && isGeniusArt(r.song_art_image_thumbnail_url));
    const song = songs.find((r) => norm(r.title!) === exact) ?? songs[0];
    const art = song?.song_art_image_thumbnail_url;
    if (art) return () => embed(art, art, fetcher);
  }
  return null;
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
  try {
    const small = downscale(crop, side, side, COVER_PX);
    return new Uint8Array(jpeg.encode(small, JPEG_QUALITY).data);
  } catch {
    return null;
  }
}

interface YoutubeItem { id?: { videoId?: string; channelId?: string }; snippet?: { title?: string; channelTitle?: string; resourceId?: { videoId?: string } } }
const unescapeHtml = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const YT_API = "https://www.googleapis.com/youtube/v3";
const TOPIC = " - Topic";
/** Pages of 50 uploads read before falling back to one search inside the channel (1 unit a page, 100 a search). */
const YT_UPLOAD_PAGES = 6;
const YT_CHANNEL_TTL_MS = 7 * 86_400_000;

/**
 * Each artist's Topic channel, remembered so it is searched for once (a search costs 100 units). In memory: the
 * presence object lives for days, so this lasts; a restart only costs one search per artist again.
 */
const topicChannels = new Map<string, { ids: string[]; until: number }>();
/** Different artists can share a name (five "Raanjha - Topic" channels exist), so a few are tried in turn. */
const YT_CHANNELS_TRIED = 3;
/** For tests. */
export const resetTopicChannels = () => topicChannels.clear();

async function findTopicChannels(artist: string, apiKey: string, fetcher: typeof fetch): Promise<string[]> {
  const k = norm(artist);
  const known = topicChannels.get(k);
  if (known && known.until > Date.now()) return known.ids;
  const q = new URLSearchParams({ part: "snippet", type: "channel", maxResults: "10", q: `${artist}${TOPIC}`, key: apiKey });
  const res = await json<{ items?: YoutubeItem[] }>(`${YT_API}/search?${q}`, fetcher);
  const ids = (res?.items ?? [])
    .filter((it) => {
      const title = unescapeHtml(it.snippet?.title ?? it.snippet?.channelTitle ?? "");
      return title.endsWith(TOPIC) && sameArtist(title.slice(0, -TOPIC.length), artist);
    })
    .map((it) => it.id?.channelId ?? "")
    .filter((id, i, all) => /^UC[\w-]{22}$/.test(id) && all.indexOf(id) === i)
    .slice(0, YT_CHANNELS_TRIED);
  topicChannels.set(k, { ids, until: Date.now() + YT_CHANNEL_TTL_MS });
  return ids;
}

/**
 * YouTube Data API v3, official and keyed; it runs only when every other source has missed. Only auto-generated
 * "Artist - Topic" uploads are used: their picture is the label-supplied cover, which is why they cover so many
 * Indian and independent releases that Last.fm and Genius lack. Same artist, same song, as everywhere else.
 *
 * A plain search ranks the artist's own videos above the art track (measured: Shlovij's "vishwaroop darshan yog"
 * was not in the top 10), and costs 100 of the free 10,000 daily units. So: find the artist's Topic channel once,
 * then read its uploads (1 unit per 50) for the title; only a very long catalogue falls back to one search inside
 * the channel. A new song by a known artist costs a few units, so the free quota covers thousands a day.
 */
async function fromYoutube(track: Pick<Track, "title" | "artist">, apiKey: string, fetcher: typeof fetch): Promise<Loader | null> {
  for (const channel of await findTopicChannels(track.artist, apiKey, fetcher)) {
    const found = await inTopicChannel(channel, track, apiKey, fetcher);
    if (found) return artTrackLoader(found, fetcher);
  }
  return null;
}

/** The video id of this song among one Topic channel's uploads, or null. */
async function inTopicChannel(channel: string, track: Pick<Track, "title" | "artist">, apiKey: string, fetcher: typeof fetch): Promise<string | null> {
  const exact = norm(track.title);
  const wanted = core(track.title);
  const pick = (items: { id: string; title: string }[]) => {
    const same = items.filter((v) => /^[\w-]{11}$/.test(v.id) && core(v.title) === wanted);
    return same.find((v) => norm(v.title) === exact) ?? same[0];
  };

  let page: string | undefined;
  for (let i = 0; i < YT_UPLOAD_PAGES; i++) {
    const q = new URLSearchParams({ part: "snippet", maxResults: "50", playlistId: `UU${channel.slice(2)}`, key: apiKey, ...(page ? { pageToken: page } : {}) });
    const res = await json<{ items?: YoutubeItem[]; nextPageToken?: string }>(`${YT_API}/playlistItems?${q}`, fetcher);
    const items = res?.items ?? [];
    // No uploads list at all (not every auto-generated channel exposes one): search inside the channel instead.
    if (i === 0 && items.length === 0) break;
    const hit = pick(items.map((it) => ({ id: it.snippet?.resourceId?.videoId ?? "", title: unescapeHtml(it.snippet?.title ?? "") })));
    if (hit) return hit.id;
    page = res?.nextPageToken;
    if (!page) return null; // read the whole catalogue: the song is not there
  }
  const q = new URLSearchParams({ part: "snippet", type: "video", maxResults: "10", channelId: channel, q: plainTitle(track.title) || track.title, key: apiKey });
  const res = await json<{ items?: YoutubeItem[] }>(`${YT_API}/search?${q}`, fetcher);
  const hit = pick((res?.items ?? []).map((it) => ({ id: it.id?.videoId ?? "", title: unescapeHtml(it.snippet?.title ?? "") })));
  return hit?.id ?? null;
}

const artTrackLoader = (id: string, fetcher: typeof fetch): Loader => async () => {
  const bytes = await getBytes(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`, fetcher);
  const cover = bytes && coverFromArtTrack(bytes);
  const px = cover && decodeToRgba(cover);
  const seed = px && seedFromPixels(px.data, px.width, px.height);
  return cover && seed ? { dataUri: `data:image/jpeg;base64,${bytesToBase64(cover)}`, seed } : null;
};

/** Per-track memory of what was found, so a busy catalogue is asked once, not on every card refresh. */
export interface ArtStore {
  get(key: string): Promise<Art | "none" | null>;
  put(key: string, value: Art | "none", ttl: number): Promise<void>;
}

/** Official covers do not change; a month keeps repeat plays instant (LastWave keeps them as long). */
const HIT_TTL = 30 * 86_400;
const MISS_TTL = 180;
/** How long one source's "no such track" is remembered, so only the throttled sources are retried. */
const SOURCE_MISS_TTL = 600;
const COOLDOWN_MS = 60_000;
/**
 * Bumped when a source learns to find more, so the "not there" it remembered under the old rules is ignored.
 * YouTube 2: the Topic-channel lookup (a plain search had missed art tracks that exist).
 */
const SOURCE_REVISION: Partial<Record<ArtSource, string>> = { youtube: "2" };

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

  // The cover that came with the scrobble, hedged: it gets a short head start, and only if it has not landed by
  // then are the other sources asked, with it behind them, so a cover they find is not held back by a slow image
  // CDN. (It used to be fetched before anything else: measured 3 s timeouts, twice, before any search began.)
  const ownWhy: string[] = [];
  const ownTry = track.artUrl ? loadArt(track.artUrl, fetcher, ownWhy).catch(() => null) : null;
  if (remembered === "none") {
    // Recently found nowhere: only the scrobble's own cover is worth another look.
    const art = ownTry ? await ownTry : null;
    if (art) await store?.put(key, art, HIT_TTL);
    return art ? { art, source: "lastfm" } : { art: null, source: "none" };
  }
  if (ownTry) {
    const early = await Promise.race([ownTry, new Promise<"slow">((d) => setTimeout(() => d("slow"), OWN_HEAD_START_MS))]);
    if (early && early !== "slow") {
      await store?.put(key, early, HIT_TTL);
      return { art: early, source: "lastfm" };
    }
  }

  // Priority: Last.fm's own catalogue (matched to the scrobbled album), then Genius, then Apple, then the
  // scrobble's late cover. All of them search at the same time, so a miss costs one round trip instead of several in
  // a row; a lower one is used only once every source above it has answered without a cover.
  /** The third entry marks a last resort: asked only when everything above it has missed (it has a daily quota). */
  const sources: [ArtSource, Find, boolean?][] = [];
  if (opts.lastfmKey) sources.push(["lastfm-info", () => fromLastfm(track, opts.lastfmKey!, fetcher)]);
  if (opts.geniusToken) sources.push(["genius", () => fromGenius(track, opts.geniusToken!, fetcher)]);
  // Last: from Cloudflare Apple often throttles or is slow, and a slow source above would hold back a found cover.
  sources.push(["itunes", () => fromItunes(track, fetcher, opts)]);
  if (ownTry) {
    sources.push(["lastfm", async () => async () => {
      const art = await ownTry;
      if (!art) throw new BadImage([...new Set(ownWhy)].join("+") || "unknown");
      return art;
    }]);
  }
  if (opts.youtubeKey) sources.push(["youtube", () => fromYoutube(track, opts.youtubeKey!, fetcher), true]);

  interface Answer { load?: Loader; note?: string; blocked?: boolean }
  const ask = async (name: ArtSource, find: Find): Promise<Answer> => {
    if (!opts.ignoreCooldown && backingOff(name)) return { note: `${name}:backing-off`, blocked: true };
    // This source already answered "no such track" recently: asking again only burns time and quota.
    const missKey = `miss-${name}${SOURCE_REVISION[name] ?? ""}-${key}`;
    if (name !== "lastfm" && (await store?.get(missKey)) === "none") return { note: `${name}:known-miss` };
    try {
      const load = await find();
      if (load) return { load };
      // YouTube has a daily quota, so its "not there" is trusted for a day; the others are asked again sooner.
      await store?.put(missKey, "none", name === "youtube" ? 86_400 : SOURCE_MISS_TTL);
      return { note: `${name}:no-match` };
    } catch (e) {
      if (!(e instanceof Throttled)) return { note: `${name}:error` };
      if (!opts.ignoreCooldown) backOff(name);
      return { note: `${name}:${e.why}`, blocked: true };
    }
  };
  const answers = sources.map(([name, find, lastResort]) => (lastResort ? null : ask(name, find)));

  let blocked = false;
  const tried: string[] = [];
  for (const [i, [name, find]] of sources.entries()) {
    const a = await (answers[i] ?? ask(name, find));
    if (a.load) {
      let reason = "";
      const art = await a.load().catch((e: unknown) => ((reason = e instanceof BadImage ? e.message : `threw ${String(e).replace(/[^\w .:-]/g, "").slice(0, 60)}`), null));
      if (art) {
        await store?.put(key, art, HIT_TTL);
        return { art, source: name };
      }
      // Found, but the image would not download or decode: likely transient, so not remembered as a miss.
      tried.push(`${name}:bad-image${reason ? `(${reason})` : ""}`);
      blocked = true;
      continue;
    }
    tried.push(a.note!);
    blocked ||= !!a.blocked;
  }
  // A throttled lookup says nothing about the track, so only remember a real miss, and only briefly.
  if (!blocked) await store?.put(key, "none", MISS_TTL);
  return { art: null, source: blocked ? "itunes-blocked" : "none", tried };
}
