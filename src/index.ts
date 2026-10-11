import { loadArt } from "./art.ts";
import { dataForFailure, dataForTrack, renderCard } from "./card.ts";
import { demoCard } from "./demo.ts";
import { fetchNowPlaying } from "./lastfm.ts";
import { landingPage } from "./landing.ts";
import { cacheKey, parseParams, type Params } from "./params.ts";

export interface Env {
  LASTFM_API_KEY?: string;
}

// Seconds an identical card is reused at the edge. GitHub's own image proxy adds its own delay on top.
const TTL = { playing: 45, idle: 120, quiet: 300, error: 30, demo: 3600 } as const;
const STALE_TTL = 86_400;

const svgHeaders = (state: string): Record<string, string> => ({
  "Content-Type": "image/svg+xml; charset=utf-8",
  "Cache-Control": "public, max-age=0, must-revalidate",
  "X-Content-Type-Options": "nosniff",
  "X-Tidemark-State": state,
});

function svgResponse(svg: string, state: string): Response {
  return new Response(svg, { headers: svgHeaders(state) });
}

/** The copy we store at the edge carries the real TTL in s-maxage; clients still revalidate. */
async function putCache(cache: Cache, key: string, svg: string, state: string, ttl: number): Promise<void> {
  const headers = new Headers(svgHeaders(state));
  headers.set("Cache-Control", `public, s-maxage=${ttl}`);
  await cache.put(new Request(key), new Response(svg, { headers }));
}

async function cardFor(p: Params, env: Env, now: number): Promise<{ svg: string; state: string; ttl: number; good: boolean }> {
  if (p.demo) {
    const { data, seed } = demoCard(p.demo, now);
    return { svg: renderCard(data, seed, p.opts), state: `demo-${p.demo}`, ttl: TTL.demo, good: false };
  }
  if (p.invalidUser || !p.user) {
    const data = dataForFailure("", "not_found", now);
    data.message = p.invalidUser ? "That does not look like a Last.fm username" : "Add ?user=your-lastfm-name";
    return { svg: renderCard(data, null, p.opts), state: "bad-user", ttl: TTL.quiet, good: false };
  }
  if (!env.LASTFM_API_KEY) {
    const data = dataForFailure(p.user, "upstream", now);
    data.message = "This server has no Last.fm key yet";
    return { svg: renderCard(data, null, p.opts), state: "no-key", ttl: TTL.error, good: false };
  }

  const res = await fetchNowPlaying(p.user, env.LASTFM_API_KEY);
  if (!res.ok) {
    const data = dataForFailure(p.user, res.reason, now);
    const quiet = res.reason === "empty" || res.reason === "not_found";
    return { svg: renderCard(data, null, p.opts), state: res.reason, ttl: quiet ? TTL.quiet : TTL.error, good: false };
  }
  const art = res.data.track.artUrl ? await loadArt(res.data.track.artUrl) : null;
  const { data, seed } = dataForTrack(res.data, art, now);
  return {
    svg: renderCard(data, seed, p.opts),
    state: res.data.status,
    ttl: res.data.status === "playing" ? TTL.playing : TTL.idle,
    good: true,
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
  const out = await cardFor(p, env, now);

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
  return svgResponse(out.svg, out.state);
}

export default {
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
