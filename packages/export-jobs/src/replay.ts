import type { ExportJobRequestV1 } from "./request.js";
import type { ExportJobSnapshotV1, ExportJobState } from "./snapshot.js";
import { parseExportJobRequestV1 } from "./validation.js";

export type ExportJobReplayRelationV1 = "retry" | "rerun";

/** Stable user action plus newly allocated identity for a replay request. */
export interface ExportJobReplayInputV1 {
  relation: ExportJobReplayRelationV1;
  actionKey: string;
  newJobId: string;
  newIdempotencyKey: string;
  createdAt: number;
  /** Optional delivery-only change; every source/render/report field stays pinned. */
  outputOverride?: ExportJobRequestV1["output"];
}

export type ExportJobReplayConflictCodeV1 =
  | "candidate-request-missing"
  | "action-payload-conflict";

/** Fail-closed replay conflict for an already-bound user action. */
export class ExportJobReplayConflict extends Error {
  constructor(
    readonly code: ExportJobReplayConflictCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "ExportJobReplayConflict";
  }
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

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
}

function replayPayload(request: ExportJobRequestV1): string {
  const { id: _id, idempotencyKey: _key, createdAt: _createdAt, priority: _priority, ...rest } =
    request;
  return canonical(rest);
}

/**
 * Derive a manual Retry or Run-again request without mutating its terminal
 * predecessor. Hosts persist the returned request and relation atomically.
 */
export function deriveExportJobReplayV1(args: {
  origin: ExportJobSnapshotV1;
  originRequest: ExportJobRequestV1;
  input: ExportJobReplayInputV1;
  existingDerived: readonly ExportJobSnapshotV1[];
  /** Requests paired by id with `existingDerived`, required to verify action binding. */
  existingDerivedRequests: readonly ExportJobRequestV1[];
}): ExportJobReplayDerivationV1 {
  const { origin, originRequest, input, existingDerived } = args;

  const allowed =
    input.relation === "retry" ? RETRY_STATES.has(origin.state) : origin.state === "succeeded";
  if (!allowed) {
    return { kind: "not-allowed", relation: input.relation, originState: origin.state };
  }

  const request = parseExportJobRequestV1({
    ...originRequest,
    id: input.newJobId,
    idempotencyKey: input.newIdempotencyKey,
    createdAt: input.createdAt,
    priority: input.relation === "retry" ? "retry" : "interactive",
    ...(input.outputOverride ? { output: input.outputOverride } : {}),
  });

  const existing = existingDerived.find(
    (candidate) =>
      candidate.derivedFrom?.jobId === origin.id &&
      candidate.derivedFrom.relation === input.relation &&
      candidate.derivedFrom.actionKey === input.actionKey,
  );
  if (existing) {
    const existingRequest = args.existingDerivedRequests.find(
      (candidate) => candidate.id === existing.id,
    );
    if (!existingRequest) {
      throw new ExportJobReplayConflict(
        "candidate-request-missing",
        `Existing derived job ${existing.id} has no request for replay verification.`,
      );
    }
    if (replayPayload(existingRequest) !== replayPayload(request)) {
      throw new ExportJobReplayConflict(
        "action-payload-conflict",
        "This replay action key is already bound to a different output override.",
      );
    }
    return { kind: "existing", snapshot: existing };
  }

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
