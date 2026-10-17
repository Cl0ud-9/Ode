import type { Mood } from "./mood.ts";

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
}

export type CardKind = "playing" | "idle" | "empty" | "error" | "private";

export const THEMES = ["expressive", "terminal", "minimal"] as const;
export type Theme = (typeof THEMES)[number];

export const MODES = ["auto", "light", "dark"] as const;
export type Mode = (typeof MODES)[number];

/**
 * Material You colour styles, as Android derives them from one source colour. "content" keeps the cover's own
 * colours (the default); the others follow the dynamic-colour scheme of the same name.
 */
export const STYLES = ["content", "tonal", "vibrant", "expressive", "fidelity", "mono"] as const;
export type Style = (typeof STYLES)[number];

export interface CardOptions {
  theme: Theme;
  mode: Mode;
  /** Disable all CSS animation (also honoured via prefers-reduced-motion). */
  still: boolean;
  /**
   * Leave the corners outside the rounded card transparent instead of painting them in GitHub's page colour.
   * For pages with their own background (the website preview); see cornerFill.
   */
  clearCorners?: boolean;
  /** Colour style (Material You scheme variant); "content" when unset. */
  style?: Style;
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
  /** How the playing song feels, from its tags: sets the tempo of the card's motion. */
  mood?: Mood;
}
