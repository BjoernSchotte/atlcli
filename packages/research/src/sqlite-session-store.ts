import { Database } from "bun:sqlite";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ResearchContractError } from "./contracts.js";
import { FileSystemResearchWorkspace } from "./filesystem-workspace.js";
import {
  RESEARCH_OPAQUE_SOURCE_REF_SCHEMA_V1,
  RESEARCH_SESSION_ARTIFACT_SCHEMA_V1,
  RESEARCH_SESSION_EVENT_SCHEMA_V1,
  type ResearchOpaqueSourceRefV1,
  type ResearchSessionArtifactV1,
  type ResearchSessionCommitV1,
  type ResearchSessionEventV1,
  type ResearchSessionStoreFailureInjectionV1,
  type ResearchSessionStoreV1,
} from "./session-store.js";
import {
  reduceResearchSessionV1,
  type ResearchSessionCheckpointV1,
  type ResearchSessionUpdateV1,
  type ResearchSessionV1,
} from "./session.js";
import type { ResearchGraphV1 } from "./graph.js";
import type { ResearchWorkspace } from "./workspace.js";
import type { ResearchAcceptedPacketV1, ResearchTaskAttemptV1 } from "./workflow-contracts.js";

const MAXIMUM_SESSIONS_V1 = 128;
const MAXIMUM_EVENTS_PER_SESSION_V1 = 2_000;
const MAXIMUM_ARTIFACTS_PER_SESSION_V1 = 64;
const MAXIMUM_SOURCE_REFS_PER_SESSION_V1 = 4_096;

type SessionRow = { session_id: string; revision: number; lease_epoch: number; state_json: string };
type EventRow = { event_json: string };
type SourceRefRow = { ref_json: string };
type ArtifactRow = { metadata_json: string; content_path: string };

