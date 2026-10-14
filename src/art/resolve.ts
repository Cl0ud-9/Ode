import type { Track } from "../model.ts";
import type { Store } from "../store.ts";
import { hash } from "../util.ts";
import { BadImage, Throttled } from "./http.ts";
import { core, norm } from "./match.ts";
import { fromGenius } from "./sources/genius.ts";
import { fromItunes } from "./sources/itunes.ts";
import { fromLastfm, loadArt } from "./sources/lastfm.ts";
import { fromYoutube } from "./sources/youtube.ts";
import type { Art, ArtOptions, ArtSource, ArtStore, Find, Loader, Resolved } from "./types.ts";

/** Official covers do not change; a month keeps repeat plays instant. */
const HIT_TTL = 30 * 86_400;
/** "No source has it" is remembered briefly, in case a catalogue adds it or a source was having a moment. */
const MISS_TTL = 180;
/** How long one source's "no such track" is remembered, so only the throttled sources are retried. */
const SOURCE_MISS_TTL = 600;
/** YouTube has a daily quota, so its "not there" is trusted for a day. */
const QUOTA_SOURCE_MISS_TTL = 86_400;
const COOLDOWN_MS = 60_000;
/** How long the scrobble's own cover may take before the other sources are asked too (it usually takes 0.1-0.3 s). */
const OWN_HEAD_START_MS = 700;
/**
 * Bumped when a source learns to find more, so the "not there" it remembered under the old rules is ignored.
 * YouTube 2: the Topic-channel lookup (a plain search had missed art tracks that exist). 3: every channel of the
 * artist's name is tried, not only the first.
 */
const SOURCE_REVISION: Partial<Record<ArtSource, string>> = { youtube: "3" };

/**
 * "This catalogue is throttling us, leave it alone for a minute." Kept in memory, not in a store: it is only a
 * politeness hint, and writing it would burn through KV's free write limit (about 1,000 a day).
 */
const coolingUntil = new Map<string, number>();
const backingOff = (source: string) => (coolingUntil.get(source) ?? 0) > Date.now();
const backOff = (source: string) => void coolingUntil.set(source, Date.now() + COOLDOWN_MS);
/** For tests. */
export const resetBackoff = () => coolingUntil.clear();

/** Adapts a generic key-value store to what the resolver remembers. */
export function artStore(store: Store): ArtStore {
  return {
    async get(k) {
      // Covers are keyed per track and rarely change, so repeat reads can come from the edge (cold KV reads were
      // measured at 250 to 800ms).
      const v = await store.get<Art | { none: true }>(k, { cacheTtl: 60 });
      if (!v) return null;
      return "none" in v ? "none" : v;
    },
    put: (k, v, ttl) => store.put(k, v === "none" ? { none: true } : v, ttl),
  };
}

/** A source in priority order. A last resort is asked only when everything above it has missed (it has a quota). */
interface Source { name: ArtSource; find: Find; lastResort?: boolean }
interface Answer { load?: Loader; note?: string; transient?: boolean }

/**
 * Best available cover. Null means the card draws its own art. Results (and misses, briefly) are remembered per
 * track; a throttled catalogue is skipped for a minute.
 *
 * Priority: the scrobble's own cover if it arrives within a short head start; then Last.fm's catalogue, Genius and
 * Apple, all asked at once (a lower one is used only once every source above it has answered without a cover);
 * then the scrobble's late cover; then YouTube.
 */
