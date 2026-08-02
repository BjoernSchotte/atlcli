import { ResearchContractError } from "./contracts.js";
import type { ResearchWorkspace } from "./workspace.js";

/**
 * Private, durable archive for the complete original agent messages and the
 * body-free host event stream. This is deliberately separate from LangGraph's
 * checkpoint bytes: a checkpoint is an execution-resume mechanism, whereas
 * this archive is the inspectable lineage needed to safely compact a prompt.
 *
 * Nothing in this module is a source of factual authority. In particular, a
 * model-authored summary is only a retrieval aid; claims must continue to
 * point at the evidence ledger.
 */
export const RESEARCH_MESSAGE_LINEAGE_EVENT_SCHEMA_V1 = "atlcli.research-message-lineage-event/v1" as const;
export const RESEARCH_MESSAGE_LINEAGE_SUMMARY_SCHEMA_V1 = "atlcli.research-message-lineage-summary/v1" as const;
export const RESEARCH_MESSAGE_LINEAGE_INDEX_SCHEMA_V1 = "atlcli.research-message-lineage-index/v1" as const;

const ROOT_PATH = "/.atlcli/message-lineage/v1";
const INDEX_PATH = `${ROOT_PATH}/index.json`;
const MAXIMUM_EVENTS = 8_192;
const MAXIMUM_SUMMARIES = 2_048;
const MAXIMUM_MESSAGES_PER_BATCH = 512;
/* Individual workspace files cap at 2 MB; original messages are chunked. */
const MAXIMUM_JSON_BYTES = 16_000_000;
const MAXIMUM_INLINE_JSON_BYTES = 750_000;
const PAYLOAD_CHUNK_CHARS = 120_000;
const MAXIMUM_PAYLOAD_CHUNKS = 160;
const MAXIMUM_SUMMARY_CHARS = 24_000;
const MAXIMUM_REFERENCE_IDS = 512;
const MAXIMUM_INDEX_BYTES = 1_750_000;
const MAXIMUM_SEARCH_QUERY_CHARS = 500;
const MAXIMUM_SEARCH_RESULTS = 100;
const MAXIMUM_SEARCH_SCAN_BYTES = 4_000_000;

export type ResearchMessageLineageEventKindV1 = "message" | "host_event";
export type ResearchMessageLineageSummaryKindV1 = "turn" | "branch" | "session";

export interface ResearchMessageLineageLinksV1 {
  turnId?: string;
  graphRevision?: number;
  packetRefs?: string[];
  artifactIds?: string[];
}

export interface ResearchMessageLineageEventV1 extends ResearchMessageLineageLinksV1 {
  schema: typeof RESEARCH_MESSAGE_LINEAGE_EVENT_SCHEMA_V1;
  id: string;
  /** Logical, retry-safe batch issued by the host—not by the model. */
  batchId: string;
  ordinal: number;
  kind: ResearchMessageLineageEventKindV1;
  source: "langgraph" | "host";
  createdAt: string;
  /** Complete JSON serialization of the original message or host event. */
  payloadJson: string;
  payloadHash: string;
}

export interface ResearchMessageLineageSummaryV1 extends ResearchMessageLineageLinksV1 {
  schema: typeof RESEARCH_MESSAGE_LINEAGE_SUMMARY_SCHEMA_V1;
  id: string;
  kind: ResearchMessageLineageSummaryKindV1;
  createdAt: string;
  /** `model` summaries are explicitly non-authoritative. */
  author: "host" | "model";
  nonAuthoritative: true;
  summary: string;
  sourceEventIds: string[];
  parentSummaryIds: string[];
}

