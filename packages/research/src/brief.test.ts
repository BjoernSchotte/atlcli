import { describe, expect, test } from "bun:test";
import {
  briefRequiresClarificationV1,
  createResearchBriefV1,
  resolveResearchEffortV1,
  resolveResearchPlanApprovalV1,
} from "./brief.js";

const scope = {
  siteOrigin: "https://example.atlassian.net",
  jiraProjectKeys: ["DEMO"],
  confluenceSpaceKeys: ["DOCS"],
};

function create(overrides: Partial<Parameters<typeof createResearchBriefV1>[0]> = {}) {
  return createResearchBriefV1({
    sessionId: "research-session:test",
    turnId: "research-turn:test",
    objective: "Which documentation relates to recent Jira work?",
    scope,
    asOf: "2026-07-31T00:00:00.000Z",
    timezone: "Europe/Berlin",
    ...overrides,
  });
}

describe("host-owned research brief", () => {
  test("resolves cross-product auto effort without losing the default approval intent", () => {
    expect(create()).toMatchObject({
      schema: "atlcli.research-brief/v1",
      revision: 1,
      requestedEffort: "auto",
      resolvedEffort: "analysis",
      requestedPlanApproval: "default",
      resolvedPlanApproval: "automatic",
      requestedReconciliation: "auto",
      sourceClasses: ["jira", "confluence"],
      coverageTargets: [{ id: "coverage:primary-question", required: true, minimumDistinctSources: 2 }],
    });
  });

  test("requires approval when auto resolves deep but preserves explicit automatic approval", () => {
    expect(resolveResearchEffortV1({
      requested: "auto",
      objective: "Perform exhaustive contradiction analysis.",
      sourceClasses: ["jira", "confluence"],
    })).toBe("deep");
    expect(resolveResearchPlanApprovalV1({ requested: "default", resolvedEffort: "deep" })).toBe("required");
    expect(resolveResearchPlanApprovalV1({ requested: "automatic", resolvedEffort: "deep" })).toBe("automatic");
    expect(create({
      objective: "Perform exhaustive contradiction analysis.",
      requestedPlanApproval: "automatic",
    })).toMatchObject({
      resolvedEffort: "deep",
      requestedPlanApproval: "automatic",
      resolvedPlanApproval: "automatic",
    });
  });

  test("stops on required questions or undecided required assumptions", () => {
    expect(briefRequiresClarificationV1(create({
      clarificationQuestions: [{
        id: "clarification:scope",
        prompt: "Which project should be used?",
        required: true,
      }],
    }))).toBe(true);
    expect(briefRequiresClarificationV1(create({
      assumptions: [{
        id: "assumption:time-window",
        text: "Use the last seven days.",
        requiresUserDecision: true,
        status: "proposed",
      }],
    }))).toBe(true);
    expect(briefRequiresClarificationV1(create({
      assumptions: [{
        id: "assumption:audience",
        text: "Write for the delivery team.",
        requiresUserDecision: false,
        status: "proposed",
      }],
    }))).toBe(false);
  });

  test("rejects silently accepted new assumptions and invalid time context", () => {
    expect(() => create({
      assumptions: [{
        id: "assumption:hidden",
        text: "Silently accept this.",
        requiresUserDecision: true,
        status: "accepted",
      }],
    })).toThrow("silently accept");
    expect(() => create({ asOf: "2026-07-31" })).toThrow("ISO timestamp");
    expect(() => create({ timezone: "Mars/Olympus" })).toThrow("timezone");
  });
});
