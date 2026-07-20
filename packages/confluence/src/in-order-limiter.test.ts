import { describe, test, expect } from "bun:test";
import { createInOrderLimiter } from "./in-order-limiter.js";

describe("createInOrderLimiter", () => {
  test("bounds concurrency to the limit", async () => {
    let active = 0;
    let peak = 0;
    const limit = createInOrderLimiter(3);
    await Promise.all(
      Array.from({ length: 9 }, () =>
        limit(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active -= 1;
        })
      )
    );
    expect(peak).toBe(3);
  });

  test("delivers results in issue order despite inverted completion order", async () => {
    const limit = createInOrderLimiter(4);
    const delivered: number[] = [];
    // Later-issued jobs finish first (inverted latency).
    await Promise.all(
      [40, 30, 20, 5].map((ms, index) =>
        limit(async () => {
          await new Promise((r) => setTimeout(r, ms));
          return index;
        }).then((value) => delivered.push(value))
      )
    );
    expect(delivered).toEqual([0, 1, 2, 3]);
  });

  test("propagates a rejection to the issuing caller", async () => {
    const limit = createInOrderLimiter(2);
    await expect(
      limit(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
  });
});
