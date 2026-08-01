import { describe, expect, it } from "bun:test";
import { isResearchOneShotEventV1 } from "./events.js";

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
  });

  it("rejects unknown capability and input identifiers", () => {
    expect(isResearchOneShotEventV1(capabilityEvent({
      toolId: "atlassian.raw.fetch",
    }))).toBe(false);
    expect(isResearchOneShotEventV1(capabilityEvent({
      inputKind: "graphql",
    }))).toBe(false);
  });
});
