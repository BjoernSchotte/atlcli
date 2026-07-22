import { createHash } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  claimExportJob,
  checkpointExportJob,
  finalizeExportJobArtifact,
  heartbeatExportJob,
  isExportJobTerminal,
  orderExportQueue,
  parseExportJobEventV1,
  parseExportJobRequestV1,
  parseExportJobSnapshotV1,
  prepareExportArtifactFinalizationIntent,
  reclaimExpiredExportJobLease,
  transitionExportJob,
  updateExportJobProgress,
  updateExportJobStats,
  updateExportJobTerminalMetadata,
  type ExportArtifactFinalizationIntentV1,
  type ExportArtifactV1,
  type ExportJobCreateV1,
  type ExportJobDeleteQueryV1,
  type ExportJobDeleteResultV1,
  type ExportJobEventAppendV1,
  type ExportJobEventV1,
  type ExportJobEventPageV1,
  type ExportJobEventQueryV1,
  type ExportJobEventReaderV1,
  type ExportJobFinalizeV1,
  type ExportJobQueryV1,
  type ExportJobRequestV1,
  type ExportJobSnapshotV1,
  type ExportJobStore,
  type ExportJobTombstoneV1,
  type ExportJobUpdateV1,
  type ExportJobClaimV1,
  type ExportJobStatsV1,
} from "@atlcli/export-jobs";
import { ensurePrivateDirectory, writeDurableAtomic } from "./atomic-fs.js";
import { FileExportLock } from "./file-lock.js";

const JOURNAL_NAME = /^([0-9]{20})\.json$/;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const MAX_EVENT_LIMIT = 1_000;

interface FileExportCatalogV1 {
  schema: "atlcli.file-export-catalog/1";
  sequence: number;
  jobs: Record<string, ExportJobSnapshotV1>;
  requests: Record<string, ExportJobRequestV1>;
  idempotency: Record<string, string>;
  derivations: Record<string, string>;
  events: Record<string, ExportJobEventV1[]>;
  nextEventSeq: Record<string, number>;
  tombstones: Record<string, ExportJobTombstoneV1>;
  transitions: Record<string, Record<string, { from: ExportJobSnapshotV1["state"]; to: ExportJobSnapshotV1["state"] }>>;
  lastClaimedGroup: Partial<Record<"interactive" | "retry", string>>;
  finalizations: Record<string, ExportArtifactFinalizationIntentV1>;
  executorCheckpoints: Record<string, { checkpoint: unknown; manifestRef: import("@atlcli/export-jobs").SpoolRefV1 }>;
  executorResults: Record<string, { intent: unknown; reportRef: string; reportPath: string; result?: import("@atlcli/export-jobs").ExportJobExecutionResultV1 }>;
}

export interface FileExportArtifactFinalizer {
  commitFinalization(intent: ExportArtifactFinalizationIntentV1): Promise<ExportArtifactV1>;
}

export interface FileExportJobStoreOptions {
  now?: () => number;
  lockTtlMs?: number;
  artifactFinalizer?: FileExportArtifactFinalizer;
}

export class FileExportJobStoreConflict extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FileExportJobStoreConflict";
    this.code = code;
  }
}

function emptyCatalog(): FileExportCatalogV1 {
  return {
    schema: "atlcli.file-export-catalog/1",
    sequence: 0,
    jobs: {}, requests: {}, idempotency: {}, derivations: {}, events: {}, nextEventSeq: {},
    tombstones: {}, transitions: {}, lastClaimedGroup: {}, finalizations: {}, executorCheckpoints: {}, executorResults: {},
  };
}

function emptyStats(): ExportJobStatsV1 {
  return {
    pages: { discovered: 0, fetched: 0, composed: 0, skipped: 0 },
    assets: { discovered: 0, fetched: 0, embedded: 0, skipped: 0, deduplicated: 0, logicalBytes: 0, physicalBytes: 0 },
    diagrams: { discovered: 0, rendered: 0, rasterized: 0, failed: 0 },
    macros: { discovered: 0, rendered: 0, approximated: 0, unresolved: 0 },
    retries: { total: 0, rateLimited: 0, network: 0, worker: 0 },
    storage: { spoolBytes: 0, spoolPeakBytes: null, outputBytes: 0 },
    memory: { heapPeakBytes: null, rendererPeakBytes: null }, metricSupport: {}, durationsMs: {}, warnings: 0, errors: 0,
  };
}

