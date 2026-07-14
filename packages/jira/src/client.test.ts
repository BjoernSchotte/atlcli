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
