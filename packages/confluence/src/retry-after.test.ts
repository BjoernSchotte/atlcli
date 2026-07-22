import { describe, expect, test } from "bun:test";
import * as shared from "@atlcli/core/internal";
import { parseRetryAfterMs, RETRY_AFTER_MAX_MS, RETRY_AFTER_MIN_MS } from "./retry-after.js";

/**
 * The seam, not the parser. `parseRetryAfterMs`'s behaviour is covered once, in
 * `packages/core/src/retry-after.test.ts`; duplicating that suite here is what
 * this refactor removed. What still needs proving locally is that `client.ts`'s
 * `./retry-after.js` import reaches the SHARED implementation — a shim that
 * silently forked again would be invisible to the core suite.
 */
describe("confluence retry-after seam", () => {
  test("re-exports the shared parser itself, not a copy", () => {
    expect(parseRetryAfterMs).toBe(shared.parseRetryAfterMs);
    expect(RETRY_AFTER_MIN_MS).toBe(shared.RETRY_AFTER_MIN_MS);
    expect(RETRY_AFTER_MAX_MS).toBe(shared.RETRY_AFTER_MAX_MS);
  });

  test("the bounded parse the client depends on still holds through the seam", () => {
    expect(parseRetryAfterMs("5")).toBe(5_000);
    expect(parseRetryAfterMs("0")).toBe(RETRY_AFTER_MIN_MS);
    expect(parseRetryAfterMs("99999999")).toBe(RETRY_AFTER_MAX_MS);
    expect(parseRetryAfterMs("unavailable")).toBeUndefined();
    expect(parseRetryAfterMs("-1")).toBeUndefined();
  });
});
