import { cardKey, dataForFailure, dataForTrack } from "../card.ts";
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
/** The presence object's current snapshot for a tracked user. Throws if it cannot answer. */
export async function presenceSnapshot(env: Env, user: string): Promise<Snapshot> {
  const res = await presenceFor(env, user).fetch(`https://presence/snapshot?user=${encodeURIComponent(user)}`);
  if (!res.ok) throw new Error(`presence answered ${res.status}`);
  const snap = (await res.json()) as Snapshot | null;
  if (!snap) throw new Error("presence has no state yet");
  return snap;
}

export async function presenceCard(p: Params & { user: string }, env: Env, now: number): Promise<CardOut> {
  const t0 = Date.now();
  const snap = await presenceSnapshot(env, p.user);
  const tPresence = Date.now() - t0;
  if (!snap.ok || !snap.np) {
    const data = dataForFailure(p.user, snap.reason ?? "upstream", now);
    return { ...draw(data, null, p.opts), state: `${snap.reason ?? "upstream"} via=presence`, timing: `presence;dur=${tPresence}`, pollMs: POLL_MS };
  }
  const { data, seed } = dataForTrack(snap.np, snap.art, now, snap.mood);
  return {
    ...draw(data, seed, p.opts),
    state: traceOf(snap, snap.np),
    timing: `presence;dur=${tPresence}, render;dur=${Date.now() - t0 - tPresence}`,
    pollMs: POLL_MS,
  };
}

/** The `X-Ode-State` of a card with a song: its status, where the cover came from, and how fresh the snapshot is. */
function traceOf(snap: Snapshot, np: NonNullable<Snapshot["np"]>): string {
  const age = Math.round((Date.now() - snap.checkedAt) / 1000);
  const misses = snap.tried.length && !snap.art ? ` (${snap.tried.join(",")})` : "";
  return `${np.status} art=${snap.source}${misses} via=presence age=${age}s${snap.mood ? ` mood=${snap.mood}` : ""}${snap.sources ? ` sources=${snap.sources}` : ""}`;
}

/**
 * What the website polls for: the card's key and trace, and nothing drawn. The key is the card's own (cardKey of the same
 * data), so it changes exactly when the card does; the card is no longer rendered every few seconds for a page left open.
 */
export async function presenceKey(p: Params & { user: string }, env: Env, now: number): Promise<Pick<CardOut, "key" | "state" | "pollMs">> {
  const snap = await presenceSnapshot(env, p.user);
  if (!snap.ok || !snap.np) {
    return { key: cardKey(dataForFailure(p.user, snap.reason ?? "upstream", now)), state: `${snap.reason ?? "upstream"} via=presence`, pollMs: POLL_MS };
  }
  const { data } = dataForTrack(snap.np, snap.art, now, snap.mood);
  return { key: cardKey(data), state: traceOf(snap, snap.np), pollMs: POLL_MS };
}
