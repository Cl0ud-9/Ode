import { artStore, resolveArt, type Art, type ArtSource } from "./art.ts";
import { USERNAME_RE, fetchNowPlaying, type SourceResult } from "./lastfm.ts";
import type { NowPlaying, Track } from "./model.ts";
import { settle } from "./presence.ts";
import { durableStore } from "./store.ts";
import { hash } from "./util.ts";

/** What a card needs, kept ready by the presence object so a card request never waits on Last.fm or a lookup. */
export interface Snapshot {
  ok: boolean;
  /** The settled now-playing state (stuck tracks ended, flapping smoothed out). */
  np: NowPlaying | null;
  /** Why there is no state, when `ok` is false. */
  reason?: Extract<SourceResult, { ok: false }>["reason"];
  art: Art | null;
  source: ArtSource;
  tried: string[];
  /** Cover sources this object is configured with, e.g. "lastfm+genius+itunes", so a missing one is visible. */
  sources?: string;
  /** Milliseconds: last successful poll, and when the track last changed. */
  checkedAt: number;
  changedAt: number;
}

export interface PresenceEnv {
  LASTFM_API_KEY?: string;
  GENIUS_TOKEN?: string;
}

/**
 * How often to ask Last.fm. Fast while something plays or recently changed, so a new song is noticed within
 * seconds; slower after hours of silence. At 5 seconds that is about 17,000 checks a day, well inside the free
 * plan's 100,000 Durable Object requests.
 */
export const POLL_MS = { playing: 5_000, idle: 8_000, dormant: 20_000, error: 15_000 } as const;
const DORMANT_AFTER_MS = 2 * 3_600_000;
/** A card request refreshes on the spot only if the background loop has fallen this far behind. */
const FRESH_MS = 15_000;
/** A Last.fm outage may be papered over with the last good state for this long, then it shows as an outage. */
const KEEP_LAST_GOOD_MS = 120_000;
/**
 * Stop polling if nothing (no card request, no cron kick) has asked for this user in this long. The cron kicks
 * every tracked user each minute, so this only ends loops for users removed from LASTFM_USER, which would
 * otherwise poll forever and eat the free quota. Any later request starts the loop again.
 */
const ORPHAN_AFTER_MS = 15 * 60_000;
/** On a track change, wait this long for the cover before showing the new song without it (filled in after). */
const COVER_WAIT_MS = 1_500;

const trackId = (t: Track) => hash(`${t.artist}\u0000${t.title}`);

/**
 * One per tracked user. Its alarm polls Last.fm every few seconds; when the track changes it resolves the cover
 * straight away (Last.fm, Genius and iTunes, all at once) and keeps the result, so by the time GitHub asks for the card,
 * everything is ready and the request is a single in-memory read.
 *
 * Written against the plain `fetch` + `alarm` interface (no `cloudflare:workers` import) so it can be unit tested.
 */
export class Presence {
  private snap: Snapshot | null = null;
  private inflight: Promise<void> | null = null;
  private touchedAt = 0;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: PresenceEnv,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const user = url.searchParams.get("user")?.trim() ?? "";
    if (!USERNAME_RE.test(user)) return new Response("bad user", { status: 400 });
    this.touchedAt = Date.now();
    await this.adopt(user);
    if (url.pathname === "/kick") return new Response("ok");

