/**
 * Report-contract parity between the PDF and DOCX export paths.
 *
 * M1 acceptance finding: `atlcli wiki export <root> --scope tree --json` emitted
 * a DIFFERENT top-level field set depending on `--format`. The DOCX ts path
 * carried spec 002's `complete` (the completeness contract a CI consumer reads
 * via `jq -r '.complete'`) and the `requestedScope`/`resolvedScope` A5
 * traceability pair; the PDF path silently dropped all three, so the guarantee
 * was unobservable on `--format pdf`.
 *
 * NO MOCKS. These tests drive the REAL engines offline — the real Typst wasm
 * compiler via `runPdfExport`, and the real DOCX engine via `runExport` against
 * a real `buildDocx` template fixture — and then assemble the reports through
 * the very same construction sites the command paths use
 * (`buildScopeReportFields` → `buildTreeExportReport` / `buildReport`). The only
 * ports supplied are in-memory sinks/resolvers, which this codebase treats as
 * legitimate port implementations rather than API mocks (see the `TreeSource`
 * port docs in `packages/confluence/src/tree-fetch.ts`).
 */
import { beforeAll, describe, expect, it } from "bun:test";
import Ajv from "ajv";
import { runExport } from "@atlcli/docx";
import { buildDocx, para } from "@atlcli/docx/fixtures";
import {
  runPdfExport,
  type ExportBlock,
  type PdfExportMetadata,
  type PdfBytesHandle,
  type PdfOutputSink,
} from "@atlcli/pdf";
import { ensurePdfFonts } from "../../../../packages/pdf/scripts/ensure-fonts.js";
import { getPdfCompiler } from "./export-pdf-assets.js";
import {
  buildReport,
  buildTreeExportReport,
  pdfReportContributions,
  type ExportReport,
  type Issue,
  type SourcePageEntry,
} from "./export-report.js";
import {
  buildExportScope,
  buildScopeReportFields,
  parseExportRequest,
} from "./export-request.js";

beforeAll(async () => {
  await ensurePdfFonts({ logger: () => {} });
});

/**
 * Fields that are legitimately format-specific and therefore NOT part of the
 * shared report contract: `engine` distinguishes the python/ts DOCX engines (the
 * PDF path has no such choice), and `placeholders` is documented in the schema
 * as "DOCX ts-engine placeholder metrics". Everything else must match.
 */
const DOCX_ONLY_FIELDS = ["engine", "placeholders"] as const;

const BLOCKS: ExportBlock[] = [
  { type: "heading", level: 1, content: [{ type: "text", text: "Chapter one" }] },
  { type: "paragraph", content: [{ type: "text", text: "Tree body text." }] },
];

const SOURCE_PAGES: SourcePageEntry[] = [
  { id: "111", title: "Root", notes: [] },
  { id: "222", title: "Child", notes: [] },
];

/** One real warning-severity issue so `notesByCode` is exercised on BOTH sides. */
const ISSUES: Issue[] = [
  { code: "label-filtered", severity: "warning", phase: "compose", retryable: false },
];

class MemorySink implements PdfOutputSink {
  bytes: Uint8Array | null = null;
  // `bytes` is a PdfBytesHandle since spec 010 T5.6; assertions want the array.
  async emit(_name: string, bytes: PdfBytesHandle): Promise<void> {
    this.bytes = await bytes.asUint8Array();
  }
}

const noAssets = {
  async resolve(): Promise<never> {
    throw new Error("fixture has no assets");
  },
};

const DOCX_TEMPLATE = buildDocx({ body: para("$scroll.content") });

/**
 * Run the REAL Typst pipeline and return its report (carries `complete`). The
 * emitted byte count is returned too so callers can prove the compile really
 * happened rather than silently no-opping.
 */
async function realPdfEngineReport(complete: boolean) {
  const metadata: PdfExportMetadata = {
    title: "Root",
    space: "DOCSY",
    exportedAt: new Date("2026-07-20T00:00:00Z"),
  };
  const compiler = await getPdfCompiler();
  const sink = new MemorySink();
  const report = await runPdfExport(
    { blocks: BLOCKS, metadata, filename: "tree.pdf", complete },
    { assets: noAssets, compiler, output: sink }
  );
  return { report, emittedBytes: sink.bytes?.length ?? 0 };
}

