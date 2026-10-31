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
 * A track whose length is known may play that long (and a little more) before it counts as stuck, so a 45-minute mix is not
 * called finished after 20. Where the length is unknown, or shorter than that, the 20 minutes stand.
 */
export const STUCK_EXTRA = 5 * 60;
export const STUCK_MAX = 6 * 3600;
export const stuckAfter = (length = 0): number => (length > 0 ? Math.min(STUCK_MAX, Math.max(STUCK_AFTER, length + STUCK_EXTRA)) : STUCK_AFTER);

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

/**
 * A song on repeat is often scrobbled again and again but flagged as playing only the first time (the player does not
 * announce a repeat as a new play), so between scrobbles Last.fm says "last played" while it plays on. The same song
 * scrobbled again within this long of its previous scrobble is taken as a loop, and as still playing...
 */
export const LOOP_MIN = 20;
export const LOOP_MAX = 20 * 60;
/**
 * ...until the next scrobble is due. Each play is scrobbled a little over halfway through it, so the next one shows up
 * about 1.6 loops after the last one's start; this leaves room for a slow scrobbler, and no more.
 */
export const LOOP_DUE = 1.9;
export const LOOP_SLACK = 20;
/**
 * Once a loop's scrobbles have been seen arriving, the next is due one loop after the last was seen, with little to spare
 * (a scrobbler is steady: two loops of "It's You" came 141 seconds apart on a 138-second loop).
 */
export const LOOP_DUE_SEEN = 1.08;
export const LOOP_SEEN_SLACK = 12;
/**
 * A song's length is learned from how far apart its repeats were scrobbled. Seen playing for this much longer than that, a
 * song whose flag has just dropped had been restarted, so it is a loop from its first repeat, not from the second scrobble.
 * Where a song proves this wrong (the flag simply lasts longer than the song, and no scrobble follows) it is not used again.
 */
export const FLAG_OUTLIVES = 1.5;
const LENGTH_TTL = 90 * 86_400;

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

/** The latest scrobble of a song, and how long after its previous scrobble (of the same song, with nothing between) it came. */
interface Loop {
  k: number;
  last: number;
  /** Seconds between the last two scrobbles (0 until there are two), which is how long the song's loop is. */
  gap: number;
  /** When the latest scrobble was first seen, so the next can be expected one loop after it; 0 for a loop inferred from the flag. */
  seen: number;
  /** The last few gaps, so one odd one (a pause, an early restart) does not decide a song's length. */
  gaps: number[];
  /** The loop was inferred from the flag outliving the song, with no second scrobble yet to confirm it. */
  flag?: boolean;
}

