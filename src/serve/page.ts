import { trackedUsers, type Env } from "../config.ts";
import { themeFor, type ThemeOut } from "./theme.ts";

// The palette roles the website uses, as CSS custom properties. site/app.js keeps the same map for live updates.
const ROLE_VARS: Record<string, string> = {
  surface: "surface", container: "container", containerHigh: "container-high", onSurface: "on-surface", onVariant: "on-variant",
  outline: "outline", primary: "primary", onPrimary: "on-primary", primaryContainer: "primary-container",
  onPrimaryContainer: "on-primary-container", secondaryContainer: "secondary-container",
  onSecondaryContainer: "on-secondary-container", tertiary: "tertiary", tertiaryContainer: "tertiary-container", bgA: "bg-a", bgB: "bg-b",
};

const tokens = (scheme: Record<string, string>) =>
  Object.entries(ROLE_VARS).map(([role, name]) => (scheme[role] ? `--md-${name}:${scheme[role]};` : "")).join("");

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * Dresses the home page in the owner's live card before it is sent: palette, both cards and the live label. Without
 * this the page would first paint the demo in the default colours and only then switch, a visible flash.
 */
export function dressPage(html: string, t: ThemeOut): string {
  const card = escape(`/api/now?${new URLSearchParams({ user: t.user, corners: "clear", k: t.key })}`);
  const song = t.title ? escape(`${t.title} · ${t.artist ?? ""}`) : "";
  const playing = t.kind === "playing";
  return html
    .replace('<html lang="en">', `<html lang="en"${playing ? ' class="playing-now"' : ""} data-owner="${escape(t.user)}" data-key="${escape(t.key)}">`)
    .replace('<style id="palette"></style>', `<style id="palette">:root{${tokens(t.palette.light)}}@media (prefers-color-scheme:dark){:root{${tokens(t.palette.dark)}}}</style>`)
    .replaceAll('src="/api/now?demo=playing&corners=clear"', `src="${card}"`)
    .replace('<p class="live" id="live"', `<p class="live${playing ? " playing" : ""}" id="live"`)
    .replace('id="live-label">Tuning in</span><span class="live-song" id="live-song"></span>', `id="live-label">${playing ? "Live" : "Last played"}</span><span class="live-song" id="live-song">${song}</span>`)
    .replace('<span id="now-chip-text"></span>', `<span id="now-chip-text">${song}</span>`);
}

/** The website. The home page carries the owner's card and colours when they have one; everything else is static. */
export async function sitePage(req: Request, env: Env & { ASSETS: Fetcher }): Promise<Response> {
  const res = await env.ASSETS.fetch(req);
  const path = new URL(req.url).pathname;
  const owner = trackedUsers(env)[0];
  // `?demo` shows the page with the demo card, so it is left as it is.
  if ((path !== "/" && path !== "/index.html") || req.method !== "GET" || !res.ok || !owner || !env.PRESENCE) return res;
  if (new URL(req.url).searchParams.has("demo")) return res;
  if (!res.headers.get("content-type")?.includes("text/html")) return res;
  const t = await themeFor(new URL(`https://site/api/theme?user=${encodeURIComponent(owner)}`), env).catch(() => null);
  if (!t || (t.kind !== "playing" && t.kind !== "idle")) return res;
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.delete("etag");
  headers.set("Cache-Control", "no-cache");
  return new Response(dressPage(await res.text(), t), { status: 200, headers });
}
