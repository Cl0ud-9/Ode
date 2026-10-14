import { isTracked, secret, settingsPrint, trackedUsers, type Env } from "./config.ts";
import { landingPage } from "./landing.ts";
import { parseParams } from "./params.ts";
import { svgResponse } from "./serve/http.ts";
import { plainCard, warm } from "./serve/plain.ts";
import { presenceCard, presenceFor } from "./serve/presence.ts";

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
    switch (new URL(req.url).pathname) {
      case "/":
        return new Response(landingPage(trackedUsers(env)[0]), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
      case "/api/now":
        return handleCard(req, env, ctx);
      case "/health":
        return new Response("ok", { headers: { "Cache-Control": "no-store" } });
      default:
        return new Response("Not found", { status: 404 });
    }
  },
} satisfies ExportedHandler<Env>;
