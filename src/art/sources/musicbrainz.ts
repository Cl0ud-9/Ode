import type { Track } from "../../model.ts";
import { UA, json } from "../http.ts";
import { embed } from "../image.ts";
import { core, norm, plainTitle, sameArtist } from "../match.ts";
import type { Loader } from "../types.ts";

const SEARCH = "https://musicbrainz.org/ws/2/recording";
const COVERS = "https://coverartarchive.org/release-group";
/** How many releases of a song are tried before giving up: each costs one image request. */
const TRIES = 3;

interface Credit { name?: string; artist?: { name?: string } }
interface Release {
  title?: string;
  status?: string;
  "release-group"?: { id?: string; "primary-type"?: string; "secondary-types"?: string[] };
}
interface Recording { title?: string; "artist-credit"?: Credit[]; releases?: Release[] }

/** Lucene treats quotes and backslashes in a phrase as syntax; a title can carry either. */
const phrase = (s: string) => `"${s.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim()}"`;

const credited = (r: Recording, artist: string) =>
  (r["artist-credit"] ?? []).some((c) => [c.name, c.artist?.name].some((n) => !!n && sameArtist(n, artist)));

/** Studio releases first: a compilation, live album or remix album is the wrong cover for the song as scrobbled. */
const studio = (r: Release) => {
  const g = r["release-group"];
  return !!g?.id && !(g["secondary-types"] ?? []).some((t) => /compilation|live|remix|dj-mix|soundtrack|demo/i.test(t));
};

/**
 * MusicBrainz and the Cover Art Archive: keyless and free, and answering from anywhere, so it fills in for the
 * catalogues that throttle shared cloud IPs or hide tracks by country. A song is matched on the same artist and the
 * same title (a common name never borrows another song's cover); the cover is the release group's front image, which
 * the archive resolves to the best release that has one. The release the scrobble names comes first, then official
 * studio releases, then the rest.
 */
export async function fromMusicBrainz(track: Pick<Track, "title" | "artist" | "album">, fetcher: typeof fetch): Promise<Loader | null> {
  const title = plainTitle(track.title) || track.title;
  const q = new URLSearchParams({ query: `recording:${phrase(title)} AND artist:${phrase(track.artist)}`, fmt: "json", limit: "10" });
  const res = await json<{ recordings?: Recording[] }>(`${SEARCH}?${q}`, fetcher, { "User-Agent": UA });
  const wanted = core(track.title);
  const album = norm(track.album);

  const releases = (res?.recordings ?? [])
    .filter((r) => !!r.title && core(r.title) === wanted && credited(r, track.artist))
    .flatMap((r) => r.releases ?? [])
    .filter(studio);
  const rank = (r: Release) =>
    (album && norm(r.title ?? "") === album ? 0 : album && norm(r.title ?? "").includes(album) ? 1 : 2) * 4 +
    (r.status === "Official" ? 0 : 2) + (r["release-group"]?.["primary-type"] === "Album" ? 0 : 1);
  const groups = [...new Set(releases.sort((a, b) => rank(a) - rank(b)).map((r) => r["release-group"]!.id!))].slice(0, TRIES);
  if (!groups.length) return null;

  return async () => {
    for (const id of groups) {
      const art = await embed(`${COVERS}/${id}/front-250`, `${COVERS}/${id}/front-500`, fetcher);
      if (art) return art;
    }
    return null;
  };
}