export interface ResearchMessageLineageStoreV1 {
  appendMessages(input: {
    batchId: string;
    createdAt: string;
    links?: ResearchMessageLineageLinksV1;
    messages: readonly unknown[];
  }): Promise<ResearchMessageLineageEventV1[]>;
  appendHostEvents(input: {
    batchId: string;
    createdAt: string;
    links?: ResearchMessageLineageLinksV1;
    events: readonly unknown[];
  }): Promise<ResearchMessageLineageEventV1[]>;
  appendSummary(input: {
    kind: ResearchMessageLineageSummaryKindV1;
    createdAt: string;
    author: "host" | "model";
    summary: string;
    sourceEventIds: readonly string[];
    parentSummaryIds?: readonly string[];
    links?: ResearchMessageLineageLinksV1;
  }): Promise<ResearchMessageLineageSummaryV1>;
  describe(): Promise<{
    eventCount: number;
    summaryCount: number;
    newestEventAt?: string;
    newestSummaryAt?: string;
  }>;
  latestSummary(): Promise<ResearchMessageLineageSummaryV1 | undefined>;
  /** Host-only bounded tail for constructing a new turn context. */
  recentEvents(input?: { limit?: number }): Promise<ResearchMessageLineageEventV1[]>;
  search(input: {
    query: string;
    limit?: number;
    cursor?: string;
  }): Promise<{
    matches: Array<{
      id: string;
      type: "event" | "summary";
      createdAt: string;
      snippet: string;
    }>;
    /** False means the caller should refine or continue its bounded search. */
    exhaustive: boolean;
    nextCursor?: string;
  }>;
  expand(id: string): Promise<ResearchMessageLineageEventV1 | ResearchMessageLineageSummaryV1 | undefined>;
}

interface PersistedLineageIndexEntryV1 {
  id: string;
  createdAt: string;
}

interface PersistedLineageIndexV1 {
  schema: typeof RESEARCH_MESSAGE_LINEAGE_INDEX_SCHEMA_V1;
  events: PersistedLineageIndexEntryV1[];
  summaries: PersistedLineageIndexEntryV1[];
}

/** Disk form keeps oversized raw messages in verified private chunk files. */
interface PersistedMessageLineageEventV1 extends Omit<ResearchMessageLineageEventV1, "payloadJson"> {
  payloadJson?: string;
  payloadChunkCount: number;
  payloadBytes: number;
}

