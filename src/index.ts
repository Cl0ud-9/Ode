import { artStore, resolveArt } from "./art.ts";
import { dataForFailure, dataForTrack, renderCard } from "./card.ts";
import { demoCard } from "./demo.ts";
import { USERNAME_RE, fetchNowPlaying } from "./lastfm.ts";
import { chooseStore } from "./store.ts";
import { settle } from "./presence.ts";
import { landingPage } from "./landing.ts";
import { cacheKey, parseParams, type Params } from "./params.ts";

export interface Env {
  LASTFM_API_KEY?: string;
  /** Optional: the Last.fm user whose current cover the cron job keeps warm, so cards never wait for a lookup. */
  LASTFM_USER?: string;
  /** Optional KV namespace. Needed for covers and the stuck-playing guard to persist on workers.dev. */
  ART?: KVNamespace;
}

// Seconds an identical card is reused at the edge. Kept short while playing: covers are cached separately for hours, so a refresh costs one Last.fm call. GitHub's own image proxy adds its delay on top.
// Idle is short too: a card cached as "last played" would otherwise hide the next song for up to this long.
const TTL = { pending: 5, playing: 10, idle: 15, quiet: 300, error: 20, demo: 3600 } as const;
/**
 * How long a card waits for a cover before drawing the placeholder. Enough for a saved cover (one KV read, which can take 100-300ms when cold);
 * a real lookup takes 300ms or more per Last.fm call, so waiting for one only delays a card that GitHub's image
 * proxy is already timing. The lookup carries on in the background and the next refresh has the cover.
 */
const ART_BUDGET_MS = 300;
/** How long a "last good" card may stand in for a failing Last.fm: long enough for a hiccup, too short to show a previous song. */
const STALE_TTL = 120;

const svgHeaders = (state: string): Record<string, string> => ({
  "Content-Type": "image/svg+xml; charset=utf-8",
  "Cache-Control": "public, max-age=0, must-revalidate",
  "X-Content-Type-Options": "nosniff",
  "X-Tidemark-State": state,
});

function svgResponse(svg: string, state: string, timing?: string): Response {
  return new Response(svg, { headers: timing ? { ...svgHeaders(state), "Server-Timing": timing } : svgHeaders(state) });
}

/** The copy we store at the edge carries the real TTL in s-maxage; clients still revalidate. */
async function putCache(cache: Cache, key: string, svg: string, state: string, ttl: number): Promise<void> {
  const headers = new Headers(svgHeaders(state));
  headers.set("Cache-Control", `public, s-maxage=${ttl}`);
  await cache.put(new Request(key), new Response(svg, { headers }));
}

async function cardFor(p: Params, env: Env, now: number, cache: Cache, origin: string, ctx: ExecutionContext): Promise<{ svg: string; state: string; ttl: number; good: boolean; timing?: string }> {
  const t0 = Date.now();
  if (p.demo) {
    const { data, seed } = demoCard(p.demo, now);
    return { svg: renderCard(data, seed, p.opts), state: `demo-${p.demo}`, ttl: TTL.demo, good: false };
  }
  if (p.invalidUser || !p.user) {
    const data = dataForFailure("", "not_found", now);
    data.message = p.invalidUser ? "Not a Last.fm username" : "Add ?user=your-name";
    return { svg: renderCard(data, null, p.opts), state: "bad-user", ttl: TTL.quiet, good: false };
  }
  if (!env.LASTFM_API_KEY) {
    const data = dataForFailure(p.user, "upstream", now);
    data.message = "No Last.fm key set yet";
    return { svg: renderCard(data, null, p.opts), state: "no-key", ttl: TTL.error, good: false };
  }

  let res = await fetchNowPlaying(p.user, env.LASTFM_API_KEY);
  // Last.fm hiccups now and then; one quick retry is cheaper than an error card or an out-of-date fallback.
  if (!res.ok && res.reason === "upstream") res = await fetchNowPlaying(p.user, env.LASTFM_API_KEY);
  const tLastfm = Date.now() - t0;
  if (!res.ok) {
    const data = dataForFailure(p.user, res.reason, now);
    const quiet = res.reason === "empty" || res.reason === "not_found";
    return { svg: renderCard(data, null, p.opts), state: res.reason, ttl: quiet ? TTL.quiet : TTL.error, good: false };
  }
  const store = chooseStore(env, cache, origin);
  // The stuck-playing check and the cover lookup are independent (settling only changes status and date, never
  // which track it is), so they run side by side instead of adding their waits together.
  const settled = settle(store, res.data, now);
  // Cover lookups can be slow or throttled. Past the budget, draw the placeholder now and let the lookup finish
  // in the background: it is stored per track, so the next refresh has the cover.
  const lookup = resolveArt(res.data.track, fetch, { artistCover: p.artistCover, lastfmKey: env.LASTFM_API_KEY }, artStore(store)).catch(() => ({ art: null, source: "none" as const, tried: ["error"] }));
  const budget = new Promise<null>((done) => setTimeout(() => done(null), ART_BUDGET_MS));
  // A slow stuck-playing check must not hold the card up either: past the budget, trust Last.fm's flag.
  const trusting = new Promise<typeof res.data>((done) => setTimeout(() => done(res.data), ART_BUDGET_MS));
  const [np, first] = await Promise.all([Promise.race([settled, trusting]), Promise.race([lookup, budget])]);
  let found = first;
  // Finish in the background either way, and log how it ended: the card itself only says "pending".
  if (!first) ctx.waitUntil(lookup.then((r) => console.log(`lookup ${res.data.track.artist} - ${res.data.track.title} => ${r.source} ${r.tried?.join(",") ?? ""}`), () => undefined));
  if (np.track !== res.data.track) {
    // Settling swapped in the track that was playing a moment ago (Last.fm dropped its flag), so it needs its own cover.
    found = await Promise.race([
      resolveArt(np.track, fetch, { artistCover: p.artistCover, lastfmKey: env.LASTFM_API_KEY }, artStore(store)).catch(() => null),
      new Promise<null>((done) => setTimeout(() => done(null), ART_BUDGET_MS)),
    ]);
  }
  const { art, source, tried } = found ?? { art: null, source: "pending" as const, tried: [] as string[] };
  const { data, seed } = dataForTrack(np, art, now);
  return {
    svg: renderCard(data, seed, p.opts),
    state: `${np.status} art=${source}${tried?.length ? ` (${tried.join(",")})` : ""}`,
    ttl: source === "pending" ? TTL.pending : np.status === "playing" ? TTL.playing : TTL.idle,
    good: true,
    // Where the time went, readable in the browser's network panel or with curl -I.
    timing: `lastfm;dur=${tLastfm}, cover;dur=${Date.now() - t0 - tLastfm}`,
  };
}

