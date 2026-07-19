/**
 * spec 004 host-wiring: external-asset policy + fetcher (SSRF / byte-cap /
 * redirect enforcement) and Jira/Confluence port error classification.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { isPortError } from "@atlcli/export-macros";
import type { JiraClient, JiraIssue } from "@atlcli/jira";
import type { ExportBlock } from "@atlcli/confluence";
import { exportDocx, type AssetRef } from "@atlcli/docx";
import { buildDocx, para } from "@atlcli/docx/fixtures";
import { preparePdfDocument } from "@atlcli/pdf";
import type { PdfAssetRef } from "@atlcli/pdf";
import {
  defaultExternalAssetPolicy,
  defaultExternalAssetFetcher,
  jiraIssuePortFromClient,
  trustRoutingAssetFetcher,
  trustRoutingPdfAssetResolver,
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

describe("trust routing — SSRF enforcement through the real engine seams", () => {
  const policy = defaultExternalAssetPolicy(BASE);
  const external = defaultExternalAssetFetcher(policy);

  test("DOCX: export_view-trust loopback image is policy-blocked; page-trust attachment uses the token fetcher", async () => {
    const seen: AssetRef[] = [];
    const tokenFetcher = {
      async fetch(ref: AssetRef): Promise<Uint8Array> {
        seen.push(ref);
        // Invalid PNG is fine — routing is what's under test; the embed then
        // degrades to a note without throwing.
        return new Uint8Array([1, 2, 3]);
      },
    };
    const assets = trustRoutingAssetFetcher(tokenFetcher, external);
    const blocks: ExportBlock[] = [
      // Untrusted: injected by third-party export_view HTML (SSRF attempt).
      { type: "image", source: { kind: "external", url: "http://169.254.169.254/latest/meta-data", trust: "export-view" } },
      // Trusted: ordinary page attachment.
      { type: "image", source: { kind: "attachment", filename: "a.png", pageId: "1" } },
    ];
    const { report } = await exportDocx({
      templateBytes: buildDocx({ body: para("$scroll.content") }),
      details: { id: "1", title: "T", storage: "", spaceKey: "DOC" },
      template: { name: "t.docx", modificationDate: new Date(0) },
      blocks,
      assets,
    });
    // The token fetcher saw ONLY the page-trust attachment — never the
    // export_view URL (which the policy rejected inside the external fetcher).
    expect(seen.length).toBe(1);
    expect(seen[0].filename).toBe("a.png");
    expect(seen[0].trust).toBeUndefined();
    // The blocked image degraded to a report note, not a fetched byte stream.
    expect(report.notes.some((n) => /blocked by policy/.test(n.message))).toBe(true);
  });

  test("PDF: export_view-trust loopback ref is policy-blocked at the resolver seam; attachment passes through", async () => {
    const seen: PdfAssetRef[] = [];
    const inner = {
      async resolve(ref: PdfAssetRef) {
        seen.push(ref);
        return { bytes: new Uint8Array([137, 80, 78, 71]), mediaType: "image/png" };
      },
    };
    const resolver = trustRoutingPdfAssetResolver(inner, external);
    const blocks: ExportBlock[] = [
      { type: "image", source: { kind: "external", url: "http://127.0.0.1/secret.png", trust: "export-view" } },
      { type: "image", source: { kind: "attachment", filename: "a.png", pageId: "1" } },
    ];
    const prepared = await preparePdfDocument(blocks, resolver);
    // Inner resolver saw only the attachment; the loopback URL was rejected by
    // policy inside the external fetcher and degraded to a skipped image.
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ kind: "attachment", filename: "a.png" });
    expect(prepared.notes.some((n) => /blocked by policy/.test(n.message))).toBe(true);
  });

  test("page-trust external image (no trust marker) stays on the token fetcher path", async () => {
    const seen: AssetRef[] = [];
    const tokenFetcher = {
      async fetch(ref: AssetRef): Promise<Uint8Array> {
        seen.push(ref);
        return new Uint8Array([1]);
      },
    };
    const assets = trustRoutingAssetFetcher(tokenFetcher, external);
    await assets.fetch({ url: "https://any-origin.example.com/x.png", pageId: "1" });
    expect(seen.length).toBe(1);
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