function invalid(message: string): never {
  throw new ResearchContractError("invalid-request", message);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function text(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0) || value.length > maximum || value.includes("\u0000")) {
    invalid(`${label} is invalid.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!Number.isFinite(Date.parse(result))) invalid(`${label} is invalid.`);
  return result;
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    invalid(`${label} is invalid.`);
  }
  return value as number;
}

function optionalReference(value: unknown, label: string, maximum = 240): string | undefined {
  if (value === undefined) return undefined;
  const result = text(value, label, maximum);
  if (!/^[A-Za-z0-9._:%/:-]+$/.test(result)) invalid(`${label} is invalid.`);
  return result;
}

function batchId(value: unknown): string {
  const result = text(value, "Message lineage batch ID", 160);
  if (!/^[A-Za-z0-9._:%-]+$/.test(result)) invalid("Message lineage batch ID is invalid.");
  return result;
}

function eventId(value: unknown): string {
  const result = text(value, "Message lineage event ID", 96);
  if (!/^lineage-event:[a-f0-9]{48}$/.test(result)) invalid("Message lineage event ID is invalid.");
  return result;
}

function summaryId(value: unknown): string {
  const result = text(value, "Message lineage summary ID", 96);
  if (!/^lineage-summary:[a-f0-9]{48}$/.test(result)) invalid("Message lineage summary ID is invalid.");
  return result;
}

function hash(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!/^[a-f0-9]{64}$/.test(result)) invalid(`${label} is invalid.`);
  return result;
}

function distinctReferences(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAXIMUM_REFERENCE_IDS) invalid(`${label} is invalid.`);
  const result = value.map((candidate) => optionalReference(candidate, label)!);
  if (new Set(result).size !== result.length) invalid(`${label} contains duplicates.`);
  return result.sort();
}

function normalizeLinks(value: ResearchMessageLineageLinksV1 | undefined): ResearchMessageLineageLinksV1 {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Message lineage links are invalid.");
  const graphRevision = value.graphRevision === undefined
    ? undefined
    : positiveInteger(value.graphRevision, "Message lineage graph revision", 1_000_000);
  const result: ResearchMessageLineageLinksV1 = {
    ...(value.turnId === undefined ? {} : { turnId: optionalReference(value.turnId, "Message lineage turn ID") }),
    ...(graphRevision === undefined ? {} : { graphRevision }),
    ...(value.packetRefs === undefined ? {} : { packetRefs: distinctReferences(value.packetRefs, "Message lineage packet references") }),
    ...(value.artifactIds === undefined ? {} : { artifactIds: distinctReferences(value.artifactIds, "Message lineage artifact IDs") }),
  };
  return result;
}

function eventPath(id: string): string {
  return `${ROOT_PATH}/events/${eventId(id)}.json`;
}

function summaryPath(id: string): string {
  return `${ROOT_PATH}/summaries/${summaryId(id)}.json`;
}

function payloadChunkPath(id: string, ordinal: number): string {
  return `${ROOT_PATH}/payloads/${eventId(id)}/${String(ordinal).padStart(3, "0")}.json`;
}

function parseJsonPayload(value: unknown, label: string): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    invalid(`${label} is not JSON-serializable.`);
  }
  if (serialized === undefined || serialized.length === 0 || bytes(serialized) > MAXIMUM_JSON_BYTES) {
    invalid(`${label} is invalid.`);
  }
  try {
    JSON.parse(serialized);
  } catch {
    invalid(`${label} is invalid.`);
  }
  return serialized;
}

/** Validate an already serialized original payload without re-serializing it. */
function storedJsonPayload(value: unknown, label: string): string {
  const serialized = text(value, label, MAXIMUM_JSON_BYTES);
  if (bytes(serialized) > MAXIMUM_JSON_BYTES) invalid(`${label} is invalid.`);
  try {
    JSON.parse(serialized);
  } catch {
    invalid(`${label} is invalid.`);
  }
  return serialized;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function splitPayload(value: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(value.length, start + PAYLOAD_CHUNK_CHARS);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value.charAt(end - 1))) end -= 1;
    if (end <= start) invalid("Message lineage payload has an invalid Unicode boundary.");
    chunks.push(value.slice(start, end));
    start = end;
  }
  if (chunks.length === 0 || chunks.length > MAXIMUM_PAYLOAD_CHUNKS) {
    invalid("Message lineage payload is too large.");
  }
  return chunks;
}

function normalizeEvent(value: ResearchMessageLineageEventV1): ResearchMessageLineageEventV1 {
  if (!value || typeof value !== "object" || value.schema !== RESEARCH_MESSAGE_LINEAGE_EVENT_SCHEMA_V1) {
    invalid("Message lineage event schema is invalid.");
  }
  if (value.kind !== "message" && value.kind !== "host_event") invalid("Message lineage event kind is invalid.");
  if (value.source !== "langgraph" && value.source !== "host") invalid("Message lineage event source is invalid.");
  const payloadJson = storedJsonPayload(value.payloadJson, "Message lineage event payload");
  const links = normalizeLinks(value);
  return {
    schema: RESEARCH_MESSAGE_LINEAGE_EVENT_SCHEMA_V1,
    id: eventId(value.id),
    batchId: batchId(value.batchId),
    ordinal: positiveInteger(value.ordinal, "Message lineage event ordinal", MAXIMUM_MESSAGES_PER_BATCH),
    kind: value.kind,
    source: value.source,
    createdAt: timestamp(value.createdAt, "Message lineage event timestamp"),
    payloadJson,
    payloadHash: hash(value.payloadHash, "Message lineage event payload hash"),
    ...links,
  };
}

function parsePersistedEvent(value: unknown): PersistedMessageLineageEventV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Stored message lineage event is invalid.");
  const candidate = value as Partial<PersistedMessageLineageEventV1>;
  const payloadChunkCount = candidate.payloadChunkCount === undefined
    ? 0 // Backwards-compatible records from the first schema implementation.
    : Number.isSafeInteger(candidate.payloadChunkCount) && candidate.payloadChunkCount >= 0 && candidate.payloadChunkCount <= MAXIMUM_PAYLOAD_CHUNKS
      ? candidate.payloadChunkCount
      : invalid("Stored message lineage payload chunk count is invalid.");
  const payloadBytes = candidate.payloadBytes === undefined
    ? candidate.payloadJson === undefined ? invalid("Stored message lineage payload is missing.") : bytes(storedJsonPayload(candidate.payloadJson, "Stored message lineage payload"))
    : Number.isSafeInteger(candidate.payloadBytes) && candidate.payloadBytes >= 1 && candidate.payloadBytes <= MAXIMUM_JSON_BYTES
      ? candidate.payloadBytes
      : invalid("Stored message lineage payload byte count is invalid.");
  if ((payloadChunkCount === 0) !== (candidate.payloadJson !== undefined)) {
    invalid("Stored message lineage payload representation is invalid.");
  }
  const placeholder = candidate.payloadJson ?? "null";
  const validated = normalizeEvent({
    ...(candidate as Omit<ResearchMessageLineageEventV1, "payloadJson">),
    payloadJson: placeholder,
  });
  const { payloadJson: _validatedPayloadJson, ...metadata } = validated;
  return {
    ...metadata,
    ...(candidate.payloadJson === undefined ? {} : { payloadJson: storedJsonPayload(candidate.payloadJson, "Stored message lineage payload") }),
    payloadChunkCount,
    payloadBytes,
  };
}

function normalizeSummary(value: ResearchMessageLineageSummaryV1): ResearchMessageLineageSummaryV1 {
  if (!value || typeof value !== "object" || value.schema !== RESEARCH_MESSAGE_LINEAGE_SUMMARY_SCHEMA_V1) {
    invalid("Message lineage summary schema is invalid.");
  }
  if (value.kind !== "turn" && value.kind !== "branch" && value.kind !== "session") invalid("Message lineage summary kind is invalid.");
  if (value.author !== "host" && value.author !== "model") invalid("Message lineage summary author is invalid.");
  if (value.nonAuthoritative !== true) invalid("Message lineage summary must be marked non-authoritative.");
  const sourceEventIds = distinctReferences(value.sourceEventIds, "Message lineage summary source event IDs")?.map(eventId) ?? invalid("Message lineage summary requires source events.");
  if (sourceEventIds.length === 0) invalid("Message lineage summary requires source events.");
  const parentSummaryIds = distinctReferences(value.parentSummaryIds ?? [], "Message lineage parent summary IDs")?.map(summaryId) ?? [];
  const links = normalizeLinks(value);
  return {
    schema: RESEARCH_MESSAGE_LINEAGE_SUMMARY_SCHEMA_V1,
    id: summaryId(value.id),
    kind: value.kind,
    createdAt: timestamp(value.createdAt, "Message lineage summary timestamp"),
    author: value.author,
    nonAuthoritative: true,
    summary: text(value.summary, "Message lineage summary", MAXIMUM_SUMMARY_CHARS),
    sourceEventIds,
    parentSummaryIds,
    ...links,
  };
}

function parseIndex(contents: string): PersistedLineageIndexV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    invalid("Message lineage index is not JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid("Message lineage index is invalid.");
  const candidate = parsed as Partial<PersistedLineageIndexV1>;
  if (candidate.schema !== RESEARCH_MESSAGE_LINEAGE_INDEX_SCHEMA_V1 ||
      !Array.isArray(candidate.events) || candidate.events.length > MAXIMUM_EVENTS ||
      !Array.isArray(candidate.summaries) || candidate.summaries.length > MAXIMUM_SUMMARIES) {
    invalid("Message lineage index is invalid.");
  }
  const events = candidate.events.map((entry) => ({
    id: eventId(entry?.id),
    createdAt: timestamp(entry?.createdAt, "Message lineage index event timestamp"),
  }));
  const summaries = candidate.summaries.map((entry) => ({
    id: summaryId(entry?.id),
    createdAt: timestamp(entry?.createdAt, "Message lineage index summary timestamp"),
  }));
  if (new Set(events.map((entry) => entry.id)).size !== events.length ||
      new Set(summaries.map((entry) => entry.id)).size !== summaries.length) {
    invalid("Message lineage index contains duplicate entries.");
  }
  return {
    schema: RESEARCH_MESSAGE_LINEAGE_INDEX_SCHEMA_V1,
    events,
    summaries,
  };
}

function searchSnippet(value: string, query: string): string {
  const lowered = value.toLocaleLowerCase("en-US");
  const index = lowered.indexOf(query.toLocaleLowerCase("en-US"));
  const start = Math.max(0, index - 180);
  const end = Math.min(value.length, start + 600);
  return value.slice(start, end);
}

/**
 * Portable immutable archive. Event and summary files are written before the
 * compact index is published, so an interrupted publication never makes a
 * partial batch visible to a new reader. A failed writer remains fail-closed
 * for its lifetime; recovery uses a fresh store instance over the workspace.
 */
export class WorkspaceResearchMessageLineageStoreV1 implements ResearchMessageLineageStoreV1 {
  readonly #workspace: ResearchWorkspace;
  #index: PersistedLineageIndexV1 = {
    schema: RESEARCH_MESSAGE_LINEAGE_INDEX_SCHEMA_V1,
    events: [],
    summaries: [],
  };
  #loaded = false;
  #tail: Promise<void> = Promise.resolve();
  #writeFailure: unknown;

  constructor(workspace: ResearchWorkspace) {
    this.#workspace = workspace;
  }

  async #exclusive<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.#writeFailure) throw this.#writeFailure;
      return await callback();
    } finally {
      release();
    }
  }

  async #hydrate(): Promise<void> {
    if (this.#loaded) return;
    const contents = await this.#workspace.readFile(INDEX_PATH);
    this.#index = contents === undefined
      ? { schema: RESEARCH_MESSAGE_LINEAGE_INDEX_SCHEMA_V1, events: [], summaries: [] }
      : parseIndex(contents);
    this.#loaded = true;
  }

  async #persistIndex(): Promise<void> {
    const contents = JSON.stringify(this.#index);
    if (bytes(contents) > MAXIMUM_INDEX_BYTES) {
      throw new ResearchContractError("limit-exceeded", "Message lineage index is too large.");
    }
    await this.#workspace.writeFile(INDEX_PATH, contents);
  }

  async #readEvent(id: string): Promise<ResearchMessageLineageEventV1 | undefined> {
    const contents = await this.#workspace.readFile(eventPath(id));
    if (contents === undefined) return undefined;
    try {
      const persisted = parsePersistedEvent(JSON.parse(contents));
      const payloadJson = persisted.payloadJson ?? (
        await Promise.all(
          Array.from({ length: persisted.payloadChunkCount }, async (_, index) => {
            const chunk = await this.#workspace.readFile(payloadChunkPath(persisted.id, index + 1));
            if (chunk === undefined) invalid("Stored message lineage payload chunk is missing.");
            return chunk;
          }),
        )
      ).join("");
      const validated = normalizeEvent({ ...persisted, payloadJson });
      if (bytes(payloadJson) !== persisted.payloadBytes || await sha256(payloadJson) !== validated.payloadHash) {
        invalid("Stored message lineage payload does not match its retained hash.");
      }
      return validated;
    } catch (error) {
      if (error instanceof ResearchContractError) throw error;
      invalid("Stored message lineage event is not JSON.");
    }
  }

  async #writeEvent(record: ResearchMessageLineageEventV1): Promise<void> {
    const payloadBytes = bytes(record.payloadJson);
    const chunks = payloadBytes > MAXIMUM_INLINE_JSON_BYTES ? splitPayload(record.payloadJson) : undefined;
    if (chunks) {
      for (const [index, chunk] of chunks.entries()) {
        await this.#workspace.writeFile(payloadChunkPath(record.id, index + 1), chunk);
      }
    }
    const { payloadJson, ...metadata } = record;
    const persisted: PersistedMessageLineageEventV1 = {
      ...metadata,
      ...(chunks ? {} : { payloadJson }),
      payloadChunkCount: chunks?.length ?? 0,
      payloadBytes,
    };
    await this.#workspace.writeFile(eventPath(record.id), JSON.stringify(persisted));
  }

  async #readSummary(id: string): Promise<ResearchMessageLineageSummaryV1 | undefined> {
    const contents = await this.#workspace.readFile(summaryPath(id));
    if (contents === undefined) return undefined;
    try {
      return normalizeSummary(JSON.parse(contents) as ResearchMessageLineageSummaryV1);
    } catch (error) {
      if (error instanceof ResearchContractError) throw error;
      invalid("Stored message lineage summary is not JSON.");
    }
  }

  async #eventForBatchOrdinal(batchId: string, ordinal: number): Promise<ResearchMessageLineageEventV1 | undefined> {
    for (const entry of this.#index.events) {
      const event = await this.#readEvent(entry.id);
      if (!event) invalid("Message lineage index references a missing event.");
      if (event.batchId === batchId && event.ordinal === ordinal) return event;
    }
    return undefined;
  }

  async #appendEvents(input: {
    batchId: string;
    createdAt: string;
    links?: ResearchMessageLineageLinksV1;
    values: readonly unknown[];
    kind: ResearchMessageLineageEventKindV1;
    source: "langgraph" | "host";
  }): Promise<ResearchMessageLineageEventV1[]> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      const normalizedBatchId = batchId(input.batchId);
      const createdAt = timestamp(input.createdAt, "Message lineage batch timestamp");
      const links = normalizeLinks(input.links);
      if (!Array.isArray(input.values) || input.values.length === 0 || input.values.length > MAXIMUM_MESSAGES_PER_BATCH) {
        invalid("Message lineage batch values are invalid.");
      }
      const records = await Promise.all(input.values.map(async (value, index) => {
        const payloadJson = parseJsonPayload(value, "Message lineage original payload");
        const payloadHash = await sha256(payloadJson);
        const id = `lineage-event:${(await sha256(JSON.stringify({
          batchId: normalizedBatchId,
          ordinal: index + 1,
          kind: input.kind,
          source: input.source,
          payloadHash,
          links,
        }))).slice(0, 48)}`;
        return normalizeEvent({
          schema: RESEARCH_MESSAGE_LINEAGE_EVENT_SCHEMA_V1,
          id,
          batchId: normalizedBatchId,
          ordinal: index + 1,
          kind: input.kind,
          source: input.source,
          createdAt,
          payloadJson,
          payloadHash,
          ...links,
        });
      }));
      const newRecords: ResearchMessageLineageEventV1[] = [];
      for (const record of records) {
        const sameBatchSlot = await this.#eventForBatchOrdinal(record.batchId, record.ordinal);
        if (sameBatchSlot && sameBatchSlot.id !== record.id) {
          invalid("Message lineage batch ordinal collides with a different event.");
        }
        const existing = await this.#readEvent(record.id);
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(record)) {
            invalid("Message lineage event ID collides with a different event.");
          }
          continue;
        }
        if (this.#index.events.length + newRecords.length >= MAXIMUM_EVENTS) {
          throw new ResearchContractError("limit-exceeded", "Message lineage event limit is exhausted.");
        }
        await this.#writeEvent(record);
        newRecords.push(record);
      }
      if (newRecords.length > 0) {
        try {
          this.#index = {
            ...this.#index,
            events: [...this.#index.events, ...newRecords.map((record) => ({ id: record.id, createdAt: record.createdAt }))],
          };
          await this.#persistIndex();
        } catch (error) {
          this.#writeFailure = error;
          throw error;
        }
      }
      return records.map(clone);
    });
  }

  async appendMessages(input: {
    batchId: string;
    createdAt: string;
    links?: ResearchMessageLineageLinksV1;
    messages: readonly unknown[];
  }): Promise<ResearchMessageLineageEventV1[]> {
    return this.#appendEvents({ ...input, values: input.messages, kind: "message", source: "langgraph" });
  }

  async appendHostEvents(input: {
    batchId: string;
    createdAt: string;
    links?: ResearchMessageLineageLinksV1;
    events: readonly unknown[];
  }): Promise<ResearchMessageLineageEventV1[]> {
    return this.#appendEvents({ ...input, values: input.events, kind: "host_event", source: "host" });
  }

  async appendSummary(input: {
    kind: ResearchMessageLineageSummaryKindV1;
    createdAt: string;
    author: "host" | "model";
    summary: string;
    sourceEventIds: readonly string[];
    parentSummaryIds?: readonly string[];
    links?: ResearchMessageLineageLinksV1;
  }): Promise<ResearchMessageLineageSummaryV1> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      const sourceEventIds = input.sourceEventIds.map(eventId).sort();
      if (sourceEventIds.length === 0 || sourceEventIds.length > MAXIMUM_REFERENCE_IDS || new Set(sourceEventIds).size !== sourceEventIds.length) {
        invalid("Message lineage summary source event IDs are invalid.");
      }
      const parentSummaryIds = (input.parentSummaryIds ?? []).map(summaryId).sort();
      if (parentSummaryIds.length > MAXIMUM_REFERENCE_IDS || new Set(parentSummaryIds).size !== parentSummaryIds.length) {
        invalid("Message lineage parent summary IDs are invalid.");
      }
      for (const id of sourceEventIds) {
        if (!this.#index.events.some((entry) => entry.id === id) || !await this.#readEvent(id)) {
          invalid("Message lineage summary references an event that is not retained.");
        }
      }
      for (const id of parentSummaryIds) {
        if (!this.#index.summaries.some((entry) => entry.id === id) || !await this.#readSummary(id)) {
          invalid("Message lineage summary references a parent summary that is not retained.");
        }
      }
      const links = normalizeLinks(input.links);
      const normalizedSummary = text(input.summary, "Message lineage summary", MAXIMUM_SUMMARY_CHARS);
      const createdAt = timestamp(input.createdAt, "Message lineage summary timestamp");
      if (input.kind !== "turn" && input.kind !== "branch" && input.kind !== "session") invalid("Message lineage summary kind is invalid.");
      if (input.author !== "host" && input.author !== "model") invalid("Message lineage summary author is invalid.");
      const id = `lineage-summary:${(await sha256(JSON.stringify({
        kind: input.kind,
        author: input.author,
        summary: normalizedSummary,
        sourceEventIds,
        parentSummaryIds,
        links,
      }))).slice(0, 48)}`;
      const record = normalizeSummary({
        schema: RESEARCH_MESSAGE_LINEAGE_SUMMARY_SCHEMA_V1,
        id,
        kind: input.kind,
        createdAt,
        author: input.author,
        nonAuthoritative: true,
        summary: normalizedSummary,
        sourceEventIds,
        parentSummaryIds,
        ...links,
      });
      const existing = await this.#readSummary(record.id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(record)) invalid("Message lineage summary ID collides with a different summary.");
        return clone(existing);
      }
      if (this.#index.summaries.length >= MAXIMUM_SUMMARIES) {
        throw new ResearchContractError("limit-exceeded", "Message lineage summary limit is exhausted.");
      }
      try {
        await this.#workspace.writeFile(summaryPath(record.id), JSON.stringify(record));
        this.#index = {
          ...this.#index,
          summaries: [...this.#index.summaries, { id: record.id, createdAt: record.createdAt }],
        };
        await this.#persistIndex();
      } catch (error) {
        this.#writeFailure = error;
        throw error;
      }
      return clone(record);
    });
  }

  async describe(): Promise<{
    eventCount: number;
    summaryCount: number;
    newestEventAt?: string;
    newestSummaryAt?: string;
  }> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      return {
        eventCount: this.#index.events.length,
        summaryCount: this.#index.summaries.length,
        ...(this.#index.events.at(-1) ? { newestEventAt: this.#index.events.at(-1)!.createdAt } : {}),
        ...(this.#index.summaries.at(-1) ? { newestSummaryAt: this.#index.summaries.at(-1)!.createdAt } : {}),
      };
    });
  }

  async latestSummary(): Promise<ResearchMessageLineageSummaryV1 | undefined> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      const latest = this.#index.summaries.at(-1);
      return latest ? clone(await this.#readSummary(latest.id)) : undefined;
    });
  }

  async recentEvents(input: { limit?: number } = {}): Promise<ResearchMessageLineageEventV1[]> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      const limit = input.limit === undefined
        ? 20
        : positiveInteger(input.limit, "Message lineage recent-event limit", MAXIMUM_SEARCH_RESULTS);
      const entries = this.#index.events.slice(-limit);
      return Promise.all(entries.map(async (entry) => {
        const event = await this.#readEvent(entry.id);
        if (!event) invalid("Message lineage index references a missing event.");
        return clone(event);
      }));
    });
  }

  async search(input: {
    query: string;
    limit?: number;
    cursor?: string;
  }): Promise<{
    matches: Array<{ id: string; type: "event" | "summary"; createdAt: string; snippet: string }>;
    exhaustive: boolean;
    nextCursor?: string;
  }> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      const query = text(input.query, "Message lineage search query", MAXIMUM_SEARCH_QUERY_CHARS).toLocaleLowerCase("en-US");
      const limit = input.limit === undefined ? 20 : positiveInteger(input.limit, "Message lineage search limit", MAXIMUM_SEARCH_RESULTS);
      const entries = [
        ...this.#index.events.map((entry) => ({ ...entry, type: "event" as const })),
        ...this.#index.summaries.map((entry) => ({ ...entry, type: "summary" as const })),
      ].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
      const start = input.cursor === undefined ? 0 : entries.findIndex((entry) => entry.id === input.cursor) + 1;
      if (input.cursor !== undefined && start === 0) invalid("Message lineage search cursor is invalid.");
      const matches: Array<{ id: string; type: "event" | "summary"; createdAt: string; snippet: string }> = [];
      let scannedBytes = 0;
      let index = start;
      for (; index < entries.length; index += 1) {
        const entry = entries[index]!;
        let searchable: string;
        if (entry.type === "event") {
          const record = await this.#readEvent(entry.id);
          if (!record) invalid("Message lineage index references a missing record.");
          searchable = record.payloadJson;
        } else {
          const record = await this.#readSummary(entry.id);
          if (!record) invalid("Message lineage index references a missing record.");
          searchable = record.summary;
        }
        scannedBytes += bytes(searchable);
        if (searchable.toLocaleLowerCase("en-US").includes(query)) {
          matches.push({ id: entry.id, type: entry.type, createdAt: entry.createdAt, snippet: searchSnippet(searchable, query) });
          if (matches.length >= limit) {
            index += 1;
            break;
          }
        }
        if (scannedBytes >= MAXIMUM_SEARCH_SCAN_BYTES) {
          index += 1;
          break;
        }
      }
      const exhaustive = index >= entries.length;
      return {
        matches,
        exhaustive,
        ...(!exhaustive && entries[Math.min(index - 1, entries.length - 1)] ? { nextCursor: entries[Math.min(index - 1, entries.length - 1)]!.id } : {}),
      };
    });
  }

  async expand(id: string): Promise<ResearchMessageLineageEventV1 | ResearchMessageLineageSummaryV1 | undefined> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      if (id.startsWith("lineage-event:")) {
        const validated = eventId(id);
        return this.#index.events.some((entry) => entry.id === validated) ? clone(await this.#readEvent(validated)) : undefined;
      }
      if (id.startsWith("lineage-summary:")) {
        const validated = summaryId(id);
        return this.#index.summaries.some((entry) => entry.id === validated) ? clone(await this.#readSummary(validated)) : undefined;
      }
      invalid("Message lineage record ID is invalid.");
    });
  }
}
