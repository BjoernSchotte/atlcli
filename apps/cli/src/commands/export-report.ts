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
import {
  AssetBudgetExceededError,
  ExportCompletenessError,
  LabelFilterError,
  PaginationLoopError,
  SpaceHomepageError,
  TreeLimitExceededError,
} from "@atlcli/confluence";
import type { ExportNote, PdfExportReport } from "@atlcli/pdf";
import { PdfExportError, type PdfExportErrorPhase } from "@atlcli/pdf";
import type { PdfCompilerDiagnostic } from "@atlcli/pdf";

/** The stable report schema string. Additive changes only; breaking bumps this. */
export const EXPORT_REPORT_SCHEMA = "atlcli.export-report/1";

export type ExportFormat = "pdf" | "docx";

/**
 * The engine named in a DOCX report. One value since the Python exporter was
 * removed; the field survives because `atlcli.export-report/1` is a published
 * contract and dropping a key consumers already read would force a schema bump
 * for no gain. Narrowing the enum is the compatible half of that change: no
 * producer ever emits anything but `"ts"` now.
 */
export type ExportReportEngine = "ts";

/**
 * Deterministic, documented exit codes (T3.4). Applied unconditionally for the
 * export command (a behavioral change from the old always-`1`, noted in the
 * CHANGELOG/docs).
 */
