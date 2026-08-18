import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { documentToAdf, type ImportBlock } from "@atlcli/import-core";
import {
  PDF_FACTS_ADAPTER_REVISION,
  PDF_FACTS_SCHEMA_V1,
  PDFIUM_ENGINE_VERSION,
  PDFIUM_WASM_SHA256,
  PDF_ANALYSIS_POLICY_REVISION,
  type PdfFactsV1,
  type PdfPageFactsV1,
  type PdfTextCharacterFact,
} from "./contracts.js";
import { createNodePdfiumFactsAdapter } from "./node.js";
import { digestPdfFacts } from "./canonical.js";
import { normalizeUntaggedPdfFacts } from "./untagged.js";

const fixtureRoot = resolve(import.meta.dir, "../../../specs/import-pdf-mvp/fixtures");

function blockText(block: ImportBlock): string {
  if (block.type === "heading" || block.type === "paragraph") {
    return block.runs.map((run) => run.kind === "text" ? run.text : "\n").join("");
  }
  return block.type;
}

function pageWithLines(
  lines: Array<{ text: string; x: number; y: number; angle?: number }>,
): PdfPageFactsV1 {
  const characters: PdfTextCharacterFact[] = [];
  for (const line of lines) {
    for (const [offset, value] of [...line.text].entries()) {
      characters.push({
        index: characters.length,
        unicode: value.codePointAt(0)!,
        value,
        bbox: { x: line.x + offset * 0.012, y: line.y, width: 0.011, height: 0.02 },
        fontSizePoints: 11,
        angleRadians: line.angle ?? 0,
        mcid: null,
        generated: false,
        hyphen: false,
        unicodeMapError: false,
      });
    }
    for (const value of ["\r", "\n"]) {
      characters.push({
        index: characters.length,
        unicode: value.codePointAt(0)!,
        value,
        bbox: null,
        fontSizePoints: 1,
        angleRadians: 0,
        mcid: null,
        generated: true,
        hyphen: false,
        unicodeMapError: false,
      });
    }
  }
  return {
    index: 0,
    widthPoints: 600,
    heightPoints: 800,
    boxes: { bounding: null, media: null, crop: null, bleed: null, trim: null, art: null },
    rotation: 0,
    kind: "digital",
    text: lines.map((line) => line.text).join("\r\n"),
    characters,
    structures: [],
    objectTypeCounts: {},
    operatorSummary: { capability: "unavailable", count: null },
    images: [],
    annotations: [],
  };
}

function factsFor(page: PdfPageFactsV1): PdfFactsV1 {
  return {
    schema: PDF_FACTS_SCHEMA_V1,
    provenance: {
      engine: "pdfium",
      engineVersion: PDFIUM_ENGINE_VERSION,
      wasmSha256: PDFIUM_WASM_SHA256,
      adapterRevision: PDF_FACTS_ADAPTER_REVISION,
      policyRevision: PDF_ANALYSIS_POLICY_REVISION,
      optionsDigest: "0".repeat(64),
      capabilities: {
        textCharacters: true,
        normalizedCharacterGeometry: true,
        structureTree: true,
        structureAttributes: true,
        pageLabels: true,
        outline: true,
        annotations: true,
        pageObjects: true,
        imageMetadata: true,
        operatorList: false,
        nativeTableExtraction: false,
        ocr: false,
        activeContentExecution: false,
      },
    },
    inputSha256: "1".repeat(64),
    inputBytes: 1,
    pageCount: 1,
    tagged: false,
    encrypted: false,
    classification: "digital-untagged",
    completeness: { expectedPages: 1, analyzedPages: 1, pageIndexes: [0], complete: true },
    pages: [page],
    outline: [],
    inertFeatures: { javascriptActionCount: 0, attachmentCount: 0, namedDestinationCount: 0, formType: 0 },
    loadError: null,
    issues: [],
  };
}

async function normalizeSynthetic(page: PdfPageFactsV1) {
  const facts = factsFor(page);
  return normalizeUntaggedPdfFacts(facts, await digestPdfFacts(facts));
}

