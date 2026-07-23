import {
  createEmptyExportJobStatsV1,
  type ExportIssueSourceV1,
  type ExportJobEventDraftV1,
  type ExportJobResultTelemetryV1,
  type ExportJobStatsV1,
  type ExportReportSummaryV1,
} from "@atlcli/export-jobs";
import type { ExportNote } from "@atlcli/confluence";

export interface ProductiveExportTelemetryInputV1 {
  pageCount: number;
  preparedBytes: number;
  outputBytes: number;
  renderAttempts: number;
  embeddedAssets: number;
  skippedAssets: number;
  renderedDiagrams: number;
  reportSummary: ExportReportSummaryV1;
  notes: readonly ExportNote[];
  compilerIssues?: ReadonlyArray<{
    severity: "warning" | "error";
    code: string;
  }>;
  durationsMs: ExportJobStatsV1["durationsMs"];
}

function countNotes(notes: readonly ExportNote[], codes: ReadonlySet<string>): number {
  return notes.reduce((count, note) => count + (codes.has(note.code) ? 1 : 0), 0);
}

function issueSource(note: ExportNote): ExportIssueSourceV1 | undefined {
  if (!note.source) return undefined;
  const source: ExportIssueSourceV1 = {
    ...(note.source.pageId ? { pageId: note.source.pageId } : {}),
    ...(note.source.pageTitle ? { pageTitle: note.source.pageTitle } : {}),
    ...(note.source.blockPath ? { blockId: note.source.blockPath } : {}),
  };
  return Object.keys(source).length > 0 ? source : undefined;
}

function safeCount(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${path} must be a non-negative safe integer.`);
  }
  return value;
}

/** Build the common truthful final projection from renderer-owned facts. */
export function buildProductiveExportTelemetryV1(
  input: ProductiveExportTelemetryInputV1,
  at: number,
): ExportJobResultTelemetryV1 {
  const pageCount = safeCount(input.pageCount, "telemetry.pageCount");
  const embeddedAssets = safeCount(input.embeddedAssets, "telemetry.embeddedAssets");
  const skippedAssets = safeCount(input.skippedAssets, "telemetry.skippedAssets");
  const renderedDiagrams = safeCount(
    input.renderedDiagrams,
    "telemetry.renderedDiagrams",
  );
  const renderRetries = Math.max(
    0,
    safeCount(input.renderAttempts, "telemetry.renderAttempts") - 1,
  );
  const diagramFailures = countNotes(
    input.notes,
    new Set([
      "diagram-render-failed",
      "pdf-diagram-failed",
      "diagram-skipped",
      "diagram-unsupported",
      "pdf-diagram-unsupported",
    ]),
  );
  const renderedMacros = countNotes(input.notes, new Set(["macro-rendered-via"]));
  const approximatedMacros = countNotes(input.notes, new Set(["macro-not-rendered"]));
  const unresolvedMacros = countNotes(input.notes, new Set(["unknown-macro"]));
  const stats = createEmptyExportJobStatsV1();
  stats.pages = {
    discovered: pageCount,
    fetched: pageCount,
    composed: pageCount,
    skipped: 0,
  };
  stats.assets = {
    ...stats.assets,
    discovered: embeddedAssets + skippedAssets,
    fetched: embeddedAssets,
    embedded: embeddedAssets,
    skipped: skippedAssets,
  };
  stats.diagrams = {
    discovered: renderedDiagrams + diagramFailures,
    rendered: renderedDiagrams,
    rasterized: renderedDiagrams,
    failed: diagramFailures,
  };
  stats.macros = {
    discovered: renderedMacros + approximatedMacros + unresolvedMacros,
    rendered: renderedMacros,
    approximated: approximatedMacros,
    unresolved: unresolvedMacros,
  };
  stats.retries = {
    total: renderRetries,
    rateLimited: 0,
    network: 0,
    worker: renderRetries,
  };
  stats.storage.spoolBytes = safeCount(input.preparedBytes, "telemetry.preparedBytes");
  stats.storage.outputBytes = safeCount(input.outputBytes, "telemetry.outputBytes");
  stats.durationsMs = { ...input.durationsMs };
  stats.warnings = input.reportSummary.issues.warning;
  stats.errors = input.reportSummary.issues.error;

  const issueByCode = new Map<string, ExportJobEventDraftV1>();
  for (const note of input.notes) {
    const source = issueSource(note);
    const candidate: ExportJobEventDraftV1 = {
      kind: "issue",
      at,
      level: note.level,
      code: note.code,
      ...(source ? { source } : {}),
    };
    const prior = issueByCode.get(note.code);
    if (!prior || (prior.kind === "issue" && prior.level === "info" && note.level === "warning")) {
      issueByCode.set(note.code, candidate);
    }
  }
  for (const issue of input.compilerIssues ?? []) {
    issueByCode.set(issue.code, {
      kind: "issue",
      at,
      level: issue.severity,
      code: issue.code,
    });
  }
  const orderedCodes = input.reportSummary.topCodes.length > 0
    ? input.reportSummary.topCodes.map(({ code }) => code)
    : [...issueByCode.keys()];
  const issues = orderedCodes
    .map((code) => issueByCode.get(code))
    .filter((issue): issue is ExportJobEventDraftV1 => issue !== undefined)
    .slice(0, 20);
  return { stats, issues };
}