    if (!this.snap) this.snap = (await this.state.storage.get<Snapshot>("snap")) ?? null;
    if (!this.snap || Date.now() - this.snap.checkedAt > FRESH_MS) {
      // Normally the background loop keeps the state fresh and this is skipped. When it is not (the very first
      // request after a deploy), wait for the poll, but never longer than it takes to show the song: a slow cover
      // lookup (Genius, iTunes) finishes in the background and lands on the next request. If even the song is not
      // known yet, this answers null and the Worker falls back to the plain path.
      await Promise.race([this.refresh(), new Promise((d) => setTimeout(d, COVER_WAIT_MS + 500))]);
    }
    return Response.json(this.snap);
  }

  async alarm(): Promise<void> {
    if (!this.touchedAt) this.touchedAt = (await this.state.storage.get<number>("touchedAt")) ?? Date.now();
    if (Date.now() - this.touchedAt > ORPHAN_AFTER_MS) return; // nobody is asking: let the loop end
    // Schedule the next tick, start this one's poll, and return at once. Measured on Cloudflare: card requests that
    // arrived while the alarm handler was still awaiting Last.fm (0.3 to 1.4 s) waited for it to finish, so the
    // handler must stay short. The poll carries on in the background; one runs at a time.
    await this.state.storage.setAlarm(Date.now() + this.nextDelay()); // provisional, in case the poll dies
    // Start the poll first (an optional call would skip evaluating its argument), then pick the real interval from
    // what the poll found: playing, idle or failing.
    const poll = this.refresh()
      .catch(() => undefined)
      .then(() => this.state.storage.setAlarm(Date.now() + this.nextDelay()));
    this.state.waitUntil?.(poll);
  }

  /** Resolves once any background poll has finished. For tests and the occasional caller that needs it. */
  idle(): Promise<void> {
    return this.inflight ?? Promise.resolve();
  }

  /** Remember whose presence this is, and make sure the polling loop is running. */
  private async adopt(user: string): Promise<void> {
    const known = await this.state.storage.get<string>("user");
    // Case differences are the same Last.fm user; only a real change is written.
    if (known?.toLowerCase() !== user.toLowerCase()) await this.state.storage.put("user", user);
    // Survives eviction, so a restarted object still knows it was recently wanted (written at most once a minute).
    const saved = (await this.state.storage.get<number>("touchedAt")) ?? 0;
    if (this.touchedAt - saved > 60_000) await this.state.storage.put("touchedAt", this.touchedAt);
    if ((await this.state.storage.getAlarm()) == null) await this.state.storage.setAlarm(Date.now() + 1_000);
  }

  private nextDelay(): number {
    const s = this.snap;
    if (!s?.ok || !s.np) return POLL_MS.error;
    if (s.np.status === "playing") return POLL_MS.playing;
    return Date.now() - s.changedAt > DORMANT_AFTER_MS ? POLL_MS.dormant : POLL_MS.idle;
  }

  /** One poll at a time: a card request arriving mid-poll waits for that poll instead of starting another. */
  private refresh(): Promise<void> {
    this.inflight ??= this.poll().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async poll(): Promise<void> {
    const user = await this.state.storage.get<string>("user");
    const key = this.env.LASTFM_API_KEY;
    if (!user || !key) return;
    const prev = this.snap ?? (await this.state.storage.get<Snapshot>("snap")) ?? null;
    const nowMs = Date.now();

    let res = await fetchNowPlaying(user, key);
    if (!res.ok && res.reason === "upstream") res = await fetchNowPlaying(user, key);
    if (!res.ok) {
      // A hiccup should not blank the card: keep the last good state briefly, then admit the outage.
      if (prev?.ok && res.reason !== "not_found" && res.reason !== "empty" && nowMs - prev.checkedAt < KEEP_LAST_GOOD_MS) return;
      this.snap = { ok: false, np: null, reason: res.reason, art: null, source: "none", tried: [], checkedAt: nowMs, changedAt: prev?.changedAt ?? nowMs };
      await this.state.storage.put("snap", this.snap);
      return;
    }

    const store = durableStore(this.state.storage);
    const np = await settle(store, res.data, Math.floor(nowMs / 1000));
    const same = !!prev?.np && trackId(prev.np.track) === trackId(np.track);
    let { art, source, tried } = same && prev ? prev : { art: null as Art | null, source: "pending" as ArtSource, tried: [] as string[] };

    // A new track, or one still without a cover: look it up now. The memory inside resolveArt makes repeats cheap
    // (a saved cover, a remembered miss, or a throttled source backing off), so this is safe to try every poll.
    if (!same || !art) {
      const lookup = resolveArt(np.track, fetch, { lastfmKey: key, geniusToken: this.env.GENIUS_TOKEN }, artStore(store)).catch(() => null);
      if (!same) {
        // Show the new song right away if its cover is slow; the cover replaces the placeholder when it lands.
        const quick = await Promise.race([lookup, new Promise<"slow">((d) => setTimeout(() => d("slow"), COVER_WAIT_MS))]);
        if (quick === "slow") {
          this.snap = { ok: true, np, art: null, source: "pending", tried: [], checkedAt: nowMs, changedAt: nowMs };
        }
      }
      const r = await lookup;
      if (r) ({ art, source, tried } = { art: r.art, source: r.source, tried: r.tried ?? [] });
      if (!same || r?.art) console.log(`presence ${np.track.artist} - ${np.track.title} => ${r?.source ?? "error"} ${r?.tried?.join(",") ?? ""}`);
    }

    const sources = ["lastfm", this.env.GENIUS_TOKEN ? "genius" : "", "itunes"].filter(Boolean).join("+");
    const next: Snapshot = { ok: true, np, art, source, tried, sources, checkedAt: nowMs, changedAt: same && prev ? prev.changedAt : nowMs };
    const changed = !prev || !same || prev.np?.status !== np.status || prev.art !== art || prev.ok !== true || !prev.np;
    this.snap = next;
    // Persist only when something a card would show has changed (status, track, cover), not on every 5-second tick.
    if (changed) await this.state.storage.put("snap", next);
  }
}
