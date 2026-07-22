import type { ExportArtifactV1 } from "./artifact.js";
import type { ExportJobFinalizeV1 } from "./store-contracts.js";

/** Durable, immutable authorization to finish one already-staged artifact. */
export interface ExportArtifactFinalizationIntentV1 {
  schema: "atlcli.export-artifact-finalization/1";
  ref: string;
  status: "prepared" | "completed";
  finalize: ExportJobFinalizeV1;
  artifact: ExportArtifactV1;
  completedAt?: number;
}

/**
 * Durable host journal for the cross-store finalization protocol.
 *
 * `prepare` MUST be atomic with revision/lease fencing against the authoritative
 * job row. Once prepared, replay is authorized even if the original lease later
 * expires. Reusing the stable ref with different input MUST fail closed.
 */
export interface ExportArtifactFinalizationJournal {
  prepare(intent: ExportArtifactFinalizationIntentV1): Promise<ExportArtifactFinalizationIntentV1>;
  get(ref: string): Promise<ExportArtifactFinalizationIntentV1 | undefined>;
  /** Discover the single unfinished intent after host restart. */
  findPreparedByJob(jobId: string): Promise<ExportArtifactFinalizationIntentV1 | undefined>;
  /** Idempotently persist completion after the job metadata commit is durable. */
  complete(ref: string, artifact: ExportArtifactV1, completedAt: number): Promise<void>;
}

/**
 * Idempotent byte promotion owned by the host artifact adapter.
 *
 * A replay after promotion MUST return the same committed artifact. It must not
 * require the staged entry to still exist, and mismatched metadata must fail.
 */
export interface ExportArtifactFinalizationCommitter {
  commit(intent: ExportArtifactFinalizationIntentV1): Promise<ExportArtifactV1>;
}

/**
 * Idempotent terminal metadata commit owned by the authoritative job adapter.
 *
 * The adapter commits only an atomically prepared intent. If the exact terminal
 * result already exists it returns successfully; any competing result fails.
 */
export interface ExportJobFinalizationCommitter {
  commit(intent: ExportArtifactFinalizationIntentV1, artifact: ExportArtifactV1): Promise<void>;
}

export interface ExportArtifactFinalizationPorts {
  journal: ExportArtifactFinalizationJournal;
  artifacts: ExportArtifactFinalizationCommitter;
  jobs: ExportJobFinalizationCommitter;
}

export interface ExportArtifactFinalizationFaultHooks {
  afterIntentPrepared?(): void | Promise<void>;
  afterArtifactCommitted?(): void | Promise<void>;
  afterJobCommitted?(): void | Promise<void>;
}

export class ExportArtifactFinalizationConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportArtifactFinalizationConflict";
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
}

function assertFiniteTime(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new ExportArtifactFinalizationConflict(`${label} must be a non-negative finite timestamp.`);
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ExportArtifactFinalizationConflict(`${label} must be a positive safe integer.`);
  }
}

