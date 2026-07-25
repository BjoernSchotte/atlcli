import type { ExportNote, PdfCompilerDiagnostic, PdfExportReport } from "@atlcli/pdf/browser";

export interface PdfParityRun {
  bytes: Uint8Array;
  report: PdfExportReport;
}

export interface PdfJobParityResult {
  byteIdentical: true;
  reportIdentical: true;
  byteLength: number;
  compilerVersion: string;
}

interface ProjectedNote {
  code: string;
  level: string;
  message: string;
  macroName?: string;
  source?: {
    pageId?: string;
    pageTitle?: string;
    pageUrl?: string;
    blockPath?: string;
    assetName?: string;
  };
}

interface ProjectedDiagnostic {
  severity: string;
  message: string;
  path?: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  blockPath?: string;
}

/**
 * The engine-owned report contract used by direct-vs-job parity.
 *
 * Only timings are absent because they are host-dependent. Notes and compiler
 * diagnostics, including their messages and provenance, remain exact. The
 * projection is JSON-safe so a failed browser run can print both sides without
 * depending on Node inspection helpers.
 */
export function projectPdfReport(report: PdfExportReport): unknown {
  const note = (value: ExportNote): ProjectedNote => ({
    code: value.code,
    level: value.level,
    message: value.message,
    ...(value.macroName === undefined ? {} : { macroName: value.macroName }),
    ...(value.source === undefined ? {} : { source: { ...value.source } }),
  });
  const diagnostic = (value: PdfCompilerDiagnostic): ProjectedDiagnostic => ({
    severity: value.severity,
    message: value.message,
    ...(value.path === undefined ? {} : { path: value.path }),
    ...(value.startLine === undefined ? {} : { startLine: value.startLine }),
    ...(value.startColumn === undefined ? {} : { startColumn: value.startColumn }),
    ...(value.endLine === undefined ? {} : { endLine: value.endLine }),
    ...(value.endColumn === undefined ? {} : { endColumn: value.endColumn }),
    ...(value.blockPath === undefined ? {} : { blockPath: value.blockPath }),
  });
  return {
    filename: report.filename,
    codeTheme: report.codeTheme,
    profile: report.profile,
    compilerVersion: report.compilerVersion,
    ...(report.pageCount === undefined ? {} : { pageCount: report.pageCount }),
    embeddedImages: report.embeddedImages,
    renderedDiagrams: report.renderedDiagrams,
    skippedAssets: report.skippedAssets,
    complete: report.complete,
    notes: report.notes.map(note),
    ...(report.sourceNotes === undefined
      ? {}
      : { sourceNotes: report.sourceNotes.map(note) }),
    ...(report.compilerDiagnostics === undefined
      ? {}
      : { compilerDiagnostics: report.compilerDiagnostics.map(diagnostic) }),
  };
}

function firstByteDifference(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return length;
}

/** Fail closed unless a job execution reproduces the direct PDF contract. */
export function assertPdfJobParity(
  direct: PdfParityRun,
  job: PdfParityRun,
): PdfJobParityResult {
  if (
    direct.bytes.byteLength !== job.bytes.byteLength ||
    !direct.bytes.every((byte, index) => byte === job.bytes[index])
  ) {
    const offset = firstByteDifference(direct.bytes, job.bytes);
    throw new Error(
      `Job PDF bytes diverged from the direct path at offset ${offset} ` +
        `(direct ${direct.bytes.byteLength} bytes, job ${job.bytes.byteLength} bytes).`,
    );
  }

  const directReport = JSON.stringify(projectPdfReport(direct.report));
  const jobReport = JSON.stringify(projectPdfReport(job.report));
  if (directReport !== jobReport) {
    throw new Error(
      `Job PDF report diverged from the direct path. direct=${directReport} job=${jobReport}`,
    );
  }

  return {
    byteIdentical: true,
    reportIdentical: true,
    byteLength: direct.bytes.byteLength,
    compilerVersion: direct.report.compilerVersion,
  };
}
