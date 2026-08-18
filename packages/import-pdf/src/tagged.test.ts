import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { documentToAdf, type ImportBlock, type ImportRun } from "@atlcli/import-core";
import {
  PDF_FACTS_ADAPTER_REVISION,
  PDF_FACTS_SCHEMA_V1,
  PDFIUM_ENGINE_VERSION,
  PDFIUM_WASM_SHA256,
  PDF_ANALYSIS_POLICY_REVISION,
  type PdfFactsV1,
  type PdfPageFactsV1,
  type PdfStructureNodeFact,
  type PdfTextCharacterFact,
} from "./contracts.js";
import { createNodePdfiumFactsAdapter } from "./node.js";
import { normalizeTaggedPdfFacts } from "./normalize.js";
import { textDirection } from "./text.js";
import { digestPdfFacts } from "./canonical.js";

const fixtureRoot = resolve(import.meta.dir, "../../../specs/import-pdf-mvp/fixtures");

function textOf(block: ImportBlock): string {
  if (block.type !== "heading" && block.type !== "paragraph") return "";
  return block.runs.map((run) => run.kind === "text" ? run.text : "\n").join("");
}

function structure(
  id: string,
  type: string,
  mcids: number[] = [],
  children: PdfStructureNodeFact[] = [],
): PdfStructureNodeFact {
  return {
    id,
    type,
    title: "",
    alt: "",
    actualText: "",
    language: "",
    elementId: "",
    mcids,
    childMcids: mcids,
    attributes: [],
    children,
  };
}

function charactersFor(
  value: string,
  mcid: number,
  startIndex: number,
  y: number,
): PdfTextCharacterFact[] {
  return [...value].map((character, offset) => ({
    index: startIndex + offset,
    unicode: character.codePointAt(0)!,
    value: character,
    bbox: { x: 0.1 + offset * 0.02, y, width: 0.018, height: 0.02 },
    fontSizePoints: 12,
    angleRadians: 0,
    mcid,
    generated: false,
    hyphen: false,
    unicodeMapError: false,
  }));
}

function syntheticPage(
  structures: PdfStructureNodeFact[],
  characters: PdfTextCharacterFact[],
): PdfPageFactsV1 {
  return {
    index: 0,
    label: "i",
    widthPoints: 612,
    heightPoints: 792,
    boxes: { bounding: null, media: null, crop: null, bleed: null, trim: null, art: null },
    rotation: 0,
    kind: "digital",
    text: characters.map((character) => character.value).join(""),
    characters,
    structures,
    objectTypeCounts: {},
    operatorSummary: { capability: "unavailable", count: null },
    images: [],
    annotations: [],
  };
}

function syntheticFacts(page: PdfPageFactsV1): PdfFactsV1 {
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
    tagged: true,
    encrypted: false,
    classification: "tagged",
    completeness: { expectedPages: 1, analyzedPages: 1, pageIndexes: [0], complete: true },
    pages: [page],
    outline: [],
    inertFeatures: { javascriptActionCount: 0, attachmentCount: 0, namedDestinationCount: 0, formType: 0 },
    loadError: null,
    issues: [],
  };
}

async function normalizeSynthetic(facts: PdfFactsV1) {
  return normalizeTaggedPdfFacts(facts, await digestPdfFacts(facts));
}

