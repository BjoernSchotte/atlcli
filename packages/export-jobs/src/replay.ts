import type { ExportJobRequestV1 } from "./request.js";
import type { ExportJobSnapshotV1, ExportJobState } from "./snapshot.js";

export type ExportJobReplayRelationV1 = "retry" | "rerun";

/** Stable user action plus newly allocated identity for a replay request. */
export interface ExportJobReplayInputV1 {
  relation: ExportJobReplayRelationV1;
  actionKey: string;
  newJobId: string;
  newIdempotencyKey: string;
  createdAt: number;
}

export type ExportJobReplayDerivationV1 =
  | { kind: "existing"; snapshot: ExportJobSnapshotV1 }
  | {
      kind: "create";
      request: ExportJobRequestV1;
      derivedFrom: NonNullable<ExportJobSnapshotV1["derivedFrom"]>;
    }
  | {
      kind: "not-allowed";
      relation: ExportJobReplayRelationV1;
      originState: ExportJobState;
    };

const RETRY_STATES: ReadonlySet<ExportJobState> = new Set([
  "failed",
  "interrupted",
  "cancelled",
]);

/**
 * Derive a manual Retry or Run-again request without mutating its terminal
 * predecessor. Hosts persist the returned request and relation atomically.
 */
export function deriveExportJobReplayV1(args: {
  origin: ExportJobSnapshotV1;
  originRequest: ExportJobRequestV1;
  input: ExportJobReplayInputV1;
  existingDerived: readonly ExportJobSnapshotV1[];
}): ExportJobReplayDerivationV1 {
  const { origin, originRequest, input, existingDerived } = args;

  const allowed =
    input.relation === "retry" ? RETRY_STATES.has(origin.state) : origin.state === "succeeded";
  if (!allowed) {
    return { kind: "not-allowed", relation: input.relation, originState: origin.state };
  }

  const existing = existingDerived.find(
    (candidate) =>
      candidate.derivedFrom?.jobId === origin.id &&
      candidate.derivedFrom.relation === input.relation &&
      candidate.derivedFrom.actionKey === input.actionKey,
  );
  if (existing) return { kind: "existing", snapshot: existing };

  const request: ExportJobRequestV1 = {
    ...originRequest,
    id: input.newJobId,
    idempotencyKey: input.newIdempotencyKey,
    createdAt: input.createdAt,
    priority: input.relation === "retry" ? "retry" : "interactive",
  };

  return {
    kind: "create",
    request,
    derivedFrom: {
      jobId: origin.id,
      relation: input.relation,
      actionKey: input.actionKey,
    },
  };
}
