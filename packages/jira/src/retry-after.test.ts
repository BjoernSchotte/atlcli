import { describe, expect, test } from "bun:test";
import * as shared from "@atlcli/core/internal";
import { parseRetryAfterMs, RETRY_AFTER_MAX_MS, RETRY_AFTER_MIN_MS } from "./retry-after.js";

/**
 * The seam, not the parser — see `packages/confluence/src/retry-after.test.ts`
 * for the same reasoning. Behaviour is covered once, in
 * `packages/core/src/retry-after.test.ts`.
 */
describe("jira retry-after seam", () => {
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
