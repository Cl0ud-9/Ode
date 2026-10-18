import type { Track } from "../../model.ts";
import { json } from "../http.ts";
import { embed } from "../image.ts";
import { core, norm, sameArtist } from "../match.ts";
import type { Art, ArtOptions, Loader } from "../types.ts";

const ITUNES_SEARCH = "https://itunes.apple.com/search";
const ARTWORK_RE = /^(https:\/\/[^/]+\.mzstatic\.com\/.+\/)\d+x\d+bb\.(?:jpg|png)$/;

interface ItunesHit { artistName?: string; collectionName?: string; trackName?: string; artworkUrl100?: string }

async function search(term: string, entity: "song" | "album", limit: number, fetcher: typeof fetch): Promise<ItunesHit[]> {
  const q = new URLSearchParams({ term, entity, limit: String(limit) });
  return (await json<{ results?: ItunesHit[] }>(`${ITUNES_SEARCH}?${q}`, fetcher))?.results ?? [];
}

async function artFrom(hit: ItunesHit, fetcher: typeof fetch): Promise<Art | null> {
  const base = hit.artworkUrl100?.match(ARTWORK_RE);
  if (!base) return null;
  // Official artwork at a crisp 300px; only if that cannot be used, step down to 200px.
  return (await embed(`${base[1]}64x64bb.jpg`, `${base[1]}300x300bb.jpg`, fetcher, true)) ?? embed(`${base[1]}64x64bb.jpg`, `${base[1]}200x200bb.jpg`, fetcher);
}

/** Tries each found hit in order until one embeds. */
function loaderFor(hits: (ItunesHit | undefined)[], fetcher: typeof fetch): Loader | null {
  const usable = hits.filter((h): h is ItunesHit => !!h?.artworkUrl100?.match(ARTWORK_RE));
  if (!usable.length) return null;
  return async () => {
    for (const hit of usable) {
      const art = await artFrom(hit, fetcher);
      if (art) return art;
    }
    return null;
  };
}

/**
 * iTunes Search: free and keyless, but Apple throttles it per IP and Workers share IPs, so from Cloudflare it
 * nearly always answers 429. Matches must be by the same artist and, for songs, the same title, so a common name
 * never borrows another song's cover.
 */
export async function fromItunes(track: Pick<Track, "title" | "artist" | "album">, fetcher: typeof fetch, opts: ArtOptions): Promise<Loader | null> {
  const album = norm(track.album);
  const byArtist = (h: ItunesHit) => !!h.artworkUrl100 && !!h.artistName && sameArtist(h.artistName, track.artist);
  // One request in the common case: every call counts against Apple's per-IP limit, so the album search only
  // runs when the song search found nothing usable.
  const wanted = core(track.title);
  const songs = await search(`${track.artist} ${track.title}`, "song", 25, fetcher);
  const sameSong = songs.filter(byArtist).filter((h) => h.trackName && core(h.trackName) === wanted);
  // A song hit on the scrobbled album wins, then any release of that song.
  const onAlbum = sameSong.find((h) => album && norm(h.collectionName ?? "").includes(album));
  const bySong = loaderFor([onAlbum, sameSong[0]], fetcher);
  if (bySong) return bySong;
  if (album) {
    const albums = await search(`${track.artist} ${track.album}`, "album", 10, fetcher);
    const byAlbum = loaderFor(albums.filter(byArtist).filter((h) => norm(h.collectionName ?? "").includes(album)).slice(0, 1), fetcher);
    if (byAlbum) return byAlbum;
  }
  if (!opts.artistCover) return null;
  return loaderFor((await search(track.artist, "album", 10, fetcher)).filter(byArtist).slice(0, 1), fetcher);
}
