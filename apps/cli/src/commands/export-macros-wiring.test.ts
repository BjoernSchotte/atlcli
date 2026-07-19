/**
 * spec 004 host-wiring: external-asset policy + fetcher (SSRF / byte-cap /
 * redirect enforcement) and Jira/Confluence port error classification.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { isPortError } from "@atlcli/export-macros";
import type { JiraClient, JiraIssue } from "@atlcli/jira";
import {
  defaultExternalAssetPolicy,
  defaultExternalAssetFetcher,
  jiraIssuePortFromClient,
} from "./export-macros-wiring.js";

const BASE = "https://acme.atlassian.net";
const originalFetch = globalThis.fetch;

describe("defaultExternalAssetPolicy", () => {
  const policy = defaultExternalAssetPolicy(BASE);

  test("relative URLs (same-origin by construction) allowed", () => {
    expect(policy.allow("/wiki/download/x.png")).toBe(true);
  });
  test("same-origin absolute allowed", () => {
    expect(policy.allow(`${BASE}/img.png`)).toBe(true);
  });
  test("different origin rejected", () => {
    expect(policy.allow("https://evil.example.com/x.png")).toBe(false);
  });
  test("disallowed schemes rejected", () => {
    expect(policy.allow("file:///etc/passwd")).toBe(false);
    expect(policy.allow("javascript:alert(1)")).toBe(false);
  });
  test("loopback / private / link-local rejected", () => {
    expect(policy.allow("http://localhost/x")).toBe(false);
    expect(policy.allow("http://127.0.0.1/x")).toBe(false);
    expect(policy.allow("http://10.0.0.5/x")).toBe(false);
    expect(policy.allow("http://192.168.1.1/x")).toBe(false);
    expect(policy.allow("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(policy.allow("http://172.16.0.1/x")).toBe(false);
  });
});

describe("defaultExternalAssetFetcher", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("rejects a redirect chain that ends at a disallowed origin (on the hop)", async () => {
    const policy = defaultExternalAssetPolicy(BASE);
    const fetcher = defaultExternalAssetFetcher(policy);
    globalThis.fetch = (async (url: string) => {
      if (url.startsWith(BASE)) {
        return new Response(null, { status: 302, headers: { location: "https://evil.example.com/x.png" } });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(fetcher.fetch(`${BASE}/start.png`, { maxBytes: 1000 })).rejects.toThrow(/blocked by policy/);
  });

  test("caps oversized responses via the stream (before full buffer)", async () => {
    const policy = defaultExternalAssetPolicy(BASE);
    const fetcher = defaultExternalAssetFetcher(policy);
    const big = new Uint8Array(5000);
    globalThis.fetch = (async () =>
      new Response(big, { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    await expect(fetcher.fetch(`${BASE}/big.png`, { maxBytes: 1000 })).rejects.toThrow(/exceeded 1000 bytes/);
  });

  test("returns bytes for an allowed same-origin URL", async () => {
    const policy = defaultExternalAssetPolicy(BASE);
    const fetcher = defaultExternalAssetFetcher(policy);
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "image/png" },
      })) as unknown as typeof fetch;
    const result = await fetcher.fetch(`${BASE}/ok.png`, { maxBytes: 1000 });
    expect(result.bytes.byteLength).toBe(4);
    expect(result.mediaType).toBe("image/png");
  });
});

describe("jiraIssuePortFromClient error classification", () => {
  function fakeClient(err: Error): JiraClient {
    return {
      async getIssue(): Promise<JiraIssue> {
        throw err;
      },
      async search() {
        throw err;
      },
    } as unknown as JiraClient;
  }

  test("403 → permission PortError", async () => {
    const port = jiraIssuePortFromClient(fakeClient(new Error("Jira API error (403): forbidden")), BASE);
    try {
      await port.getIssue("ATL-1");
      throw new Error("expected throw");
    } catch (e) {
      expect(isPortError(e)).toBe(true);
      expect((e as { kind: string }).kind).toBe("permission");
    }
  });

  test("404 → not-found; 429 → rate-limited; other → network", async () => {
    const mk = (msg: string) => jiraIssuePortFromClient(fakeClient(new Error(msg)), BASE);
    const kindOf = async (p: ReturnType<typeof mk>) => {
      try {
        await p.getIssue("X");
        return "none";
      } catch (e) {
        return (e as { kind: string }).kind;
      }
    };
    expect(await kindOf(mk("Jira API error (404): gone"))).toBe("not-found");
    expect(await kindOf(mk("Jira API error (429): slow down"))).toBe("rate-limited");
    expect(await kindOf(mk("Jira API error (500): boom"))).toBe("network");
  });

  test("maps issue to a ref with a browse URL", async () => {
    const client = {
      async getIssue(): Promise<JiraIssue> {
        return {
          id: "1",
          key: "ATL-9",
          self: "https://api/rest/issue/1",
          fields: { summary: "Hi", status: { id: "1", name: "Done", statusCategory: { id: 3, key: "done", name: "Done", colorName: "green" } } },
        } as unknown as JiraIssue;
      },
    } as unknown as JiraClient;
    const port = jiraIssuePortFromClient(client, BASE);
    const ref = await port.getIssue("ATL-9");
    expect(ref.url).toBe(`${BASE}/browse/ATL-9`);
    expect(ref.statusColor).toBe("green");
  });
});
