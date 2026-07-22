import type { ExportArtifactV1 } from "./artifact.js";
import type { ExportIssueSourceV1 } from "./error.js";
import type {
  ExportJobProgressV1,
  ExportJobStage,
  ExportJobState,
} from "./snapshot.js";

/** Bounded durable event entries for one job. */
export type ExportJobEventV1 =
  | { kind: "state"; seq: number; at: number; from: ExportJobState; to: ExportJobState }
  | { kind: "stage"; seq: number; at: number; stage: ExportJobStage }
  | { kind: "progress"; seq: number; at: number; progress: ExportJobProgressV1 }
  | { kind: "retry"; seq: number; at: number; code: string; nextAttemptAt: number }
  | {
      kind: "issue";
      seq: number;
      at: number;
      level: "info" | "warning" | "error";
      code: string;
      source?: ExportIssueSourceV1;
    }
  | { kind: "recovery"; seq: number; at: number; fromCheckpoint?: string; leaseEpoch: number }
  | { kind: "artifact"; seq: number; at: number; artifact: ExportArtifactV1 };
