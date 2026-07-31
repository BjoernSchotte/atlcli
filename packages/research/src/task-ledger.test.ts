import { describe, expect, test } from "bun:test";
import {
  InMemoryResearchSubagentDispatchPort,
  reduceResearchTaskAttemptV1,
} from "./task-ledger.js";
import {
  RESEARCH_PACKET_BODY_SCHEMA_V1,
  RESEARCH_TASK_ATTEMPT_SCHEMA_V1,
  type ResearchPacketBodyV1,
  type ResearchTaskAttemptV1,
  type ResearchTaskUsageV1,
} from "./workflow-contracts.js";

const usage: ResearchTaskUsageV1 = {
  capabilityCalls: 2,
  inputTokens: 100,
  outputTokens: 50,
  resultBytes: 4_096,
  durationMs: 25,
  costMicros: 100,
};

function attempt(overrides: Partial<ResearchTaskAttemptV1> = {}): ResearchTaskAttemptV1 {
  return {
    schema: RESEARCH_TASK_ATTEMPT_SCHEMA_V1,
    taskId: "task:1",
    nodeId: "node:1",
    graphRevision: 3,
    attempt: 1,
    executor: "subagent",
    roleId: "focused-researcher",
    grantedCapabilityIds: ["jira.issue.search"],
    typedIntentRefs: ["intent:1"],
    expectedOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V1,
    status: "ready",
    dispatchState: "not_started",
    createdAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

function packet(sourceId = "jira:DEMO-1"): ResearchPacketBodyV1 {
  return {
    schema: RESEARCH_PACKET_BODY_SCHEMA_V1,
    answeredQuestion: "One bounded answer.",
    sourceIds: [sourceId],
    findingCandidates: [{
      id: "finding:1",
      classification: "fact",
      summary: "One supported fact.",
      sourceIds: [sourceId],
    }],
    relationshipCandidates: [],
    gaps: [],
    proposedFollowUps: [],
    coverageLimits: [],
  };
}

describe("revision-fenced T3 task ledger", () => {
  test("constructs accepted envelopes from host-owned attempt metadata", () => {
    const ledger = new InMemoryResearchSubagentDispatchPort({ maxResultBytes: 8_192 });
    ledger.admit(attempt());
    ledger.start("task:1", 3, "2026-07-31T00:00:01.000Z");
    const accepted = ledger.accept({
      taskId: "task:1",
      graphRevision: 3,
      body: packet(),
      usage,
      acceptedAt: "2026-07-31T00:00:02.000Z",
      availableSourceIds: ["jira:DEMO-1"],
    });
    expect(accepted).toMatchObject({
      packetRef: "packet:task:1:1",
      taskId: "task:1",
      graphRevision: 3,
      attempt: 1,
      roleId: "focused-researcher",
      grantedCapabilityIds: ["jira.issue.search"],
      typedIntentRefs: ["intent:1"],
      hostObservedUsage: usage,
    });
    expect(ledger.attempt("task:1")?.status).toBe("complete");
  });

  test("rejects stale revisions, duplicate dispatch, and late results", () => {
    const ledger = new InMemoryResearchSubagentDispatchPort({ maxResultBytes: 8_192 });
    ledger.admit(attempt());
    expect(() => ledger.start("task:1", 2, "2026-07-31T00:00:01.000Z")).toThrow("stale");
    ledger.start("task:1", 3, "2026-07-31T00:00:01.000Z");
    expect(() => ledger.start("task:1", 3, "2026-07-31T00:00:01.500Z")).toThrow("only once");
    ledger.quarantine("task:1", 3, "2026-07-31T00:00:02.000Z");
    expect(() => ledger.accept({
      taskId: "task:1",
      graphRevision: 3,
      body: packet(),
      usage,
      acceptedAt: "2026-07-31T00:00:03.000Z",
      availableSourceIds: ["jira:DEMO-1"],
    })).toThrow("outside its active dispatch");
  });

  test("rejects unknown evidence, oversized packets, and two accepted attempts for one node", () => {
    const unknown = new InMemoryResearchSubagentDispatchPort({ maxResultBytes: 8_192 });
    unknown.admit(attempt());
    unknown.start("task:1", 3, "2026-07-31T00:00:01.000Z");
    expect(() => unknown.accept({
      taskId: "task:1",
      graphRevision: 3,
      body: packet("jira:UNKNOWN-1"),
      usage,
      acceptedAt: "2026-07-31T00:00:02.000Z",
      availableSourceIds: ["jira:DEMO-1"],
    })).toThrow("unknown evidence");

    const oversized = new InMemoryResearchSubagentDispatchPort({ maxResultBytes: 32 });
    oversized.admit(attempt());
    oversized.start("task:1", 3, "2026-07-31T00:00:01.000Z");
    expect(() => oversized.accept({
      taskId: "task:1",
      graphRevision: 3,
      body: packet(),
      usage,
      acceptedAt: "2026-07-31T00:00:02.000Z",
      availableSourceIds: ["jira:DEMO-1"],
    })).toThrow("byte envelope");

    const duplicate = new InMemoryResearchSubagentDispatchPort({ maxResultBytes: 8_192 });
    duplicate.admit(attempt());
    duplicate.start("task:1", 3, "2026-07-31T00:00:01.000Z");
    duplicate.accept({ taskId: "task:1", graphRevision: 3, body: packet(), usage, acceptedAt: "2026-07-31T00:00:02.000Z", availableSourceIds: ["jira:DEMO-1"] });
    duplicate.admit(attempt({ taskId: "task:2", attempt: 2 }));
    duplicate.start("task:2", 3, "2026-07-31T00:00:03.000Z");
    expect(() => duplicate.accept({ taskId: "task:2", graphRevision: 3, body: packet(), usage, acceptedAt: "2026-07-31T00:00:04.000Z", availableSourceIds: ["jira:DEMO-1"] })).toThrow("already accepted");
  });

  test("keeps the pure reducer closed over legal lifecycle transitions", () => {
    const running = reduceResearchTaskAttemptV1(attempt(), {
      kind: "dispatch_started",
      at: "2026-07-31T00:00:01.000Z",
    });
    const unknown = reduceResearchTaskAttemptV1(running, {
      kind: "outcome_unknown",
      at: "2026-07-31T00:00:02.000Z",
    });
    expect(unknown).toMatchObject({ status: "outcome_unknown", dispatchState: "outcome_unknown" });
    expect(() => reduceResearchTaskAttemptV1(unknown, {
      kind: "result_committed",
      at: "2026-07-31T00:00:03.000Z",
      packetRef: "packet:late",
      usage,
    })).toThrow("Only a running task");
  });
});
