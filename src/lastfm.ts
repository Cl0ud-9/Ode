import type { NowPlaying } from "./model.ts";

export type SourceResult =
  | { ok: true; data: NowPlaying }
  | { ok: false; reason: "not_found" | "empty" | "rate_limited" | "upstream" };

const API = "https://ws.audioscrobbler.com/2.0/";
// Last.fm serves this hash for "no cover"; treat it as missing art.
const PLACEHOLDER_HASH = "2a96cbd8b46e442fc41c2b86b821562f";

export const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_-]{1,14}$/;

export interface RawImage { "#text"?: string; size?: string }
interface RawTrack {
  name?: string;
  artist?: { "#text"?: string; name?: string };
  album?: { "#text"?: string };
  image?: RawImage[];
  date?: { uts?: string };
  "@attr"?: { nowplaying?: string };
}

export function pickArt(images: RawImage[] | undefined): string | null {
  const sizes = ["extralarge", "large", "medium", "small"];
  for (const size of sizes) {
    const url = images?.find((i) => i.size === size)?.["#text"];
    if (url && !url.includes(PLACEHOLDER_HASH)) return url;
  }
  return null;
}

export function normalize(user: string, json: unknown): SourceResult {
  const body = json as { error?: number; recenttracks?: { track?: RawTrack | RawTrack[] } };
  if (body?.error === 6) return { ok: false, reason: "not_found" };
  if (body?.error === 29) return { ok: false, reason: "rate_limited" };
  if (body?.error || !body?.recenttracks) return { ok: false, reason: "upstream" };
  const raw = body.recenttracks.track;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const first = list[0];
  if (!first?.name) return { ok: false, reason: "empty" };
  const playing = first["@attr"]?.nowplaying === "true";
  const uts = Number(first.date?.uts);
  return {
    ok: true,
    data: {
      user,
      status: playing ? "playing" : "idle",
      track: {
        title: first.name,
        artist: first.artist?.["#text"] ?? first.artist?.name ?? "Unknown artist",
        album: first.album?.["#text"] ?? "",
        artUrl: pickArt(first.image),
        playedAt: playing || !Number.isFinite(uts) ? null : uts,
      },
    },
  };
}

export async function fetchNowPlaying(user: string, apiKey: string, fetcher: typeof fetch = fetch): Promise<SourceResult> {
  const url = `${API}?method=user.getrecenttracks&user=${encodeURIComponent(user)}&api_key=${apiKey}&format=json&limit=1`;
  try {
    const res = await fetcher(url, { headers: { "User-Agent": "Tidemark/0.1 (+github readme widget)" } });
    if (res.status === 429) return { ok: false, reason: "rate_limited" };
    // Last.fm answers errors with 4xx plus a JSON body, so try to parse first.
    const json = await res.json().catch(() => null);
    if (json === null) return { ok: false, reason: "upstream" };
    return normalize(user, json);
  } catch {
    return { ok: false, reason: "upstream" };
  }
}
