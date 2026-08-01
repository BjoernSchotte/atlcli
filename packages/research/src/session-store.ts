import { ResearchContractError } from "./contracts.js";
import type { ResearchGraphV1 } from "./graph.js";
import {
  reduceResearchSessionV1,
  type ResearchSessionCheckpointV1,
  type ResearchSessionUpdateV1,
  type ResearchSessionV1,
  type ResearchSessionTurnV1,
} from "./session.js";
import { createMemoryResearchWorkspace, type ResearchWorkspace } from "./workspace.js";
import type {
  ResearchAcceptedPacketV1,
  ResearchTaskAttemptV1,
} from "./workflow-contracts.js";

export const RESEARCH_SESSION_EVENT_SCHEMA_V1 = "atlcli.research-session-event/v1" as const;
export const RESEARCH_SESSION_ARTIFACT_SCHEMA_V1 = "atlcli.research-session-artifact/v1" as const;
export const RESEARCH_OPAQUE_SOURCE_REF_SCHEMA_V1 = "atlcli.research-opaque-source-ref/v1" as const;

const MAXIMUM_SESSIONS_V1 = 128;
const MAXIMUM_EVENTS_PER_SESSION_V1 = 2_000;
const MAXIMUM_CHECKPOINTS_PER_TURN_V1 = 256;
const MAXIMUM_TURNS_PER_SESSION_V1 = 64;
const MAXIMUM_TASKS_PER_TURN_V1 = 512;
const MAXIMUM_PACKETS_PER_TURN_V1 = 512;
const MAXIMUM_ARTIFACTS_PER_SESSION_V1 = 64;
const MAXIMUM_SOURCE_REFS_PER_SESSION_V1 = 4_096;

export interface ResearchSessionEventV1 {
  schema: typeof RESEARCH_SESSION_EVENT_SCHEMA_V1;
  sessionId: string;
  sessionRevision: number;
  leaseEpoch: number;
  kind: ResearchSessionUpdateV1["kind"];
  status: ResearchSessionV1["status"];
  turnId?: string;
  at: string;
}

/** A source pointer is opaque until T5 introduces evidence/chunk records. */
export interface ResearchOpaqueSourceRefV1 {
  schema: typeof RESEARCH_OPAQUE_SOURCE_REF_SCHEMA_V1;
  id: string;
  product: "jira" | "confluence";
  sourceRef: string;
  capturedAt: string;
}

/** Metadata is durable; artifact body storage remains adapter-owned. */
export interface ResearchSessionArtifactV1 {
  schema: typeof RESEARCH_SESSION_ARTIFACT_SCHEMA_V1;
  id: string;
  path: string;
  contentType: "text/markdown" | "application/json";
  bytes: number;
  createdAt: string;
}

export interface ResearchSessionCommitV1 {
  session: ResearchSessionV1;
  event: ResearchSessionEventV1;
}

export type ResearchSessionStoreFailureStageV1 =
  | "before_create"
  | "before_state_commit"
  | "before_event_append"
  | "before_artifact_write"
  | "before_source_ref_write"
  | "before_delete";

export interface ResearchSessionStoreFailureInjectionV1 {
  onStage?(stage: ResearchSessionStoreFailureStageV1, sessionId: string): void;
}

/**
 * Host-neutral aggregate store port. Implementations must make `commit`
 * revision-fenced and atomic for the session snapshot plus its journal event.
 */
