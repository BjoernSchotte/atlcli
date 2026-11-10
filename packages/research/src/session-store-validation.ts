/**
 * Package-private bounds and validators shared by every session store
 * (in-memory reference, SQLite, IndexedDB), so the three hosts cannot drift.
 * Not exported from any entrypoint; the schema constants are re-exported by
 * `session-store.ts`.
 */
import { ResearchContractError } from "./contracts.js";
import type { ResearchSessionUpdateV1, ResearchSessionV1 } from "./session.js";
import type {
  ResearchOpaqueSourceRefV1,
  ResearchSessionArtifactV1,
  ResearchSessionEventV1,
} from "./session-store.js";

export const RESEARCH_SESSION_EVENT_SCHEMA_V1 = "atlcli.research-session-event/v1" as const;
export const RESEARCH_SESSION_ARTIFACT_SCHEMA_V1 = "atlcli.research-session-artifact/v1" as const;
export const RESEARCH_OPAQUE_SOURCE_REF_SCHEMA_V1 = "atlcli.research-opaque-source-ref/v1" as const;

export const MAXIMUM_SESSIONS_V1 = 128;
export const MAXIMUM_EVENTS_PER_SESSION_V1 = 2_000;
// A retained session may contain one canonical Markdown report per allowed
// turn, plus the bounded latest query/gap/draft operating projections.
export const MAXIMUM_ARTIFACTS_PER_SESSION_V1 = 72;
export const MAXIMUM_SOURCE_REFS_PER_SESSION_V1 = 4_096;

function invalid(message: string): never {
  throw new ResearchContractError("invalid-request", message);
}

function boundedId(value: string, prefix: string): boolean {
  return new RegExp(`^${prefix}[A-Za-z0-9._:-]{1,180}$`).test(value);
}

/** The body-free journal event for one committed session update. */
export function sessionEventFor(session: ResearchSessionV1, update: ResearchSessionUpdateV1): ResearchSessionEventV1 {
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

export function validateSourceRefs(refs: readonly ResearchOpaqueSourceRefV1[]): void {
  if (!Array.isArray(refs) || refs.length > MAXIMUM_SOURCE_REFS_PER_SESSION_V1) invalid("Research source references exceed the bounded limit.");
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!ref || ref.schema !== RESEARCH_OPAQUE_SOURCE_REF_SCHEMA_V1 || !boundedId(ref.id, "source:") || !["jira", "confluence"].includes(ref.product) || typeof ref.sourceRef !== "string" || !ref.sourceRef.trim() || ref.sourceRef.length > 512 || !Number.isFinite(Date.parse(ref.capturedAt)) || seen.has(ref.id)) invalid("Research opaque source reference is invalid or duplicated.");
    seen.add(ref.id);
  }
}

export function validateArtifact(artifact: ResearchSessionArtifactV1, contents: string): void {
  if (!artifact || artifact.schema !== RESEARCH_SESSION_ARTIFACT_SCHEMA_V1 || !boundedId(artifact.id, "artifact:") || !/^\/artifacts\/[A-Za-z0-9._/-]{1,240}$/.test(artifact.path) || !["text/markdown", "application/json"].includes(artifact.contentType) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || !Number.isFinite(Date.parse(artifact.createdAt)) || typeof contents !== "string" || new TextEncoder().encode(contents).byteLength !== artifact.bytes || artifact.bytes > 2_000_000) invalid("Research artifact is invalid.");
}
