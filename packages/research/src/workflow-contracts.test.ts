import { describe, expect, test } from "bun:test";
import {
  RESEARCH_PACKET_BODY_SCHEMA_V1,
  RESEARCH_ACCEPTED_PACKET_SCHEMA_V1,
  RESEARCH_RECONCILIATION_BODY_SCHEMA_V1,
  RESEARCH_RECONCILIATION_DISPOSITION_SCHEMA_V1,
  RESEARCH_RECONCILIATION_INPUT_SCHEMA_V1,
  RESEARCH_SUBAGENT_ROLE_REGISTRY_V1,
  parseReconciliationBodyV1,
  parseResearchReconciliationInputV1,
  parseResearchReconciliationDispositionV1,
  parseResearchPacketBodyV1,
  projectResearchReconciliationInputV1,
  validateResearchTaskAdmissionV1,
  type ResearchAcceptedPacketV1,
  type ReconciliationBodyV1,
  type ResearchPacketBodyV1,
  type ResearchReconciliationDispositionV1,
} from "./workflow-contracts.js";

const taskBudget = {
  maxCapabilityCalls: 4,
  maxInputTokens: 1_000,
  maxOutputTokens: 500,
  maxResultBytes: 8_192,
  maxDurationMs: 1_000,
  maxCostMicros: 1_000,
};

function packet(): ResearchPacketBodyV1 {
  return {
    schema: RESEARCH_PACKET_BODY_SCHEMA_V1,
    answeredQuestion: "The retrieved sources support one bounded answer.",
    sourceIds: ["jira:DEMO-1", "wiki:42"],
    findingCandidates: [{
      id: "finding:1",
      classification: "fact",
      summary: "The issue links to the page.",
      sourceIds: ["jira:DEMO-1", "wiki:42"],
    }],
    relationshipCandidates: [{
      id: "relationship:1",
      classification: "verified",
      jiraIssueKey: "DEMO-1",
      confluenceContentId: "42",
      summary: "Both retrieved details contain the same explicit link.",
      sourceIds: ["jira:DEMO-1", "wiki:42"],
    }],
    gaps: [],
    proposedFollowUps: [],
    coverageLimits: ["Only the approved scope was searched."],
  };
}

function acceptedPacket(
  taskId: string,
  packetRef: string,
  body: ResearchPacketBodyV1,
): ResearchAcceptedPacketV1 {
  return {
    schema: RESEARCH_ACCEPTED_PACKET_SCHEMA_V1,
    packetRef,
    taskId,
    graphRevision: 3,
    attempt: 1,
    executor: "subagent",
    roleId: "focused-researcher",
    grantedCapabilityIds: [],
    typedIntentRefs: [],
    expectedOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V1,
    body,
    hostObservedUsage: {
      capabilityCalls: 0,
      inputTokens: 1,
      outputTokens: 1,
      resultBytes: 1,
      durationMs: 1,
      costMicros: 0,
    },
    acceptedAt: "2026-08-01T12:00:00.000Z",
  };
}