export async function resolveArt(
  track: Pick<Track, "title" | "artist" | "album" | "artUrl">,
  fetcher: typeof fetch = fetch,
  opts: ArtOptions = {},
  store?: ArtStore,
): Promise<Resolved> {
  // Keyed by artist and title only: Last.fm sometimes sends the same song with and without an album.
  const key = hash(`${norm(track.artist)}\u0000${core(track.title)}\u0000${opts.artistCover ? 1 : 0}`).toString(36);

  // A remembered cover is the fast path: one store read, no image fetches, no decoding.
  const remembered = await store?.get(key);
  if (remembered && remembered !== "none") return { art: remembered, source: "cache" };

  // The cover that came with the scrobble, hedged: it gets a short head start, and only if it has not landed by
  // then are the other sources asked, with it behind them, so a cover they find is not held back by a slow image
  // CDN. (It used to be fetched before anything else: measured 3 s timeouts, twice, before any search began.)
  const ownWhy: string[] = [];
  const ownTry = track.artUrl ? loadArt(track.artUrl, fetcher, ownWhy).catch(() => null) : null;
  if (remembered === "none") {
    // Recently found nowhere: only the scrobble's own cover is worth another look.
    const art = ownTry ? await ownTry : null;
    if (art) await store?.put(key, art, HIT_TTL);
    return art ? { art, source: "lastfm" } : { art: null, source: "none" };
  }
  if (ownTry) {
    const early = await Promise.race([ownTry, new Promise<"slow">((d) => setTimeout(() => d("slow"), OWN_HEAD_START_MS))]);
    if (early && early !== "slow") {
      await store?.put(key, early, HIT_TTL);
      return { art: early, source: "lastfm" };
    }
  }

  const sources: Source[] = [];
  if (opts.lastfmKey) sources.push({ name: "lastfm-info", find: () => fromLastfm(track, opts.lastfmKey!, fetcher) });
  if (opts.geniusToken) sources.push({ name: "genius", find: () => fromGenius(track, opts.geniusToken!, fetcher) });
  // From Cloudflare Apple often throttles or is slow, and a slow source above would hold back a found cover.
  sources.push({ name: "itunes", find: () => fromItunes(track, fetcher, opts) });
  if (ownTry) {
    sources.push({
      name: "lastfm",
      find: async () => async () => {
        const art = await ownTry;
        if (!art) throw new BadImage([...new Set(ownWhy)].join("+") || "unknown");
        return art;
      },
    });
  }
  if (opts.youtubeKey) sources.push({ name: "youtube", find: (note) => fromYoutube(track, opts.youtubeKey!, fetcher, note), lastResort: true });

  const ask = async ({ name, find }: Source): Promise<Answer> => {
    if (!opts.ignoreCooldown && backingOff(name)) return { note: `${name}:backing-off`, transient: true };
    // This source already answered "no such track" recently: asking again only burns time and quota.
    const missKey = `miss-${name}${SOURCE_REVISION[name] ?? ""}-${key}`;
    if (name !== "lastfm" && (await store?.get(missKey)) === "none") return { note: `${name}:known-miss` };
    try {
      const details: string[] = [];
      const load = await find((d) => void details.push(d));
      if (load) return { load };
      await store?.put(missKey, "none", name === "youtube" ? QUOTA_SOURCE_MISS_TTL : SOURCE_MISS_TTL);
      return { note: `${name}:no-match${details.length ? `(${details.join(" ")})` : ""}` };
    } catch (e) {
      if (!(e instanceof Throttled)) return { note: `${name}:error` };
      if (!opts.ignoreCooldown) backOff(name);
      return { note: `${name}:${e.why}`, transient: true };
    }
  };
  const answers = sources.map((s) => (s.lastResort ? null : ask(s)));

  let transient = false;
  const tried: string[] = [];
  for (const [i, source] of sources.entries()) {
    const a = await (answers[i] ?? ask(source));
    if (a.load) {
      let reason = "";
      const art = await a.load().catch((e: unknown) => ((reason = e instanceof BadImage ? e.message : `threw ${String(e).replace(/[^\w .:-]/g, "").slice(0, 60)}`), null));
      if (art) {
        await store?.put(key, art, HIT_TTL);
        return { art, source: source.name };
      }
      // Found, but the image would not download or decode: likely transient, so not remembered as a miss.
      tried.push(`${source.name}:bad-image${reason ? `(${reason})` : ""}`);
      transient = true;
      continue;
    }
    tried.push(a.note!);
    transient ||= !!a.transient;
  }
  // A throttled lookup says nothing about the track, so only remember a real miss, and only briefly.
  if (!transient) await store?.put(key, "none", MISS_TTL);
  return { art: null, source: transient ? "retrying" : "none", tried };
}
