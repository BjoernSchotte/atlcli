import { describe, expect, it } from "bun:test";
import {
  formatResearchOneShotEventV1,
  isResearchOneShotEventV1,
} from "./events.js";

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