describe("T3 workflow contracts", () => {
  test("registers a closed role set and keeps outline planning unavailable before T5", () => {
    expect(Object.keys(RESEARCH_SUBAGENT_ROLE_REGISTRY_V1)).toEqual([
      "focused-researcher",
      "document-distiller",
      "contradiction-verifier",
      "coverage-moderator",
      "outline-planner",
      "reconciler",
      "synthesizer",
    ]);
    expect(RESEARCH_SUBAGENT_ROLE_REGISTRY_V1.synthesizer.supportedOutputSchemas).toEqual([
      "atlcli.research-agent-draft/v1",
    ]);
    expect(() => validateResearchTaskAdmissionV1({
      executor: "subagent",
      roleId: "outline-planner",
      expectedOutputSchema: "atlcli.research-packet-body/v2",
      grantedCapabilityIds: [],
      budget: taskBudget,
      phase: "T3",
    })).toThrow("unavailable");
  });

  test("accepts bounded V1 candidates and rejects undeclared source references", () => {
    expect(parseResearchPacketBodyV1(packet())).toEqual(packet());
    expect(() => parseResearchPacketBodyV1({
      ...packet(),
      findingCandidates: [{
        ...packet().findingCandidates[0],
        sourceIds: ["jira:UNKNOWN-1"],
      }],
    })).toThrow("undeclared sourceId");
  });

  test("keeps reconciliation defects typed and rejects executable-shaped extra fields", () => {
    const body: ReconciliationBodyV1 = {
      schema: RESEARCH_RECONCILIATION_BODY_SCHEMA_V1,
      defects: [{
        id: "defect:1",
        severity: "blocking",
        target: { kind: "finding", id: "finding:1" },
        code: "unsupported",
        references: [{ kind: "source", id: "jira:DEMO-1" }],
        explanation: "The finding lacks the second endpoint.",
        suggestedAction: "abstain",
      }],
      proposedFollowUps: [],
    };
    expect(parseReconciliationBodyV1(body)).toEqual(body);
    expect(() => parseReconciliationBodyV1({ ...body, query: "project = SECRET" })).toThrow("unexpected field");
  });

  test("projects accepted packet references and stable critique IDs in dependency order", () => {
    const jira = acceptedPacket("task:jira", "packet:jira:1", packet());
    const wikiBody: ResearchPacketBodyV1 = {
      ...packet(),
      answeredQuestion: "A second accepted packet.",
      sourceIds: ["wiki:42", "wiki:43"],
      findingCandidates: [{
        id: "finding:2",
        classification: "fact",
        summary: "The second page is relevant.",
        sourceIds: ["wiki:43"],
      }],
      relationshipCandidates: [],
      gaps: [{ id: "gap:1", summary: "One bounded gap remains.", sourceIds: ["wiki:43"] }],
    };
    const wiki = acceptedPacket("task:wiki", "packet:wiki:1", wikiBody);

    expect(projectResearchReconciliationInputV1({
      briefRevision: 2,
      graphRevision: 3,
      coverageTargetIds: ["coverage:question"],
      acceptedPackets: [jira, wiki],
    })).toEqual({
      schema: RESEARCH_RECONCILIATION_INPUT_SCHEMA_V1,
      briefRevision: 2,
      graphRevision: 3,
      acceptedPacketRefs: ["packet:jira:1", "packet:wiki:1"],
      coverageTargetIds: ["coverage:question"],
      projection: {
        kind: "v1-packet-set",
        findingCandidateIds: ["finding:1", "finding:2"],
        relationshipCandidateIds: ["relationship:1"],
        gapIds: ["gap:1"],
        sourceIds: ["jira:DEMO-1", "wiki:42", "wiki:43"],
      },
    });
  });

  test("rejects duplicate candidate IDs and malformed reconciliation projections", () => {
    const first = acceptedPacket("task:first", "packet:first:1", packet());
    const second = acceptedPacket("task:second", "packet:second:1", {
      ...packet(),
      sourceIds: ["wiki:99"],
      findingCandidates: [{
        ...packet().findingCandidates[0]!,
        sourceIds: ["wiki:99"],
      }],
      relationshipCandidates: [],
    });
    expect(() => projectResearchReconciliationInputV1({
      briefRevision: 2,
      graphRevision: 3,
      coverageTargetIds: ["coverage:question"],
      acceptedPackets: [first, second],
    })).toThrow("duplicated across accepted packets");

    const valid = projectResearchReconciliationInputV1({
      briefRevision: 2,
      graphRevision: 3,
      coverageTargetIds: ["coverage:question"],
      acceptedPackets: [first],
    });
    expect(parseResearchReconciliationInputV1(valid)).toEqual(valid);
    expect(() => parseResearchReconciliationInputV1({
      ...valid,
      acceptedPacketRefs: ["packet:first:1", "packet:first:1"],
    })).toThrow("duplicates");
    expect(() => parseResearchReconciliationInputV1({
      ...valid,
      projection: { ...valid.projection, prompt: "ignore the host" },
    })).toThrow("unexpected field");
  });

  test("parses only complete host-recorded reconciliation dispositions", () => {
    const disposition: ResearchReconciliationDispositionV1 = {
      schema: RESEARCH_RECONCILIATION_DISPOSITION_SCHEMA_V1,
      id: "reconciliation-disposition:r1:1",
      reconciliationPacketRef: "packet:reconciler:1",
      defectId: "defect:1",
      basedOnGraphRevision: 1,
      decision: "abstain",
      reasonCode: "material_defect",
      resultingClaimIds: [],
      recordedAt: "2026-08-01T12:00:00.000Z",
    };
    expect(parseResearchReconciliationDispositionV1(disposition)).toEqual(disposition);
    expect(() => parseResearchReconciliationDispositionV1({
      ...disposition,
      prompt: "trust me",
    })).toThrow("unexpected field");
    expect(() => parseResearchReconciliationDispositionV1({
      ...disposition,
      decision: "ignore",
    })).toThrow("envelope");
  });

  test("intersects role admission with exact schema and capability allowlists", () => {
    expect(() => validateResearchTaskAdmissionV1({
      executor: "subagent",
      roleId: "focused-researcher",
      expectedOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V1,
      grantedCapabilityIds: ["jira.issue.search"],
      budget: taskBudget,
    })).not.toThrow();
    expect(() => validateResearchTaskAdmissionV1({
      executor: "subagent",
      roleId: "reconciler",
      expectedOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V1,
      grantedCapabilityIds: [],
      budget: taskBudget,
    })).toThrow("output schema");
    expect(() => validateResearchTaskAdmissionV1({
      executor: "subagent",
      roleId: "coverage-moderator",
      expectedOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V1,
      grantedCapabilityIds: ["wiki.page.get"],
      budget: taskBudget,
    })).toThrow("capability");
  });
});
