import { ResearchContractError } from "./contracts.js";
import {
  normalizeResearchWorkspacePath,
  researchWorkspacePathMatchesPrefix,
  type ResearchWorkspace,
} from "./workspace.js";
import {
  RESEARCH_OPAQUE_SOURCE_REF_SCHEMA_V1,
  RESEARCH_SESSION_ARTIFACT_SCHEMA_V1,
  RESEARCH_SESSION_EVENT_SCHEMA_V1,
  type ResearchOpaqueSourceRefV1,
  type ResearchSessionArtifactV1,
  type ResearchSessionCommitV1,
  type ResearchSessionEventV1,
  type ResearchSessionStoreFailureContextV1,
  type ResearchSessionStoreFailureInjectionV1,
  type ResearchSessionStoreFailureStageV1,
  type ResearchSessionStoreV1,
  type ResearchSessionDataNamespaceV1,
  type ResearchSessionDataWorkspaceStoreV1,
} from "./session-store.js";
import {
  reduceResearchSessionV1,
  type ResearchSessionCheckpointV1,
  type ResearchSessionUpdateV1,
  type ResearchSessionV1,
} from "./session.js";
import type { ResearchGraphV1 } from "./graph.js";
import type { ResearchAcceptedPacketV1, ResearchTaskAttemptV1 } from "./workflow-contracts.js";

export const RESEARCH_SESSION_INDEXED_DB_NAME_V1 = "atlcli-research-sessions";
export const RESEARCH_SESSION_INDEXED_DB_VERSION_V1 = 2;
export const RESEARCH_SESSION_INDEXED_DB_BLOCKED_TIMEOUT_MS = 10_000;

const SESSIONS = "sessions";
const EVENTS = "events";
const SOURCE_REFS = "sourceRefs";
const ARTIFACTS = "artifacts";
const WORKSPACE = "workspace";
const EVIDENCE_WORKSPACE = "evidenceWorkspace";
const CLAIMS_WORKSPACE = "claimsWorkspace";
const OUTLINE_WORKSPACE = "outlineWorkspace";
const MAXIMUM_SESSIONS_V1 = 128;
const MAXIMUM_EVENTS_PER_SESSION_V1 = 2_000;
const MAXIMUM_ARTIFACTS_PER_SESSION_V1 = 64;
const MAXIMUM_SOURCE_REFS_PER_SESSION_V1 = 4_096;
export const MAXIMUM_RESEARCH_EVIDENCE_WORKSPACE_BYTES_V1 = 48 * 1024 * 1024;
export const MAXIMUM_RESEARCH_CLAIMS_WORKSPACE_BYTES_V1 = 8 * 1024 * 1024;
export const MAXIMUM_RESEARCH_OUTLINE_WORKSPACE_BYTES_V1 = 8 * 1024 * 1024;

export interface IndexedDbResearchDataWorkspaceLimitsV1 {
  evidence?: number;
  claims?: number;
  outline?: number;
}

interface StoredSession { sessionId: string; state: ResearchSessionV1 }
interface StoredEvent { sessionId: string; sessionRevision: number; event: ResearchSessionEventV1 }
interface StoredSourceRef { sessionId: string; id: string; ref: ResearchOpaqueSourceRefV1 }
interface StoredArtifact { sessionId: string; id: string; metadata: ResearchSessionArtifactV1; contents: string }
interface StoredWorkspaceFile { sessionId: string; path: string; contents: string }

function invalid(message: string): never {
  throw new ResearchContractError("invalid-request", message);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("IndexedDB request failed."));
  });
}

function transaction<T>(
  db: IDBDatabase,
  stores: readonly string[],
  mode: IDBTransactionMode,
  run: (handles: Record<string, IDBObjectStore>, finish: (value: T) => void, fail: (reason: unknown) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([...stores], mode);
    let result: T;
    let hasResult = false;
    let settled = false;
    let failure: unknown;
    const fail = (reason: unknown): void => {
      if (settled) return;
      settled = true;
      failure = reason;
      try { tx.abort(); } catch { /* transaction is already finishing */ }
    };
    try {
      const handles: Record<string, IDBObjectStore> = {};
      for (const name of stores) handles[name] = tx.objectStore(name);
      run(handles, (value) => {
        result = value;
        hasResult = true;
      }, fail);
    } catch (error) {
      fail(error);
    }
    tx.oncomplete = () => !hasResult
      ? reject(new Error("IndexedDB session transaction completed without a result."))
      : resolve(result!);
    tx.onabort = () => reject(failure ?? tx.error ?? new Error("IndexedDB session transaction aborted."));
    tx.onerror = () => reject(failure ?? tx.error ?? new Error("IndexedDB session transaction failed."));
  });
}