function clone<T>(value: T): T { return structuredClone(value); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
function boundedLimit(value: number | undefined, fallback = DEFAULT_LIST_LIMIT): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Query limit must be non-negative.");
  return Math.min(value, MAX_LIST_LIMIT);
}
function requestRef(request: ExportJobRequestV1): string { return `request:${request.id}`; }
function derivationKey(value: NonNullable<ExportJobCreateV1["derivedFrom"]>): string {
  return canonical([value.jobId, value.relation, value.actionKey]);
}
function locatorLabel(request: ExportJobRequestV1): string {
  switch (request.source.locator.kind) {
    case "page-id": return request.source.locator.id;
    case "content-key": return request.source.locator.value;
    case "space-key": return request.source.locator.spaceKey;
  }
}
function replayPayloadWithoutOutput(request: ExportJobRequestV1): string {
  const { id: _id, idempotencyKey: _key, createdAt: _at, priority: _priority, output: _output, ...rest } = request;
  return canonical(rest);
}
function replayPayload(request: ExportJobRequestV1): string {
  const { id: _id, idempotencyKey: _key, createdAt: _at, priority: _priority, ...rest } = request;
  return canonical(rest);
}
function finalizationRef(input: ExportJobFinalizeV1): string {
  return prepareExportArtifactFinalizationIntent(input).ref;
}

/** Durable metadata store. Each committed journal file is one complete atomic catalog revision. */
export class FileExportJobStore implements ExportJobStore, ExportJobEventReaderV1 {
  readonly rootDir: string;
  readonly #journalDir: string;
  readonly #lock: FileExportLock;
  readonly #now: () => number;
  readonly #artifactFinalizer?: FileExportArtifactFinalizer;

  constructor(rootDir: string, options: FileExportJobStoreOptions = {}) {
    this.rootDir = rootDir;
    this.#journalDir = join(rootDir, "journal");
    this.#lock = new FileExportLock(join(rootDir, "locks", "journal.lock"), { ttlMs: options.lockTtlMs ?? 30_000, now: options.now });
    this.#now = options.now ?? Date.now;
    this.#artifactFinalizer = options.artifactFinalizer;
  }

