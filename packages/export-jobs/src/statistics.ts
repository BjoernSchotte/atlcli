import type { ExportJobStage } from "./snapshot.js";

/** Bounded, format-neutral summary retained with the activity row. */
export interface ExportReportSummaryV1 {
  issues: { info: number; warning: number; error: number };
  topCodes: Array<{ code: string; count: number }>;
  completeness: "complete" | "partial" | "unknown";
  failurePhase?: string;
}

/** Host-dependent measurements whose support must be stated explicitly. */
export type ExportJobMetricV1 =
  | "storage.spoolPeakBytes"
  | "memory.heapPeakBytes"
  | "memory.rendererPeakBytes";

export const EXPORT_JOB_METRICS_V1 = [
  "storage.spoolPeakBytes",
  "memory.heapPeakBytes",
  "memory.rendererPeakBytes",
] as const satisfies readonly ExportJobMetricV1[];

/** Monotonic version-1 counters and measurements for one export job. */
export interface ExportJobStatsV1 {
  pages: { discovered: number; fetched: number; composed: number; skipped: number };
  assets: {
    discovered: number;
    fetched: number;
    embedded: number;
    skipped: number;
    deduplicated: number;
    logicalBytes: number;
    physicalBytes: number;
  };
  diagrams: { discovered: number; rendered: number; rasterized: number; failed: number };
  macros: { discovered: number; rendered: number; approximated: number; unresolved: number };
  retries: { total: number; rateLimited: number; network: number; worker: number };
  storage: { spoolBytes: number; spoolPeakBytes: number | null; outputBytes: number };
  memory: { heapPeakBytes: number | null; rendererPeakBytes: number | null };
  metricSupport: Partial<Record<ExportJobMetricV1, "measured" | "derived" | "unavailable">>;
  durationsMs: Partial<Record<ExportJobStage | "queue", number>>;
  warnings: number;
  errors: number;
}

/** Canonical initial projection; unsupported host metrics are never presented as measured zero. */
export function createEmptyExportJobStatsV1(): ExportJobStatsV1 {
  return {
    pages: { discovered: 0, fetched: 0, composed: 0, skipped: 0 },
    assets: {
      discovered: 0,
      fetched: 0,
      embedded: 0,
      skipped: 0,
      deduplicated: 0,
      logicalBytes: 0,
      physicalBytes: 0,
    },
    diagrams: { discovered: 0, rendered: 0, rasterized: 0, failed: 0 },
    macros: { discovered: 0, rendered: 0, approximated: 0, unresolved: 0 },
    retries: { total: 0, rateLimited: 0, network: 0, worker: 0 },
    storage: { spoolBytes: 0, spoolPeakBytes: null, outputBytes: 0 },
    memory: { heapPeakBytes: null, rendererPeakBytes: null },
    metricSupport: {
      "storage.spoolPeakBytes": "unavailable",
      "memory.heapPeakBytes": "unavailable",
      "memory.rendererPeakBytes": "unavailable",
    },
    durationsMs: {},
    warnings: 0,
    errors: 0,
  };
}
