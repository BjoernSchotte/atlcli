import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256Hex } from "@atlcli/core";
import {
  IMPORT_DOCUMENT_SCHEMA_V2,
  documentToAdf,
  documentToStorage,
  type ImportDocumentV2,
} from "@atlcli/import-core";
import {
  PDF_ASSET_MATERIALIZER_REVISION,
  type PdfAssetMaterializationProgress,
  type PdfAssetMaterializationRequestV1,
  type PdfFactsAdapter,
} from "./contracts.js";
import { digestPdfFacts } from "./canonical.js";
import { encodeRgbaPng } from "./fallbacks.js";
import { preservePdfFigures } from "./figures.js";
import { isPdfImportError, type PdfImportErrorCode } from "./issues.js";
import { createNodePdfiumFactsAdapter } from "./node.js";
import { createPdfiumFactsAdapter, createPdfiumFactsAdapterForTest } from "./adapter/pdfium.js";
import type { PdfiumFailureStage } from "./adapter/contracts.js";
import { normalizeTaggedPdfFacts } from "./normalize.js";
import { normalizeUntaggedPdfFacts } from "./untagged.js";

const fixtureRoot = resolve(import.meta.dir, "../../../specs/import-pdf-mvp/fixtures");

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(fixtureRoot, name)));
}

async function wasm(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(import.meta.dir, "../vendor/pdfium.wasm")));
}

async function expectCode(promise: Promise<unknown>, code: PdfImportErrorCode): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(isPdfImportError(error)).toBe(true);
    if (!isPdfImportError(error)) throw error;
    expect(error.code).toBe(code);
  }
}

