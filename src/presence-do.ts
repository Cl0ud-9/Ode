import { artStore, resolveArt, type Art, type ArtSource } from "./art.ts";
import { coverOptions, secret, settingsPrint, sourceList, type Secrets } from "./config.ts";
import { USERNAME_RE, fetchNowPlaying, type SourceResult } from "./lastfm.ts";
import type { NowPlaying, Track } from "./model.ts";
import { settle } from "./presence.ts";
import { durableStore, sweepExpired } from "./store.ts";
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

export type PresenceEnv = Secrets;

/**
 * How often to ask Last.fm. Fast while something plays or recently changed, so a new song is noticed within
 * seconds; a little slower after hours of silence, still quick enough that the first song after a break shows within
 * about 10 seconds. At 5 seconds that is about 17,000 checks a day, well inside the free
 * plan's 100,000 Durable Object requests.
 */
export const POLL_MS = { playing: 5_000, idle: 8_000, dormant: 10_000, error: 15_000 } as const;
const DORMANT_AFTER_MS = 2 * 3_600_000;
/** If the background loop has fallen this far behind, a card request starts a poll (without waiting for it). */
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
/** One page of expired entries is cleared this often (see sweepExpired). */
const SWEEP_EVERY_MS = 10 * 60_000;

/** At most one restart for new settings this often, so two versions disagreeing during a rollout cannot loop. */
const RESTART_AT_MOST_EVERY_MS = 10 * 60_000;

const trackId = (t: Track) => hash(`${t.artist}\u0000${t.title}`);

/**
 * One per tracked user. Its alarm polls Last.fm every few seconds; when the track changes it resolves the cover
 * straight away (Last.fm, Genius and iTunes at once, then YouTube) and keeps the result, so by the time GitHub asks for the card,
 * everything is ready and the request is a single in-memory read.
 *
 * Written against the plain `fetch` + `alarm` interface (no `cloudflare:workers` import) so it can be unit tested.
 */
export class Presence {
  private snap: Snapshot | null = null;
  private inflight: Promise<void> | null = null;
  private touchedAt = 0;
  // Kept in memory so a card request does no storage I/O at all: measured, requests that read storage while a poll
  // was writing waited for that poll (about 300 ms, once every few polls).
  private user: string | null = null;
  private savedTouchedAt = -1;
  private looping = false;
  private sweptAt = 0;
  private sweepFrom: string | undefined;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: PresenceEnv,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const user = url.searchParams.get("user")?.trim() ?? "";
    if (!USERNAME_RE.test(user)) return new Response("bad user", { status: 400 });
    this.touchedAt = Date.now();
    const kick = url.pathname === "/kick";
    // The cron's kick always checks the alarm for real, so a loop that died while the object stayed alive restarts.
    if (kick) this.looping = false;
    await this.adopt(user);
    if (kick) {
      // The cron runs the current version: if it was given other secrets than this object holds, restart to load them.
      const print = url.searchParams.get("cfg");
      if (print && print !== settingsPrint(this.env)) {
        const last = (await this.state.storage.get<number>("restartedAt")) ?? 0;
        if (Date.now() - last > RESTART_AT_MOST_EVERY_MS) {
          await this.state.storage.put("restartedAt", Date.now());
          this.state.abort?.("settings changed");
          return new Response("restarting for new settings");
        }
      }
      return new Response("ok");
    }

