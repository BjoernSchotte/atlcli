import { describe, expect, it } from "bun:test";
import {
  validateManifestV3,
  type WikiPdfTemplateDesignV3,
} from "@atlcli/template-pack";
import type { PreparedPdfBlock, PreparedPdfDocument } from "./types.js";
import { PDF_RUNTIME_ASSETS } from "./runtime-assets.js";
import { serializePdfDocument } from "./serialize.js";
import {
  assertResolvedPdfFontRequirementsV1,
  resolveFullPdfFontRequirementsV1,
  resolvePdfFontRequirementsV1,
} from "./font-requirements.js";
import { BUILTIN_PDF_TEMPLATE_MANIFEST } from "./builtin-template.js";
import {
  PDF_TEMPLATE_CAPABILITIES_V2,
  PDF_TEMPLATE_CAPABILITIES_V3,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V2,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V3,
} from "./design-catalog.js";
import { resolvePdfSettings } from "./settings.js";
import { BUILTIN_PDF_TEMPLATE_BASELINE_V1 } from "./recipe-baselines.js";

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

function brandLockupRequirements(options: {
  enabled: boolean;
  website?: "show" | "hide";
  legalNotice?: "show" | "hide";
}) {
  const manifest = structuredClone(BUILTIN_PDF_TEMPLATE_MANIFEST);
  manifest.id = "fixture.fonts-v4";
  manifest.design!.features.closingPage.enabled = options.enabled;
  manifest.design!.compositions = {
    cover: { kind: "standard", logo: "hide" },
    closingPage: {
      kind: "brand-lockup",
      logo: "hide",
      website: options.website ?? "show",
      legalNotice: options.legalNotice ?? "show",
      align: "left",
    },
  };
  Object.assign(manifest.design!.branding, {
    websiteLabel: "systems.example",
    websiteUrl: "https://systems.example",
    legalNotice: "© Example GmbH · Zürich · Qualität 🧪",
  });
  Object.assign(manifest.design!.tokens.colors, {
    closingPageBackground: "#E75204",
    closingBrandText: "#FFFFFF",
  });
  Object.assign(manifest.design!.tokens.layout, {
    closingBrandBottomInset: "24mm",
    closingBrandBlockWidth: "90mm",
    closingBrandTextGap: "4mm",
  });
  Object.assign(manifest.design!.typography.roles, {
    closingWebsite: { font: "heading", size: "14pt", weight: "semibold" },
    closingLegal: { font: "heading", size: "9pt", weight: "regular" },
  });
  manifest.canonicalSource = {
    api: "wiki.pdf-canonical-typst",
    revision: "4",
  };
  manifest.capabilityCatalog = {
    id: PDF_TEMPLATE_CAPABILITIES_V2.id,
    version: PDF_TEMPLATE_CAPABILITIES_V2.version,
    digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V2,
  };
  const settings = resolvePdfSettings(
    { cover: false, outline: false },
    { manifest }
  );
  const document: PreparedPdfDocument = { blocks: [], assets: [], notes: [] };
  return resolvePdfFontRequirementsV1({
    document,
    metadata,
    settings,
    manifest,
  });
}

function runningV5Requirements(
  literal?: string,
  configure?: (design: WikiPdfTemplateDesignV3) => void,
) {
  const design = structuredClone(BUILTIN_PDF_TEMPLATE_BASELINE_V1.design);
  const header = design.compositions.running.header;
  header.first = "hide";
  header.odd = literal === undefined
    ? { center: { field: "documentTitle" } }
    : { center: { field: "literal", value: literal } };
  configure?.(design);
  const manifest = validateManifestV3({
    schemaVersion: 1,
    id: "fixture.fonts-v5",
    name: "Font V5 fixture",
    version: "1.0.0",
    engine: {
      kind: "typst",
      api: "wiki.pdf-template/v1",
      entry: "atlcli.typ",
      compilerRange: ">=0.15.1 <0.16",
    },
    canonicalSource: { api: "wiki.pdf-canonical-typst", revision: "5" },
    capabilityCatalog: {
      id: PDF_TEMPLATE_CAPABILITIES_V3.id,
      version: PDF_TEMPLATE_CAPABILITIES_V3.version,
      digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V3,
    },
    design,
  });
  const settings = resolvePdfSettings(
    { cover: false, outline: false },
    { manifest },
  );
  const document: PreparedPdfDocument = { blocks: [], assets: [], notes: [] };
  return resolvePdfFontRequirementsV1({ document, metadata, settings, manifest });
}

