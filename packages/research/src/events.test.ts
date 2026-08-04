import { describe, expect, it } from "bun:test";
import {
  formatResearchOneShotEventV1,
  isResearchOneShotEventV1,
} from "./events.js";
import {
  RESEARCH_REPORT_ARTIFACT_PATH_V1,
  type ResearchOneShotEventV1,
} from "./contracts.js";

const capabilityEvent = (overrides: Record<string, unknown> = {}) => ({
  kind: "capability",
  seq: 1,
  at: "2026-08-01T12:00:00.000Z",
  callId: "catalog-1",
  toolId: "jira.project.search",
  inputKind: "search",
  status: "completed",
  itemCount: 2,
  complete: false,
  resultBytes: 256,
  durationMs: 12,
  inputKeys: ["query"],
  queryKeys: [],
  ...overrides,
});

describe("research one-shot events", () => {
  it("pins every event projection to a body-free exact-key contract", () => {
    const at = "2026-08-01T12:00:00.000Z";
    const events = [
      { kind: "phase", seq: 1, at, phase: "planning" },
      { kind: "progress", seq: 2, at, graphRevision: 1, completed: 0, maximum: 2 },
      { kind: "brief", seq: 3, at, revision: 1 },
      {
        kind: "plan",
        seq: 4,
        at,
        briefRevision: 1,
        revision: 1,
        status: "accepted",
        resolvedEffort: "deep",
        selectedRoleIds: ["focused-researcher"],
        nodeCount: 1,
        waveCount: 1,
        maxParallelNodes: 1,
      },
      {
        kind: "task",
        seq: 5,
        at,
        taskId: "task:one",
        status: "planned",
        roleId: "focused-researcher",
      },
      {
        kind: "subagent",
        seq: 6,
        at,
        taskId: "task:one",
        roleId: "focused-researcher",
        status: "started",
      },
      {
        kind: "capability",
        seq: 7,
        at,
        callId: "call:one",
        toolId: "wiki.search",
        inputKind: "search",
        status: "completed",
        itemCount: 1,
      },
      {
        kind: "decision",
        seq: 8,
        at,
        decisionId: "decision:one",
        status: "completed",
        reasonCode: "validated-before-render",
      },
      {
        kind: "reconciliation",
        seq: 9,
        at,
        taskId: "task:critic",
        status: "completed",
        defectCount: 0,
      },
      {
        kind: "reconciliation_disposition",
        seq: 10,
        at,
        dispositionId: "disposition:one",
        defectId: "defect:one",
        decision: "no_change",
        reasonCode: "already_resolved",
        status: "recorded",
      },
      {
        kind: "repair_group",
        seq: 11,
        at,
        followUpId: "follow-up:one",
        status: "retained_without_execution",
        reasonCode: "wave_or_budget_exhausted",
      },
      {
        kind: "retrieval",
        seq: 12,
        at,
        graphRevision: 1,
        action: "stop",
        reason: "evidence_sufficient",
        rankedCandidateCount: 1,
        detailReadCount: 1,
        newDetailSourceCount: 1,
        duplicateDetailReadCount: 0,
        unresolvedCoverageTargetCount: 0,
        unresolvedContradictionCount: 0,
      },
      { kind: "steering", seq: 13, at, revision: 2, status: "applied" },
      {
        kind: "budget",
        seq: 14,
        at,
        metric: "tokens",
        consumed: 10,
        maximum: 100,
      },
      {
        kind: "artifact",
        seq: 15,
        at,
        path: RESEARCH_REPORT_ARTIFACT_PATH_V1,
      },
    ] satisfies ResearchOneShotEventV1[];

    expect(events).toHaveLength(15);
    for (const event of events) {
      expect(isResearchOneShotEventV1(event), event.kind).toBe(true);
      expect(
        isResearchOneShotEventV1({ ...event, sourceBody: "private body" }),
        event.kind,
      ).toBe(false);
      expect(
        isResearchOneShotEventV1({ ...event, credential: "private key" }),
        event.kind,
      ).toBe(false);
      expect(
        isResearchOneShotEventV1({ ...event, reasoning: "hidden reasoning" }),
        event.kind,
      ).toBe(false);
      const formatted = formatResearchOneShotEventV1(event);
      expect(formatted).not.toContain("private body");
      expect(formatted).not.toContain("private key");
      expect(formatted).not.toContain("hidden reasoning");
    }
  });

  it("admits body-free scope catalog capability events", () => {
    expect(isResearchOneShotEventV1(capabilityEvent())).toBe(true);
    expect(isResearchOneShotEventV1(capabilityEvent({
      toolId: "wiki.space.search",
      inputKind: "continuation",
      queryKeys: ["cursor"],
    }))).toBe(true);
    expect(isResearchOneShotEventV1(capabilityEvent({
      toolId: "atlassian.reference.resolve",
      inputKind: "reference",
      itemCount: undefined,
      complete: undefined,
    }))).toBe(true);
    expect(isResearchOneShotEventV1(capabilityEvent({
      toolId: "research.candidate.rank",
      inputKind: "ranking",
      itemCount: 2,
      itemLabels: ["DEMO-1: Bounded issue", "Confluence 1001: Design"],
      complete: undefined,
    }))).toBe(true);
    expect(isResearchOneShotEventV1(capabilityEvent({
      itemLabels: ["x".repeat(241)],
    }))).toBe(false);
  });

  it("rejects unknown capability and input identifiers", () => {
    expect(isResearchOneShotEventV1(capabilityEvent({
      toolId: "atlassian.raw.fetch",
    }))).toBe(false);
    expect(isResearchOneShotEventV1(capabilityEvent({
      inputKind: "graphql",
    }))).toBe(false);
  });

  it("admits and formats body-free deterministic retrieval assessments", () => {
    const event = {
      kind: "retrieval" as const,
      seq: 4,
      at: "2026-08-02T12:00:00.000Z",
      graphRevision: 2,
      action: "stop" as const,
      reason: "detail_budget_exhausted",
      rankedCandidateCount: 12,
      detailReadCount: 8,
      newDetailSourceCount: 8,
      duplicateDetailReadCount: 0,
      unresolvedCoverageTargetCount: 2,
      unresolvedContradictionCount: 0,
    };
    expect(isResearchOneShotEventV1(event)).toBe(true);
    expect(formatResearchOneShotEventV1(event)).toBe(
      "retrieval · graph 2 · stop · detail budget exhausted · 12 ranked · 8 detail reads · 8 new · 2 coverage gaps",
    );
    expect(isResearchOneShotEventV1({ ...event, sourceId: "private:source" })).toBe(false);
    expect(isResearchOneShotEventV1({ ...event, reason: "private source title" })).toBe(false);
  });

  it("streams only a body-free steering completion", () => {
    const event = {
      kind: "steering" as const,
      seq: 5,
      at: "2026-08-02T12:00:00.000Z",
      revision: 3,
      status: "applied",
    };
    expect(isResearchOneShotEventV1(event)).toBe(true);
    expect(formatResearchOneShotEventV1(event)).toBe("steering · graph 3 · applied");
    expect(isResearchOneShotEventV1({ ...event, instruction: "private user text" })).toBe(false);
  });
});
