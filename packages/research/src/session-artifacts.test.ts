import { describe, expect, test } from "bun:test";
import { createResearchBriefV1 } from "./brief.js";
import { composeResearchGraphV1 } from "./graph.js";
import {
  RESEARCH_GAP_ASSESSMENT_ARTIFACT_ID_V1,
  RESEARCH_GAP_ASSESSMENT_ARTIFACT_PATH_V1,
  RESEARCH_QUERY_INTENTS_ARTIFACT_ID_V1,
  RESEARCH_QUERY_INTENTS_ARTIFACT_PATH_V1,
  RESEARCH_REPORT_DRAFT_ARTIFACT_ID_V1,
  RESEARCH_REPORT_DRAFT_ARTIFACT_PATH_V1,
  prepareResearchSessionArtifactWriteV1,
  projectResearchGapAssessmentArtifactV1,
  projectResearchQueryIntentsArtifactV1,
  projectResearchReportDraftArtifactV1,
} from "./session-artifacts.js";
import {
  RESEARCH_PACKET_BODY_SCHEMA_V1,
  RESEARCH_RECONCILIATION_DISPOSITION_SCHEMA_V1,
  type ResearchAcceptedPacketV1,
  type ResearchReconciliationDispositionV1,
} from "./workflow-contracts.js";

const updatedAt = "2026-08-03T12:00:00.000Z";
const graph = composeResearchGraphV1(createResearchBriefV1({
  sessionId: "research-session:artifact-projections",
  turnId: "research-turn:artifact-projections",
  objective: "Relate the bounded Jira delivery work to Confluence guidance.",
  scope: {
    siteOrigin: "https://synthetic.atlassian.net",
    jiraProjectKeys: ["DEMO"],
    confluenceSpaceKeys: ["KB"],
  },
  sourceClasses: ["jira", "confluence"],
  asOf: updatedAt,
  timezone: "UTC",
  requestedEffort: "analysis",
  requestedPlanApproval: "automatic",
  requestedReconciliation: "auto",
}));

const packet: ResearchAcceptedPacketV1 = {
  schema: "atlcli.accepted-research-packet/v1",
  packetRef: "packet:artifact-gap",
  taskId: "research-task:r1:jira-research:a1",
  graphRevision: graph.revision,
  attempt: 1,
  executor: "subagent",
  roleId: "focused-researcher",
  grantedCapabilityIds: ["jira.issue.search"],
  typedIntentRefs: ["intent:research-node:jira-research"],
  expectedOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V1,
  body: {
    schema: RESEARCH_PACKET_BODY_SCHEMA_V1,
    answeredQuestion: "Synthetic detail-backed packet.",
    sourceIds: ["jira:DEMO-1"],
    findingCandidates: [{
      id: "finding:excluded-from-artifact",
      classification: "fact",
      summary: "This finding is not copied into the gap artifact.",
      sourceIds: ["jira:DEMO-1"],
    }],
    relationshipCandidates: [],
    gaps: [{
      id: "gap:documentation",
      summary: "Confluence detail was not read.",
      targetId: "coverage:primary-question",
      sourceIds: ["jira:DEMO-1"],
    }],
    proposedFollowUps: [{
      id: "follow-up:wiki-detail",
      objective: "Read the relevant Confluence page.",
      reasonCode: "coverage_gap",
      sourceIds: ["jira:DEMO-1"],
    }],
    coverageLimits: ["No Confluence detail was returned."],
    abstentionReason: "The cross-product relationship cannot yet be verified.",
  },
  hostObservedUsage: {
    capabilityCalls: 1,
    inputTokens: 20,
    outputTokens: 10,
    resultBytes: 1_024,
    durationMs: 100,
    costMicros: 20,
  },
  acceptedAt: updatedAt,
};

const disposition: ResearchReconciliationDispositionV1 = {
  schema: RESEARCH_RECONCILIATION_DISPOSITION_SCHEMA_V1,
  id: "reconciliation-disposition:artifact",
  reconciliationPacketRef: "packet:excluded-from-artifact",
  defectId: "defect:coverage",
  basedOnGraphRevision: graph.revision,
  decision: "add_follow_up",
  reasonCode: "material_defect",
  resultingGraphRevision: graph.revision + 1,
  resultingNodeId: "research-node:repair-coverage",
  resultingClaimIds: ["claim:two", "claim:one"],
  recordedAt: updatedAt,
};

