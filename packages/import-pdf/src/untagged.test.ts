import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { documentToAdf, documentToStorage, type ImportBlock } from "@atlcli/import-core";
import {
  PDF_FACTS_ADAPTER_REVISION,
  PDF_FACTS_SCHEMA_V1,
  PDFIUM_ENGINE_VERSION,
  PDFIUM_WASM_SHA256,
  PDF_ANALYSIS_POLICY_REVISION,
  PDF_GEOMETRY_POLICY_REVISION_V2,
  PDF_UNTAGGED_SEMANTICS_SCHEMA_V2,
  type PdfFactsV1,
  type PdfPageFactsV1,
  type PdfPageFactsV2,
  type PdfTextCharacterFact,
} from "./contracts.js";
import { createNodePdfiumFactsAdapter, createNodePdfiumFactsAdapterV2 } from "./node.js";
import { digestPdfFacts, digestPdfFactsV2 } from "./canonical.js";
import { normalizeUntaggedPdfFacts, normalizeUntaggedPdfFactsV2 } from "./untagged.js";
import { PDF_TEXT_ASSEMBLY_POLICY_REVISION_V2 } from "./text-assembly.js";
import { analyzeGeometryReadingOrderV2 } from "./reading-order.js";

const fixtureRoot = resolve(import.meta.dir, "../../../specs/import-pdf-mvp/fixtures");
const qualityFixtureRoot = resolve(import.meta.dir, "../../../specs/pdf-import-quality/fixtures");

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
        fontWeight: 400,
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
        fontWeight: 400,
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
    paths: [],
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
        pathGeometry: true,
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

function pageWithLinesV2(
  lines: Array<{ text: string; x: number; y: number }>,
): PdfPageFactsV2 {
  const page = pageWithLines(lines);
  return {
    ...page,
    characters: page.characters.map((character) => ({
      ...character,
      textRunId: character.generated ? null : `run:${character.index}`,
    })),
    structures: [],
  };
}

