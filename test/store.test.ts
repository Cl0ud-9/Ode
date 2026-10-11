import { describe, expect, it } from "vitest";
import { cacheStore, chooseStore, kvStore } from "../src/store.ts";

describe("stores", () => {
  it("round-trips JSON through KV and never throws when KV does", async () => {
    const m = new Map<string, { v: string; ttl?: number }>();
    const kv = {
      get: async (k: string) => (m.has(k) ? JSON.parse(m.get(k)!.v) : null),
      put: async (k: string, v: string, o?: { expirationTtl?: number }) => { m.set(k, { v, ttl: o?.expirationTtl }); },
    } as unknown as KVNamespace;
    const s = kvStore(kv);
    await s.put("a", { x: 1 }, 5);
    expect(await s.get("a")).toEqual({ x: 1 });
    expect(m.get("a")!.ttl).toBe(60); // KV's minimum
    const broken = kvStore({ get: async () => { throw new Error("x"); }, put: async () => { throw new Error("x"); } } as unknown as KVNamespace);
    expect(await broken.get("a")).toBeNull();
    await expect(broken.put("a", 1, 100)).resolves.toBeUndefined();
  });

  it("round-trips through the Cache API", async () => {
    const map = new Map<string, Response>();
    const c = { match: async (r: Request) => map.get(r.url)?.clone(), put: async (r: Request, res: Response) => { map.set(r.url, res); } } as unknown as Cache;
    const s = cacheStore(c, "https://x.dev");
    expect(await s.get("k")).toBeNull();
    await s.put("k", { n: 2 }, 30);
    expect(await s.get("k")).toEqual({ n: 2 });
  });

  it("prefers KV when it is bound", async () => {
    const used: string[] = [];
    const kv = { get: async () => { used.push("kv"); return null; }, put: async () => {} } as unknown as KVNamespace;
    const c = { match: async () => { used.push("cache"); return undefined; }, put: async () => {} } as unknown as Cache;
    await chooseStore({ ART: kv }, c, "https://x.dev").get("k");
    await chooseStore({}, c, "https://x.dev").get("k");
    expect(used).toEqual(["kv", "cache"]);
  });
});

describe("edge-cached KV reads", () => {
  it("passes cacheTtl to KV (at KV's 60s minimum) only when asked", async () => {
    const seen: unknown[] = [];
    const kv = { get: async (_k: string, o: unknown) => { seen.push(o); return null; }, put: async () => {} } as unknown as KVNamespace;
    const s = kvStore(kv);
    await s.get("a");
    await s.get("b", { cacheTtl: 10 });
    expect(seen[0]).toEqual({ type: "json" });
    expect(seen[1]).toEqual({ type: "json", cacheTtl: 60 });
  });
});
