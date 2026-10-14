import { artStore, resolveArt, type Resolved } from "../art.ts";
import { dataForFailure, dataForTrack } from "../card.ts";
import { coverOptions, isTracked, secret, trackedUsers, type Env } from "../config.ts";
import { demoCard } from "../demo.ts";
import { fetchNowPlaying } from "../lastfm.ts";
import { cacheKey, type Params } from "../params.ts";
import { settle } from "../presence.ts";
import { chooseStore } from "../store.ts";
import { draw, type CardOut } from "./http.ts";

/**
 * Seconds a card is reused at the edge (only on a custom domain: the Cache API does nothing on workers.dev). Short
 * while playing, and short when idle too, or a cached "last played" would hide the next song.
 */
const TTL = { pending: 5, playing: 10, idle: 15, quiet: 300, error: 20, demo: 3600 } as const;
/**
 * How long a card waits for a cover before drawing the placeholder: enough for a saved cover (one KV read, which can
 * take 100-300ms when cold). A real lookup carries on in the background and the next load has the cover.
 */
const ART_BUDGET_MS = 300;
/** How long a "last good" card may stand in for a failing Last.fm: long enough for a hiccup, too short to show a previous song. */
const STALE_TTL = 120;
/** The website checks untracked users' cards this often: each check here is a Last.fm call on the owner's key. */
const POLL_MS = 20_000;

interface Rendered extends CardOut { ttl: number; good: boolean }

/** A card computed on the spot: one Last.fm call, plus a cover lookup up to a short budget. */
async function render(p: Params, env: Env, now: number, cache: Cache, origin: string, ctx: ExecutionContext): Promise<Rendered> {
  const t0 = Date.now();
  if (p.demo) {
    const { data, seed } = demoCard(p.demo, now);
    return { ...draw(data, seed, p.opts), state: `demo-${p.demo}`, ttl: TTL.demo, good: false };
  }
  if (p.invalidUser || !p.user) {
    const data = dataForFailure("", "not_found", now);
    data.message = p.invalidUser ? "Not a Last.fm username" : "Add ?user=your-name";
    return { ...draw(data, null, p.opts), state: "bad-user", ttl: TTL.quiet, good: false };
  }
  const key = secret(env, "LASTFM_API_KEY");
  if (!key) {
    const data = dataForFailure(p.user, "upstream", now);
    data.message = "No Last.fm key set yet";
    return { ...draw(data, null, p.opts), state: "no-key", ttl: TTL.error, good: false };
  }

  let res = await fetchNowPlaying(p.user, key);
  // Last.fm hiccups now and then; one quick retry is cheaper than an error card or an out-of-date fallback.
  if (!res.ok && res.reason === "upstream") res = await fetchNowPlaying(p.user, key);
  const tLastfm = Date.now() - t0;
  if (!res.ok) {
    const data = dataForFailure(p.user, res.reason, now);
    const quiet = res.reason === "empty" || res.reason === "not_found";
    return { ...draw(data, null, p.opts), state: res.reason, ttl: quiet ? TTL.quiet : TTL.error, good: false, pollMs: POLL_MS };
  }
  const store = chooseStore(env, cache, origin);
  const options = coverOptions(env, { tracked: isTracked(env, p.user), artistCover: p.artistCover });
  const cover = (track: typeof res.data.track) => resolveArt(track, fetch, options, artStore(store)).catch((): Resolved => ({ art: null, source: "none", tried: ["error"] }));
  const within = <T,>(work: Promise<T>, fallback: T) => Promise.race([work, new Promise<T>((done) => setTimeout(() => done(fallback), ART_BUDGET_MS))]);

  // The stuck-playing check and the cover lookup are independent (settling only changes status and date, never
  // which track it is), so they run side by side; past the budget, trust Last.fm's flag and draw the placeholder.
  const lookup = cover(res.data.track);
  const [np, first] = await Promise.all([within(settle(store, res.data, now), res.data), within<Resolved | null>(lookup, null)]);
  let found = first;
  // Finish in the background either way, and log how it ended: the card itself only says "pending".
  if (!first) ctx.waitUntil(lookup.then((r) => console.log(`lookup ${res.data.track.artist} - ${res.data.track.title} => ${r.source} in ${Date.now() - t0} ms ${r.tried?.join(",") ?? ""}`)));
  // Settling swapped in the track that was playing a moment ago (Last.fm dropped its flag): it needs its own cover.
  if (np.track !== res.data.track) found = await within<Resolved | null>(cover(np.track), null);

  const { art, source, tried } = found ?? { art: null, source: "pending" as const, tried: [] };
  const { data, seed } = dataForTrack(np, art, now);
  return {
    ...draw(data, seed, p.opts),
    state: `${np.status} art=${source}${tried?.length ? ` (${tried.join(",")})` : ""}`,
    ttl: source === "pending" ? TTL.pending : np.status === "playing" ? TTL.playing : TTL.idle,
    good: true,
    // Where the time went, readable in the browser's network panel or with curl -I.
    timing: `lastfm;dur=${tLastfm}, cover;dur=${Date.now() - t0 - tLastfm}`,
    pollMs: POLL_MS,
  };
}