function ensureWorkspaceStore(db: IDBDatabase, name: string): void {
  if (db.objectStoreNames.contains(name)) return;
  const store = db.createObjectStore(name, { keyPath: ["sessionId", "path"] });
  store.createIndex("bySession", "sessionId", { unique: false });
}

function ensureSchema(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: "sessionId" });
  if (!db.objectStoreNames.contains(EVENTS)) {
    const store = db.createObjectStore(EVENTS, { keyPath: ["sessionId", "sessionRevision"] });
    store.createIndex("bySession", "sessionId", { unique: false });
  }
  if (!db.objectStoreNames.contains(SOURCE_REFS)) {
    const store = db.createObjectStore(SOURCE_REFS, { keyPath: ["sessionId", "id"] });
    store.createIndex("bySession", "sessionId", { unique: false });
  }
  if (!db.objectStoreNames.contains(ARTIFACTS)) {
    const store = db.createObjectStore(ARTIFACTS, { keyPath: ["sessionId", "id"] });
    store.createIndex("bySession", "sessionId", { unique: false });
  }
  ensureWorkspaceStore(db, WORKSPACE);
  ensureWorkspaceStore(db, EVIDENCE_WORKSPACE);
  ensureWorkspaceStore(db, CLAIMS_WORKSPACE);
  ensureWorkspaceStore(db, OUTLINE_WORKSPACE);
}

function factoryFor(factory?: IDBFactory): IDBFactory {
  const resolved = factory ?? globalThis.indexedDB;
  if (!resolved) throw new ResearchContractError("unknown", "IndexedDB is unavailable in this host.");
  return resolved;
}

function openDatabase(input: {
  factory?: IDBFactory;
  databaseName: string;
  blockedUpgradeTimeoutMs: number;
}): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factoryFor(input.factory).open(input.databaseName, RESEARCH_SESSION_INDEXED_DB_VERSION_V1);
    let settled = false;
    let blockedTimer: ReturnType<typeof setTimeout> | undefined;
    const clear = (): void => {
      if (blockedTimer !== undefined) clearTimeout(blockedTimer);
      blockedTimer = undefined;
    };
    open.onupgradeneeded = () => {
      try { ensureSchema(open.result); } catch (error) { settled = true; clear(); reject(error); }
    };
    open.onblocked = () => {
      if (blockedTimer !== undefined) return;
      blockedTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new ResearchContractError("provider-error", "Research session IndexedDB upgrade is blocked by another extension context."));
      }, input.blockedUpgradeTimeoutMs);
    };
    open.onerror = () => {
      clear();
      if (!settled) { settled = true; reject(open.error ?? new Error("Failed to open research session IndexedDB.")); }
    };
    open.onsuccess = () => {
      clear();
      if (settled) { open.result.close(); return; }
      settled = true;
      resolve(open.result);
    };
  });
}

function eventFor(session: ResearchSessionV1, update: ResearchSessionUpdateV1): ResearchSessionEventV1 {
  const turnId = session.activeTurnId ?? session.turns.at(-1)?.id;
  return {
    schema: RESEARCH_SESSION_EVENT_SCHEMA_V1,
    sessionId: session.sessionId,
    sessionRevision: session.revision,
    leaseEpoch: session.lease.epoch,
    kind: update.kind,
    status: session.status,
    ...(turnId ? { turnId } : {}),
    at: update.at,
  };
}

function validateSourceRefs(refs: readonly ResearchOpaqueSourceRefV1[]): void {
  if (refs.length > MAXIMUM_SOURCE_REFS_PER_SESSION_V1 || new Set(refs.map((ref) => ref.id)).size !== refs.length) invalid("Research source references exceed their bounded limit.");
  for (const ref of refs) {
    if (ref.schema !== RESEARCH_OPAQUE_SOURCE_REF_SCHEMA_V1 || !/^source:[A-Za-z0-9._:-]{1,180}$/.test(ref.id) || !["jira", "confluence"].includes(ref.product) || !ref.sourceRef.trim() || ref.sourceRef.length > 512 || !Number.isFinite(Date.parse(ref.capturedAt))) invalid("Research source reference is invalid.");
  }
}

