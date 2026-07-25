import { beforeAll, describe, expect, it } from "bun:test";
import Ajv from "ajv";
import {
  AssetBudgetExceededError,
  ExportCompletenessError,
  LabelFilterError,
  PaginationLoopError,
  SpaceHomepageError,
  TreeLimitExceededError,
} from "@atlcli/confluence";
import {
  runPdfExport,
  type ExportBlock,
  type PdfCompilePort,
  type PdfCompilerDiagnostic,
  type PdfExportMetadata,
  type PdfBytesHandle,
  type PdfOutputSink,
} from "@atlcli/pdf";
import { ensurePdfFonts } from "../../../../packages/pdf/scripts/ensure-fonts.js";
import { getPdfCompiler } from "./export-pdf-assets.js";
import {
  EXPORT_EXIT,
  EXPORT_REPORT_SCHEMA,
  buildReport,
  classifyError,
  diagnosticToIssue,
  extractStatus,
  noteToIssue,
  pdfReportContributions,
} from "./export-report.js";

beforeAll(async () => {
  await ensurePdfFonts({ logger: () => {} });
});

const BLOCKS: ExportBlock[] = [
  { type: "heading", level: 1, content: [{ type: "text", text: "Report smoke" }] },
  { type: "paragraph", content: [{ type: "text", text: "Body text." }] },
];
const METADATA: PdfExportMetadata = {
  title: "Report smoke",
  space: "DOCSY",
  exportedAt: new Date("2026-07-19T00:00:00Z"),
};

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

/** Real compiler wrapper that prepends invalid Typst — real wasm, real diagnostics. */
function brokenCompiler(inner: PdfCompilePort): PdfCompilePort {
  return {
    compile(bundle, context) {
      return inner.compile({ ...bundle, main: `#this-does-not-exist()\n${bundle.main}` }, context);
    },
  };
}