/** How long a song is, as learned from its loops; `miss` once its flag was seen to outlast it without a repeat. */
interface Length {
  len: number;
  miss?: boolean;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

const loopOf = (t: Track) => hash(`${t.artist}\u0000${t.title}`);

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
export async function settle(store: Store, np: NowPlaying, now: number, length = 0): Promise<NowPlaying> {
  const key = `playing-${np.user.toLowerCase()}`;
  const k = keyOf(np);
  const rec = await store.get<Seen>(key);
  const loopKey = `loop-${np.user.toLowerCase()}`;

  if (np.status === "playing") {
    const same = !!rec && rec.k === k && !rec.ended && Number.isFinite(rec.since) && rec.since <= now && now - (rec.seen ?? 0) <= NEW_PLAY_AFTER;
    let since = same ? rec.since : now;
    // Something was scrobbled after the clock started (another song, or this one again on repeat): this play began after it.
    if (same && np.lastScrobbleAt && np.lastScrobbleAt > since && np.lastScrobbleAt <= now) since = np.lastScrobbleAt;
    if (!same || since !== rec.since || now - (rec.seen ?? 0) >= REFRESH_EVERY) {
      await store.put(key, { k, since, seen: now, track: np.track } satisfies Seen, 86_400);
    }
    // A different song playing ends any loop of an earlier one: it scrobbled again later is not a repeat.
    if (!same) {
      const loop = await store.get<Loop>(loopKey);
      if (loop && loop.k !== loopOf(np.track)) await store.put(loopKey, { k: loopOf(np.track), last: 0, gap: 0, seen: 0, gaps: [] } satisfies Loop, 86_400);
    }
    if (now - since > stuckAfter(length)) return { ...np, status: "idle", track: { ...np.track, playedAt: since } };
    return np;
  }

  // How long it was flagged as playing, when this is the moment the flag drops from the song we were watching.
  const flagged = rec && !rec.ended && rec.k === k ? now - rec.since : 0;
  const again = await onRepeat(store, loopKey, np, now, flagged);
  if (rec && !rec.ended) {
    // The track we saw playing is now the latest scrobble and not playing: that play is over, and nothing is held for it.
    if (rec.k === k) {
      await store.put(key, { ...rec, ended: true } satisfies Seen, 86_400);
      return again ?? np;
    }
    if (rec.track && now - (rec.seen ?? 0) <= HOLD_FOR) return { ...np, status: "playing", track: rec.track };
  }
  return again ?? np;
}

/**
 * Not playing according to Last.fm, but its latest scrobble is the same song as the one before it, close behind: a loop.
 * Returns it as playing while the next scrobble is not yet due, or null when it is no loop (or the loop has stopped).
 */
async function onRepeat(store: Store, key: string, np: NowPlaying, now: number, flagged: number): Promise<NowPlaying | null> {
  const at = np.track.playedAt;
  if (!at || at > now) return null;
  const tk = loopOf(np.track);
  const lengthKey = `len-${np.user.toLowerCase()}-${tk}`;
  const loop = await store.get<Loop>(key);
  let cur: Loop;
  if (loop && loop.k === tk && at === loop.last) cur = loop;
  else if (loop && loop.k === tk && at < loop.last) return null; // a lagging answer naming an older scrobble
  else {
    const d = loop && loop.k === tk ? at - loop.last : 0;
    const ok = d >= LOOP_MIN && d <= LOOP_MAX;
    const gaps = ok ? [...(loop?.gaps ?? []), d].slice(-5) : [];
    cur = { k: tk, last: at, gap: ok ? d : 0, seen: now, gaps };
    await store.put(key, cur, 86_400);
    if (ok) {
      // The song's length, kept for the next time it is played: the middle of its recent gaps, rewritten only when it moves.
      const known = await store.get<Length>(lengthKey);
      const len = median(gaps);
      if (!known || Math.abs(known.len - len) > known.len * 0.1) await store.put(lengthKey, { len, ...(known?.miss ? { miss: true } : {}) } satisfies Length, LENGTH_TTL);
    }
  }
  // The flag has just dropped from a song that was flagged for much longer than it is long: it was restarted, which is a loop
  // already, before a second scrobble can say so.
  if (!cur.gap && flagged > 0) {
    const known = await store.get<Length>(lengthKey);
    if (known && !known.miss && known.len >= LOOP_MIN && known.len <= LOOP_MAX && flagged >= known.len * FLAG_OUTLIVES) {
      cur = { ...cur, gap: known.len, seen: 0, flag: true };
      await store.put(key, cur, 86_400);
    }
  }
  if (!cur.gap) return null;
  const due = cur.seen ? cur.seen + cur.gap * LOOP_DUE_SEEN + LOOP_SEEN_SLACK : cur.last + cur.gap * LOOP_DUE + LOOP_SLACK;
  if (now <= due) return { ...np, status: "playing", track: { ...np.track, playedAt: null } };
  if (cur.flag) {
    // Inferred from the flag and no scrobble followed: this song's flag lasts longer than the song, so it says nothing here.
    await store.put(key, { ...cur, gap: 0, flag: false } satisfies Loop, 86_400);
    await store.put(lengthKey, { len: cur.gap, miss: true } satisfies Length, LENGTH_TTL);
  }
  return null;
}

/**
 * A finished play is stamped by Last.fm with when it started, so a 4-minute song that has only just ended would read "played
 * 4 min ago", which sounds as if it ended long ago. Where the song's length is known, "ago" counts from when it ended instead
 * (never from the future: a flag that dropped early reads as just now). Anything else is returned as it was.
 */
export function endedAt(np: NowPlaying, length: number, now: number): NowPlaying {
  const at = np.track.playedAt;
  if (np.status !== "idle" || !at || length < LOOP_MIN || length > STUCK_MAX) return np;
  return { ...np, track: { ...np.track, playedAt: Math.min(at + length, now) } };
}