function validateArtifact(artifact: ResearchSessionArtifactV1, contents: string): void {
  if (artifact.schema !== RESEARCH_SESSION_ARTIFACT_SCHEMA_V1 || !/^artifact:[A-Za-z0-9._:-]{1,180}$/.test(artifact.id) || !/^\/artifacts\/[A-Za-z0-9._/-]{1,240}$/.test(artifact.path) || !["text/markdown", "application/json"].includes(artifact.contentType) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes !== new TextEncoder().encode(contents).byteLength || artifact.bytes > 2_000_000 || !Number.isFinite(Date.parse(artifact.createdAt))) invalid("Research artifact is invalid.");
}

function deleteIndexRows(index: IDBIndex, sessionId: string): void {
  const cursor = index.openCursor(sessionId);
  cursor.onsuccess = () => {
    const current = cursor.result;
    if (!current) return;
    current.delete();
    current.continue();
  };
}

function dataWorkspaceLimit(
  configured: number | undefined,
  fallback: number,
): number {
  const result = configured ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 512 * 1024 * 1024) {
    invalid("Research data workspace byte limit is invalid.");
  }
  return result;
}

/** IndexedDB implementation for the MV3 service worker, offscreen, and UI hosts. */
export class IndexedDbResearchSessionStoreV1 implements ResearchSessionStoreV1, ResearchSessionDataWorkspaceStoreV1 {
  readonly #db: IDBDatabase;
  readonly #failureInjection?: ResearchSessionStoreFailureInjectionV1;
  readonly #dataWorkspaceLimits: Required<IndexedDbResearchDataWorkspaceLimitsV1>;

