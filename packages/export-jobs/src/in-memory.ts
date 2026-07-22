import type {
  PendingArtifactV1,
  StagedArtifactV1,
} from "./artifact.js";
import type { ExportJobEventV1 } from "./event.js";
import type { ExportJobRequestV1 } from "./request.js";
import type { ExportJobStatsV1 } from "./statistics.js";
import type {
  ExportJobClaimV1,
  ExportJobCreateV1,
  ExportJobDeleteQueryV1,
  ExportJobDeleteResultV1,
  ExportJobEventAppendV1,
  ExportJobFinalizeV1,
  ExportJobQueryV1,
  ExportJobUpdateV1,
} from "./store-contracts.js";
import type { ExportJobSnapshotV1 } from "./snapshot.js";
import type { SpoolObjectV1, SpoolRefV1, SpoolWriteLimitsV1 } from "./spool.js";
import type {
  ExportArtifactStore,
  ExportJobStore,
  ExportSpoolStore,
} from "./ports.js";
import { orderExportQueue } from "./policy.js";
import {
  parseExportJobEventV1,
  parseExportJobRequestV1,
  parseExportJobSnapshotV1,
} from "./validation.js";
import {
  claimExportJob,
  checkpointExportJob,
  finalizeExportJobArtifact,
  heartbeatExportJob,
  isExportJobTerminal,
  reclaimExpiredExportJobLease,
  transitionExportJob,
  updateExportJobProgress,
  updateExportJobStats,
  updateExportJobTerminalMetadata,
  type ExportJobHeartbeatInputV1,
  type ExportJobCheckpointInputV1,
  type ExportJobLeaseReclaimInputV1,
  type ExportJobProgressInputV1,
  type ExportJobStatsInputV1,
  type ExportJobStateTransitionV1,
} from "./transitions.js";

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 1_000;

export type InMemoryExportStoreConflictCode =
  | "duplicate-id"
  | "idempotency-conflict"
  | "derivation-conflict"
  | "job-deleted"
  | "job-not-found"
  | "revision-conflict"
  | "lease-required"
  | "lease-mismatch"
  | "lease-expired"
  | "invalid-event"
  | "event-limit"
  | "retention-protected";

/** Closed failures added by the reference adapter around the pure reducers. */
export class InMemoryExportStoreConflict extends Error {
  readonly code: InMemoryExportStoreConflictCode;

  constructor(code: InMemoryExportStoreConflictCode, message: string) {
    super(message);
    this.name = "InMemoryExportStoreConflict";
    this.code = code;
  }
}

export interface ExportJobTombstoneV1 {
  ref: string;
  jobId: string;
  requestRef: string;
  idempotencyKey: string;
  derivationKey?: string;
  finalState: Extract<
    ExportJobSnapshotV1["state"],
    "succeeded" | "failed" | "cancelled" | "interrupted"
  >;
  finalRevision: number;
  finishedAt: number;
  deletedAt: number;
  /** Logical owned refs retained so a host can audit or continue cleanup. */
  ownedRefs: string[];
}

export interface InMemoryExportJobStoreOptions {
  now?: () => number;
  artifactStore?: InMemoryArtifactStore;
  tombstones?: readonly ExportJobTombstoneV1[];
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

function boundedLimit(limit: number | undefined, fallback: number, maximum: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("Query limit must be a non-negative safe integer.");
  }
  return Math.min(limit, maximum);
}

function locatorLabel(request: ExportJobRequestV1): string {
  switch (request.source.locator.kind) {
    case "page-id":
      return request.source.locator.id;
    case "content-key":
      return request.source.locator.value;
    case "space-key":
      return request.source.locator.spaceKey;
  }
}

function emptyStats(): ExportJobStatsV1 {
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
    metricSupport: {},
    durationsMs: {},
    warnings: 0,
    errors: 0,
  };
}

function derivationKey(input: NonNullable<ExportJobCreateV1["derivedFrom"]>): string {
  return canonical([input.jobId, input.relation, input.actionKey]);
}

function requestRef(request: ExportJobRequestV1): string {
  return `request:${request.id}`;
}

function replayPayload(request: ExportJobRequestV1): string {
  const { id: _id, idempotencyKey: _idempotencyKey, createdAt: _createdAt, priority: _priority, ...rest } =
    request;
  return canonical(rest);
}

function assertNonEmpty(value: string, label: string): void {
  if (value.length === 0) throw new Error(`${label} must not be empty.`);
}