describe("untagged PDF conservative geometry semantics", () => {
  it("qualifies a simple golden with headings, safe links, and one native list", async () => {
    const adapter = await createNodePdfiumFactsAdapter();
    const bytes = new Uint8Array(await readFile(resolve(fixtureRoot, "simple-untagged.pdf")));
    const first = await adapter.analyze(bytes);
    const second = await adapter.analyze(bytes);
    const result = await normalizeUntaggedPdfFacts(first.facts, first.factsDigest);
    const repeated = await normalizeUntaggedPdfFacts(second.facts, second.factsDigest);

    expect(result.semanticDigest).toBe(repeated.semanticDigest);
    expect(result.requiresFallbackPages).toEqual([]);
    expect(result.document.titleCandidate).toBe("Quarterly Garden Notes");
    expect(result.document.blocks.map((block) => block.type)).toEqual([
      "heading", "paragraph", "paragraph", "paragraph", "heading", "list",
    ]);
    expect(result.document.blocks[4]).toMatchObject({ type: "heading", level: 2 });
    expect(result.document.blocks[5]).toMatchObject({ type: "list", ordered: false });
    if (result.document.blocks[5]?.type !== "list") throw new Error("expected list");
    expect(result.document.blocks[5].items).toHaveLength(3);
    expect(result.pageOutcomes[0]).toMatchObject({
      mode: "geometry-native",
      columnCount: 1,
      suppressedFragmentCount: 1,
      unaccountedCharacterCount: 0,
      qualificationReasons: [],
    });
    expect(result.evidence.some((item) => item.basis.includes("annotation") && item.outcome === "native")).toBe(true);
    expect(documentToAdf(result.document).content.map((node) => node.type)).toEqual([
      "heading", "paragraph", "paragraph", "paragraph", "heading", "bulletList",
    ]);
    await expect(normalizeUntaggedPdfFacts(first.facts, "0".repeat(64))).rejects.toMatchObject({
      code: "pdf/provenance-drift",
    });
  });

  it("orders the qualified two-column golden column-first without duplicates", async () => {
    const adapter = await createNodePdfiumFactsAdapter();
    const raw = await adapter.analyze(
      new Uint8Array(await readFile(resolve(fixtureRoot, "complex-untagged.pdf"))),
    );
    const result = await normalizeUntaggedPdfFacts(raw.facts, raw.factsDigest);
    const texts = result.document.blocks.map(blockText);

    expect(result.requiresFallbackPages).toEqual([]);
    expect(result.pageOutcomes[0]).toMatchObject({
      mode: "geometry-native",
      columnCount: 2,
      sourceFragmentCount: 26,
      suppressedFragmentCount: 1,
      unaccountedCharacterCount: 0,
    });
    expect(texts[0]).toBe("Two-column Field Report");
    expect(texts.slice(1, 13)).toEqual(
      Array.from({ length: 12 }, (_, index) =>
        `Left column sentence ${String(index + 1).padStart(2, "0")} describes alpine observations.`
      ),
    );
    expect(texts.slice(13)).toEqual(
      Array.from({ length: 12 }, (_, index) =>
        `Right column sentence ${String(index + 1).padStart(2, "0")} records coastal measurements.`
      ),
    );
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("removes only proven repeated furniture across both 100-page goldens", async () => {
    const adapter = await createNodePdfiumFactsAdapter();
    const richRaw = await adapter.analyze(
      new Uint8Array(await readFile(resolve(fixtureRoot, "heading-rich-100.pdf"))),
    );
    const poorRaw = await adapter.analyze(
      new Uint8Array(await readFile(resolve(fixtureRoot, "heading-poor-100.pdf"))),
    );
    const rich = await normalizeUntaggedPdfFacts(richRaw.facts, richRaw.factsDigest);
    const poor = await normalizeUntaggedPdfFacts(poorRaw.facts, poorRaw.factsDigest);

    expect(rich.pageOutcomes).toHaveLength(100);
    expect(poor.pageOutcomes).toHaveLength(100);
    expect(rich.requiresFallbackPages).toEqual([]);
    expect(poor.requiresFallbackPages).toEqual([]);
    expect(rich.document.blocks.filter((block) => block.type === "heading")).toHaveLength(4);
    expect(poor.document.blocks.filter((block) => block.type === "heading")).toHaveLength(0);
    expect(poor.document.blocks.filter((block) => block.type === "paragraph")).toHaveLength(100);
    const poorText = poor.document.blocks.map(blockText).join("\n");
    for (const page of [1, 20, 50, 100]) {
      expect(poorText).toContain(`PAGE-${String(page).padStart(3, "0")}`);
    }
    expect(poorText).not.toContain("Long Neutral Report");
    expect(poor.pageOutcomes.every((page) => page.unaccountedCharacterCount === 0)).toBe(true);
    expect(poor.evidence.some((item) => item.decisionCode === "pdf/geometry-repeated-region-suppressed")).toBe(true);
  });

  it("fails closed for conflicting overlap, three columns, rotation, and unsafe links", async () => {
    const overlap = await normalizeSynthetic(pageWithLines([
      { text: "Alpha layer", x: 0.1, y: 0.2 },
      { text: "Omega layer", x: 0.1, y: 0.2 },
    ]));
    expect(overlap.requiresFallbackPages).toEqual([0]);
    expect(overlap.pageOutcomes[0]?.qualificationReasons).toContain("conflicting-overlap");
    expect(overlap.evidence.every((item) => item.outcome !== "native")).toBe(true);

    const duplicate = await normalizeSynthetic(pageWithLines([
      { text: "Exact duplicate", x: 0.1, y: 0.2 },
      { text: "Exact duplicate", x: 0.1, y: 0.2 },
    ]));
    expect(duplicate.requiresFallbackPages).toEqual([]);
    expect(duplicate.document.blocks.map(blockText)).toEqual(["Exact duplicate"]);
    expect(duplicate.evidence).toContainEqual(expect.objectContaining({
      decisionCode: "pdf/geometry-overlap-duplicate-suppressed",
      outcome: "approximated",
    }));

    const columns = await normalizeSynthetic(pageWithLines([
      { text: "Column A1", x: 0.05, y: 0.2 },
      { text: "Column A2", x: 0.05, y: 0.3 },
      { text: "Column B1", x: 0.38, y: 0.2 },
      { text: "Column B2", x: 0.38, y: 0.3 },
      { text: "Column C1", x: 0.72, y: 0.2 },
      { text: "Column C2", x: 0.72, y: 0.3 },
    ]));
    expect(columns.pageOutcomes[0]?.qualificationReasons).toContain("too-many-columns");
    expect(columns.document.blocks).toEqual([]);

    const rotated = await normalizeSynthetic(pageWithLines([
      { text: "Rotated text", x: 0.1, y: 0.2, angle: Math.PI / 2 },
    ]));
    expect(rotated.pageOutcomes[0]?.qualificationReasons).toContain("non-horizontal-text");

    const rtl = await normalizeSynthetic(pageWithLines([
      { text: "مرحبا بالعالم", x: 0.1, y: 0.2 },
    ]));
    expect(rtl.requiresFallbackPages).toEqual([]);
    expect(rtl.document.blocks.map(blockText)).toEqual(["مرحبا بالعالم"]);

    const unsafePage = pageWithLines([{ text: "unsafe target", x: 0.1, y: 0.2 }]);
    unsafePage.annotations.push({
      id: "unsafe",
      subtype: 2,
      bbox: { x: 0.09, y: 0.19, width: 0.3, height: 0.04 },
      actionType: 3,
      safeExternalTarget: null,
      unsafeTargetReported: true,
    });
    const unsafe = await normalizeSynthetic(unsafePage);
    expect(JSON.stringify(unsafe.document.blocks)).not.toContain("link");
    expect(unsafe.evidence.some((item) => item.basis.includes("annotation"))).toBe(false);
  });
});
