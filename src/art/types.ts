import type { Seed } from "../palette.ts";

/** A cover ready to embed: a data URI the card can show, and the colour seed its palette is built from. */
export interface Art { dataUri: string; seed: Seed }

/** Where a cover came from, reported in the `X-Ode-State` header so a missing one can be explained. */
export type ArtSource =
  | "lastfm" // the cover that came with the scrobble
  | "lastfm-info" // Last.fm's catalogue (album.getInfo, track.getInfo, album.search)
  | "genius"
  | "itunes"
  | "musicbrainz" // MusicBrainz and the Cover Art Archive: keyless, answers from anywhere
  | "youtube"
  | "cache" // found earlier and remembered
  | "pending" // still looking
  | "none" // no source has it
  | "retrying"; // a source was briefly unavailable (throttled, timed out, rejected our key): not remembered as a miss

export interface Resolved {
  art: Art | null;
  source: ArtSource;
  /** What each source said when nothing was found, e.g. `itunes:429`; empty on success. */
  tried?: string[];
}

/**
 * A cover a source has found but not yet downloaded. Sources search in parallel, but only the winner's image is
 * fetched and decoded: decoding is the expensive part, and doing it for every source would waste CPU.
 */
export type Loader = () => Promise<Art | null>;

/**
 * Asks a source; resolves to a loader for the cover it found, or null when it has none. `note` lets a source explain
 * a miss in the trace, e.g. "youtube:no-match(channels=2/5 uploads=50 searched=3)".
 */
export type Find = (note: (detail: string) => void) => Promise<Loader | null>;

export interface ArtOptions {
  /** Retrying on purpose (the warm-up job): ignore the "throttled, back off" marker. */
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

/** Per-track memory of what was found, so a busy catalogue is asked once, not on every card refresh. */
export interface ArtStore {
  get(key: string): Promise<Art | "none" | null>;
  put(key: string, value: Art | "none", ttl: number): Promise<void>;
}
