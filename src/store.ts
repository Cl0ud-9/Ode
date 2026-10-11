/**
 * Small key-value memory with expiry. Cloudflare's Cache API does nothing on workers.dev domains, so when a KV
 * namespace is bound (binding `ART`) that is used; otherwise the Cache API is a best-effort fallback that works
 * on custom domains. Everything here is best effort: a failing store just means we look things up again.
 */
export interface Store {
  /** `cacheTtl` (seconds) lets KV serve repeat reads from the edge: far faster than a cold read, but possibly stale. */
  get<T>(key: string, opts?: { cacheTtl?: number }): Promise<T | null>;
  put(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

/** KV refuses expirations under 60 seconds. */
const KV_MIN_TTL = 60;

export function kvStore(kv: KVNamespace): Store {
  return {
    async get<T>(key: string, opts?: { cacheTtl?: number }) {
      try { return await kv.get<T>(key, { type: "json", ...(opts?.cacheTtl ? { cacheTtl: Math.max(60, opts.cacheTtl) } : {}) }); } catch { return null; }
    },
    async put(key, value, ttl) {
      try { await kv.put(key, JSON.stringify(value), { expirationTtl: Math.max(KV_MIN_TTL, Math.round(ttl)) }); } catch { /* best effort */ }
    },
  };
}

export function cacheStore(cache: Cache, origin: string): Store {
  const req = (k: string) => new Request(`${origin}/__kv/${k}`);
  return {
    async get<T>(key: string) {
      try {
        const hit = await cache.match(req(key));
        return hit ? ((await hit.json()) as T) : null;
      } catch { return null; }
    },
    async put(key, value, ttl) {
      try {
        await cache.put(req(key), new Response(JSON.stringify(value), { headers: { "Cache-Control": `public, s-maxage=${Math.round(ttl)}` } }));
      } catch { /* best effort */ }
    },
  };
}

/**
 * A Durable Object's own storage. It has no expiry of its own, so values carry their deadline. Unlike KV it has
 * no small daily write cap and no cold-read delay, which is why the presence object keeps everything here.
 */
export function durableStore(storage: DurableObjectStorage): Store {
  return {
    async get<T>(key: string) {
      try {
        const v = await storage.get<{ v: T; exp: number }>(key);
        if (!v) return null;
        if (v.exp < Date.now()) {
          await storage.delete(key);
          return null;
        }
        return v.v;
      } catch { return null; }
    },
    async put(key, value, ttl) {
      try { await storage.put(key, { v: value, exp: Date.now() + ttl * 1000 }); } catch { /* best effort */ }
    },
  };
}

export interface StoreEnv { ART?: KVNamespace }

export function chooseStore(env: StoreEnv, cache: Cache, origin: string): Store {
  return env.ART ? kvStore(env.ART) : cacheStore(cache, origin);
}