/** The copy stored at the edge carries the real TTL in s-maxage, and the trace and key in its headers. */
async function putCache(cache: Cache, key: string, out: CardOut, ttl: number): Promise<void> {
  const headers = { "Cache-Control": `public, s-maxage=${ttl}`, "X-Tidemark-State": out.state, "X-Tidemark-Key": out.key };
  await cache.put(new Request(key), new Response(out.svg, { headers }));
}

async function fromCache(cache: Cache, key: string, state?: string): Promise<CardOut | null> {
  const hit = await cache.match(new Request(key));
  if (!hit) return null;
  return { svg: await hit.text(), key: hit.headers.get("X-Tidemark-Key") ?? "", state: state ?? hit.headers.get("X-Tidemark-State") ?? "hit", pollMs: POLL_MS, cached: true };
}

/** The plain path, for users without a presence object (or when it is unavailable): edge cache, then render. */
export async function plainCard(url: URL, p: Params, env: Env, ctx: ExecutionContext): Promise<CardOut> {
  const cache = caches.default;
  const key = cacheKey(url.origin, p);
  const hit = await fromCache(cache, key);
  if (hit) return hit;

  const out = await render(p, env, Math.floor(Date.now() / 1000), cache, url.origin, ctx);
  // On a Last.fm hiccup, the last good card (at most STALE_TTL old) beats an error card.
  if (!out.good && (out.state === "upstream" || out.state === "rate_limited")) {
    const stale = await fromCache(cache, `${key}#stale`, "stale");
    if (stale) return stale;
  }
  ctx.waitUntil(Promise.all([putCache(cache, key, out, out.ttl), out.good ? putCache(cache, `${key}#stale`, out, STALE_TTL) : undefined]));
  return out;
}

const WARM_ATTEMPTS = 4;
const WARM_GAP_MS = 12_000;

/**
 * Cron, only when no presence objects are bound: keep each tracked user's current cover saved, so their cards do
 * not wait for a lookup. Apple throttles shared cloud IPs and only some attempts get through, so it retries a few
 * times within the minute.
 */
export async function warm(env: Env): Promise<void> {
  const key = secret(env, "LASTFM_API_KEY");
  if (!key) return;
  const store = artStore(chooseStore(env, caches.default, "https://warm.invalid"));
  await Promise.all(
    trackedUsers(env).map(async (user) => {
      const res = await fetchNowPlaying(user, key);
      if (!res.ok) return;
      for (let attempt = 0; attempt < WARM_ATTEMPTS; attempt++) {
        const r = await resolveArt(res.data.track, fetch, { ...coverOptions(env, { tracked: true }), ignoreCooldown: true }, store).catch(() => null);
        console.log(`warm ${user}: ${res.data.track.artist} - ${res.data.track.title} => ${r?.source ?? "error"} ${r?.tried?.join(",") ?? ""}`);
        if (!r || r.source !== "retrying") return;
        await new Promise((done) => setTimeout(done, WARM_GAP_MS));
      }
    }),
  );
}
