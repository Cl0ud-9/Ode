import { pickArt, type RawImage } from "../../lastfm.ts";
import type { Track } from "../../model.ts";
import { BadImage, Throttled, UA, cacheOk, isTransient } from "../http.ts";
import { embed } from "../image.ts";
import { core, norm, plainTitle, sameArtist } from "../match.ts";
import type { Art, Loader } from "../types.ts";

const LASTFM_API = "https://ws.audioscrobbler.com/2.0/";
/** Cover lookups run in the background, so a slow Last.fm answer is worth waiting for (1.5 s timed out often). */
const LASTFM_TIMEOUT_MS = 2500;

/**
 * Last.fm's image CDN hosts. They have changed before: covers moved to lastfm-img.freetls.fastly.net, and an
 * exact list silently dropped every one of them (the trace said "bad-image(host-...)"). Same /i/u/<size>/ paths.
 */
const LASTFM_IMAGE_HOST = /^lastfm(?:-img\d*)?\.(?:freetls\.fastly\.net|akamaized\.net)$/;

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

const describe = (url: string) => { try { const u = new URL(url); return `${u.hostname}${u.pathname.slice(0, 24)}`; } catch { return "invalid"; } };

/** Art straight from a Last.fm image URL: a crisp 300px copy, or 174px if that cannot be used; 770px for the site. */
export async function loadArt(artUrl: string, fetcher: typeof fetch = fetch, why?: string[]): Promise<Art | null> {
  const small = sizedUrl(artUrl, "64s");
  const crisp = sizedUrl(artUrl, "300x300");
  const medium = sizedUrl(artUrl, "174s");
  if (!small || !crisp || !medium) return void why?.push(`unsized-${describe(artUrl)}`), null;
  const art = (await embed(small, crisp, fetcher, true)) ?? (await embed(small, medium, fetcher, false, why));
  const big = sizedUrl(artUrl, "770x0");
  return art && big ? { ...art, big } : art;
}

/** A loader that throws BadImage with the reasons when the cover will not load, so the trace can say why. */
export const lastfmLoader = (url: string, fetcher: typeof fetch): Loader => async () => {
  const why: string[] = [];
  const art = await loadArt(url, fetcher, why);
  if (!art) throw new BadImage([...new Set(why)].join("+") || "unknown");
  return art;
};

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
export async function fromLastfm(track: Pick<Track, "title" | "artist" | "album">, key: string, fetcher: typeof fetch): Promise<Loader | null> {
  const call = async <T>(params: Record<string, string>): Promise<T | null> => {
    const q = new URLSearchParams({ ...params, api_key: key, format: "json" });
    const init = { headers: { "User-Agent": UA }, cf: cacheOk(3600), signal: AbortSignal.timeout(LASTFM_TIMEOUT_MS) } as RequestInit;
    try {
      const res = await fetcher(`${LASTFM_API}?${q}`, init);
      if (isTransient(res.status)) throw new Throttled("lastfm", res.status);
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
    const album = norm(track.album);
    const hit = (Array.isArray(raw) ? raw : raw ? [raw] : []).find(
      (a) => a.artist && a.name && sameArtist(a.artist, track.artist) && (core(a.name) === wanted || (!!album && norm(a.name).includes(album))) && pickArt(a.image),
    );
    url = hit ? pickArt(hit.image) : null;
  }
  return url ? lastfmLoader(url, fetcher) : null;
}
