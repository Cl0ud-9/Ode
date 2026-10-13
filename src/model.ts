export const APP_NAME = "Tidemark";

export type TrackStatus = "playing" | "idle";

export interface Track {
  title: string;
  artist: string;
  album: string;
  /** Last.fm image URL (any size), or null when the track has no usable art. */
  artUrl: string | null;
  /** Unix seconds the track was scrobbled; null while it is playing. */
  playedAt: number | null;
}

/** What every music source adapter must produce. */
export interface NowPlaying {
  user: string;
  status: TrackStatus;
  track: Track;
  /** Unix seconds this track was first seen playing (set while playing, when known). */
  since?: number;
}

export type CardKind = "playing" | "idle" | "empty" | "error";

export const THEMES = ["expressive", "terminal", "minimal"] as const;
export type Theme = (typeof THEMES)[number];

export const MODES = ["auto", "light", "dark"] as const;
export type Mode = (typeof MODES)[number];

export interface CardOptions {
  theme: Theme;
  mode: Mode;
  /** Disable all CSS animation (also honoured via prefers-reduced-motion). */
  still: boolean;
}

/** Everything a renderer needs; art is already embedded and palette resolved. */
export interface CardData {
  kind: CardKind;
  user: string;
  track: Track | null;
  /** data: URI of the album art, or null. */
  artDataUri: string | null;
  /** Seed used for deterministic shapes when there is no art, and for the wave. */
  seed: number;
  /** Short human text for non-track states. */
  message?: string;
  now: number;
  /** Seconds into the song and its length, when both are known: drives the progress indicator. */
  progress?: { elapsed: number; duration: number };
}