/** Run the REAL DOCX engine against a real template and return its report. */
async function realDocxEngineReport(complete: boolean) {
  let emittedBytes = 0;
  const report = await runExport(
    {
      details: { id: "111", title: "Root", storage: "", spaceKey: "DOCSY" },
      template: { name: "t.docx", modificationDate: new Date(0) },
      blocks: BLOCKS,
      complete,
    },
    {
      templates: { getBytes: async () => DOCX_TEMPLATE },
      assets: { fetch: async () => new Uint8Array() },
      output: { emit: async (_name, bytes) => { emittedBytes = bytes.length; } },
    }
  );
  return { report, emittedBytes };
}

/**
 * Both engines really ran: a real PDF and a real DOCX package came out. If this
 * ever fails, every parity assertion below is comparing hollow reports.
 */
function assertRealArtifacts(
  pdf: { report: { pageCount?: number }; emittedBytes: number },
  docx: { emittedBytes: number }
): void {
  expect(pdf.report.pageCount).toBeGreaterThanOrEqual(1);
  expect(pdf.emittedBytes).toBeGreaterThan(500);
  expect(docx.emittedBytes).toBeGreaterThan(500);
}

/**
 * Assemble the two tree-scope reports exactly as `exportPdf` and
 * `exportTreeWithTsEngine` do: one shared `buildScopeReportFields` result fed
 * into `buildTreeExportReport` on both sides.
 */
async function treeReportsForSameRequest(
  pageRef: string | undefined,
  flags: Record<string, string | boolean | string[]>,
  resolvedRootId: string,
  complete = true
): Promise<{ pdf: ExportReport; docx: ExportReport }> {
  const request = parseExportRequest(pageRef, flags);
  const exportScope = buildExportScope(request, resolvedRootId);
  const scope = buildScopeReportFields(request, exportScope);

  const [pdfRun, docxRun] = await Promise.all([
    realPdfEngineReport(complete),
    realDocxEngineReport(complete),
  ]);
  assertRealArtifacts(pdfRun, docxRun);
  const pdfEngine = pdfRun.report;
  const docxEngine = docxRun.report;

  const { outputDetail } = pdfReportContributions(
    pdfEngine,
    "/tmp/tree.pdf",
    pdfEngine.compilerDiagnostics ?? []
  );

  const pdf = buildTreeExportReport({
    format: "pdf",
    sourcePages: SOURCE_PAGES,
    outputDetails: [outputDetail],
    issues: ISSUES,
    timings: { ...pdfEngine.timings, totalMs: 1 },
    complete: pdfEngine.complete,
    scope,
  });

  const docx = buildTreeExportReport({
    format: "docx",
    engine: "ts",
    sourcePages: SOURCE_PAGES,
    outputDetails: [
      {
        output: "/tmp/tree.docx",
        embeddedImages: docxEngine.embeddedImages,
        renderedDiagrams: docxEngine.renderedDiagrams,
        skippedAssets: docxEngine.skippedImages,
      },
    ],
    issues: ISSUES,
    timings: { durationMs: docxEngine.durationMs },
    complete: docxEngine.complete,
    scope,
    placeholders: {
      resolved: docxEngine.resolvedCount,
      unsupported: docxEngine.unsupportedNames,
    },
  });

  return { pdf, docx };
}

function symmetricDifference(a: string[], b: string[]): string[] {
  const setA = new Set(a);
  const setB = new Set(b);
  return [...a.filter((k) => !setB.has(k)), ...b.filter((k) => !setA.has(k))].sort();
}