async function handleCard(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const p = parseParams(url);
  const cache = caches.default;
  const key = cacheKey(url.origin, p);

  const hit = await cache.match(new Request(key));
  if (hit) return new Response(hit.body, { headers: { ...svgHeaders(hit.headers.get("X-Tidemark-State") ?? "hit"), "X-Tidemark-Cache": "hit" } });

  const now = Math.floor(Date.now() / 1000);
  const out = await cardFor(p, env, now, cache, url.origin, ctx);

  // On a Last.fm hiccup, a day-old real card beats an error card.
  if (!out.good && (out.state === "upstream" || out.state === "rate_limited")) {
    const stale = await cache.match(new Request(`${key}#stale`));
    if (stale) return new Response(stale.body, { headers: svgHeaders("stale") });
  }

  ctx.waitUntil(
    Promise.all([
      putCache(cache, key, out.svg, out.state, out.ttl),
      out.good ? putCache(cache, `${key}#stale`, out.svg, out.state, STALE_TTL) : Promise.resolve(),
    ]),
  );
  return svgResponse(out.svg, out.state, out.timing);
}

const WARM_ATTEMPTS = 4;
const WARM_GAP_MS = 12_000;

/** Cron: keep the cover for the current track cached, so the card is instant when GitHub asks for it. */
async function warm(env: Env): Promise<void> {
  const user = env.LASTFM_USER?.trim();
  if (!user || !USERNAME_RE.test(user) || !env.LASTFM_API_KEY) return;
  const res = await fetchNowPlaying(user, env.LASTFM_API_KEY);
  if (!res.ok) return;
  const store = artStore(chooseStore(env, caches.default, "https://warm.invalid"));
  // Apple throttles shared cloud IPs and only some attempts get through, so retry a few times within the minute.
  for (let attempt = 0; attempt < WARM_ATTEMPTS; attempt++) {
    const r = await resolveArt(res.data.track, fetch, { lastfmKey: env.LASTFM_API_KEY, ignoreCooldown: true }, store).catch(() => null);
    console.log(`warm ${res.data.track.artist} - ${res.data.track.title} [${res.data.track.album}] => ${r?.source ?? "error"} ${r?.tried?.join(",") ?? ""}`);
    if (!r || r.source !== "itunes-blocked") return;
    await new Promise((done) => setTimeout(done, WARM_GAP_MS));
  }
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(warm(env));
  },
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    switch (url.pathname) {
      case "/":
        return new Response(landingPage(), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
      case "/api/now":
        return handleCard(req, env, ctx);
      case "/health":
        return new Response("ok", { headers: { "Cache-Control": "no-store" } });
      default:
        return new Response("Not found", { status: 404 });
    }
  },
} satisfies ExportedHandler<Env>;