describe("export-report kernel (spec 008 T3.2/T3.4)", () => {
  it("builds a v1 report from a real successful runPdfExport", async () => {
    const compiler = await getPdfCompiler();
    const report = await runPdfExport(
      { blocks: BLOCKS, metadata: METADATA, filename: "out.pdf" },
      { assets: noAssets, compiler, output: new MemorySink() }
    );
    // Regression: diagnostics are surfaced even on a clean compile (empty here).
    expect(report.compilerDiagnostics).toEqual([]);

    const { outputDetail, issues } = pdfReportContributions(report, "/tmp/out.pdf", report.compilerDiagnostics);
    const built = buildReport({
      format: "pdf",
      sourcePages: [{ id: "1", title: "Report smoke", notes: [] }],
      outputDetails: [outputDetail],
      issues,
    });
    expect(built.schema).toBe(EXPORT_REPORT_SCHEMA);
    expect(built.format).toBe("pdf");
    expect(built.outputs).toEqual(["/tmp/out.pdf"]);
    // Per-artifact metrics live in outputDetails, not per-sourcePages fields.
    expect(built.outputDetails[0]).toMatchObject({
      output: "/tmp/out.pdf",
      embeddedImages: 0,
      renderedDiagrams: 0,
      skippedAssets: 0,
    });
    expect(built.outputDetails[0]!.pageCount).toBeGreaterThanOrEqual(1);
    expect(built.exitCode).toBe(EXPORT_EXIT.SUCCESS);
  }, 30_000);

  it("maps a REAL compile-phase PdfExportError to exit code 5", async () => {
    const compiler = brokenCompiler(await getPdfCompiler());
    let thrown: unknown;
    try {
      await runPdfExport(
        { blocks: BLOCKS, metadata: METADATA, filename: "out.pdf" },
        { assets: noAssets, compiler, output: new MemorySink() }
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    const { exitCode, issue } = classifyError(thrown);
    expect(exitCode).toBe(EXPORT_EXIT.COMPILE);
    expect(issue.phase).toBe("compile");
    expect(issue.severity).toBe("error");
  }, 30_000);

  it("classifies live-shaped Confluence errors by HTTP status", () => {
    // The exact message shape ConfluenceClient throws (client.ts:411).
    expect(classifyError(new Error("Confluence API error (403): forbidden")).exitCode).toBe(EXPORT_EXIT.AUTH);
    expect(classifyError(new Error("Confluence API error (401): unauthorized")).exitCode).toBe(EXPORT_EXIT.AUTH);
    expect(classifyError(new Error("Confluence API error (404): not found")).exitCode).toBe(EXPORT_EXIT.REMOTE);
    expect(classifyError(new Error("Confluence API error (503): down")).exitCode).toBe(EXPORT_EXIT.REMOTE);
    // Prefer a real status property when present.
    const withStatus = Object.assign(new Error("nope"), { status: 403 });
    expect(classifyError(withStatus).exitCode).toBe(EXPORT_EXIT.AUTH);
    expect(extractStatus(new Error("Confluence API error (429): slow down"))).toBe(429);
  });

  it("maps an AbortError to exit code 130", () => {
    const abort = new DOMException("cancelled", "AbortError");
    expect(classifyError(abort).exitCode).toBe(EXPORT_EXIT.CANCELLED);
  });

  it("validates against the checked-in JSON Schema with ajv (strict, additionalProperties)", async () => {
    const schema = JSON.parse(await Bun.file(new URL("./export-report.schema.json", import.meta.url)).text());
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);

    // PDF-shaped success report.
    const pdfReport = buildReport({
      format: "pdf",
      sourcePages: [{ id: "1", title: "P", notes: [] }],
      outputDetails: [{ output: "/tmp/x.pdf", pageCount: 2, embeddedImages: 1, renderedDiagrams: 0, skippedAssets: 0 }],
      issues: [{ code: "c", severity: "warning", phase: "prepare", retryable: false }],
      strict: false,
    });
    expect(validate(pdfReport) ? [] : validate.errors).toEqual([]);

    // DOCX-shaped tree report carrying the 002 fields WITHIN the unified schema.
    const docxReport = buildReport({
      format: "docx",
      engine: "ts",
      sourcePages: [
        { id: "1", title: "Root", notes: [] },
        { id: "2", title: "Child", notes: [{ code: "label-filtered", severity: "warning", phase: "compose", retryable: false }] },
      ],
      outputDetails: [{ output: "/tmp/tree.docx", embeddedImages: 3, renderedDiagrams: 1, skippedAssets: 0 }],
      issues: [{ code: "label-filtered", severity: "warning", phase: "compose", retryable: false }],
      requestedScope: { kind: "space", spaceKey: "DOCSY", completeness: "strict" },
      resolvedScope: { kind: "tree", rootPageId: "1", includeRoot: true },
      complete: true,
      placeholders: { resolved: 12, unsupported: ["$scroll.unknown"] },
      strict: false,
    });
    expect(validate(docxReport) ? [] : validate.errors).toEqual([]);
    expect(docxReport.schema).toBe(EXPORT_REPORT_SCHEMA);
    expect(docxReport.notesByCode).toEqual({ "label-filtered": 1 });
    expect(docxReport.outputs).toEqual(["/tmp/tree.docx"]);

    // Removing an engine must not retroactively invalidate archived documents
    // under the unchanged, additive-only /1 schema. Current producer types stay
    // narrowed to "ts"; this fixture deliberately models historical JSON.
    const historicalPythonReport = { ...docxReport, engine: "python" };
    expect(
      validate(historicalPythonReport) ? [] : validate.errors,
      "atlcli.export-report/1 must keep accepting historical Python reports",
    ).toEqual([]);

    // An `info`-severity issue (an engine note with level "info") is part of the
    // /1 contract too — the schema's severity enum must accept it.
    const withInfo = buildReport({
      format: "docx",
      engine: "ts",
      sourcePages: [{ id: "1", title: "Root", notes: [noteToIssue({ level: "info", code: "perf-timing", message: "Timing: 1 ms total" }, "prepare", "1")] }],
      outputDetails: [{ output: "/tmp/i.docx", embeddedImages: 0, renderedDiagrams: 0, skippedAssets: 0 }],
      issues: [noteToIssue({ level: "info", code: "perf-timing", message: "Timing: 1 ms total" }, "prepare")],
      strict: true,
    });
    expect(validate(withInfo) ? [] : validate.errors).toEqual([]);
    expect(withInfo.issues[0]!.severity).toBe("info");
    expect(withInfo.exitCode).toBe(EXPORT_EXIT.SUCCESS);

    // ajv actually REJECTS malformed documents (proves this is a real check).
    expect(validate({ ...pdfReport, extraneous: true })).toBe(false);
    expect(validate({ ...pdfReport, exitCode: 42 })).toBe(false);
    expect(validate({ ...pdfReport, issues: [{ code: "c", severity: "nope", phase: "p", retryable: false }] })).toBe(false);
  });

  it("classifies the typed @atlcli/confluence errors per the unified exit-code table", () => {
    const cases: Array<{ error: unknown; exitCode: number; code: string }> = [
      // Validation-class → 5 (compile/validation failure).
      { error: new TreeLimitExceededError("max-pages", 500), exitCode: EXPORT_EXIT.COMPILE, code: "max-pages" },
      { error: new TreeLimitExceededError("max-folders", 200), exitCode: EXPORT_EXIT.COMPILE, code: "max-folders" },
      { error: new LabelFilterError("empty-include-result", "nothing matched"), exitCode: EXPORT_EXIT.COMPILE, code: "empty-include-result" },
      {
        error: new AssetBudgetExceededError([{ filename: "huge.png", pageId: "9", sizeBytes: 60_000_000 }], 60_000_000, 50_000_000),
        exitCode: EXPORT_EXIT.COMPILE,
        code: "asset-budget-exceeded",
      },
      // Remote/API-state → 4.
      { error: new SpaceHomepageError("DOCSY"), exitCode: EXPORT_EXIT.REMOTE, code: "space-homepage-missing" },
      { error: new ExportCompletenessError("page-unreadable", [{ id: "1", title: "Secret" }]), exitCode: EXPORT_EXIT.REMOTE, code: "page-unreadable" },
      { error: new PaginationLoopError("cursor-abc"), exitCode: EXPORT_EXIT.REMOTE, code: "pagination-loop" },
    ];
    for (const c of cases) {
      const { exitCode, issue } = classifyError(c.error);
      expect(exitCode).toBe(c.exitCode);
      expect(issue.code).toBe(c.code);
      expect(issue.severity).toBe("error");
    }
    // Structured payloads survive into issue.details.
    const budget = classifyError(new AssetBudgetExceededError([{ filename: "a.png", sizeBytes: 10 }], 10, 5));
    expect(budget.issue.details).toMatchObject({ totalBytes: 10, limitBytes: 5 });
    const completeness = classifyError(new ExportCompletenessError("subtree-unreadable", [{ id: "1", title: "A" }]));
    expect(completeness.issue.details).toEqual({ affected: [{ id: "1", title: "A" }] });
  });

  it("keeps exit codes 3/4/5/130 reachable from the DOCX failure boundary", () => {
    // The exact classes the DOCX ts paths route through classifyError.
    expect(classifyError(new Error("Confluence API error (401): no")).exitCode).toBe(EXPORT_EXIT.AUTH);
    expect(classifyError(new Error("Confluence API error (500): down")).exitCode).toBe(EXPORT_EXIT.REMOTE);
    expect(classifyError(new LabelFilterError("empty-include-result", "x")).exitCode).toBe(EXPORT_EXIT.COMPILE);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classifyError(abort).exitCode).toBe(EXPORT_EXIT.CANCELLED);
    // Non-Error throw still classifies (TOTAL mapping, single-document contract).
    expect(classifyError("catastrophe").exitCode).toBe(EXPORT_EXIT.REMOTE);
  });

  it("preserves engine ExportNote codes through noteToIssue into issues + notesByCode (spec 005)", () => {
    // The DOCX ts path maps every engine ExportNote to an Issue via noteToIssue;
    // spec 005's include note codes must survive verbatim so `--json` consumers
    // (and this plan's own E2E acceptance) can assert on `code` — the report
    // kernel from 008 already carries it, this pins that it does not regress.
    const notes = [
      { level: "warning" as const, code: "includepage-cycle" as const, message: "a page cannot include itself" },
      { level: "info" as const, code: "includepage-ambiguous-title" as const, message: "matched 3 pages" },
    ];
    const issues = notes.map((n) => noteToIssue(n, "prepare"));
    expect(issues.map((i) => i.code)).toEqual(["includepage-cycle", "includepage-ambiguous-title"]);
    const report = buildReport({
      format: "docx",
      engine: "ts",
      sourcePages: [{ id: "1", title: "Root", notes: [] }],
      outputDetails: [{ output: "/tmp/out.docx", embeddedImages: 0, renderedDiagrams: 0, skippedAssets: 0 }],
      issues,
    });
    // BOTH codes are tallied regardless of severity — an informational note is
    // still fully reported, it just is not a warning.
    expect(report.notesByCode).toEqual({ "includepage-cycle": 1, "includepage-ambiguous-title": 1 });
    expect(report.warnings.map((w) => w.code)).toContain("includepage-cycle");
  });

  it("maps note LEVEL onto issue severity instead of flattening everything to warning", () => {
    // The defect: `noteToIssue` hard-coded `severity: "warning"`, so the
    // unconditional `perf-timing` note (level "info", appended to every ts DOCX
    // export) made a clean export exit 2 under --strict while the PDF path,
    // which emits no such note, exited 0.
    const info = noteToIssue({ level: "info", code: "perf-timing", message: "Timing: 12 ms total" }, "prepare");
    const warning = noteToIssue({ level: "warning", code: "image-unresolved", message: "no such attachment" }, "compose");
    expect(info.severity).toBe("info");
    expect(warning.severity).toBe("warning");
    // Everything else about the projection is unchanged.
    expect(info).toEqual({
      code: "perf-timing",
      severity: "info",
      phase: "prepare",
      retryable: false,
      message: "Timing: 12 ms total",
    });

    // …and that severity is what --strict reads.
    const base = {
      format: "docx" as const,
      engine: "ts" as const,
      sourcePages: [{ id: "1", title: "Root", notes: [] }],
      outputDetails: [{ output: "/tmp/out.docx", embeddedImages: 0, renderedDiagrams: 0, skippedAssets: 0 }],
      strict: true,
    };
    const clean = buildReport({ ...base, issues: [info] });
    expect(clean.exitCode).toBe(EXPORT_EXIT.SUCCESS);
    expect(clean.warnings).toEqual([]);
    // The info note did NOT vanish — it is visible in issues and notesByCode.
    expect(clean.issues).toHaveLength(1);
    expect(clean.notesByCode).toEqual({ "perf-timing": 1 });

    const dirty = buildReport({ ...base, issues: [info, warning] });
    expect(dirty.exitCode).toBe(EXPORT_EXIT.STRICT_WARNINGS);
    expect(dirty.warnings.map((w) => w.code)).toEqual(["image-unresolved"]);
  });

  it("trips --strict on an error-severity issue that reached a SUCCESS report", () => {
    // A compiler diagnostic captured on a compile that still produced bytes has
    // severity "error" but no failureExitCode. Exiting 0 for it under --strict
    // would be the same false-negative in the other direction.
    const issue = diagnosticToIssue({ severity: "error", message: "bad glyph", path: "/main.typ" });
    const strict = buildReport({
      format: "pdf",
      sourcePages: [],
      outputDetails: [],
      issues: [issue],
      strict: true,
    });
    expect(strict.errors).toHaveLength(1);
    expect(strict.exitCode).toBe(EXPORT_EXIT.STRICT_WARNINGS);
  });

  it("folds a compiler warning into issues and trips exit 2 under --strict", () => {
    const diagnostic: PdfCompilerDiagnostic = {
      severity: "warning",
      message: "layout did not converge",
      path: "/main.typ",
      startLine: 3,
    };
    const issue = diagnosticToIssue(diagnostic);
    expect(issue.severity).toBe("warning");
    expect(issue.phase).toBe("compile");

    const strict = buildReport({
      format: "pdf",
      sourcePages: [],
      outputDetails: [],
      issues: [issue],
      strict: true,
    });
    expect(strict.warnings).toHaveLength(1);
    expect(strict.exitCode).toBe(EXPORT_EXIT.STRICT_WARNINGS);

    // Without --strict, the same warning is exit 0.
    const lenient = buildReport({ format: "pdf", sourcePages: [], outputDetails: [], issues: [issue] });
    expect(lenient.exitCode).toBe(EXPORT_EXIT.SUCCESS);
  });
});
