/**
 * The shared, versioned export report + exit-code kernel (spec 008 T3.2/T3.4).
 *
 * This is the ONE report shape and the ONE error→exit-code mapping for
 * `atlcli wiki export`, consumed by both the PDF (`export-pdf.ts`) and the
 * ts DOCX (`export.ts`) paths. The export code path never calls `fail()` and
 * never lets an error propagate past its own boundary: it returns a typed
 * {@link ExportOutcome}, and exactly one call site turns that into stdout output
 * and the process exit code (`emitReportOutcome`).
 *
 * Pure and host-agnostic: no IO, no `process` reads, no network. Fully
 * unit-testable against real `PdfExportError`s and real Confluence errors.
 */
import { output, type OutputOptions } from "@atlcli/core";
import type { ExportNote, PdfExportReport } from "@atlcli/pdf";
import { PdfExportError, type PdfExportErrorPhase } from "@atlcli/pdf";
import type { PdfCompilerDiagnostic } from "@atlcli/pdf";

/** The stable report schema string. Additive changes only; breaking bumps this. */
export const EXPORT_REPORT_SCHEMA = "atlcli.export-report/1";

export type ExportFormat = "pdf" | "docx";
export type ExportReportEngine = "python" | "ts";

/**
 * Deterministic, documented exit codes (T3.4). Applied unconditionally for the
 * export command (a behavioral change from the old always-`1`, noted in the
 * CHANGELOG/docs).
 */
export const EXPORT_EXIT = {
  SUCCESS: 0,
  /** Usage / config / local IO error. */
  USAGE: 1,
  /** Completed, but a `warning`-severity issue exists and `--strict` was set. */
  STRICT_WARNINGS: 2,
  /** Authentication/authorization error (401/403). */
  AUTH: 3,
  /** Remote/API error: page not found, fetch failed, 4xx/5xx. */
  REMOTE: 4,
  /** Compile or validation failure. */
  COMPILE: 5,
  /** Cancelled via SIGINT. */
  CANCELLED: 130,
} as const;

export type ExportExitCode = (typeof EXPORT_EXIT)[keyof typeof EXPORT_EXIT];

/**
 * A single problem, reused across compose/fetch notes, PDF compiler
 * diagnostics, and asset warnings. `warnings`/`errors` in the report are
 * convenience views over `issues` filtered by severity — not a parallel shape.
 */
export interface Issue {
  code: string;
  severity: "error" | "warning";
  phase: string;
  retryable: boolean;
  message?: string;
  status?: number;
  sourcePageId?: string;
  path?: string;
  startLine?: number;
}

/** Provenance/fetch-and-compose status for one source page (no per-page metrics). */
export interface SourcePageEntry {
  id: string;
  title: string;
  notes: Issue[];
}

/** Per-compiled-artifact metrics (one entry per `outputs[]` path). */
export interface OutputDetail {
  output: string;
  pageCount?: number;
  embeddedImages: number;
  renderedDiagrams: number;
  skippedAssets: number;
}

export interface ExportReport {
  schema: typeof EXPORT_REPORT_SCHEMA;
  format: ExportFormat;
  engine?: ExportReportEngine;
  sourcePages: SourcePageEntry[];
  outputDetails: OutputDetail[];
  outputs: string[];
  issues: Issue[];
  warnings: Issue[];
  errors: Issue[];
  timings: Record<string, number>;
  exitCode: number;
}

/** The typed result of an export attempt — success or failure, always with a report. */
export type ExportOutcome =
  | { ok: true; report: ExportReport }
  | { ok: false; report: ExportReport };

/**
 * Project a compose/fetch {@link ExportNote} onto an {@link Issue}. The two-level
 * note model (`info | warning`) collapses to the report's `warning` severity:
 * any note means content was not rendered perfectly cleanly, so `--strict` CI
 * should see it (documented). Only classified thrown errors are `error`.
 */
export function noteToIssue(note: ExportNote, phase = "compose", sourcePageId?: string): Issue {
  return {
    code: note.code,
    severity: "warning",
    phase,
    retryable: false,
    ...(note.message ? { message: note.message } : {}),
    ...(sourcePageId ? { sourcePageId } : {}),
  };
}

