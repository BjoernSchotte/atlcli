import type { ResearchAgentDraftV1 } from "./agent-draft.js";
import type { ResearchGraphV1 } from "./graph.js";
import type { ResearchRetrievalAssessmentV1 } from "./retrieval-assessment.js";
import {
  RESEARCH_SESSION_ARTIFACT_SCHEMA_V1,
  type ResearchSessionArtifactV1,
} from "./session-store.js";
import {
  isResearchPacketBodyV1,
  isResearchPacketBodyV2,
  type ResearchAcceptedPacketV1,
  type ResearchGapV1,
} from "./workflow-contracts.js";

/**
 * Durable, bounded operating context for the current graph revision. These
 * artifact projections are private session data, not evidence and never a
 * substitute for the authoritative graph or packet journal.
 */
export const RESEARCH_QUERY_INTENTS_ARTIFACT_SCHEMA_V1 =
  "atlcli.research-query-intents-artifact/v1" as const;
export const RESEARCH_GAP_ASSESSMENT_ARTIFACT_SCHEMA_V1 =
  "atlcli.research-gap-assessment-artifact/v1" as const;
export const RESEARCH_REPORT_DRAFT_ARTIFACT_SCHEMA_V1 =
  "atlcli.research-report-draft-artifact/v1" as const;

export const RESEARCH_QUERY_INTENTS_ARTIFACT_ID_V1 = "artifact:query-intents" as const;
export const RESEARCH_GAP_ASSESSMENT_ARTIFACT_ID_V1 = "artifact:gap-assessment" as const;
export const RESEARCH_REPORT_DRAFT_ARTIFACT_ID_V1 = "artifact:report-draft" as const;

export const RESEARCH_QUERY_INTENTS_ARTIFACT_PATH_V1 = "/artifacts/query-intents.json" as const;
export const RESEARCH_GAP_ASSESSMENT_ARTIFACT_PATH_V1 = "/artifacts/gap-assessment.json" as const;
export const RESEARCH_REPORT_DRAFT_ARTIFACT_PATH_V1 = "/artifacts/report-draft.json" as const;

export interface ResearchQueryIntentsArtifactV1 {
  schema: typeof RESEARCH_QUERY_INTENTS_ARTIFACT_SCHEMA_V1;
  turnId: string;
  graphRevision: number;
  updatedAt: string;
  intents: Array<{
    nodeId: string;
    kind: ResearchGraphV1["nodes"][number]["kind"];
    roleId?: string;
    objective: string;
    typedIntentRefs: string[];
    grantedCapabilityIds: string[];
    dependencyNodeIds: string[];
    coverageTargetIds: string[];
    reasonCodes: string[];
  }>;
}

export interface ResearchGapAssessmentArtifactV1 {
  schema: typeof RESEARCH_GAP_ASSESSMENT_ARTIFACT_SCHEMA_V1;
  turnId: string;
  graphRevision: number;
  updatedAt: string;
  packets: Array<{
    taskId: string;
    packetRef: string;
    roleId?: string;
    gaps: ResearchGapV1[];
    coverageLimits: string[];
    proposedFollowUpIds: string[];
    abstentionReason?: string;
  }>;
  latestRetrievalAssessment?: ResearchRetrievalAssessmentV1;
}

export interface ResearchReportDraftArtifactV1 {
  schema: typeof RESEARCH_REPORT_DRAFT_ARTIFACT_SCHEMA_V1;
  turnId: string;
  graphRevision?: number;
  updatedAt: string;
  draft: ResearchAgentDraftV1;
}

export type ResearchSessionArtifactDocumentV1 =
  | ResearchQueryIntentsArtifactV1
  | ResearchGapAssessmentArtifactV1
  | ResearchReportDraftArtifactV1;

export interface ResearchSessionArtifactWriteV1 {
  metadata: ResearchSessionArtifactV1;
  contents: string;
}

function canonicalStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function canonicalGaps(gaps: readonly ResearchGapV1[]): ResearchGapV1[] {
  return gaps
    .map((gap) => ({
      id: gap.id,
      summary: gap.summary,
      ...(gap.targetId ? { targetId: gap.targetId } : {}),
      sourceIds: canonicalStrings(gap.sourceIds),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Project the host-approved graph into compact, query-shaped operational
 * context. It intentionally contains no source bodies, cursors, provider
 * credentials, QuickJS program, or model trajectory.
 */
export function projectResearchQueryIntentsArtifactV1(input: {
  graph: ResearchGraphV1;
  updatedAt: string;
}): ResearchQueryIntentsArtifactV1 {
  return {
    schema: RESEARCH_QUERY_INTENTS_ARTIFACT_SCHEMA_V1,
    turnId: input.graph.turnId,
    graphRevision: input.graph.revision,
    updatedAt: input.updatedAt,
    intents: input.graph.nodes
      .filter((node) => node.status !== "pruned")
      .map((node) => ({
        nodeId: node.id,
        kind: node.kind,
        ...(node.roleId ? { roleId: node.roleId } : {}),
        objective: node.objective,
        typedIntentRefs: canonicalStrings(node.typedIntentRefs),
        grantedCapabilityIds: canonicalStrings(node.grantedCapabilityIds),
        dependencyNodeIds: canonicalStrings(node.dependencies),
        coverageTargetIds: canonicalStrings(node.completion.requiredCoverageTargetIds),
        reasonCodes: canonicalStrings(node.reasonCodes),
      }))
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
  };
}

/**
 * Persist only accepted gap/coverage projections. Findings, claims, source
 * bodies, detail excerpts, and child trajectories remain in their own
 * authoritative stores and are deliberately not copied into this artifact.
 */
export function projectResearchGapAssessmentArtifactV1(input: {
  turnId: string;
  graphRevision: number;
  packets: Iterable<ResearchAcceptedPacketV1>;
  updatedAt: string;
  latestRetrievalAssessment?: ResearchRetrievalAssessmentV1;
}): ResearchGapAssessmentArtifactV1 {
  return {
    schema: RESEARCH_GAP_ASSESSMENT_ARTIFACT_SCHEMA_V1,
    turnId: input.turnId,
    graphRevision: input.graphRevision,
    updatedAt: input.updatedAt,
    packets: [...input.packets]
      .filter((packet) => isResearchPacketBodyV1(packet.body) || isResearchPacketBodyV2(packet.body))
      .map((packet) => {
        const body = packet.body;
        if (!isResearchPacketBodyV1(body) && !isResearchPacketBodyV2(body)) {
          throw new Error("Research gap artifact received a non-research packet.");
        }
        return {
          taskId: packet.taskId,
          packetRef: packet.packetRef,
          ...(packet.roleId ? { roleId: packet.roleId } : {}),
          gaps: canonicalGaps(body.gaps),
          coverageLimits: canonicalStrings(body.coverageLimits),
          proposedFollowUpIds: canonicalStrings(body.proposedFollowUps.map((followUp) => followUp.id)),
          ...(body.abstentionReason ? { abstentionReason: body.abstentionReason } : {}),
        };
      })
      .sort((left, right) => left.taskId.localeCompare(right.taskId)),
    ...(input.latestRetrievalAssessment
      ? { latestRetrievalAssessment: structuredClone(input.latestRetrievalAssessment) }
      : {}),
  };
}

/** Store the schema-validated synthesizer candidate before deterministic rendering. */
export function projectResearchReportDraftArtifactV1(input: {
  turnId: string;
  graphRevision?: number;
  draft: ResearchAgentDraftV1;
  updatedAt: string;
}): ResearchReportDraftArtifactV1 {
  return {
    schema: RESEARCH_REPORT_DRAFT_ARTIFACT_SCHEMA_V1,
    turnId: input.turnId,
    ...(input.graphRevision === undefined ? {} : { graphRevision: input.graphRevision }),
    updatedAt: input.updatedAt,
    draft: structuredClone(input.draft),
  };
}

function artifactLocation(
  document: ResearchSessionArtifactDocumentV1,
): { id: string; path: string } {
  switch (document.schema) {
    case RESEARCH_QUERY_INTENTS_ARTIFACT_SCHEMA_V1:
      return { id: RESEARCH_QUERY_INTENTS_ARTIFACT_ID_V1, path: RESEARCH_QUERY_INTENTS_ARTIFACT_PATH_V1 };
    case RESEARCH_GAP_ASSESSMENT_ARTIFACT_SCHEMA_V1:
      return { id: RESEARCH_GAP_ASSESSMENT_ARTIFACT_ID_V1, path: RESEARCH_GAP_ASSESSMENT_ARTIFACT_PATH_V1 };
    case RESEARCH_REPORT_DRAFT_ARTIFACT_SCHEMA_V1:
      return { id: RESEARCH_REPORT_DRAFT_ARTIFACT_ID_V1, path: RESEARCH_REPORT_DRAFT_ARTIFACT_PATH_V1 };
  }
}

/**
 * Use stable artifact identities: each write replaces only the current
 * operational projection rather than consuming the bounded artifact quota on
 * every turn or wave.
 */
export function prepareResearchSessionArtifactWriteV1(
  document: ResearchSessionArtifactDocumentV1,
): ResearchSessionArtifactWriteV1 {
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  const location = artifactLocation(document);
  return {
    metadata: {
      schema: RESEARCH_SESSION_ARTIFACT_SCHEMA_V1,
      id: location.id,
      path: location.path,
      contentType: "application/json",
      bytes: new TextEncoder().encode(contents).byteLength,
      createdAt: document.updatedAt,
    },
    contents,
  };
}
