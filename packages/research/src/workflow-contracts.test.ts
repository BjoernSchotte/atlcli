import { describe, expect, test } from "bun:test";
import {
  RESEARCH_PACKET_BODY_SCHEMA_V1,
  RESEARCH_RECONCILIATION_BODY_SCHEMA_V1,
  RESEARCH_SUBAGENT_ROLE_REGISTRY_V1,
  parseReconciliationBodyV1,
  parseResearchPacketBodyV1,
  validateResearchTaskAdmissionV1,
  type ReconciliationBodyV1,
  type ResearchPacketBodyV1,
} from "./workflow-contracts.js";

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

  test("intersects role admission with exact schema and capability allowlists", () => {
    expect(() => validateResearchTaskAdmissionV1({
      executor: "subagent",
      roleId: "focused-researcher",
      expectedOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V1,
      grantedCapabilityIds: ["jira.issue.search"],
    })).not.toThrow();
    expect(() => validateResearchTaskAdmissionV1({
      executor: "subagent",
      roleId: "reconciler",
      expectedOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V1,
      grantedCapabilityIds: [],
    })).toThrow("output schema");
    expect(() => validateResearchTaskAdmissionV1({
      executor: "subagent",
      roleId: "coverage-moderator",
      expectedOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V1,
      grantedCapabilityIds: ["wiki.page.get"],
    })).toThrow("capability");
  });
});
