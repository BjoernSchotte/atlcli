import type { ExportReportSummaryV1 } from "./statistics.js";

/** User-visible artifact committed by a successful job. */
export interface ExportArtifactV1 {
  ref: string;
  mediaType:
    | "application/pdf"
    | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  filename: string;
  byteLength: number;
  sha256: string;
  committedAt: number;
}

/** Artifact metadata supplied before bytes are staged. */
export interface PendingArtifactV1 {
  mediaType: ExportArtifactV1["mediaType"];
  filename: string;
  byteLength: number;
  sha256: string;
  bytes: AsyncIterable<Uint8Array>;
}

/** Host-owned staged output that is not user-visible until finalization. */
export interface StagedArtifactV1 {
  ref: string;
  mediaType: ExportArtifactV1["mediaType"];
  filename: string;
  byteLength: number;
  sha256: string;
  jobId: string;
  leaseEpoch: number;
  stagedAt: number;
}

/** Executor output handed to the outer, fenced runtime finalizer. */
export interface ExportJobExecutionResultV1 {
  stagedArtifact: StagedArtifactV1;
  reportRef?: string;
  reportSummary?: ExportReportSummaryV1;
}
