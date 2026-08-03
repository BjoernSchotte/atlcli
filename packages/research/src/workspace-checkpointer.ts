import type { RunnableConfig } from "@langchain/core/runnables";
import {
  MemorySaver,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type DeltaChannelHistory,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import { ResearchContractError } from "./contracts.js";
import {
  researchSupervisorThreadIdForSessionV1,
  researchThreadIdForSessionV1,
} from "./checkpoint-identity.js";
import type { ResearchWorkspace } from "./workspace.js";

/**
 * Private, session-local storage for the LangGraph checkpoint journal. These
 * files are implementation state, never report artifacts or generic research
 * workspace files.
 */
const ROOT_PATH = "/.atlcli/langgraph-checkpoints/v1";
const SCHEMA = "atlcli.research-langgraph-workspace-checkpoints/v1" as const;
const MAXIMUM_OPERATIONS = 2_000;
const MAXIMUM_PAYLOAD_BYTES = 64_000_000;
// A durable DeepAgentsJS checkpoint includes the bounded task-tool schemas
// for one active supervisor state. Deep runs safely omit raw source bodies,
// but the serialized graph/runtime envelope can exceed four megabytes before
// the continuation boundary. The 64 MB session payload cap remains the hard
// aggregate host limit.
const MAXIMUM_BLOB_BYTES = 8_000_000;
const BLOB_CHUNK_BYTES = 500_000;
/*
 * Every ordinary DeepAgentsJS turn emits several checkpoints and pending
 * writes. Retain a useful per-namespace execution tail, but do not allow a
 * long completed conversation to turn the durable journal into an unbounded
 * append-only log. A checkpoint contains complete state, so an older parent
 * is not necessary to resume the retained frontier.
 */
const MAXIMUM_RETAINED_CHECKPOINTS_PER_NAMESPACE = 64;
const MAXIMUM_COMPACTED_OPERATIONS = 1_024;

interface PersistedBlobV1 {
  bytes: number;
  chunks: number;
}

interface PersistedCheckpointOperationV1 {
  id: string;
  kind: "checkpoint";
  namespace: string;
  checkpointId: string;
  parentCheckpointId?: string;
  checkpoint: PersistedBlobV1;
  metadata: PersistedBlobV1;
}

interface PersistedWriteV1 {
  key: string;
  taskId: string;
  channel: string;
  value: PersistedBlobV1;
}

interface PersistedWritesOperationV1 {
  id: string;
  kind: "writes";
  namespace: string;
  checkpointId: string;
  writes: PersistedWriteV1[];
}

type PersistedOperationV1 = PersistedCheckpointOperationV1 | PersistedWritesOperationV1;

interface PersistedIndexV1 {
  schema: typeof SCHEMA;
  threadId: string;
  payloadBytes: number;
  operations: PersistedOperationV1[];
}

function invalid(message: string): never {
  throw new ResearchContractError("invalid-request", message);
}

function limitedString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value) || value.length > 1_024 || value.includes("\u0000")) {
    invalid(`Stored LangGraph ${label} is invalid.`);
  }
  return value;
}

function operationId(value: unknown): string {
  const id = limitedString(value, "operation ID");
  if (!/^operation-\d{6,}$/.test(id)) invalid("Stored LangGraph operation ID is invalid.");
  return id;
}

function limitedCount(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    invalid(`Stored LangGraph ${label} is invalid.`);
  }
  return value as number;
}

function blob(value: unknown, label: string): PersistedBlobV1 {
  if (!value || typeof value !== "object") invalid(`Stored LangGraph ${label} is invalid.`);
  const candidate = value as Partial<PersistedBlobV1>;
  const bytes = limitedCount(candidate.bytes, `${label} byte count`, MAXIMUM_BLOB_BYTES);
  const chunks = limitedCount(candidate.chunks, `${label} chunk count`, Math.ceil(MAXIMUM_BLOB_BYTES / BLOB_CHUNK_BYTES));
  if ((bytes === 0 && chunks !== 0) || (bytes > 0 && chunks !== Math.ceil(bytes / BLOB_CHUNK_BYTES))) {
    invalid(`Stored LangGraph ${label} has inconsistent chunks.`);
  }
  return { bytes, chunks };
}