describe("resolved PDF font requirements v1", () => {
  it("adds revision-5 running-slot demand only for visible variants", () => {
    const visible = runningV5Requirements("VISIBLE 🧪");
    expect(visible.assets.map(({ fileName }) => fileName)).toContain(
      "NotoEmoji-wght.ttf",
    );
    expect(
      visible.assets
        .flatMap(({ reasons }) => reasons)
        .some(({ detail }) =>
          detail === "running-header-odd-center-literal"),
    ).toBe(true);

    const hidden = runningV5Requirements();
    expect(hidden.assets.map(({ fileName }) => fileName)).not.toContain(
      "NotoEmoji-wght.ttf",
    );
  });

  it("accounts for revision-5 outline leaders, page numbers, and heading numbering", () => {
    const visible = runningV5Requirements(undefined, (design) => {
      design.navigation.contents = {
        enabled: true,
        depth: 3,
        leader: "dots",
        pageNumbers: "show",
      };
      design.navigation.headingNumbers = {
        enabled: true,
        preset: "decimal-alpha-roman",
      };
    });
    const visibleDetails = visible.assets
      .flatMap(({ reasons }) => reasons)
      .map(({ detail }) => detail);
    expect(visibleDetails).toContain("outline-leader");
    expect(visibleDetails).toContain("outline-page-number");
    expect(visibleDetails).toContain("heading-numbering");

    const hidden = runningV5Requirements(undefined, (design) => {
      design.navigation.contents.enabled = false;
      design.navigation.headingNumbers.enabled = false;
    });
    const hiddenDetails = hidden.assets
      .flatMap(({ reasons }) => reasons)
      .map(({ detail }) => detail);
    expect(hiddenDetails).not.toContain("outline-leader");
    expect(hiddenDetails).not.toContain("outline-page-number");
    expect(hiddenDetails).not.toContain("heading-numbering");
  });

  it("includes only visible brand-lockup roles and Unicode demand", () => {
    const requirements = brandLockupRequirements({ enabled: true });
    const reasons = requirements.assets.flatMap((asset) => asset.reasons);
    expect(reasons).toContainEqual({
      kind: "template-role",
      detail: "closingWebsite",
    });
    expect(reasons).toContainEqual({
      kind: "template-role",
      detail: "closingLegal",
    });
    expect(reasons.some(({ detail }) => detail === "closingTitle")).toBe(false);
    expect(requirements.assets.map(({ fileName }) => fileName)).toContain(
      "NotoEmoji-wght.ttf"
    );

    const websiteOnly = brandLockupRequirements({
      enabled: true,
      legalNotice: "hide",
    });
    expect(
      websiteOnly.assets.flatMap((asset) => asset.reasons)
        .some(({ detail }) => detail === "closingLegal")
    ).toBe(false);
  });

  it("requires no closing-only role when the revision-4 closing page is disabled", () => {
    const requirements = brandLockupRequirements({ enabled: false });
    const details = requirements.assets
      .flatMap((asset) => asset.reasons)
      .map(({ detail }) => detail);
    expect(details).not.toContain("closingWebsite");
    expect(details).not.toContain("closingLegal");
    expect(details).not.toContain("closingTitle");
    expect(details).not.toContain("closingEyebrow");
  });

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
