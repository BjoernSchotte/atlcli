import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import React from "react";
import {
  ResearchBriefClarificationNotice,
  ResearchScreen,
  inferResearchScope,
} from "../components/screens/ResearchScreen.js";
import { I18nProvider } from "../utils/i18n/context.js";
import type {
  ResearchBriefClarificationRequiredV1,
  ResearchSessionClarificationReviewV1,
  ResearchSessionScopeClarificationReviewV1,
  ResearchSessionPlanReviewV1,
  ResearchSessionScopeReviewV1,
} from "@atlcli/research";
import { createResearchKeyScopeSeedV1 } from "@atlcli/research/scope-discovery";
import { ResearchContractError } from "../utils/research/contracts.js";
import type {
  ResearchPort,
  ResearchReportV1,
  ResearchReportV2,
  ResearchRequestV1,
} from "../utils/research/contracts.js";
import type { ScreenProps } from "../utils/screens/registry.js";
import type { AppPorts } from "../utils/ports/index.js";
import { createReactHarness } from "./react-harness.js";

const dom = createReactHarness();

beforeEach(() => dom.setup());
afterEach(() => dom.teardown());
afterAll(() => {
  expect(dom.leakedGlobals()).toEqual([]);
});

const report: ResearchReportV1 = {
  schema: "atlcli.research-report/v1",
  title: "Guarded research",
  question: "How are DEMO-1 and KB related?",
  scope: {
    siteOrigin: "https://example.atlassian.net",
    jiraProjectKeys: ["DEMO"],
    confluenceSpaceKeys: ["KB"],
  },
  executiveSummary: "The page explicitly links the issue.",
  findings: [
    {
      id: "finding-1",
      classification: "fact",
      summary: "The design is documented.",
      sourceIds: ["wiki:1001"],
    },
  ],
  relationships: [
    {
      id: "relationship-1",
      classification: "verified",
      jiraIssueKey: "DEMO-1",
      confluenceContentId: "1001",
      summary: "Exact link.",
      sourceIds: ["jira:DEMO-1", "wiki:1001"],
    },
  ],
  limitations: ["Synthetic result."],
  sources: [
    {
      id: "jira:DEMO-1",
      product: "jira",
      title: "Issue",
      url: "https://example.atlassian.net/browse/DEMO-1",
      issueKey: "DEMO-1",
      projectKey: "DEMO",
    },
    {
      id: "wiki:1001",
      product: "confluence",
      title: "Design",
      url: "https://example.atlassian.net/wiki/spaces/KB/pages/1001",
      contentId: "1001",
      spaceKey: "KB",
    },
  ],
  run: {
    model: "claude-sonnet-4-6",
    wikiProvider: "rest",
    startedAt: "2026-07-30T10:00:00.000Z",
    completedAt: "2026-07-30T10:00:01.000Z",
    durationMs: 1_000,
    complete: true,
    counts: { ptcCalls: 8, httpCalls: 8, jiraItems: 2, confluenceItems: 2 },
    usage: { inputTokens: 100, outputTokens: 50 },
    warnings: [],
  },
  markdown: "# Guarded research\n\nSafe Markdown.",
};

const v2Report: ResearchReportV2 = {
  schema: "atlcli.research-report/v2",
  title: "Evidence-backed research",
  question: "What does the validated Jira issue establish?",
  scope: {
    siteOrigin: "https://example.atlassian.net",
    jiraProjectKeys: ["DEMO"],
    confluenceSpaceKeys: [],
  },
  executiveSummaryClaimIds: ["claim:validated"],
  claims: [{
    id: "claim:validated",
    classification: "fact",
    statement: "The validated Jira issue establishes the implementation fact.",
    freshness: "current",
    evidenceIds: ["evidence:validated"],
    sourceIds: ["jira:DEMO-1"],
  }],
  sections: [{
    id: "section:validated",
    title: "Validated result",
    question: "What was established?",
    claimIds: ["claim:validated"],
    coverageTargetIds: ["target:validated"],
  }],
  coverage: [{
    targetId: "target:validated",
    status: "covered",
    claimIds: ["claim:validated"],
    evidenceIds: ["evidence:validated"],
    distinctSourceCount: 1,
  }],
  reconciliation: [{
    defectId: "defect:validated-coverage",
    target: { kind: "coverage", id: "target:validated" },
    decision: "abstain",
    reasonCode: "insufficient_budget",
  }],
  limitations: [],
  sources: [report.sources[0]!],
  run: report.run,
  markdown: "# Evidence-backed research\n\n- The validated Jira issue establishes the implementation fact.",
};

function screenProps(port: ResearchPort, spaceKey = "KB"): ScreenProps {
  return {
    ports: {
      host: {
        kind: "test",
        name: "test",
        version: "1",
        capabilities: ["research"],
      },
      research: port,
    } as unknown as AppPorts,
    page: {
      status: "loaded",
      token: 1,
      lastSeq: 1,
      ref: {
        url: `https://example.atlassian.net/wiki/spaces/${spaceKey}/pages/1001/Design`,
        entity: {
          product: "confluence",
          type: "page",
          pageId: "1001",
          spaceKey,
        },
      },
      contentId: "1001",
      page: {
        details: {
          id: "1001",
          title: "Design",
          spaceKey,
          version: 1,
          storage: "<p>Design</p>",
        },
        markdown: "Design",
        wordCount: 1,
        attachments: [],
      },
    },
    retry: () => undefined,
    navigate: () => undefined,
  };
}

describe("research scope inference", () => {
  it("leaves question-derived scope to the shared catalog-backed preflight", () => {
    expect(
      inferResearchScope({
        siteOrigin: "https://example.atlassian.net",
        question:
          "Nutze Jira Projektkey ATLCLI und Confluence Spacekey DOCSY für den Bericht.",
        jiraProjects: "",
        confluenceSpaces: "",
        activeSpaceKey: "CURRENT",
      })
    ).toMatchObject({
      jiraProjectKeys: [],
      confluenceSpaceKeys: ["CURRENT"],
      scopeSeeds: [
        { binding: { key: "CURRENT", source: "current_context", authority: "approved" }, precedence: 300 },
      ],
    });
  });

  it("keeps manual scope locked while retaining removable current context", () => {
    expect(inferResearchScope({
      siteOrigin: "https://example.atlassian.net",
      question: "Research the current context.",
      jiraProjects: "MANUAL, SECOND",
      confluenceSpaces: "DOCS",
      activeProjectKey: "CURRENT",
      activeSpaceKey: "CURRENTSPACE",
    })).toMatchObject({
      jiraProjectKeys: ["MANUAL", "SECOND"],
      confluenceSpaceKeys: ["DOCS"],
      scopeSeeds: [
        { binding: { key: "MANUAL", source: "ui_added", authority: "locked" }, precedence: 500 },
        { binding: { key: "SECOND", source: "ui_added", authority: "locked" }, precedence: 500 },
        { binding: { key: "CURRENT", source: "current_context", authority: "approved" }, precedence: 300 },
        { binding: { key: "DOCS", source: "ui_added", authority: "locked" }, precedence: 500 },
        { binding: { key: "CURRENTSPACE", source: "current_context", authority: "approved" }, precedence: 300 },
      ],
    });
  });
});