  private constructor(
    db: IDBDatabase,
    failureInjection?: ResearchSessionStoreFailureInjectionV1,
    dataWorkspaceLimits: IndexedDbResearchDataWorkspaceLimitsV1 = {},
  ) {
    this.#db = db;
    this.#failureInjection = failureInjection;
    this.#dataWorkspaceLimits = {
      evidence: dataWorkspaceLimit(dataWorkspaceLimits.evidence, MAXIMUM_RESEARCH_EVIDENCE_WORKSPACE_BYTES_V1),
      claims: dataWorkspaceLimit(dataWorkspaceLimits.claims, MAXIMUM_RESEARCH_CLAIMS_WORKSPACE_BYTES_V1),
      outline: dataWorkspaceLimit(dataWorkspaceLimits.outline, MAXIMUM_RESEARCH_OUTLINE_WORKSPACE_BYTES_V1),
    };
  }

  static async open(options: {
    databaseName?: string;
    factory?: IDBFactory;
    blockedUpgradeTimeoutMs?: number;
    failureInjection?: ResearchSessionStoreFailureInjectionV1;
    dataWorkspaceLimits?: IndexedDbResearchDataWorkspaceLimitsV1;
  } = {}): Promise<IndexedDbResearchSessionStoreV1> {
    const db = await openDatabase({
      factory: options.factory,
      databaseName: options.databaseName ?? RESEARCH_SESSION_INDEXED_DB_NAME_V1,
      blockedUpgradeTimeoutMs: options.blockedUpgradeTimeoutMs ?? RESEARCH_SESSION_INDEXED_DB_BLOCKED_TIMEOUT_MS,
    });
    return new IndexedDbResearchSessionStoreV1(db, options.failureInjection, options.dataWorkspaceLimits);
  }

  close(): void { this.#db.close(); }

  #fail(
    stage: ResearchSessionStoreFailureStageV1,
    sessionId: string,
    context?: ResearchSessionStoreFailureContextV1,
  ): void {
    this.#failureInjection?.onStage?.(stage, sessionId, context);
  }

  async #required(sessionId: string): Promise<ResearchSessionV1> {
    const found = await this.read(sessionId);
    if (!found) invalid("Research session is not found.");
    return found;
  }

  async create(session: ResearchSessionV1): Promise<ResearchSessionV1> {
    this.#fail("before_create", session.sessionId);
    return transaction(this.#db, [SESSIONS], "readwrite", (stores, finish, fail) => {
      const count = stores[SESSIONS]!.count();
      count.onsuccess = () => {
        try {
          if (count.result >= MAXIMUM_SESSIONS_V1) invalid("Research session store limit is exhausted.");
          const add = stores[SESSIONS]!.add({ sessionId: session.sessionId, state: clone(session) } satisfies StoredSession);
          add.onsuccess = () => finish(clone(session));
          add.onerror = () => fail(add.error ?? new Error("Research session already exists."));
        } catch (error) { fail(error); }
      };
      count.onerror = () => fail(count.error ?? new Error("Research session count failed."));
    });
  }

  async read(sessionId: string): Promise<ResearchSessionV1 | undefined> {
    const row = await request(this.#db.transaction(SESSIONS, "readonly").objectStore(SESSIONS).get(sessionId) as IDBRequest<StoredSession | undefined>);
    return row ? clone(row.state) : undefined;
  }

  async list(input: { limit?: number; cursor?: string } = {}): Promise<{ sessions: ResearchSessionV1[]; nextCursor?: string }> {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const rows = await request(this.#db.transaction(SESSIONS, "readonly").objectStore(SESSIONS).getAll() as IDBRequest<StoredSession[]>);
    const ordered = rows.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
    const start = input.cursor ? ordered.findIndex((row) => row.sessionId === input.cursor) + 1 : 0;
    if (input.cursor && start === 0) invalid("Research session list cursor is invalid.");
    const page = ordered.slice(start, start + limit);
    return { sessions: page.map((row) => clone(row.state)), ...(start + limit < ordered.length ? { nextCursor: page.at(-1)!.sessionId } : {}) };
  }

  async commit(sessionId: string, update: ResearchSessionUpdateV1): Promise<ResearchSessionCommitV1> {
    return transaction(this.#db, [SESSIONS, EVENTS], "readwrite", (stores, finish, fail) => {
      const currentRequest = stores[SESSIONS]!.get(sessionId) as IDBRequest<StoredSession | undefined>;
      currentRequest.onsuccess = () => {
        try {
          const row = currentRequest.result;
          if (!row) invalid("Research session is not found.");
          if (row.state.revision !== update.expectedRevision || row.state.lease.epoch !== update.expectedLeaseEpoch) invalid("Research session store compare-and-swap fence is stale.");
          const next = reduceResearchSessionV1(row.state, update);
          const event = eventFor(next, update);
          const count = stores[EVENTS]!.index("bySession").count(sessionId);
          count.onsuccess = () => {
            try {
              if (count.result >= MAXIMUM_EVENTS_PER_SESSION_V1) invalid("Research session event limit is exhausted.");
              this.#fail("before_state_commit", sessionId, { updateKind: update.kind });
              this.#fail("before_event_append", sessionId, { updateKind: update.kind });
              stores[SESSIONS]!.put({ sessionId, state: clone(next) } satisfies StoredSession);
              const eventRequest = stores[EVENTS]!.add({ sessionId, sessionRevision: next.revision, event } satisfies StoredEvent);
              eventRequest.onsuccess = () => finish({ session: clone(next), event: clone(event) });
              eventRequest.onerror = () => fail(eventRequest.error ?? new Error("Research session journal append failed."));
            } catch (error) { fail(error); }
          };
          count.onerror = () => fail(count.error ?? new Error("Research session event count failed."));
        } catch (error) { fail(error); }
      };
      currentRequest.onerror = () => fail(currentRequest.error ?? new Error("Research session read failed."));
    });
  }

  async events(sessionId: string, input: { afterRevision?: number; limit?: number } = {}): Promise<ResearchSessionEventV1[]> {
    await this.#required(sessionId);
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    const rows = await request(this.#db.transaction(EVENTS, "readonly").objectStore(EVENTS).index("bySession").getAll(sessionId) as IDBRequest<StoredEvent[]>);
    return rows.sort((left, right) => left.sessionRevision - right.sessionRevision)
      .filter((row) => row.sessionRevision > (input.afterRevision ?? 0))
      .slice(0, limit).map((row) => clone(row.event));
  }

  async checkpoints(sessionId: string, turnId: string): Promise<ResearchSessionCheckpointV1[]> {
    const turn = (await this.#required(sessionId)).turns.find((candidate) => candidate.id === turnId);
    if (!turn) invalid("Research session turn is not found.");
    return clone(turn.checkpoints);
  }

  async graph(sessionId: string, turnId: string): Promise<ResearchGraphV1 | undefined> {
    return clone((await this.#required(sessionId)).turns.find((candidate) => candidate.id === turnId)?.graph);
  }

  async tasks(sessionId: string, turnId: string): Promise<ResearchTaskAttemptV1[]> {
    const turn = (await this.#required(sessionId)).turns.find((candidate) => candidate.id === turnId);
    if (!turn) invalid("Research session turn is not found.");
    return clone(turn.tasks);
  }

  async packet(sessionId: string, packetRef: string): Promise<ResearchAcceptedPacketV1 | undefined> {
    return clone((await this.#required(sessionId)).turns.flatMap((turn) => turn.acceptedPackets).find((packet) => packet.packetRef === packetRef));
  }

  async #workspaceForStore(
    sessionId: string,
    storeName: string,
    maximumBytes?: number,
  ): Promise<ResearchWorkspace> {
    await this.#required(sessionId);
    return {
      readFile: async (path) => {
        const normalized = normalizeResearchWorkspacePath(path);
        const row = await request(this.#db.transaction(storeName, "readonly").objectStore(storeName).get([sessionId, normalized]) as IDBRequest<StoredWorkspaceFile | undefined>);
        return row?.contents;
      },
      writeFile: async (path, contents) => {
        const normalized = normalizeResearchWorkspacePath(path);
        if (contents.length > 2_000_000) throw new ResearchContractError("limit-exceeded", "Workspace file is too large.");
        await this.#required(sessionId);
        await transaction(this.#db, [storeName], "readwrite", (stores, finish, fail) => {
          const store = stores[storeName]!;
          const rows = store.index("bySession").getAll(sessionId) as IDBRequest<StoredWorkspaceFile[]>;
          rows.onsuccess = () => {
            try {
              if (maximumBytes !== undefined) {
                const existing = rows.result.find((row) => row.path === normalized);
                const retainedBytes = rows.result.reduce(
                  (total, row) => total + new TextEncoder().encode(row.contents).byteLength,
                  0,
                ) - (existing ? new TextEncoder().encode(existing.contents).byteLength : 0);
                const nextBytes = retainedBytes + new TextEncoder().encode(contents).byteLength;
                if (nextBytes > maximumBytes) {
                  throw new ResearchContractError("limit-exceeded", "Research data namespace quota is exhausted.");
                }
              }
              const put = store.put({ sessionId, path: normalized, contents } satisfies StoredWorkspaceFile);
              put.onsuccess = () => finish(undefined);
              put.onerror = () => fail(put.error ?? new Error("Research workspace write failed."));
            } catch (error) { fail(error); }
          };
          rows.onerror = () => fail(rows.error ?? new Error("Research workspace quota read failed."));
        });
      },
      remove: async (path) => {
        const normalized = normalizeResearchWorkspacePath(path);
        const rows = await request(this.#db.transaction(storeName, "readonly").objectStore(storeName).index("bySession").getAll(sessionId) as IDBRequest<StoredWorkspaceFile[]>);
        await transaction(this.#db, [storeName], "readwrite", (stores, finish) => {
          for (const row of rows) if (researchWorkspacePathMatchesPrefix(row.path, normalized)) stores[storeName]!.delete([sessionId, row.path]);
          finish(undefined);
        });
      },
      list: async (prefix = "/") => {
        const normalized = normalizeResearchWorkspacePath(prefix);
        const rows = await request(this.#db.transaction(storeName, "readonly").objectStore(storeName).index("bySession").getAll(sessionId) as IDBRequest<StoredWorkspaceFile[]>);
        return rows.map((row) => row.path).filter((path) => researchWorkspacePathMatchesPrefix(path, normalized)).sort();
      },
    };
  }

  async workspace(sessionId: string): Promise<ResearchWorkspace> {
    return this.#workspaceForStore(sessionId, WORKSPACE);
  }

  async researchDataWorkspace(
    sessionId: string,
    namespace: ResearchSessionDataNamespaceV1,
  ): Promise<ResearchWorkspace> {
    switch (namespace) {
      case "evidence":
        return this.#workspaceForStore(sessionId, EVIDENCE_WORKSPACE, this.#dataWorkspaceLimits.evidence);
      case "claims":
        return this.#workspaceForStore(sessionId, CLAIMS_WORKSPACE, this.#dataWorkspaceLimits.claims);
      case "outline":
        return this.#workspaceForStore(sessionId, OUTLINE_WORKSPACE, this.#dataWorkspaceLimits.outline);
    }
  }

  async replaceOpaqueSourceRefs(sessionId: string, refs: ResearchOpaqueSourceRefV1[]): Promise<void> {
    await this.#required(sessionId);
    validateSourceRefs(refs);
    this.#fail("before_source_ref_write", sessionId);
    const existing = await request(this.#db.transaction(SOURCE_REFS, "readonly").objectStore(SOURCE_REFS).index("bySession").getAll(sessionId) as IDBRequest<StoredSourceRef[]>);
    await transaction(this.#db, [SOURCE_REFS], "readwrite", (stores, finish) => {
      const store = stores[SOURCE_REFS]!;
      for (const row of existing) store.delete([sessionId, row.id]);
      for (const ref of refs) store.put({ sessionId, id: ref.id, ref: clone(ref) } satisfies StoredSourceRef);
      finish(undefined);
    });
  }

  async opaqueSourceRefs(sessionId: string): Promise<ResearchOpaqueSourceRefV1[]> {
    await this.#required(sessionId);
    const rows = await request(this.#db.transaction(SOURCE_REFS, "readonly").objectStore(SOURCE_REFS).index("bySession").getAll(sessionId) as IDBRequest<StoredSourceRef[]>);
    return rows.map((row) => clone(row.ref)).sort((left, right) => left.id.localeCompare(right.id));
  }

  async writeArtifact(sessionId: string, artifact: ResearchSessionArtifactV1, contents: string): Promise<void> {
    await this.#required(sessionId);
    validateArtifact(artifact, contents);
    this.#fail("before_artifact_write", sessionId);
    await transaction(this.#db, [ARTIFACTS], "readwrite", (stores, finish, fail) => {
      const store = stores[ARTIFACTS]!;
      const existing = store.get([sessionId, artifact.id]) as IDBRequest<StoredArtifact | undefined>;
      existing.onsuccess = () => {
        const count = store.index("bySession").count(sessionId);
        count.onsuccess = () => {
          try {
            if (!existing.result && count.result >= MAXIMUM_ARTIFACTS_PER_SESSION_V1) invalid("Research session artifact limit is exhausted.");
            const put = store.put({ sessionId, id: artifact.id, metadata: clone(artifact), contents } satisfies StoredArtifact);
            put.onsuccess = () => finish(undefined);
            put.onerror = () => fail(put.error ?? new Error("Research artifact write failed."));
          } catch (error) { fail(error); }
        };
      };
      existing.onerror = () => fail(existing.error ?? new Error("Research artifact read failed."));
    });
  }

  async artifact(sessionId: string, artifactId: string): Promise<{ metadata: ResearchSessionArtifactV1; contents: string } | undefined> {
    await this.#required(sessionId);
    const row = await request(this.#db.transaction(ARTIFACTS, "readonly").objectStore(ARTIFACTS).get([sessionId, artifactId]) as IDBRequest<StoredArtifact | undefined>);
    return row ? { metadata: clone(row.metadata), contents: row.contents } : undefined;
  }

  async listArtifacts(sessionId: string): Promise<ResearchSessionArtifactV1[]> {
    await this.#required(sessionId);
    const rows = await request(this.#db.transaction(ARTIFACTS, "readonly").objectStore(ARTIFACTS).index("bySession").getAll(sessionId) as IDBRequest<StoredArtifact[]>);
    return rows.map((row) => clone(row.metadata)).sort((left, right) => left.id.localeCompare(right.id));
  }

  async eraseDeleted(sessionId: string): Promise<boolean> {
    const session = await this.read(sessionId);
    if (!session) return false;
    if (session.status !== "deleted" || session.retention.state !== "deleted") invalid("Only a deleted research session can be erased.");
    this.#fail("before_delete", sessionId);
    const sessionStores = [
      EVENTS,
      SOURCE_REFS,
      ARTIFACTS,
      WORKSPACE,
      EVIDENCE_WORKSPACE,
      CLAIMS_WORKSPACE,
      OUTLINE_WORKSPACE,
    ];
    await transaction(this.#db, [SESSIONS, ...sessionStores], "readwrite", (stores, finish) => {
      stores[SESSIONS]!.delete(sessionId);
      for (const name of sessionStores) deleteIndexRows(stores[name]!.index("bySession"), sessionId);
      finish(undefined);
    });
    return true;
  }
}
