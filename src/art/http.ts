/** Fetching for the cover sources: JSON with timeouts, image bytes, and the two errors the resolver understands. */

export const UA = "Tidemark/0.1 (+https://github.com/Cl0ud-9/tidemark)";
const LOOKUP_TIMEOUT_MS = 2500;
const IMAGE_TIMEOUT_MS = 3000;
const MAX_IMAGE_BYTES = 400_000;

/** Thrown when a catalogue says "slow down" (or cannot be reached), so we stop asking it for a while. */
export class Throttled extends Error {
  /** What to call it in the trace: an HTTP status (429, 401, 503), "bad-reply" or "timeout". */
  readonly why: string | number;
  // A plain field, not a constructor parameter property: Node's type stripping (npm run preview) rejects those.
  constructor(where: string, why: string | number = 429) {
    super(where);
    this.why = why;
  }
}

/** Thrown by a loader whose found cover would not load, carrying why (for the trace). */
export class BadImage extends Error {}

/** Never cache error pages: an upstream 429 must not stick for an hour. */
export const cacheOk = (ttl: number) => ({ cacheTtl: ttl, cacheEverything: true, cacheTtlByStatus: { "200-299": ttl, "300-599": 0 } });

/** True for answers about us rather than the track: throttling, our credentials, or the service failing. */
export const isTransient = (status: number) => status === 429 || status === 401 || status === 403 || status >= 500;

/**
 * GET JSON. Anything that is not a clean answer (429, a rejected key, a 5xx, an HTML error page, a timeout) throws
 * Throttled: it says nothing about the track and must never be remembered as "no such track". A plain 404 is null.
 */
export async function json<T>(url: string, fetcher: typeof fetch, headers?: HeadersInit, timeoutMs = LOOKUP_TIMEOUT_MS): Promise<T | null> {
  try {
    const init = { headers, cf: cacheOk(3600), signal: AbortSignal.timeout(timeoutMs) } as RequestInit;
    const res = await fetcher(url, init);
    if (res.status === 401) console.log(`cover source rejected our credentials: ${new URL(url).hostname}`);
    if (isTransient(res.status)) throw new Throttled(url, res.status);
    if (!res.ok) return null;
    try {
      return (await res.json()) as T;
    } catch {
      throw new Throttled(url, "bad-reply");
    }
  } catch (e) {
    throw e instanceof Throttled ? e : new Throttled(url, "timeout");
  }
}

/** An image's bytes, or null. `why`, when given, collects a short reason, shown in the trace as "bad-image(...)". */
export async function getBytes(url: string, fetcher: typeof fetch, why?: string[]): Promise<Uint8Array | null> {
  try {
    const res = await fetcher(url, { cf: cacheOk(86400), signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) } as RequestInit);
    if (!res.ok) return void why?.push(`http-${res.status}`), null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > 0 && buf.length < MAX_IMAGE_BYTES) return buf;
    return void why?.push(`size-${buf.length}`), null;
  } catch {
    return void why?.push("fetch-failed"), null;
  }
}
