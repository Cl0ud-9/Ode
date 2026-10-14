import type { Track } from "../../model.ts";
import { UA, json } from "../http.ts";
import { embed } from "../image.ts";
import { core, norm, plainTitle, sameArtist } from "../match.ts";
import type { Loader } from "../types.ts";

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
export async function fromGenius(track: Pick<Track, "title" | "artist">, token: string, fetcher: typeof fetch): Promise<Loader | null> {
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
