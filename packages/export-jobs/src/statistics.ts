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
