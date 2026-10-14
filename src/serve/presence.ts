import { dataForFailure, dataForTrack } from "../card.ts";
import type { Env } from "../config.ts";
import type { Params } from "../params.ts";
import type { Snapshot } from "../presence-do.ts";
import { draw, type CardOut } from "./http.ts";

/** The website checks a tracked user's card this often: each check is one in-memory read, no Last.fm call. */
const POLL_MS = 4_000;

export const presenceFor = (env: Env, user: string) => env.PRESENCE!.get(env.PRESENCE!.idFromName(user.toLowerCase()));

/**
 * The fast path: the presence object already knows what is playing and has the cover, so this is one read plus
 * a render. Measured in Server-Timing as "presence". Throws if the object cannot answer, so the caller can fall
 * back to the plain path.
 */
export async function presenceCard(p: Params & { user: string }, env: Env, now: number): Promise<CardOut> {
  const t0 = Date.now();
  const res = await presenceFor(env, p.user).fetch(`https://presence/snapshot?user=${encodeURIComponent(p.user)}`);
  if (!res.ok) throw new Error(`presence answered ${res.status}`);
  const snap = (await res.json()) as Snapshot | null;
  const tPresence = Date.now() - t0;
  if (!snap) throw new Error("presence has no state yet");
  if (!snap.ok || !snap.np) {
    const data = dataForFailure(p.user, snap.reason ?? "upstream", now);
    return { ...draw(data, null, p.opts), state: `${snap.reason ?? "upstream"} via=presence`, timing: `presence;dur=${tPresence}`, pollMs: POLL_MS };
  }
  const { data, seed } = dataForTrack(snap.np, snap.art, now, snap.mood);
  const age = Math.round((Date.now() - snap.checkedAt) / 1000);
  const misses = snap.tried.length && !snap.art ? ` (${snap.tried.join(",")})` : "";
  return {
    ...draw(data, seed, p.opts),
    state: `${snap.np.status} art=${snap.source}${misses} via=presence age=${age}s${snap.mood ? ` mood=${snap.mood}` : ""}${snap.sources ? ` sources=${snap.sources}` : ""}`,
    timing: `presence;dur=${tPresence}, render;dur=${Date.now() - t0 - tPresence}`,
    pollMs: POLL_MS,
  };
}
