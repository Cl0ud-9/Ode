import { cardKey, renderCard } from "../card.ts";
import type { CardData, CardOptions } from "../model.ts";
import type { Seed } from "../palette.ts";
import { hash } from "../util.ts";

/** A rendered card and what the response says about it. */
export interface CardOut {
  svg: string;
  /** Changes only when what the card shows changes (see cardKey); the website polls it. */
  key: string;
  /** The `X-Tidemark-State` trace. */
  state: string;
  timing?: string;
  /** How often the website should check this card for changes, in milliseconds. */
  pollMs?: number;
  /** Served from the edge cache (reported as `X-Tidemark-Cache: hit`). */
  cached?: boolean;
}

/** The card plus its key. */
export const draw = (data: CardData, seed: Seed | null, opts: CardOptions) => ({ svg: renderCard(data, seed, opts), key: cardKey(data) });

/**
 * GitHub's image proxy (camo, behind Fastly) ignores a bare `no-cache` or `no-store` and keeps the card for about
 * 60 seconds, so a new song took up to a minute to appear however often the page was reloaded. Measured through
 * real camo URLs: an explicit `max-age=0` or `s-maxage=1` is honoured and every load gets a fresh card.
 */
export const LIVE_CACHE_CONTROL = "max-age=0, s-maxage=1, must-revalidate";

export function svgHeaders(out: Pick<CardOut, "state" | "key" | "timing" | "pollMs" | "cached">): Record<string, string> {
  return {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control": LIVE_CACHE_CONTROL,
    "X-Content-Type-Options": "nosniff",
    "X-Tidemark-State": out.state,
    ...(out.key ? { "X-Tidemark-Key": out.key } : {}),
    ...(out.pollMs ? { "X-Tidemark-Poll": String(out.pollMs) } : {}),
    ...(out.timing ? { "Server-Timing": out.timing } : {}),
    ...(out.cached ? { "X-Tidemark-Cache": "hit" } : {}),
  };
}

/**
 * Every card carries an ETag, so a browser that loads the card directly gets a tiny 304 when nothing changed.
 * (camo drops the ETag, so on GitHub every load is a full, fresh card.)
 */
export function svgResponse(req: Request, out: CardOut): Response {
  const etag = `W/"${hash(out.svg).toString(36)}-${out.svg.length.toString(36)}"`;
  const headers = { ...svgHeaders(out), ETag: etag };
  const match = req.headers.get("If-None-Match");
  if (match && match.split(",").some((t) => t.trim() === etag)) return new Response(null, { status: 304, headers });
  return new Response(out.svg, { headers });
}
