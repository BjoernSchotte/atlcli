import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  PDF_FACTS_SCHEMA_V1,
  PDFIUM_ENGINE_VERSION,
  PDFIUM_WASM_SHA256,
  assertPdfAnalysisProvenance,
  createPdfiumFactsAdapter,
  isPdfImportError,
  type PdfAnalysisProgress,
  type PdfImportErrorCode,
  type PdfStructureNodeFact,
} from "./index.js";
import { createBrowserPdfiumFactsAdapter } from "./adapter/pdfium-browser.js";
import { createPdfiumFactsAdapterForTest } from "./adapter/pdfium.js";
import { createNodePdfiumFactsAdapter } from "./node.js";
import type { PdfiumFailureStage } from "./adapter/contracts.js";

const fixtureRoot = resolve(import.meta.dir, "../../../specs/import-pdf-mvp/fixtures");
const wasmPath = resolve(import.meta.dir, "../vendor/pdfium.wasm");

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(fixtureRoot, name)));
}

async function wasm(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(wasmPath));
}

function flatten(nodes: readonly PdfStructureNodeFact[]): PdfStructureNodeFact[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
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

describe("PDFium facts adapter", () => {
  it("extracts deterministic simple facts, safe links, normalized geometry, and progress", async () => {
    const bytes = await fixture("simple-untagged.pdf");
    const adapter = createPdfiumFactsAdapter({ wasmBinary: await wasm() });
    const progress: PdfAnalysisProgress[] = [];
    const first = await adapter.analyze(bytes, { progress: (event) => progress.push(event) });
    const second = await adapter.analyze(bytes);

    expect(first.facts.schema).toBe(PDF_FACTS_SCHEMA_V1);
    expect(first.facts.provenance.engineVersion).toBe(PDFIUM_ENGINE_VERSION);
    expect(first.facts.provenance.wasmSha256).toBe(PDFIUM_WASM_SHA256);
    expect(first.facts.classification).toBe("digital-untagged");
    expect(first.facts.completeness).toEqual({
      expectedPages: 1,
      analyzedPages: 1,
      pageIndexes: [0],
      complete: true,
    });
    expect(first.facts.pages[0]?.text).toContain("Quarterly Garden Notes");
    expect(first.facts.pages[0]?.boxes.bounding).not.toBeNull();
    expect(first.facts.pages[0]?.boxes.media).not.toBeNull();
    expect(first.facts.pages[0]?.annotations[0]?.safeExternalTarget).toBe(
      "https://example.com/garden-notes",
    );
    const boxes = first.facts.pages[0]?.characters.flatMap((character) =>
      character.bbox ? [character.bbox] : [],
    ) ?? [];
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.every((box) =>
      [box.x, box.y, box.width, box.height].every((value) => value >= 0 && value <= 1),
    )).toBe(true);
    expect(boxes[0]?.width).toBeLessThan(0.1);
    expect(boxes[0]?.height).toBeLessThan(0.1);
    expect(first.factsDigest).toBe(second.factsDigest);
    expect(JSON.stringify(first.facts)).not.toMatch(/(?:handle|pointer|module)/i);
    expect(progress.map((event) => event.phase)).toEqual([
      "start",
      "document-loaded",
      "page-start",
      "page-complete",
      "complete",
      "cleanup",
    ]);
  });

  it("collects tagged structures, attributes, images, outline, and explicit capability gaps", async () => {
    const result = await createPdfiumFactsAdapter({ wasmBinary: await wasm() })
      .analyze(await fixture("complex-tagged.pdf"));
    const nodes = flatten(result.facts.pages[0]?.structures ?? []);
    const cells = nodes.filter((node) => node.type === "TH" || node.type === "TD");
    expect(result.facts.tagged).toBe(true);
    expect(result.facts.classification).toBe("tagged");
    expect(cells).toHaveLength(4);
    expect(cells.every((cell) =>
      cell.attributes.some((attribute) => attribute.name === "RowSpan" && attribute.value === 1),
    )).toBe(true);
    expect(nodes.find((node) => node.type === "Figure")?.alt).toBe("Green square sample tile");
    expect(result.facts.pages[0]?.images).toHaveLength(1);
    expect(result.facts.outline).toEqual([
      { title: "Structured Garden Report", pageIndex: 0, depth: 0 },
    ]);
    expect(result.facts.provenance.capabilities.operatorList).toBe(false);
    expect(result.facts.provenance.capabilities.nativeTableExtraction).toBe(false);
    expect(result.facts.pages[0]?.operatorSummary).toEqual({ capability: "unavailable", count: null });
  });

  it("classifies scan, mixed, encrypted, and inert active-content cases without fallback", async () => {
    const adapter = createPdfiumFactsAdapter({ wasmBinary: await wasm() });
    const scan = await adapter.analyze(await fixture("scan.pdf"));
    const mixed = await adapter.analyze(await fixture("mixed.pdf"));
    const encrypted = await adapter.analyze(await fixture("encrypted.pdf"));
    const active = await adapter.analyze(await fixture("adversarial-actions.pdf"));

    expect(scan.facts.classification).toBe("scan");
    expect(scan.facts.pages[0]?.kind).toBe("image-only");
    expect(scan.facts.pages[0]?.text).toBe("");
    expect(mixed.facts.classification).toBe("mixed");
    expect(mixed.facts.pages.map((page) => page.kind)).toEqual(["digital", "image-only"]);
    expect(encrypted.facts.classification).toBe("encrypted");
    expect(encrypted.facts.encrypted).toBe(true);
    expect(encrypted.facts.completeness.complete).toBe(false);
    expect(encrypted.facts.loadError).toBe(4);
    expect(active.facts.inertFeatures.javascriptActionCount).toBe(1);
    expect(active.facts.inertFeatures.attachmentCount).toBe(1);
    expect(active.facts.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "pdf-import/javascript-inert",
      "pdf-import/embedded-files-inert",
    ]));
  });

  it("rejects invalid inputs, raised limits, page excess, text excess, and cancellation with stable codes", async () => {
    const adapter = createPdfiumFactsAdapter({ wasmBinary: await wasm() });
    await expectCode(
      adapter.analyze(new ArrayBuffer(8) as unknown as Uint8Array),
      "pdf/input-type-invalid",
    );
    await expectCode(adapter.analyze(new Uint8Array()), "pdf/input-empty");
    await expectCode(adapter.analyze(new TextEncoder().encode("not a pdf")), "pdf/signature-invalid");
    const simple = await fixture("simple-untagged.pdf");
    await expectCode(
      adapter.analyze(simple, { budgets: { maxInputBytes: simple.byteLength - 1 } }),
      "pdf/input-too-large",
    );
    await expectCode(
      adapter.analyze(simple, { budgets: { maxPages: 501 } }),
      "pdf/budget-exceeded",
    );
    await expectCode(
      adapter.analyze(await fixture("heading-rich-100.pdf"), { budgets: { maxPages: 99 } }),
      "pdf/page-count-invalid",
    );
    await expectCode(
      adapter.analyze(simple, { budgets: { maxTextItemsPerPage: 1 } }),
      "pdf/budget-exceeded",
    );
    await expectCode(
      adapter.analyze(await fixture("scan.pdf"), { budgets: { maxDecodedPixelsPerAsset: 1 } }),
      "pdf/budget-exceeded",
    );
    const controller = new AbortController();
    controller.abort();
    await expectCode(adapter.analyze(simple, { signal: controller.signal }), "pdf/cancelled");
    const wrongWasm = await wasm();
    wrongWasm[0] = wrongWasm[0]! ^ 0xff;
    await expectCode(
      createPdfiumFactsAdapter({ wasmBinary: wrongWasm }).analyze(simple),
      "pdf/wasm-digest-mismatch",
    );
    const truncated = await adapter.analyze(simple.slice(0, 100));
    expect(truncated.facts.classification).toBe("rejected");
    expect(truncated.facts.issues[0]?.code).toBe("pdf-import/load-rejected");
  });

  it("releases each acquired lifecycle stage after faults and permits identical recovery", async () => {
    const wasmBinary = await wasm();
    const bytes = await fixture("complex-tagged.pdf");
    const expected = await createPdfiumFactsAdapter({ wasmBinary }).analyze(bytes);
    const stages: PdfiumFailureStage[] = [
      "after-init",
      "after-input",
      "after-load",
      "after-page-load",
      "after-text-page",
      "after-structure-tree",
      "after-annotation",
      "after-page-objects",
      "before-finalize",
    ];
    for (const failAt of stages) {
      const cleanup: PdfAnalysisProgress[] = [];
      await expectCode(
        createPdfiumFactsAdapterForTest({ wasmBinary, failAt }).analyze(bytes, {
          progress: (event) => cleanup.push(event),
        }),
        "pdf/engine-failure",
      );
      expect(cleanup.at(-1)?.phase).toBe("cleanup");
      const recovered = await createPdfiumFactsAdapter({ wasmBinary }).analyze(bytes);
      expect(recovered.factsDigest).toBe(expected.factsDigest);
      expect(recovered.telemetry.wasmFinalBytes).toBe(recovered.telemetry.wasmInitialBytes);
    }
  });

  it("accounts for all 100 pages and rejects concurrent ownership without queuing bytes", async () => {
    const adapter = createPdfiumFactsAdapter({ wasmBinary: await wasm() });
    const richPromise = adapter.analyze(await fixture("heading-rich-100.pdf"));
    await expectCode(
      adapter.analyze(await fixture("heading-poor-100.pdf")),
      "pdf/adapter-busy",
    );
    const rich = await richPromise;
    const poor = await adapter.analyze(await fixture("heading-poor-100.pdf"));
    for (const result of [rich, poor]) {
      expect(result.facts.pageCount).toBe(100);
      expect(result.facts.completeness.complete).toBe(true);
      expect(result.facts.pages.map((page) => page.index)).toEqual(
        Array.from({ length: 100 }, (_, index) => index),
      );
    }
  }, 30_000);

  it("observes cancellation between pages, cleans up, and recovers", async () => {
    const adapter = createPdfiumFactsAdapter({ wasmBinary: await wasm() });
    const bytes = await fixture("heading-poor-100.pdf");
    const controller = new AbortController();
    await expectCode(adapter.analyze(bytes, {
      signal: controller.signal,
      progress: (event) => {
        if (event.phase === "page-complete" && event.completedPages === 1) controller.abort();
      },
    }), "pdf/cancelled");
    const recovered = await adapter.analyze(bytes);
    expect(recovered.facts.completeness.complete).toBe(true);
  });

  it("uses the same normalized facts contract in the browser-worker entry and rejects provenance drift", async () => {
    const wasmBinary = await wasm();
    const bytes = await fixture("simple-untagged.pdf");
    const node = await createPdfiumFactsAdapter({ wasmBinary }).analyze(bytes);
    const browser = await createBrowserPdfiumFactsAdapter({ wasmBinary }).analyze(bytes);
    const packagedNode = await (await createNodePdfiumFactsAdapter()).analyze(bytes);
    expect(browser.factsDigest).toBe(node.factsDigest);
    expect(packagedNode.factsDigest).toBe(node.factsDigest);
    expect(() => assertPdfAnalysisProvenance(node.facts.provenance, browser.facts.provenance)).not.toThrow();
    expect(() => assertPdfAnalysisProvenance(node.facts.provenance, {
      ...browser.facts.provenance,
      optionsDigest: "drift",
    })).toThrow("Run preview again");
  });
});