describe("untagged PDF conservative geometry semantics", () => {
  it("does not infer columns from an indented line and a numeric page footer", () => {
    const analysis = analyzeGeometryReadingOrderV2(pageWithLinesV2([
      { text: "Neutral body line one spans the available content width.", x: 0.1, y: 0.2 },
      { text: "Neutral body line two spans the available content width.", x: 0.1, y: 0.3 },
      { text: "Indented note", x: 0.36, y: 0.4 },
      { text: "Neutral body line three spans the available content width.", x: 0.1, y: 0.5 },
      { text: "Neutral body line four spans the available content width.", x: 0.1, y: 0.6 },
      { text: "17", x: 0.87, y: 0.95 },
    ]));

    expect(analysis.columnCount).toBe(1);
    expect(analysis.qualificationReasons).toEqual([]);
    expect(analysis.fragments.find((fragment) => fragment.text === "17")?.furniture).toBe(true);
    expect(analysis.ordered.map((fragment) => fragment.text)).toEqual([
      "Neutral body line one spans the available content width.",
      "Neutral body line two spans the available content width.",
      "Indented note",
      "Neutral body line three spans the available content width.",
      "Neutral body line four spans the available content width.",
    ]);
  });

  it("retains repeated vertically aligned V2 column evidence", () => {
    const analysis = analyzeGeometryReadingOrderV2(pageWithLinesV2([
      { text: "Left one", x: 0.08, y: 0.2 },
      { text: "Right one", x: 0.56, y: 0.2 },
      { text: "Left two", x: 0.08, y: 0.3 },
      { text: "Right two", x: 0.56, y: 0.3 },
      { text: "Left three", x: 0.08, y: 0.4 },
      { text: "Right three", x: 0.56, y: 0.4 },
    ]));

    expect(analysis.columnCount).toBe(2);
    expect(analysis.qualificationReasons).toEqual([]);
    expect(analysis.ordered.map((fragment) => fragment.text)).toEqual([
      "Left one", "Left two", "Left three", "Right one", "Right two", "Right three",
    ]);
  });

  it("routes clustered physical lines and paragraphs through V2 assembly", async () => {
    const adapter = await createNodePdfiumFactsAdapterV2();
    const bytes = new Uint8Array(
      await readFile(resolve(qualityFixtureRoot, "independent-fragmented-untagged.pdf")),
    );
    const first = await adapter.analyze(bytes);
    const second = await adapter.analyze(bytes);
    const result = await normalizeUntaggedPdfFactsV2(first.facts, first.factsDigest);
    const repeated = await normalizeUntaggedPdfFactsV2(second.facts, second.factsDigest);

    expect(result.schema).toBe(PDF_UNTAGGED_SEMANTICS_SCHEMA_V2);
    expect(result.policyRevision).toBe(PDF_GEOMETRY_POLICY_REVISION_V2);
    expect(result.textAssemblyPolicyRevision).toBe(PDF_TEXT_ASSEMBLY_POLICY_REVISION_V2);
    expect(result.semanticDigest).toBe(repeated.semanticDigest);
    expect(result.document.blocks.map((block) => [block.type, blockText(block)])).toEqual([
      ["heading", "Neutral Geometry Evidence"],
      ["paragraph", "River markers remain stable."],
      ["paragraph", "Wrapped routes continue safely without explicit breaks."],
      ["paragraph", "Punctuation, brackets and links stay attached."],
      ["paragraph", "Authored north-east remains hard-hyphenated."],
      ["heading", "Neutral Script Boundaries"],
      ["paragraph", "مرحبا بالميناء"],
      ["paragraph", "港の信号"],
      ["paragraph", "office"],
      ["paragraph", "Seasonal coordination stays stable."],
    ]);
    expect(result.pageOutcomes).toEqual([expect.objectContaining({
      mode: "geometry-native",
      columnCount: 1,
      sourceFragmentCount: 11,
      suppressedFragmentCount: 0,
      accountedCharacterCount: 281,
      unaccountedCharacterCount: 0,
      qualificationReasons: [],
      boundaryDecisionCount: 33,
      unresolvedBoundaryCount: 0,
    })]);
    expect(result.boundaries.filter((boundary) =>
      boundary.leftCharacterIndex === 31 && boundary.rightCharacterIndex === 33
      || boundary.leftCharacterIndex === 79 && boundary.rightCharacterIndex === 82
      || boundary.leftCharacterIndex === 125 && boundary.rightCharacterIndex === 126
      || boundary.leftCharacterIndex === 176 && boundary.rightCharacterIndex === 178
    )).toEqual([
      expect.objectContaining({
        action: "insert-space",
        basis: ["generated-whitespace", "text-run", "baseline", "glyph-gap"],
        confidence: 0.98,
      }),
      expect.objectContaining({
        action: "join-line",
        basis: ["generated-whitespace", "baseline", "script"],
        confidence: 0.95,
      }),
      expect.objectContaining({
        action: "no-space",
        basis: ["text-run", "punctuation", "baseline"],
        confidence: 0.99,
      }),
      expect.objectContaining({
        action: "retain-hyphen",
        basis: ["hyphen", "script"],
        confidence: 1,
      }),
    ]);
    expect(result.evidence.every((item) =>
      item.outcome !== "native" || item.confidence < 1 || item.boundaryDecisionIds.length === 0
    )).toBe(true);
    expect(documentToAdf(result.document).content.map((node) => node.type)).toEqual([
      "heading", "paragraph", "paragraph", "paragraph", "paragraph",
      "heading", "paragraph", "paragraph", "paragraph", "paragraph",
    ]);
    const storage = documentToStorage(result.document);
    expect(storage).toContain("<p>Wrapped routes continue safely without explicit breaks.</p>");
    expect(storage).toContain("<p>مرحبا بالميناء</p><p>港の信号</p><p>office</p>");
    expect(storage).toContain('href="https://example.com/neutral-river"');
  });

  it("keeps an unresolved V2 geometry boundary out of native output", async () => {
    const adapter = await createNodePdfiumFactsAdapterV2();
    const raw = await adapter.analyze(new Uint8Array(
      await readFile(resolve(qualityFixtureRoot, "independent-fragmented-untagged.pdf")),
    ));
    const facts = structuredClone(raw.facts);
    const separator = facts.pages[0]?.characters.find((character) => character.index === 32);
    const right = facts.pages[0]?.characters.find((character) => character.index === 33);
    if (!separator || !right?.bbox) throw new Error("expected neutral boundary characters");
    separator.value = "";
    separator.unicode = 0;
    right.bbox.x = 0.168;
    const result = await normalizeUntaggedPdfFactsV2(facts, await digestPdfFactsV2(facts));

    expect(result.document.blocks).toEqual([]);
    expect(result.requiresFallbackPages).toEqual([0]);
    expect(result.pageOutcomes[0]).toMatchObject({
      mode: "fallback-required",
      qualificationReasons: ["unresolved-text-boundary"],
      unresolvedBoundaryCount: 1,
    });
    expect(result.boundaries).toContainEqual(expect.objectContaining({
      leftCharacterIndex: 31,
      rightCharacterIndex: 33,
      action: "unresolved",
      confidence: 0.25,
    }));
    expect(result.evidence.every((item) => item.outcome !== "native")).toBe(true);
    expect(result.document.issues).toContainEqual(expect.objectContaining({
      code: "pdf-import/text-boundary-unresolved",
      outcome: "reported",
      context: { pageIndex: 0, boundaries: 1 },
    }));
  });

  it("normalizes the pinned Word producer with RTL, calibrated heading, list, and filled grid", async () => {
    const adapter = await createNodePdfiumFactsAdapterV2();
    const raw = await adapter.analyze(new Uint8Array(
      await readFile(resolve(qualityFixtureRoot, "producer-word.pdf")),
    ));
    const result = await normalizeUntaggedPdfFactsV2(raw.facts, raw.factsDigest);

    expect(result.document.blocks.map((block) => [block.type, blockText(block)])).toEqual([
      ["heading", "Neutral Harbor Field Notes"],
      ["paragraph", "Harbor signals remain clear across styled text runs."],
      ["paragraph", "Seasonal coordination continues safely across a visual line wrap."],
      ["paragraph", "Grüne Flächen, Küstenwege und präzise Übergänge bleiben neutral."],
      ["paragraph", "مرحبا بالميناء"],
      ["paragraph", "港の信号は明確です"],
      ["list", "list"],
      ["table", "table"],
    ]);
    const list = result.document.blocks[6]!;
    expect(list.type).toBe("list");
    if (list.type !== "list") throw new Error("expected native list");
    expect(list.items.map((item) => blockText(item.blocks[0]!))).toEqual([
      "Inspect the northern marker.",
      "Record the stable reading.",
      "Publish the neutral summary.",
    ]);
    const table = result.document.blocks[7]!;
    expect(table.type).toBe("table");
    if (table.type !== "table") throw new Error("expected native table");
    expect(table.rows.map((row) => row.cells.map((cell) => blockText(cell.blocks[0]!)))).toEqual([
      ["Zone", "Signal"],
      ["North", "Clear"],
      ["South", "Stable"],
    ]);
    expect(result.requiresFallbackPages).toEqual([]);
    expect(result.pageOutcomes).toEqual([expect.objectContaining({
      mode: "geometry-native",
      columnCount: 1,
      sourceFragmentCount: 15,
      accountedCharacterCount: 352,
      unaccountedCharacterCount: 0,
      qualificationReasons: [],
      boundaryDecisionCount: 48,
      unresolvedBoundaryCount: 0,
    })]);
    expect(result.evidence).toContainEqual(expect.objectContaining({
      decisionCode: "pdf/table-untagged-grid-native",
      outcome: "native",
    }));
    expect(result.evidence.every((item) => item.boundaryDecisionIds.every((id) =>
      result.boundaries.some((boundary) => boundary.id === id)
    ))).toBe(true);
    expect(documentToStorage(result.document)).toContain(
      "<h1>Neutral Harbor Field Notes</h1>",
    );
  });

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
