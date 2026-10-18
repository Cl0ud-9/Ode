// Checks the cover pipeline against real listening: which songs get a cover, from which source, and which get none.
//
//   npm run covers -- --user YOUR_LASTFM_NAME        your most recent scrobbles (needs LASTFM_API_KEY)
//   npm run covers -- --user NAME --top --limit 60   your most played songs of the last three months
//   npm run covers -- --track "Vicetone | Nevada | Nevada"   one named song, no Last.fm key needed
//
// Keys come from the environment or from .dev.vars (the same file `npm run dev` reads): LASTFM_API_KEY, GENIUS_TOKEN
// and YOUTUBE_API_KEY. With no Genius or YouTube key those sources are skipped, exactly as on a deployment without them.
// It asks the sources one song at a time and pauses between songs, since MusicBrainz and iTunes throttle fast callers.
import { existsSync, readFileSync } from "node:fs";
import { resolveArt } from "../src/art.ts";
import { USERNAME_RE, pickArt, type RawImage } from "../src/lastfm.ts";
import type { Track } from "../src/model.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => args[args.indexOf(`--${name}`) + 1];
const values = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []));

/** KEY=value lines of .dev.vars, overridden by the environment. */
function secrets(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (existsSync(".dev.vars")) {
    for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith("#")) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "") || undefined;
    }
  }
  for (const k of ["LASTFM_API_KEY", "GENIUS_TOKEN", "YOUTUBE_API_KEY"]) out[k] = process.env[k] || out[k];
  return out;
}

/** The first LASTFM_USER in wrangler.toml, for a default. */
function configuredUser(): string | undefined {
  const m = existsSync("wrangler.toml") ? /^LASTFM_USER\s*=\s*"([^"]+)"/m.exec(readFileSync("wrangler.toml", "utf8")) : null;
  return m?.[1]?.split(",")[0]?.trim();
}

interface Item { track: Track; plays?: number }

async function lastfm(method: string, params: Record<string, string>, key: string): Promise<unknown> {
  const q = new URLSearchParams({ method, api_key: key, format: "json", ...params });
  const res = await fetch(`https://ws.audioscrobbler.com/2.0/?${q}`, { headers: { "User-Agent": "Ode/0.1 (+https://github.com/Cl0ud-9/Ode)" } });
  const json = (await res.json().catch(() => null)) as { error?: number; message?: string } | null;
  if (!json || json.error) throw new Error(`Last.fm: ${json?.message ?? `HTTP ${res.status}`}`);
  return json;
}

interface RawTrack { name?: string; artist?: { "#text"?: string; name?: string }; album?: { "#text"?: string }; image?: RawImage[]; playcount?: string }

async function listening(user: string, key: string, top: boolean, limit: number): Promise<Item[]> {
  const raw = top
    ? ((await lastfm("user.gettoptracks", { user, period: "3month", limit: String(limit) }, key)) as { toptracks?: { track?: RawTrack[] } }).toptracks?.track ?? []
    : ((await lastfm("user.getrecenttracks", { user, limit: String(Math.min(200, limit * 3)) }, key)) as { recenttracks?: { track?: RawTrack[] } }).recenttracks?.track ?? [];
  const seen = new Set<string>();
  const items: Item[] = [];
  for (const t of raw) {
    const artist = t.artist?.["#text"] ?? t.artist?.name ?? "";
    if (!t.name || !artist) continue;
    const id = `${artist}\u0000${t.name}`.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ track: { title: t.name, artist, album: t.album?.["#text"] ?? "", artUrl: pickArt(t.image), playedAt: null }, plays: Number(t.playcount) || undefined });
    if (items.length >= limit) break;
  }
  return items;
}

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function main() {
  const env = secrets();
  const named = values("track").map((t): Item => {
    const [artist = "", title = "", album = ""] = t.split("|").map((p) => p.trim());
    return { track: { title, artist, album, artUrl: null, playedAt: null } };
  });
  let items = named;
  if (!items.length) {
    const user = value("user") ?? configuredUser();
    if (!user || !USERNAME_RE.test(user)) throw new Error('Say whose songs to check: --user NAME (or set LASTFM_USER in wrangler.toml), or name one song: --track "Artist | Title | Album"');
    if (!env.LASTFM_API_KEY) throw new Error("This needs LASTFM_API_KEY: put it in .dev.vars (see .dev.vars.example) or the environment. Without a key, check one song with --track.");
    items = await listening(user, env.LASTFM_API_KEY, flag("top"), Number(value("limit")) || 40);
    console.log(`${items.length} songs from ${user}${flag("top") ? " (most played, last 3 months)" : " (most recent)"}\n`);
  }

  const tally = new Map<string, number>();
  const misses: Item[] = [];
  const rescued: string[] = [];
  console.log(`${pad("source", 12)} ${pad("on Last.fm", 10)} song`);
  for (const [i, item] of items.entries()) {
    const r = await resolveArt(item.track, fetch, { ignoreCooldown: true, lastfmKey: env.LASTFM_API_KEY, geniusToken: env.GENIUS_TOKEN, youtubeKey: env.YOUTUBE_API_KEY });
    const source = r.art ? r.source : r.source === "retrying" ? "throttled" : "none";
    tally.set(source, (tally.get(source) ?? 0) + 1);
    const label = `${item.track.artist} - ${item.track.title}`;
    console.log(`${pad(source, 12)} ${pad(item.track.artUrl ? "cover" : "no cover", 10)} ${label}${r.art ? "" : `   [${(r.tried ?? []).join(" ")}]`}`);
    if (!r.art) misses.push(item);
    else if (!item.track.artUrl) rescued.push(`${label} (${source})`);
    if (i < items.length - 1) await pause(1100);
  }

  console.log(`\n${items.length} songs: ${[...tally].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${n} ${s}`).join(", ")}`);
  if (rescued.length) console.log(`\nLast.fm had no cover, another source did (${rescued.length}):\n  ${rescued.join("\n  ")}`);
  if (misses.length) {
    console.log(`\nNo cover from any source (${misses.length}). Each of these shows a generated placeholder:`);
    for (const m of misses) console.log(`  ${m.track.artist} - ${m.track.title}${m.track.album ? ` (${m.track.album})` : ""}`);
    const off = (["GENIUS_TOKEN", "YOUTUBE_API_KEY"] as const).filter((k) => !env[k]);
    if (off.length) console.log(`\nNot set, so not asked: ${off.join(", ")}. Each is a free extra source (see the README).`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
