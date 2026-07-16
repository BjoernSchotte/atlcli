import { describe, expect, it } from "bun:test";
import { sessionCache } from "../../utils/docx/session-cache.js";

describe("sessionCache (panel deps TTL cache)", () => {
  it("serves repeat gets within the TTL from one load", async () => {
    let now = 0;
    let loads = 0;
    const cache = sessionCache<string>(1000, 32, () => now);
    const load = async (): Promise<string> => {
      loads += 1;
      return "space";
    };
    expect(await cache.get("site|DOCSY", load)).toBe("space");
    now = 999;
    expect(await cache.get("site|DOCSY", load)).toBe("space");
    expect(loads).toBe(1);
  });

  it("reloads after the TTL expires", async () => {
    let now = 0;
    let loads = 0;
    const cache = sessionCache<number>(1000, 32, () => now);
    const load = async (): Promise<number> => ++loads;
    expect(await cache.get("k", load)).toBe(1);
    now = 1001;
    expect(await cache.get("k", load)).toBe(2);
  });

  it("shares an in-flight promise between concurrent gets", async () => {
    let loads = 0;
    let release!: (v: string) => void;
    const cache = sessionCache<string>(1000);
    const load = (): Promise<string> => {
      loads += 1;
      return new Promise<string>((r) => {
        release = r;
      });
    };
    const a = cache.get("k", load);
    const b = cache.get("k", load);
    release("v");
    expect(await a).toBe("v");
    expect(await b).toBe("v");
    expect(loads).toBe(1);
  });

  it("evicts a rejected load immediately so failures never stick", async () => {
    let loads = 0;
    const cache = sessionCache<string>(1000);
    const failing = (): Promise<string> => {
      loads += 1;
      return Promise.reject(new Error("boom"));
    };
    await expect(cache.get("k", failing)).rejects.toThrow("boom");
    // Rejection eviction runs in a microtask; yield once.
    await Promise.resolve();
    expect(await cache.get("k", async () => "recovered")).toBe("recovered");
    expect(loads).toBe(1);
  });

  it("isolates keys (multi-site: same space key on different sites)", async () => {
    const cache = sessionCache<string>(1000);
    expect(await cache.get("siteA|DOCSY", async () => "a")).toBe("a");
    expect(await cache.get("siteB|DOCSY", async () => "b")).toBe("b");
  });

  it("bounds entries, dropping the least recently written key", async () => {
    let loads = 0;
    const cache = sessionCache<number>(60_000, 2);
    const load = async (): Promise<number> => ++loads;
    await cache.get("a", load); // 1
    await cache.get("b", load); // 2
    await cache.get("c", load); // 3 → evicts "a"
    expect(await cache.get("b", load)).toBe(2); // still cached
    expect(await cache.get("a", load)).toBe(4); // was evicted → reloads
  });
});
