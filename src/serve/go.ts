import { isTracked, secret, servesUser, type Env } from "../config.ts";
import { USERNAME_RE, fetchNowPlaying } from "../lastfm.ts";
import type { Track } from "../model.ts";
import { presenceSnapshot } from "./presence.ts";

/** Where a click on the card can lead: the song's page on Last.fm, a search for it elsewhere, or the listener's profile. */
export const TARGETS = ["song", "spotify", "youtube", "apple", "profile"] as const;
export type Target = (typeof TARGETS)[number];

const enc = encodeURIComponent;
/** Last.fm writes spaces in its addresses as plus signs. */
const lastfm = (s: string) => enc(s).replace(/%20/g, "+");

/**
 * The address for a click. Only these fixed sites are ever returned, with the song's words encoded into one path or query,
 * so what Last.fm says a track is called can never send anyone somewhere else. With no song, or `profile`, it is the profile.
 */
export function destination(user: string, track: Pick<Track, "artist" | "title"> | null, to: Target): string {
  const profile = `https://www.last.fm/user/${enc(user)}`;
  if (!track || to === "profile") return profile;
  const words = enc(`${track.artist} ${track.title}`);
  switch (to) {
    case "spotify":
      return `https://open.spotify.com/search/${words}`;
    case "youtube":
      return `https://music.youtube.com/search?q=${words}`;
    case "apple":
      return `https://music.apple.com/search?term=${words}`;
    default:
      return `https://www.last.fm/music/${lastfm(track.artist)}/_/${lastfm(track.title)}`;
  }
}

/** The song the card shows: from the presence object when it can answer, otherwise straight from Last.fm. */
async function cardTrack(user: string, env: Env): Promise<Track | null> {
  if (env.PRESENCE && isTracked(env, user)) {
    const snap = await presenceSnapshot(env, user).catch(() => null);
    if (snap) return snap.ok && snap.np ? snap.np.track : null;
  }
  const key = secret(env, "LASTFM_API_KEY");
  if (!key) return null;
  const res = await fetchNowPlaying(user, key);
  return res.ok ? res.data.track : null;
}

/**
 * GET /api/go?user=NAME&to=song|spotify|youtube|apple|profile: sends the visitor to the song on the card. A README's image
 * cannot link to something that changes, but the link around it can point here and be sent on to whatever plays now. Only for
 * users this deployment serves, and never cached, since the song changes.
 */
export async function goResponse(url: URL, env: Env): Promise<Response> {
  const user = url.searchParams.get("user")?.trim() ?? "";
  if (!USERNAME_RE.test(user) || !servesUser(env, user)) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const asked = (url.searchParams.get("to") ?? "").toLowerCase();
  const to = TARGETS.includes(asked as Target) ? (asked as Target) : "song";
  const track = await cardTrack(user, env).catch(() => null);
  return new Response(null, { status: 302, headers: { Location: destination(user, track, to), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