function assertFiniteTime(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative finite timestamp.`);
  }
}

/**
 * Deterministic reference store used by contract tests and host prototypes.
 *
 * It deliberately exposes only narrow reducer-backed operations. Callers
 * cannot submit arbitrary partial snapshots, so every mutation retains the
 * lifecycle and fencing invariants enforced by the reducers.
 */
export class InMemoryExportJobStore implements ExportJobStore {
  readonly #jobs = new Map<string, ExportJobSnapshotV1>();
  readonly #requests = new Map<string, ExportJobRequestV1>();
  readonly #idempotency = new Map<string, string>();
  readonly #derivations = new Map<string, string>();
  readonly #events = new Map<string, ExportJobEventV1[]>();
  readonly #nextEventSeq = new Map<string, number>();
  readonly #tombstones = new Map<string, ExportJobTombstoneV1>();
  readonly #stateTransitions = new Map<
    string,
    Map<number, { from: ExportJobSnapshotV1["state"]; to: ExportJobSnapshotV1["state"] }>
  >();
  readonly #lastClaimedGroup = new Map<ExportJobSnapshotV1["queue"]["priority"], string>();
  readonly #now: () => number;
  readonly #artifacts: InMemoryArtifactStore;

  constructor(options: InMemoryExportJobStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#artifacts = options.artifactStore ?? new InMemoryArtifactStore({ now: this.#now });
    for (const tombstone of options.tombstones ?? []) {
      const retained = clone(tombstone);
      this.#tombstones.set(retained.jobId, retained);
      this.#idempotency.set(retained.idempotencyKey, retained.jobId);
      if (retained.derivationKey) this.#derivations.set(retained.derivationKey, retained.jobId);
    }
  }

  async create(input: ExportJobCreateV1): Promise<ExportJobSnapshotV1> {
    const request = clone(parseExportJobRequestV1(clone(input.request)));
    if (input.derivedFrom) {
      assertNonEmpty(input.derivedFrom.jobId, "Derived job id");
      assertNonEmpty(input.derivedFrom.actionKey, "Derivation action key");
    }

    const byDerivation = input.derivedFrom
      ? this.#derivations.get(derivationKey(input.derivedFrom))
      : undefined;
    const byIdempotency = this.#idempotency.get(request.idempotencyKey);
    if (byIdempotency && byDerivation && byIdempotency !== byDerivation) {
      throw new InMemoryExportStoreConflict(
        "derivation-conflict",
        "Idempotency and derivation keys resolve to different jobs.",
      );
    }
    if (byDerivation) {
      this.#assertReplayCandidate(request, input.derivedFrom!, byDerivation);
      const existing = this.#jobs.get(byDerivation);
      if (!existing) {
        throw new InMemoryExportStoreConflict("job-deleted", `Job ${byDerivation} was deleted.`);
      }
      return clone(existing);
    }
    if (byIdempotency) {
      const existingId = byIdempotency;
      const existing = this.#jobs.get(existingId);
      if (!existing) {
        throw new InMemoryExportStoreConflict("job-deleted", `Job ${existingId} was deleted.`);
      }
      const storedRequest = this.#requests.get(existing.requestRef)!;
      if (canonical(storedRequest) !== canonical(request)) {
        throw new InMemoryExportStoreConflict(
          "idempotency-conflict",
          "An idempotency or derivation key was reused with a different request.",
        );
      }
      if (canonical(existing.derivedFrom) !== canonical(input.derivedFrom)) {
        throw new InMemoryExportStoreConflict(
          "derivation-conflict",
          "An idempotent acknowledgement cannot change replay ancestry.",
        );
      }
      return clone(existing);
    }

    if (input.derivedFrom) this.#assertReplayCandidate(request, input.derivedFrom);

    const duplicate = this.#jobs.get(request.id);
    if (duplicate || this.#tombstones.has(request.id)) {
      throw new InMemoryExportStoreConflict("duplicate-id", `Job id ${request.id} already exists.`);
    }

    const ref = requestRef(request);
    const snapshot: ExportJobSnapshotV1 = {
      schema: "atlcli.export-job/1",
      id: request.id,
      revision: 0,
      requestRef: ref,
      format: request.format,
      renderer: request.renderer,
      summary: {
        displayName: request.displayName,
        sourceLabel: locatorLabel(request),
        siteOrigin: request.source.siteOrigin,
        scopeKind: request.source.scope.kind,
      },
      queue: {
        priority: request.priority,
        enqueuedAt: request.createdAt,
        groupKey: request.source.siteOrigin,
      },
      state: "queued",
      attempt: 0,
      recoveryCount: 0,
      leaseEpoch: 0,
      stats: emptyStats(),
      createdAt: request.createdAt,
      ...(input.derivedFrom ? { derivedFrom: clone(input.derivedFrom) } : {}),
    };

    const persisted = clone(snapshot);
    parseExportJobSnapshotV1(persisted);
    this.#jobs.set(persisted.id, persisted);
    this.#requests.set(ref, request);
    this.#idempotency.set(request.idempotencyKey, snapshot.id);
    if (input.derivedFrom) this.#derivations.set(derivationKey(input.derivedFrom), snapshot.id);
    this.#events.set(persisted.id, []);
    this.#nextEventSeq.set(persisted.id, 1);
    this.#stateTransitions.set(persisted.id, new Map());
    return clone(persisted);
  }

  async get(id: string): Promise<ExportJobSnapshotV1 | undefined> {
    const snapshot = this.#jobs.get(id);
    return snapshot ? clone(snapshot) : undefined;
  }

  async getRequest(ref: string): Promise<ExportJobRequestV1 | undefined> {
    const request = this.#requests.get(ref);
    return request ? clone(request) : undefined;
  }

  async list(query: ExportJobQueryV1 = {}): Promise<ExportJobSnapshotV1[]> {
    const limit = boundedLimit(query.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    return [...this.#jobs.values()]
      .filter((job) => !query.formats || query.formats.includes(job.format))
      .filter((job) => !query.states || query.states.includes(job.state))
      .filter((job) => !query.stages || (job.stage !== undefined && query.stages.includes(job.stage)))
      .filter((job) => query.includeDismissed === true || job.dismissedAt === undefined)
      .filter((job) => query.createdBefore === undefined || job.createdAt < query.createdBefore)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .slice(0, limit)
      .map(clone);
  }

  async claimNext(claim: ExportJobClaimV1): Promise<ExportJobSnapshotV1 | undefined> {
    const observedAt = this.#now();
    const claimable = [...this.#jobs.values()].filter(
      (job) =>
        (job.state === "queued" ||
          (job.state === "waiting" &&
            job.waiting?.until !== undefined &&
            job.waiting.until <= observedAt)) &&
        (!claim.formats || claim.formats.includes(job.format)),
    );
    const ordered = orderExportQueue(claimable);
    const first = ordered[0];
    let candidate: ExportJobSnapshotV1 | undefined = first;
    if (first) {
      const priority = first.queue.priority;
      const groupOrder = [
        ...new Set(
          ordered
            .filter((job) => job.queue.priority === priority)
            .map((job) => job.queue.groupKey),
        ),
      ];
      const lastGroup = this.#lastClaimedGroup.get(priority);
      const lastIndex = lastGroup === undefined ? -1 : groupOrder.indexOf(lastGroup);
      const nextGroup = groupOrder[(lastIndex + 1) % groupOrder.length]!;
      candidate = ordered.find(
        (job) => job.queue.priority === priority && job.queue.groupKey === nextGroup,
      );
    }
    if (!candidate) return undefined;
    const claimed = claimExportJob(candidate, {
      expectedRevision: candidate.revision,
      ownerId: claim.ownerId,
      now: claim.now,
      observedAt,
      leaseDurationMs: claim.leaseDurationMs,
    });
    const persisted = clone(claimed);
    parseExportJobSnapshotV1(persisted);
    this.#jobs.set(candidate.id, persisted);
    this.#recordStateTransition(candidate, persisted);
    this.#lastClaimedGroup.set(candidate.queue.priority, candidate.queue.groupKey);
    return clone(persisted);
  }

  async transition(id: string, input: ExportJobStateTransitionV1): Promise<ExportJobSnapshotV1> {
    return this.#replace(id, (snapshot) =>
      transitionExportJob(snapshot, { ...input, observedAt: this.#now() }),
    );
  }

  async heartbeat(id: string, input: ExportJobHeartbeatInputV1): Promise<ExportJobSnapshotV1> {
    return this.#replace(id, (snapshot) =>
      heartbeatExportJob(snapshot, { ...input, observedAt: this.#now() }),
    );
  }

  async updateProgress(id: string, input: ExportJobProgressInputV1): Promise<ExportJobSnapshotV1> {
    return this.#replace(id, (snapshot) =>
      updateExportJobProgress(snapshot, { ...input, observedAt: this.#now() }),
    );
  }

  async reclaimExpiredLease(
    id: string,
    input: ExportJobLeaseReclaimInputV1,
  ): Promise<ExportJobSnapshotV1> {
    const observedAt = this.#now();
    return this.#replace(id, (snapshot) =>
      reclaimExpiredExportJobLease(snapshot, { ...input, now: observedAt, observedAt }),
    );
  }

  async updateCheckpoint(
    id: string,
    input: ExportJobCheckpointInputV1,
  ): Promise<ExportJobSnapshotV1> {
    return this.#replace(id, (snapshot) =>
      checkpointExportJob(snapshot, { ...input, observedAt: this.#now() }),
    );
  }

  async updateStats(id: string, input: ExportJobStatsInputV1): Promise<ExportJobSnapshotV1> {
    return this.#replace(id, (snapshot) =>
      updateExportJobStats(snapshot, { ...input, observedAt: this.#now() }),
    );
  }

  async compareAndSet(update: ExportJobUpdateV1): Promise<ExportJobSnapshotV1> {
    switch (update.kind) {
      case "transition":
        return this.transition(update.id, {
          expectedRevision: update.expectedRevision,
          to: update.to,
          at: update.at,
          leaseEpoch: update.leaseEpoch,
          waiting: update.waiting,
          checkpointRef: update.checkpointRef,
          error: update.error,
        });
      case "heartbeat":
        return this.heartbeat(update.id, {
          expectedRevision: update.expectedRevision,
          ownerId: update.ownerId,
          leaseEpoch: update.leaseEpoch,
          now: update.now,
          leaseDurationMs: update.leaseDurationMs,
        });
      case "progress":
        return this.updateProgress(update.id, {
          expectedRevision: update.expectedRevision,
          leaseEpoch: update.leaseEpoch,
          progress: update.progress,
        });
      case "reclaim-expired":
        return this.reclaimExpiredLease(update.id, {
          expectedRevision: update.expectedRevision,
          now: update.now,
        });
      case "checkpoint":
        return this.updateCheckpoint(update.id, {
          expectedRevision: update.expectedRevision,
          leaseEpoch: update.leaseEpoch,
          at: update.at,
          checkpointRef: update.checkpointRef,
        });
      case "stats":
        return this.updateStats(update.id, {
          expectedRevision: update.expectedRevision,
          leaseEpoch: update.leaseEpoch,
          at: update.at,
          stats: update.stats,
        });
    }
  }

  async appendEvent(id: string, input: ExportJobEventAppendV1): Promise<void> {
    const snapshot = this.#require(id);
    const event = clone(parseExportJobEventV1(clone(input.event)));
    if (snapshot.revision !== input.expectedRevision) {
      throw new InMemoryExportStoreConflict("revision-conflict", "Event revision is stale.");
    }
    const expectedSeq = this.#nextEventSeq.get(id) ?? 1;
    if (event.seq !== expectedSeq) {
      throw new InMemoryExportStoreConflict(
        "invalid-event",
        `Expected event sequence ${expectedSeq}, received ${event.seq}.`,
      );
    }
    if (snapshot.state === "running" || snapshot.state === "cancelling") {
      this.#assertExecutorWrite(
        snapshot,
        input.expectedRevision,
        input.leaseEpoch,
        this.#now(),
      );
    } else if (input.leaseEpoch !== undefined && input.leaseEpoch !== snapshot.leaseEpoch) {
      throw new InMemoryExportStoreConflict("lease-mismatch", "Event lease epoch is stale.");
    }
    this.#assertEventMatchesSnapshot(snapshot, event);
    const events = [...(this.#events.get(id) ?? [])];
    const previous = events.at(-1);
    if (
      event.kind === "progress" &&
      previous?.kind === "progress" &&
      previous.progress.stage === event.progress.stage &&
      event.at - previous.at < 500
    ) {
      events[events.length - 1] = event;
    } else {
      events.push(event);
    }
    while (events.length > MAX_EVENT_LIMIT) {
      const evictable = events.findIndex(
        (candidate) =>
          candidate.kind === "progress" ||
          (candidate.kind === "issue" && candidate.level === "info"),
      );
      if (evictable < 0) {
        throw new InMemoryExportStoreConflict(
          "event-limit",
          "The bounded event log is full of retention-protected events.",
        );
      }
      events.splice(evictable, 1);
    }
    this.#events.set(id, events);
    this.#nextEventSeq.set(id, expectedSeq + 1);
  }

  async listEvents(id: string, limit?: number): Promise<ExportJobEventV1[]> {
    this.#require(id);
    const bounded = boundedLimit(limit, DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT);
    return (this.#events.get(id) ?? []).slice(-bounded).map(clone);
  }

  async finalizeArtifact(finalize: ExportJobFinalizeV1): Promise<ExportJobSnapshotV1> {
    const current = this.#require(finalize.id);
    const next = finalizeExportJobArtifact(current, {
      ...finalize,
      observedAt: this.#now(),
    });
    const persisted = clone(next);
    parseExportJobSnapshotV1(persisted);
    this.#artifacts.commitStaged(finalize.stagedArtifact, finalize.finishedAt);
    this.#jobs.set(finalize.id, persisted);
    this.#recordStateTransition(current, persisted);
    return clone(persisted);
  }

  async acknowledge(id: string, expectedRevision: number, at: number): Promise<ExportJobSnapshotV1> {
    return this.#replace(id, (snapshot) =>
      updateExportJobTerminalMetadata(snapshot, { expectedRevision, acknowledgedAt: at }),
    );
  }

  async dismiss(id: string, expectedRevision: number, at: number): Promise<ExportJobSnapshotV1> {
    return this.#replace(id, (snapshot) =>
      updateExportJobTerminalMetadata(snapshot, { expectedRevision, dismissedAt: at }),
    );
  }

  async deliver(id: string, expectedRevision: number, at: number): Promise<ExportJobSnapshotV1> {
    return this.#replace(id, (snapshot) =>
      updateExportJobTerminalMetadata(snapshot, {
        expectedRevision,
        deliveredAt: at,
        ...(snapshot.acknowledgedAt === undefined ? { acknowledgedAt: at } : {}),
      }),
    );
  }

  async deleteTerminal(query: ExportJobDeleteQueryV1): Promise<ExportJobDeleteResultV1> {
    assertFiniteTime(query.finishedBefore, "Retention cutoff");
    const limit = boundedLimit(query.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const candidates = [...this.#jobs.values()]
      .filter((job) => isExportJobTerminal(job.state))
      .filter((job) => query.states === undefined || query.states.includes(job.state as never))
      .filter((job) => job.finishedAt !== undefined && job.finishedAt < query.finishedBefore)
      .filter(
        (job) =>
          job.state !== "succeeded" ||
          job.deliveredAt !== undefined ||
          job.dismissedAt !== undefined,
      )
      .sort((a, b) => a.finishedAt! - b.finishedAt! || a.id.localeCompare(b.id))
      .slice(0, limit);

    const deletedJobIds: string[] = [];
    const tombstoneRefs: string[] = [];
    for (const job of candidates) {
      const retainedRequest = this.#requests.get(job.requestRef);
      if (!retainedRequest) {
        throw new InMemoryExportStoreConflict(
          "retention-protected",
          `Job ${job.id} has no retained request for a safe tombstone.`,
        );
      }
      const ref = `tombstone:${job.id}:${job.revision}`;
      const tombstone: ExportJobTombstoneV1 = {
        ref,
        jobId: job.id,
        requestRef: job.requestRef,
        idempotencyKey: retainedRequest.idempotencyKey,
        ...(job.derivedFrom ? { derivationKey: derivationKey(job.derivedFrom) } : {}),
        finalState: job.state as ExportJobTombstoneV1["finalState"],
        finalRevision: job.revision,
        finishedAt: job.finishedAt!,
        deletedAt: this.#now(),
        ownedRefs: [
          job.requestRef,
          `events:${job.id}`,
          `spool:${job.id}`,
          ...(job.checkpointRef ? [job.checkpointRef] : []),
          ...(job.artifact ? [job.artifact.ref] : []),
          ...(job.reportRef ? [job.reportRef] : []),
        ],
      };
      this.#tombstones.set(job.id, tombstone);
      this.#jobs.delete(job.id);
      this.#requests.delete(job.requestRef);
      this.#events.delete(job.id);
      this.#nextEventSeq.delete(job.id);
      this.#stateTransitions.delete(job.id);
      if (job.artifact) this.#artifacts.deleteCommitted(job.artifact.ref);
      deletedJobIds.push(job.id);
      tombstoneRefs.push(ref);
    }
    return { deletedJobIds, tombstoneRefs };
  }

  async getTombstone(jobId: string): Promise<ExportJobTombstoneV1 | undefined> {
    const tombstone = this.#tombstones.get(jobId);
    return tombstone ? clone(tombstone) : undefined;
  }

  #require(id: string): ExportJobSnapshotV1 {
    const snapshot = this.#jobs.get(id);
    if (!snapshot) throw new InMemoryExportStoreConflict("job-not-found", `Job ${id} was not found.`);
    return snapshot;
  }

  #replace(
    id: string,
    mutate: (snapshot: ExportJobSnapshotV1) => ExportJobSnapshotV1,
  ): Promise<ExportJobSnapshotV1> {
    const current = this.#require(id);
    const next = mutate(current);
    const persisted = clone(next);
    parseExportJobSnapshotV1(persisted);
    this.#jobs.set(id, persisted);
    this.#recordStateTransition(current, persisted);
    return Promise.resolve(clone(persisted));
  }

  #recordStateTransition(
    previous: ExportJobSnapshotV1,
    next: ExportJobSnapshotV1,
  ): void {
    if (previous.state === next.state) return;
    const transitions = this.#stateTransitions.get(next.id) ?? new Map();
    transitions.set(next.revision, { from: previous.state, to: next.state });
    this.#stateTransitions.set(next.id, transitions);
  }

  #assertExecutorWrite(
    snapshot: ExportJobSnapshotV1,
    expectedRevision: number,
    leaseEpoch: number | undefined,
    at: number,
  ): void {
    if (snapshot.revision !== expectedRevision) {
      throw new InMemoryExportStoreConflict("revision-conflict", "Executor revision is stale.");
    }
    assertFiniteTime(at, "Executor write time");
    if ((snapshot.state !== "running" && snapshot.state !== "cancelling") || !snapshot.lease) {
      throw new InMemoryExportStoreConflict("lease-required", "Executor write requires a live lease.");
    }
    if (leaseEpoch === undefined || leaseEpoch !== snapshot.lease.epoch || leaseEpoch !== snapshot.leaseEpoch) {
      throw new InMemoryExportStoreConflict("lease-mismatch", "Executor lease epoch is stale.");
    }
    if (at >= snapshot.lease.expiresAt) {
      throw new InMemoryExportStoreConflict("lease-expired", "Executor lease has expired.");
    }
  }

  #assertEventMatchesSnapshot(
    snapshot: ExportJobSnapshotV1,
    event: ExportJobEventV1,
  ): void {
    if (event.kind === "state") {
      const transition = this.#stateTransitions.get(snapshot.id)?.get(snapshot.revision);
      if (!transition || event.from !== transition.from || event.to !== transition.to) {
        throw new InMemoryExportStoreConflict(
          "invalid-event",
          "State event must describe the exact transition at the expected revision.",
        );
      }
    }
    if (event.kind === "stage" && event.stage !== snapshot.stage) {
      throw new InMemoryExportStoreConflict("invalid-event", "Stage event does not match the snapshot.");
    }
    if (event.kind === "progress" && canonical(event.progress) !== canonical(snapshot.progress)) {
      throw new InMemoryExportStoreConflict(
        "invalid-event",
        "Progress event does not match the bounded snapshot projection.",
      );
    }
    if (
      event.kind === "artifact" &&
      (!snapshot.artifact || canonical(event.artifact) !== canonical(snapshot.artifact))
    ) {
      throw new InMemoryExportStoreConflict(
        "invalid-event",
        "Artifact event does not match the committed snapshot artifact.",
      );
    }
    if (event.kind === "recovery" && event.leaseEpoch > snapshot.leaseEpoch) {
      throw new InMemoryExportStoreConflict(
        "invalid-event",
        "Recovery event cannot name a future lease epoch.",
      );
    }
  }

  #assertReplayCandidate(
    request: ExportJobRequestV1,
    derivedFrom: NonNullable<ExportJobCreateV1["derivedFrom"]>,
    existingDerivedId?: string,
  ): void {
    const origin = this.#jobs.get(derivedFrom.jobId);
    const originRequest = origin ? this.#requests.get(origin.requestRef) : undefined;
    if (!origin || !originRequest || !isExportJobTerminal(origin.state)) {
      throw new InMemoryExportStoreConflict(
        "derivation-conflict",
        "Replay ancestry must reference an existing terminal origin.",
      );
    }
    const allowed =
      derivedFrom.relation === "retry"
        ? origin.state === "failed" || origin.state === "interrupted" || origin.state === "cancelled"
        : origin.state === "succeeded";
    if (!allowed) {
      throw new InMemoryExportStoreConflict(
        "derivation-conflict",
        `${derivedFrom.relation} is not allowed from ${origin.state}.`,
      );
    }
    if (
      request.id === origin.id ||
      request.format !== origin.format ||
      request.renderer !== origin.renderer ||
      replayPayload(request) !== replayPayload(originRequest) ||
      request.priority !== (derivedFrom.relation === "retry" ? "retry" : "interactive")
    ) {
      throw new InMemoryExportStoreConflict(
        "derivation-conflict",
        "Replay request does not match the origin's replay-safe content.",
      );
    }
    if (existingDerivedId) {
      const existing = this.#jobs.get(existingDerivedId);
      if (!existing || canonical(existing.derivedFrom) !== canonical(derivedFrom)) {
        throw new InMemoryExportStoreConflict(
          "derivation-conflict",
          "Stored derivation index does not match the replay relation.",
        );
      }
    }
  }
}

export type InMemoryByteStoreConflictCode =
  | "invalid-limit"
  | "object-limit"
  | "job-limit"
  | "total-limit"
  | "length-mismatch"
  | "digest-mismatch"
  | "ownership-mismatch"
  | "not-committed";

export class InMemoryByteStoreConflict extends Error {
  readonly code: InMemoryByteStoreConflictCode;

  constructor(code: InMemoryByteStoreConflictCode, message: string) {
    super(message);
    this.name = "InMemoryByteStoreConflict";
    this.code = code;
  }
}

function refKey(ref: SpoolRefV1): string {
  return canonical([ref.jobId, ref.leaseEpoch, ref.namespace, ref.key]);
}

function assertByteLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InMemoryByteStoreConflict("invalid-limit", `${label} must be a non-negative safe integer.`);
  }
}

async function collectBytes(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("Byte stores accept Uint8Array chunks.");
    if (!Number.isSafeInteger(length + chunk.byteLength) || length + chunk.byteLength > maxBytes) {
      throw new InMemoryByteStoreConflict("object-limit", "Object byte limit exceeded.");
    }
    chunks.push(chunk.slice());
    length += chunk.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function* bytesIterable(bytes: Uint8Array, signal?: AbortSignal): AsyncIterable<Uint8Array> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  yield bytes.slice();
}

interface StoredSpoolObject {
  metadata: SpoolObjectV1;
  bytes: Uint8Array;
}

export interface InMemorySpoolStoreOptions {
  now?: () => number;
}

/** Atomic, bounded in-memory spool reference adapter. */
export class InMemorySpoolStore implements ExportSpoolStore {
  readonly #objects = new Map<string, StoredSpoolObject>();
  readonly #now: () => number;
  #commitTail: Promise<void> = Promise.resolve();

  constructor(options: InMemorySpoolStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  async put(
    ref: SpoolRefV1,
    source: AsyncIterable<Uint8Array>,
    limits: SpoolWriteLimitsV1,
  ): Promise<SpoolObjectV1> {
    assertNonEmpty(ref.jobId, "Spool job id");
    if (!Number.isSafeInteger(ref.leaseEpoch) || ref.leaseEpoch <= 0) {
      throw new InMemoryByteStoreConflict(
        "ownership-mismatch",
        "Spool lease epoch must be a positive safe integer.",
      );
    }
    assertNonEmpty(ref.namespace, "Spool namespace");
    assertNonEmpty(ref.key, "Spool key");
    assertByteLimit(limits.maxObjectBytes, "Object limit");
    assertByteLimit(limits.maxJobBytes, "Job limit");
    assertByteLimit(limits.maxTotalBytes, "Total limit");
    const key = refKey(ref);
    const bytes = await collectBytes(source, limits.maxObjectBytes);
    const digest = await sha256Hex(bytes);
    const metadata: SpoolObjectV1 = {
      ref: clone(ref),
      byteLength: bytes.byteLength,
      sha256: digest,
      committedAt: this.#now(),
    };
    return this.#commit(() => {
      const existing = this.#objects.get(key);
      if (existing) {
        if (
          existing.metadata.byteLength !== bytes.byteLength ||
          existing.metadata.sha256 !== digest
        ) {
          throw new InMemoryByteStoreConflict(
            "ownership-mismatch",
            "A committed spool ref cannot be replaced by different bytes.",
          );
        }
        return clone(existing.metadata);
      }
      const jobBytes = [...this.#objects.values()]
        .filter((entry) => entry.metadata.ref.jobId === ref.jobId)
        .reduce((sum, entry) => sum + entry.bytes.byteLength, 0) + bytes.byteLength;
      const totalBytes = [...this.#objects.values()]
        .reduce((sum, entry) => sum + entry.bytes.byteLength, 0) + bytes.byteLength;
      if (jobBytes > limits.maxJobBytes) {
        throw new InMemoryByteStoreConflict("job-limit", "Per-job spool byte limit exceeded.");
      }
      if (totalBytes > limits.maxTotalBytes) {
        throw new InMemoryByteStoreConflict("total-limit", "Total spool byte limit exceeded.");
      }
      this.#objects.set(key, { metadata, bytes });
      return clone(metadata);
    });
  }

  read(ref: SpoolRefV1, options?: { signal?: AbortSignal }): AsyncIterable<Uint8Array> {
    const stored = this.#objects.get(refKey(ref));
    if (!stored) throw new Error("Spool object was not found.");
    return bytesIterable(stored.bytes, options?.signal);
  }

  async stat(ref: SpoolRefV1): Promise<SpoolObjectV1 | undefined> {
    const stored = this.#objects.get(refKey(ref));
    return stored ? clone(stored.metadata) : undefined;
  }

  async deleteNamespace(jobId: string, leaseEpoch: number): Promise<void> {
    for (const [key, entry] of this.#objects) {
      if (
        entry.metadata.ref.jobId === jobId &&
        entry.metadata.ref.leaseEpoch === leaseEpoch
      ) {
        this.#objects.delete(key);
      }
    }
  }

  async #commit<T>(operation: () => T): Promise<T> {
    const previous = this.#commitTail;
    let release!: () => void;
    this.#commitTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  }
}

interface StoredArtifact {
  metadata: StagedArtifactV1;
  bytes: Uint8Array;
}

export interface InMemoryArtifactStoreOptions {
  now?: () => number;
  maxArtifactBytes?: number;
  maxTotalBytes?: number;
}

/** In-memory two-phase artifact adapter: staged bytes are unreadable until commit. */
export class InMemoryArtifactStore implements ExportArtifactStore {
  readonly #staged = new Map<string, StoredArtifact>();
  readonly #committed = new Map<string, StoredArtifact>();
  readonly #now: () => number;
  readonly #maxArtifactBytes: number;
  readonly #maxTotalBytes: number;

  constructor(options: InMemoryArtifactStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxArtifactBytes = options.maxArtifactBytes ?? Number.MAX_SAFE_INTEGER;
    this.#maxTotalBytes = options.maxTotalBytes ?? Number.MAX_SAFE_INTEGER;
    assertByteLimit(this.#maxArtifactBytes, "Artifact limit");
    assertByteLimit(this.#maxTotalBytes, "Artifact total limit");
  }

  async stage(
    jobId: string,
    leaseEpoch: number,
    artifact: PendingArtifactV1,
  ): Promise<StagedArtifactV1> {
    assertNonEmpty(jobId, "Artifact job id");
    if (!Number.isSafeInteger(leaseEpoch) || leaseEpoch <= 0) {
      throw new InMemoryByteStoreConflict("ownership-mismatch", "Artifact lease epoch must be positive.");
    }
    assertByteLimit(artifact.byteLength, "Declared artifact length");
    const bytes = await collectBytes(artifact.bytes, this.#maxArtifactBytes);
    if (bytes.byteLength !== artifact.byteLength) {
      throw new InMemoryByteStoreConflict("length-mismatch", "Artifact byte length does not match.");
    }
    const digest = await sha256Hex(bytes);
    if (digest.toLowerCase() !== artifact.sha256.toLowerCase()) {
      throw new InMemoryByteStoreConflict("digest-mismatch", "Artifact SHA-256 does not match.");
    }
    const ref = `artifact:${jobId.length}:${jobId}:${leaseEpoch}`;
    const existing = this.#staged.get(ref) ?? this.#committed.get(ref);
    const total = this.#totalBytes() - (existing?.bytes.byteLength ?? 0) + bytes.byteLength;
    if (total > this.#maxTotalBytes) {
      throw new InMemoryByteStoreConflict("total-limit", "Total artifact byte limit exceeded.");
    }
    if (existing) {
      if (
        existing.metadata.jobId !== jobId ||
        existing.metadata.leaseEpoch !== leaseEpoch ||
        existing.metadata.sha256.toLowerCase() !== digest ||
        existing.metadata.filename !== artifact.filename ||
        existing.metadata.mediaType !== artifact.mediaType
      ) {
        throw new InMemoryByteStoreConflict(
          "ownership-mismatch",
          "A staged artifact ref cannot be replaced by different bytes or metadata.",
        );
      }
      return clone(existing.metadata);
    }
    const metadata: StagedArtifactV1 = {
      ref,
      mediaType: artifact.mediaType,
      filename: artifact.filename,
      byteLength: bytes.byteLength,
      sha256: digest,
      jobId,
      leaseEpoch,
      stagedAt: this.#now(),
    };
    this.#staged.set(ref, { metadata, bytes });
    return clone(metadata);
  }

  async getStaged(jobId: string, leaseEpoch: number): Promise<StagedArtifactV1 | undefined> {
    const stored = this.#staged.get(`artifact:${jobId.length}:${jobId}:${leaseEpoch}`);
    return stored ? clone(stored.metadata) : undefined;
  }

  read(ref: string): AsyncIterable<Uint8Array> {
    const stored = this.#committed.get(ref);
    if (!stored) {
      throw new InMemoryByteStoreConflict("not-committed", "Artifact is not committed and visible.");
    }
    return bytesIterable(stored.bytes);
  }

  async deleteStaged(ref: string): Promise<void> {
    this.#staged.delete(ref);
  }

  /** Atomically promote an owned staged artifact; used by the reference job store finalizer. */
  commitStaged(staged: StagedArtifactV1, committedAt: number): void {
    assertFiniteTime(committedAt, "Artifact commit time");
    const stored = this.#staged.get(staged.ref);
    if (
      !stored ||
      canonical(stored.metadata) !== canonical(staged) ||
      committedAt < stored.metadata.stagedAt
    ) {
      throw new InMemoryByteStoreConflict(
        "ownership-mismatch",
        "Only the exact owned staged artifact can be committed.",
      );
    }
    this.#staged.delete(staged.ref);
    this.#committed.set(staged.ref, stored);
  }

  /** Retention-only removal of already committed bytes. */
  deleteCommitted(ref: string): void {
    this.#committed.delete(ref);
  }

  isCommitted(ref: string): boolean {
    return this.#committed.has(ref);
  }

  #totalBytes(): number {
    return [...this.#staged.values(), ...this.#committed.values()].reduce(
      (sum, entry) => sum + entry.bytes.byteLength,
      0,
    );
  }
}
