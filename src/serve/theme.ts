import { cardKey, dataForFailure, dataForTrack, paletteFor } from "../card.ts";
import { isTracked, trackedUsers, type Env } from "../config.ts";
import { DEMOS, demoCard, type Demo } from "../demo.ts";
import { STYLES, type CardData, type Style } from "../model.ts";
import type { Seed } from "../palette.ts";
import { presenceSnapshot } from "./presence.ts";

/** What the website needs to dress itself in the card's colours and say what is playing. */
export interface ThemeOut {
  user: string;
  kind: CardData["kind"];
  title?: string;
  artist?: string;
  album?: string;
  mood?: string;
  /** Same key as the card's X-Ode-Key: changes exactly when the card does. */
  key: string;
  palette: { light: Record<string, string>; dark: Record<string, string> };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

/**
 * GET /api/theme: the palette (light and dark Material roles) and track of a card, so the website can take on the
 * colours of whatever is playing. Defaults to this deployment's first tracked user; `demo=` gives a demo card.
 * Like the cards, it answers only for this deployment's own users: anyone else gets a 404, at no cost.
 */
export async function themeResponse(url: URL, env: Env): Promise<Response> {
  const q = url.searchParams;
  const scheme = (q.get("scheme") ?? "").toLowerCase();
  const style: Style = STYLES.includes(scheme as Style) ? (scheme as Style) : "content";
  const now = Math.floor(Date.now() / 1000);
  const user = q.get("user")?.trim() || trackedUsers(env)[0];
  const demo = q.get("demo") as Demo | null;

  let data: CardData;
  let seed: Seed | null;
  if (demo || !user || !env.PRESENCE) {
    ({ data, seed } = demoCard(demo && DEMOS.includes(demo) ? demo : "playing", now));
  } else {
    if (!isTracked(env, user)) return json({ error: "private" }, 404);
    try {
      const snap = await presenceSnapshot(env, user);
      ({ data, seed } = snap.ok && snap.np ? dataForTrack(snap.np, snap.art, now, snap.mood) : { data: dataForFailure(user, snap.reason ?? "upstream", now), seed: null });
    } catch {
      ({ data, seed } = { data: dataForFailure(user, "upstream", now), seed: null });
    }
  }

  const palette = paletteFor(data, seed, style);
  const body: ThemeOut = {
    user: data.user,
    kind: data.kind,
    ...(data.track ? { title: data.track.title, artist: data.track.artist, album: data.track.album } : {}),
    ...(data.mood ? { mood: data.mood } : {}),
    key: cardKey(data),
    palette: { light: { ...palette.light }, dark: { ...palette.dark } },
  };
  return json(body);
}
