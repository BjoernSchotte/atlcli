import { describe, expect, it } from "bun:test";
import {
  ASSET_MAX_BYTES,
  ASSET_MAX_TOTAL_BYTES,
  AssetBudget,
  AssetBudgetExceededError,
} from "./asset-budget.js";

function bytes(size: number, fill = 1): Uint8Array {
  return new Uint8Array(size).fill(fill);
}

describe("AssetBudget (spec 002 shared contract)", () => {
  it("exposes the shared caps both engines import", () => {
    expect(ASSET_MAX_TOTAL_BYTES).toBe(50 * 1024 * 1024);
    expect(ASSET_MAX_BYTES).toBe(25 * 1024 * 1024);
  });

  it("deduplicates byte-identical assets before counting against the cap", () => {
    const budget = new AssetBudget({ maxTotalBytes: 100 });
    const first = budget.account(bytes(40, 7), { filename: "a.png" });
    const again = budget.account(bytes(40, 7), { filename: "a-copy.png" });
    expect(first.deduped).toBe(false);
    expect(again.deduped).toBe(true);
    // Only counted once — 40, not 80.
    expect(budget.totalBytes).toBe(40);
  });

  it("counts distinct content separately", () => {
    const budget = new AssetBudget({ maxTotalBytes: 100 });
    budget.account(bytes(40, 1), { filename: "a.png" });
    budget.account(bytes(40, 2), { filename: "b.png" });
    expect(budget.totalBytes).toBe(80);
  });

  it("throws a fatal error with a size-sorted offender list on breach", () => {
    const budget = new AssetBudget({ maxTotalBytes: 100 });
    budget.account(bytes(30, 1), { filename: "small.png", pageId: "1" });
    budget.account(bytes(50, 2), { filename: "big.png", pageId: "2" });
    let error: unknown;
    try {
      budget.account(bytes(40, 3), { filename: "mid.png", pageId: "3" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AssetBudgetExceededError);
    const breach = error as AssetBudgetExceededError;
    expect(breach.totalBytes).toBe(120);
    expect(breach.limitBytes).toBe(100);
    // Largest-first: big (50), mid (40), small (30).
    expect(breach.offenders.map((o) => o.filename)).toEqual(["big.png", "mid.png", "small.png"]);
    expect(breach.offenders.map((o) => o.pageId)).toEqual(["2", "3", "1"]);
    // The breaching asset is NOT counted (state is not mutated on throw).
    expect(budget.totalBytes).toBe(80);
    // Actionable suggestions in the message.
    expect(breach.message).toContain("--no-images");
    expect(breach.message).toContain("--max-depth");
  });

  it("does not count a deduped asset even at the cap boundary", () => {
    const budget = new AssetBudget({ maxTotalBytes: 40 });
    budget.account(bytes(40, 9), { filename: "a.png" });
    // A repeat of the same bytes dedups → no breach even though total == cap.
    expect(() => budget.account(bytes(40, 9), { filename: "a.png" })).not.toThrow();
  });

  it("keeps two DIFFERENT byte sequences distinct even when their hash buckets collide", () => {
    // The dedup key is FNV-1a(bytes) + length — a non-cryptographic hash, so
    // genuine bucket collisions exist. The budget must byte-verify bucket
    // members (sameBytes) and count colliding-but-different content twice.
    // Deterministically brute-force a real collision. Raw sequential counters
    // are too structured for FNV (its per-byte multiply keeps low-Hamming-
    // difference inputs apart), so counters go through murmur3's bijective
    // 32-bit finalizer first: distinct counters still yield distinct byte
    // sequences (bijection), but the hash values now behave randomly and the
    // birthday bound applies — the first collision lands around n ≈ 87k,
    // in single-digit milliseconds.
    const fnv = (b: Uint8Array): number => {
      let hash = 0x811c9dc5;
      for (let i = 0; i < b.length; i += 1) {
        hash ^= b[i]!;
        hash = Math.imul(hash, 0x01000193);
      }
      return hash >>> 0;
    };
    const fmix32 = (n: number): number => {
      let h = n | 0;
      h ^= h >>> 16;
      h = Math.imul(h, 0x85ebca6b);
      h ^= h >>> 13;
      h = Math.imul(h, 0xc2b2ae35);
      h ^= h >>> 16;
      return h >>> 0;
    };
    const fromCounter = (n: number): Uint8Array => {
      const x = fmix32(n);
      return new Uint8Array([(x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff]);
    };

    const seen = new Map<number, number>();
    let pair: [Uint8Array, Uint8Array] | undefined;
    for (let n = 0; n < 1 << 22; n += 1) {
      const candidate = fromCounter(n);
      const hash = fnv(candidate);
      const earlier = seen.get(hash);
      if (earlier !== undefined) {
        pair = [fromCounter(earlier), candidate];
        break;
      }
      seen.set(hash, n);
    }
    expect(pair).toBeDefined();
    const [first, second] = pair!;
    // Sanity: a REAL collision — same hash + same length, different bytes.
    expect(fnv(first)).toBe(fnv(second));
    expect(first).not.toEqual(second);

    const budget = new AssetBudget({ maxTotalBytes: 100 });
    expect(budget.account(first, { filename: "first.bin" }).deduped).toBe(false);
    // Same bucket, different bytes → NOT deduped; counted separately.
    expect(budget.account(second, { filename: "second.bin" }).deduped).toBe(false);
    expect(budget.totalBytes).toBe(8);
    // And a true repeat of either member still dedups within the shared bucket.
    expect(budget.account(first, { filename: "first-again.bin" }).deduped).toBe(true);
    expect(budget.totalBytes).toBe(8);
  });
});