  async create(input: ExportJobCreateV1): Promise<ExportJobSnapshotV1> {
    return this.#mutate((catalog) => {
      const request = clone(parseExportJobRequestV1(clone(input.request)));
      const dkey = input.derivedFrom ? derivationKey(input.derivedFrom) : undefined;
      const byDerivation = dkey ? catalog.derivations[dkey] : undefined;
      const byIdempotency = catalog.idempotency[request.idempotencyKey];
      if (byDerivation && byIdempotency && byDerivation !== byIdempotency) throw new FileExportJobStoreConflict("derivation-conflict", "Keys resolve to different jobs.");
      if (byDerivation) {
        this.#assertReplay(catalog, request, input.derivedFrom!, byDerivation);
        const existing = catalog.jobs[byDerivation];
        if (!existing) throw new FileExportJobStoreConflict("job-deleted", `Job ${byDerivation} was deleted.`);
        return { result: clone(existing), changed: false };
      }
      if (byIdempotency) {
        const existing = catalog.jobs[byIdempotency];
        if (!existing) throw new FileExportJobStoreConflict("job-deleted", `Job ${byIdempotency} was deleted.`);
        const stored = catalog.requests[existing.requestRef];
        if (!stored || canonical(stored) !== canonical(request)) {
          throw new FileExportJobStoreConflict("idempotency-conflict", "A durable key was reused with different input.");
        }
        if (canonical(existing.derivedFrom) !== canonical(input.derivedFrom)) throw new FileExportJobStoreConflict("derivation-conflict", "An idempotent acknowledgement cannot change replay ancestry.");
        return { result: clone(existing), changed: false };
      }
      if (catalog.jobs[request.id] || catalog.tombstones[request.id]) throw new FileExportJobStoreConflict("duplicate-id", `Job ${request.id} already exists.`);
      if (input.derivedFrom) this.#assertReplay(catalog, request, input.derivedFrom);
      const ref = requestRef(request);
      const snapshot: ExportJobSnapshotV1 = {
        schema: "atlcli.export-job/1", id: request.id, revision: 0, requestRef: ref,
        format: request.format, renderer: request.renderer,
        summary: { displayName: request.displayName, sourceLabel: locatorLabel(request), siteOrigin: request.source.siteOrigin, scopeKind: request.source.scope.kind },
        queue: { priority: request.priority, enqueuedAt: request.createdAt, groupKey: request.source.siteOrigin },
        state: "queued", attempt: 0, recoveryCount: 0, leaseEpoch: 0, stats: emptyStats(), createdAt: request.createdAt,
        ...(input.derivedFrom ? { derivedFrom: clone(input.derivedFrom) } : {}),
      };
      parseExportJobSnapshotV1(snapshot);
      catalog.jobs[snapshot.id] = clone(snapshot); catalog.requests[ref] = request;
      catalog.idempotency[request.idempotencyKey] = snapshot.id;
      if (dkey) catalog.derivations[dkey] = snapshot.id;
      catalog.events[snapshot.id] = []; catalog.nextEventSeq[snapshot.id] = 1; catalog.transitions[snapshot.id] = {};
      return { result: clone(snapshot), changed: true };
    });
  }

  async get(id: string): Promise<ExportJobSnapshotV1 | undefined> { return this.#read((c) => c.jobs[id] ? clone(c.jobs[id]) : undefined); }
  async getRequest(ref: string): Promise<ExportJobRequestV1 | undefined> { return this.#read((c) => c.requests[ref] ? clone(c.requests[ref]) : undefined); }
  async list(query: ExportJobQueryV1 & { createdAfter?: number } = {}): Promise<ExportJobSnapshotV1[]> {
    return this.#read((catalog) => Object.values(catalog.jobs)
      .filter((j) => !query.formats || query.formats.includes(j.format))
      .filter((j) => !query.states || query.states.includes(j.state))
      .filter((j) => !query.stages || (j.stage !== undefined && query.stages.includes(j.stage)))
      .filter((j) => query.includeDismissed === true || j.dismissedAt === undefined)
      .filter((j) => query.createdBefore === undefined || j.createdAt < query.createdBefore)
      .filter((j) => query.createdAfter === undefined || j.createdAt > query.createdAfter)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)).slice(0, boundedLimit(query.limit)).map(clone));
  }

  async claimNext(claim: ExportJobClaimV1): Promise<ExportJobSnapshotV1 | undefined> {
    return this.#mutate((catalog) => {
      const observedAt = this.#now();
      const ordered = orderExportQueue(Object.values(catalog.jobs).filter((j) =>
        (j.state === "queued" || (j.state === "waiting" && j.waiting?.until !== undefined && j.waiting.until <= observedAt)) &&
        (!claim.ids || claim.ids.includes(j.id)) &&
        (!claim.formats || claim.formats.includes(j.format)) &&
        (!claim.authRefs || claim.authRefs.includes(catalog.requests[j.requestRef]?.authRef ?? ""))));
      const first = ordered[0];
      if (!first) return { result: undefined, changed: false };
      const groups = [...new Set(ordered.filter((j) => j.queue.priority === first.queue.priority).map((j) => j.queue.groupKey))];
      const previous = catalog.lastClaimedGroup[first.queue.priority];
      const candidateGroup = groups[(groups.indexOf(previous ?? "") + 1) % groups.length]!;
      const candidate = ordered.find((j) => j.queue.priority === first.queue.priority && j.queue.groupKey === candidateGroup) ?? first;
      const next = claimExportJob(candidate, { expectedRevision: candidate.revision, ownerId: claim.ownerId, now: claim.now, observedAt, leaseDurationMs: claim.leaseDurationMs });
      this.#replace(catalog, candidate, next); catalog.lastClaimedGroup[candidate.queue.priority] = candidate.queue.groupKey;
      return { result: clone(next), changed: true };
    });
  }

  async compareAndSet(update: ExportJobUpdateV1): Promise<ExportJobSnapshotV1> {
    return this.#mutate((catalog) => {
      const current = this.#require(catalog, update.id); const observedAt = this.#now();
      let next: ExportJobSnapshotV1;
      switch (update.kind) {
        case "transition": next = transitionExportJob(current, { ...update, observedAt }); break;
        case "heartbeat": next = heartbeatExportJob(current, { ...update, observedAt }); break;
        case "progress": next = updateExportJobProgress(current, { ...update, observedAt }); break;
        case "reclaim-expired": next = reclaimExpiredExportJobLease(current, { ...update, observedAt }); break;
        case "checkpoint":
          if (current.checkpointRef === update.checkpointRef && current.leaseEpoch === update.leaseEpoch) return { result: clone(current), changed: false };
          next = checkpointExportJob(current, { ...update, observedAt }); break;
        case "stats": next = updateExportJobStats(current, { ...update, observedAt }); break;
      }
      this.#replace(catalog, current, next);
      return { result: clone(next), changed: true };
    });
  }

  async appendEvent(id: string, input: ExportJobEventAppendV1): Promise<void> {
    await this.#mutate((catalog) => {
      const snapshot = this.#require(catalog, id); const event = parseExportJobEventV1(clone(input.event));
      if (snapshot.revision !== input.expectedRevision) throw new FileExportJobStoreConflict("revision-conflict", "Event revision is stale.");
      if (snapshot.state === "running" || snapshot.state === "cancelling") {
        if (input.leaseEpoch !== snapshot.leaseEpoch || !snapshot.lease) throw new FileExportJobStoreConflict("lease-mismatch", "Event lease is stale.");
        if (this.#now() >= snapshot.lease.expiresAt) throw new FileExportJobStoreConflict("lease-expired", "Event lease expired.");
      }
      if (snapshot.state !== "running" && snapshot.state !== "cancelling" && input.leaseEpoch !== undefined && input.leaseEpoch !== snapshot.leaseEpoch) throw new FileExportJobStoreConflict("lease-mismatch", "Event lease epoch is stale.");
      const expected = catalog.nextEventSeq[id] ?? 1;
      if (event.seq !== expected) throw new FileExportJobStoreConflict("invalid-event", `Expected event sequence ${expected}.`);
      this.#assertEvent(catalog, snapshot, event);
      const events = catalog.events[id] ?? [];
      const previous = events.at(-1);
      if (event.kind === "progress" && previous?.kind === "progress" && previous.progress.stage === event.progress.stage && event.at - previous.at < 500) events[events.length - 1] = event;
      else events.push(event);
      while (events.length > MAX_EVENT_LIMIT) {
        const index = events.findIndex((e) => e.kind === "progress" || (e.kind === "issue" && e.level === "info"));
        if (index < 0) throw new FileExportJobStoreConflict("event-limit", "Durable event log is full.");
        events.splice(index, 1);
      }
      catalog.events[id] = events; catalog.nextEventSeq[id] = expected + 1;
      return { result: undefined, changed: true };
    });
  }

  async readEvents(id: string, query: ExportJobEventQueryV1 = {}): Promise<ExportJobEventPageV1> {
    const afterSeq = query.afterSeq ?? 0;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new RangeError("Event cursor must be a non-negative safe integer.");
    }
    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1)) {
      throw new RangeError("Event page limit must be a positive safe integer.");
    }
    const limit = Math.min(query.limit ?? 100, MAX_EVENT_LIMIT);
    return this.#read((catalog) => {
      this.#require(catalog, id);
      const candidates = (catalog.events[id] ?? []).filter((event) => event.seq > afterSeq);
      const events = candidates.slice(0, limit).map(clone);
      return {
        events,
        nextAfterSeq: events.at(-1)?.seq ?? afterSeq,
        hasMore: candidates.length > events.length,
      };
    });
  }

  async finalizeArtifact(input: ExportJobFinalizeV1): Promise<ExportJobSnapshotV1> {
    if (!this.#artifactFinalizer) throw new Error("FileExportJobStore requires an artifact finalizer.");
    const prepared = await this.#mutate((catalog) => {
      const current = this.#require(catalog, input.id);
      if (current.state === "succeeded") return { result: undefined, changed: false };
      const finalize = { ...input, observedAt: this.#now() };
      finalizeExportJobArtifact(current, finalize);
      const intent = prepareExportArtifactFinalizationIntent(finalize);
      const existing = catalog.finalizations[intent.ref];
      if (existing && canonical(existing) !== canonical(intent)) throw new FileExportJobStoreConflict("finalization-conflict", "Finalization ref was reused.");
      catalog.finalizations[intent.ref] = existing ?? intent;
      return { result: clone(catalog.finalizations[intent.ref]), changed: !existing };
    });
    if (prepared) await this.#finishFinalization(prepared);
    return (await this.get(input.id))!;
  }

  async reconcilePreparedArtifactFinalizations(): Promise<number> {
    const prepared = await this.#read((catalog) => Object.values(catalog.finalizations).filter((i) => i.status === "prepared").map(clone));
    for (const intent of prepared) await this.#finishFinalization(intent);
    return prepared.length;
  }

  async loadExecutorCheckpoint<T>(key: string): Promise<{ checkpoint: T; manifestRef: import("@atlcli/export-jobs").SpoolRefV1 } | undefined> {
    return this.#read((catalog) => catalog.executorCheckpoints[key] ? clone(catalog.executorCheckpoints[key] as { checkpoint: T; manifestRef: import("@atlcli/export-jobs").SpoolRefV1 }) : undefined);
  }

  /** Atomically publish executor checkpoint metadata and attach its ref to the live job. */
  async commitExecutorCheckpoint<T>(input: { key: string; jobId: string; leaseEpoch: number; checkpoint: T & { ref: string }; manifestRef: import("@atlcli/export-jobs").SpoolRefV1; at: number }): Promise<T> {
    return this.#mutate((catalog) => {
      const current = this.#require(catalog, input.jobId); this.#assertLiveLease(current, input.leaseEpoch);
      const existing = catalog.executorCheckpoints[input.key];
      if (existing) {
        if (canonical(existing) !== canonical({ checkpoint: input.checkpoint, manifestRef: input.manifestRef })) throw new FileExportJobStoreConflict("checkpoint-conflict", "Checkpoint key was reused with different input.");
        return { result: clone(existing.checkpoint as T), changed: false };
      }
      const next = checkpointExportJob(current, { expectedRevision: current.revision, leaseEpoch: input.leaseEpoch, at: input.at, observedAt: this.#now(), checkpointRef: input.checkpoint.ref });
      catalog.executorCheckpoints[input.key] = { checkpoint: clone(input.checkpoint), manifestRef: clone(input.manifestRef) }; this.#replace(catalog, current, next);
      return { result: clone(input.checkpoint), changed: true };
    });
  }

  async advanceExecutorCheckpointAttempt<T extends { renderAttempts: number }>(input: { key: string; jobId: string; leaseEpoch: number; expected: T }): Promise<T> {
    return this.#mutate((catalog) => {
      const current = this.#require(catalog, input.jobId); this.#assertLiveLease(current, input.leaseEpoch);
      const stored = catalog.executorCheckpoints[input.key]; if (!stored || canonical(stored.checkpoint) !== canonical(input.expected)) throw new FileExportJobStoreConflict("checkpoint-conflict", "Checkpoint attempt update is stale.");
      const next = { ...input.expected, renderAttempts: input.expected.renderAttempts + 1 }; stored.checkpoint = clone(next);
      return { result: clone(next), changed: true };
    });
  }

  async prepareExecutorResult(input: { key: string; jobId: string; leaseEpoch: number; intent: unknown; reportRef: string; reportPath: string }): Promise<unknown> {
    return this.#mutate((catalog) => {
      const current = this.#require(catalog, input.jobId); this.#assertLiveLease(current, input.leaseEpoch);
      const existing = catalog.executorResults[input.key];
      if (existing) { if (canonical(existing.intent) !== canonical(input.intent) || existing.reportRef !== input.reportRef || existing.reportPath !== input.reportPath) throw new FileExportJobStoreConflict("result-conflict", "Result key was reused."); return { result: clone(existing.intent), changed: false }; }
      catalog.executorResults[input.key] = { intent: clone(input.intent), reportRef: input.reportRef, reportPath: input.reportPath }; return { result: clone(input.intent), changed: true };
    });
  }
  async completeExecutorResult(input: { key: string; jobId: string; leaseEpoch: number; intent: unknown; result: import("@atlcli/export-jobs").ExportJobExecutionResultV1 }): Promise<void> {
    await this.#mutate((catalog) => { const current = this.#require(catalog, input.jobId); this.#assertLiveLease(current, input.leaseEpoch); const stored = catalog.executorResults[input.key]; if (!stored || canonical(stored.intent) !== canonical(input.intent)) throw new FileExportJobStoreConflict("result-conflict", "Prepared result is missing."); if (stored.result && canonical(stored.result) !== canonical(input.result)) throw new FileExportJobStoreConflict("result-conflict", "Different result is already complete."); stored.result ??= clone(input.result); return { result: undefined, changed: true }; });
  }
  async loadExecutorResult<TIntent>(key: string): Promise<{ intent: TIntent; result?: import("@atlcli/export-jobs").ExportJobExecutionResultV1 } | undefined> {
    return this.#read((catalog) => { const stored = catalog.executorResults[key]; return stored ? { intent: clone(stored.intent as TIntent), ...(stored.result ? { result: clone(stored.result) } : {}) } : undefined; });
  }
  async resolveExecutorReportPath(reportRef: string): Promise<string | undefined> { return this.#read((catalog) => Object.values(catalog.executorResults).find((value) => value.reportRef === reportRef)?.reportPath); }

  async #finishFinalization(intent: ExportArtifactFinalizationIntentV1): Promise<void> {
    const artifact = await this.#artifactFinalizer!.commitFinalization(intent);
    await this.#mutate((catalog) => {
      const stored = catalog.finalizations[intent.ref];
      if (!stored || canonical(stored.artifact) !== canonical(artifact)) throw new FileExportJobStoreConflict("finalization-conflict", "Prepared intent disappeared or changed.");
      const current = this.#require(catalog, intent.finalize.id);
      if (current.state !== "succeeded") this.#replace(catalog, current, finalizeExportJobArtifact(current, intent.finalize));
      else if (canonical(current.artifact) !== canonical(artifact)) throw new FileExportJobStoreConflict("revision-conflict", "Different terminal artifact exists.");
      catalog.finalizations[intent.ref] = { ...stored, status: "completed", completedAt: intent.finalize.finishedAt };
      return { result: undefined, changed: true };
    });
  }

  async acknowledge(id: string, expectedRevision: number, at: number): Promise<ExportJobSnapshotV1> { return this.#terminalMetadata(id, expectedRevision, { acknowledgedAt: at }); }
  async dismiss(id: string, expectedRevision: number, at: number): Promise<ExportJobSnapshotV1> { return this.#terminalMetadata(id, expectedRevision, { dismissedAt: at }); }
  async deliver(id: string, expectedRevision: number, at: number): Promise<ExportJobSnapshotV1> {
    return this.#mutate((c) => { const current = this.#require(c, id); const next = updateExportJobTerminalMetadata(current, { expectedRevision, deliveredAt: at, ...(current.acknowledgedAt === undefined ? { acknowledgedAt: at } : {}) }); this.#replace(c, current, next); return { result: clone(next), changed: true }; });
  }
  async #terminalMetadata(id: string, expectedRevision: number, metadata: { acknowledgedAt?: number; dismissedAt?: number }): Promise<ExportJobSnapshotV1> {
    return this.#mutate((c) => { const current = this.#require(c, id); const next = updateExportJobTerminalMetadata(current, { expectedRevision, ...metadata }); this.#replace(c, current, next); return { result: clone(next), changed: true }; });
  }

  async deleteTerminal(query: ExportJobDeleteQueryV1): Promise<ExportJobDeleteResultV1> {
    return this.#mutate((catalog) => {
      const candidates = Object.values(catalog.jobs).filter((j) => isExportJobTerminal(j.state) && j.finishedAt !== undefined && j.finishedAt < query.finishedBefore)
        .filter((j) => !query.states || query.states.includes(j.state as never)).filter((j) => j.state !== "succeeded" || j.deliveredAt !== undefined || j.dismissedAt !== undefined)
        .sort((a, b) => a.finishedAt! - b.finishedAt!).slice(0, boundedLimit(query.limit));
      for (const job of candidates) {
        const request = catalog.requests[job.requestRef]; if (!request) throw new Error("Cannot tombstone a job without its request.");
        const ref = `tombstone:${job.id}:${job.revision}`;
        catalog.tombstones[job.id] = { ref, jobId: job.id, requestRef: job.requestRef, idempotencyKey: request.idempotencyKey,
          ...(job.derivedFrom ? { derivationKey: derivationKey(job.derivedFrom) } : {}), finalState: job.state as ExportJobTombstoneV1["finalState"], finalRevision: job.revision,
          finishedAt: job.finishedAt!, deletedAt: this.#now(), ownedRefs: [job.requestRef, `events:${job.id}`, `spool:${job.id}`, ...(job.checkpointRef ? [job.checkpointRef] : []), ...(job.artifact ? [job.artifact.ref] : []), ...(job.reportRef ? [job.reportRef] : [])] };
        delete catalog.jobs[job.id]; delete catalog.requests[job.requestRef]; delete catalog.events[job.id]; delete catalog.nextEventSeq[job.id]; delete catalog.transitions[job.id];
      }
      return { result: { deletedJobIds: candidates.map((j) => j.id), tombstoneRefs: candidates.map((j) => catalog.tombstones[j.id]!.ref) }, changed: candidates.length > 0 };
    });
  }
  async getTombstone(jobId: string): Promise<ExportJobTombstoneV1 | undefined> { return this.#read((c) => c.tombstones[jobId] ? clone(c.tombstones[jobId]) : undefined); }
  async markTombstoneCleanupComplete(jobId: string, ref: string, at: number): Promise<ExportJobTombstoneV1> {
    const lease = await this.#lock.acquire({ label: "journal-cleanup" });
    try {
      const catalog = await this.#load();
      const value = catalog.tombstones[jobId];
      if (!value || value.ref !== ref) {
        throw new FileExportJobStoreConflict("job-not-found", "Tombstone not found.");
      }
      if (at < value.deletedAt) throw new RangeError("Cleanup predates tombstone.");

      const reportsRoot = resolve(this.rootDir, "reports");
      const reportPaths: string[] = [];
      for (const [key, stored] of Object.entries(catalog.executorResults)) {
        const intent = stored.intent as { key?: { jobId?: unknown }; jobId?: unknown };
        const owner = intent.key?.jobId ?? intent.jobId;
        if (owner !== jobId) continue;
        const reportPath = resolve(stored.reportPath);
        if (reportPath !== reportsRoot && !reportPath.startsWith(`${reportsRoot}${sep}`)) {
          throw new Error("Executor report path escaped the private report directory.");
        }
        reportPaths.push(reportPath);
        delete catalog.executorResults[key];
      }
      for (const [key, stored] of Object.entries(catalog.executorCheckpoints)) {
        if ((stored.checkpoint as { jobId?: unknown }).jobId === jobId) {
          delete catalog.executorCheckpoints[key];
        }
      }
      for (const [key, intent] of Object.entries(catalog.finalizations)) {
        if (intent.finalize.id === jobId) delete catalog.finalizations[key];
      }

      const projectionKey = createHash("sha256").update(jobId).digest("hex");
      await Promise.all([
        ...reportPaths.map((path) => rm(path, { force: true })),
        rm(join(this.rootDir, "cli-projections", `${projectionKey}.json`), { force: true }),
      ]);
      value.cleanupCompletedAt ??= at;
      await lease.assertOwned();
      catalog.sequence += 1;
      await this.#commit(catalog);
      return clone(value);
    } finally {
      await lease.release();
    }
  }

  async #read<T>(read: (catalog: FileExportCatalogV1) => T): Promise<T> {
    const lease = await this.#lock.acquire({ label: "journal-read" });
    try { return read(await this.#load()); } finally { await lease.release(); }
  }
  async #mutate<T>(mutate: (catalog: FileExportCatalogV1) => { result: T; changed: boolean }): Promise<T> {
    const lease = await this.#lock.acquire({ label: "journal-write" });
    try {
      const catalog = await this.#load(); const change = mutate(catalog);
      if (change.changed) { await lease.assertOwned(); catalog.sequence += 1; await this.#commit(catalog); }
      return change.result;
    } finally { await lease.release(); }
  }
  async #load(): Promise<FileExportCatalogV1> {
    await ensurePrivateDirectory(this.rootDir);
    await ensurePrivateDirectory(this.#journalDir);
    const entries = (await readdir(this.#journalDir)).flatMap((name) => { const m = JOURNAL_NAME.exec(name); return m ? [{ name, sequence: Number(m[1]) }] : []; }).sort((a, b) => b.sequence - a.sequence);
    if (!entries[0]) return emptyCatalog();
    const catalog = JSON.parse(await readFile(join(this.#journalDir, entries[0].name), "utf8")) as FileExportCatalogV1;
    if (catalog.schema !== "atlcli.file-export-catalog/1" || catalog.sequence !== entries[0].sequence) throw new Error("Export job journal head is invalid.");
    catalog.executorCheckpoints ??= {}; catalog.executorResults ??= {};
    for (const request of Object.values(catalog.requests)) parseExportJobRequestV1(request);
    for (const snapshot of Object.values(catalog.jobs)) parseExportJobSnapshotV1(snapshot);
    for (const events of Object.values(catalog.events)) for (const event of events) parseExportJobEventV1(event);
    return catalog;
  }
  async #commit(catalog: FileExportCatalogV1): Promise<void> {
    await writeDurableAtomic(join(this.#journalDir, `${catalog.sequence.toString().padStart(20, "0")}.json`), `${JSON.stringify(catalog)}\n`);
    // Each head is self-contained. Retain a bounded rollback window so frequent
    // progress/heartbeat writes cannot grow the private journal forever.
    const heads = (await readdir(this.#journalDir)).flatMap((name) => JOURNAL_NAME.test(name) ? [name] : []).sort().reverse();
    await Promise.all(heads.slice(64).map((name) => rm(join(this.#journalDir, name), { force: true })));
  }
  #require(catalog: FileExportCatalogV1, id: string): ExportJobSnapshotV1 { const value = catalog.jobs[id]; if (!value) throw new FileExportJobStoreConflict("job-not-found", `Job ${id} was not found.`); return value; }
  #replace(catalog: FileExportCatalogV1, previous: ExportJobSnapshotV1, next: ExportJobSnapshotV1): void {
    parseExportJobSnapshotV1(next); catalog.jobs[next.id] = clone(next);
    if (previous.state !== next.state) (catalog.transitions[next.id] ??= {})[String(next.revision)] = { from: previous.state, to: next.state };
  }
  #assertReplay(catalog: FileExportCatalogV1, request: ExportJobRequestV1, relation: NonNullable<ExportJobCreateV1["derivedFrom"]>, existingDerivedId?: string): void {
    const origin = catalog.jobs[relation.jobId]; const originRequest = origin ? catalog.requests[origin.requestRef] : undefined;
    const allowed = origin && (relation.relation === "rerun" ? origin.state === "succeeded" : ["failed", "interrupted", "cancelled"].includes(origin.state));
    if (!allowed || !originRequest || request.id === origin!.id || request.format !== origin!.format || request.renderer !== origin!.renderer || replayPayloadWithoutOutput(request) !== replayPayloadWithoutOutput(originRequest) || request.priority !== (relation.relation === "retry" ? "retry" : "interactive")) throw new FileExportJobStoreConflict("derivation-conflict", "Replay request does not match a terminal origin.");
    if (existingDerivedId) {
      const existing = catalog.jobs[existingDerivedId]; const existingRequest = existing ? catalog.requests[existing.requestRef] : undefined;
      if (!existing || !existingRequest || canonical(existing.derivedFrom) !== canonical(relation) || replayPayload(request) !== replayPayload(existingRequest)) throw new FileExportJobStoreConflict("derivation-conflict", "Stored replay action or output override does not match.");
    }
  }
  #assertEvent(catalog: FileExportCatalogV1, snapshot: ExportJobSnapshotV1, event: ExportJobEventV1): void {
    if (event.kind === "state") { const edge = catalog.transitions[snapshot.id]?.[String(snapshot.revision)]; if (!edge || canonical(edge) !== canonical({ from: event.from, to: event.to })) throw new FileExportJobStoreConflict("invalid-event", "State event does not match transition."); }
    if (event.kind === "stage" && event.stage !== snapshot.stage) throw new FileExportJobStoreConflict("invalid-event", "Stage event does not match snapshot.");
    if (event.kind === "progress" && canonical(event.progress) !== canonical(snapshot.progress)) throw new FileExportJobStoreConflict("invalid-event", "Progress event does not match snapshot.");
    if (event.kind === "artifact" && canonical(event.artifact) !== canonical(snapshot.artifact)) throw new FileExportJobStoreConflict("invalid-event", "Artifact event does not match snapshot.");
    if (event.kind === "recovery" && event.leaseEpoch > snapshot.leaseEpoch) throw new FileExportJobStoreConflict("invalid-event", "Recovery event cannot name a future lease epoch.");
  }
  #assertLiveLease(snapshot: ExportJobSnapshotV1, leaseEpoch: number): void {
    if ((snapshot.state !== "running" && snapshot.state !== "cancelling") || !snapshot.lease || snapshot.leaseEpoch !== leaseEpoch || snapshot.lease.epoch !== leaseEpoch) throw new FileExportJobStoreConflict("lease-mismatch", "Executor lease is stale.");
    if (this.#now() >= snapshot.lease.expiresAt) throw new FileExportJobStoreConflict("lease-expired", "Executor lease expired.");
  }
}
