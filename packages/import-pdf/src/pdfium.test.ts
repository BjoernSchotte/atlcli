import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  PDF_FACTS_SCHEMA_V1,
  PDF_FACTS_SCHEMA_V2,
  PDF_FACTS_ADAPTER_REVISION_V2,
  PDF_ANALYSIS_POLICY_REVISION_V2,
  PDFIUM_ENGINE_VERSION,
  PDFIUM_WASM_SHA256,
  assertPdfAnalysisProvenance,
  createPdfiumFactsAdapter,
  createPdfiumFactsAdapterV2,
  isPdfImportError,
  orderedDescendantMcidsV2,
  type PdfAnalysisProgress,
  type PdfImportErrorCode,
  type PdfStructureNodeFact,
} from "./index.js";
import {
  createBrowserPdfiumFactsAdapter,
  createBrowserPdfiumFactsAdapterV2,
} from "./adapter/pdfium-browser.js";
import {
  createPdfiumFactsAdapterForTest,
  createPdfiumFactsAdapterV2ForTest,
} from "./adapter/pdfium.js";
import {
  createNodePdfiumFactsAdapter,
  createNodePdfiumFactsAdapterV2,
} from "./node.js";
import type { PdfiumFailureStage } from "./adapter/contracts.js";
import { generateUnresolvedStructureKidProbe } from "../../../specs/pdf-import-quality/fixtures/generate-core.js";

const fixtureRoot = resolve(import.meta.dir, "../../../specs/import-pdf-mvp/fixtures");
const qualityFixtureRoot = resolve(import.meta.dir, "../../../specs/pdf-import-quality/fixtures");
const wasmPath = resolve(import.meta.dir, "../vendor/pdfium.wasm");

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(fixtureRoot, name)));
}

async function qualityFixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(qualityFixtureRoot, name)));
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