function assertFinalizeInput(input: ExportJobFinalizeV1): void {
  if (input.id.length === 0 || input.stagedArtifact.ref.length === 0) {
    throw new ExportArtifactFinalizationConflict("Job and staged artifact refs must not be empty.");
  }
  if (input.stagedArtifact.jobId !== input.id) {
    throw new ExportArtifactFinalizationConflict("The staged artifact belongs to a different job.");
  }
  assertPositiveSafeInteger(input.leaseEpoch, "Lease epoch");
  assertPositiveSafeInteger(input.stagedArtifact.leaseEpoch, "Staged artifact lease epoch");
  if (input.stagedArtifact.leaseEpoch !== input.leaseEpoch) {
    throw new ExportArtifactFinalizationConflict("The staged artifact belongs to a different lease epoch.");
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new ExportArtifactFinalizationConflict("Expected revision must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(input.stagedArtifact.byteLength) || input.stagedArtifact.byteLength < 0) {
    throw new ExportArtifactFinalizationConflict("Artifact byte length must be a non-negative safe integer.");
  }
  assertFiniteTime(input.stagedArtifact.stagedAt, "Artifact staging time");
  assertFiniteTime(input.finishedAt, "Artifact finish time");
  if (input.stagedArtifact.stagedAt > input.finishedAt) {
    throw new ExportArtifactFinalizationConflict("Artifact staging cannot occur after finalization.");
  }
}

export function exportArtifactFinalizationRef(input: ExportJobFinalizeV1): string {
  assertFinalizeInput(input);
  return `artifact-finalization:${input.id.length}:${input.id}:${input.expectedRevision}:${input.leaseEpoch}`;
}

export function prepareExportArtifactFinalizationIntent(
  input: ExportJobFinalizeV1,
): ExportArtifactFinalizationIntentV1 {
  assertFinalizeInput(input);
  return {
    schema: "atlcli.export-artifact-finalization/1",
    ref: exportArtifactFinalizationRef(input),
    status: "prepared",
    finalize: clone(input),
    artifact: {
      ref: input.stagedArtifact.ref,
      mediaType: input.stagedArtifact.mediaType,
      filename: input.stagedArtifact.filename,
      byteLength: input.stagedArtifact.byteLength,
      sha256: input.stagedArtifact.sha256,
      committedAt: input.finishedAt,
    },
  };
}

/**
 * Replayable saga for artifact visibility and terminal job metadata.
 *
 * This intentionally does not claim cross-store atomicity. Durability comes
 * from a fenced intent plus idempotent promotion and metadata commits.
 */
export async function finalizeExportArtifactDurably(
  ports: ExportArtifactFinalizationPorts,
  input: ExportJobFinalizeV1,
  hooks: ExportArtifactFinalizationFaultHooks = {},
): Promise<ExportArtifactV1> {
  const requested = prepareExportArtifactFinalizationIntent(input);
  const prepared = await ports.journal.prepare(requested);
  if (
    prepared.schema !== requested.schema ||
    prepared.ref !== requested.ref ||
    canonical(prepared.finalize) !== canonical(requested.finalize) ||
    canonical(prepared.artifact) !== canonical(requested.artifact)
  ) {
    throw new ExportArtifactFinalizationConflict("The finalization journal returned a mismatched intent.");
  }
  if (prepared.status === "completed") {
    if (prepared.completedAt === undefined) {
      throw new ExportArtifactFinalizationConflict("A completed finalization intent needs a completion time.");
    }
    return clone(prepared.artifact);
  }
  if (prepared.status !== "prepared" || prepared.completedAt !== undefined) {
    throw new ExportArtifactFinalizationConflict("The finalization journal returned an invalid intent state.");
  }

  return completePreparedExportArtifactFinalization(ports, prepared, hooks);
}

async function completePreparedExportArtifactFinalization(
  ports: ExportArtifactFinalizationPorts,
  prepared: ExportArtifactFinalizationIntentV1,
  hooks: ExportArtifactFinalizationFaultHooks,
): Promise<ExportArtifactV1> {

  await hooks.afterIntentPrepared?.();
  const artifact = await ports.artifacts.commit(prepared);
  if (canonical(artifact) !== canonical(prepared.artifact)) {
    throw new ExportArtifactFinalizationConflict("Artifact promotion returned mismatched metadata.");
  }

  await hooks.afterArtifactCommitted?.();
  await ports.jobs.commit(prepared, artifact);
  await hooks.afterJobCommitted?.();
  await ports.journal.complete(prepared.ref, artifact, prepared.finalize.finishedAt);
  return clone(artifact);
}

/** Reconcile a discoverable prepared intent without deriving a new lease-bound ref. */
export async function resumePreparedExportArtifactFinalization(
  ports: ExportArtifactFinalizationPorts,
  jobId: string,
  hooks: ExportArtifactFinalizationFaultHooks = {},
): Promise<ExportArtifactV1 | undefined> {
  if (jobId.trim().length === 0) {
    throw new ExportArtifactFinalizationConflict("Job id must not be empty.");
  }
  const prepared = await ports.journal.findPreparedByJob(jobId);
  if (!prepared) return undefined;
  if (
    prepared.schema !== "atlcli.export-artifact-finalization/1" ||
    prepared.status !== "prepared" ||
    prepared.completedAt !== undefined ||
    prepared.finalize.id !== jobId
  ) {
    throw new ExportArtifactFinalizationConflict("The journal returned an invalid prepared intent.");
  }
  return completePreparedExportArtifactFinalization(ports, prepared, hooks);
}

/** Small deterministic reference journal used by host contract tests. */
export class InMemoryExportArtifactFinalizationJournal
  implements ExportArtifactFinalizationJournal
{
  readonly #intents = new Map<string, ExportArtifactFinalizationIntentV1>();

  async prepare(
    intent: ExportArtifactFinalizationIntentV1,
  ): Promise<ExportArtifactFinalizationIntentV1> {
    const expected = prepareExportArtifactFinalizationIntent(intent.finalize);
    if (
      intent.schema !== "atlcli.export-artifact-finalization/1" ||
      intent.status !== "prepared" ||
      intent.ref !== expected.ref ||
      canonical(intent.artifact) !== canonical(expected.artifact)
    ) {
      throw new ExportArtifactFinalizationConflict("Only an exact prepared v1 intent can be stored.");
    }
    const existing = this.#intents.get(intent.ref);
    if (existing) {
      if (
        canonical(existing.finalize) !== canonical(intent.finalize) ||
        canonical(existing.artifact) !== canonical(intent.artifact)
      ) {
        throw new ExportArtifactFinalizationConflict(
          "A finalization ref cannot be reused with different input.",
        );
      }
      return clone(existing);
    }
    const persisted = clone(intent);
    this.#intents.set(persisted.ref, persisted);
    return clone(persisted);
  }

  async get(ref: string): Promise<ExportArtifactFinalizationIntentV1 | undefined> {
    const intent = this.#intents.get(ref);
    return intent ? clone(intent) : undefined;
  }

  async findPreparedByJob(
    jobId: string,
  ): Promise<ExportArtifactFinalizationIntentV1 | undefined> {
    const matches = [...this.#intents.values()].filter(
      (intent) => intent.finalize.id === jobId && intent.status === "prepared",
    );
    if (matches.length > 1) {
      throw new ExportArtifactFinalizationConflict(
        "More than one prepared finalization intent exists for the job.",
      );
    }
    return matches[0] ? clone(matches[0]) : undefined;
  }

  async complete(ref: string, artifact: ExportArtifactV1, completedAt: number): Promise<void> {
    assertFiniteTime(completedAt, "Finalization completion time");
    const existing = this.#intents.get(ref);
    if (!existing) {
      throw new ExportArtifactFinalizationConflict("Cannot complete a missing finalization intent.");
    }
    if (canonical(existing.artifact) !== canonical(artifact)) {
      throw new ExportArtifactFinalizationConflict("Cannot complete an intent with a different artifact.");
    }
    if (existing.status === "completed") {
      if (existing.completedAt !== completedAt) {
        throw new ExportArtifactFinalizationConflict(
          "A completed intent cannot be replayed with a different completion time.",
        );
      }
      return;
    }
    this.#intents.set(ref, { ...existing, status: "completed", completedAt });
  }
}
