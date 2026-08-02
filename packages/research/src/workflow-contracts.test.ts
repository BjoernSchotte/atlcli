import { describe, expect, test } from "bun:test";
import {
  RESEARCH_PACKET_BODY_SCHEMA_V1,
  RESEARCH_PACKET_BODY_SCHEMA_V2,
  RESEARCH_ACCEPTED_PACKET_SCHEMA_V1,
  RESEARCH_RECONCILIATION_BODY_SCHEMA_V1,
  RESEARCH_RECONCILIATION_DISPOSITION_SCHEMA_V1,
  RESEARCH_RECONCILIATION_INPUT_SCHEMA_V1,
  RESEARCH_SUBAGENT_ROLE_REGISTRY_V1,
  parseReconciliationBodyV1,
  parseResearchReconciliationInputV1,
  parseResearchReconciliationDispositionV1,
  parseResearchPacketBodyV1,
  parseResearchPacketBodyV2,
  parseResearchPacketModelBodyV2,
  parseResearchTaskBodyV1,
  validateResearchReconciliationBodyNamespaceV1,
  projectResearchReconciliationInputV1,
  validateResearchTaskAdmissionV1,
  type ResearchAcceptedPacketV1,
  type ReconciliationBodyV1,
  type ResearchPacketBodyV1,
  type ResearchPacketBodyV2,
  type ResearchPacketModelBodyV2,
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
  body: ResearchPacketBodyV1 | ResearchPacketBodyV2,
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
    expectedOutputSchema: body.schema,
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

  test("keeps model quotes ephemeral and accepts only a normalized V2 packet for durable task reduction", () => {
    const modelBody: ResearchPacketModelBodyV2 = {
      schema: RESEARCH_PACKET_BODY_SCHEMA_V2,
      claimCandidates: [{
        id: "candidate:one",
        classification: "fact",
        summary: "The detail contains one explicit implementation reference.",
        support: [{ sourceId: "jira:DEMO-1", quote: "explicit implementation reference" }],
      }],
      contradictionCandidates: [],
      outlineProposals: [],
      gaps: [],
      proposedFollowUps: [],
      coverageLimits: [],
    };
    expect(parseResearchPacketModelBodyV2(modelBody)).toEqual(modelBody);
    expect(parseResearchPacketModelBodyV2({
      ...modelBody,
      coverageLimits: ["a".repeat(600)],
    }).coverageLimits).toEqual(["a".repeat(600)]);
    expect(() => parseResearchPacketModelBodyV2({
      ...modelBody,
      coverageLimits: ["a".repeat(601)],
    })).toThrow("Research V2 coverage limits[0]");
    const canonical = {
      schema: RESEARCH_PACKET_BODY_SCHEMA_V2,
      claims: [{ candidateId: "candidate:one", claimId: `claim:${"a".repeat(48)}` }],
      referencedClaimIds: [],
      contradictions: [],
      outlineProposals: [],
      gaps: [],
      proposedFollowUps: [],
      coverageLimits: [],
    };
    expect(parseResearchPacketBodyV2(canonical)).toEqual(canonical);
    expect(parseResearchTaskBodyV1(RESEARCH_PACKET_BODY_SCHEMA_V2, canonical)).toEqual(canonical);
    expect(() => parseResearchPacketBodyV2(modelBody)).toThrow("packet body");
    expect(() => parseResearchPacketModelBodyV2({
      ...modelBody,
      claimCandidates: [{ ...modelBody.claimCandidates[0], support: [{ sourceId: "jira:DEMO-1", quote: "x".repeat(641) }] }],
    })).toThrow("quote");
    expect(() => parseResearchPacketModelBodyV2({
      ...modelBody,
      claimCandidates: Array.from({ length: 9 }, (_, index) => ({
        ...modelBody.claimCandidates[0],
        id: `candidate:${index}`,
      })),
    })).toThrow("packet body");
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

  test("rejects critic references and coverage targets outside its host namespace before disposition", () => {
    const input = parseResearchReconciliationInputV1({
      schema: RESEARCH_RECONCILIATION_INPUT_SCHEMA_V1,
      briefRevision: 2,
      graphRevision: 3,
      acceptedPacketRefs: ["packet:detail:1"],
      coverageTargetIds: ["coverage:question"],
      projection: {
        kind: "v2-claim-set",
        claimIds: ["claim:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
        evidenceIds: ["evidence:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
        gapIds: ["gap:known"],
      },
    });
    const valid = parseReconciliationBodyV1({
      schema: RESEARCH_RECONCILIATION_BODY_SCHEMA_V1,
      defects: [{
        id: "defect:coverage",
        severity: "important",
        target: { kind: "coverage", id: "coverage:question" },
        code: "missing_coverage",
        references: [{ kind: "evidence", id: "evidence:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }],
        explanation: "The approved coverage target has one unresolved gap.",
        suggestedAction: "add_follow_up",
      }],
      proposedFollowUps: [],
    });

    expect(validateResearchReconciliationBodyNamespaceV1(valid, input)).toEqual(valid);
    expect(() => validateResearchReconciliationBodyNamespaceV1({
      ...valid,
      defects: [{ ...valid.defects[0]!, target: { kind: "coverage", id: "coverage:invented" } }],
    }, input)).toThrow("outside the host namespace");
    expect(() => validateResearchReconciliationBodyNamespaceV1({
      ...valid,
      defects: [{
        ...valid.defects[0]!,
        references: [{ kind: "evidence", id: "evidence:cccccccccccccccccccccccccccccccccccccccccccccccc" }],
      }],
    }, input)).toThrow("outside the host namespace");
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

  test("projects V2 claims and evidence without exposing model quotes or source text", () => {
    const claimId = "claim:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const evidenceId = "evidence:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const detailPacket = acceptedPacket("task:detail", "packet:detail:1", {
      schema: RESEARCH_PACKET_BODY_SCHEMA_V2,
      claims: [{
        claimId,
        candidateId: "candidate:detail:1",
      }],
      referencedClaimIds: [],
      contradictions: [],
      outlineProposals: [{
        id: "outline:v2:1",
        sectionId: "section:v2:1",
        title: "Verified detail",
        question: "What does the verified detail establish?",
        claimIds: [claimId],
        evidenceIds: [evidenceId],
        dependsOnSectionIds: [],
        coverageTargetIds: [],
      }],
      gaps: [],
      proposedFollowUps: [],
      coverageLimits: [],
    });
    const analysisPacket = acceptedPacket("task:analysis", "packet:analysis:1", {
      schema: RESEARCH_PACKET_BODY_SCHEMA_V2,
      claims: [],
      referencedClaimIds: [claimId],
      contradictions: [],
      outlineProposals: [],
      gaps: [{ id: "gap:v2:1", summary: "The linked evidence was not exhaustive.", sourceIds: [] }],
      proposedFollowUps: [],
      coverageLimits: ["One bounded limitation remains."],
    });

    expect(projectResearchReconciliationInputV1({
      briefRevision: 2,
      graphRevision: 3,
      coverageTargetIds: ["coverage:question"],
      acceptedPackets: [detailPacket, analysisPacket],
    })).toEqual({
      schema: RESEARCH_RECONCILIATION_INPUT_SCHEMA_V1,
      briefRevision: 2,
      graphRevision: 3,
      acceptedPacketRefs: ["packet:detail:1", "packet:analysis:1"],
      coverageTargetIds: ["coverage:question"],
      projection: {
        kind: "v2-claim-set",
        claimIds: [claimId],
        evidenceIds: [evidenceId],
        gapIds: ["gap:v2:1"],
      },
    });

    const repeatedLocalGap = acceptedPacket("task:analysis:2", "packet:analysis:2", {
      ...(analysisPacket.body as ResearchPacketBodyV2),
      gaps: [{
        id: "gap:v2:1",
        summary: "A second packet records a distinct boundary using the same local label.",
        sourceIds: [],
      }],
    });
    expect(projectResearchReconciliationInputV1({
      briefRevision: 2,
      graphRevision: 3,
      coverageTargetIds: ["coverage:question"],
      acceptedPackets: [detailPacket, analysisPacket, repeatedLocalGap],
    }).projection).toMatchObject({
      kind: "v2-claim-set",
      gapIds: ["gap:v2:1"],
    });

    expect(() => projectResearchReconciliationInputV1({
      briefRevision: 2,
      graphRevision: 3,
      coverageTargetIds: ["coverage:question"],
      acceptedPackets: [acceptedPacket("task:v1", "packet:v1:1", packet()), detailPacket],
    })).toThrow("cannot mix V1 and V2");
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
