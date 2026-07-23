import {
  claimExportJob,
  finalizeExportJobArtifact,
  isExportJobTerminal,
  orderExportQueue,
  parseExportJobEventV1,
  parseExportJobRequestV1,
  parseExportJobSnapshotV1,
  reclaimExpiredExportJobLease,
  transitionExportJob,
  heartbeatExportJob,
  updateExportJobProgress,
  updateExportJobStats,
  checkpointExportJob,
  updateExportJobTerminalMetadata,
  type ExportJobClaimV1,
  type ExportJobCreateV1,
  type ExportJobDeleteQueryV1,
  type ExportJobDeleteResultV1,
  type ExportJobDerivationV1,
  type ExportJobEventAppendV1,
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
  type ExportJobStatsV1,
} from "@atlcli/export-jobs";

export const EXTENSION_EXPORT_DB_NAME = "atlcli-export-jobs";
/** v1 was the pre-merge spike schema; v2 adds events, byte stores and bridges. */
export const EXTENSION_EXPORT_DB_VERSION = 2;

const JOBS = "jobs";
const REQUESTS = "requests";
const EVENTS = "events";
const TOMBSTONES = "tombstones";
const CURSORS = "cursors";
/** Shared durable coordination rows; byte-store fences use a disjoint key prefix. */
export const EXTENSION_EXPORT_COORDINATION_STORE = CURSORS;
const LEGACY_BRIDGES = "legacy-bridges";
export const EXTENSION_EXPORT_BYTE_OBJECTS_STORE = "byte-objects";
export const EXTENSION_EXPORT_BYTE_CHUNKS_STORE = "byte-chunks";
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 1_000;

type StoreName =
  | typeof JOBS
  | typeof REQUESTS
  | typeof EVENTS
  | typeof TOMBSTONES
  | typeof CURSORS
  | typeof LEGACY_BRIDGES
  | typeof EXTENSION_EXPORT_BYTE_OBJECTS_STORE
  | typeof EXTENSION_EXPORT_BYTE_CHUNKS_STORE;

interface JobRow {
  id: string;
  idempotencyKey: string;
  derivationKey?: string;
  authRef: string;
  snapshot: ExportJobSnapshotV1;
  nextEventSeq: number;
  transitions: Record<string, { from: ExportJobSnapshotV1["state"]; to: ExportJobSnapshotV1["state"] }>;
}

interface RequestRow {
  ref: string;
  request: ExportJobRequestV1;
}

interface EventRow {
  jobId: string;
  seq: number;
  event: import("@atlcli/export-jobs").ExportJobEventV1;
}

interface CursorRow {
  key: string;
  groupKey: string;
}

export interface LegacyPdfBridgeV1 {
  legacyJobId: string;
  outerJobId: string;
  outerLeaseEpoch: number;
  hidden: true;
  createdAt: number;
}

export type ExtensionExportCatalogErrorCode =
  | "blocked"
  | "duplicate-id"
  | "idempotency-conflict"
  | "derivation-conflict"
  | "job-deleted"
  | "job-not-found"
  | "revision-conflict"
  | "invalid-event"
  | "event-limit"
  | "legacy-bridge-conflict"
  | "retention-protected";

export class ExtensionExportCatalogError extends Error {
  readonly code: ExtensionExportCatalogErrorCode;

  constructor(code: ExtensionExportCatalogErrorCode, message: string) {
    super(message);
    this.name = "ExtensionExportCatalogError";
    this.code = code;
  }
}

export interface ExtensionExportCatalogOptions {
  factory?: IDBFactory;
  now?: () => number;
  onBlocked?: () => void;
  blockedTimeoutMs?: number;
  /** Transaction fault seam used to prove job+request creation is atomic. */
  afterRequestWrite?: () => void;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
}

function derivationKey(value: ExportJobDerivationV1): string {
  return canonical([value.jobId, value.relation, value.actionKey]);
}

function replayPayload(request: ExportJobRequestV1, includeOutput: boolean): string {
  const {
    id: _id,
    idempotencyKey: _idempotencyKey,
    createdAt: _createdAt,
    priority: _priority,
    output: _output,
    ...rest
  } = request;
  return canonical(includeOutput ? { ...rest, output: _output } : rest);
}