export interface ResearchSessionStoreV1 {
  create(session: ResearchSessionV1): Promise<ResearchSessionV1>;
  read(sessionId: string): Promise<ResearchSessionV1 | undefined>;
  list(input?: { limit?: number; cursor?: string }): Promise<{ sessions: ResearchSessionV1[]; nextCursor?: string }>;
  commit(sessionId: string, update: ResearchSessionUpdateV1): Promise<ResearchSessionCommitV1>;
  events(sessionId: string, input?: { afterRevision?: number; limit?: number }): Promise<ResearchSessionEventV1[]>;
  checkpoints(sessionId: string, turnId: string): Promise<ResearchSessionCheckpointV1[]>;
  graph(sessionId: string, turnId: string): Promise<ResearchGraphV1 | undefined>;
  tasks(sessionId: string, turnId: string): Promise<ResearchTaskAttemptV1[]>;
  packet(sessionId: string, packetRef: string): Promise<ResearchAcceptedPacketV1 | undefined>;
  workspace(sessionId: string): Promise<ResearchWorkspace>;
  replaceOpaqueSourceRefs(sessionId: string, refs: ResearchOpaqueSourceRefV1[]): Promise<void>;
  opaqueSourceRefs(sessionId: string): Promise<ResearchOpaqueSourceRefV1[]>;
  writeArtifact(sessionId: string, artifact: ResearchSessionArtifactV1, contents: string): Promise<void>;
  artifact(sessionId: string, artifactId: string): Promise<{ metadata: ResearchSessionArtifactV1; contents: string } | undefined>;
  listArtifacts(sessionId: string): Promise<ResearchSessionArtifactV1[]>;
  eraseDeleted(sessionId: string): Promise<boolean>;
}

function invalid(message: string): never {
  throw new ResearchContractError("invalid-request", message);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function boundedId(value: string, prefix: string, maximum = 180): boolean {
  return new RegExp(`^${prefix}[A-Za-z0-9._:-]{1,${maximum}}$`).test(value);
}

function activeTurnId(session: ResearchSessionV1): string | undefined {
  return session.activeTurnId ?? session.turns.at(-1)?.id;
}

function turn(session: ResearchSessionV1, turnId: string): ResearchSessionTurnV1 | undefined {
  return session.turns.find((candidate) => candidate.id === turnId);
}

function assertStoredBounds(session: ResearchSessionV1): void {
  if (session.turns.length > MAXIMUM_TURNS_PER_SESSION_V1) invalid("Research session exceeds the turn limit.");
  for (const candidate of session.turns) {
    if (candidate.tasks.length > MAXIMUM_TASKS_PER_TURN_V1 || candidate.acceptedPackets.length > MAXIMUM_PACKETS_PER_TURN_V1 || candidate.checkpoints.length > MAXIMUM_CHECKPOINTS_PER_TURN_V1) {
      invalid("Research session turn exceeds a bounded store limit.");
    }
  }
}

function eventFor(session: ResearchSessionV1, update: ResearchSessionUpdateV1): ResearchSessionEventV1 {
  return {
    schema: RESEARCH_SESSION_EVENT_SCHEMA_V1,
    sessionId: session.sessionId,
    sessionRevision: session.revision,
    leaseEpoch: session.lease.epoch,
    kind: update.kind,
    status: session.status,
    ...(activeTurnId(session) ? { turnId: activeTurnId(session) } : {}),
    at: update.at,
  };
}

function validateSourceRefs(refs: readonly ResearchOpaqueSourceRefV1[]): void {
  if (!Array.isArray(refs) || refs.length > MAXIMUM_SOURCE_REFS_PER_SESSION_V1) invalid("Research source references exceed the bounded limit.");
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!ref || ref.schema !== RESEARCH_OPAQUE_SOURCE_REF_SCHEMA_V1 || !boundedId(ref.id, "source:") || !["jira", "confluence"].includes(ref.product) || typeof ref.sourceRef !== "string" || !ref.sourceRef.trim() || ref.sourceRef.length > 512 || !Number.isFinite(Date.parse(ref.capturedAt)) || seen.has(ref.id)) invalid("Research opaque source reference is invalid or duplicated.");
    seen.add(ref.id);
  }
}

