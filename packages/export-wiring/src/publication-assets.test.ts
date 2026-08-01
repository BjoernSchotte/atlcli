import { describe, expect, test } from "bun:test";
import type { ExternalAssetFetcher } from "@atlcli/export-macros";
import type { PublicationAssetPolicyV1 } from "@atlcli/web-publish";
import {
  fetchAndMaterializePublicationAssetV1,
  PublicationAssetMaterializationErrorV1,
} from "./publication-assets.js";

const policy: PublicationAssetPolicyV1 = {
  selfContained: true,
  external: "same-origin-only",
  allowedOrigins: [],
  activeContent: "block",
  maxAssetBytes: 1_024,
  maxTotalBytes: 4_096,
  maxImagePixels: 10_000,
  maxSvgNodes: 8,
};

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const safeSvg = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10"/></svg>',
);

describe("publication asset materialization", () => {
  test("uses the source-specific fetch port and persists only a validated static asset", async () => {
    const attachmentCalls: unknown[] = [];
    const result = await fetchAndMaterializePublicationAssetV1({
      assetId: "diagram-1",
      source: { kind: "attachment", pageId: "page-42", filename: "Architecture diagram.svg" },
    }, policy, {
      attachmentPort: {
        async fetchAttachment(request) {
          attachmentCalls.push(request);
          return { bytes: safeSvg, mediaType: "image/svg+xml" };
        },
      },
    });

    expect(attachmentCalls).toEqual([{
      pageId: "page-42",
      filename: "Architecture diagram.svg",
      maxBytes: 1_024,
    }]);
    expect(result.entry).toMatchObject({
      assetId: "diagram-1",
      mediaType: "image/svg+xml",
      disposition: "inline",
      byteLength: safeSvg.byteLength,
    });
    expect(result.entry.path).toMatch(/^assets\/[a-f0-9]{64}\/Architecture-diagram\.svg$/u);
    expect(JSON.stringify(result)).not.toContain("page-42");
  });

  test("delegates external acquisition to the policy-wrapped fetcher and never persists its URL", async () => {
    const calls: unknown[] = [];
    const externalFetcher: ExternalAssetFetcher = {
      async fetch(url, options) {
        calls.push({ url, options });
        return { bytes: png(20, 10), mediaType: "image/png" };
      },
    };
    const url = "https://macro-assets.example.test/chart.png?token=private";
    const result = await fetchAndMaterializePublicationAssetV1({
      assetId: "chart-1",
      source: { kind: "external", url, filename: "chart.png" },
    }, policy, { externalFetcher });

    expect(calls).toEqual([{ url, options: { maxBytes: 1_024 } }]);
    expect(result.entry.path).toMatch(/^assets\/[a-f0-9]{64}\/chart\.png$/u);
    expect(JSON.stringify(result)).not.toContain("macro-assets.example.test");
    expect(JSON.stringify(result)).not.toContain("token");
  });

  test("rejects MIME lies, active SVG, SVG node bombs, and oversized raster dimensions", async () => {
    const attach = (bytes: Uint8Array, mediaType?: string) => ({
      attachmentPort: { async fetchAttachment() { return { bytes, ...(mediaType === undefined ? {} : { mediaType }) }; } },
    });
    const request = { assetId: "asset-1", source: { kind: "attachment" as const, pageId: "page", filename: "asset.svg" } };

    await expect(fetchAndMaterializePublicationAssetV1(request, policy, attach(png(1, 1), "image/svg+xml")))
      .rejects.toMatchObject({ code: "mime-mismatch" });
    await expect(fetchAndMaterializePublicationAssetV1(
      request,
      policy,
      attach(new TextEncoder().encode('<svg width="1" height="1"><script/></svg>'), "image/svg+xml"),
    )).rejects.toMatchObject({ code: "unsafe-svg" });
    await expect(fetchAndMaterializePublicationAssetV1(
      request,
      { ...policy, maxSvgNodes: 1 },
      attach(safeSvg, "image/svg+xml"),
    )).rejects.toMatchObject({ code: "svg-node-budget" });
    await expect(fetchAndMaterializePublicationAssetV1(
      { ...request, source: { kind: "attachment", pageId: "page", filename: "asset.png" } },
      policy,
      attach(png(101, 100), "image/png"),
    )).rejects.toBeInstanceOf(PublicationAssetMaterializationErrorV1);
  });
});