function operation(value: unknown): PersistedOperationV1 {
  if (!value || typeof value !== "object") invalid("Stored LangGraph operation is invalid.");
  const candidate = value as Partial<PersistedOperationV1>;
  const id = operationId(candidate.id);
  const namespace = limitedString(candidate.namespace, "namespace", true);
  const checkpointId = limitedString(candidate.checkpointId, "checkpoint ID");
  if (candidate.kind === "checkpoint") {
    const parentCheckpointId = candidate.parentCheckpointId === undefined
      ? undefined
      : limitedString(candidate.parentCheckpointId, "parent checkpoint ID");
    return {
      id,
      kind: "checkpoint",
      namespace,
      checkpointId,
      ...(parentCheckpointId ? { parentCheckpointId } : {}),
      checkpoint: blob(candidate.checkpoint, "checkpoint"),
      metadata: blob(candidate.metadata, "metadata"),
    };
  }
  if (candidate.kind !== "writes" || !Array.isArray(candidate.writes) || candidate.writes.length > 1_024) {
    invalid("Stored LangGraph write operation is invalid.");
  }
  const writes = candidate.writes.map((entry) => {
    if (!entry || typeof entry !== "object") invalid("Stored LangGraph write is invalid.");
    const write = entry as Partial<PersistedWriteV1>;
    return {
      key: limitedString(write.key, "write key"),
      taskId: limitedString(write.taskId, "write task ID"),
      channel: limitedString(write.channel, "write channel"),
      value: blob(write.value, "write value"),
    };
  });
  return { id, kind: "writes", namespace, checkpointId, writes };
}

function parseIndex(contents: string, expectedThreadId: string): PersistedIndexV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    invalid("Stored LangGraph checkpoint index is not JSON.");
  }
  if (!parsed || typeof parsed !== "object") invalid("Stored LangGraph checkpoint index is invalid.");
  const candidate = parsed as Partial<PersistedIndexV1>;
  if (candidate.schema !== SCHEMA || candidate.threadId !== expectedThreadId || !Array.isArray(candidate.operations)) {
    invalid("Stored LangGraph checkpoint index does not match this research session.");
  }
  if (candidate.operations.length > MAXIMUM_OPERATIONS) invalid("Stored LangGraph checkpoint operation limit is exceeded.");
  const operations = candidate.operations.map(operation);
  const ids = new Set<string>();
  for (const entry of operations) {
    if (ids.has(entry.id)) invalid("Stored LangGraph checkpoint operation IDs are duplicated.");
    ids.add(entry.id);
  }
  const payloadBytes = limitedCount(candidate.payloadBytes, "payload byte count", MAXIMUM_PAYLOAD_BYTES);
  const calculatedBytes = operations.reduce((total, entry) => total + (entry.kind === "checkpoint"
    ? entry.checkpoint.bytes + entry.metadata.bytes
    : entry.writes.reduce((writeTotal, write) => writeTotal + write.value.bytes, 0)), 0);
  if (calculatedBytes !== payloadBytes) invalid("Stored LangGraph checkpoint payload accounting is invalid.");
  return { schema: SCHEMA, threadId: expectedThreadId, payloadBytes, operations };
}

function encodeHex(bytes: Uint8Array): string {
  let encoded = "";
  for (const byte of bytes) encoded += byte.toString(16).padStart(2, "0");
  return encoded;
}

