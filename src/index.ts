import { isTracked, secret, settingsPrint, trackedUsers, type Env } from "./config.ts";
import { parseParams } from "./params.ts";
import { svgResponse, type CardOut } from "./serve/http.ts";
import { sitePage } from "./serve/page.ts";
import { plainCard, warm } from "./serve/plain.ts";
import { presenceCard, presenceFor, presenceKey } from "./serve/presence.ts";
import { themeResponse } from "./serve/theme.ts";

export { Presence } from "./presence-do.ts";
export type { Env } from "./config.ts";

/**
 * GET /api/now: the card. Tracked users are answered from their presence object (one in-memory read); anyone else,
 * or a tracked user whose object cannot answer, goes through the plain path.
 */
async function handleCard(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const p = parseParams(url);
  const user = p.user;
  const fast = !p.demo && !!user && !!env.PRESENCE && !!secret(env, "LASTFM_API_KEY") && !p.artistCover && isTracked(env, user);
  if (fast) {
    const out = await presenceCard({ ...p, user }, env, Math.floor(Date.now() / 1000)).catch((e: unknown) => {
      console.log(`presence unavailable: ${String(e)}`);
      return null;
    });
    if (out) return svgResponse(req, out);
  }
  return svgResponse(req, await plainCard(url, p, env, ctx));
}

/**
 * GET or HEAD /api/key: what the website polls. The card's key (and its trace, for the cover wait) without drawing it, so a page
 * left open costs a memory read, not a render. Anyone not tracked, or a tracked user whose object cannot answer, gets the
 * same answer the card would give.
 */
async function handleKey(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const p = parseParams(url);
  const user = p.user;
  const fast = !p.demo && !!user && !!env.PRESENCE && !!secret(env, "LASTFM_API_KEY") && !p.artistCover && isTracked(env, user);
  let out: Pick<CardOut, "key" | "state" | "pollMs"> | null = null;
  if (fast) {
    out = await presenceKey({ ...p, user }, env, Math.floor(Date.now() / 1000)).catch((e: unknown) => {
      console.log(`presence unavailable: ${String(e)}`);
      return null;
    });
  }
  out ??= await plainCard(url, p, env, ctx);
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store", "X-Ode-State": out.state, ...(out.key ? { "X-Ode-Key": out.key } : {}), ...(out.pollMs ? { "X-Ode-Poll": String(out.pollMs) } : {}) },
  });
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // With presence objects, the cron only keeps each polling loop alive (and passes on new secrets); they do the
    // real work every few seconds.
    if (env.PRESENCE && secret(env, "LASTFM_API_KEY")) {
      const cfg = settingsPrint(env);
      ctx.waitUntil(Promise.all(trackedUsers(env).map((u) => presenceFor(env, u).fetch(`https://presence/kick?user=${encodeURIComponent(u)}&cfg=${cfg}`))));
      return;
    }
    ctx.waitUntil(warm(env));
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/api/now":
        return handleCard(req, env, ctx);
      case "/api/key":
        return handleKey(req, env, ctx);
      case "/api/theme":
        return themeResponse(url, env);
      case "/health":
        return new Response("ok", { headers: { "Cache-Control": "no-store" } });
      default:
        // The website (site/) is served as static assets, the home page dressed in the live card; anything else is not found.
        return env.ASSETS ? sitePage(req, { ...env, ASSETS: env.ASSETS }) : new Response("Not found", { status: 404 });
    }
  },
} satisfies ExportedHandler<Env>;
