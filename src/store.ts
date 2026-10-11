/**
 * Small key-value memory with expiry. Cloudflare's Cache API does nothing on workers.dev domains, so when a KV
 * namespace is bound (binding `ART`) that is used; otherwise the Cache API is a best-effort fallback that works
 * on custom domains. Everything here is best effort: a failing store just means we look things up again.
 */
export interface Store {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

/** KV refuses expirations under 60 seconds. */
const KV_MIN_TTL = 60;

export function kvStore(kv: KVNamespace): Store {
  return {
    async get<T>(key: string) {
      try { return await kv.get<T>(key, "json"); } catch { return null; }
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

export interface StoreEnv { ART?: KVNamespace }

export function chooseStore(env: StoreEnv, cache: Cache, origin: string): Store {
  return env.ART ? kvStore(env.ART) : cacheStore(cache, origin);
}