function requestRef(request: ExportJobRequestV1): string {
  return `request:${request.id}`;
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

function initialSnapshot(
  request: ExportJobRequestV1,
  derivedFrom?: ExportJobDerivationV1,
): ExportJobSnapshotV1 {
  return parseExportJobSnapshotV1({
    schema: "atlcli.export-job/1",
    id: request.id,
    revision: 0,
    requestRef: requestRef(request),
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
    // The accepted durable request is the first safe recovery boundary. An
    // offscreen context may disappear immediately after claiming the job,
    // before an engine publishes a more specific checkpoint.
    checkpointRef: requestRef(request),
    stats: emptyStats(),
    createdAt: request.createdAt,
    ...(derivedFrom ? { derivedFrom } : {}),
  });
}

function resolveFactory(factory?: IDBFactory): IDBFactory {
  const resolved = factory ?? globalThis.indexedDB;
  if (!resolved) throw new Error("IndexedDB is unavailable for background exports.");
  return resolved;
}

export function extensionExportRequestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}

export function openExtensionExportDb(
  options: ExtensionExportCatalogOptions = {},
): Promise<IDBDatabase> {
  const factory = resolveFactory(options.factory);
  return new Promise((resolve, reject) => {
    const request = factory.open(EXTENSION_EXPORT_DB_NAME, EXTENSION_EXPORT_DB_VERSION);
    let settled = false;
    let blockedTimer: ReturnType<typeof setTimeout> | undefined;
    const settleReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      if (blockedTimer !== undefined) clearTimeout(blockedTimer);
      reject(error);
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      const upgrade = request.transaction!;
      if (settled) {
        // `IDBOpenDBRequest` has no cancel API. A request that timed out while
        // blocked can still receive `upgradeneeded` after the old connection is
        // eventually released, so explicitly abort that late upgrade before it
        // mutates the durable schema.
        upgrade.abort();
        return;
      }
      const jobs = db.objectStoreNames.contains(JOBS)
        ? upgrade.objectStore(JOBS)
        : db.createObjectStore(JOBS, { keyPath: "id" });
      if (!jobs.indexNames.contains("idempotencyKey")) jobs.createIndex("idempotencyKey", "idempotencyKey", { unique: true });
      if (!jobs.indexNames.contains("derivationKey")) jobs.createIndex("derivationKey", "derivationKey", { unique: true });
      if (!db.objectStoreNames.contains(REQUESTS)) db.createObjectStore(REQUESTS, { keyPath: "ref" });
      const events = db.objectStoreNames.contains(EVENTS)
        ? upgrade.objectStore(EVENTS)
        : db.createObjectStore(EVENTS, { keyPath: ["jobId", "seq"] });
      if (!events.indexNames.contains("jobId")) events.createIndex("jobId", "jobId", { unique: false });
      if (!db.objectStoreNames.contains(TOMBSTONES)) db.createObjectStore(TOMBSTONES, { keyPath: "jobId" });
      if (!db.objectStoreNames.contains(CURSORS)) db.createObjectStore(CURSORS, { keyPath: "key" });
      const bridges = db.objectStoreNames.contains(LEGACY_BRIDGES)
        ? upgrade.objectStore(LEGACY_BRIDGES)
        : db.createObjectStore(LEGACY_BRIDGES, { keyPath: ["outerJobId", "outerLeaseEpoch"] });
      if (!bridges.indexNames.contains("legacyJobId")) bridges.createIndex("legacyJobId", "legacyJobId", { unique: true });
      if (!bridges.indexNames.contains("outerJobId")) bridges.createIndex("outerJobId", "outerJobId", { unique: false });
      if (!db.objectStoreNames.contains(EXTENSION_EXPORT_BYTE_OBJECTS_STORE)) {
        const objects = db.createObjectStore(EXTENSION_EXPORT_BYTE_OBJECTS_STORE, { keyPath: "id" });
        objects.createIndex("jobId", "jobId", { unique: false });
        objects.createIndex("jobEpoch", ["jobId", "leaseEpoch"], { unique: false });
        objects.createIndex("spoolRef", ["jobId", "leaseEpoch", "namespace", "key"], { unique: true });
        objects.createIndex("artifactRef", "ref", { unique: true });
      }
      if (!db.objectStoreNames.contains(EXTENSION_EXPORT_BYTE_CHUNKS_STORE)) {
        const chunks = db.createObjectStore(EXTENSION_EXPORT_BYTE_CHUNKS_STORE, { keyPath: ["objectId", "index"] });
        chunks.createIndex("objectId", "objectId", { unique: false });
      }
    };
    request.onblocked = () => {
      options.onBlocked?.();
      if (blockedTimer !== undefined || settled) return;
      const timeout = options.blockedTimeoutMs ?? 5_000;
      blockedTimer = setTimeout(() => settleReject(new ExtensionExportCatalogError(
        "blocked",
        "The export catalog upgrade is blocked by an older extension context.",
      )), timeout);
    };
    request.onerror = () => {
      settleReject(request.error ?? new Error("Opening the export catalog failed."));
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      if (blockedTimer !== undefined) clearTimeout(blockedTimer);
      resolve(db);
    };
  });
}

