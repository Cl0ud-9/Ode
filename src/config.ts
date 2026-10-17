import type { ArtOptions } from "./art.ts";
import { USERNAME_RE } from "./lastfm.ts";
import { hash } from "./util.ts";

export interface Env {
  LASTFM_API_KEY?: string;
  /** Last.fm users (comma-separated) kept warm by presence objects: their cards are served from memory. */
  LASTFM_USER?: string;
  /** Optional KV namespace. Needed for covers and the stuck-playing guard to persist on workers.dev. */
  ART?: KVNamespace;
  /** Optional Genius client access token: another cover source, with its own quota. */
  GENIUS_TOKEN?: string;
  /** Optional YouTube Data API key: a last-resort cover source (official art from "Artist - Topic" uploads). */
  YOUTUBE_API_KEY?: string;
  /** The website's static files (site/), served by Cloudflare (wrangler.toml `assets`). */
  ASSETS?: Fetcher;
  /** Optional presence objects, one per tracked user (see src/presence-do.ts). */
  PRESENCE?: DurableObjectNamespace;
  /**
   * "true" to serve cards for any Last.fm user. Off by default: only LASTFM_USER is served, so nobody else can spend
   * this deployment's keys or limits. Everyone else gets a card inviting them to deploy their own.
   */
  OPEN_TO_ALL?: string;
  /** This deployment's version (wrangler.toml `version_metadata`): lets presence objects notice new code. */
  CF_VERSION_METADATA?: { id: string };
}

/** The secrets Ode reads. */
export type SecretName = "LASTFM_API_KEY" | "GENIUS_TOKEN" | "YOUTUBE_API_KEY";
export type Secrets = Partial<Record<SecretName, string>>;
/** What a presence object is configured with: the secrets and the version of the code it runs. */
export type Settings = Secrets & Pick<Env, "CF_VERSION_METADATA">;

/** A secret as set, minus stray whitespace from pasting; empty counts as unset. */
export const secret = (env: Secrets, name: SecretName): string | undefined => env[name]?.trim() || undefined;

/** Users the presence objects keep warm (LASTFM_USER, comma-separated). Anyone else uses the plain path. */
export function trackedUsers(env: Pick<Env, "LASTFM_USER">): string[] {
  return (env.LASTFM_USER ?? "").split(",").map((u) => u.trim()).filter((u) => USERNAME_RE.test(u));
}

export const isTracked = (env: Pick<Env, "LASTFM_USER">, user: string) => trackedUsers(env).some((u) => u.toLowerCase() === user.toLowerCase());

/** Whether this deployment draws cards for this user: its own tracked users, or anyone when OPEN_TO_ALL is set. */
export const servesUser = (env: Pick<Env, "LASTFM_USER" | "OPEN_TO_ALL">, user: string) =>
  env.OPEN_TO_ALL?.trim().toLowerCase() === "true" || isTracked(env, user);

/**
 * Which cover sources a card may use. YouTube has a small daily quota that belongs to the owner, so only the
 * owner's tracked users spend it: otherwise anyone could drain it by asking this Worker for random users' cards.
 * The others are free to ask (their limits are per request rate, not per day).
 */
export function coverOptions(env: Secrets, opts: { tracked: boolean; artistCover?: boolean }): ArtOptions {
  return {
    lastfmKey: secret(env, "LASTFM_API_KEY"),
    geniusToken: secret(env, "GENIUS_TOKEN"),
    youtubeKey: opts.tracked ? secret(env, "YOUTUBE_API_KEY") : undefined,
    artistCover: opts.artistCover,
  };
}

/** The cover sources a set of options will ask, for the trace: "lastfm+genius+itunes+youtube". */
export const sourceList = (o: ArtOptions) => ["lastfm", o.geniusToken ? "genius" : "", "itunes", o.youtubeKey ? "youtube" : ""].filter(Boolean).join("+");

/**
 * A fingerprint of the secrets (a hash, never the values) and the deployed version, so a presence object can tell
 * when either changed. It is created with the settings and code of its day and, kept awake by its own alarm, can
 * run for days: measured, neither `wrangler secret put` nor a deploy restarted it.
 */
export function settingsPrint(env: Settings): string {
  const secrets = (["LASTFM_API_KEY", "GENIUS_TOKEN", "YOUTUBE_API_KEY"] as const).map((n) => secret(env, n) ?? "");
  return hash([...secrets, env.CF_VERSION_METADATA?.id ?? ""].join("\u0000")).toString(36);
}