function decodeHex(value: string, expectedBytes: number): Uint8Array {
  if (value.length !== expectedBytes * 2 || !/^[0-9a-f]*$/i.test(value)) {
    invalid("Stored LangGraph checkpoint blob is invalid.");
  }
  const result = new Uint8Array(expectedBytes);
  for (let index = 0; index < expectedBytes; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function outerWriteKey(threadId: string, namespace: string, checkpointId: string): string {
  return JSON.stringify([threadId, namespace, checkpointId]);
}

function rejectForeignThread(config: RunnableConfig, expectedThreadId: string): void {
  if (config.configurable?.thread_id !== expectedThreadId) {
    throw new ResearchContractError("access-denied", "LangGraph checkpoint operation is outside the research session thread.");
  }
}

/**
 * Host-neutral physical checkpoint saver. It keeps LangGraph's native
 * `MemorySaver` semantics in memory during a run and journals the serialized
 * checkpoint bytes into the durable session workspace. A fresh saver over the
 * same workspace replays that journal exactly, so SQLite/filesystem and
 * IndexedDB hosts resume the same thread without a Node-only dependency.
 */
export class ResearchSessionWorkspaceCheckpointerV1 extends MemorySaver {
  readonly #threadId: string;
  readonly #workspace: ResearchWorkspace;
  readonly #rootPath: string;
  readonly #indexPath: string;
  #index: PersistedIndexV1;
  #loaded = false;
  #tail: Promise<void> = Promise.resolve();
  #writeFailure: unknown;

  constructor(
    sessionId: string,
    workspace: ResearchWorkspace,
    options?: { supervisorPhaseId?: string },
  ) {
    super();
    this.#threadId = options?.supervisorPhaseId === undefined
      ? researchThreadIdForSessionV1(sessionId)
      : researchSupervisorThreadIdForSessionV1(
          sessionId,
          options.supervisorPhaseId,
        );
    this.#workspace = workspace;
    this.#rootPath = options?.supervisorPhaseId === undefined
      ? ROOT_PATH
      : `${ROOT_PATH}/supervisor/${options.supervisorPhaseId}`;
    this.#indexPath = `${this.#rootPath}/index.json`;
    this.#index = { schema: SCHEMA, threadId: this.#threadId, payloadBytes: 0, operations: [] };
  }

  async #exclusive<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.#writeFailure) throw this.#writeFailure;
      return await callback();
    } finally {
      release();
    }
  }

  #operationPath(operationId: string, label: string, chunk: number): string {
    return `${this.#rootPath}/${operationId}/${label}-${String(chunk).padStart(4, "0")}.hex`;
  }

  async #writeBlob(operationId: string, label: string, value: Uint8Array): Promise<PersistedBlobV1> {
    if (value.byteLength > MAXIMUM_BLOB_BYTES) {
      throw new ResearchContractError("limit-exceeded", "Research LangGraph checkpoint blob is too large.");
    }
    const chunks = Math.ceil(value.byteLength / BLOB_CHUNK_BYTES);
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      const start = chunk * BLOB_CHUNK_BYTES;
      await this.#workspace.writeFile(this.#operationPath(operationId, label, chunk), encodeHex(value.slice(start, start + BLOB_CHUNK_BYTES)));
    }
    return { bytes: value.byteLength, chunks };
  }

  async #readBlob(operationId: string, label: string, persisted: PersistedBlobV1): Promise<Uint8Array> {
    const result = new Uint8Array(persisted.bytes);
    for (let chunk = 0; chunk < persisted.chunks; chunk += 1) {
      const start = chunk * BLOB_CHUNK_BYTES;
      const expectedBytes = Math.min(BLOB_CHUNK_BYTES, persisted.bytes - start);
      const contents = await this.#workspace.readFile(this.#operationPath(operationId, label, chunk));
      if (contents === undefined) invalid("Stored LangGraph checkpoint blob is missing.");
      result.set(decodeHex(contents, expectedBytes), start);
    }
    return result;
  }

  async #persistIndex(index = this.#index): Promise<void> {
    const contents = JSON.stringify(index);
    if (new TextEncoder().encode(contents).byteLength > 2_000_000) {
      throw new ResearchContractError("limit-exceeded", "Research LangGraph checkpoint index is too large.");
    }
    await this.#workspace.writeFile(this.#indexPath, contents);
  }

  #nextOperationId(): string {
    const highest = this.#index.operations.reduce((current, entry) => {
      const sequence = Number.parseInt(entry.id.slice("operation-".length), 10);
      return Math.max(current, sequence);
    }, 0);
    return `operation-${String(highest + 1).padStart(6, "0")}`;
  }

  #assertAppendBytes(bytes: number): void {
    if (this.#index.operations.length >= MAXIMUM_OPERATIONS || bytes > MAXIMUM_PAYLOAD_BYTES - this.#index.payloadBytes) {
      throw new ResearchContractError("limit-exceeded", "Research LangGraph checkpoint budget is exhausted.");
    }
  }

  async #append(operation: PersistedOperationV1, payloadBytes: number): Promise<void> {
    this.#assertAppendBytes(payloadBytes);
    this.#index = {
      ...this.#index,
      payloadBytes: this.#index.payloadBytes + payloadBytes,
      operations: [...this.#index.operations, operation],
    };
    await this.#persistIndex();
  }

  /**
   * Rebuild the durable journal from the latest complete checkpoint tail in
   * every namespace. The MemorySaver state has already accepted the current
   * put/putWrites call when this method runs, so the compacted index includes
   * that newest state. We publish the replacement index only after every new
   * blob is durable; a failed publication therefore leaves the previous index
   * usable on a fresh host, exactly like normal journal append.
   */
  async #compactJournal(): Promise<void> {
    const retained = new Map<string, {
      namespace: string;
      checkpointId: string;
      stored: [Uint8Array, Uint8Array, string | undefined];
    }>();
    const threadStorage = this.storage[this.#threadId] ?? Object.create(null) as Record<string, Record<string, [Uint8Array, Uint8Array, string | undefined]>>;

    for (const namespace of Object.keys(threadStorage).sort()) {
      let count = 0;
      for await (const tuple of super.list({
        configurable: { thread_id: this.#threadId, checkpoint_ns: namespace },
      })) {
        if (count >= MAXIMUM_RETAINED_CHECKPOINTS_PER_NAMESPACE) break;
        const checkpointId = tuple.config.configurable?.checkpoint_id;
        if (!checkpointId) invalid("LangGraph returned a checkpoint without an ID during compaction.");
        const stored = threadStorage[namespace]?.[checkpointId];
        if (!stored) invalid("LangGraph did not retain a checkpoint selected for compaction.");
        retained.set(outerWriteKey(this.#threadId, namespace, checkpointId), {
          namespace,
          checkpointId,
          stored,
        });
        count += 1;
      }
    }

    if (retained.size === 0) {
      throw new ResearchContractError("limit-exceeded", "Research LangGraph checkpoint compaction has no resumable checkpoint to retain.");
    }

    const priorOperationIds = new Set(this.#index.operations.map((entry) => entry.id));
    let nextSequence = this.#index.operations.reduce((current, entry) => Math.max(
      current,
      Number.parseInt(entry.id.slice("operation-".length), 10),
    ), 0) + 1;
    const nextOperationId = (): string => `operation-${String(nextSequence++).padStart(6, "0")}`;
    const operations: PersistedOperationV1[] = [];
    let payloadBytes = 0;
    const retainedKeys = new Set(retained.keys());
    const compactedStorage = Object.create(null) as typeof this.storage;
    compactedStorage[this.#threadId] = Object.create(null);
    const compactedWrites = Object.create(null) as typeof this.writes;

    const assertCompactedCapacity = (additionalBytes: number): void => {
      if (operations.length >= MAXIMUM_COMPACTED_OPERATIONS || additionalBytes > MAXIMUM_PAYLOAD_BYTES - payloadBytes) {
        throw new ResearchContractError("limit-exceeded", "Research LangGraph checkpoint compaction exceeds the durable session budget.");
      }
    };
    const newOperationIds = new Set<string>();

    for (const [key, entry] of retained) {
      const operationId = nextOperationId();
      newOperationIds.add(operationId);
      const parentCheckpointId = entry.stored[2];
      const retainedParentKey = parentCheckpointId === undefined
        ? undefined
        : outerWriteKey(this.#threadId, entry.namespace, parentCheckpointId);
      const retainedParentCheckpointId = retainedParentKey && retainedKeys.has(retainedParentKey)
        ? parentCheckpointId
        : undefined;
      const namespaceStorage = compactedStorage[this.#threadId][entry.namespace] ??= Object.create(null);
      namespaceStorage[entry.checkpointId] = [
        entry.stored[0],
        entry.stored[1],
        retainedParentCheckpointId,
      ];
      assertCompactedCapacity(entry.stored[0].byteLength + entry.stored[1].byteLength);
      await this.#workspace.remove(`${this.#rootPath}/${operationId}`);
      const checkpoint = await this.#writeBlob(operationId, "checkpoint", entry.stored[0]);
      const metadata = await this.#writeBlob(operationId, "metadata", entry.stored[1]);
      operations.push({
        id: operationId,
        kind: "checkpoint",
        namespace: entry.namespace,
        checkpointId: entry.checkpointId,
        ...(retainedParentCheckpointId ? { parentCheckpointId: retainedParentCheckpointId } : {}),
        checkpoint,
        metadata,
      });
      payloadBytes += checkpoint.bytes + metadata.bytes;

      const writes = this.writes[key];
      if (!writes || Object.keys(writes).length === 0) continue;
      compactedWrites[key] = { ...writes };
      assertCompactedCapacity(Object.values(writes).reduce((total, [, , value]) => total + value.byteLength, 0));
      const writesOperationId = nextOperationId();
      newOperationIds.add(writesOperationId);
      await this.#workspace.remove(`${this.#rootPath}/${writesOperationId}`);
      const persistedWrites: PersistedWriteV1[] = [];
      for (const [index, [key, [taskId, channel, value]]] of Object.entries(writes).entries()) {
        persistedWrites.push({
          key,
          taskId,
          channel,
          value: await this.#writeBlob(writesOperationId, `write-${index}`, value),
        });
      }
      operations.push({
        id: writesOperationId,
        kind: "writes",
        namespace: entry.namespace,
        checkpointId: entry.checkpointId,
        writes: persistedWrites,
      });
      payloadBytes += persistedWrites.reduce((total, write) => total + write.value.bytes, 0);
    }

    const compacted: PersistedIndexV1 = {
      schema: SCHEMA,
      threadId: this.#threadId,
      payloadBytes,
      operations,
    };
    await this.#persistIndex(compacted);
    this.#index = compacted;
    this.storage = compactedStorage;
    this.writes = compactedWrites;
    for (const operationId of priorOperationIds) {
      if (newOperationIds.has(operationId)) continue;
      try {
        await this.#workspace.remove(`${this.#rootPath}/${operationId}`);
      } catch {
        // The new index no longer references this completed-branch data. A
        // later compaction can retry cleanup without risking a valid resume.
      }
    }
  }

  async #ensureAppendCapacity(payloadBytes: number): Promise<boolean> {
    if (this.#index.operations.length < MAXIMUM_OPERATIONS && payloadBytes <= MAXIMUM_PAYLOAD_BYTES - this.#index.payloadBytes) {
      return false;
    }
    await this.#compactJournal();
    return true;
  }

  async #hydrate(): Promise<void> {
    if (this.#loaded) return;
    const contents = await this.#workspace.readFile(this.#indexPath);
    if (contents === undefined) {
      this.#loaded = true;
      return;
    }
    const index = parseIndex(contents, this.#threadId);
    this.storage = Object.create(null);
    this.writes = Object.create(null);
    this.storage[this.#threadId] = Object.create(null);
    for (const entry of index.operations) {
      if (entry.kind === "checkpoint") {
        const namespace = this.storage[this.#threadId][entry.namespace] ??= Object.create(null);
        namespace[entry.checkpointId] = [
          await this.#readBlob(entry.id, "checkpoint", entry.checkpoint),
          await this.#readBlob(entry.id, "metadata", entry.metadata),
          entry.parentCheckpointId,
        ];
        continue;
      }
      const key = outerWriteKey(this.#threadId, entry.namespace, entry.checkpointId);
      const writes = this.writes[key] ??= Object.create(null);
      for (let index = 0; index < entry.writes.length; index += 1) {
        const write = entry.writes[index]!;
        writes[write.key] = [
          write.taskId,
          write.channel,
          await this.#readBlob(entry.id, `write-${index}`, write.value),
        ];
      }
    }
    this.#index = index;
    this.#loaded = true;
  }

  async #failWrite(error: unknown): Promise<never> {
    this.#writeFailure = error;
    throw error;
  }

  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    rejectForeignThread(config, this.#threadId);
    return this.#exclusive(async () => {
      await this.#hydrate();
      return super.getTuple(config);
    });
  }

  override async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    rejectForeignThread(config, this.#threadId);
    if (options?.before) rejectForeignThread(options.before, this.#threadId);
    const tuples = await this.#exclusive(async () => {
      await this.#hydrate();
      const collected: CheckpointTuple[] = [];
      for await (const tuple of super.list(config, options)) collected.push(tuple);
      return collected;
    });
    yield* tuples;
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions?: ChannelVersions,
  ): Promise<RunnableConfig> {
    rejectForeignThread(config, this.#threadId);
    return this.#exclusive(async () => {
      await this.#hydrate();
      let saved: RunnableConfig;
      try {
        saved = await super.put(config, checkpoint, metadata);
        const namespace = saved.configurable?.checkpoint_ns ?? "";
        const checkpointId = saved.configurable?.checkpoint_id;
        if (!checkpointId) invalid("LangGraph did not return a checkpoint ID.");
        const stored = this.storage[this.#threadId]?.[namespace]?.[checkpointId];
        if (!stored) invalid("LangGraph did not retain the checkpoint it returned.");
        const compacted = await this.#ensureAppendCapacity(stored[0].byteLength + stored[1].byteLength);
        if (!compacted) {
          const operationId = this.#nextOperationId();
          await this.#workspace.remove(`${this.#rootPath}/${operationId}`);
          const checkpointBlob = await this.#writeBlob(operationId, "checkpoint", stored[0]);
          const metadataBlob = await this.#writeBlob(operationId, "metadata", stored[1]);
          await this.#append({
            id: operationId,
            kind: "checkpoint",
            namespace,
            checkpointId,
            ...(stored[2] ? { parentCheckpointId: stored[2] } : {}),
            checkpoint: checkpointBlob,
            metadata: metadataBlob,
          }, checkpointBlob.bytes + metadataBlob.bytes);
        }
      } catch (error) {
        return this.#failWrite(error);
      }
      return saved;
    });
  }

  override async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    rejectForeignThread(config, this.#threadId);
    return this.#exclusive(async () => {
      await this.#hydrate();
      try {
        const namespace = config.configurable?.checkpoint_ns ?? "";
        const checkpointId = config.configurable?.checkpoint_id;
        if (!checkpointId) invalid("LangGraph pending writes are missing a checkpoint ID.");
        const key = outerWriteKey(this.#threadId, namespace, checkpointId);
        const before = new Set(Object.keys(this.writes[key] ?? {}));
        await super.putWrites(config, writes, taskId);
        const after = this.writes[key] ?? {};
        const added = Object.entries(after).filter(([writeKey]) => !before.has(writeKey));
        if (added.length === 0) return;
        const payloadBytes = added.reduce((total, [, [, , value]]) => total + value.byteLength, 0);
        const compacted = await this.#ensureAppendCapacity(payloadBytes);
        if (!compacted) {
          const operationId = this.#nextOperationId();
          await this.#workspace.remove(`${this.#rootPath}/${operationId}`);
          const persistedWrites: PersistedWriteV1[] = [];
          for (let index = 0; index < added.length; index += 1) {
            const [writeKey, [storedTaskId, channel, value]] = added[index]!;
            persistedWrites.push({
              key: writeKey,
              taskId: storedTaskId,
              channel,
              value: await this.#writeBlob(operationId, `write-${index}`, value),
            });
          }
          await this.#append({ id: operationId, kind: "writes", namespace, checkpointId, writes: persistedWrites }, persistedWrites.reduce((total, write) => total + write.value.bytes, 0));
        }
      } catch (error) {
        return this.#failWrite(error);
      }
    });
  }

  override async getDeltaChannelHistory(options: { config: RunnableConfig; channels: string[] }): Promise<Record<string, DeltaChannelHistory>> {
    rejectForeignThread(options.config, this.#threadId);
    return this.#exclusive(async () => {
      await this.#hydrate();
      return super.getDeltaChannelHistory(options);
    });
  }

  override async deleteThread(threadId: string): Promise<void> {
    if (threadId !== this.#threadId) {
      throw new ResearchContractError("access-denied", "LangGraph checkpoint deletion is outside the research session thread.");
    }
    return this.#exclusive(async () => {
      await this.#hydrate();
      try {
        await this.#workspace.remove(this.#rootPath);
        await super.deleteThread(threadId);
        this.#index = { schema: SCHEMA, threadId: this.#threadId, payloadBytes: 0, operations: [] };
        this.#loaded = true;
      } catch (error) {
        return this.#failWrite(error);
      }
    });
  }
}