function invalid(message: string): never {
  throw new ResearchContractError("invalid-request", message);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sessionDirectoryName(sessionId: string): string {
  const match = /^research-session:([A-Za-z0-9._-]{1,120})$/.exec(sessionId);
  if (!match) invalid("Research session ID is invalid.");
  return match[1]!;
}

function turnFor(session: ResearchSessionV1, turnId: string) {
  return session.turns.find((turn) => turn.id === turnId);
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

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    invalid(`Stored ${label} is invalid.`);
  }
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

/**
 * Bun/SQLite durable implementation used by the CLI. The SQLite transaction
 * is the authority for the revision-fenced session snapshot and body-free
 * journal event; each retained session also has a private 0700 directory for
 * its atomic manifest, workspace, and artifact bodies.
 */
export class SqliteResearchSessionStoreV1 implements ResearchSessionStoreV1 {
  readonly #db: Database;
  readonly #root: string;
  readonly #failureInjection?: ResearchSessionStoreFailureInjectionV1;

  constructor(options: {
    databasePath: string;
    root: string;
    failureInjection?: ResearchSessionStoreFailureInjectionV1;
  }) {
    this.#root = resolve(options.root);
    this.#failureInjection = options.failureInjection;
    this.#db = new Database(options.databasePath, { create: true });
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS research_sessions_v1 (
        session_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        lease_epoch INTEGER NOT NULL,
        state_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS research_session_events_v1 (
        session_id TEXT NOT NULL,
        session_revision INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (session_id, session_revision),
        FOREIGN KEY (session_id) REFERENCES research_sessions_v1(session_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS research_source_refs_v1 (
        session_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        ref_json TEXT NOT NULL,
        PRIMARY KEY (session_id, source_id),
        FOREIGN KEY (session_id) REFERENCES research_sessions_v1(session_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS research_artifacts_v1 (
        session_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        content_path TEXT NOT NULL,
        PRIMARY KEY (session_id, artifact_id),
        FOREIGN KEY (session_id) REFERENCES research_sessions_v1(session_id) ON DELETE CASCADE
      );
    `);
  }

  close(): void {
    this.#db.close();
  }

  #fail(stage: Parameters<NonNullable<ResearchSessionStoreFailureInjectionV1["onStage"]>>[0], sessionId: string): void {
    this.#failureInjection?.onStage?.(stage, sessionId);
  }

  #sessionRoot(sessionId: string): string {
    return join(this.#root, "sessions", sessionDirectoryName(sessionId));
  }

  #manifestPath(sessionId: string): string {
    return join(this.#sessionRoot(sessionId), "manifest.json");
  }

  #readRow(sessionId: string): SessionRow | undefined {
    return this.#db.query<SessionRow, [string]>("SELECT session_id, revision, lease_epoch, state_json FROM research_sessions_v1 WHERE session_id = ?").get(sessionId) ?? undefined;
  }

  #require(sessionId: string): ResearchSessionV1 {
    const row = this.#readRow(sessionId);
    if (!row) invalid("Research session is not found.");
    return parseJson<ResearchSessionV1>(row.state_json, "research session");
  }

  async create(session: ResearchSessionV1): Promise<ResearchSessionV1> {
    this.#fail("before_create", session.sessionId);
    const count = this.#db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM research_sessions_v1").get()?.count ?? 0;
    if (count >= MAXIMUM_SESSIONS_V1) invalid("Research session store limit is exhausted.");
    const root = this.#sessionRoot(session.sessionId);
    await mkdir(join(root, "workspace"), { recursive: true, mode: 0o700 });
    await mkdir(join(root, "artifacts"), { recursive: true, mode: 0o700 });
    try {
      this.#db.query("INSERT INTO research_sessions_v1 (session_id, revision, lease_epoch, state_json) VALUES (?, ?, ?, ?)").run(session.sessionId, session.revision, session.lease.epoch, JSON.stringify(session));
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) invalid("Research session already exists.");
      throw error;
    }
    await writeAtomic(this.#manifestPath(session.sessionId), JSON.stringify(session));
    return clone(session);
  }

  async read(sessionId: string): Promise<ResearchSessionV1 | undefined> {
    const row = this.#readRow(sessionId);
    return row ? clone(parseJson<ResearchSessionV1>(row.state_json, "research session")) : undefined;
  }

  async list(input: { limit?: number; cursor?: string } = {}): Promise<{ sessions: ResearchSessionV1[]; nextCursor?: string }> {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const rows = input.cursor
      ? this.#db.query<SessionRow, [string, number]>("SELECT session_id, revision, lease_epoch, state_json FROM research_sessions_v1 WHERE session_id > ? ORDER BY session_id LIMIT ?").all(input.cursor, limit + 1)
      : this.#db.query<SessionRow, [number]>("SELECT session_id, revision, lease_epoch, state_json FROM research_sessions_v1 ORDER BY session_id LIMIT ?").all(limit + 1);
    const page = rows.slice(0, limit);
    return {
      sessions: page.map((row) => clone(parseJson<ResearchSessionV1>(row.state_json, "research session"))),
      ...(rows.length > limit ? { nextCursor: page.at(-1)!.session_id } : {}),
    };
  }

  async commit(sessionId: string, update: ResearchSessionUpdateV1): Promise<ResearchSessionCommitV1> {
    const current = this.#require(sessionId);
    if (current.revision !== update.expectedRevision || current.lease.epoch !== update.expectedLeaseEpoch) invalid("Research session store compare-and-swap fence is stale.");
    const next = reduceResearchSessionV1(current, update);
    const event = eventFor(next, update);
    const eventCount = this.#db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM research_session_events_v1 WHERE session_id = ?").get(sessionId)?.count ?? 0;
    if (eventCount >= MAXIMUM_EVENTS_PER_SESSION_V1) invalid("Research session event limit is exhausted.");
    this.#fail("before_state_commit", sessionId);
    this.#fail("before_event_append", sessionId);
    this.#db.transaction(() => {
      const written = this.#db.query("UPDATE research_sessions_v1 SET revision = ?, lease_epoch = ?, state_json = ? WHERE session_id = ? AND revision = ? AND lease_epoch = ?").run(next.revision, next.lease.epoch, JSON.stringify(next), sessionId, current.revision, current.lease.epoch);
      if (written.changes !== 1) invalid("Research session store compare-and-swap fence is stale.");
      this.#db.query("INSERT INTO research_session_events_v1 (session_id, session_revision, event_json) VALUES (?, ?, ?)").run(sessionId, next.revision, JSON.stringify(event));
    })();
    await writeAtomic(this.#manifestPath(sessionId), JSON.stringify(next));
    return { session: clone(next), event: clone(event) };
  }

  async events(sessionId: string, input: { afterRevision?: number; limit?: number } = {}): Promise<ResearchSessionEventV1[]> {
    this.#require(sessionId);
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    const rows = this.#db.query<EventRow, [string, number, number]>("SELECT event_json FROM research_session_events_v1 WHERE session_id = ? AND session_revision > ? ORDER BY session_revision LIMIT ?").all(sessionId, input.afterRevision ?? 0, limit);
    return rows.map((row) => clone(parseJson<ResearchSessionEventV1>(row.event_json, "research session event")));
  }

  async checkpoints(sessionId: string, turnId: string): Promise<ResearchSessionCheckpointV1[]> {
    const current = turnFor(this.#require(sessionId), turnId);
    if (!current) invalid("Research session turn is not found.");
    return clone(current.checkpoints);
  }

  async graph(sessionId: string, turnId: string): Promise<ResearchGraphV1 | undefined> {
    return clone(turnFor(this.#require(sessionId), turnId)?.graph);
  }

  async tasks(sessionId: string, turnId: string): Promise<ResearchTaskAttemptV1[]> {
    const current = turnFor(this.#require(sessionId), turnId);
    if (!current) invalid("Research session turn is not found.");
    return clone(current.tasks);
  }

  async packet(sessionId: string, packetRef: string): Promise<ResearchAcceptedPacketV1 | undefined> {
    return clone(this.#require(sessionId).turns.flatMap((turn) => turn.acceptedPackets).find((packet) => packet.packetRef === packetRef));
  }

  async workspace(sessionId: string): Promise<ResearchWorkspace> {
    this.#require(sessionId);
    return new FileSystemResearchWorkspace(this.#sessionRoot(sessionId));
  }

  async replaceOpaqueSourceRefs(sessionId: string, refs: ResearchOpaqueSourceRefV1[]): Promise<void> {
    this.#require(sessionId);
    validateSourceRefs(refs);
    this.#fail("before_source_ref_write", sessionId);
    this.#db.transaction(() => {
      this.#db.query("DELETE FROM research_source_refs_v1 WHERE session_id = ?").run(sessionId);
      const insert = this.#db.query("INSERT INTO research_source_refs_v1 (session_id, source_id, ref_json) VALUES (?, ?, ?)");
      for (const ref of refs) insert.run(sessionId, ref.id, JSON.stringify(ref));
    })();
  }

  async opaqueSourceRefs(sessionId: string): Promise<ResearchOpaqueSourceRefV1[]> {
    this.#require(sessionId);
    const rows = this.#db.query<SourceRefRow, [string]>("SELECT ref_json FROM research_source_refs_v1 WHERE session_id = ? ORDER BY source_id").all(sessionId);
    return rows.map((row) => clone(parseJson<ResearchOpaqueSourceRefV1>(row.ref_json, "research source reference")));
  }

  async writeArtifact(sessionId: string, artifact: ResearchSessionArtifactV1, contents: string): Promise<void> {
    this.#require(sessionId);
    validateArtifact(artifact, contents);
    const count = this.#db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM research_artifacts_v1 WHERE session_id = ?").get(sessionId)?.count ?? 0;
    const exists = this.#db.query<ArtifactRow, [string, string]>("SELECT metadata_json, content_path FROM research_artifacts_v1 WHERE session_id = ? AND artifact_id = ?").get(sessionId, artifact.id);
    if (!exists && count >= MAXIMUM_ARTIFACTS_PER_SESSION_V1) invalid("Research session artifact limit is exhausted.");
    this.#fail("before_artifact_write", sessionId);
    const workspace = new FileSystemResearchWorkspace(this.#sessionRoot(sessionId));
    await workspace.writeFile(artifact.path, contents);
    this.#db.query("INSERT OR REPLACE INTO research_artifacts_v1 (session_id, artifact_id, metadata_json, content_path) VALUES (?, ?, ?, ?)").run(sessionId, artifact.id, JSON.stringify(artifact), artifact.path);
  }

  async artifact(sessionId: string, artifactId: string): Promise<{ metadata: ResearchSessionArtifactV1; contents: string } | undefined> {
    this.#require(sessionId);
    const row = this.#db.query<ArtifactRow, [string, string]>("SELECT metadata_json, content_path FROM research_artifacts_v1 WHERE session_id = ? AND artifact_id = ?").get(sessionId, artifactId);
    if (!row) return undefined;
    const contents = await new FileSystemResearchWorkspace(this.#sessionRoot(sessionId)).readFile(row.content_path);
    if (contents === undefined) invalid("Research artifact body is missing.");
    return { metadata: clone(parseJson<ResearchSessionArtifactV1>(row.metadata_json, "research artifact")), contents };
  }

  async listArtifacts(sessionId: string): Promise<ResearchSessionArtifactV1[]> {
    this.#require(sessionId);
    const rows = this.#db.query<ArtifactRow, [string]>("SELECT metadata_json, content_path FROM research_artifacts_v1 WHERE session_id = ? ORDER BY artifact_id").all(sessionId);
    return rows.map((row) => clone(parseJson<ResearchSessionArtifactV1>(row.metadata_json, "research artifact")));
  }

  async eraseDeleted(sessionId: string): Promise<boolean> {
    const current = await this.read(sessionId);
    if (!current) return false;
    if (current.status !== "deleted" || current.retention.state !== "deleted") invalid("Only a deleted research session can be erased.");
    this.#fail("before_delete", sessionId);
    this.#db.query("DELETE FROM research_sessions_v1 WHERE session_id = ?").run(sessionId);
    await rm(this.#sessionRoot(sessionId), { recursive: true, force: true });
    return true;
  }
}