    if (!this.snap) this.snap = (await this.state.storage.get<Snapshot>("snap")) ?? null;
    const age = this.snap ? Date.now() - this.snap.checkedAt : Infinity;
    if (age > KEEP_LAST_GOOD_MS) {
      if (this.snap) this.looping = false; // the loop should have kept this fresh; make sure an alarm is set
      await this.adopt(user);
      // Nothing usable yet (the very first request after a deploy, or a loop that died): wait for the poll, but
      // never longer than it takes to show the song: a slow cover lookup (Genius, iTunes) finishes in the
      // background and lands on the next request. If even the song is not known yet, this answers null and the
      // Worker falls back to the plain path.
      await Promise.race([this.refresh(), new Promise((d) => setTimeout(d, COVER_WAIT_MS + 500))]);
    } else if (age > FRESH_MS) {
      // Cloudflare fires alarms late now and then. Measured: waiting for a poll here made one card request in
      // eight take 400 to 650 ms. Answer with what we have (seconds old) and catch up in the background.
      void this.refresh().catch(() => undefined);
    }
    return Response.json(this.snap);
  }

  async alarm(): Promise<void> {
    if (!this.touchedAt) this.touchedAt = (await this.state.storage.get<number>("touchedAt")) ?? Date.now();
    if (Date.now() - this.touchedAt > ORPHAN_AFTER_MS) {
      this.looping = false; // nobody is asking: let the loop end (the next request starts it again)
      return;
    }
    // Schedule the next tick, start this one's poll, and return at once. Measured on Cloudflare: card requests that
    // arrived while the alarm handler was still awaiting Last.fm (0.3 to 1.4 s) waited for it to finish, so the
    // handler must stay short. The poll carries on in the background; one runs at a time.
    await this.state.storage.setAlarm(Date.now() + this.nextDelay()); // provisional, in case the poll dies
    // Start the poll first (an optional call would skip evaluating its argument), then pick the real interval from
    // what the poll found: playing, idle or failing.
    const poll = this.refresh()
      .catch(() => undefined)
      .then(() => this.sweep())
      .then(() => this.state.storage.setAlarm(Date.now() + this.nextDelay()));
    this.state.waitUntil?.(poll);
  }

  /** Clears one page of expired covers and notes, at most every SWEEP_EVERY_MS. */
  private async sweep(): Promise<void> {
    if (Date.now() - this.sweptAt < SWEEP_EVERY_MS) return;
    this.sweptAt = Date.now();
    try {
      ({ next: this.sweepFrom } = await sweepExpired(this.state.storage, this.sweepFrom));
    } catch { /* best effort: try again next time */ }
  }

  /** Resolves once any background poll has finished. For tests and the occasional caller that needs it. */
  idle(): Promise<void> {
    return this.inflight ?? Promise.resolve();
  }

  /** Remember whose presence this is, and make sure the polling loop is running. */
  private async adopt(user: string): Promise<void> {
    // Case differences are the same Last.fm user; only a real change is written.
    if (this.user?.toLowerCase() !== user.toLowerCase()) {
      const known = await this.state.storage.get<string>("user");
      if (known?.toLowerCase() !== user.toLowerCase()) await this.state.storage.put("user", user);
      this.user = user;
    }
    // Survives eviction, so a restarted object still knows it was recently wanted (written at most once a minute).
    if (this.savedTouchedAt < 0) this.savedTouchedAt = (await this.state.storage.get<number>("touchedAt")) ?? 0;
    if (this.touchedAt - this.savedTouchedAt > 60_000) {
      await this.state.storage.put("touchedAt", this.touchedAt);
      this.savedTouchedAt = this.touchedAt;
    }
    if (!this.looping) {
      if ((await this.state.storage.getAlarm()) == null) await this.state.storage.setAlarm(Date.now() + 1_000);
      this.looping = true;
    }
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
    const user = this.user ?? (await this.state.storage.get<string>("user"));
    const key = secret(this.env, "LASTFM_API_KEY");
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
      const started = Date.now();
      const lookup = resolveArt(np.track, fetch, coverOptions(this.env, { tracked: true }), artStore(store)).catch(
        // Not swallowed: an unexpected failure is named in the trace instead of leaving the last one standing.
        (e: unknown) => ({ art: null, source: "none" as ArtSource, tried: [`error:${String(e).replace(/[^\w .:()-]/g, "").slice(0, 80)}`] }),
      );
      if (!same) {
        // Show the new song right away if its cover is slow; the cover replaces the placeholder when it lands.
        const quick = await Promise.race([lookup, new Promise<"slow">((d) => setTimeout(() => d("slow"), COVER_WAIT_MS))]);
        if (quick === "slow") {
          this.snap = { ok: true, np, art: null, source: "pending", tried: [], checkedAt: nowMs, changedAt: nowMs };
        }
      }
      const r = await lookup;
      if (r) ({ art, source, tried } = { art: r.art, source: r.source, tried: r.tried ?? [] });
      if (!same || r?.art) console.log(`presence ${np.track.artist} - ${np.track.title} => ${r?.source ?? "error"} in ${Date.now() - started} ms ${r?.tried?.join(",") ?? ""}`);
    }

    const sources = sourceList(coverOptions(this.env, { tracked: true }));
    const next: Snapshot = { ok: true, np, art, source, tried, sources, checkedAt: nowMs, changedAt: same && prev ? prev.changedAt : nowMs };
    const changed = !prev || !same || prev.np?.status !== np.status || prev.art !== art || prev.ok !== true || !prev.np;
    this.snap = next;
    // Persist only when something a card would show has changed (status, track, cover), not on every 5-second tick.
    if (changed) await this.state.storage.put("snap", next);
  }
}