/** Project a PDF compiler diagnostic onto an {@link Issue} (kept even on success). */
export function diagnosticToIssue(diagnostic: PdfCompilerDiagnostic): Issue {
  return {
    code: diagnostic.severity === "error" ? "pdf-compile-error" : "pdf-compile-warning",
    severity: diagnostic.severity,
    phase: "compile",
    retryable: false,
    message: diagnostic.message,
    ...(diagnostic.blockPath ? { path: diagnostic.blockPath } : diagnostic.path ? { path: diagnostic.path } : {}),
    ...(diagnostic.startLine !== undefined ? { startLine: diagnostic.startLine } : {}),
  };
}

/**
 * Extract an HTTP status from a Confluence error without trusting message text
 * alone: prefer a real `status`/`statusCode` property (T3.4), fall back to the
 * `Confluence API error (\d+)` shape the client currently throws.
 */
export function extractStatus(error: unknown): number | undefined {
  if (error && typeof error === "object") {
    const withStatus = error as { status?: unknown; statusCode?: unknown };
    if (typeof withStatus.status === "number") return withStatus.status;
    if (typeof withStatus.statusCode === "number") return withStatus.statusCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/Confluence API error \((\d+)\)/);
  return match ? Number(match[1]) : undefined;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

const PDF_PHASE_EXIT: Record<PdfExportErrorPhase, number> = {
  configuration: EXPORT_EXIT.USAGE,
  prepare: EXPORT_EXIT.REMOTE, // asset fetch / prepare is remote-dominated
  compile: EXPORT_EXIT.COMPILE,
  validate: EXPORT_EXIT.COMPILE,
  emit: EXPORT_EXIT.USAGE, // local filesystem write
};

/**
 * Classify any thrown error into an exit code + {@link Issue}, TOTAL over every
 * class. Auth (401/403) → 3; other 4xx/5xx and generic remote failures → 4;
 * PDF compile/validate → 5; abort → 130; anything unexpected → 4 so a JSON
 * report is still emitted rather than a plain crash.
 */
export function classifyError(error: unknown): { exitCode: number; issue: Issue } {
  if (isAbortError(error)) {
    return {
      exitCode: EXPORT_EXIT.CANCELLED,
      issue: { code: "cancelled", severity: "error", phase: "cancel", retryable: true, message: "Export cancelled." },
    };
  }

  const status = extractStatus(error);
  if (status === 401 || status === 403) {
    return {
      exitCode: EXPORT_EXIT.AUTH,
      issue: {
        code: "auth-error",
        severity: "error",
        phase: "fetch",
        retryable: false,
        status,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  if (error instanceof PdfExportError) {
    const exitCode = PDF_PHASE_EXIT[error.phase];
    // A prepare-phase failure that carries an HTTP status is remote; otherwise
    // use the phase mapping (compile/validate → 5, configuration/emit → 1).
    return {
      exitCode,
      issue: {
        code: `pdf-${error.phase}-error`,
        severity: "error",
        phase: error.phase,
        retryable: exitCode === EXPORT_EXIT.REMOTE,
        ...(status !== undefined ? { status } : {}),
        message: error.message,
      },
    };
  }

  if (status !== undefined) {
    return {
      exitCode: EXPORT_EXIT.REMOTE,
      issue: {
        code: "remote-error",
        severity: "error",
        phase: "fetch",
        retryable: status >= 500 || status === 429,
        status,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  return {
    exitCode: EXPORT_EXIT.REMOTE,
    issue: {
      code: "unexpected-error",
      severity: "error",
      phase: "unknown",
      retryable: false,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

export interface BuildReportInput {
  format: ExportFormat;
  engine?: ExportReportEngine;
  sourcePages: SourcePageEntry[];
  outputDetails: OutputDetail[];
  issues: Issue[];
  timings?: Record<string, number>;
  /** Under `--strict`, a warning-severity issue trips exit code 2. */
  strict?: boolean;
  /** Set on the failure path; overrides the success/strict exit computation. */
  failureExitCode?: number;
}

/**
 * Assemble the final {@link ExportReport}, deriving `warnings`/`errors` views and
 * the exit code. Success is `0`; `--strict` with any warning is `2`; a failure
 * uses the classified `failureExitCode`.
 */
export function buildReport(input: BuildReportInput): ExportReport {
  const issues = input.issues;
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const errors = issues.filter((issue) => issue.severity === "error");

  let exitCode: number;
  if (input.failureExitCode !== undefined) {
    exitCode = input.failureExitCode;
  } else if (input.strict && warnings.length > 0) {
    exitCode = EXPORT_EXIT.STRICT_WARNINGS;
  } else {
    exitCode = EXPORT_EXIT.SUCCESS;
  }

  return {
    schema: EXPORT_REPORT_SCHEMA,
    format: input.format,
    ...(input.engine ? { engine: input.engine } : {}),
    sourcePages: input.sourcePages,
    outputDetails: input.outputDetails,
    outputs: input.outputDetails.map((detail) => detail.output),
    issues,
    warnings,
    errors,
    timings: input.timings ?? {},
    exitCode,
  };
}

/** One-line human summary for text mode (stdout stays clean for `--report json`). */
export function summarizeReport(report: ExportReport): string {
  if (report.exitCode !== EXPORT_EXIT.SUCCESS && report.exitCode !== EXPORT_EXIT.STRICT_WARNINGS) {
    const first = report.errors[0];
    return `Export failed (exit ${report.exitCode})${first?.message ? `: ${first.message}` : "."}`;
  }
  const detail = report.outputDetails[0];
  const parts = [
    `Exported ${report.format.toUpperCase()}`,
    report.outputs[0] ? `→ ${report.outputs[0]}` : "",
    `(${report.sourcePages.length} page${report.sourcePages.length === 1 ? "" : "s"}`,
    detail ? `, ${detail.embeddedImages} image${detail.embeddedImages === 1 ? "" : "s"}` : "",
    detail?.pageCount !== undefined ? `, ${detail.pageCount} PDF page${detail.pageCount === 1 ? "" : "s"}` : "",
    ")",
  ];
  let line = parts.filter(Boolean).join(" ").replace(" ,", ",").replace("( ", "(");
  if (report.warnings.length > 0) line += ` — ${report.warnings.length} warning${report.warnings.length === 1 ? "" : "s"}`;
  return line;
}

/**
 * The SINGLE call site that turns an {@link ExportOutcome} into stdout output and
 * the process exit code. Never called from inside the export pipeline — only the
 * command entry point calls this. In `--json`/`--report json` mode it emits the
 * `atlcli.export-report/1` object as the sole stdout document; in text mode a
 * summary line (and a stderr error message on failure). Does not return.
 */
export function emitReportOutcome(outcome: ExportOutcome, opts: OutputOptions): never {
  const { report } = outcome;
  if (opts.json) {
    output(report, opts);
  } else if (outcome.ok) {
    output(summarizeReport(report), opts);
  } else {
    process.stderr.write(`${summarizeReport(report)}\n`);
  }
  process.exit(report.exitCode);
}

/**
 * Turn a successful {@link PdfExportReport} into the report's issues +
 * output-detail entry. Crucially includes compiler diagnostics captured on a
 * SUCCESSFUL compile (so `--strict` is not a no-op for that whole class) and the
 * prepare-phase asset skip notes.
 */
export function pdfReportContributions(
  report: PdfExportReport,
  outputPath: string,
  compilerDiagnostics: PdfCompilerDiagnostic[] = []
): { outputDetail: OutputDetail; issues: Issue[] } {
  const issues: Issue[] = [
    ...report.notes.map((note) => noteToIssue(note, "prepare")),
    ...compilerDiagnostics.map(diagnosticToIssue),
  ];
  return {
    outputDetail: {
      output: outputPath,
      ...(report.pageCount !== undefined ? { pageCount: report.pageCount } : {}),
      embeddedImages: report.embeddedImages,
      renderedDiagrams: report.renderedDiagrams,
      skippedAssets: report.skippedAssets,
    },
    issues,
  };
}
