import {
  validateExportScope,
  type ExportTreePlanV1,
  type TreeSourceVersion,
} from "@atlcli/confluence";

export interface ConfluenceSourcePlanIdentityV1 {
  jobId: string;
  requestKey: string;
  /** Host-owned representation/capability policy identity, never user input. */
  sourcePolicyKey: string;
}

export interface ConfluenceSourcePlanCheckpointV1 extends ConfluenceSourcePlanIdentityV1 {
  schema: "atlcli.confluence-source-plan-checkpoint/1";
  committedLeaseEpoch: number;
  root: {
    id: string;
    title: string;
    version?: number;
  };
  plan: ExportTreePlanV1;
}

export interface PersistedConfluenceSourcePlanV1 {
  checkpoint: ConfluenceSourcePlanCheckpointV1;
  /** Opaque host-owned ref published on the active job lease. */
  ref: string;
}

export interface ConfluenceSourcePlanStoreV1 {
  /**
   * Load the latest committed plan by logical identity. The host owns any
   * authority needed to read a prior lease epoch.
   */
  load(
    identity: ConfluenceSourcePlanIdentityV1,
    context: { signal: AbortSignal },
  ): Promise<PersistedConfluenceSourcePlanV1 | undefined>;
  /**
   * Atomically commit the plan under the active fenced lease. A repeat commit
   * of the same logical identity and plan must be idempotent.
   */
  commit(
    checkpoint: ConfluenceSourcePlanCheckpointV1,
    context: { leaseEpoch: number; signal: AbortSignal },
  ): Promise<string>;
}

export interface ConfluenceSourcePlanCheckpointOptionsV1
  extends ConfluenceSourcePlanIdentityV1 {
  leaseEpoch: number;
  store: ConfluenceSourcePlanStoreV1;
  /**
   * Latest durable checkpoint at claim time. If it points past the source
   * plan, recovery must not move the job cursor backwards to the plan ref.
   */
  recoveryHeadRef?: string;
  /** Fence and publish the opaque ref before any source body read. */
  publishCheckpointRef(
    ref: string,
    context: { signal: AbortSignal },
  ): Promise<void>;
}

export class ConfluenceSourcePlanCheckpointError extends Error {
  readonly code = "confluence-source-plan-checkpoint-invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "ConfluenceSourcePlanCheckpointError";
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function validateConfluenceSourcePlanCheckpointOptionsV1(
  options: ConfluenceSourcePlanCheckpointOptionsV1,
): ConfluenceSourcePlanCheckpointOptionsV1 {
  if (
    !options ||
    typeof options !== "object" ||
    !nonEmpty(options.jobId) ||
    !nonEmpty(options.requestKey) ||
    !nonEmpty(options.sourcePolicyKey) ||
    !positiveVersion(options.leaseEpoch) ||
    (options.recoveryHeadRef !== undefined && !nonEmpty(options.recoveryHeadRef)) ||
    !options.store ||
    typeof options.store.load !== "function" ||
    typeof options.store.commit !== "function" ||
    typeof options.publishCheckpointRef !== "function"
  ) {
    throw new ConfluenceSourcePlanCheckpointError(
      "Source plan checkpoint options are invalid.",
    );
  }
  return options;
}

export function validatePersistedConfluenceSourcePlanV1(
  persisted: PersistedConfluenceSourcePlanV1,
  expected: ConfluenceSourcePlanIdentityV1 & { leaseEpoch: number },
): PersistedConfluenceSourcePlanV1 {
  const checkpoint = persisted?.checkpoint;
  if (!persisted || typeof persisted !== "object" || !nonEmpty(persisted.ref)) {
    throw new ConfluenceSourcePlanCheckpointError("Persisted source plan ref is invalid.");
  }
  if (
    !checkpoint ||
    typeof checkpoint !== "object" ||
    checkpoint.schema !== "atlcli.confluence-source-plan-checkpoint/1" ||
    checkpoint.jobId !== expected.jobId ||
    checkpoint.requestKey !== expected.requestKey ||
    checkpoint.sourcePolicyKey !== expected.sourcePolicyKey
  ) {
    throw new ConfluenceSourcePlanCheckpointError(
      "Persisted source plan identity does not match this export job.",
    );
  }
  if (
    !positiveVersion(checkpoint.committedLeaseEpoch) ||
    checkpoint.committedLeaseEpoch > expected.leaseEpoch
  ) {
    throw new ConfluenceSourcePlanCheckpointError(
      "Persisted source plan lease epoch is invalid.",
    );
  }
  if (
    !checkpoint.root ||
    typeof checkpoint.root !== "object" ||
    !nonEmpty(checkpoint.root.id) ||
    typeof checkpoint.root.title !== "string" ||
    (checkpoint.root.version !== undefined && !positiveVersion(checkpoint.root.version))
  ) {
    throw new ConfluenceSourcePlanCheckpointError("Persisted source plan root is invalid.");
  }
  if (
    !checkpoint.plan ||
    typeof checkpoint.plan !== "object" ||
    checkpoint.plan.schema !== "atlcli.export-tree-plan/1" ||
    checkpoint.plan.rootId !== checkpoint.root.id
  ) {
    throw new ConfluenceSourcePlanCheckpointError(
      "Persisted source plan root does not match its tree plan.",
    );
  }
  try {
    validateExportScope(checkpoint.plan.scope);
  } catch {
    throw new ConfluenceSourcePlanCheckpointError("Persisted source plan scope is invalid.");
  }
  return persisted;
}

export function rootSnapshotFromPlanV1(plan: ExportTreePlanV1): TreeSourceVersion {
  const root = plan.nodes.find(
    (node) => node.kind === "page" && node.pageId === plan.rootId,
  );
  if (!root || root.kind !== "page") {
    throw new ConfluenceSourcePlanCheckpointError(
      "The prepared tree plan does not contain root metadata.",
    );
  }
  return {
    title: root.title,
    ...(root.observedVersion !== undefined ? { version: root.observedVersion } : {}),
  };
}
