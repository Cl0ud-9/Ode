import { USERNAME_RE } from "./lastfm.ts";
import { DEMOS, type Demo } from "./demo.ts";
import { MODES, THEMES, type CardOptions, type Mode, type Theme } from "./model.ts";

export interface Params {
  user: string | null;
  /** True when a user was given but is not a valid Last.fm username. */
  invalidUser: boolean;
  demo: Demo | null;
  opts: CardOptions;
}

const pick = <T extends string>(allowed: readonly T[], v: string | null, fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

export function parseParams(url: URL): Params {
  const q = url.searchParams;
  const rawUser = q.get("user")?.trim() ?? "";
  const user = USERNAME_RE.test(rawUser) ? rawUser : null;
  const demoRaw = q.get("demo");
  const still = ["1", "true", "yes"].includes((q.get("still") ?? "").toLowerCase());
  return {
    user,
    invalidUser: rawUser !== "" && user === null,
    demo: DEMOS.includes(demoRaw as Demo) ? (demoRaw as Demo) : null,
    opts: {
      theme: pick<Theme>(THEMES, q.get("theme"), "expressive"),
      mode: pick<Mode>(MODES, q.get("mode"), "auto"),
      still,
    },
  };
}

/** Normalised cache key: only recognised params, in a fixed order, so `?x=1` cannot bust the cache. */
export function cacheKey(origin: string, p: Params): string {
  const id = p.demo ? `demo-${p.demo}` : `u-${(p.user ?? "").toLowerCase()}`;
  return `${origin}/__cache/${id}/${p.opts.theme}/${p.opts.mode}/${p.opts.still ? "still" : "live"}`;
}
