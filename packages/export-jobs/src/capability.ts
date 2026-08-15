import type { ExportFormat } from "./source.js";

/** Truthful, per-format background and activity guarantees of one host. */
export interface ExportJobHostCapabilityV1 {
  format: ExportFormat;
  renderer: "docx-typescript" | "pdf-typst";
  executionLifetime: "surface" | "process" | "browser-session" | "remote";
  survivesSurfaceClose: boolean;
  resumesAfterExecutorLoss: boolean;
  resumesAfterHostRestart: boolean;
  canCancel: boolean;
  canRetry: boolean;
  canRerun: boolean;
  canCollectLater: boolean;
  resultRetentionMs: number;
}
