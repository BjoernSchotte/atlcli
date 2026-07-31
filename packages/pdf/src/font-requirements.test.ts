import { describe, expect, it } from "bun:test";
import type { PreparedPdfBlock, PreparedPdfDocument } from "./types.js";
import { PDF_RUNTIME_ASSETS } from "./runtime-assets.js";
import { serializePdfDocument } from "./serialize.js";
import {
  assertResolvedPdfFontRequirementsV1,
  resolveFullPdfFontRequirementsV1,
} from "./font-requirements.js";

const metadata = {
  title: "Font requirement proof",
  exportedAt: new Date("2026-07-30T00:00:00.000Z"),
};

function resolve(blocks: PreparedPdfBlock[]) {
  const document: PreparedPdfDocument = { blocks, assets: [], notes: [] };
  return serializePdfDocument(document, {
    metadata,
    settings: { cover: false, outline: false },
  }).fontRequirements!;
}

function fileNames(blocks: PreparedPdfBlock[]): string[] {
  return resolve(blocks).assets.map((asset) => asset.fileName!);
}

describe("resolved PDF font requirements v1", () => {
  it("keeps an ordinary prose export below the canonical 12-font bundle", () => {
    const requirements = resolve([
      {
        type: "heading",
        level: 1,
        content: [{ type: "text", text: "Plain heading" }],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "Plain body" }],
      },
    ]);

    expect(requirements.assets.map((asset) => asset.fileName)).toEqual([
      "SourceSans3-Regular.ttf",
      "SourceSans3-Semibold.ttf",
      "SourceSerif4-Regular.ttf",
      "SourceSerif4-Semibold.ttf",
    ]);
    expect(requirements.assets.length).toBeLessThan(PDF_RUNTIME_ASSETS.fonts.length);
    expect(requirements.assets.some((asset) => asset.family === "Source Code Pro")).toBe(false);
    expect(requirements.assets.some((asset) => asset.family === "Noto Emoji")).toBe(false);
    expect(requirements.assets.some((asset) => asset.family === "Noto Sans Symbols2")).toBe(false);
    assertResolvedPdfFontRequirementsV1(requirements);
  });

  it("adds style, mono, and Unicode fallback faces only when nested content needs them", () => {
    const requirements = resolve([
      {
        type: "layout",
        columns: [
          {
            width: 1,
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Bold", marks: ["bold"] },
                  { type: "text", text: "Italic", marks: ["italic"] },
                  { type: "text", text: "const answer = 42", marks: ["code"] },
                  { type: "text", text: "🧪" },
                ],
              },
            ],
          },
        ],
      },
    ]);

    expect(requirements.assets.map((asset) => asset.fileName)).toContain(
      "SourceSerif4-Bold.ttf",
    );
    expect(requirements.assets.map((asset) => asset.fileName)).toContain(
      "SourceSerif4-It.ttf",
    );
    expect(requirements.assets.map((asset) => asset.fileName)).toContain(
      "SourceCodePro-Regular.ttf",
    );
    expect(requirements.assets.map((asset) => asset.fileName)).toContain(
      "NotoEmoji-wght.ttf",
    );
  });

  it("is deterministic and never leaks source text into requirement reasons", () => {
    const secret = "customer-secret-phrase";
    const blocks: PreparedPdfBlock[] = [
      {
        type: "paragraph",
        content: [{ type: "text", text: secret, marks: ["italic"] }],
      },
    ];

    const first = resolve(blocks);
    const second = resolve(blocks);

    expect(second).toEqual(first);
    expect(first.key).not.toContain(secret);
    expect(JSON.stringify(first.assets.flatMap((asset) => asset.reasons))).not.toContain(
      secret,
    );
  });

  it("provides an explicit validated full-bundle conformance requirement", () => {
    const requirements = resolveFullPdfFontRequirementsV1();

    expect(requirements.assets.map((asset) => asset.assetId)).toEqual(
      PDF_RUNTIME_ASSETS.fonts.map((asset) => asset.assetId),
    );
    expect(fileNames([]).length).toBeLessThan(requirements.assets.length);
    assertResolvedPdfFontRequirementsV1(requirements);
  });

  it("rejects a hash/key mismatch before a host loads any bytes", () => {
    const requirements = resolve([]);
    const invalid = {
      ...requirements,
      key: "tampered",
    };

    expect(() => assertResolvedPdfFontRequirementsV1(invalid)).toThrow(
      "key does not match",
    );
  });

  it("rejects malformed and reordered requirements from a durable boundary", () => {
    expect(() => assertResolvedPdfFontRequirementsV1(null)).toThrow(
      "Unsupported",
    );

    const requirements = resolveFullPdfFontRequirementsV1();
    const assets = [...requirements.assets];
    [assets[0], assets[1]] = [assets[1]!, assets[0]!];
    const reordered = {
      ...requirements,
      assets,
      key: assets.map((asset) => `${asset.assetId}@${asset.sha256}`).join("|"),
    };
    expect(() => assertResolvedPdfFontRequirementsV1(reordered)).toThrow(
      "canonical manifest order",
    );
  });
});