describe("PDF figure and rendered fallback preservation", () => {
  it("extracts the tagged one-to-one raster with author alt and caption", async () => {
    const adapter = await createNodePdfiumFactsAdapter();
    const bytes = await fixture("complex-tagged.pdf");
    const analyzed = await adapter.analyze(bytes);
    const base = await normalizeTaggedPdfFacts(analyzed.facts, analyzed.factsDigest);
    const first = await preservePdfFigures(analyzed.facts, analyzed.factsDigest, bytes, adapter, base);
    const second = await preservePdfFigures(analyzed.facts, analyzed.factsDigest, bytes, adapter, base);
    const figure = first.figures[0]!;
    const image = first.document.blocks.find((block) => block.id === figure.blockId);

    expect(first.semanticDigest).toBe(second.semanticDigest);
    expect(first.figures).toHaveLength(1);
    expect(figure).toMatchObject({
      mode: "native-raster",
      authorAlt: true,
      captionBlockId: "pdf:p0:struct:3.1:caption",
    });
    expect(image).toMatchObject({
      type: "image",
      presentation: "figure",
      alt: "Green square sample tile",
      captionBlockId: "pdf:p0:struct:3.1:caption",
    });
    expect(first.document.blocks.map((block) => block.type)).toEqual([
      "heading", "paragraph", "table", "image", "paragraph",
    ]);
    expect(first.document.assets).toHaveLength(1);
    expect(first.document.assets[0]?.bytes.slice(0, 8)).toEqual(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(first.document.issues.map((issue) => issue.code)).not.toContain(
      "pdf-import/tagged-figure-deferred",
    );
    expect(first.document.issues.map((issue) => issue.code)).not.toContain(
      "pdf-import/figure-alt-missing",
    );

    const media = new Map([[figure.assetId, { fileId: "cloud-file-1", collection: "content-1" }]]);
    const adf = documentToAdf(first.document, { media });
    expect(adf.content[3]?.content?.[0]?.attrs).toMatchObject({
      id: "cloud-file-1",
      collection: "content-1",
      alt: "Green square sample tile",
    });
    const storage = documentToStorage(first.document);
    expect(storage).toContain(`ri:filename="${first.document.assets[0]!.fileName}"`);
    expect(storage).toContain('ac:alt="Green square sample tile"');
  });

  it("extracts the real raster and renders the vector region without false native vectors", async () => {
    const adapter = await createNodePdfiumFactsAdapter();
    const bytes = await fixture("figure.pdf");
    const analyzed = await adapter.analyze(bytes);
    const base = await normalizeUntaggedPdfFacts(analyzed.facts, analyzed.factsDigest);
    const result = await preservePdfFigures(analyzed.facts, analyzed.factsDigest, bytes, adapter, base);

    expect(base.requiresFallbackPages).toEqual([]);
    expect(result.figures.map((figure) => figure.mode)).toEqual([
      "native-raster", "rendered-region",
    ]);
    expect(result.document.blocks.map((block) => block.type)).toEqual([
      "heading", "image", "image", "paragraph",
    ]);
    expect(result.figures[0]?.captionBlockId).toBe(result.figures[1]?.captionBlockId);
    expect(result.document.assets).toHaveLength(2);
    expect(new Set(result.document.assets.map((asset) => asset.fileName)).size).toBe(2);
    expect(result.document.assets.every((asset) => asset.mediaType === "image/png")).toBe(true);
    expect(result.document.issues.filter((issue) => issue.code === "pdf-import/figure-alt-missing"))
      .toHaveLength(2);
    expect(result.document.issues).toContainEqual(expect.objectContaining({
      code: "pdf-import/figure-rendered-region-attached",
      outcome: "attached",
    }));
    expect(result.evidence.find((item) => item.sourceId === result.figures[1]!.sourceId)).toMatchObject({
      basis: ["rendered-region"],
      outcome: "attached",
    });
  });

  it("attaches a bounded visual table fallback alongside exact linearized text", async () => {
    const adapter = await createNodePdfiumFactsAdapter();
    const bytes = await fixture("table-negative.pdf");
    const analyzed = await adapter.analyze(bytes);
    const base = await normalizeUntaggedPdfFacts(analyzed.facts, analyzed.factsDigest);
    const result = await preservePdfFigures(analyzed.facts, analyzed.factsDigest, bytes, adapter, base);

    expect(result.figures).toHaveLength(1);
    expect(result.figures[0]?.mode).toBe("table-region-fallback");
    expect(result.document.blocks.map((block) => block.type)).toEqual([
      "image", "paragraph", "paragraph", "paragraph",
    ]);
    expect(JSON.stringify(result.document.blocks)).toContain("Plot | Apples | Pears");
    expect(result.document.issues).toContainEqual(expect.objectContaining({
      code: "pdf-import/table-region-fallback-attached",
      outcome: "attached",
    }));
  });

  it("deduplicates identical bytes while preserving two independent placements", async () => {
    const realAdapter = await createNodePdfiumFactsAdapter();
    const bytes = await fixture("figure.pdf");
    const analyzed = await realAdapter.analyze(bytes);
    const page = analyzed.facts.pages[0]!;
    const firstImage = page.images[0]!;
    const facts = {
      ...analyzed.facts,
      pages: [{
        ...page,
        paths: [],
        images: [
          firstImage,
          { ...firstImage, id: "pdf:p0:image:99", bbox: { ...firstImage.bbox!, y: 0.55 } },
        ],
      }],
    };
    const factsDigest = await digestPdfFacts(facts);
    const png = encodeRgbaPng(1, 1, new Uint8Array([20, 80, 140, 255]));
    const digest = await sha256Hex(png);
    const fakeAdapter: PdfFactsAdapter = {
      analyze: () => Promise.reject(new Error("not used")),
      materialize: async (_data, requests) => requests.map((request) => ({
        requestId: request.id,
        pageIndex: request.pageIndex,
        sourceKind: request.kind,
        mediaType: "image/png",
        width: 1,
        height: 1,
        bytes: new Uint8Array(png),
        sha256: digest,
        materializerRevision: PDF_ASSET_MATERIALIZER_REVISION,
      })),
    };
    const document: ImportDocumentV2 = {
      schema: IMPORT_DOCUMENT_SCHEMA_V2,
      sourceKind: "pdf",
      blocks: [],
      assets: [],
      issues: [],
    };
    const result = await preservePdfFigures(facts, factsDigest, bytes, fakeAdapter, {
      factsDigest,
      document,
      evidence: [],
    });

    expect(result.figures).toHaveLength(2);
    expect(result.document.assets).toHaveLength(1);
    expect(new Set(result.figures.map((figure) => figure.assetId)).size).toBe(1);
    expect(result.document.assets[0]?.sourceRefs).toEqual(expect.arrayContaining([
      firstImage.id, "pdf:p0:image:99",
    ]));
  });

  it("materializes raster and rendered figure requests deterministically within hard budgets", async () => {
    const bytes = await fixture("figure.pdf");
    const wasmBinary = await wasm();
    const adapter = createPdfiumFactsAdapter({ wasmBinary });
    const facts = (await adapter.analyze(bytes)).facts;
    const image = facts.pages[0]!.images[0]!;
    const path = facts.pages[0]!.paths.find((candidate) => candidate.bbox)!.bbox!;
    const requests: PdfAssetMaterializationRequestV1[] = [
      {
        id: "figure-raster",
        pageIndex: 0,
        kind: "image-object",
        objectId: image.id,
      },
      {
        id: "figure-vector",
        pageIndex: 0,
        kind: "rendered-region",
        bbox: path,
        dpi: 144,
      },
    ];
    const progress: PdfAssetMaterializationProgress[] = [];
    const first = await adapter.materialize(bytes, requests, {
      progress: (event) => progress.push(event),
    });
    const second = await adapter.materialize(bytes, requests);

    expect(first.map((asset) => asset.sha256)).toEqual(second.map((asset) => asset.sha256));
    expect(first.map((asset) => asset.bytes)).toEqual(second.map((asset) => asset.bytes));
    expect(first.map((asset) => asset.sourceKind)).toEqual(["image-object", "rendered-region"]);
    expect(first.every((asset) => asset.width > 0 && asset.height > 0)).toBe(true);
    expect(progress.map((event) => event.phase)).toEqual([
      "start",
      "request-start",
      "request-complete",
      "request-start",
      "request-complete",
      "cleanup",
    ]);

    await expectCode(
      adapter.materialize(bytes, [requests[1]!], { budgets: { maxRenderedPixelsPerAsset: 1 } }),
      "pdf/budget-exceeded",
    );
    await expectCode(
      adapter.materialize(bytes, [{ ...requests[1]!, dpi: 301 }]),
      "pdf/budget-exceeded",
    );
    await expectCode(
      adapter.materialize(bytes, [{ ...requests[0]!, objectId: "pdf:p0:object:9999" }]),
      "pdf/asset-request-invalid",
    );
  });

  it("cancels between figure requests, cleans up, and permits deterministic recovery", async () => {
    const bytes = await fixture("figure.pdf");
    const adapter = createPdfiumFactsAdapter({ wasmBinary: await wasm() });
    const facts = (await adapter.analyze(bytes)).facts;
    const image = facts.pages[0]!.images[0]!;
    const requests: PdfAssetMaterializationRequestV1[] = [
      { id: "figure-first", pageIndex: 0, kind: "image-object", objectId: image.id },
      { id: "figure-second", pageIndex: 0, kind: "image-object", objectId: image.id },
    ];
    const controller = new AbortController();
    const progress: PdfAssetMaterializationProgress[] = [];
    await expectCode(adapter.materialize(bytes, requests, {
      signal: controller.signal,
      progress: (event) => {
        progress.push(event);
        if (event.phase === "request-complete" && event.completed === 1) controller.abort();
      },
    }), "pdf/cancelled");
    expect(progress.at(-1)?.phase).toBe("cleanup");
    expect(progress.filter((event) => event.phase === "request-complete")).toHaveLength(1);

    const recovered = await adapter.materialize(bytes, [requests[0]!]);
    const repeated = await adapter.materialize(bytes, [requests[0]!]);
    expect(recovered[0]?.sha256).toBe(repeated[0]?.sha256);
  });

  it("releases figure bitmaps and render state after injected lifecycle faults", async () => {
    const bytes = await fixture("figure.pdf");
    const wasmBinary = await wasm();
    const healthy = createPdfiumFactsAdapter({ wasmBinary });
    const facts = (await healthy.analyze(bytes)).facts;
    const image = facts.pages[0]!.images[0]!;
    const path = facts.pages[0]!.paths.find((candidate) => candidate.bbox)!.bbox!;
    const cases: Array<{
      failAt: PdfiumFailureStage;
      request: PdfAssetMaterializationRequestV1;
    }> = [
      {
        failAt: "after-bitmap",
        request: { id: "figure-raster", pageIndex: 0, kind: "image-object", objectId: image.id },
      },
      {
        failAt: "after-render",
        request: { id: "figure-vector", pageIndex: 0, kind: "rendered-region", bbox: path, dpi: 144 },
      },
    ];
    for (const testCase of cases) {
      const progress: PdfAssetMaterializationProgress[] = [];
      await expectCode(
        createPdfiumFactsAdapterForTest({ wasmBinary, failAt: testCase.failAt }).materialize(
          bytes,
          [testCase.request],
          { progress: (event) => progress.push(event) },
        ),
        "pdf/engine-failure",
      );
      expect(progress.at(-1)?.phase).toBe("cleanup");
      const recovered = await healthy.materialize(bytes, [testCase.request]);
      const repeated = await healthy.materialize(bytes, [testCase.request]);
      expect(recovered[0]?.sha256).toBe(repeated[0]?.sha256);
    }
  });
});