describe("PDFium V2 facts adapter", () => {
  it("preserves the pinned V1 facts and options digests through the V2 projection", async () => {
    const adapter = createPdfiumFactsAdapter({ wasmBinary: await wasm() });
    const simple = await adapter.analyze(await fixture("simple-untagged.pdf"));
    const fragmented = await adapter.analyze(
      await qualityFixture("independent-fragmented-tagged.pdf"),
    );

    expect(simple.factsDigest).toBe(
      "5f2b76680800f21c8ea01d2030421bf46491ae99c3270ebac8b371aedd52c64a",
    );
    expect(fragmented.factsDigest).toBe(
      "0cfb59c1212d667cd28a941336fd6f8c4263392f65a7e2ef39a930d18b3696da",
    );
    expect(simple.facts.provenance.optionsDigest).toBe(
      "cc08a36bd42d41e600e84e08cf88c3b14b474f0a064ee5efc4cc4c5f8593d304",
    );
    expect(fragmented.facts.provenance.optionsDigest).toBe(
      simple.facts.provenance.optionsDigest,
    );
  });

  it("applies a tight canonical-size budget to public V1 facts, not internal V2 evidence", async () => {
    const bytes = await fixture("simple-untagged.pdf");
    const wasmBinary = await wasm();
    const baseline = await createPdfiumFactsAdapter({ wasmBinary }).analyze(bytes);
    const maxCanonicalBytes = new TextEncoder().encode(JSON.stringify(baseline.facts)).byteLength;

    const compatible = await createPdfiumFactsAdapter({ wasmBinary }).analyze(bytes, {
      budgets: { maxCanonicalBytes },
    });
    expect(compatible.facts.schema).toBe(PDF_FACTS_SCHEMA_V1);
    await expectCode(
      createPdfiumFactsAdapterV2({ wasmBinary }).analyze(bytes, {
        budgets: { maxCanonicalBytes },
      }),
      "pdf/budget-exceeded",
    );
  });

  it("emits deterministic stable text-run ordinals without serializing PDFium handles", async () => {
    const bytes = await qualityFixture("independent-fragmented-tagged.pdf");
    const adapter = createPdfiumFactsAdapterV2({ wasmBinary: await wasm() });
    const first = await adapter.analyze(bytes);
    const second = await adapter.analyze(bytes);
    const characters = first.facts.pages[0]?.characters ?? [];
    const harbor = characters.filter((character) => character.textRunId === "pdf:p0:text-run:1");
    const signals = characters.filter((character) => character.textRunId === "pdf:p0:text-run:2");

    expect(first.facts.schema).toBe(PDF_FACTS_SCHEMA_V2);
    expect(first.facts.provenance.adapterRevision).toBe(PDF_FACTS_ADAPTER_REVISION_V2);
    expect(first.facts.provenance.policyRevision).toBe(PDF_ANALYSIS_POLICY_REVISION_V2);
    expect(harbor.map((character) => character.value).join("")).toBe("Harbor");
    expect(signals.map((character) => character.value).join("")).toBe("signals");
    expect(new Set(harbor.map((character) => character.textRunId)).size).toBe(1);
    expect(new Set(signals.map((character) => character.textRunId)).size).toBe(1);
    expect(harbor[0]?.textRunId).not.toBe(signals[0]?.textRunId);
    expect(first.facts).toEqual(second.facts);
    expect(first.factsDigest).toBe(second.factsDigest);
    expect(JSON.stringify(first.facts)).not.toMatch(/(?:handle|pointer|module)/i);
  });

  it("retains mixed structure child order and avoids direct-MCID duplication", async () => {
    const result = await createPdfiumFactsAdapterV2({ wasmBinary: await wasm() }).analyze(
      await qualityFixture("independent-fragmented-tagged.pdf"),
    );
    const paragraph = result.facts.pages[0]?.structures.find((node) =>
      node.type === "P" && node.kids.some((kid) => kid.kind === "element"),
    );
    expect(paragraph?.kids.map((kid) =>
      kid.kind === "mcid" ? `mcid:${kid.mcid}` : `${kid.kind}:${kid.index}`
    )).toEqual(["mcid:1", "element:1", "mcid:3"]);
    expect(paragraph?.kids[1]).toMatchObject({
      kind: "element",
      index: 1,
      node: { type: "Span", directMcids: [2] },
    });
    expect(orderedDescendantMcidsV2(paragraph!)).toEqual([1, 2, 3]);
  });

  it("retains an unresolved child at its exact index and falls back only when needed", async () => {
    const result = await createPdfiumFactsAdapterV2({ wasmBinary: await wasm() }).analyze(
      generateUnresolvedStructureKidProbe(),
    );
    const paragraph = result.facts.pages[0]?.structures[0];

    expect(paragraph?.kids).toEqual([
      { kind: "mcid", index: 0, mcid: 0 },
      {
        kind: "unresolved",
        index: 1,
        reason: "child-handle-and-mcid-unavailable",
      },
      { kind: "mcid", index: 2, mcid: 1 },
    ]);
    expect(paragraph?.directMcids).toEqual([0, 1]);
    expect(orderedDescendantMcidsV2(paragraph!)).toEqual([0, 1]);
    expect(orderedDescendantMcidsV2({
      ...paragraph!,
      kids: [{
        kind: "unresolved",
        index: 0,
        reason: "child-handle-and-mcid-unavailable",
      }],
      directMcids: [4, 2, 4],
    })).toEqual([4, 2]);
  });

  it("keeps V2 Node, browser, and injected adapters canonically identical", async () => {
    const bytes = await fixture("simple-untagged.pdf");
    const wasmBinary = await wasm();
    const injected = await createPdfiumFactsAdapterV2({ wasmBinary }).analyze(bytes);
    const browser = await createBrowserPdfiumFactsAdapterV2({ wasmBinary }).analyze(bytes);
    const node = await (await createNodePdfiumFactsAdapterV2()).analyze(bytes);

    expect(browser.facts).toEqual(injected.facts);
    expect(node.facts).toEqual(injected.facts);
    expect(browser.factsDigest).toBe(injected.factsDigest);
    expect(node.factsDigest).toBe(injected.factsDigest);
    expect(() => assertPdfAnalysisProvenance(
      injected.facts.provenance,
      browser.facts.provenance,
    )).not.toThrow();
  });

  it("retains V2 lifecycle cleanup, cancellation, hard budgets, and recovery", async () => {
    const wasmBinary = await wasm();
    const bytes = await fixture("complex-tagged.pdf");
    const expected = await createPdfiumFactsAdapterV2({ wasmBinary }).analyze(bytes);
    const stages: PdfiumFailureStage[] = ["after-init", "after-structure-tree", "before-finalize"];
    for (const failAt of stages) {
      const progress: PdfAnalysisProgress[] = [];
      await expectCode(
        createPdfiumFactsAdapterV2ForTest({ wasmBinary, failAt }).analyze(bytes, {
          progress: (event) => progress.push(event),
        }),
        "pdf/engine-failure",
      );
      expect(progress.at(-1)?.phase).toBe("cleanup");
      const recovered = await createPdfiumFactsAdapterV2({ wasmBinary }).analyze(bytes);
      expect(recovered.factsDigest).toBe(expected.factsDigest);
      expect(recovered.telemetry.wasmFinalBytes).toBe(recovered.telemetry.wasmInitialBytes);
    }

    await expectCode(
      createPdfiumFactsAdapterV2({ wasmBinary }).analyze(bytes, {
        budgets: { maxTextItemsPerPage: 1 },
      }),
      "pdf/budget-exceeded",
    );
    const controller = new AbortController();
    controller.abort();
    await expectCode(
      createPdfiumFactsAdapterV2({ wasmBinary }).analyze(bytes, { signal: controller.signal }),
      "pdf/cancelled",
    );
    const recovered = await createPdfiumFactsAdapterV2({ wasmBinary }).analyze(bytes);
    expect(recovered.factsDigest).toBe(expected.factsDigest);
  });
});
