import type { NowPlaying } from "./model.ts";
import type { Store } from "./store.ts";
import { hash } from "./util.ts";

/**
 * Last.fm flags the live track with `nowplaying` but gives no start time, and a player that crashes or is
 * force-closed never clears the flag. Remember when we first saw the same track playing, and past this many
 * seconds treat it as finished rather than claim someone is still listening.
 */
export const STUCK_AFTER = 20 * 60;

interface Seen { k: number; since: number }

/** Returns the unix time this exact track was first seen playing, recording it if it is new. */
export async function firstSeenPlaying(store: Store, np: NowPlaying, now: number): Promise<number> {
  const k = hash(`${np.track.artist}\u0000${np.track.title}\u0000${np.track.album}`);
  const key = `playing-${np.user.toLowerCase()}`;
  const seen = await store.get<Seen>(key);
  if (seen && seen.k === k && Number.isFinite(seen.since) && seen.since <= now) return seen.since;
  await store.put(key, { k, since: now } satisfies Seen, 86_400);
  return now;
}

/** A playing track that has been "playing" for too long becomes a last-played one, dated from when we first saw it. */
export async function settle(store: Store, np: NowPlaying, now: number): Promise<NowPlaying> {
  if (np.status !== "playing") return np;
  const since = await firstSeenPlaying(store, np, now);
  if (now - since <= STUCK_AFTER) return np;
  return { ...np, status: "idle", track: { ...np.track, playedAt: since } };
}
