import { type Art } from "./art.ts";
import type { SourceResult } from "./lastfm.ts";
import type { CardData, CardOptions, NowPlaying } from "./model.ts";
import { paletteFromSeed, seedFromHash, type Seed } from "./palette.ts";
import { renderExpressive } from "./render/expressive.ts";
import { renderMinimal } from "./render/minimal.ts";
import { renderTerminal } from "./render/terminal.ts";
import { hash } from "./util.ts";

export function renderCard(data: CardData, seed: Seed | null, opts: CardOptions): string {
  const palette = paletteFromSeed(seed ?? seedFromHash(data.seed));
  switch (opts.theme) {
    case "terminal": return renderTerminal(data, palette, opts);
    case "minimal": return renderMinimal(data, palette, opts);
    default: return renderExpressive(data, palette, opts);
  }
}

const seedOf = (np: NowPlaying) => hash(`${np.track.artist}\u0000${np.track.album || np.track.title}`);

export function dataForTrack(np: NowPlaying, art: Art | null, now: number): { data: CardData; seed: Seed | null } {
  return {
    data: {
      kind: np.status,
      user: np.user,
      track: np.track,
      artDataUri: art?.dataUri ?? null,
      seed: seedOf(np),
      now,
    },
    seed: art?.seed ?? null,
  };
}

/** Cards for everything that is not a track: the quiet and broken states. */
export function dataForFailure(user: string, reason: Extract<SourceResult, { ok: false }>["reason"], now: number): CardData {
  const base = { user, track: null, artDataUri: null, seed: hash(user || "tidemark"), now };
  switch (reason) {
    case "empty":
      return { ...base, kind: "empty" };
    case "not_found":
      return { ...base, kind: "error", message: `No Last.fm user named "${user}"` };
    case "rate_limited":
      return { ...base, kind: "error", message: "Last.fm is busy, trying again shortly" };
    default:
      return { ...base, kind: "error", message: "Could not reach Last.fm" };
  }
}