export async function withExtensionExportTransaction<T>(
  options: ExtensionExportCatalogOptions,
  stores: readonly StoreName[],
  mode: IDBTransactionMode,
  run: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await openExtensionExportDb(options);
  try {
    const transaction = db.transaction([...stores], mode);
    const done = transactionDone(transaction);
    try {
      const result = await run(transaction);
      await done;
      return result;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The request may already have aborted or committed the transaction.
      }
      await done.catch(() => undefined);
      throw error;
    }
  } finally {
    db.close();
  }
}

function boundedLimit(limit: number | undefined, fallback: number, maximum: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("Query limit must be a non-negative safe integer.");
  }
  return Math.min(limit, maximum);
}

function requireRow(row: JobRow | undefined, id: string): JobRow {
  if (!row) throw new ExtensionExportCatalogError("job-not-found", `Job ${id} was not found.`);
  return row;
}

function assertReplay(
  request: ExportJobRequestV1,
  derivedFrom: ExportJobDerivationV1,
  origin: JobRow | undefined,
  originRequest: RequestRow | undefined,
  existing?: { row: JobRow; request: RequestRow },
): void {
  if (!origin || !originRequest || !isExportJobTerminal(origin.snapshot.state)) {
    throw new ExtensionExportCatalogError("derivation-conflict", "Replay ancestry must reference an existing terminal job.");
  }
  const allowed = derivedFrom.relation === "retry"
    ? ["failed", "interrupted", "cancelled"].includes(origin.snapshot.state)
    : origin.snapshot.state === "succeeded";
  if (
    !allowed ||
    request.id === origin.id ||
    request.format !== origin.snapshot.format ||
    request.renderer !== origin.snapshot.renderer ||
    replayPayload(request, false) !== replayPayload(originRequest.request, false) ||
    request.priority !== (derivedFrom.relation === "retry" ? "retry" : "interactive")
  ) {
    throw new ExtensionExportCatalogError("derivation-conflict", "Replay request does not match its origin.");
  }
  if (
    existing &&
    (canonical(existing.row.snapshot.derivedFrom) !== canonical(derivedFrom) ||
      replayPayload(request, true) !== replayPayload(existing.request.request, true))
  ) {
    throw new ExtensionExportCatalogError("derivation-conflict", "Stored replay action does not match the request.");
  }
}

function applyUpdate(
  snapshot: ExportJobSnapshotV1,
  update: ExportJobUpdateV1,
  observedAt: number,
): ExportJobSnapshotV1 {
  switch (update.kind) {
    case "transition":
      return transitionExportJob(snapshot, { ...update, observedAt });
    case "heartbeat":
      return heartbeatExportJob(snapshot, { ...update, observedAt });
    case "progress":
      return updateExportJobProgress(snapshot, { ...update, observedAt });
    case "reclaim-expired":
      return reclaimExpiredExportJobLease(snapshot, { ...update, now: observedAt, observedAt });
    case "checkpoint":
      return checkpointExportJob(snapshot, { ...update, observedAt });
    case "stats":
      return updateExportJobStats(snapshot, { ...update, observedAt });
  }
}

function replaceSnapshot(row: JobRow, next: ExportJobSnapshotV1): JobRow {
  const parsed = clone(parseExportJobSnapshotV1(clone(next)));
  const transitions = { ...row.transitions };
  if (row.snapshot.state !== parsed.state) {
    transitions[String(parsed.revision)] = { from: row.snapshot.state, to: parsed.state };
  }
  return { ...row, snapshot: parsed, transitions };
}

export class IndexedDbExportJobCatalog implements ExportJobStore, ExportJobEventReaderV1 {
  readonly #options: ExtensionExportCatalogOptions;

