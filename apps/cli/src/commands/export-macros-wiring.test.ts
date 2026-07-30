/**
 * spec 004 host-wiring, as the CLI sees it after the spec 010 promotion.
 *
 * The implementation now lives in `@atlcli/export-wiring`; this file stays the
 * CLI-facing regression contract for it — same import specifier, same behaviour
 * through the real DOCX/PDF seams — plus explicit coverage of the places where
 * the shared policy is deliberately STRONGER than the CLI's own copy was.
 */
import { describe, expect, test, afterEach } from "bun:test";
import {
  isPortError,
  resolveMacroBlocks,
  type MacroExportContext,
} from "@atlcli/export-macros";
import type { Profile } from "@atlcli/core";
import type { JiraClient, JiraIssue } from "@atlcli/jira";
import {
  adfToBlocks,
  type ExportBlock,
} from "@atlcli/confluence";
import { exportDocx, type AssetRef } from "@atlcli/docx";
import { buildDocx, para } from "@atlcli/docx/fixtures";
import { preparePdfDocument } from "@atlcli/pdf";
import type { PdfAssetRef } from "@atlcli/pdf";
import type { ConfluenceClient } from "@atlcli/confluence";
import {
  buildMacroResolutionOptions,
  confluenceContentPortFromClient,
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
    await expect(fetcher.fetch(`${BASE}/start.png`, { maxBytes: 1000 })).rejects.toThrow(/blocked by the export asset policy/);
  });

  test("caps oversized responses via the stream (before full buffer)", async () => {
    const policy = defaultExternalAssetPolicy(BASE);
    const fetcher = defaultExternalAssetFetcher(policy);
    const big = new Uint8Array(5000);
    globalThis.fetch = (async () =>
      new Response(big, { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    await expect(fetcher.fetch(`${BASE}/big.png`, { maxBytes: 1000 })).rejects.toThrow(/exceeded the 1000-byte export limit/);
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
    expect(report.notes.some((n) => /blocked by the export asset policy/.test(n.message))).toBe(true);
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
    expect(prepared.notes.some((n) => /blocked by the export asset policy/.test(n.message))).toBe(true);
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

describe("confluenceContentPortFromClient — children port method pinning", () => {
  test("getChildren uses the child-page endpoint (getChildrenWithPosition), never the CQL lookup", async () => {
    // Pin the client method: the CQL-based client.getChildren lags behind
    // fresh page creation (e2e-observed: a new child page was missing on the
    // first export, present on retry) and has no position guarantee. The port
    // MUST use getChildrenWithPosition (v2 child-page endpoint, real UI order,
    // no indexing lag).
    const calls: string[] = [];
    const fake = {
      async getChildrenWithPosition(parentId: string, opts?: { limit?: number }) {
        calls.push(`getChildrenWithPosition:${parentId}:${opts?.limit}`);
        return [
          { id: "2", title: "Beta", position: 1 },
          { id: "1", title: "Alpha", position: 0 },
        ];
      },
      async getChildren() {
        calls.push("getChildren");
        return [];
      },
    } as unknown as ConfluenceClient;

    const port = confluenceContentPortFromClient(fake);
    const children = await port.getChildren("42", { limit: 51 });

    expect(calls).toEqual(["getChildrenWithPosition:42:51"]);
    expect(children).toEqual([
      { id: "2", title: "Beta" },
      { id: "1", title: "Alpha" },
    ]);
  });

  test("port cap slices a fully-drained listing to the requested limit", async () => {
    const many = Array.from({ length: 10 }, (_v, i) => ({ id: `${i}`, title: `P${i}`, position: i }));
    const fake = {
      async getChildrenWithPosition() {
        return many;
      },
    } as unknown as ConfluenceClient;
    const port = confluenceContentPortFromClient(fake);
    const children = await port.getChildren("42", { limit: 3 });
    expect(children.length).toBe(3);
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

describe("buildMacroResolutionOptions — the CLI's half of the shared builder", () => {
  const profile = { name: "p", baseUrl: BASE, email: "e@x", token: "t" } as unknown as Profile;
  const confluence = {
    async getPage() {
      return { id: "1", version: 1, storage: "" };
    },
  } as unknown as ConfluenceClient;

  test("maps profile.baseUrl onto the site identity, the browse links and the policy origin", async () => {
    const jira = {
      async getIssue(): Promise<JiraIssue> {
        return { id: "1", key: "ATL-3", self: "", fields: { summary: "S" } } as unknown as JiraIssue;
      },
      async search() {
        return { issues: [] };
      },
    } as unknown as JiraClient;

    const options = buildMacroResolutionOptions({
      profile,
      confluence,
      jira,
      targetEngine: "docx",
      live: true,
    });
    const ctx: MacroExportContext = options.contextFor!({ id: "9", spaceKey: "DOC" });

    expect(ctx.siteId).toBe(BASE);
    expect(ctx.siteOrigin).toBe(BASE);
    expect(ctx.flags?.targetEngine).toBe("docx");
    expect(options.live).toBe(true);
    expect((await ctx.jira!.getIssue("ATL-3")).url).toBe(`${BASE}/browse/ATL-3`);
    // Same-origin-only, exactly as before the promotion: the CLI passes no
    // extra origins, and the shared package adds none of its own.
    await expect(
      ctx.externalAssets!.fetch("https://api.media.atlassian.com/file/a/binary", { maxBytes: 10 })
    ).rejects.toThrow(/blocked by the export asset policy/);
  });

  test("resolves an embedded Whiteboard offline without calling Confluence", async () => {
    const calls: string[] = [];
    const noRequestConfluence = {
      async getPage() {
        calls.push("getPage");
        throw new Error("The pure Whiteboard renderer must not fetch");
      },
      async getChildrenWithPosition() {
        calls.push("getChildrenWithPosition");
        throw new Error("The pure Whiteboard renderer must not fetch");
      },
      async getAttachments() {
        calls.push("getAttachments");
        throw new Error("The pure Whiteboard renderer must not fetch");
      },
    } as unknown as ConfluenceClient;
    const options = buildMacroResolutionOptions({
      profile,
      confluence: noRequestConfluence,
      targetEngine: "docx",
      live: false,
    });
    const page = { id: "9", version: 1, spaceKey: "DOC" };
    const decoded = adfToBlocks({
      version: 1,
      type: "doc",
      content: [{
        type: "extension",
        attrs: {
          extensionType: "com.atlassian.confluence.macro.core",
          extensionKey: "native-embed:whiteboard",
          parameters: {
            macroParams: {
              url: {
                value:
                  `${BASE}/wiki/spaces/DOC/whiteboard/41?source=cli`,
              },
            },
          },
        },
      }],
    }, { pageContext: page });

    const result = await resolveMacroBlocks(
      decoded,
      options.registry,
      options.contextFor(page),
      {
        live: false,
        contextFor: (source) => options.contextFor(source ?? page),
        targetEngine: "docx",
      },
    );

    expect(calls).toEqual([]);
    expect(result.blocks).toEqual([{
      type: "smartCard",
      card: {
        appearance: "block",
        source: "url",
        url: `${BASE}/wiki/spaces/DOC/whiteboard/41`,
        target: {
          kind: "external",
          href: `${BASE}/wiki/spaces/DOC/whiteboard/41`,
        },
        title: "Atlassian Whiteboard",
      },
    }]);
    expect(result.notes.map((note) => note.code)).toEqual([
      "macro-rendered-via",
    ]);
  });

  test("contextFor builds from the page it is handed, never a remembered root", () => {
    const options = buildMacroResolutionOptions({ profile, confluence, targetEngine: "docx" });
    expect(options.contextFor!({ id: "100", spaceKey: "D" }).page.id).toBe("100");
    expect(options.contextFor!({ id: "200", spaceKey: "D" }).page.id).toBe("200");
  });

  test("forwards the job cancellation signal into every macro context", () => {
    const controller = new AbortController();
    const options = buildMacroResolutionOptions({
      profile,
      confluence,
      targetEngine: "docx",
      signal: controller.signal,
    });

    expect(options.contextFor!({ id: "100", spaceKey: "D" }).signal).toBe(
      controller.signal,
    );
    expect(options.contextFor!({ id: "200", spaceKey: "D" }).signal).toBe(
      controller.signal,
    );
  });
});

/**
 * Deliberate CLI behaviour CHANGES (spec 010 W2-0). The CLI's own policy was
 * weaker than the extension's in each of these; the shared one takes the
 * stronger behaviour, so these are the regression pins for the upgrade.
 */
describe("policy upgrades the CLI inherited from the shared implementation", () => {
  const policy = defaultExternalAssetPolicy(BASE);

  test("rejects credentials embedded in the URL, even on the site's own origin", () => {
    expect(policy.allow(`https://user:secret@acme.atlassian.net/img.png`)).toBe(false);
  });

  test("rejects private targets spelled as IPv6 that the old dotted-quad regex missed", () => {
    // WHATWG URL canonicalizes `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so the
    // old `/^127\./` test never saw a dotted quad at all.
    for (const url of [
      "http://[::ffff:7f00:1]/x.png",
      "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
      "http://[::]:8080/x.png",
      "http://[fd00:ec2::254]/latest/meta-data/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://100.64.0.1/x.png",
      "http://0.0.0.0/x.png",
      "http://intranet/x.png",
    ]) {
      expect(policy.allow(url), url).toBe(false);
    }
  });

  test("keeps signed media tokens out of the report note", async () => {
    const fetcher = defaultExternalAssetFetcher(policy);
    const error = await fetcher
      .fetch("https://evil.example.com/chart.png?token=SUPERSECRET", { maxBytes: 10 })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect((error as Error).message).not.toContain("SUPERSECRET");
  });

  test(
    "bounds a stalled body on wall-clock time, which the CLI's fetcher never did",
    async () => {
      const stalled = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
        }),
        { status: 200 }
      );
      globalThis.fetch = (async () => stalled) as unknown as typeof fetch;
      const fetcher = defaultExternalAssetFetcher(policy, { timeoutMs: 25 });
      await expect(fetcher.fetch(`${BASE}/stall.png`, { maxBytes: 1024 })).rejects.toThrow(
        /timed out after 25 ms/
      );
      globalThis.fetch = originalFetch;
    },
    2_000
  );
});
