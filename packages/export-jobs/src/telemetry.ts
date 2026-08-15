import type { ExportJobEventDraftV1 } from "./event.js";
import type { ExportJobStatsV1 } from "./statistics.js";

/** Durable final telemetry carried by crash-recoverable result intents. */
export interface ExportJobResultTelemetryV1 {
  stats: ExportJobStatsV1;
  /** Bounded, redacted representative issues; full messages stay in the report. */
  issues: ExportJobEventDraftV1[];
}