describe("export report parity — PDF vs DOCX tree scope", () => {
  it("emits the SAME top-level field set for the same logical tree request", async () => {
    const { pdf, docx } = await treeReportsForSameRequest("111", { scope: "tree", engine: "ts" }, "111");

    // The only permitted divergence is the documented DOCX-ts-only pair. Any new
    // field wired on one path only fails here.
    expect(symmetricDifference(Object.keys(pdf), Object.keys(docx))).toEqual(
      [...DOCX_ONLY_FIELDS].sort()
    );

    // And the three fields the M1 run found missing are present on BOTH.
    for (const report of [pdf, docx]) {
      expect(Object.keys(report)).toContain("complete");
      expect(Object.keys(report)).toContain("requestedScope");
      expect(Object.keys(report)).toContain("resolvedScope");
      expect(Object.keys(report)).toContain("notesByCode");
    }
    expect(pdf.notesByCode).toEqual(docx.notesByCode);
    expect(pdf.requestedScope).toEqual(docx.requestedScope);
    expect(pdf.resolvedScope).toEqual(docx.resolvedScope);
  }, 60_000);

  it("REGRESSION: `complete` is present (not undefined) on the PDF tree path", async () => {
    // The exact M1 finding: `jq -r '.complete'` yielded null for --format pdf.
    const { pdf, docx } = await treeReportsForSameRequest("111", { scope: "tree", engine: "ts" }, "111");
    expect(pdf.complete).toBeDefined();
    expect(pdf.complete).not.toBeUndefined();
    expect(Object.hasOwn(pdf, "complete")).toBe(true);
    // A strict full export is complete on both paths.
    expect(pdf.complete).toBe(true);
    expect(docx.complete).toBe(true);
    // JSON round-trip (what a CI consumer actually reads off stdout).
    expect(JSON.parse(JSON.stringify(pdf)).complete).toBe(true);
  }, 60_000);

  it("carries `complete: false` through both formats for a partial export", async () => {
    const { pdf, docx } = await treeReportsForSameRequest(
      "111",
      { scope: "tree", engine: "ts", completeness: "partial" },
      "111",
      false
    );
    expect(pdf.complete).toBe(false);
    expect(docx.complete).toBe(false);
    expect(pdf.requestedScope).toMatchObject({ completeness: "partial" });
  }, 60_000);

  it("traces a --scope space request to the tree resolved at the homepage id (A5)", async () => {
    // spec 002 A5: a `--scope space` request that resolved to a homepage id must
    // stay traceable — requested stays `space`, resolved becomes a tree rooted at
    // the homepage. Identical on both formats.
    const { pdf, docx } = await treeReportsForSameRequest(
      undefined,
      { scope: "space", space: "DOCSY", engine: "ts" },
      "9001"
    );
    for (const report of [pdf, docx]) {
      expect(report.requestedScope).toEqual({
        kind: "space",
        spaceKey: "DOCSY",
        completeness: "strict",
      });
      expect(report.resolvedScope).toEqual({
        kind: "tree",
        rootPageId: "9001",
        includeRoot: true,
      });
    }
  }, 60_000);

  it("validates both formats' tree reports against the checked-in JSON Schema (ajv)", async () => {
    const schema = JSON.parse(
      await Bun.file(new URL("./export-report.schema.json", import.meta.url)).text()
    );
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);

    const { pdf, docx } = await treeReportsForSameRequest(
      "111",
      { scope: "tree", engine: "ts", "max-depth": "2", "label-exclude": "internal" },
      "111"
    );
    expect(validate(pdf) ? [] : validate.errors).toEqual([]);
    expect(validate(docx) ? [] : validate.errors).toEqual([]);

    // The schema really is being enforced (not vacuously passing).
    expect(validate({ ...pdf, extraneous: true })).toBe(false);
    expect(validate({ ...pdf, complete: "yes" })).toBe(false);
  }, 60_000);
});

