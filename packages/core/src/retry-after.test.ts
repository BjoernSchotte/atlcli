import { describe, test, expect } from "bun:test";
import {
  parseRetryAfterMs,
  RETRY_AFTER_MAX_MS,
  RETRY_AFTER_MIN_MS,
} from "./retry-after.js";

/**
 * `Retry-After` parsing (spec 010 wave-1 review, B6) — the single owner.
 *
 * This suite used to exist twice, byte-identical, under `packages/confluence`
 * and `packages/jira`, because the parser did. Both are now one-line re-exports
 * of this module, so the substantive coverage lives here and each package keeps
 * a short test proving its seam still resolves to this parser.
 *
 * The header is chosen by the SERVER, so every one of these is a value a
 * rate-limited client can actually be handed. The pre-fix
 * `parseInt(header, 10) * 1000` turned three of them into either an immediate
 * retry storm against the endpoint that just said "slow down", or a wait long
 * enough to look like a hang.
 */
describe("parseRetryAfterMs", () => {
  const NOW = Date.parse("Sun, 06 Nov 1994 08:49:37 GMT");

  test("reads a plain delta-seconds value", () => {
    expect(parseRetryAfterMs("5")).toBe(5_000);
    expect(parseRetryAfterMs(" 30 ")).toBe(30_000);
  });

  test("ignores a header that is not a delay, rather than inventing one", () => {
    // parseInt() read each of these as a number and produced a delay from a
    // header it did not understand.
    for (const header of ["", "   ", "unavailable", "soon", "5 minutes", "1e9", "0x10", "NaN"]) {
      expect(parseRetryAfterMs(header)).toBeUndefined();
    }
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
  });

  test("never yields an immediate retry", () => {
    // parseInt("-1") * 1000 === -1000, and setTimeout() treats every one of
    // these as "fire on the next tick".
    expect(parseRetryAfterMs("0")).toBe(RETRY_AFTER_MIN_MS);
    expect(parseRetryAfterMs("-1")).toBeUndefined();
    expect(parseRetryAfterMs("-999")).toBeUndefined();
    for (const header of ["0", "-1", "-999", "abc", ""]) {
      const delay = parseRetryAfterMs(header);
      expect(delay === undefined || delay >= RETRY_AFTER_MIN_MS).toBe(true);
    }
  });

  test("never yields a pathological wait", () => {
    // parseInt("99999999") * 1000 is ~3 years of setTimeout.
    expect(parseRetryAfterMs("99999999")).toBe(RETRY_AFTER_MAX_MS);
    expect(parseRetryAfterMs("9".repeat(30))).toBe(RETRY_AFTER_MAX_MS);
    expect(parseRetryAfterMs(String(Number.MAX_SAFE_INTEGER))).toBe(RETRY_AFTER_MAX_MS);
  });

  test("every accepted value lands inside the bounded range", () => {
    const headers = [
      "0", "1", "5", "60", "61", "3600", "99999999", "-1", "abc", "",
      "Sun, 06 Nov 1994 08:49:47 GMT", "Sun, 06 Nov 1994 08:49:27 GMT",
      "Sun, 06 Nov 2094 08:49:37 GMT", "Sun, 06 Nov 1894 08:49:37 GMT",
    ];
    for (const header of headers) {
      const delay = parseRetryAfterMs(header, { now: NOW });
      if (delay === undefined) continue;
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(RETRY_AFTER_MIN_MS);
      expect(delay).toBeLessThanOrEqual(RETRY_AFTER_MAX_MS);
    }
  });

  test("supports the RFC 9110 HTTP-date form, clamped the same way", () => {
    expect(parseRetryAfterMs("Sun, 06 Nov 1994 08:49:47 GMT", { now: NOW })).toBe(10_000);
    // A date already in the past must not become an immediate retry.
    expect(parseRetryAfterMs("Sun, 06 Nov 1894 08:49:37 GMT", { now: NOW })).toBe(
      RETRY_AFTER_MIN_MS
    );
    // ...and a date far in the future must not become a pathological wait.
    expect(parseRetryAfterMs("Sun, 06 Nov 2094 08:49:37 GMT", { now: NOW })).toBe(
      RETRY_AFTER_MAX_MS
    );
    expect(parseRetryAfterMs("Not, A Real Date GMT", { now: NOW })).toBeUndefined();
  });

  test("does not mistake a bare negative number for a date", () => {
    // The guard that makes this work: Date.parse("-1") is NOT NaN, it is a date
    // in 2001. Routing "-1" down the date branch would clamp it to a retry
    // floor instead of rejecting it outright.
    expect(Number.isNaN(Date.parse("-1"))).toBe(false);
    expect(parseRetryAfterMs("-1")).toBeUndefined();
  });
});
