import { describe, expect, test } from "bun:test";
import {
  briefRequiresClarificationV1,
  createResearchBriefV1,
  prepareResearchBriefPreflightV1,
  projectResearchProposedAssumptionLimitationsV1,
  researchPolicyFromBriefV1,
  researchRequestFromBriefV1,
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

  test("returns a typed one-shot clarification before graph composition", () => {
    const brief = create({
      revision: 4,
      clarificationQuestions: [{
        id: "clarification:scope",
        prompt: "Which project should be used?",
        required: true,
      }, {
        id: "clarification:optional",
        prompt: "Which audience should receive the report?",
        required: false,
      }],
      assumptions: [{
        id: "assumption:time-window",
        text: "Use the last seven days.",
        requiresUserDecision: true,
        status: "proposed",
      }, {
        id: "assumption:format",
        text: "Use Markdown.",
        requiresUserDecision: false,
        status: "proposed",
      }],
    });
    expect(prepareResearchBriefPreflightV1(brief)).toEqual({
      schema: "atlcli.research-brief-preflight-outcome/v1",
      kind: "clarification_required",
      brief,
      clarification: {
        schema: "atlcli.research-clarification-required/v1",
        sessionId: "research-session:test",
        turnId: "research-turn:test",
        briefRevision: 4,
        questions: [{
          id: "clarification:scope",
          prompt: "Which project should be used?",
          required: true,
        }],
        assumptionsRequiringDecision: [{
          id: "assumption:time-window",
          text: "Use the last seven days.",
          requiresUserDecision: true,
          status: "proposed",
        }],
      },
    });
    const ready = prepareResearchBriefPreflightV1(create());
    expect(ready).toMatchObject({
      schema: "atlcli.research-brief-preflight-outcome/v1",
      kind: "ready",
      brief: { schema: "atlcli.research-brief/v1" },
    });
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

  test("projects non-blocking proposed assumptions as explicitly unconfirmed report limits", () => {
    const brief = create({
      revision: 2,
      assumptions: [
        {
          id: "assumption:audience",
          text: "The report is intended for the delivery team.",
          requiresUserDecision: false,
          status: "proposed",
        },
        {
          id: "assumption:accepted",
          text: "This was explicitly confirmed.",
          requiresUserDecision: false,
          status: "accepted",
        },
      ],
    });

    expect(projectResearchProposedAssumptionLimitationsV1(brief)).toEqual([
      "Proposed assumption (not user-confirmed): The report is intended for the delivery team.",
    ]);
  });

  test("reconstructs resume inputs only from the accepted durable brief", () => {
    const brief = create({
      requestedEffort: "deep",
      requestedPlanApproval: "automatic",
      requestedReconciliation: "required",
      scopeDiscoveryPolicy: {
        schema: "atlcli.research-scope-discovery-policy/v1",
        catalogDiscovery: "on",
        expansionMode: "exact-linked",
        maxCatalogPagesPerCapability: 3,
        maxCandidatesPerMention: 4,
        maxCatalogResultBytes: 10_000,
        maxExactLinkedEntities: 2,
        maxScopeExpansionProposals: 2,
      },
    });
    const request = researchRequestFromBriefV1(brief);
    const policy = researchPolicyFromBriefV1(brief);

    expect(request).toEqual({
      schema: "atlcli.research-request/v1",
      question: brief.objective,
      scope: brief.scope,
      limits: brief.limits,
      wikiProvider: "rest",
    });
    expect(policy).toEqual({
      schema: "atlcli.research-one-shot-policy/v1",
      requestedEffort: "deep",
      requestedPlanApproval: "automatic",
      scopeExpansionMode: "exact-linked",
      requestedReconciliation: "required",
    });
    request.scope.jiraProjectKeys.push("MUTATED");
    request.limits.maxPtcCalls = 99;
    expect(brief.scope.jiraProjectKeys).toEqual(["DEMO"]);
    expect(brief.limits.maxPtcCalls).not.toBe(99);
  });
});
