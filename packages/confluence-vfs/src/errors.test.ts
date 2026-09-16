import { describe, expect, it } from "bun:test";
import {
  httpStatusOf,
  mapClientError,
  retryAfterMsOf,
  withRateLimitRetry,
} from "./errors.js";
import { FakeHttpError } from "./testing/fake-client.js";
import { VfsError } from "./types.js";

describe("httpStatusOf", () => {
  it("reads a status property", () => {
    expect(httpStatusOf(new FakeHttpError(404, "gone"))).toBe(404);
  });

  it("falls back to the status embedded in the client's message", () => {
    // The client's error classes are module-private, so this shape is the only
    // thing we can rely on for errors that cross a bundle boundary.
    expect(httpStatusOf(new Error("Confluence API error (403): forbidden"))).toBe(403);
    expect(httpStatusOf(new Error("Confluence API v2 error (409): conflict"))).toBe(409);
  });

  it("returns undefined for anything without a status", () => {
    expect(httpStatusOf(new Error("socket hang up"))).toBeUndefined();
    expect(httpStatusOf("nope")).toBeUndefined();
    expect(httpStatusOf(null)).toBeUndefined();
  });

  it("ignores an out-of-range number", () => {
    expect(httpStatusOf({ status: 99 })).toBeUndefined();
    expect(httpStatusOf({ status: 600 })).toBeUndefined();
  });
});

describe("mapClientError", () => {
  const cases: [number, string][] = [
    [400, "EINVAL"],
    [401, "EACCES"],
    [403, "EACCES"],
    [404, "ENOENT"],
    [405, "EROFS"],
    [409, "EBUSY"],
    [413, "ENOSPC"],
    [429, "EAGAIN"],
    [507, "ENOSPC"],
  ];

  for (const [status, code] of cases) {
    it(`maps ${status} to ${code}`, () => {
      const mapped = mapClientError(new FakeHttpError(status, "boom"), "/DOCSY/a-1.md");
      expect(mapped).toBeInstanceOf(VfsError);
      expect(mapped.code).toBe(code as VfsError["code"]);
      expect(mapped.status).toBe(status);
      expect(mapped.path).toBe("/DOCSY/a-1.md");
    });
  }

  it("maps 5xx to EAGAIN and says the request was already retried", () => {
    const mapped = mapClientError(new FakeHttpError(503, "unavailable"));
    expect(mapped.code).toBe("EAGAIN");
    expect(mapped.message).toContain("retried");
  });

  it("names the wait and the remedy for 429", () => {
    const mapped = mapClientError(new FakeHttpError(429, "slow down", 4000));
    expect(mapped.message).toContain("Retry after 4 s");
    expect(mapped.message).toContain("--concurrency");
  });

  it("tells the user how to re-authenticate on 401", () => {
    expect(mapClientError(new FakeHttpError(401, "nope")).message).toContain("atlcli auth login");
  });

  it("passes a VfsError through untouched, so nested calls keep their code", () => {
    const original = new VfsError("EROFS", "read-only");
    expect(mapClientError(original)).toBe(original);
  });

  it("falls back to EINVAL when nothing carries a status", () => {
    const mapped = mapClientError(new Error("socket hang up"), "/DOCSY");
    expect(mapped.code).toBe("EINVAL");
    expect(mapped.message).toContain("socket hang up");
  });
});

describe("retryAfterMsOf", () => {
  it("reads a numeric retryAfterMs", () => {
    expect(retryAfterMsOf(new FakeHttpError(429, "x", 1500))).toBe(1500);
  });

  it("parses a header-shaped retryAfter", () => {
    expect(retryAfterMsOf({ retryAfter: "2" })).toBe(2000);
  });

  it("returns undefined when absent", () => {
    expect(retryAfterMsOf(new FakeHttpError(429, "x"))).toBeUndefined();
  });
});

describe("withRateLimitRetry", () => {
  it("returns the value when the task succeeds", async () => {
    expect(await withRateLimitRetry(async () => 42)).toBe(42);
  });

  it("retries a 429 and honours Retry-After", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const value = await withRateLimitRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new FakeHttpError(429, "slow down", 250);
        return "ok";
      },
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(value).toBe("ok");
    expect(attempts).toBe(3);
    expect(waits).toEqual([250, 250]);
  });

  it("gives up after the retry budget and surfaces EAGAIN", async () => {
    let attempts = 0;
    const promise = withRateLimitRetry(
      async () => {
        attempts += 1;
        throw new FakeHttpError(429, "slow down", 10);
      },
      { retries: 1, sleep: async () => {} },
    );
    await expect(promise).rejects.toMatchObject({ code: "EAGAIN" });
    expect(attempts).toBe(2);
  });

  it("never retries a status other than 429", async () => {
    let attempts = 0;
    const promise = withRateLimitRetry(async () => {
      attempts += 1;
      throw new FakeHttpError(404, "gone");
    });
    await expect(promise).rejects.toMatchObject({ code: "ENOENT" });
    expect(attempts).toBe(1);
  });

  it("jitters when the server sent no Retry-After, and stays within the band", async () => {
    const waits: number[] = [];
    await withRateLimitRetry(
      (() => {
        let attempts = 0;
        return async () => {
          attempts += 1;
          if (attempts === 1) throw new FakeHttpError(429, "slow down");
          return "ok";
        };
      })(),
      { baseDelayMs: 1000, sleep: async (ms) => void waits.push(ms) },
    );
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(500);
    expect(waits[0]).toBeLessThanOrEqual(1000);
  });

  it("reports each wait so a frontend can warn about long ones", async () => {
    const seen: number[] = [];
    let attempts = 0;
    await withRateLimitRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new FakeHttpError(429, "slow down", 6000);
        return "ok";
      },
      { sleep: async () => {}, onWait: (ms) => seen.push(ms) },
    );
    expect(seen).toEqual([6000]);
  });
});