function validateArtifact(artifact: ResearchSessionArtifactV1, contents: string): void {
  if (!artifact || artifact.schema !== RESEARCH_SESSION_ARTIFACT_SCHEMA_V1 || !boundedId(artifact.id, "artifact:") || !/^\/artifacts\/[A-Za-z0-9._/-]{1,240}$/.test(artifact.path) || !["text/markdown", "application/json"].includes(artifact.contentType) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || !Number.isFinite(Date.parse(artifact.createdAt)) || typeof contents !== "string" || new TextEncoder().encode(contents).byteLength !== artifact.bytes || artifact.bytes > 2_000_000) invalid("Research artifact is invalid.");
}

/**
 * Test-only reference implementation. It deliberately has no filesystem,
 * IndexedDB, provider, or browser dependencies, which makes it the conformance
 * baseline for the SQLite/filesystem and IndexedDB adapters in later T4 work.
 */
export class InMemoryResearchSessionStoreV1 implements ResearchSessionStoreV1 {
  readonly #sessions = new Map<string, ResearchSessionV1>();
  readonly #events = new Map<string, ResearchSessionEventV1[]>();
  readonly #workspaces = new Map<string, ResearchWorkspace>();
  readonly #sourceRefs = new Map<string, ResearchOpaqueSourceRefV1[]>();
  readonly #artifacts = new Map<string, Map<string, { metadata: ResearchSessionArtifactV1; contents: string }>>();
  readonly #failureInjection?: ResearchSessionStoreFailureInjectionV1;

  constructor(options: { failureInjection?: ResearchSessionStoreFailureInjectionV1 } = {}) {
    this.#failureInjection = options.failureInjection;
  }

