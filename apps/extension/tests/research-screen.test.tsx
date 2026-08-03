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
  researchTimelineSteps,
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
  ResearchOneShotEventV1,
  ResearchReportV1,
  ResearchReportV2,
  ResearchRequestV1,
} from "../utils/research/contracts.js";
import type { ScreenProps } from "../utils/screens/registry.js";
import type { AppPorts } from "../utils/ports/index.js";
import { createReactHarness } from "./react-harness.js";

const dom = createReactHarness();

async function pressComposerKey(
  key: string,
  options: { metaKey?: boolean; shiftKey?: boolean } = {},
): Promise<void> {
  const { act } = await import("react");
  const element = dom.find("copilot-chat-textarea");
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key,
      ...options,
    }));
  });
  await dom.flush();
}

async function openConversationMenu(): Promise<void> {
  await dom.click("research-conversation-menu-toggle");
  expect(dom.find("research-conversation-menu")).toBeTruthy();
}

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

describe("research activity timeline", () => {
  it("does not present low-level runtime events as conversation turns", () => {
    const events: ResearchOneShotEventV1[] = [
      {
        kind: "phase",
        seq: 1,
        at: "2026-08-03T12:00:00.000Z",
        phase: "researching",
      },
      ...Array.from({ length: 76 }, (_, index): ResearchOneShotEventV1 => ({
        kind: "budget",
        seq: index + 2,
        at: "2026-08-03T12:00:01.000Z",
        metric: "tokens",
        consumed: index + 1,
        maximum: 1_000,
      })),
    ];

    const steps = researchTimelineSteps(events, true);

    expect(steps).toHaveLength(1);
    expect(steps[0]?.kind).toBe("thinking");
    expect(steps[0]?.events).toHaveLength(0);
  });
});

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
  it("binds the exact current page as well as its containing space", () => {
    expect(inferResearchScope({
      siteOrigin: "https://example.atlassian.net",
      question: "Summarize the current page.",
      jiraProjects: "",
      confluenceSpaces: "",
      activeSpaceKey: "DOCS",
      activeEntity: {
        product: "confluence",
        entityKind: "page",
        key: "1001",
        name: "Architecture",
      },
    }).scopeSeeds).toEqual(expect.arrayContaining([
      expect.objectContaining({ binding: expect.objectContaining({ entityKind: "space", key: "DOCS" }) }),
      expect.objectContaining({
        binding: expect.objectContaining({
          entityKind: "page",
          key: "1001",
          entityRef: "research-scope-entity:confluence-page-1001",
          source: "current_context",
          authority: "approved",
        }),
      }),
    ]));
  });

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
  it("renders the compact chat surface and opens an intentionally empty add menu", async () => {
    const port: ResearchPort = {
      hasApiKey: async () => true,
      setApiKey: async () => undefined,
      clearApiKey: async () => undefined,
      resolveScope: async () => {
        throw new Error("not needed for composer controls");
      },
      run: async () => {
        throw new Error("not needed for composer controls");
      },
      copyMarkdown: async () => undefined,
      downloadMarkdown: async () => undefined,
    };
    await dom.render(
      <I18nProvider locale="en">
        <ResearchScreen {...screenProps(port)} />
      </I18nProvider>,
    );

    expect(dom.find("research-chat-composer-shell").className).toContain("rounded-[22px]");
    expect(dom.find("research-chat-composer-shell").className).not.toContain("shadow");
    expect(dom.find("research-settings").className).toContain("hidden");
    expect(dom.find("research-disclosure").parentElement?.textContent).toContain("selected LLM provider");
    expect(dom.find("research-disclosure").parentElement?.textContent).not.toContain("Anthropic");
    expect(dom.maybeFind("research-conversation-menu")).toBeNull();
    await openConversationMenu();
    expect(dom.find("research-conversation-menu").textContent).toContain("New conversation");
    await dom.click("research-conversation-menu-toggle");
    expect(dom.find("research-context-chips").textContent).toContain("Design");
    expect(dom.find("research-context-chips").textContent).not.toContain("confluence: KB");
    expect(dom.find("research-mode-chat").getAttribute("aria-pressed")).toBe("true");
    await dom.click("research-mode-deep");
    expect(dom.find("research-mode-deep").getAttribute("aria-pressed")).toBe("true");
    expect((dom.find("research-effort") as HTMLSelectElement).value).toBe("deep");
    expect((dom.find("research-plan-approval") as HTMLSelectElement).value).toBe("default");
    expect((dom.find("research-reconciliation") as HTMLSelectElement).value).toBe("auto");
    await openConversationMenu();
    await dom.click("research-new-conversation");
    expect(dom.find("research-mode-chat").getAttribute("aria-pressed")).toBe("true");

    expect(dom.maybeFind("research-composer-add-menu")).toBeNull();
    expect(dom.find("research-composer-add-menu-toggle").getAttribute("aria-expanded")).toBe("false");

    await dom.click("research-composer-add-menu-toggle");
    expect(dom.find("research-composer-add-menu").textContent).toContain(
      "Additional context options will appear here.",
    );
    expect(dom.find("research-composer-add-menu-toggle").getAttribute("aria-expanded")).toBe("true");

    await dom.click("research-composer-add-menu-toggle");
    expect(dom.maybeFind("research-composer-add-menu")).toBeNull();
  });

  it("uses the CopilotKit composer for queued follow-ups and checkpointed steering", async () => {
    let releaseRun: ((value: ResearchReportV1) => void) | undefined;
    let pauseCalls = 0;
    let runCalls = 0;
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
      run: async (_request, options) => {
        runCalls += 1;
        options?.onSessionStart?.({ sessionId: "research-session:chat" });
        options?.onEvent?.({
          kind: "phase",
          seq: 1,
          at: "2026-08-03T12:00:00.000Z",
          phase: "researching",
        });
        options?.onEvent?.({
          kind: "capability",
          seq: 2,
          at: "2026-08-03T12:00:01.000Z",
          callId: "wiki.page.get:1",
          toolId: "wiki.page.get",
          inputKind: "detail",
          status: "started",
        });
        if (runCalls > 1) return report;
        return await new Promise<ResearchReportV1>((resolve) => {
          releaseRun = resolve;
        });
      },
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

    expect((dom.find("research-settings") as HTMLDetailsElement).open).toBe(false);
    expect(dom.find("research-chat-welcome").textContent).toContain("Ask a research question");
    await dom.setValue("research-effort", "lookup");
    await dom.toggle("research-disclosure");
    await dom.setValue("copilot-chat-textarea", "How are DEMO-1 and KB related?");
    await dom.click("research-run");
    await dom.flush();
    expect(runCalls).toBe(1);
    expect(dom.find("research-activity").textContent).not.toContain("The selected sources are being investigated");
    expect(dom.find("research-activity").textContent).toContain("is being read");
    expect(dom.find("research-activity").textContent).toContain("loaded for evidence-backed statements");
    expect(dom.find("research-streaming-turn").querySelectorAll('[data-testid="research-active-kite"]')).toHaveLength(1);
    expect(dom.find("research-streaming-turn").querySelectorAll("details")).toHaveLength(0);

    await dom.setValue("copilot-chat-textarea", "Queue a source check after this report.");
    await pressComposerKey("Enter");
    expect(dom.find("research-chat").textContent).toContain("Queued for the current research session.");
    expect(runCalls).toBe(1);

    await dom.setValue("copilot-chat-textarea", "Prioritize linked evidence before synthesis.");
    await pressComposerKey("Enter", { metaKey: true, shiftKey: true });
    expect(pauseCalls).toBe(0);
    expect(dom.find("research-chat").textContent).toContain("Steering will be applied at the next safe checkpoint.");
    expect(dom.find("research-chat").querySelectorAll('[data-testid^="research-queued-edit-"]')).toHaveLength(2);
    expect(dom.find("research-chat").querySelectorAll('[data-testid^="research-queued-remove-"]')).toHaveLength(2);

    releaseRun?.(report);
    await dom.flush(20);
    expect(runCalls).toBe(3);
    expect(dom.find("research-chat-answer").textContent).toContain("The page explicitly links the issue.");
    expect(dom.find("research-streaming-turn").querySelector('[data-testid="research-active-kite"]')).toBeNull();
  });

  it("drains an ordinary queued chat message through the retained session", async () => {
    const retained = {
      schema: "atlcli.research-retained-session/v1" as const,
      sessionId: "research-session:chat-queue",
      revision: 6,
      turnId: "research-turn:initial",
      status: "complete" as const,
      updatedAt: "2026-08-03T10:00:00.000Z",
      question: "How are DEMO-1 and KB related?",
      scope: { jiraProjectKeys: ["DEMO"], confluenceSpaceKeys: ["KB"] },
    };
    const resumable = {
      schema: "atlcli.research-resumable-session/v1" as const,
      sessionId: retained.sessionId,
      revision: 8,
      turnId: "research-turn:follow-up",
      status: "running" as const,
      updatedAt: "2026-08-03T10:01:00.000Z",
      question: "Which source needs another check?",
      scope: retained.scope,
    };
    let releaseInitial: ((value: ResearchReportV1) => void) | undefined;
    let complete = false;
    let resumed = 0;
    const prepared: Array<{ sessionId: string; revision: number; question: string }> = [];
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
      listRetainedSessions: async () => complete ? [retained] : [],
      prepareFollowUpTurn: async (input) => {
        prepared.push(input);
        return { kind: "resumable", session: resumable };
      },
      run: async (_request, options) => {
        options?.onSessionStart?.({ sessionId: retained.sessionId });
        return await new Promise<ResearchReportV1>((resolve) => {
          releaseInitial = (value) => {
            complete = true;
            resolve(value);
          };
        });
      },
      resume: async (sessionId) => {
        expect(sessionId).toBe(retained.sessionId);
        resumed += 1;
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
    await dom.setValue("research-effort", "lookup");
    await dom.toggle("research-disclosure");
    await dom.setValue("copilot-chat-textarea", retained.question);
    await dom.click("research-run");
    await dom.setValue("copilot-chat-textarea", resumable.question);
    await pressComposerKey("Enter");

    releaseInitial?.(report);
    await dom.flush(12);

    expect(prepared).toEqual([{
      sessionId: retained.sessionId,
      revision: retained.revision,
      question: resumable.question,
    }]);
    expect(resumed).toBe(1);
    expect(dom.find("research-chat").textContent).not.toContain("Queued for the current research session.");
  });

  it("lets a queued follow-up be edited or removed without touching the live turn", async () => {
    let releaseRun: ((value: ResearchReportV1) => void) | undefined;
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
      run: async (_request, options) => {
        options?.onSessionStart?.({ sessionId: "research-session:queued-turn" });
        return await new Promise<ResearchReportV1>((resolve) => { releaseRun = resolve; });
      },
      copyMarkdown: async () => undefined,
      downloadMarkdown: async () => undefined,
    };
    await dom.render(
      <I18nProvider locale="en">
        <ResearchScreen {...screenProps(port)} />
      </I18nProvider>,
    );
    await dom.setValue("research-effort", "lookup");
    await dom.toggle("research-disclosure");
    await dom.setValue("copilot-chat-textarea", "How are DEMO-1 and KB related?");
    await dom.click("research-run");
    await dom.setValue("copilot-chat-textarea", "Check source one after the report.");
    await pressComposerKey("Enter");

    await dom.click("research-queued-edit-research-user-turn:2");
    await dom.setValue("research-queued-edit-research-user-turn:2", "Check source two after the report.");
    await dom.click("research-queued-save-research-user-turn:2");
    expect(dom.find("research-chat").textContent).toContain("Check source two after the report.");

    await dom.click("research-queued-remove-research-user-turn:2");
    expect(dom.find("research-chat").textContent).not.toContain("Check source two after the report.");

    releaseRun?.(report);
    await dom.flush();
  });

  it("uses the configured key, infers scope, runs, and renders safe structured output", async () => {
    const stored = true;
    const preflightInputs: ResearchRequestV1[] = [];
    const observed: ResearchRequestV1[] = [];
    const observedPolicies: unknown[] = [];
    const port: ResearchPort = {
      hasApiKey: async () => stored,
      setApiKey: async () => undefined,
      clearApiKey: async () => undefined,
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
          itemLabels: ["Confluence 1001: Design", "Confluence 1002: Delivery notes"],
          complete: false,
          termination: "item-limit",
          resultBytes: 2048,
          truncated: false,
          durationMs: 42,
        });
        options?.onEvent?.({
          kind: "capability",
          seq: 5,
          at: "2026-07-31T12:00:00.000Z",
          callId: "research.candidate.rank:1",
          toolId: "research.candidate.rank",
          inputKind: "ranking",
          status: "completed",
          itemCount: 1,
          itemLabels: ["Confluence 1001: Design"],
        });
        options?.onEvent?.({
          kind: "budget",
          seq: 6,
          at: "2026-07-31T12:00:00.000Z",
          metric: "capability_calls",
          consumed: 1,
          maximum: 32,
        });
        options?.onEvent?.({
          kind: "budget",
          seq: 7,
          at: "2026-07-31T12:00:00.000Z",
          metric: "tokens",
          consumed: 12_500,
          maximum: 224_000,
        });
        options?.onEvent?.({
          kind: "budget",
          seq: 8,
          at: "2026-07-31T12:00:00.000Z",
          metric: "cost_micros",
          consumed: 250_000,
          maximum: 1_250_000,
        });
        options?.onEvent?.({
          kind: "budget",
          seq: 9,
          at: "2026-07-31T12:00:00.000Z",
          metric: "duration_ms",
          consumed: 42_000,
          maximum: 420_000,
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
    expect((dom.find("research-max-run-minutes") as HTMLInputElement).value).toBe("10");
    await dom.setValue(
      "research-question",
      "Nutze Jira Projektkey DEMO und Confluence Spacekey KB: Wie hängen DEMO-1 und Seite 1001 zusammen?"
    );
    await dom.setValue("research-max-cost-usd", "1.25");
    await dom.setValue("research-max-run-minutes", "7");
    await dom.toggle("research-disclosure");
    await dom.click("research-run");
    await dom.flush();

    expect(stored).toBe(true);
    expect(preflightInputs[0]).toMatchObject({
      limits: { maxModelCostMicros: 1_250_000, maxRunMs: 7 * 60_000 },
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: [],
        confluenceSpaceKeys: ["KB"],
      },
      scopeSeeds: [
        { binding: { key: "KB", source: "current_context", authority: "approved" }, precedence: 300 },
        { binding: { key: "1001", entityKind: "page", source: "current_context", authority: "approved" }, precedence: 300 },
      ],
    });
    expect(observed[0]!.scope).toMatchObject({
      siteOrigin: "https://example.atlassian.net",
      jiraProjectKeys: ["DEMO"],
      confluenceSpaceKeys: ["KB"],
    });
    expect(dom.find("research-model-cost-summary").textContent).toContain("1.25");
    expect(dom.find("research-max-runtime-summary").textContent).toContain("7");
    expect(dom.maybeFind("research-live-budget")).toBeNull();
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
      requestedEffort: "lookup",
      requestedPlanApproval: "automatic",
      scopeExpansionMode: "ask",
      requestedReconciliation: "off",
    });
    expect(dom.find("research-chat-answer").textContent).toContain(
      "The page explicitly links the issue."
    );
    expect(dom.find("research-activity").textContent).toContain("Gefunden: Confluence 1001: Design");
    expect(dom.find("research-activity").textContent).toContain("Für das detaillierte Lesen ausgewählt: Confluence 1001: Design");
    expect(dom.find("research-activity").textContent).not.toContain("research-task:1");
    expect(dom.find("research-activity").textContent).not.toContain("capability_calls");
    expect(dom.find("research-activity").textContent).not.toContain("2048");
    await dom.toggle("research-current-context");
    await dom.setValue(
      "copilot-chat-textarea",
      "Nutze Jira Projektkey DEMO und Confluence Spacekey KB: Wie hängen DEMO-1 und Seite 1001 zusammen?",
    );
    await dom.click("research-run");
    await dom.flush();
    expect(preflightInputs[1]!.scopeSeeds?.some(
      (seed) => seed.binding.source === "current_context" && seed.binding.entityKind === "page",
    )).toBe(false);
    expect(preflightInputs[1]!.scopeSeeds?.some(
      (seed) => seed.binding.source === "current_context" && seed.binding.entityKind === "space",
    )).toBe(true);
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
    expect(dom.find("research-error-diagnostics").textContent)
      .toContain("The run stopped before a validated answer could be published.");

    await dom.setValue("research-max-cost-usd", "2");
    await dom.setValue("research-max-run-minutes", "11");
    await dom.click("research-run");
    await dom.flush();

    expect({ scopeCalls, runCalls }).toEqual({ scopeCalls: 0, runCalls: 0 });
    expect(dom.find("research-error").textContent)
      .toContain("Enter a maximum run time from 1 to 10 whole minutes.");
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
    expect(dom.find("research-run").getAttribute("aria-label")).toBe("Stop run");
    expect(dom.find("research-run").className).toContain("bg-destructive");

    await dom.click("research-pause");
    expect(pauseCalls).toBe(1);
    expect(dom.find("research-action-status").textContent).toContain(
      "Pause requested — finishing the current retrieval wave.",
    );
    expect((dom.find("research-pause") as HTMLButtonElement).disabled).toBe(true);
  });

  it("stops an active chat run from the composer", async () => {
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
      run: async (_request, options) => new Promise<ResearchReportV1>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      }),
      copyMarkdown: async () => undefined,
      downloadMarkdown: async () => undefined,
    };
    await dom.render(
      <I18nProvider locale="en">
        <ResearchScreen {...screenProps(port)} />
      </I18nProvider>,
    );
    await dom.setValue("research-question", "Summarize the attached page.");
    await dom.toggle("research-disclosure");
    await dom.click("research-run");
    await dom.flush();
    await dom.click("research-run");
    await dom.flush();

    expect(dom.find("research-action-status").textContent).toContain("Research was stopped.");
    expect(dom.maybeFind("research-error")).toBeNull();
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

    await openConversationMenu();
    expect(dom.find("research-resumable-sessions").textContent)
      .toContain("Continue the interrupted research.");
    expect((dom.find("research-resume-0") as HTMLButtonElement).disabled).toBe(true);
    await dom.toggle("research-disclosure");
    await dom.click("research-resume-0");
    await dom.flush();

    expect(resumed).toEqual(["research-session:resume"]);
    expect(dom.find("research-activity").textContent).not.toContain(
      "The selected sources are being investigated",
    );
    expect(dom.find("research-chat-answer").textContent)
      .toContain("The page explicitly links the issue.");
  });

  it("prepares a terminal-session follow-up without starting a provider run", async () => {
    const retained = {
      schema: "atlcli.research-retained-session/v1" as const,
      sessionId: "research-session:terminal",
      revision: 12,
      turnId: "research-turn:terminal",
      status: "complete" as const,
      updatedAt: "2026-08-02T12:00:00.000Z",
      question: "What did the first research turn establish?",
      scope: { jiraProjectKeys: ["DEMO"], confluenceSpaceKeys: ["KB"] },
    };
    const resumed = {
      schema: "atlcli.research-resumable-session/v1" as const,
      sessionId: retained.sessionId,
      revision: 16,
      turnId: "research-turn:follow-up",
      status: "running" as const,
      updatedAt: "2026-08-02T12:01:00.000Z",
      question: "Which evidence is still missing?",
      scope: retained.scope,
    };
    const prepared: Array<{ sessionId: string; revision: number; question: string }> = [];
    let retainedListing = 0;
    let resumables: typeof resumed[] = [];
    const port: ResearchPort = {
      hasApiKey: async () => false,
      setApiKey: async () => undefined,
      clearApiKey: async () => undefined,
      resolveScope: async (request) => ({
        schema: "atlcli.research-scope-preflight-outcome/v1",
        kind: "ready",
        request,
        mentions: [],
        resolutions: [],
      }),
      listRetainedSessions: async () => (++retainedListing === 1 ? [retained] : []),
      listResumableSessions: async () => resumables,
      prepareFollowUpTurn: async (input) => {
        prepared.push(input);
        resumables = [resumed];
        return { kind: "resumable", session: resumed };
      },
      run: async () => {
        throw new Error("A follow-up preparation must not start the provider.");
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

    await openConversationMenu();
    expect(dom.find("research-retained-sessions").textContent)
      .toContain("What did the first research turn establish?");
    await dom.setValue("research-follow-up-question-0", resumed.question);
    await dom.click("research-follow-up-prepare-0");
    await dom.flush();

    expect(prepared).toEqual([{
      sessionId: retained.sessionId,
      revision: retained.revision,
      question: resumed.question,
    }]);
    expect(dom.find("research-resumable-sessions").textContent).toContain(resumed.question);
    expect(dom.find("research-action-status").textContent)
      .toContain("Follow-up prepared. Review its plan or resume it when ready.");
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

    await openConversationMenu();
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

  it("shows the shared deep-plan stop before calling the provider", async () => {
    let keyWrites = 0;
    let runs = 0;
    const policies: unknown[] = [];
    const port: ResearchPort = {
      hasApiKey: async () => true,
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
    await dom.setValue(
      "research-question",
      "Perform exhaustive contradiction analysis for Jira project DEMO and Confluence space KB.",
    );
    await dom.click("research-mode-deep");
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
    await dom.setValue(
      "copilot-chat-textarea",
      "Perform exhaustive contradiction analysis for Jira project DEMO and Confluence space KB.",
    );
    await dom.click("research-run");
    await dom.flush();
    expect({ keyWrites, runs }).toEqual({ keyWrites: 0, runs: 1 });
    expect(policies[0]).toMatchObject({
      requestedEffort: "deep",
      requestedPlanApproval: "automatic",
    });
    expect(dom.find("research-formatted-report").textContent).toContain(
      "The page explicitly links the issue.",
    );
  });

  it("persists an initial deep plan for review before retrieval", async () => {
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
        timeWindow: { from: "2026-07-01", to: "2026-08-02" },
        scopeBindings: [{
          id: "scope-binding:cli-demo",
          product: "jira",
          entityKind: "project",
          key: "DEMO",
          name: "Demo project",
          source: "cli_flag",
          authority: "locked",
        }],
        coverageTargets: [{
          id: "coverage:primary",
          required: true,
          sourceClasses: ["jira", "confluence"],
          minimumDistinctSources: 2,
        }],
        replanEnvelope: {
          optionalRoleIds: ["coverage-moderator"],
          allowedCapabilityIds: ["jira.issue.search", "jira.issue.get", "wiki.search"],
          maxParallelNodes: 3,
          maxResearchWaves: 3,
          maxReconciliationWaves: 1,
        },
        budget: {
          maxPtcCalls: 32,
          maxHttpCalls: 32,
          maxModelCalls: 16,
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
    await dom.setValue(
      "research-question",
      "Perform exhaustive contradiction analysis for Jira project DEMO and Confluence space KB.",
    );
    await dom.click("research-mode-deep");
    await dom.toggle("research-disclosure");
    await dom.click("research-run");
    await dom.flush();

    expect(prepared).toHaveLength(1);
    expect({ keyWrites, runs }).toEqual({ keyWrites: 0, runs: 0 });
    expect(dom.find("research-plan-reviews").textContent).toContain("reconciler");
    expect(dom.find("research-plan-review-budget-0").textContent)
      .toContain("$2.00");
    expect(dom.find("research-plan-review-time-window-0").textContent)
      .toContain("2026-07-01 → 2026-08-02");
    expect(dom.find("research-plan-review-bindings-0").textContent)
      .toContain("DEMO (locked, cli_flag)");
    expect(dom.find("research-plan-review-coverage-0").textContent)
      .toContain("coverage:primary [jira/confluence; ≥2]");
    expect(dom.find("research-plan-review-replan-envelope-0").textContent)
      .toContain("coverage-moderator");
    await dom.click("research-plan-review-approve-0");
    await dom.flush();

    expect(approvals).toEqual([{
      sessionId: review.sessionId,
      revision: 4,
      briefRevision: 1,
      graphRevision: 1,
    }]);
    expect({ keyWrites, runs }).toEqual({ keyWrites: 0, runs: 0 });
    await openConversationMenu();
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
    await dom.click("research-mode-deep");
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

  it("persists and resolves an initial clarification before retrieval", async () => {
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
    await dom.click("research-mode-deep");
    await dom.setValue(
      "research-question",
      "How is the current Jira work in DEMO related to Confluence space KB?",
    );
    await dom.toggle("research-disclosure");
    await dom.click("research-run");
    await dom.flush();

    expect({ keyWrites, runs }).toEqual({ keyWrites: 0, runs: 0 });
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
    await openConversationMenu();
    expect(dom.find("research-resumable-sessions").textContent)
      .toContain("Synthetic durable clarification question.");
  });

  it("does not turn a normal chat question into a deep-research clarification", async () => {
    let preparedClarifications = 0;
    let runs = 0;
    let submitted: ResearchRequestV1 | undefined;
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
      prepareClarificationReview: async () => {
        preparedClarifications += 1;
        throw new Error("Chat mode must not prepare a deep-research clarification.");
      },
      run: async (request, options) => {
        runs += 1;
        submitted = request;
        options?.onEvent?.({
          kind: "capability",
          seq: 1,
          at: "2026-08-03T12:00:00.000Z",
          callId: "wiki.search:1",
          toolId: "wiki.search",
          inputKind: "search",
          status: "completed",
          itemCount: 1,
          itemLabels: ["Confluence 1001: Design"],
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
    await dom.toggle("research-disclosure");
    await dom.setValue(
      "copilot-chat-textarea",
      "What is the attached page about?",
    );
    await dom.click("research-run");
    await dom.flush();

    expect({ preparedClarifications, runs }).toEqual({ preparedClarifications: 0, runs: 1 });
    expect(submitted?.exactContextProducts).toEqual(["confluence"]);
    expect(submitted?.scope.confluenceSpaceKeys).toEqual(["KB"]);
    expect(dom.maybeFind("research-clarification-reviews")).toBeNull();
    expect(dom.find("research-activity").textContent).toContain(
      "The page ID was taken directly from the attached context; no Confluence search was run.",
    );
    expect(dom.find("research-activity").textContent).not.toContain("Confluence search returned");
    expect(dom.find("research-chat-answer").textContent).toContain(
      "The page explicitly links the issue.",
    );
  });

  it("persists a scope choice and resolves it without retrieval", async () => {
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
    await openConversationMenu();
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

  it("shows typed scope clarification before starting research", async () => {
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
      hasApiKey: async () => true,
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
    expect({ keyWrites, runs }).toEqual({ keyWrites: 0, runs: 1 });
    expect(dom.find("research-submitted-scope").textContent).toContain(
      "confluence:ACCOUNT2",
    );
  });
});