describe("research brief clarification presentation", () => {
  it("renders the shared typed stop without starting a worker", async () => {
    const clarification: ResearchBriefClarificationRequiredV1 = {
      schema: "atlcli.research-clarification-required/v1",
      sessionId: "research-session:screen",
      turnId: "research-turn:screen",
      briefRevision: 2,
      questions: [{
        id: "clarification:window",
        prompt: "Which time window should be used?",
        required: true,
      }],
      assumptionsRequiringDecision: [{
        id: "assumption:archived",
        text: "Archived items would be included.",
        requiresUserDecision: true,
        status: "proposed",
      }],
    };
    await dom.render(
      <I18nProvider locale="en">
        <ResearchBriefClarificationNotice clarification={clarification} />
      </I18nProvider>,
    );
    const alert = dom.find("research-brief-clarification-required");
    expect(alert.textContent).toContain("Research clarification required");
    expect(alert.textContent).toContain("Brief revision 2");
    expect(alert.textContent).toContain("Which time window should be used?");
    expect(alert.textContent).toContain("Archived items would be included.");
  });
});

describe("portable Research screen", () => {
  it("stores the key through the port, infers scope, runs, and renders safe structured output", async () => {
    let stored = false;
    const preflightInputs: ResearchRequestV1[] = [];
    const observed: ResearchRequestV1[] = [];
    const observedPolicies: unknown[] = [];
    const port: ResearchPort = {
      hasApiKey: async () => stored,
      setApiKey: async () => {
        stored = true;
      },
      clearApiKey: async () => {
        stored = false;
      },
      resolveScope: async (request) => {
        preflightInputs.push(request);
        return {
          schema: "atlcli.research-scope-preflight-outcome/v1",
          kind: "ready",
          request: {
            ...request,
            scope: {
              ...request.scope,
              jiraProjectKeys: ["DEMO"],
              confluenceSpaceKeys: ["KB"],
            },
            scopeSeeds: [
              createResearchKeyScopeSeedV1({
                tenantOrigin: request.scope.siteOrigin,
                product: "jira",
                key: "DEMO",
                source: "natural_language",
                authority: "approved",
              }),
              createResearchKeyScopeSeedV1({
                tenantOrigin: request.scope.siteOrigin,
                product: "confluence",
                key: "KB",
                source: "natural_language",
                authority: "approved",
              }),
            ],
          },
          mentions: [],
          resolutions: [],
        };
      },
      run: async (request, options) => {
        observed.push(request);
        observedPolicies.push(options?.policy);
        options?.onProgress?.({
          phase: "researching",
          message: "Synthetic progress",
          completedCalls: 2,
          maxCalls: 32,
        });
        options?.onEvent?.({
          kind: "plan",
          seq: 1,
          at: "2026-07-31T12:00:00.000Z",
          briefRevision: 1,
          revision: 1,
          status: "approved",
          resolvedEffort: "analysis",
          selectedRoleIds: ["wiki-retrieval", "synthesizer"],
          nodeCount: 2,
          waveCount: 2,
          maxParallelNodes: 3,
        });
        options?.onEvent?.({
          kind: "task",
          seq: 2,
          at: "2026-07-31T12:00:00.000Z",
          taskId: "research-task:1",
          roleId: "wiki-retrieval",
          status: "planned",
          wave: 1,
          dependencyTaskIds: [],
          grantedCapabilityIds: ["wiki.search", "wiki.page.get"],
        });
        options?.onEvent?.({
          kind: "subagent",
          seq: 3,
          at: "2026-07-31T12:00:00.000Z",
          taskId: "research-task:1",
          roleId: "wiki-retrieval",
          status: "started",
        });
        options?.onEvent?.({
          kind: "capability",
          seq: 4,
          at: "2026-07-31T12:00:00.000Z",
          callId: "wiki.search:1",
          toolId: "wiki.search",
          inputKind: "search",
          status: "completed",
          inputKeys: ["query"],
          queryKeys: ["text"],
          itemCount: 10,
          complete: false,
          termination: "item-limit",
          resultBytes: 2048,
          truncated: false,
          durationMs: 42,
        });
        options?.onEvent?.({
          kind: "budget",
          seq: 5,
          at: "2026-07-31T12:00:00.000Z",
          metric: "capability_calls",
          consumed: 1,
          maximum: 32,
        });
        return report;
      },
      copyMarkdown: async () => undefined,
      downloadMarkdown: async () => undefined,
    };
    await dom.render(
      <I18nProvider locale="de">
        <ResearchScreen {...screenProps(port)} />
      </I18nProvider>
    );
    await dom.setValue("research-key", "synthetic-key");
    await dom.setValue(
      "research-question",
      "Nutze Jira Projektkey DEMO und Confluence Spacekey KB: Wie hängen DEMO-1 und Seite 1001 zusammen?"
    );
    await dom.setValue("research-max-cost-usd", "1.25");
    await dom.toggle("research-disclosure");
    await dom.click("research-run");
    await dom.flush();

    expect(stored).toBe(true);
    expect(preflightInputs[0]).toMatchObject({
      limits: { maxModelCostMicros: 1_250_000 },
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: [],
        confluenceSpaceKeys: ["KB"],
      },
      scopeSeeds: [
        { binding: { key: "KB", source: "current_context", authority: "approved" }, precedence: 300 },
      ],
    });
    expect(observed[0]!.scope).toMatchObject({
      siteOrigin: "https://example.atlassian.net",
      jiraProjectKeys: ["DEMO"],
      confluenceSpaceKeys: ["KB"],
    });
    expect(dom.find("research-model-cost-summary").textContent).toContain("1.25");
    expect(observed[0]!.scopeSeeds).toEqual(expect.arrayContaining([
      expect.objectContaining({
        binding: expect.objectContaining({ source: "natural_language", key: "DEMO" }),
      }),
      expect.objectContaining({
        binding: expect.objectContaining({ source: "natural_language", key: "KB" }),
      }),
    ]));
    expect(observedPolicies[0]).toEqual({
      schema: "atlcli.research-one-shot-policy/v1",
      requestedEffort: "auto",
      requestedPlanApproval: "default",
      scopeExpansionMode: "ask",
      requestedReconciliation: "auto",
    });
    expect(dom.find("research-formatted-report").textContent).toContain(
      "The page explicitly links the issue."
    );
    expect(dom.find("research-activity").textContent).toContain(
      "agent · wiki-retrieval · research-task:1 · started"
    );
    expect(dom.find("research-activity").textContent).toContain(
      "plan · graph 1 · approved · effort analysis · 2 nodes in 2 waves"
    );
    expect(dom.find("research-activity").textContent).toContain(
      "task · research-task:1 · wiki-retrieval · planned · wave 1"
    );
    expect(dom.find("research-activity").textContent).toContain(
      "tool · wiki.search · wiki.search:1 · search · completed · input {query} · query {text} · 10 items · complete false · item-limit · 2048 bytes · truncated false · 42 ms"
    );
    expect(dom.find("research-activity").textContent).toContain(
      "budget · capability_calls · 1/32"
    );
    await dom.toggle("research-current-context");
    await dom.click("research-run");
    await dom.flush();
    expect(observed[1]!.scopeSeeds?.some(
      (seed) => seed.binding.source === "current_context",
    )).toBe(false);
    expect(dom.html()).not.toContain("<script");
    expect((globalThis as Record<string, unknown>).chrome).toBeUndefined();
  });

  it("rejects an unsafe browser model-cost budget before scope or provider access", async () => {
    let scopeCalls = 0;
    let runCalls = 0;
    const port: ResearchPort = {
      hasApiKey: async () => true,
      setApiKey: async () => undefined,
      clearApiKey: async () => undefined,
      resolveScope: async (request) => {
        scopeCalls += 1;
        return {
          schema: "atlcli.research-scope-preflight-outcome/v1",
          kind: "ready",
          request,
          mentions: [],
          resolutions: [],
        };
      },
      run: async () => {
        runCalls += 1;
        return report;
      },
      copyMarkdown: async () => undefined,
      downloadMarkdown: async () => undefined,
    };
    await dom.render(
      <I18nProvider locale="en">
        <ResearchScreen {...screenProps(port)} />
      </I18nProvider>,
    );
    await dom.setValue("research-question", "How are DEMO-1 and KB related?");
    await dom.setValue("research-max-cost-usd", "25.01");
    await dom.toggle("research-disclosure");
    await dom.click("research-run");
    await dom.flush();

    expect({ scopeCalls, runCalls }).toEqual({ scopeCalls: 0, runCalls: 0 });
    expect(dom.find("research-error").textContent)
      .toContain("Enter a maximum model cost from $0.01 to $25.00.");
  });

  it("requests a cooperative durable pause without cancelling the active run", async () => {
    let pauseCalls = 0;
    const port: ResearchPort = {
      hasApiKey: async () => true,
      setApiKey: async () => undefined,
      clearApiKey: async () => undefined,
      resolveScope: async (request) => ({
        schema: "atlcli.research-scope-preflight-outcome/v1",
        kind: "ready",
        request: {
          ...request,
          scope: {
            ...request.scope,
            jiraProjectKeys: ["DEMO"],
            confluenceSpaceKeys: ["KB"],
          },
        },
        mentions: [],
        resolutions: [],
      }),
      run: async () => new Promise<ResearchReportV1>(() => undefined),
      pauseActiveRun: async () => {
        pauseCalls += 1;
        return "pause_requested";
      },
      copyMarkdown: async () => undefined,
      downloadMarkdown: async () => undefined,
    };
    await dom.render(
      <I18nProvider locale="en">
        <ResearchScreen {...screenProps(port)} />
      </I18nProvider>,
    );
    await dom.setValue("research-question", "How are DEMO-1 and KB related?");
    await dom.toggle("research-disclosure");
    await dom.click("research-run");
    await dom.flush();
    expect((dom.find("research-pause") as HTMLButtonElement).disabled).toBe(false);

    await dom.click("research-pause");
    expect(pauseCalls).toBe(1);
    expect(dom.find("research-action-status").textContent).toContain(
      "Pause requested — finishing the current retrieval wave.",
    );
    expect((dom.find("research-pause") as HTMLButtonElement).disabled).toBe(true);
  });

  it("treats a durable paused result as resumable status rather than an error", async () => {
    const port: ResearchPort = {
      hasApiKey: async () => true,
      setApiKey: async () => undefined,
      clearApiKey: async () => undefined,
      resolveScope: async (request) => ({
        schema: "atlcli.research-scope-preflight-outcome/v1",
        kind: "ready",
        request: {
          ...request,
          scope: {
            ...request.scope,
            jiraProjectKeys: ["DEMO"],
            confluenceSpaceKeys: ["KB"],
          },
        },
        mentions: [],
        resolutions: [],
      }),
      run: async () => {
        throw new ResearchContractError(
          "paused",
          "Research paused at a durable retrieval checkpoint.",
        );
      },
      copyMarkdown: async () => undefined,
      downloadMarkdown: async () => undefined,
    };
    await dom.render(
      <I18nProvider locale="en">
        <ResearchScreen {...screenProps(port)} />
      </I18nProvider>,
    );
    await dom.setValue("research-question", "How are DEMO-1 and KB related?");
    await dom.toggle("research-disclosure");
    await dom.click("research-run");
    expect(dom.find("research-action-status").textContent).toContain(
      "Research paused at a durable checkpoint. Resume it below.",
    );
    expect(dom.maybeFind("research-error")).toBeNull();
  });

  it("renders a V2 claim report and preserves its canonical Markdown", async () => {
    const port: ResearchPort = {
      hasApiKey: async () => true,
      setApiKey: async () => undefined,
      clearApiKey: async () => undefined,
      resolveScope: async (request) => ({
        schema: "atlcli.research-scope-preflight-outcome/v1",
        kind: "ready",
        request,
        mentions: [],
        resolutions: [],
      }),
      run: async () => v2Report,
      copyMarkdown: async () => undefined,
      downloadMarkdown: async () => undefined,
    };
    await dom.render(
      <I18nProvider locale="en">
        <ResearchScreen {...screenProps(port)} />
      </I18nProvider>,
    );
    await dom.setValue("research-question", v2Report.question);
    await dom.setValue("research-jira", "DEMO");
    await dom.toggle("research-disclosure");
    await dom.click("research-run");
    await dom.flush();

    const formatted = dom.find("research-formatted-report");
    expect(formatted.textContent).toContain("The validated Jira issue establishes the implementation fact.");
    expect(formatted.textContent).toContain("Evidence coverage");
    expect(formatted.textContent).toContain("1 distinct retained source");
    expect(dom.find("research-claim-freshness-claim:validated").textContent).toBe("Current evidence");
    expect(dom.find("research-reconciliation-defect:validated-coverage").textContent).toContain("coverage: target:validated: abstain (insufficient_budget)");
    expect(formatted.textContent).toContain("None reported.");
    expect(dom.html()).toContain("https://example.atlassian.net/browse/DEMO-1");

    await dom.click("research-raw");
    await dom.flush();
    expect(dom.find("research-raw-markdown").textContent).toBe(v2Report.markdown);
  });

  it("lists a durable tenant-bound session and resumes it through the portable port", async () => {
    const resumable = {
      schema: "atlcli.research-resumable-session/v1" as const,
      sessionId: "research-session:resume",
      revision: 4,
      turnId: "research-turn:resume",
      status: "waiting_authentication" as const,
      updatedAt: "2026-08-02T12:00:00.000Z",
      question: "Continue the interrupted research.",
      scope: { jiraProjectKeys: ["DEMO"], confluenceSpaceKeys: ["KB"] },
    };
    const resumed: string[] = [];
    let listingCount = 0;
    const port: ResearchPort = {
      hasApiKey: async () => true,
      setApiKey: async () => undefined,
      clearApiKey: async () => undefined,
      resolveScope: async (request) => ({
        schema: "atlcli.research-scope-preflight-outcome/v1",
        kind: "ready",
        request,
        mentions: [],
        resolutions: [],
      }),
      listResumableSessions: async () => (++listingCount === 1 ? [resumable] : []),
      run: async () => report,
      resume: async (sessionId, options) => {
        resumed.push(sessionId);
        options?.onEvent?.({
          kind: "phase",
          seq: 1,
          at: "2026-08-02T12:00:01.000Z",
          phase: "researching",
        });
        return report;
      },
      copyMarkdown: async () => undefined,
      downloadMarkdown: async () => undefined,
    };
    await dom.render(
      <I18nProvider locale="en">
        <ResearchScreen {...screenProps(port)} />
      </I18nProvider>,
    );
    await dom.flush();

    expect(dom.find("research-resumable-sessions").textContent)
      .toContain("Continue the interrupted research.");
    expect((dom.find("research-resume-0") as HTMLButtonElement).disabled).toBe(true);
    await dom.toggle("research-disclosure");
    await dom.click("research-resume-0");
    await dom.flush();

    expect(resumed).toEqual(["research-session:resume"]);
    expect(dom.find("research-activity").textContent)
      .toContain("phase · researching");
    expect(dom.find("research-formatted-report").textContent)
      .toContain("The page explicitly links the issue.");
  });

  it("stores one bounded steering instruction from a paused durable session", async () => {
    const resumable = {
      schema: "atlcli.research-resumable-session/v1" as const,
      sessionId: "research-session:checkpoint",
      revision: 12,
      turnId: "research-turn:checkpoint",
      status: "paused" as const,
      updatedAt: "2026-08-02T12:00:00.000Z",
      question: "Continue the approved research.",
      scope: { jiraProjectKeys: ["DEMO"], confluenceSpaceKeys: ["KB"] },
    };
    const instructions: Array<{ sessionId: string; revision: number; instruction: string }> = [];
    const port: ResearchPort = {
      hasApiKey: async () => true,
      setApiKey: async () => undefined,
      clearApiKey: async () => undefined,
      resolveScope: async (request) => ({
        schema: "atlcli.research-scope-preflight-outcome/v1",
        kind: "ready",
        request,
        mentions: [],
        resolutions: [],
      }),
      listResumableSessions: async () => [resumable],
      requestSteering: async (input) => { instructions.push(input); },
      run: async () => report,
      copyMarkdown: async () => undefined,
      downloadMarkdown: async () => undefined,
    };
    await dom.render(
      <I18nProvider locale="en">
        <ResearchScreen {...screenProps(port)} />
      </I18nProvider>,
    );
    await dom.flush();

    await dom.setValue("research-steering-input-0", "Prioritize the approved comparison.");
    await dom.click("research-steering-submit-0");
    await dom.flush();

    expect(instructions).toEqual([{
      sessionId: "research-session:checkpoint",
      revision: 12,
      instruction: "Prioritize the approved comparison.",
    }]);
    expect(dom.find("research-action-status").textContent)
      .toContain("Steering saved. Resume to apply the bounded graph update.");
  });

  it("shows a persisted scope proposal and sends only its revision-fenced decision", async () => {
    const review: ResearchSessionScopeReviewV1 = {
      schema: "atlcli.research-session-scope-review/v1",
      sessionId: "research-session:scope-review",
      revision: 12,
      status: "waiting_scope_approval",
      updatedAt: "2026-08-02T12:00:00.000Z",
      turn: {
        id: "research-turn:scope-review",
        briefRevision: 3,
        graphRevision: 4,
        candidates: [{
          id: "research-scope-candidate:confluence-space-related",
          product: "confluence",
          entityKind: "space",
          key: "RELATED",
          name: "Related documentation",
        }],
        bindings: [],
        discoveryDispositions: [],
        expansionProposals: [{
          id: "scope-expansion:related-space",
          candidateId: "research-scope-candidate:confluence-space-related",
          expansionKind: "whole_scope",
          basedOnBriefRevision: 3,
          basedOnGraphRevision: 4,
          reason: "An exact reference points to this space.",
          status: "proposed",
        }],
        scopeRevisions: [],
      },
    };
    const approved: Array<{
      sessionId: string;
      revision: number;
      briefRevision: number;
      graphRevision: number;
      proposalId: string;
    }> = [];
    let listings = 0;
    const port: ResearchPort = {
      hasApiKey: async () => true,
      setApiKey: async () => undefined,
      clearApiKey: async () => undefined,
      resolveScope: async (request) => ({
        schema: "atlcli.research-scope-preflight-outcome/v1",
        kind: "ready",
        request,
        mentions: [],
        resolutions: [],
      }),
      listScopeReviews: async () => (++listings === 1 ? [review] : []),
      approveScopeReview: async (input) => {
        approved.push(input);
        return {
          ...review,
          revision: 13,
          status: "waiting_plan_approval",
          turn: {
            ...review.turn,
            expansionProposals: [{
              ...review.turn.expansionProposals[0]!,
              status: "approved",
              approvedBindingId: "scope-binding:related-space",
            }],
          },
        };
      },
      rejectScopeReview: async () => review,
      run: async () => report,
      copyMarkdown: async () => undefined,
      downloadMarkdown: async () => undefined,
    };
    await dom.render(
      <I18nProvider locale="en">
        <ResearchScreen {...screenProps(port)} />
      </I18nProvider>,
    );
    await dom.flush();

    expect(dom.find("research-scope-reviews").textContent)
      .toContain("RELATED");
    expect(dom.find("research-scope-review-0-0").textContent)
      .toContain("An exact reference points to this space.");
    await dom.click("research-scope-review-approve-0-0");
    await dom.flush();

    expect(approved).toEqual([{
      sessionId: "research-session:scope-review",
      revision: 12,
      briefRevision: 3,
      graphRevision: 4,
      proposalId: "scope-expansion:related-space",
    }]);
    expect(dom.html()).toContain("Scope decision saved.");
    expect(dom.html()).not.toContain("candidateId");
  });

  it("approves a durable replacement plan without starting retrieval", async () => {
    const review: ResearchSessionScopeReviewV1 = {
      schema: "atlcli.research-session-scope-review/v1",
      sessionId: "research-session:scope-plan-review",
      revision: 13,
      status: "waiting_plan_approval",
      updatedAt: "2026-08-02T12:00:00.000Z",
      turn: {
        id: "research-turn:scope-plan-review",
        briefRevision: 4,
        graphRevision: 5,
        candidates: [],
        bindings: [{
          id: "scope-binding:related-space",
          product: "confluence",
          entityKind: "space",
          key: "RELATED",
          name: "Related documentation",
          source: "research_discovery",
          authority: "approved",
        }],
        discoveryDispositions: [],
        expansionProposals: [],
        scopeRevisions: [{
          id: "scope-revision:related-space",
          proposalId: "scope-expansion:related-space",
          basedOnBriefRevision: 3,
          basedOnGraphRevision: 4,
          revisedBriefRevision: 4,
          proposedGraphRevision: 5,
          state: "proposed",
        }],
      },
    };
    const approvals: Array<{
      sessionId: string;
      revision: number;
      briefRevision: number;
      graphRevision: number;
    }> = [];
    let listings = 0;
    let runs = 0;
    const port: ResearchPort = {
      hasApiKey: async () => true,
      setApiKey: async () => undefined,
      clearApiKey: async () => undefined,
      resolveScope: async (request) => ({
        schema: "atlcli.research-scope-preflight-outcome/v1",
        kind: "ready",
        request,
        mentions: [],
        resolutions: [],
      }),
      listScopePlanReviews: async () => (++listings === 1 ? [review] : []),
      approveScopePlanReview: async (input) => {
        approvals.push(input);
        return { ...review, revision: 14, status: "running" };
      },
      run: async () => {
        runs += 1;
        return report;
      },
      copyMarkdown: async () => undefined,
      downloadMarkdown: async () => undefined,
    };
    await dom.render(
      <I18nProvider locale="en">
        <ResearchScreen {...screenProps(port)} />
      </I18nProvider>,
    );
    await dom.flush();

    expect(dom.find("research-scope-plan-reviews").textContent)
      .toContain("RELATED");
    expect(dom.find("research-scope-plan-review-0").textContent)
      .toContain("does not start retrieval");
    await dom.click("research-scope-plan-review-approve-0");
    await dom.flush();

    expect(approvals).toEqual([{
      sessionId: "research-session:scope-plan-review",
      revision: 13,
      briefRevision: 4,
      graphRevision: 5,
    }]);
    expect(runs).toBe(0);
    expect(dom.html()).toContain("Replacement plan approved.");
  });

  it("shows the shared deep-plan stop before storing a key or calling the host", async () => {
    let keyWrites = 0;
    let runs = 0;
    const policies: unknown[] = [];
    const port: ResearchPort = {
      hasApiKey: async () => false,
      setApiKey: async () => { keyWrites += 1; },
      clearApiKey: async () => undefined,
      resolveScope: async (request) => ({
        schema: "atlcli.research-scope-preflight-outcome/v1",
        kind: "ready",
        request,
        mentions: [],
        resolutions: [],
      }),
      run: async (_request, options) => {
        runs += 1;
        policies.push(options?.policy);
        return report;
      },
      copyMarkdown: async () => undefined,
      downloadMarkdown: async () => undefined,
    };
    await dom.render(
      <I18nProvider locale="en">
        <ResearchScreen {...screenProps(port)} />
      </I18nProvider>,
    );
    await dom.setValue("research-key", "synthetic-key");
    await dom.setValue(
      "research-question",
      "Perform exhaustive contradiction analysis for Jira project DEMO and Confluence space KB.",
    );
    await dom.setValue("research-effort", "deep");
    await dom.toggle("research-disclosure");
    await dom.click("research-run");
    await dom.flush();

    expect(dom.find("research-plan-approval-required").textContent).toContain(
      "Plan review required",
    );
    expect(dom.find("research-plan-approval-required").textContent).toContain(
      "reconciler",
    );
    expect({ keyWrites, runs }).toEqual({ keyWrites: 0, runs: 0 });

    await dom.setValue("research-plan-approval", "automatic");
    await dom.click("research-run");
    await dom.flush();
    expect({ keyWrites, runs }).toEqual({ keyWrites: 1, runs: 1 });
    expect(policies[0]).toMatchObject({
      requestedEffort: "deep",
      requestedPlanApproval: "automatic",
    });
    expect(dom.find("research-formatted-report").textContent).toContain(
      "The page explicitly links the issue.",
    );
  });

  it("persists an initial deep plan for review before key storage or retrieval", async () => {
    const review: ResearchSessionPlanReviewV1 = {
      schema: "atlcli.research-session-plan-review/v1",
      sessionId: "research-session:initial-plan-review",
      revision: 4,
      status: "waiting_plan_approval",
      updatedAt: "2026-08-02T12:00:00.000Z",
      turn: {
        id: "research-turn:initial-plan-review",
        briefRevision: 1,
        graphRevision: 1,
        resolvedEffort: "deep",
        selectedRoleIds: ["focused-researcher", "reconciler"],
        scopeExpansionMode: "ask",
        reconciliationMode: "required",
        scope: { jiraProjectKeys: ["DEMO"], confluenceSpaceKeys: ["KB"] },
        budget: {
          maxPtcCalls: 32,
          maxHttpCalls: 32,
          maxTotalModelInputTokens: 80_000,
          maxTotalModelOutputTokens: 32_000,
          maxModelCostMicros: 2_000_000,
          maxRunMs: 120_000,
        },
      },
    };
    const prepared: Array<{ request: ResearchRequestV1; policy: unknown }> = [];
    const approvals: unknown[] = [];
    let preparedReview = false;
    let approvedSession = false;
    let keyWrites = 0;
    let runs = 0;
    const port: ResearchPort = {
      hasApiKey: async () => false,
      setApiKey: async () => { keyWrites += 1; },
      clearApiKey: async () => undefined,
      resolveScope: async (request) => ({
        schema: "atlcli.research-scope-preflight-outcome/v1",
        kind: "ready",
        request,
        mentions: [],
        resolutions: [],
      }),
      preparePlanReview: async (request, policy) => {
        prepared.push({ request, policy });
        preparedReview = true;
        return review;
      },
      listPlanReviews: async () => (preparedReview ? [review] : []),
      listResumableSessions: async () => (approvedSession ? [{
        schema: "atlcli.research-resumable-session/v1" as const,
        sessionId: review.sessionId,
        revision: 14,
        turnId: review.turn.id,
        status: "running" as const,
        updatedAt: review.updatedAt,
        question: "Synthetic durable question.",
        scope: review.turn.scope,
      }] : []),
      approvePlanReview: async (input) => {
        approvals.push(input);
        approvedSession = true;
        return {
          schema: "atlcli.research-resumable-session/v1",
          sessionId: review.sessionId,
          revision: 14,
          turnId: review.turn.id,
          status: "running",
          updatedAt: review.updatedAt,
          question: "Synthetic durable question.",
          scope: review.turn.scope,
        };
      },
      run: async () => {
        runs += 1;
        return report;
      },
      copyMarkdown: async () => undefined,
      downloadMarkdown: async () => undefined,
    };
    await dom.render(
      <I18nProvider locale="en">
        <ResearchScreen {...screenProps(port)} />
      </I18nProvider>,
    );
    await dom.setValue("research-key", "synthetic-key");
    await dom.setValue(
      "research-question",
      "Perform exhaustive contradiction analysis for Jira project DEMO and Confluence space KB.",
    );
    await dom.setValue("research-effort", "deep");
    await dom.toggle("research-disclosure");
    await dom.click("research-run");
    await dom.flush();

    expect(prepared).toHaveLength(1);
    expect({ keyWrites, runs }).toEqual({ keyWrites: 0, runs: 0 });
    expect(dom.find("research-plan-reviews").textContent).toContain("reconciler");
    expect(dom.find("research-plan-review-budget-0").textContent)
      .toContain("$2.00");
    expect(dom.find("research-plan-reviews").textContent).toContain("does not store a key");
    await dom.click("research-plan-review-approve-0");
    await dom.flush();

    expect(approvals).toEqual([{
      sessionId: review.sessionId,
      revision: 4,
      briefRevision: 1,
      graphRevision: 1,
    }]);
    expect({ keyWrites, runs }).toEqual({ keyWrites: 0, runs: 0 });
    expect(dom.find("research-resumable-sessions").textContent)
      .toContain("Synthetic durable question.");
  });

  it("persists a bounded plan correction and requires review of its replacement", async () => {
    const review: ResearchSessionPlanReviewV1 = {
      schema: "atlcli.research-session-plan-review/v1",
      sessionId: "research-session:plan-correction-review",
      revision: 4,
      status: "waiting_plan_approval",
      updatedAt: "2026-08-02T12:00:00.000Z",
      turn: {
        id: "research-turn:plan-correction-review",
        briefRevision: 1,
        graphRevision: 1,
        resolvedEffort: "deep",
        selectedRoleIds: ["focused-researcher", "reconciler"],
        scopeExpansionMode: "ask",
        reconciliationMode: "required",
        scope: { jiraProjectKeys: ["DEMO"], confluenceSpaceKeys: ["KB"] },
        budget: {
          maxPtcCalls: 32,
          maxHttpCalls: 32,
          maxTotalModelInputTokens: 80_000,
          maxTotalModelOutputTokens: 32_000,
          maxModelCostMicros: 2_000_000,
          maxRunMs: 120_000,
        },
      },
    };
    const replacement: ResearchSessionPlanReviewV1 = {
      ...review,
      revision: 7,
      turn: { ...review.turn, briefRevision: 2, graphRevision: 2 },
    };
    const corrections: unknown[] = [];
    let revised = false;
    let keyWrites = 0;
    let runs = 0;
    const port: ResearchPort = {
      hasApiKey: async () => false,
      setApiKey: async () => { keyWrites += 1; },
      clearApiKey: async () => undefined,
      resolveScope: async (request) => ({
        schema: "atlcli.research-scope-preflight-outcome/v1",
        kind: "ready",
        request,
        mentions: [],
        resolutions: [],
      }),
      listPlanReviews: async () => [revised ? replacement : review],
      rejectPlanReview: async (input) => {
        corrections.push(input);
        revised = true;
        return replacement;
      },
      run: async () => {
        runs += 1;
        return report;
      },
      copyMarkdown: async () => undefined,
      downloadMarkdown: async () => undefined,
    };
    await dom.render(
      <I18nProvider locale="en">
        <ResearchScreen {...screenProps(port)} />
      </I18nProvider>,
    );
    await dom.flush();
    await dom.setValue(
      "research-plan-review-correction-0",
      "Separate direct evidence from inferred relationships.",
    );
    await dom.click("research-plan-review-revise-0");
    await dom.flush();

    expect(corrections).toEqual([{
      sessionId: review.sessionId,
      revision: 4,
      briefRevision: 1,
      graphRevision: 1,
      instruction: "Separate direct evidence from inferred relationships.",
    }]);
    expect({ keyWrites, runs }).toEqual({ keyWrites: 0, runs: 0 });
    expect(dom.find("research-plan-reviews").textContent).toContain("brief revision 2");
    expect(dom.find("research-action-status").textContent)
      .toContain("Correction saved");
  });

  it("persists and resolves an initial clarification before key storage or retrieval", async () => {
    const review: ResearchSessionClarificationReviewV1 = {
      schema: "atlcli.research-session-clarification-review/v1",
      sessionId: "research-session:initial-clarification-review",
      revision: 3,
      status: "waiting_clarification",
      stage: "answer_required",
      updatedAt: "2026-08-02T12:00:00.000Z",
      turn: {
        id: "research-turn:initial-clarification-review",
        briefRevision: 1,
        scope: { jiraProjectKeys: ["DEMO"], confluenceSpaceKeys: ["KB"] },
        questions: [{
          id: "clarification:time-window",
          prompt: "Which exact reporting window should this research use?",
        }],
        assumptions: [],
      },
    };
    let prepared = false;
    let resolved = false;
    let keyWrites = 0;
    let runs = 0;
    const resolutions: unknown[] = [];
    const port: ResearchPort = {
      hasApiKey: async () => false,
      setApiKey: async () => { keyWrites += 1; },
      clearApiKey: async () => undefined,
      resolveScope: async (request) => ({
        schema: "atlcli.research-scope-preflight-outcome/v1",
        kind: "ready",
        request,
        mentions: [],
        resolutions: [],
      }),
      prepareClarificationReview: async () => {
        prepared = true;
        return review;
      },
      listClarificationReviews: async () => (prepared && !resolved ? [review] : []),
      listResumableSessions: async () => (resolved ? [{
        schema: "atlcli.research-resumable-session/v1" as const,
        sessionId: review.sessionId,
        revision: 14,
        turnId: review.turn.id,
        status: "running" as const,
        updatedAt: review.updatedAt,
        question: "Synthetic durable clarification question.",
        scope: review.turn.scope,
      }] : []),
      resolveClarificationReview: async (input) => {
        resolutions.push(input);
        resolved = true;
        return {
          kind: "resumable" as const,
          session: {
            schema: "atlcli.research-resumable-session/v1" as const,
            sessionId: review.sessionId,
            revision: 14,
            turnId: review.turn.id,
            status: "running" as const,
            updatedAt: review.updatedAt,
            question: "Synthetic durable clarification question.",
            scope: review.turn.scope,
          },
        };
      },
      run: async () => {
        runs += 1;
        return report;
      },
      copyMarkdown: async () => undefined,
      downloadMarkdown: async () => undefined,
    };
    await dom.render(
      <I18nProvider locale="en">
        <ResearchScreen {...screenProps(port)} />
      </I18nProvider>,
    );
    await dom.setValue("research-key", "synthetic-key");
    await dom.setValue(
      "research-question",
      "How is the current Jira work in DEMO related to Confluence space KB?",
    );
    await dom.toggle("research-disclosure");
    await dom.click("research-run");
    await dom.flush();

    expect({ keyWrites, runs }).toEqual({ keyWrites: 0, runs: 0 });
    expect(dom.find("research-clarification-reviews").textContent)
      .toContain("does not store a key");
    await dom.setValue(
      "research-clarification-answer-0-clarification:time-window",
      "Use the last seven days.",
    );
    await dom.click("research-clarification-resolve-0");
    await dom.flush();

    expect(resolutions).toEqual([{
      sessionId: review.sessionId,
      revision: 3,
      briefRevision: 1,
      answers: [{ questionId: "clarification:time-window", response: "Use the last seven days." }],
      assumptionDecisions: [],
    }]);
    expect({ keyWrites, runs }).toEqual({ keyWrites: 0, runs: 0 });
    expect(dom.find("research-resumable-sessions").textContent)
      .toContain("Synthetic durable clarification question.");
  });

  it("persists a scope choice and resolves it without key storage or retrieval", async () => {
    const review: ResearchSessionScopeClarificationReviewV1 = {
      schema: "atlcli.research-session-scope-clarification-review/v1",
      sessionId: "research-session:scope-choice-review",
      revision: 2,
      status: "waiting_scope_clarification",
      stage: "choice_required",
      updatedAt: "2026-08-02T12:00:00.000Z",
      clarification: {
        mentionId: "mention:scope-1",
        reason: "ambiguous",
        rerunGuidance: ["Choose the intended space."],
        candidates: [{
          id: "research-scope-candidate:account-management",
          product: "confluence",
          entityKind: "space",
          key: "DOCS",
          name: "Account Management",
        }],
      },
    };
    let prepared = false;
    let resolved = false;
    let keyWrites = 0;
    let runs = 0;
    const selections: unknown[] = [];
    const port: ResearchPort = {
      hasApiKey: async () => false,
      setApiKey: async () => { keyWrites += 1; },
      clearApiKey: async () => undefined,
      resolveScope: async () => ({
        schema: "atlcli.research-scope-preflight-outcome/v1",
        kind: "clarification_required",
        clarification: {
          schema: "atlcli.research-clarification-required/v1",
          reason: "ambiguous",
          mentionId: "mention:scope-1",
          candidateIds: ["research-scope-candidate:account-management"],
          rerunGuidance: ["Choose the intended space."],
        },
        candidateChoices: [],
        mentions: [],
        resolutions: [],
      }),
      prepareScopeClarificationReview: async () => {
        prepared = true;
        return review;
      },
      listScopeClarificationReviews: async () => (prepared && !resolved ? [review] : []),
      listResumableSessions: async () => (resolved ? [{
        schema: "atlcli.research-resumable-session/v1" as const,
        sessionId: review.sessionId,
        revision: 14,
        turnId: "research-turn:scope-choice-review",
        status: "running" as const,
        updatedAt: review.updatedAt,
        question: "Synthetic durable scope-choice question.",
        scope: { jiraProjectKeys: [], confluenceSpaceKeys: ["DOCS"] },
      }] : []),
      resolveScopeClarificationReview: async (input) => {
        selections.push(input);
        resolved = true;
        return {
          kind: "resumable" as const,
          session: {
            schema: "atlcli.research-resumable-session/v1" as const,
            sessionId: review.sessionId,
            revision: 14,
            turnId: "research-turn:scope-choice-review",
            status: "running" as const,
            updatedAt: review.updatedAt,
            question: "Synthetic durable scope-choice question.",
            scope: { jiraProjectKeys: [], confluenceSpaceKeys: ["DOCS"] },
          },
        };
      },
      run: async () => {
        runs += 1;
        return report;
      },
      copyMarkdown: async () => undefined,
      downloadMarkdown: async () => undefined,
    };
    await dom.render(
      <I18nProvider locale="en">
        <ResearchScreen {...screenProps(port)} />
      </I18nProvider>,
    );
    await dom.setValue("research-key", "synthetic-key");
    await dom.setValue("research-question", "Research the Account Management space.");
    await dom.toggle("research-disclosure");
    await dom.click("research-run");
    await dom.flush();

    expect({ keyWrites, runs }).toEqual({ keyWrites: 0, runs: 0 });
    expect(dom.find("research-scope-clarification-reviews").textContent)
      .toContain("Account Management");
    await dom.setValue(
      "research-scope-clarification-picker-0",
      "research-scope-candidate:account-management",
    );
    await dom.click("research-scope-clarification-resolve-0");
    await dom.flush();

    expect(selections).toEqual([{
      sessionId: review.sessionId,
      revision: 2,
      selection: {
        schema: "atlcli.research-scope-candidate-selection/v1",
        mentionId: "mention:scope-1",
        candidateId: "research-scope-candidate:account-management",
      },
    }]);
    expect({ keyWrites, runs }).toEqual({ keyWrites: 0, runs: 0 });
    expect(dom.find("research-resumable-sessions").textContent)
      .toContain("Synthetic durable scope-choice question.");
  });

  it("renders removable context chips and freezes the submitted scope across tab changes", async () => {
    let observedRequest: ResearchRequestV1 | undefined;
    const port: ResearchPort = {
      hasApiKey: async () => true,
      setApiKey: async () => undefined,
      clearApiKey: async () => undefined,
      resolveScope: async (request) => ({
        schema: "atlcli.research-scope-preflight-outcome/v1",
        kind: "ready",
        request,
        mentions: [],
        resolutions: [],
      }),
      run: async (request) => {
        observedRequest = structuredClone(request);
        return report;
      },
      copyMarkdown: async () => undefined,
      downloadMarkdown: async () => undefined,
    };
    await dom.render(
      <I18nProvider locale="en">
        <ResearchScreen {...screenProps(port, "KB")} />
      </I18nProvider>,
    );
    await dom.setValue("research-question", "Research this context.");
    await dom.setValue("research-jira", "MANUAL");
    expect(dom.find("research-scope-chips").textContent).toContain("jira: MANUAL");
    expect(dom.find("research-scope-chips").textContent).toContain("confluence: KB");

    await dom.click("research-scope-chip-0");
    expect((dom.find("research-jira") as HTMLInputElement).value).toBe("");
    await dom.setValue("research-jira", "MANUAL");
    await dom.toggle("research-disclosure");
    await dom.click("research-run");
    await dom.flush();

    expect(observedRequest?.scope).toMatchObject({
      jiraProjectKeys: ["MANUAL"],
      confluenceSpaceKeys: ["KB"],
    });
    expect(dom.find("research-submitted-scope").textContent).toContain("confluence:KB");

    await dom.render(
      <I18nProvider locale="en">
        <ResearchScreen {...screenProps(port, "OTHER")} />
      </I18nProvider>,
    );
    expect(dom.find("research-scope-chips").textContent).toContain("confluence: OTHER");
    expect(dom.find("research-submitted-scope").textContent).toContain("confluence:KB");
    expect(observedRequest?.scope.confluenceSpaceKeys).toEqual(["KB"]);
  });

  it("shows typed scope clarification before storing the key or starting research", async () => {
    let keyWrites = 0;
    let runs = 0;
    let selectedCandidateId: string | undefined;
    const candidateChoices = [
      {
        schema: "atlcli.research-scope-candidate/v1" as const,
        id: "research-scope-candidate:confluence-space-account-1",
        tenantOrigin: "https://example.atlassian.net",
        product: "confluence" as const,
        entityKind: "space" as const,
        entityRef: "research-scope-entity:confluence-space-account-1",
        key: "ACCOUNT1",
        name: "Account Management One",
        accessible: true as const,
        providerFreshnessAt: "2026-08-01T00:00:00.000Z",
      },
      {
        schema: "atlcli.research-scope-candidate/v1" as const,
        id: "research-scope-candidate:confluence-space-account-2",
        tenantOrigin: "https://example.atlassian.net",
        product: "confluence" as const,
        entityKind: "space" as const,
        entityRef: "research-scope-entity:confluence-space-account-2",
        key: "ACCOUNT2",
        name: "Account Management Two",
        accessible: true as const,
        providerFreshnessAt: "2026-08-01T00:00:00.000Z",
      },
    ];
    const port: ResearchPort = {
      hasApiKey: async () => false,
      setApiKey: async () => { keyWrites += 1; },
      clearApiKey: async () => undefined,
      resolveScope: async (request, options) => {
        selectedCandidateId = options?.candidateSelections?.[0]?.candidateId;
        return selectedCandidateId
          ? {
              schema: "atlcli.research-scope-preflight-outcome/v1",
              kind: "ready",
              request: {
                ...request,
                scope: {
                  ...request.scope,
                  confluenceSpaceKeys: ["ACCOUNT2"],
                },
              },
              mentions: [],
              resolutions: [],
            }
          : {
              schema: "atlcli.research-scope-preflight-outcome/v1",
              kind: "clarification_required",
              clarification: {
                schema: "atlcli.research-clarification-required/v1",
                reason: "ambiguous",
                mentionId: "mention:scope-1",
                candidateIds: candidateChoices.map((candidate) => candidate.id),
                productHint: "confluence",
                entityKindHint: "space",
                rerunGuidance: ["Pass an exact Confluence space key."],
              },
              candidateChoices,
              mentions: [],
              resolutions: [],
            };
      },
      run: async () => {
        runs += 1;
        return report;
      },
      copyMarkdown: async () => undefined,
      downloadMarkdown: async () => undefined,
    };
    await dom.render(
      <I18nProvider locale="en">
        <ResearchScreen {...screenProps(port)} />
      </I18nProvider>,
    );
    await dom.setValue("research-key", "synthetic-key");
    await dom.setValue(
      "research-question",
      "Research Jira projectkey DEMO and the Account Management space.",
    );
    await dom.toggle("research-disclosure");
    await dom.click("research-run");
    await dom.flush();

    expect(dom.find("research-scope-clarification-required").textContent)
      .toContain("Scope clarification required");
    expect(dom.find("research-scope-clarification-required").textContent)
      .toContain("Account Management One");
    expect({ keyWrites, runs }).toEqual({ keyWrites: 0, runs: 0 });

    await dom.setValue(
      "research-scope-candidate-picker",
      "research-scope-candidate:confluence-space-account-2",
    );
    await dom.click("research-scope-candidate-continue");
    await dom.flush();

    expect(selectedCandidateId).toBe(
      "research-scope-candidate:confluence-space-account-2",
    );
    expect({ keyWrites, runs }).toEqual({ keyWrites: 1, runs: 1 });
    expect(dom.find("research-submitted-scope").textContent).toContain(
      "confluence:ACCOUNT2",
    );
  });
});
