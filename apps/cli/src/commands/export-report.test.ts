import { beforeAll, describe, expect, it } from "bun:test";
import {
  runPdfExport,
  type ExportBlock,
  type PdfCompilePort,
  type PdfCompilerDiagnostic,
  type PdfExportMetadata,
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
  async emit(_name: string, bytes: Uint8Array): Promise<void> {
    this.bytes = bytes;
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