export const EXPORT_EXIT = {
  SUCCESS: 0,
  /** Usage / config / local IO error. */
  USAGE: 1,
  /**
   * Completed, but a `warning`- or `error`-severity issue exists and `--strict`
   * was set. `info`-severity issues NEVER trip this — see {@link noteToIssue}.
   */
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
 * How bad an {@link Issue} is. Three values, mirroring the two engine note
 * levels (`info | warning`) plus the `error` reserved for classified throws:
 *
 * - `error`   — the export failed, or a compiler diagnostic says the artifact is
 *               wrong. Only {@link classifyError}/{@link diagnosticToIssue} mint these.
 * - `warning` — the export completed but something is not right in the output
 *               (an image did not embed, a link did not resolve). Trips `--strict`.
 * - `info`    — an observation about a correct export (timings, a label filter
 *               doing exactly what was asked). Reported, never a build failure.
 */
export type IssueSeverity = "error" | "warning" | "info";

/**
 * A single problem, reused across compose/fetch notes, PDF compiler
 * diagnostics, and asset warnings. `warnings`/`errors` in the report are
 * convenience views over `issues` filtered by severity — not a parallel shape.
 * There is deliberately no `infos` view: informational issues are readable off
 * `issues[]`/`notesByCode` and adding a fourth array would change the report's
 * top-level field set for every consumer.
 */
export interface Issue {
  code: string;
  severity: IssueSeverity;
  phase: string;
  retryable: boolean;
  message?: string;
  status?: number;
  sourcePageId?: string;
  path?: string;
  startLine?: number;
  /** Structured payload for typed errors (affected pages, budget offenders, …). */
  details?: Record<string, unknown>;
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
  /**
   * Scope traceability (spec 002 report content, carried WITHIN the unified
   * schema): the scope as requested by flags, and as resolved (e.g. a `space`
   * request resolved to a tree rooted at the homepage id).
   */
  requestedScope?: Record<string, unknown>;
  resolvedScope?: Record<string, unknown>;
  /** False when the composed document omitted content (partial mode). */
  complete?: boolean;
  /** Convenience per-code counts over `issues` (spec 002). */
  notesByCode?: Record<string, number>;
  /** DOCX ts-engine placeholder metrics (spec 006). */
  placeholders?: { resolved: number; unsupported: string[] };
}

/** The typed result of an export attempt — success or failure, always with a report. */
export type ExportOutcome =
  | { ok: true; report: ExportReport }
  | { ok: false; report: ExportReport };

/**
 * The note-level → issue-severity mapping. Faithful and total: the engines'
 * `ExportNote["level"]` vocabulary (`info | warning`) maps 1:1 onto the matching
 * {@link IssueSeverity} members. `error` is unreachable from a note by design —
 * a note is by definition non-fatal, so only {@link classifyError} (thrown
 * errors) and {@link diagnosticToIssue} (compiler diagnostics) mint one.
 *
 * Typed as a `Record` over `ExportNote["level"]` on purpose: if an engine ever
 * adds a third level, this stops compiling instead of silently defaulting.
 */
const NOTE_LEVEL_SEVERITY: Record<ExportNote["level"], IssueSeverity> = {
  info: "info",
  warning: "warning",
};

/**
 * Project a compose/fetch {@link ExportNote} onto an {@link Issue}, HONOURING
 * `note.level`.
 *
 * This used to hard-code `severity: "warning"` on the theory that "any note
 * means content was not rendered perfectly cleanly". That was wrong, and it made
 * `--strict` unusable: `packages/docx/src/export.ts` appends a `perf-timing`
 * note (`level: "info"`) to EVERY ts DOCX export, so a completely clean export
 * reported one warning and exited `2` under `--strict`, while the PDF path —
 * which has no such note — exited `0`. Same input, same request, two exit codes.
 *
 * The flattening was never `perf-timing`-specific: every `level: "info"` note in
 * the codebase was promoted, including `label-filtered` (a label filter doing
 * exactly what `--label-exclude` asked for), `macro-rendered-via` (a macro that
 * rendered SUCCESSFULLY) and `placeholder-substituted`. Those are observations
 * about a correct export, not defects in it, so none of them fail a build any
 * more. They remain fully visible in `issues[]` and `notesByCode`.
 */
export function noteToIssue(note: ExportNote, phase = "compose", sourcePageId?: string): Issue {
  return {
    code: note.code,
    severity: NOTE_LEVEL_SEVERITY[note.level],
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
 * class — the ONE mapping shared by the PDF and DOCX(ts) paths. Auth (401/403)
 * → 3; typed validation errors (tree limits, label filters, asset budget) and
 * PDF compile/validate → 5; remote/API-state errors (completeness, homepage
 * missing, pagination loop, 4xx/5xx) → 4; abort → 130; anything unexpected → 4
 * so a JSON report is still emitted rather than a plain crash.
 */
export function classifyError(error: unknown): { exitCode: number; issue: Issue } {
  if (isAbortError(error)) {
    return {
      exitCode: EXPORT_EXIT.CANCELLED,
      issue: { code: "cancelled", severity: "error", phase: "cancel", retryable: true, message: "Export cancelled." },
    };
  }

  // Typed errors from @atlcli/confluence (spec 002) — structured payloads ride
  // in `details` so the report keeps the affected/offender lists.
  if (error instanceof TreeLimitExceededError) {
    return {
      exitCode: EXPORT_EXIT.COMPILE,
      issue: { code: error.code, severity: "error", phase: "fetch", retryable: false, message: error.message, details: { limit: error.limit } },
    };
  }
  if (error instanceof LabelFilterError) {
    return {
      exitCode: EXPORT_EXIT.COMPILE,
      issue: { code: error.code, severity: "error", phase: "fetch", retryable: false, message: error.message },
    };
  }
  if (error instanceof AssetBudgetExceededError) {
    return {
      exitCode: EXPORT_EXIT.COMPILE,
      issue: {
        code: "asset-budget-exceeded",
        severity: "error",
        phase: "prepare",
        retryable: false,
        message: error.message,
        details: {
          totalBytes: error.totalBytes,
          limitBytes: error.limitBytes,
          offenders: error.offenders.map((o) => ({ ...o })),
        },
      },
    };
  }
  if (error instanceof ExportCompletenessError) {
    return {
      exitCode: EXPORT_EXIT.REMOTE,
      issue: {
        code: error.code,
        severity: "error",
        phase: "fetch",
        retryable: false,
        message: error.message,
        details: { affected: error.affected.map((a) => ({ id: a.id, title: a.title })) },
      },
    };
  }
  if (error instanceof SpaceHomepageError) {
    return {
      exitCode: EXPORT_EXIT.REMOTE,
      issue: { code: "space-homepage-missing", severity: "error", phase: "fetch", retryable: false, message: error.message, details: { spaceKey: error.spaceKey } },
    };
  }
  if (error instanceof PaginationLoopError) {
    return {
      exitCode: EXPORT_EXIT.REMOTE,
      issue: {
        code: error.code,
        severity: "error",
        phase: "fetch",
        retryable: true,
        message: `${error.message} This usually indicates a Confluence server pagination bug; re-run, and report the issue if it persists.`,
        details: { token: error.token },
      },
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
  /**
   * Under `--strict`, a warning- OR error-severity issue trips exit code 2.
   * Informational issues never do — that is the whole point of the severity.
   */
  strict?: boolean;
  /** Set on the failure path; overrides the success/strict exit computation. */
  failureExitCode?: number;
  /** Scope traceability (spec 002 content carried within the unified schema). */
  requestedScope?: Record<string, unknown>;
  resolvedScope?: Record<string, unknown>;
  complete?: boolean;
  /** DOCX ts-engine placeholder metrics. */
  placeholders?: { resolved: number; unsupported: string[] };
}

/**
 * Assemble the final {@link ExportReport}, deriving `warnings`/`errors` views and
 * the exit code. Success is `0`; `--strict` with any warning or error is `2`; a
 * failure uses the classified `failureExitCode`.
 *
 * `--strict` counts warnings AND errors, never `info`. Errors are in because an
 * error-severity issue can reach a SUCCESS report without a `failureExitCode` —
 * a compiler diagnostic captured on a compile that nonetheless produced bytes
 * (`pdfReportContributions`) — and `--strict` silently returning `0` for one
 * would be the same class of bug in the other direction.
 */
export function buildReport(input: BuildReportInput): ExportReport {
  const issues = input.issues;
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const errors = issues.filter((issue) => issue.severity === "error");

  let exitCode: number;
  if (input.failureExitCode !== undefined) {
    exitCode = input.failureExitCode;
  } else if (input.strict && warnings.length + errors.length > 0) {
    exitCode = EXPORT_EXIT.STRICT_WARNINGS;
  } else {
    exitCode = EXPORT_EXIT.SUCCESS;
  }

  const notesByCode: Record<string, number> = {};
  for (const issue of issues) {
    notesByCode[issue.code] = (notesByCode[issue.code] ?? 0) + 1;
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
    ...(input.requestedScope ? { requestedScope: input.requestedScope } : {}),
    ...(input.resolvedScope ? { resolvedScope: input.resolvedScope } : {}),
    ...(input.complete !== undefined ? { complete: input.complete } : {}),
    ...(issues.length > 0 ? { notesByCode } : {}),
    ...(input.placeholders ? { placeholders: input.placeholders } : {}),
  };
}

/**
 * Input for {@link buildTreeExportReport}. Identical to {@link BuildReportInput}
 * except that the three spec-002 tree fields are REQUIRED rather than optional —
 * that is the whole point of the type.
 */
export interface TreeExportReportInput
  extends Omit<BuildReportInput, "complete" | "requestedScope" | "resolvedScope"> {
  /**
   * Spec 002's completeness contract. REQUIRED: its DoD says the report carries
   * `complete: boolean` at the top level so a CI consumer can tell a full export
   * from a partial one, and `jq -r '.complete'` must never yield null.
   */
  complete: boolean;
  /**
   * Spec 002 A5 scope traceability, from `buildScopeReportFields`. REQUIRED so a
   * `--scope space` request that resolved to a tree at the homepage id stays
   * traceable in the report.
   */
  scope: { requestedScope: Record<string, unknown>; resolvedScope: Record<string, unknown> };
}

/**
 * Assemble the success report for a `--scope tree|space` export — the ONE site
 * that decides which spec-002 fields a tree/space export carries, used by BOTH
 * the PDF (`export-pdf.ts`) and DOCX ts (`export.ts`) paths.
 *
 * Why this exists rather than each path calling {@link buildReport} directly:
 * `complete`/`requestedScope`/`resolvedScope` are optional on
 * {@link BuildReportInput} (single-page exports legitimately omit the scope
 * pair), so a tree path could — and the PDF path did — silently forget them and
 * still typecheck. Making them REQUIRED here turns that report-contract gap into
 * a compile error instead of a field a `--json` consumer discovers is missing.
 *
 * Format-specific extras (`engine`, `placeholders`) stay pass-through: they are
 * documented DOCX-ts-only fields, not part of the shared scope contract.
 */
export function buildTreeExportReport(input: TreeExportReportInput): ExportReport {
  const { scope, ...rest } = input;
  return buildReport({
    ...rest,
    requestedScope: scope.requestedScope,
    resolvedScope: scope.resolvedScope,
  });
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