  constructor(options: ExtensionExportCatalogOptions = {}) {
    this.#options = options;
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  async create(input: ExportJobCreateV1): Promise<ExportJobSnapshotV1> {
    const request = clone(parseExportJobRequestV1(clone(input.request)));
    const derivedKey = input.derivedFrom ? derivationKey(input.derivedFrom) : undefined;
    return withExtensionExportTransaction(this.#options, [JOBS, REQUESTS, TOMBSTONES], "readwrite", async (tx) => {
      const jobs = tx.objectStore(JOBS);
      const requests = tx.objectStore(REQUESTS);
      const tombstones = tx.objectStore(TOMBSTONES);
      const byIdempotency = await extensionExportRequestResult(jobs.index("idempotencyKey").get(request.idempotencyKey)) as JobRow | undefined;
      const byDerivation = derivedKey
        ? await extensionExportRequestResult(jobs.index("derivationKey").get(derivedKey)) as JobRow | undefined
        : undefined;
      if (byIdempotency && byDerivation && byIdempotency.id !== byDerivation.id) {
        throw new ExtensionExportCatalogError("derivation-conflict", "Idempotency and replay keys resolve to different jobs.");
      }
      const existing = byDerivation ?? byIdempotency;
      if (existing) {
        const storedRequest = await extensionExportRequestResult(requests.get(existing.snapshot.requestRef)) as RequestRow | undefined;
        if (!storedRequest) throw new ExtensionExportCatalogError("job-deleted", `Job ${existing.id} has no request.`);
        if (byDerivation && input.derivedFrom) {
          const origin = await extensionExportRequestResult(jobs.get(input.derivedFrom.jobId)) as JobRow | undefined;
          const originRequest = origin
            ? await extensionExportRequestResult(requests.get(origin.snapshot.requestRef)) as RequestRow | undefined
            : undefined;
          assertReplay(request, input.derivedFrom, origin, originRequest, { row: existing, request: storedRequest });
        } else if (canonical(storedRequest.request) !== canonical(request)) {
          throw new ExtensionExportCatalogError("idempotency-conflict", "Idempotency key was reused with a different request.");
        }
        if (canonical(existing.snapshot.derivedFrom) !== canonical(input.derivedFrom)) {
          throw new ExtensionExportCatalogError("derivation-conflict", "An idempotent acknowledgement cannot change replay ancestry.");
        }
        return clone(existing.snapshot);
      }

      if (await extensionExportRequestResult(jobs.get(request.id)) || await extensionExportRequestResult(tombstones.get(request.id))) {
        throw new ExtensionExportCatalogError("duplicate-id", `Job ${request.id} already exists.`);
      }
      if (input.derivedFrom) {
        const origin = await extensionExportRequestResult(jobs.get(input.derivedFrom.jobId)) as JobRow | undefined;
        const originRequest = origin
          ? await extensionExportRequestResult(requests.get(origin.snapshot.requestRef)) as RequestRow | undefined
          : undefined;
        assertReplay(request, input.derivedFrom, origin, originRequest);
      }
      const snapshot = initialSnapshot(request, input.derivedFrom);
      const row: JobRow = {
        id: snapshot.id,
        idempotencyKey: request.idempotencyKey,
        ...(derivedKey ? { derivationKey: derivedKey } : {}),
        authRef: request.authRef,
        snapshot,
        nextEventSeq: 1,
        transitions: {},
      };
      await extensionExportRequestResult(requests.add({ ref: snapshot.requestRef, request } satisfies RequestRow));
      this.#options.afterRequestWrite?.();
      await extensionExportRequestResult(jobs.add(row));
      return clone(snapshot);
    });
  }