describe("buildScopeReportFields — the shared scope-traceability builder", () => {
  const cases: Array<{
    name: string;
    pageRef?: string;
    flags: Record<string, string | boolean | string[]>;
    rootId: string;
    requestedScope: Record<string, unknown>;
    resolvedScope: Record<string, unknown>;
  }> = [
    {
      name: "plain tree scope",
      pageRef: "111",
      flags: { scope: "tree", engine: "ts" },
      rootId: "111",
      requestedScope: { kind: "tree", pageRef: "111", completeness: "strict" },
      resolvedScope: { kind: "tree", rootPageId: "111", includeRoot: true },
    },
    {
      name: "tree scope with traversal + label flags",
      pageRef: "111",
      flags: {
        scope: "tree",
        engine: "ts",
        "max-depth": "2",
        "max-pages": "50",
        "max-folders": "5",
        "label-include": "public",
        "label-exclude": "internal",
      },
      rootId: "111",
      requestedScope: {
        kind: "tree",
        pageRef: "111",
        maxDepth: 2,
        maxPages: 50,
        maxFolders: 5,
        labels: { include: ["public"], exclude: ["internal"] },
        completeness: "strict",
      },
      resolvedScope: { kind: "tree", rootPageId: "111", includeRoot: true, maxDepth: 2 },
    },
    {
      name: "space scope resolves to a tree at the homepage (A5)",
      flags: { scope: "space", space: "DOCSY", engine: "ts" },
      rootId: "9001",
      requestedScope: { kind: "space", spaceKey: "DOCSY", completeness: "strict" },
      resolvedScope: { kind: "tree", rootPageId: "9001", includeRoot: true },
    },
    {
      name: "space scope with partial completeness and max-depth",
      flags: {
        scope: "space",
        space: "DOCSY",
        engine: "ts",
        completeness: "partial",
        "max-depth": "0",
      },
      rootId: "9001",
      requestedScope: {
        kind: "space",
        spaceKey: "DOCSY",
        maxDepth: 0,
        completeness: "partial",
      },
      resolvedScope: { kind: "tree", rootPageId: "9001", includeRoot: true, maxDepth: 0 },
    },
  ];

  for (const testCase of cases) {
    it(`reflects the request: ${testCase.name}`, () => {
      const request = parseExportRequest(testCase.pageRef, testCase.flags);
      const fields = buildScopeReportFields(request, buildExportScope(request, testCase.rootId));
      expect(fields.requestedScope).toEqual(testCase.requestedScope);
      expect(fields.resolvedScope).toEqual(testCase.resolvedScope);
      // Plain JSON — the report is serialized to stdout.
      expect(JSON.parse(JSON.stringify(fields))).toEqual(fields);
    });
  }

  it("returns a detached copy, so mutating the report cannot corrupt the scope", () => {
    const request = parseExportRequest("111", { scope: "tree", engine: "ts" });
    const exportScope = buildExportScope(request, "111");
    const fields = buildScopeReportFields(request, exportScope);
    (fields.resolvedScope as { rootPageId: string }).rootPageId = "tampered";
    expect(exportScope).toMatchObject({ rootPageId: "111" });
  });
});

describe("export report parity — PDF vs DOCX single-page scope", () => {
  /**
   * Single-page exports carry NO scope-traceability pair BY DESIGN — there is no
   * scope resolution to trace — but they must still be symmetric between the two
   * formats, and `complete` must still be present so `jq -r '.complete'` is never
   * null on a successful export.
   */
  it("emits the same field set, with `complete` present and no scope pair", async () => {
    const [pdfRun, docxRun] = await Promise.all([
      realPdfEngineReport(true),
      realDocxEngineReport(true),
    ]);
    assertRealArtifacts(pdfRun, docxRun);
    const pdfEngine = pdfRun.report;
    const docxEngine = docxRun.report;
    const { outputDetail } = pdfReportContributions(
      pdfEngine,
      "/tmp/page.pdf",
      pdfEngine.compilerDiagnostics ?? []
    );

    // Mirrors exportPdf()'s page-scope branch.
    const pdf = buildReport({
      format: "pdf",
      sourcePages: [{ id: "111", title: "Root", notes: [] }],
      outputDetails: [outputDetail],
      issues: ISSUES,
      timings: { ...pdfEngine.timings, totalMs: 1 },
      complete: pdfEngine.complete,
    });

    // Mirrors exportWithTsEngine()'s single-page report.
    const docx = buildReport({
      format: "docx",
      engine: "ts",
      sourcePages: [{ id: "111", title: "Root", notes: [] }],
      outputDetails: [
        {
          output: "/tmp/page.docx",
          embeddedImages: docxEngine.embeddedImages,
          renderedDiagrams: docxEngine.renderedDiagrams,
          skippedAssets: docxEngine.skippedImages,
        },
      ],
      issues: ISSUES,
      timings: { totalMs: docxEngine.durationMs },
      complete: docxEngine.complete,
      placeholders: {
        resolved: docxEngine.resolvedCount,
        unsupported: docxEngine.unsupportedNames,
      },
    });

    expect(symmetricDifference(Object.keys(pdf), Object.keys(docx))).toEqual(
      [...DOCX_ONLY_FIELDS].sort()
    );
    // `complete` present on both; scope pair absent from both (symmetric).
    expect(pdf.complete).toBe(true);
    expect(docx.complete).toBe(true);
    for (const report of [pdf, docx]) {
      expect(Object.keys(report)).not.toContain("requestedScope");
      expect(Object.keys(report)).not.toContain("resolvedScope");
    }
  }, 60_000);
});
