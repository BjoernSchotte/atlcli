import { describe, expect, it } from "bun:test";
import type {
  PdfCompileContext,
  PdfCompileResult,
  PdfExportReport,
  PdfSourceBundle,
} from "@atlcli/pdf/browser";
import { runPdfJobParityCase } from "../src/pdf-job-parity-case.js";
import { assertPdfJobParity, projectPdfReport } from "../src/pdf-job-parity.js";

const VALID_PDF = new TextEncoder().encode(
  "%PDF-1.7\n/Type/Page /Type/Catalog /Lang (en) /StructTreeRoot /MarkInfo /Outlines /FontFile2\n%%EOF\n",
);

class RecordingCompiler {
  workerGeneration = 0;
  compileCalls = 0;
  disposed = false;

  constructor(private readonly failure?: Error) {}

  async compile(
    _bundle: PdfSourceBundle,
    _context: PdfCompileContext = {},
  ): Promise<PdfCompileResult> {
    this.compileCalls += 1;
    this.workerGeneration = 1;
    if (this.failure) throw this.failure;
    return { pdf: VALID_PDF.slice(), diagnostics: [], compilerVersion: "typst-test" };
  }

  dispose(): void {
    this.disposed = true;
  }
}

function report(overrides: Partial<PdfExportReport> = {}): PdfExportReport {
  return {
    filename: "Parity.pdf",
    profile: "tagged",
    compilerVersion: "typst-test",
    pageCount: 2,
    embeddedImages: 1,
    renderedDiagrams: 1,
    skippedAssets: 0,
    notes: [
      {
        code: "unknown-macro",
        level: "warning",
        message: "host-specific wording",
        source: { pageId: "42", blockPath: "blocks[1]" },
      },
    ],
    sourceNotes: [],
    complete: true,
    compilerDiagnostics: [],
    timings: { prepareMs: 1, compileMs: 2, emitMs: 3, totalMs: 6 },
    ...overrides,
  };
}

describe("PDF direct-vs-job parity", () => {
  it("uses independent direct/job compilers and disposes both after success", async () => {
    const compilers: RecordingCompiler[] = [];
    const result = await runPdfJobParityCase({
      createCompiler: () => {
        const compiler = new RecordingCompiler();
        compilers.push(compiler);
        return compiler;
      },
    });

    expect(result).toMatchObject({ usedRealWorker: true, jobCompileCalls: 1 });
    expect(compilers).toHaveLength(2);
    expect(compilers.map((compiler) => compiler.compileCalls)).toEqual([1, 1]);
    expect(compilers.every((compiler) => compiler.disposed)).toBe(true);
  });

  it("disposes both compilers when the job compiler fails", async () => {
    const compilers: RecordingCompiler[] = [];
    await expect(runPdfJobParityCase({
      createCompiler: () => {
        const compiler = new RecordingCompiler(
          compilers.length === 1 ? new Error("job compiler failed") : undefined,
        );
        compilers.push(compiler);
        return compiler;
      },
    })).rejects.toThrow("job compiler failed");

    expect(compilers).toHaveLength(2);
    expect(compilers.every((compiler) => compiler.disposed)).toBe(true);
  });

  it("accepts exact bytes and ignores only host timing", () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const direct = report();
    const job = report({
      timings: { prepareMs: 40, compileMs: 50, emitMs: 60, totalMs: 150 },
    });

    expect(assertPdfJobParity({ bytes, report: direct }, { bytes: bytes.slice(), report: job })).toEqual({
      byteIdentical: true,
      reportIdentical: true,
      byteLength: 4,
      compilerVersion: "typst-test",
    });
  });

  it("rejects byte divergence with the first differing offset", () => {
    expect(() =>
      assertPdfJobParity(
        { bytes: new Uint8Array([1, 2, 3]), report: report() },
        { bytes: new Uint8Array([1, 9, 3]), report: report() },
      ),
    ).toThrow("offset 1");
  });

  it("rejects stable report and provenance divergence", () => {
    const direct = report();
    const job = report({
      notes: [{ ...direct.notes[0]!, source: { pageId: "99", blockPath: "blocks[1]" } }],
    });
    expect(() =>
      assertPdfJobParity(
        { bytes: new Uint8Array([1]), report: direct },
        { bytes: new Uint8Array([1]), report: job },
      ),
    ).toThrow("report diverged");
  });

  it("rejects note message divergence", () => {
    const direct = report();
    const job = report({ notes: [{ ...direct.notes[0]!, message: "different wording" }] });
    expect(() =>
      assertPdfJobParity(
        { bytes: new Uint8Array([1]), report: direct },
        { bytes: new Uint8Array([1]), report: job },
      ),
    ).toThrow("report diverged");
  });

  it("does not collapse an absent report field into an empty collection", () => {
    const direct = report({ sourceNotes: undefined });
    const job = report({ sourceNotes: [] });
    expect(() =>
      assertPdfJobParity(
        { bytes: new Uint8Array([1]), report: direct },
        { bytes: new Uint8Array([1]), report: job },
      ),
    ).toThrow("report diverged");
  });

  it("projects diagnostics including their prose", () => {
    const projected = projectPdfReport(report({
      compilerDiagnostics: [{
        severity: "warning",
        message: "compiler-specific prose",
        path: "main.typ",
        startLine: 7,
        blockPath: "blocks[2]",
      }],
    })) as { compilerDiagnostics: unknown[] };
    expect(projected.compilerDiagnostics).toEqual([{
      severity: "warning",
      message: "compiler-specific prose",
      path: "main.typ",
      startLine: 7,
      blockPath: "blocks[2]",
    }]);
  });
});
