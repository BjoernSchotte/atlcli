import { describe, test, expect, mock, afterEach } from "bun:test";
import type { Profile } from "@atlcli/core";
import { JiraClient } from "./client.js";

const mockProfile: Profile = {
  name: "test",
  baseUrl: "https://test.atlassian.net",
  auth: {
    type: "apiToken",
    email: "test@example.com",
    token: "test-token",
  },
};

const originalFetch = globalThis.fetch;

describe("JiraClient TLS options", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("omits the tls field on fetch when the profile has no TLS config", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock((_url: string, options: RequestInit) => {
      capturedInit = options;
      return Promise.resolve(
        new Response(JSON.stringify({ id: "1", key: "TEST-1", fields: {} }), { status: 200 })
      );
    }) as unknown as typeof fetch;

    const client = new JiraClient(mockProfile);
    await client.getIssue("TEST-1");

    expect(capturedInit).toBeDefined();
    expect("tls" in (capturedInit as Record<string, unknown>)).toBe(false);
  });

  test("passes tls options on fetch when the profile skips verification", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock((_url: string, options: RequestInit) => {
      capturedInit = options;
      return Promise.resolve(
        new Response(JSON.stringify({ id: "1", key: "TEST-1", fields: {} }), { status: 200 })
      );
    }) as unknown as typeof fetch;

    const client = new JiraClient({ ...mockProfile, tlsSkipVerify: true });
    await client.getIssue("TEST-1");

    const tls = (capturedInit as unknown as { tls?: { rejectUnauthorized?: boolean } }).tls;
    expect(tls).toBeDefined();
    expect(tls?.rejectUnauthorized).toBe(false);
  });
});

describe("JiraClient session auth mode (spec 001 task 5)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const sessionProfile: Profile = {
    name: "session",
    baseUrl: "https://test.atlassian.net",
    auth: { type: "session" },
  };

  function captureFetch(response: () => Response): { last: () => RequestInit | undefined } {
    let last: RequestInit | undefined;
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      last = init;
      return Promise.resolve(response());
    }) as unknown as typeof fetch;
    return { last: () => last };
  }

  const issueResponse = () =>
    new Response(JSON.stringify({ id: "1", key: "TEST-1", fields: {} }), { status: 200 });

  test("issue read (getIssue): no Authorization header, credentials include", async () => {
    const cap = captureFetch(issueResponse);
    await new JiraClient(sessionProfile).getIssue("TEST-1");
    const init = cap.last();
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    expect(init?.credentials).toBe("include");
  });

  test("search: no Authorization header, credentials include", async () => {
    const cap = captureFetch(() =>
      new Response(JSON.stringify({ issues: [], total: 0 }), { status: 200 })
    );
    await new JiraClient(sessionProfile).search("project = TEST");
    const init = cap.last();
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    expect(init?.credentials).toBe("include");
  });

  test("attachment upload: no Authorization header, credentials include", async () => {
    const cap = captureFetch(() =>
      new Response(JSON.stringify([{ id: "10", filename: "f.png" }]), { status: 200 })
    );
    await new JiraClient(sessionProfile).uploadAttachment(
      "TEST-1",
      "f.png",
      Buffer.from([1, 2, 3])
    );
    const init = cap.last();
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    expect(init?.credentials).toBe("include");
  });

  test("attachment download: no Authorization header, credentials include", async () => {
    const cap = captureFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    await new JiraClient(sessionProfile).downloadAttachment(
      "https://test.atlassian.net/rest/api/3/attachment/content/10"
    );
    const init = cap.last();
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    expect(init?.credentials).toBe("include");
  });

  test("regression: non-session profile keeps Authorization and leaves credentials unset", async () => {
    const cap = captureFetch(issueResponse);
    await new JiraClient(mockProfile).getIssue("TEST-1");
    const init = cap.last();
    expect(new Headers(init?.headers).get("Authorization")).toMatch(/^Basic /);
    expect(init?.credentials).toBeUndefined();
  });
});

describe("JiraClient 429 retry delay is bounded (spec 010 wave-1 review, B6)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("does not retry immediately when Retry-After is unparseable", async () => {
    // Proves the clamp is WIRED INTO the request loop, not merely exported:
    // `parseInt("unavailable", 10) * 1000` is NaN, and `setTimeout(fn, NaN)`
    // fires on the next tick, so the client used to answer a 429 with an
    // instant second request.
    const timestamps: number[] = [];
    let callCount = 0;
    globalThis.fetch = mock(() => {
      timestamps.push(Date.now());
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          new Response("Rate limited", {
            status: 429,
            headers: { "Retry-After": "unavailable" },
          })
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ id: "1", key: "TEST-1", fields: {} }), { status: 200 })
      );
    }) as unknown as typeof fetch;

    const client = new JiraClient(mockProfile);
    await client.getIssue("TEST-1");

    expect(callCount).toBe(2);
    // Fell back to the 1 s exponential base rather than to NaN.
    expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(500);
  });
});
