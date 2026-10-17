import { type Art } from "./art.ts";
import type { SourceResult } from "./lastfm.ts";
import type { CardData, CardOptions, NowPlaying } from "./model.ts";
import type { Mood } from "./mood.ts";
import { paletteFromSeed, seedFromHash, styleSeed, type Seed } from "./palette.ts";
import { renderExpressive } from "./render/expressive.ts";
import { renderMinimal } from "./render/minimal.ts";
import { copyFor } from "./render/common.ts";
import { renderTerminal } from "./render/terminal.ts";
import { hash } from "./util.ts";

export function renderCard(data: CardData, seed: Seed | null, opts: CardOptions): string {
  const palette = paletteFromSeed(styleSeed(seed ?? seedFromHash(data.seed), opts.style));
  switch (opts.theme) {
    case "terminal": return renderTerminal(data, palette, opts);
    case "minimal": return renderMinimal(data, palette, opts);
    default: return renderExpressive(data, palette, opts);
  }
}

const seedOf = (np: NowPlaying) => hash(`${np.track.artist}\u0000${np.track.album || np.track.title}`);

export function dataForTrack(np: NowPlaying, art: Art | null, now: number, mood?: Mood): { data: CardData; seed: Seed | null } {
  return {
    data: {
      kind: np.status,
      user: np.user,
      track: np.track,
      artDataUri: art?.dataUri ?? null,
      seed: seedOf(np),
      now,
      ...(mood && np.status === "playing" ? { mood } : {}),
    },
    seed: art?.seed ?? null,
  };
}

/**
 * Changes exactly when what the card shows changes: the song, its cover, the status line ("played 4 min ago"), the
 * message. Not on every render: the card animates by itself. The website
 * polls this (with cheap HEAD requests) and swaps the image only when it changes.
 */
export function cardKey(data: CardData): string {
  const t = data.track;
  const parts = [data.kind, copyFor(data).pill, t?.title, t?.artist, t?.album, data.artDataUri?.length ?? 0, data.message ?? "", data.mood ?? ""];
  return hash(JSON.stringify(parts)).toString(36);
}

/** The card for a user this deployment does not serve: it names no song and costs no Last.fm call. */
export function dataForPrivate(user: string, now: number): CardData {
  return { kind: "private", user, track: null, artDataUri: null, seed: hash(user || "tidemark"), now };
}

/** Cards for everything that is not a track: the quiet and broken states. */
export function dataForFailure(user: string, reason: Extract<SourceResult, { ok: false }>["reason"], now: number): CardData {
  const base = { user, track: null, artDataUri: null, seed: hash(user || "tidemark"), now };
  switch (reason) {
    case "empty":
      return { ...base, kind: "empty" };
    case "not_found":
      return { ...base, kind: "error", message: "Unknown Last.fm user" };
    case "rate_limited":
      return { ...base, kind: "error", message: "Last.fm is busy" };
    default:
      return { ...base, kind: "error", message: "Could not reach Last.fm" };
  }
}
