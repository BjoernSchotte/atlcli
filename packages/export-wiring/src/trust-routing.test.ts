/**
 * Sink-side SSRF enforcement, asserted through the REAL engine seams
 * (`exportDocx` and `preparePdfDocument`) rather than against the router in
 * isolation — the bug class this guards is "the router exists but nothing
 * composes it around the seam", which an isolated unit test cannot see.
 */
import { describe, expect, test } from "bun:test";
import type { ExportBlock } from "@atlcli/confluence";
import { exportDocx, type AssetRef } from "@atlcli/docx";
import { buildDocx, para } from "@atlcli/docx/fixtures";
import { preparePdfDocument, type PdfAssetRef } from "@atlcli/pdf";
import { defaultExternalAssetFetcher, defaultExternalAssetPolicy } from "./asset-policy.js";
import { assertPolicyRoutedPdfAssets } from "./fixtures.js";
import { trustRoutingAssetFetcher, trustRoutingPdfAssetResolver } from "./trust-routing.js";

const BASE = "https://acme.atlassian.net";
const external = defaultExternalAssetFetcher(defaultExternalAssetPolicy(BASE));

describe("trust routing — SSRF enforcement through the real engine seams", () => {
  test("DOCX: export_view-trust loopback image is policy-blocked; page-trust attachment uses the host fetcher", async () => {
    const seen: AssetRef[] = [];
    const hostFetcher = {
      async fetch(ref: AssetRef): Promise<Uint8Array> {
        seen.push(ref);
        // Invalid PNG is fine — routing is what's under test; the embed then
        // degrades to a note without throwing.
        return new Uint8Array([1, 2, 3]);
      },
    };
    const assets = trustRoutingAssetFetcher(hostFetcher, external);
    const blocks: ExportBlock[] = [
      // Untrusted: injected by third-party export_view HTML (SSRF attempt).
      {
        type: "image",
        source: {
          kind: "external",
          url: "http://169.254.169.254/latest/meta-data",
          trust: "export-view",
        },
      },
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
    // The host fetcher saw ONLY the page-trust attachment — never the
    // export_view URL (which the policy rejected inside the external fetcher).
    expect(seen.length).toBe(1);
    expect(seen[0].filename).toBe("a.png");
    expect(seen[0].trust).toBeUndefined();
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
      {
        type: "image",
        source: { kind: "external", url: "http://127.0.0.1/secret.png", trust: "export-view" },
      },
      { type: "image", source: { kind: "attachment", filename: "a.png", pageId: "1" } },
    ];
    const prepared = await preparePdfDocument(blocks, resolver);
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ kind: "attachment", filename: "a.png" });
    expect(prepared.notes.some((n) => /blocked by the export asset policy/.test(n.message))).toBe(
      true
    );
  });

  test("page-trust external image (no trust marker) stays on the host fetcher path", async () => {
    const seen: AssetRef[] = [];
    const hostFetcher = {
      async fetch(ref: AssetRef): Promise<Uint8Array> {
        seen.push(ref);
        return new Uint8Array([1]);
      },
    };
    const assets = trustRoutingAssetFetcher(hostFetcher, external);
    await assets.fetch({ url: "https://any-origin.example.com/x.png", pageId: "1" });
    expect(seen.length).toBe(1);
  });

  test("a cancelled export tears down the in-flight external fetch", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const stallingExternal = {
      async fetch(_url: string, opts: { maxBytes: number; signal?: AbortSignal }) {
        seenSignal = opts.signal;
        return { bytes: new Uint8Array(), mediaType: "image/png" };
      },
    };
    const resolver = trustRoutingPdfAssetResolver(
      { async resolve() { return { bytes: new Uint8Array(), mediaType: "image/png" }; } },
      stallingExternal
    );
    await resolver.resolve(
      { kind: "external", url: `${BASE}/x.png`, trust: "export-view" } as PdfAssetRef,
      { signal: controller.signal }
    );
    expect(seenSignal).toBe(controller.signal);
  });
});

describe("assertPolicyRoutedPdfAssets — the executable form of the wiring rule", () => {
  test("passes for a resolver wrapped in trustRoutingPdfAssetResolver", async () => {
    const wrapped = trustRoutingPdfAssetResolver(
      { async resolve() { return { bytes: new Uint8Array([1]), mediaType: "image/png" }; } },
      external
    );
    await assertPolicyRoutedPdfAssets(wrapped);
  });

  test("fails loudly for an UNWRAPPED resolver — the regression it exists to catch", async () => {
    const unwrapped = {
      async resolve() {
        // The unprotected host resolver: it happily fetches whatever it is told.
        return { bytes: new Uint8Array([1]), mediaType: "image/png" };
      },
    };
    await expect(assertPolicyRoutedPdfAssets(unwrapped)).rejects.toThrow(
      /not wrapped in trustRoutingPdfAssetResolver/
    );
  });

  test("fails when the rejection is a network error rather than a policy block", async () => {
    const attempts = {
      async resolve(): Promise<never> {
        throw new Error("fetch failed: ECONNREFUSED");
      },
    };
    await expect(assertPolicyRoutedPdfAssets(attempts)).rejects.toThrow(
      /NOT with an ExternalAssetBlockedError/
    );
  });
});
