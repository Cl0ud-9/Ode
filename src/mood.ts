import type { Track } from "./model.ts";

/**
 * How a song feels, read from its Last.fm tags, so the card's motion can follow it: the wave travels slowly and low
 * for ambient or devotional music, fast and tall for EDM or metal. "steady" is the default when tags are missing
 * or mixed.
 */
export type Mood = "calm" | "steady" | "lively" | "intense";

/** Tags that point to each mood (lower case; Last.fm users tag freely, so common spellings are listed). */
const MOOD_TAGS: Record<Exclude<Mood, "steady">, string[]> = {
  calm: [
    "ambient", "chill", "chillout", "chill out", "lofi", "lo-fi", "lo fi", "acoustic", "piano", "classical", "sleep",
    "relaxing", "relax", "meditation", "devotional", "bhajan", "spiritual", "indian classical", "sufi", "ghazal",
    "folk", "soft", "calm", "instrumental", "new age", "downtempo", "jazz", "ballad", "mellow", "dream pop",
    "sad", "slowcore", "lullaby", "bhakti", "mantra", "carnatic", "hindustani", "sitar",
  ],
  lively: [
    "pop", "dance", "indie pop", "funk", "disco", "k-pop", "kpop", "reggaeton", "bollywood", "punjabi", "electropop",
    "synthpop", "synth-pop", "house", "happy", "upbeat", "latin", "afrobeats", "afrobeat", "hip-hop", "hip hop",
    "rap", "desi hip hop", "rnb", "r&b", "electronic", "future bass", "tropical house", "j-pop", "party",
  ],
  intense: [
    "edm", "dubstep", "drum and bass", "drum n bass", "dnb", "metal", "heavy metal", "hard rock", "rock", "punk",
    "trap", "hardstyle", "electro", "big room", "techno", "trance", "bass", "phonk", "drill", "hardcore",
    "metalcore", "industrial", "gaming", "epic", "aggressive", "brostep", "riddim",
  ],
};

const lookup = new Map<string, Exclude<Mood, "steady">>(
  (Object.entries(MOOD_TAGS) as [Exclude<Mood, "steady">, string[]][]).flatMap(([mood, tags]) => tags.map((t) => [t, mood] as const)),
);

/** Below this total tag weight a mood is a guess, so the card stays "steady". */
const MIN_SCORE = 15;

/**
 * The mood for a list of Last.fm tags (`count` is Last.fm's 0..100 weight). The ten strongest tags vote with their
 * weight; the winner needs a clear score.
 */
export function moodFromTags(tags: { name?: string; count?: number | string }[]): Mood {
  const score: Record<Exclude<Mood, "steady">, number> = { calm: 0, lively: 0, intense: 0 };
  for (const tag of tags.slice(0, 10)) {
    const mood = lookup.get((tag.name ?? "").trim().toLowerCase());
    if (mood) score[mood] += Number(tag.count) || 0;
  }
  const [best, value] = (Object.entries(score) as [Exclude<Mood, "steady">, number][]).sort((a, b) => b[1] - a[1])[0]!;
  return value >= MIN_SCORE ? best : "steady";
}

const API = "https://ws.audioscrobbler.com/2.0/";

async function topTags(params: Record<string, string>, apiKey: string, fetcher: typeof fetch) {
  const q = new URLSearchParams({ ...params, autocorrect: "1", api_key: apiKey, format: "json" });
  // A song's tags barely change: cached at the edge for a day.
  const init = { signal: AbortSignal.timeout(2500), cf: { cacheTtl: 86_400, cacheEverything: true, cacheTtlByStatus: { "200-299": 86_400, "300-599": 0 } } } as RequestInit;
  const body = (await (await fetcher(`${API}?${q}`, init)).json()) as { toptags?: { tag?: { name?: string; count?: number | string }[] | { name?: string } } };
  const tag = body?.toptags?.tag;
  return Array.isArray(tag) ? tag : tag ? [tag] : [];
}

/**
 * How long the song is, in seconds, from Last.fm's catalogue; 0 when it does not know (common for videos and mixes). Never
 * throws. Used to tell a long track that is really playing from a flag a crashed player left behind.
 */
export async function fetchLength(track: Pick<Track, "title" | "artist">, apiKey: string, fetcher: typeof fetch = fetch): Promise<number> {
  try {
    const q = new URLSearchParams({ method: "track.getinfo", artist: track.artist, track: track.title, autocorrect: "1", api_key: apiKey, format: "json" });
    const init = { signal: AbortSignal.timeout(2500), cf: { cacheTtl: 86_400, cacheEverything: true, cacheTtlByStatus: { "200-299": 86_400, "300-599": 0 } } } as RequestInit;
    const body = (await (await fetcher(`${API}?${q}`, init)).json()) as { track?: { duration?: number | string } };
    const ms = Number(body?.track?.duration);
    return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
  } catch {
    return 0;
  }
}

/**
 * The song's mood from its own tags, or its artist's when the song has too few (common for smaller releases).
 * Never throws: any failure is just "steady".
 */
export async function fetchMood(track: Pick<Track, "title" | "artist">, apiKey: string, fetcher: typeof fetch = fetch): Promise<Mood> {
  try {
    const own = moodFromTags(await topTags({ method: "track.gettoptags", artist: track.artist, track: track.title }, apiKey, fetcher));
    if (own !== "steady") return own;
    return moodFromTags(await topTags({ method: "artist.gettoptags", artist: track.artist }, apiKey, fetcher));
  } catch {
    return "steady";
  }
}
