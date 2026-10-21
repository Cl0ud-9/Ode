import type { NowPlaying, Track } from "./model.ts";
import type { Store } from "./store.ts";
import { hash } from "./util.ts";

/**
 * Last.fm flags the live track with `nowplaying` but gives no start time, and a player that crashes or is
 * force-closed never clears the flag. Remember when we first saw the same track playing, and past this many
 * seconds treat it as finished rather than claim someone is still listening.
 */
export const STUCK_AFTER = 20 * 60;

/**
 * The opposite problem: Last.fm's API briefly drops the flag while a track is still playing (replicas lag, the
 * player re-sends its state), so one response says "last played: the previous song". If we saw a different track
 * playing within this many seconds, keep showing it instead of flipping back and forth.
 */
export const HOLD_FOR = 90;

/**
 * A track seen playing again after a gap this long is counted as played again, not as the same play. While a track plays
 * it is seen every few seconds (the record is refreshed at least every REFRESH_EVERY), so a gap means nobody looked: as
 * long as STUCK_AFTER, so a stuck track looked at now and then is still noticed.
 */
export const NEW_PLAY_AFTER = STUCK_AFTER;

/** How often to refresh "last seen playing"; KV's free tier allows only about 1,000 writes a day. */
const REFRESH_EVERY = 45;

interface Seen {
  k: number;
  since: number;
  /** Last time this track was seen playing. */
  seen: number;
  track?: Track;
  /** Last.fm has since shown this track as finished (its latest scrobble, not playing): the play is over. */
  ended?: boolean;
}

const keyOf = (np: NowPlaying) => hash(`${np.track.artist}\u0000${np.track.title}\u0000${np.track.album}`);

/**
 * Reconciles what Last.fm says right now with what we saw a moment ago:
 *  - a track "playing" for over STUCK_AFTER becomes last-played, dated from when we first saw it;
 *  - a different track seen playing within HOLD_FOR seconds beats a response that momentarily says "idle".
 * The clock for STUCK_AFTER belongs to one play, not to the track: it starts again when the track is played again
 * (after it was seen finished, after a gap of NEW_PLAY_AFTER, or once Last.fm has scrobbled anything since the clock
 * started), or a song played a second time hours later would be called stuck at once.
 * Everything here is best effort: if the store is slow or failing, Last.fm's answer is used as is.
 */
export async function settle(store: Store, np: NowPlaying, now: number): Promise<NowPlaying> {
  const key = `playing-${np.user.toLowerCase()}`;
  const k = keyOf(np);
  const rec = await store.get<Seen>(key);

  if (np.status === "playing") {
    const same = !!rec && rec.k === k && !rec.ended && Number.isFinite(rec.since) && rec.since <= now && now - (rec.seen ?? 0) <= NEW_PLAY_AFTER;
    let since = same ? rec.since : now;
    // Something was scrobbled after the clock started (another song, or this one again on repeat): this play began after it.
    if (same && np.lastScrobbleAt && np.lastScrobbleAt > since && np.lastScrobbleAt <= now) since = np.lastScrobbleAt;
    if (!same || since !== rec.since || now - (rec.seen ?? 0) >= REFRESH_EVERY) {
      await store.put(key, { k, since, seen: now, track: np.track } satisfies Seen, 86_400);
    }
    if (now - since > STUCK_AFTER) return { ...np, status: "idle", track: { ...np.track, playedAt: since } };
    return np;
  }

  if (rec && !rec.ended) {
    // The track we saw playing is now the latest scrobble and not playing: that play is over, and nothing is held for it.
    if (rec.k === k) {
      await store.put(key, { ...rec, ended: true } satisfies Seen, 86_400);
      return np;
    }
    if (rec.track && now - (rec.seen ?? 0) <= HOLD_FOR) return { ...np, status: "playing", track: rec.track };
  }
  return np;
}