  #fail(stage: ResearchSessionStoreFailureStageV1, sessionId: string): void {
    this.#failureInjection?.onStage?.(stage, sessionId);
  }

  #require(sessionId: string): ResearchSessionV1 {
    const session = this.#sessions.get(sessionId);
    if (!session) invalid("Research session is not found.");
    return session;
  }

  async create(session: ResearchSessionV1): Promise<ResearchSessionV1> {
    this.#fail("before_create", session.sessionId);
    assertStoredBounds(session);
    if (this.#sessions.size >= MAXIMUM_SESSIONS_V1 || this.#sessions.has(session.sessionId)) invalid("Research session already exists or exceeds the store limit.");
    this.#sessions.set(session.sessionId, clone(session));
    this.#events.set(session.sessionId, []);
    this.#workspaces.set(session.sessionId, createMemoryResearchWorkspace());
    this.#sourceRefs.set(session.sessionId, []);
    this.#artifacts.set(session.sessionId, new Map());
    return clone(session);
  }

  async read(sessionId: string): Promise<ResearchSessionV1 | undefined> {
    const found = this.#sessions.get(sessionId);
    return found ? clone(found) : undefined;
  }

  async list(input: { limit?: number; cursor?: string } = {}): Promise<{ sessions: ResearchSessionV1[]; nextCursor?: string }> {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const keys = [...this.#sessions.keys()].sort();
    const start = input.cursor ? keys.findIndex((key) => key === input.cursor) + 1 : 0;
    if (input.cursor && start === 0) invalid("Research session list cursor is invalid.");
    const slice = keys.slice(start, start + limit);
    return {
      sessions: slice.map((key) => clone(this.#sessions.get(key)!)),
      ...(start + limit < keys.length ? { nextCursor: slice.at(-1)! } : {}),
    };
  }

  async commit(sessionId: string, update: ResearchSessionUpdateV1): Promise<ResearchSessionCommitV1> {
    const current = this.#require(sessionId);
    if (update.expectedRevision !== current.revision || update.expectedLeaseEpoch !== current.lease.epoch) invalid("Research session store compare-and-swap fence is stale.");
    const next = reduceResearchSessionV1(current, update);
    assertStoredBounds(next);
    const event = eventFor(next, update);
    const events = this.#events.get(sessionId)!;
    if (events.length >= MAXIMUM_EVENTS_PER_SESSION_V1) invalid("Research session event limit is exhausted.");
    this.#fail("before_state_commit", sessionId);
    this.#fail("before_event_append", sessionId);
    this.#sessions.set(sessionId, clone(next));
    this.#events.set(sessionId, [...events, clone(event)]);
    return { session: clone(next), event: clone(event) };
  }

  async events(sessionId: string, input: { afterRevision?: number; limit?: number } = {}): Promise<ResearchSessionEventV1[]> {
    this.#require(sessionId);
    if (input.afterRevision !== undefined && (!Number.isSafeInteger(input.afterRevision) || input.afterRevision < 0)) invalid("Research session event revision is invalid.");
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    return clone((this.#events.get(sessionId) ?? [])
      .filter((event) => event.sessionRevision > (input.afterRevision ?? 0))
      .slice(0, limit));
  }

  async checkpoints(sessionId: string, turnId: string): Promise<ResearchSessionCheckpointV1[]> {
    const current = turn(this.#require(sessionId), turnId);
    if (!current) invalid("Research session turn is not found.");
    return clone(current.checkpoints);
  }

  async graph(sessionId: string, turnId: string): Promise<ResearchGraphV1 | undefined> {
    return clone(turn(this.#require(sessionId), turnId)?.graph);
  }

  async tasks(sessionId: string, turnId: string): Promise<ResearchTaskAttemptV1[]> {
    const current = turn(this.#require(sessionId), turnId);
    if (!current) invalid("Research session turn is not found.");
    return clone(current.tasks);
  }

  async packet(sessionId: string, packetRef: string): Promise<ResearchAcceptedPacketV1 | undefined> {
    const session = this.#require(sessionId);
    return clone(session.turns.flatMap((candidate) => candidate.acceptedPackets).find((packet) => packet.packetRef === packetRef));
  }

  async workspace(sessionId: string): Promise<ResearchWorkspace> {
    this.#require(sessionId);
    return this.#workspaces.get(sessionId)!;
  }

  async replaceOpaqueSourceRefs(sessionId: string, refs: ResearchOpaqueSourceRefV1[]): Promise<void> {
    this.#require(sessionId);
    validateSourceRefs(refs);
    this.#fail("before_source_ref_write", sessionId);
    this.#sourceRefs.set(sessionId, clone(refs));
  }

  async opaqueSourceRefs(sessionId: string): Promise<ResearchOpaqueSourceRefV1[]> {
    this.#require(sessionId);
    return clone(this.#sourceRefs.get(sessionId) ?? []);
  }

  async writeArtifact(sessionId: string, artifact: ResearchSessionArtifactV1, contents: string): Promise<void> {
    this.#require(sessionId);
    validateArtifact(artifact, contents);
    const artifacts = this.#artifacts.get(sessionId)!;
    if (!artifacts.has(artifact.id) && artifacts.size >= MAXIMUM_ARTIFACTS_PER_SESSION_V1) invalid("Research session artifact limit is exhausted.");
    this.#fail("before_artifact_write", sessionId);
    artifacts.set(artifact.id, { metadata: clone(artifact), contents });
  }

  async artifact(sessionId: string, artifactId: string): Promise<{ metadata: ResearchSessionArtifactV1; contents: string } | undefined> {
    this.#require(sessionId);
    const value = this.#artifacts.get(sessionId)!.get(artifactId);
    return value ? clone(value) : undefined;
  }

  async listArtifacts(sessionId: string): Promise<ResearchSessionArtifactV1[]> {
    this.#require(sessionId);
    return [...this.#artifacts.get(sessionId)!.values()]
      .map((value) => clone(value.metadata))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async eraseDeleted(sessionId: string): Promise<boolean> {
    const session = this.#sessions.get(sessionId);
    if (!session) return false;
    if (session.status !== "deleted" || session.retention.state !== "deleted") invalid("Only a deleted research session can be erased.");
    this.#fail("before_delete", sessionId);
    this.#sessions.delete(sessionId);
    this.#events.delete(sessionId);
    this.#workspaces.delete(sessionId);
    this.#sourceRefs.delete(sessionId);
    this.#artifacts.delete(sessionId);
    return true;
  }
}