  async get(id: string): Promise<ExportJobSnapshotV1 | undefined> {
    return withExtensionExportTransaction(this.#options, [JOBS], "readonly", async (tx) => {
      const row = await extensionExportRequestResult(tx.objectStore(JOBS).get(id)) as JobRow | undefined;
      return row ? clone(row.snapshot) : undefined;
    });
  }

  async getRequest(ref: string): Promise<ExportJobRequestV1 | undefined> {
    return withExtensionExportTransaction(this.#options, [REQUESTS], "readonly", async (tx) => {
      const row = await extensionExportRequestResult(tx.objectStore(REQUESTS).get(ref)) as RequestRow | undefined;
      return row ? clone(row.request) : undefined;
    });
  }

  async list(query: ExportJobQueryV1 = {}): Promise<ExportJobSnapshotV1[]> {
    const limit = boundedLimit(query.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    return withExtensionExportTransaction(this.#options, [JOBS], "readonly", async (tx) => {
      const rows = await extensionExportRequestResult(tx.objectStore(JOBS).getAll()) as JobRow[];
      return rows.map((row) => row.snapshot)
        .filter((job) => !query.formats || query.formats.includes(job.format))
        .filter((job) => !query.states || query.states.includes(job.state))
        .filter((job) => !query.stages || (job.stage !== undefined && query.stages.includes(job.stage)))
        .filter((job) => query.includeDismissed === true || job.dismissedAt === undefined)
        .filter((job) => query.createdAfter === undefined || job.createdAt > query.createdAfter)
        .filter((job) => query.createdBefore === undefined || job.createdAt < query.createdBefore)
        .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
        .slice(0, limit)
        .map(clone);
    });
  }

  async claimNext(claim: ExportJobClaimV1): Promise<ExportJobSnapshotV1 | undefined> {
    return withExtensionExportTransaction(this.#options, [JOBS, CURSORS], "readwrite", async (tx) => {
      const jobs = tx.objectStore(JOBS);
      const rows = await extensionExportRequestResult(jobs.getAll()) as JobRow[];
      const eligibilityAt = this.#now();
      const claimable = rows.filter((row) => {
        const job = row.snapshot;
        return (job.state === "queued" || (job.state === "waiting" && job.waiting?.until !== undefined && job.waiting.until <= eligibilityAt))
          && (!claim.ids || claim.ids.includes(job.id))
          && (!claim.formats || claim.formats.includes(job.format))
          && (!claim.authRefs || claim.authRefs.includes(row.authRef));
      });
      const ordered = orderExportQueue(claimable.map((row) => row.snapshot));
      const first = ordered[0];
      if (!first) return undefined;
      const cursorKey = `last-claimed:${first.queue.priority}`;
      const cursor = await extensionExportRequestResult(tx.objectStore(CURSORS).get(cursorKey)) as CursorRow | undefined;
      const groups = [...new Set(ordered.filter((job) => job.queue.priority === first.queue.priority).map((job) => job.queue.groupKey))];
      const lastIndex = cursor ? groups.indexOf(cursor.groupKey) : -1;
      const nextGroup = groups[(lastIndex + 1) % groups.length]!;
      const candidate = ordered.find((job) => job.queue.priority === first.queue.priority && job.queue.groupKey === nextGroup)!;
      const row = rows.find((value) => value.id === candidate.id)!;
      // Observe the host clock only after all potentially queued IndexedDB reads.
      // A timestamp captured before opening/entering this write transaction can
      // produce a lease that is already expired when the claim commits.
      const observedAt = this.#now();
      const next = claimExportJob(candidate, {
        expectedRevision: candidate.revision,
        ownerId: claim.ownerId,
        now: claim.now,
        observedAt,
        leaseDurationMs: claim.leaseDurationMs,
      });
      await extensionExportRequestResult(jobs.put(replaceSnapshot(row, next)));
      await extensionExportRequestResult(tx.objectStore(CURSORS).put({ key: cursorKey, groupKey: candidate.queue.groupKey } satisfies CursorRow));
      return clone(next);
    });
  }

  async compareAndSet(update: ExportJobUpdateV1): Promise<ExportJobSnapshotV1> {
    return withExtensionExportTransaction(this.#options, [JOBS], "readwrite", async (tx) => {
      const store = tx.objectStore(JOBS);
      const row = requireRow(await extensionExportRequestResult(store.get(update.id)) as JobRow | undefined, update.id);
      const next = applyUpdate(row.snapshot, update, this.#now());
      await extensionExportRequestResult(store.put(replaceSnapshot(row, next)));
      return clone(next);
    });
  }

  async appendEvent(id: string, input: ExportJobEventAppendV1): Promise<void> {
    await withExtensionExportTransaction(this.#options, [JOBS, EVENTS], "readwrite", async (tx) => {
      const jobs = tx.objectStore(JOBS);
      const row = requireRow(await extensionExportRequestResult(jobs.get(id)) as JobRow | undefined, id);
      if (row.snapshot.revision !== input.expectedRevision) {
        throw new ExtensionExportCatalogError("revision-conflict", "Event revision is stale.");
      }
      const event = clone(parseExportJobEventV1(clone(input.event)));
      if (row.snapshot.state === "running" || row.snapshot.state === "cancelling") {
        if (!row.snapshot.lease || input.leaseEpoch !== row.snapshot.leaseEpoch || input.leaseEpoch !== row.snapshot.lease.epoch) {
          throw new ExtensionExportCatalogError("revision-conflict", "Event lease epoch is stale.");
        }
        if (this.#now() >= row.snapshot.lease.expiresAt) {
          throw new ExtensionExportCatalogError("revision-conflict", "Event lease has expired.");
        }
      } else if (input.leaseEpoch !== undefined && input.leaseEpoch !== row.snapshot.leaseEpoch) {
        throw new ExtensionExportCatalogError("revision-conflict", "Event lease epoch is stale.");
      }
      if (event.seq !== row.nextEventSeq) {
        throw new ExtensionExportCatalogError("invalid-event", `Expected event sequence ${row.nextEventSeq}, received ${event.seq}.`);
      }
      if (event.kind === "state") {
        const transition = row.transitions[String(row.snapshot.revision)];
        if (!transition || transition.from !== event.from || transition.to !== event.to) {
          throw new ExtensionExportCatalogError("invalid-event", "State event does not match the committed transition.");
        }
      }
      if (event.kind === "stage" && event.stage !== row.snapshot.stage) {
        throw new ExtensionExportCatalogError("invalid-event", "Stage event does not match the snapshot.");
      }
      if (event.kind === "progress" && canonical(event.progress) !== canonical(row.snapshot.progress)) {
        throw new ExtensionExportCatalogError("invalid-event", "Progress event does not match the snapshot.");
      }
      if (event.kind === "artifact" && canonical(event.artifact) !== canonical(row.snapshot.artifact)) {
        throw new ExtensionExportCatalogError("invalid-event", "Artifact event does not match the snapshot.");
      }
      if (event.kind === "recovery" && event.leaseEpoch > row.snapshot.leaseEpoch) {
        throw new ExtensionExportCatalogError("invalid-event", "Recovery event cannot name a future lease epoch.");
      }
      const retained = (await extensionExportRequestResult(tx.objectStore(EVENTS).index("jobId").getAll(id)) as EventRow[])
        .sort((left, right) => left.seq - right.seq);
      if (retained.length >= MAX_EVENT_LIMIT) {
        const evictable = retained.find((candidate) => candidate.event.kind === "progress" || (candidate.event.kind === "issue" && candidate.event.level === "info"));
        if (!evictable) throw new ExtensionExportCatalogError("event-limit", "The event log is full of protected events.");
        await extensionExportRequestResult(tx.objectStore(EVENTS).delete([evictable.jobId, evictable.seq]));
      }
      await extensionExportRequestResult(tx.objectStore(EVENTS).add({ jobId: id, seq: event.seq, event } satisfies EventRow));
      await extensionExportRequestResult(jobs.put({ ...row, nextEventSeq: row.nextEventSeq + 1 }));
    });
  }

  async readEvents(id: string, query: ExportJobEventQueryV1 = {}): Promise<ExportJobEventPageV1> {
    const afterSeq = query.afterSeq ?? 0;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new RangeError("Event cursor must be non-negative.");
    const limit = Math.min(query.limit ?? DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Event limit must be positive.");
    return withExtensionExportTransaction(this.#options, [JOBS, EVENTS], "readonly", async (tx) => {
      requireRow(await extensionExportRequestResult(tx.objectStore(JOBS).get(id)) as JobRow | undefined, id);
      const candidates = (await extensionExportRequestResult(tx.objectStore(EVENTS).index("jobId").getAll(id)) as EventRow[])
        .filter((row) => row.seq > afterSeq)
        .sort((left, right) => left.seq - right.seq);
      const events = candidates.slice(0, limit).map((row) => clone(row.event));
      return { events, nextAfterSeq: events.at(-1)?.seq ?? afterSeq, hasMore: candidates.length > events.length };
    });
  }

  async finalizeArtifact(finalize: ExportJobFinalizeV1): Promise<ExportJobSnapshotV1> {
    return withExtensionExportTransaction(this.#options, [JOBS, EXTENSION_EXPORT_BYTE_OBJECTS_STORE], "readwrite", async (tx) => {
      const store = tx.objectStore(JOBS);
      const row = requireRow(await extensionExportRequestResult(store.get(finalize.id)) as JobRow | undefined, finalize.id);
      const next = finalizeExportJobArtifact(row.snapshot, { ...finalize, observedAt: this.#now() });
      const artifacts = tx.objectStore(EXTENSION_EXPORT_BYTE_OBJECTS_STORE);
      const artifact = await extensionExportRequestResult(artifacts.index("artifactRef").get(finalize.stagedArtifact.ref)) as {
        state: string;
        kind: string;
        jobId: string;
        leaseEpoch: number;
        ref: string;
        byteLength: number;
        sha256?: string;
        mediaType?: string;
        filename?: string;
      } | undefined;
      if (
        !artifact ||
        artifact.kind !== "artifact" ||
        artifact.state !== "staged" ||
        artifact.jobId !== finalize.id ||
        artifact.leaseEpoch !== finalize.leaseEpoch ||
        artifact.byteLength !== finalize.stagedArtifact.byteLength ||
        artifact.sha256 !== finalize.stagedArtifact.sha256 ||
        artifact.mediaType !== finalize.stagedArtifact.mediaType ||
        artifact.filename !== finalize.stagedArtifact.filename
      ) {
        throw new ExtensionExportCatalogError("revision-conflict", "The staged artifact does not match this job lease.");
      }
      await extensionExportRequestResult(artifacts.put({ ...artifact, state: "committed" }));
      await extensionExportRequestResult(store.put(replaceSnapshot(row, next)));
      return clone(next);
    });
  }

  async #terminalMetadata(
    id: string,
    expectedRevision: number,
    values: { acknowledgedAt?: number; dismissedAt?: number; deliveredAt?: number },
  ): Promise<ExportJobSnapshotV1> {
    return withExtensionExportTransaction(this.#options, [JOBS], "readwrite", async (tx) => {
      const store = tx.objectStore(JOBS);
      const row = requireRow(await extensionExportRequestResult(store.get(id)) as JobRow | undefined, id);
      const next = updateExportJobTerminalMetadata(row.snapshot, { expectedRevision, ...values });
      await extensionExportRequestResult(store.put(replaceSnapshot(row, next)));
      return clone(next);
    });
  }

  acknowledge(id: string, expectedRevision: number, at: number): Promise<ExportJobSnapshotV1> {
    return this.#terminalMetadata(id, expectedRevision, { acknowledgedAt: at });
  }

  dismiss(id: string, expectedRevision: number, at: number): Promise<ExportJobSnapshotV1> {
    return this.#terminalMetadata(id, expectedRevision, { dismissedAt: at });
  }

  async deliver(id: string, expectedRevision: number, at: number): Promise<ExportJobSnapshotV1> {
    const current = await this.get(id);
    if (!current) throw new ExtensionExportCatalogError("job-not-found", `Job ${id} was not found.`);
    return this.#terminalMetadata(id, expectedRevision, {
      deliveredAt: at,
      ...(current.acknowledgedAt === undefined ? { acknowledgedAt: at } : {}),
    });
  }

  async deleteTerminal(query: ExportJobDeleteQueryV1): Promise<ExportJobDeleteResultV1> {
    const limit = boundedLimit(query.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    return withExtensionExportTransaction(this.#options, [JOBS, REQUESTS, EVENTS, TOMBSTONES], "readwrite", async (tx) => {
      const jobs = tx.objectStore(JOBS);
      const requests = tx.objectStore(REQUESTS);
      const events = tx.objectStore(EVENTS);
      const candidates = (await extensionExportRequestResult(jobs.getAll()) as JobRow[])
        .filter((row) => isExportJobTerminal(row.snapshot.state))
        .filter((row) => !query.states || query.states.includes(row.snapshot.state as never))
        .filter((row) => row.snapshot.finishedAt !== undefined && row.snapshot.finishedAt < query.finishedBefore)
        .filter((row) => row.snapshot.state !== "succeeded" || row.snapshot.deliveredAt !== undefined || row.snapshot.dismissedAt !== undefined)
        .sort((left, right) => left.snapshot.finishedAt! - right.snapshot.finishedAt! || left.id.localeCompare(right.id))
        .slice(0, limit);
      const deletedJobIds: string[] = [];
      const tombstoneRefs: string[] = [];
      for (const row of candidates) {
        const request = await extensionExportRequestResult(requests.get(row.snapshot.requestRef)) as RequestRow | undefined;
        if (!request) throw new ExtensionExportCatalogError("retention-protected", `Job ${row.id} has no retained request.`);
        const ref = `tombstone:${row.id}:${row.snapshot.revision}`;
        const tombstone: ExportJobTombstoneV1 = {
          ref,
          jobId: row.id,
          requestRef: row.snapshot.requestRef,
          idempotencyKey: request.request.idempotencyKey,
          ...(row.derivationKey ? { derivationKey: row.derivationKey } : {}),
          finalState: row.snapshot.state as ExportJobTombstoneV1["finalState"],
          finalRevision: row.snapshot.revision,
          finishedAt: row.snapshot.finishedAt!,
          deletedAt: this.#now(),
          ownedRefs: [row.snapshot.requestRef, `events:${row.id}`, `spool:${row.id}`, ...(row.snapshot.checkpointRef ? [row.snapshot.checkpointRef] : []), ...(row.snapshot.artifact ? [row.snapshot.artifact.ref] : []), ...(row.snapshot.reportRef ? [row.snapshot.reportRef] : [])],
        };
        await extensionExportRequestResult(tx.objectStore(TOMBSTONES).put(tombstone));
        for (const event of await extensionExportRequestResult(events.index("jobId").getAll(row.id)) as EventRow[]) {
          await extensionExportRequestResult(events.delete([event.jobId, event.seq]));
        }
        await extensionExportRequestResult(jobs.delete(row.id));
        await extensionExportRequestResult(requests.delete(row.snapshot.requestRef));
        deletedJobIds.push(row.id);
        tombstoneRefs.push(ref);
      }
      return { deletedJobIds, tombstoneRefs };
    });
  }

  async getTombstone(jobId: string): Promise<ExportJobTombstoneV1 | undefined> {
    return withExtensionExportTransaction(this.#options, [TOMBSTONES], "readonly", async (tx) => {
      const value = await extensionExportRequestResult(tx.objectStore(TOMBSTONES).get(jobId)) as ExportJobTombstoneV1 | undefined;
      return value ? clone(value) : undefined;
    });
  }

  async markTombstoneCleanupComplete(jobId: string, tombstoneRef: string, at: number): Promise<ExportJobTombstoneV1> {
    return withExtensionExportTransaction(this.#options, [TOMBSTONES], "readwrite", async (tx) => {
      const store = tx.objectStore(TOMBSTONES);
      const value = await extensionExportRequestResult(store.get(jobId)) as ExportJobTombstoneV1 | undefined;
      if (!value || value.ref !== tombstoneRef) throw new ExtensionExportCatalogError("job-not-found", "The exact tombstone was not found.");
      if (at < value.deletedAt) throw new ExtensionExportCatalogError("retention-protected", "Cleanup cannot predate deletion.");
      const next = value.cleanupCompletedAt === undefined ? { ...value, cleanupCompletedAt: at } : value;
      await extensionExportRequestResult(store.put(next));
      return clone(next);
    });
  }

  async putLegacyBridge(bridge: LegacyPdfBridgeV1): Promise<void> {
    if (
      bridge.hidden !== true ||
      !bridge.legacyJobId ||
      !bridge.outerJobId ||
      !Number.isSafeInteger(bridge.outerLeaseEpoch) ||
      bridge.outerLeaseEpoch < 1
    ) throw new TypeError("Legacy compile bridges must be hidden and fully identified.");
    await withExtensionExportTransaction(this.#options, [JOBS, LEGACY_BRIDGES], "readwrite", async (tx) => {
      const outer = await extensionExportRequestResult(
        tx.objectStore(JOBS).get(bridge.outerJobId),
      ) as JobRow | undefined;
      if (!outer) {
        throw new ExtensionExportCatalogError("job-not-found", `Outer job ${bridge.outerJobId} was not found.`);
      }
      if (
        outer.snapshot.state !== "running" ||
        !outer.snapshot.lease ||
        outer.snapshot.leaseEpoch !== bridge.outerLeaseEpoch ||
        outer.snapshot.lease.epoch !== bridge.outerLeaseEpoch ||
        this.#now() >= outer.snapshot.lease.expiresAt
      ) {
        throw new ExtensionExportCatalogError(
          "legacy-bridge-conflict",
          "Legacy compile bridge does not match the active outer job lease.",
        );
      }

      const bridges = tx.objectStore(LEGACY_BRIDGES);
      const key: [string, number] = [bridge.outerJobId, bridge.outerLeaseEpoch];
      const existing = await extensionExportRequestResult(bridges.get(key)) as LegacyPdfBridgeV1 | undefined;
      if (existing) {
        if (
          existing.hidden === true &&
          existing.legacyJobId === bridge.legacyJobId &&
          existing.outerJobId === bridge.outerJobId &&
          existing.outerLeaseEpoch === bridge.outerLeaseEpoch
        ) return;
        throw new ExtensionExportCatalogError(
          "legacy-bridge-conflict",
          "A different legacy compiler job is already bound to this outer lease.",
        );
      }
      const legacyOwner = await extensionExportRequestResult(
        bridges.index("legacyJobId").get(bridge.legacyJobId),
      ) as LegacyPdfBridgeV1 | undefined;
      if (legacyOwner) {
        throw new ExtensionExportCatalogError(
          "legacy-bridge-conflict",
          "Legacy compiler job is already bound to a different outer lease.",
        );
      }
      await extensionExportRequestResult(bridges.add(clone(bridge)));
    });
  }

  async listLegacyBridges(): Promise<LegacyPdfBridgeV1[]> {
    return withExtensionExportTransaction(this.#options, [LEGACY_BRIDGES], "readonly", async (tx) =>
      clone(await extensionExportRequestResult(tx.objectStore(LEGACY_BRIDGES).getAll()) as LegacyPdfBridgeV1[]));
  }
}

export interface RecoverExtensionExportJobsOptions {
  now: number;
  ownerId: string;
  leaseDurationMs: number;
  ids?: string[];
  formats?: Array<"pdf" | "docx">;
  authRefs?: string[];
}

/** Reconcile expired owners, then atomically claim at most one runnable job. */
export async function recoverAndClaimExtensionExportJob(
  catalog: IndexedDbExportJobCatalog,
  options: RecoverExtensionExportJobsOptions,
): Promise<ExportJobSnapshotV1 | undefined> {
  const active = await catalog.list({ states: ["running", "cancelling"], limit: MAX_LIST_LIMIT });
  for (const snapshot of active) {
    if (snapshot.lease && snapshot.lease.expiresAt <= options.now) {
      await catalog.compareAndSet({
        kind: "reclaim-expired",
        id: snapshot.id,
        expectedRevision: snapshot.revision,
        now: options.now,
      }).catch(() => undefined);
    }
  }
  return catalog.claimNext(options);
}