describe("tagged PDF semantic extraction", () => {
  it("correlates a real tagged golden without page loss or outline dependence", async () => {
    const adapter = await createNodePdfiumFactsAdapter();
    const bytes = new Uint8Array(await readFile(resolve(fixtureRoot, "complex-tagged.pdf")));
    const first = await adapter.analyze(bytes);
    const second = await adapter.analyze(bytes);
    const normalized = await normalizeTaggedPdfFacts(first.facts, first.factsDigest);
    const repeated = await normalizeTaggedPdfFacts(second.facts, second.factsDigest);

    await expect(normalizeTaggedPdfFacts(first.facts, "0".repeat(64))).rejects.toMatchObject({
      code: "pdf/provenance-drift",
    });

    expect(first.factsDigest).toBe(second.factsDigest);
    expect(normalized.semanticDigest).toBe(repeated.semanticDigest);
    expect(normalized.document.titleCandidate).toBe("Structured Garden Report");
    expect(normalized.document.blocks.map((block) => [block.type, textOf(block)])).toEqual([
      ["heading", "Structured Garden Report"],
      ["paragraph", "Tagged content connects structure roles to marked text."],
    ]);
    expect(normalized.pageOutcomes).toEqual([{
      pageIndex: 0,
      mode: "tagged-native",
      projectedNodeIds: ["pdf:p0:struct:0:heading-1", "pdf:p0:struct:1:paragraph"],
      claimedCharacterCount: 127,
      unclaimedCharacterCount: 0,
      corruptTagCount: 0,
    }]);
    expect(normalized.evidence.map((item) => item.outcome)).toEqual([
      "native", "native", "reported", "reported",
    ]);
    expect(normalized.document.issues.map((issue) => issue.code)).toContain(
      "pdf-import/tagged-table-deferred",
    );
    expect(normalized.document.issues.map((issue) => issue.code)).toContain(
      "pdf-import/tagged-figure-deferred",
    );
    expect(documentToAdf(normalized.document).content.map((node) => node.type)).toEqual([
      "heading", "paragraph",
    ]);

    const withoutOutline = await normalizeTaggedPdfFacts(
      { ...first.facts, outline: [] },
      await digestPdfFacts({ ...first.facts, outline: [] }),
    );
    expect(withoutOutline.document.blocks[0]).toMatchObject({ type: "heading", level: 1 });
  });

  it("preserves explicit heading levels, logical RTL text, nested lists, and safe link marks", async () => {
    const h1Chars = charactersFor("Root", 0, 0, 0.1);
    const h3Chars = charactersFor("Detail", 1, h1Chars.length, 0.2);
    const rtlChars = charactersFor("مرحبا", 2, h1Chars.length + h3Chars.length, 0.3);
    for (const character of rtlChars) character.angleRadians = Math.PI / 2;
    const linkChars = charactersFor("safe link", 3, h1Chars.length + h3Chars.length + rtlChars.length, 0.4);
    const labelChars = charactersFor("1.", 4, 100, 0.5);
    const itemChars = charactersFor("First item", 5, 110, 0.55);
    const childLabelChars = charactersFor("•", 6, 130, 0.6);
    const childChars = charactersFor("Nested item", 7, 140, 0.65);
    const nestedList = structure("s-list-nested", "L", [], [
      structure("s-li-nested", "LI", [], [
        structure("s-label-nested", "Lbl", [6]),
        structure("s-body-nested", "LBody", [], [structure("s-p-nested", "P", [7])]),
      ]),
    ]);
    const list = structure("s-list", "L", [], [
      structure("s-li", "LI", [], [
        structure("s-label", "Lbl", [4]),
        structure("s-body", "LBody", [], [structure("s-p-item", "P", [5]), nestedList]),
      ]),
    ]);
    const page = syntheticPage(
      [
        structure("s-h1", "H1", [0]),
        structure("s-h3", "H3", [1]),
        structure("s-rtl", "P", [2]),
        structure("s-link-p", "P", [], [structure("s-link", "Link", [3])]),
        list,
      ],
      [...h1Chars, ...h3Chars, ...rtlChars, ...linkChars, ...labelChars, ...itemChars, ...childLabelChars, ...childChars],
    );
    page.rotation = 1;
    page.annotations.push({
      id: "safe-annotation",
      subtype: 2,
      bbox: { x: 0.195, y: 0.39, width: 0.12, height: 0.04 },
      actionType: 3,
      safeExternalTarget: "https://example.com/safe",
      unsafeTargetReported: false,
    });
    const result = await normalizeSynthetic(syntheticFacts(page));

    expect(result.requiresGeometryPages).toEqual([]);
    expect(result.pageOutcomes[0]).toMatchObject({
      mode: "tagged-native",
      unclaimedCharacterCount: 0,
      corruptTagCount: 0,
    });
    expect(result.document.blocks.map((block) => block.type)).toEqual([
      "heading", "heading", "paragraph", "paragraph", "list",
    ]);
    expect(result.document.blocks[1]).toMatchObject({ type: "heading", level: 3 });
    expect(textOf(result.document.blocks[2]!)).toBe("مرحبا");
    expect(textDirection(textOf(result.document.blocks[2]!))).toBe("rtl");
    const linkRuns = (result.document.blocks[3] as { runs: ImportRun[] }).runs;
    expect(linkRuns).toEqual([
      { kind: "text", text: "safe " },
      {
        kind: "text",
        text: "link",
        marks: { link: { href: "https://example.com/safe" } },
      },
    ]);
    expect(result.evidence.find((item) => item.sourceId === "s-link-p")).toMatchObject({
      locator: { annotationId: "safe-annotation" },
      basis: ["structure-tree", "marked-content", "text-geometry", "annotation"],
    });
    const projectedList = result.document.blocks[4];
    expect(projectedList).toMatchObject({ type: "list", ordered: true });
    if (projectedList?.type !== "list") throw new Error("expected list");
    expect(projectedList.items[0]?.child).toMatchObject({ ordered: false });
    expect(documentToAdf(result.document).content.map((node) => node.type)).toEqual([
      "heading", "heading", "paragraph", "paragraph", "orderedList",
    ]);
    expect(result.document.issues.map((issue) => issue.code)).toContain(
      "pdf-import/tagged-heading-gap",
    );
    expect(result.evidence.filter((item) => item.outcome === "native")).toHaveLength(8);
  });

  it("demotes corrupt, incomplete, and unsafe tagged content instead of claiming native semantics", async () => {
    const characters = charactersFor("ambiguous", 0, 0, 0.1);
    const page = syntheticPage(
      [structure("duplicate-a", "P", [0]), structure("duplicate-b", "P", [0])],
      characters,
    );
    page.annotations.push({
      id: "unsafe-annotation",
      subtype: 2,
      bbox: { x: 0.09, y: 0.09, width: 0.4, height: 0.04 },
      actionType: 3,
      safeExternalTarget: null,
      unsafeTargetReported: true,
    });
    const corruptFacts = syntheticFacts(page);
    const corrupt = await normalizeSynthetic(corruptFacts);

    expect(corrupt.document.blocks).toEqual([]);
    expect(corrupt.requiresGeometryPages).toEqual([0]);
    expect(corrupt.pageOutcomes[0]).toMatchObject({
      mode: "geometry-required",
      corruptTagCount: 3,
      unclaimedCharacterCount: characters.length,
    });
    expect(corrupt.evidence.every((item) => item.outcome === "reported")).toBe(true);
    expect(JSON.stringify(corrupt.document.blocks)).not.toContain("javascript:");

    const missing = await normalizeSynthetic(syntheticFacts(syntheticPage([], characters)));
    expect(missing.requiresGeometryPages).toEqual([0]);
    expect(missing.document.issues.map((issue) => issue.code)).toContain(
      "pdf-import/tagged-structure-missing",
    );
  });

  it("retains repeated tagged regions with distinct evidence and an explicit outcome", async () => {
    const first = charactersFor("Repeated header", 0, 0, 0.1);
    const second = charactersFor("Repeated header", 1, 50, 0.8);
    const result = await normalizeSynthetic(
      syntheticFacts(syntheticPage([
        structure("repeat-top", "P", [0]),
        structure("repeat-bottom", "P", [1]),
      ], [...first, ...second])),
    );

    expect(result.document.blocks.map(textOf)).toEqual(["Repeated header", "Repeated header"]);
    expect(result.evidence.filter((item) => item.outcome === "native")).toHaveLength(2);
    expect(result.document.issues).toContainEqual(expect.objectContaining({
      code: "pdf-import/tagged-repeated-region-retained",
      outcome: "native",
      sourceRefs: ["repeat-top", "repeat-bottom"],
      context: { occurrences: 2 },
    }));
  });
});