describe("durable session artifact projections", () => {
  test("projects only compact graph query intents without source evidence", () => {
    const artifact = projectResearchQueryIntentsArtifactV1({ graph, updatedAt });

    expect(artifact).toMatchObject({
      turnId: graph.turnId,
      graphRevision: graph.revision,
      intents: expect.arrayContaining([
        expect.objectContaining({
          nodeId: "research-node:jira-research",
          typedIntentRefs: ["intent:research-node:jira-research"],
        }),
      ]),
    });
    expect(JSON.stringify(artifact)).not.toContain("sourceIds");
    expect(JSON.stringify(artifact)).not.toContain("DEMO-1");
    expect(artifact.roleDecisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ roleId: "focused-researcher", decision: "selected" }),
      expect.objectContaining({ roleId: "coverage-moderator", decision: "omitted" }),
    ]));
    expect(artifact.nodeDecisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "research-node:jira-research", decision: "selected" }),
    ]));
    const pruned = structuredClone(graph);
    const prunedNode = pruned.nodes.find((node) => node.id === "research-node:wiki-research")!;
    prunedNode.status = "pruned";
    expect(projectResearchQueryIntentsArtifactV1({ graph: pruned, updatedAt }).nodeDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: prunedNode.id,
          decision: "omitted",
          reasonCodes: ["independent_branch"],
        }),
      ]),
    );
  });

  test("projects gaps and host retrieval status without copying findings or follow-up prompts", () => {
    const artifact = projectResearchGapAssessmentArtifactV1({
      graph,
      packets: [packet],
      updatedAt,
      latestRetrievalAssessment: {
        schema: "atlcli.research-retrieval-assessment/v1",
        action: "replan",
        reason: "coverage_gap",
        products: [{
          product: "jira",
          rankedCandidateCount: 1,
          detailReadCount: 1,
          uniqueDetailSourceCount: 1,
          unreadRankedCandidateCount: 0,
          searchAttempted: true,
          searchComplete: true,
          canSearchMore: false,
          canReadMoreDetails: false,
        }],
        newDetailSourceCount: 1,
        duplicateDetailReadCount: 0,
        unresolvedCoverageTargetCount: 1,
        unresolvedContradictionCount: 0,
      },
      reconciliationDispositions: [disposition],
    });

    expect(artifact.packets).toEqual([expect.objectContaining({
      taskId: packet.taskId,
      gaps: [expect.objectContaining({ id: "gap:documentation" })],
      proposedFollowUpIds: ["follow-up:wiki-detail"],
    })]);
    expect(artifact.latestRetrievalAssessment).toMatchObject({ reason: "coverage_gap" });
    expect(artifact.reconciliation).toMatchObject({
      status: "recorded",
      policy: expect.objectContaining({ mode: "auto" }),
      dispositions: [expect.objectContaining({
        id: disposition.id,
        decision: "add_follow_up",
        reasonCode: "material_defect",
        resultingClaimIds: ["claim:one", "claim:two"],
      })],
    });
    expect(JSON.stringify(artifact)).not.toContain("excluded-from-artifact");
    expect(JSON.stringify(artifact)).not.toContain("Read the relevant Confluence page.");
    expect(JSON.stringify(artifact)).not.toContain("packet:excluded-from-artifact");
  });

  test("uses stable canonical paths so current state never consumes one artifact slot per turn", () => {
    const query = prepareResearchSessionArtifactWriteV1(
      projectResearchQueryIntentsArtifactV1({ graph, updatedAt }),
    );
    const gaps = prepareResearchSessionArtifactWriteV1(projectResearchGapAssessmentArtifactV1({
      graph,
      packets: [packet],
      updatedAt,
    }));
    const firstDraft = prepareResearchSessionArtifactWriteV1(projectResearchReportDraftArtifactV1({
      turnId: "research-turn:first",
      graphRevision: graph.revision,
      updatedAt,
      draft: {
        title: "First draft",
        executiveSummary: "Synthetic first draft.",
        findings: [],
        relationships: [],
        limitations: [],
      },
    }));
    const secondDraft = prepareResearchSessionArtifactWriteV1(projectResearchReportDraftArtifactV1({
      turnId: "research-turn:second",
      graphRevision: graph.revision,
      updatedAt,
      draft: {
        title: "Second draft",
        executiveSummary: "Synthetic second draft.",
        findings: [],
        relationships: [],
        limitations: [],
      },
    }));
    const compactDraft = prepareResearchSessionArtifactWriteV1(projectResearchReportDraftArtifactV1({
      turnId: "research-turn:compact",
      graphRevision: graph.revision,
      updatedAt,
      draft: {
        title: "Compact V2 selection",
        selectedClaimIds: [],
      },
    }));

    expect(query.metadata).toMatchObject({
      id: RESEARCH_QUERY_INTENTS_ARTIFACT_ID_V1,
      path: RESEARCH_QUERY_INTENTS_ARTIFACT_PATH_V1,
      contentType: "application/json",
    });
    expect(gaps.metadata).toMatchObject({
      id: RESEARCH_GAP_ASSESSMENT_ARTIFACT_ID_V1,
      path: RESEARCH_GAP_ASSESSMENT_ARTIFACT_PATH_V1,
    });
    expect(firstDraft.metadata).toMatchObject({
      id: RESEARCH_REPORT_DRAFT_ARTIFACT_ID_V1,
      path: RESEARCH_REPORT_DRAFT_ARTIFACT_PATH_V1,
    });
    expect(secondDraft.metadata).toMatchObject({
      id: RESEARCH_REPORT_DRAFT_ARTIFACT_ID_V1,
      path: RESEARCH_REPORT_DRAFT_ARTIFACT_PATH_V1,
    });
    expect(JSON.parse(compactDraft.contents)).toMatchObject({
      draft: {
        title: "Compact V2 selection",
        selectedClaimIds: [],
      },
    });
    expect(firstDraft.contents).not.toEqual(secondDraft.contents);
  });
});
