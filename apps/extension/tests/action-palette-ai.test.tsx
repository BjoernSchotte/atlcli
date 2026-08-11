import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import React from "react";
import {
  ACTION_IDS,
  createActionCatalog,
  type ActionExecutionRequestV1,
  type ActionResultV1,
} from "@atlcli/action-registry";
import {
  ActionPaletteV1,
  type ActionPaletteExecuteRequestV1,
  type ActionPaletteExecutorV1,
} from "@atlcli/action-palette-react";
import {
  ChatUserQuestionRequiredError,
  ResearchContractError,
  type ChatAnswerV1,
} from "@atlcli/research";
import {
  createActionPaletteQuickAiExecutorV1,
  prepareActionPaletteQuickAiV1,
  type QuickAiMetricV1,
} from "../utils/action-palette/quick-ai.js";
import {
  EXTENSION_ACTION_CAPABILITIES_V1,
  EXTENSION_ACTION_MODULES_V1,
} from "../utils/action-palette/catalog.js";
import {
  ActionPaletteContextError,
  type ActionPaletteContextBindingV1,
} from "../utils/action-palette/context.js";
import { isActionPaletteRequestV1 } from "../utils/action-palette/protocol.js";
import type { BrowserChatTurnPortV1 } from "../utils/research/chat-turn-port.js";
import { createPaletteReactHarness } from "../../../packages/action-palette-react/src/testing/react-harness.js";

const siteOrigin = "https://fixture.atlassian.net";
const pageUrl = `${siteOrigin}/wiki/spaces/DOC/pages/42/Guide`;
const binding: ActionPaletteContextBindingV1 = {
  tabId: 4,
  documentId: "doc-1",
  frameId: 0,
  origin: siteOrigin,
  url: pageUrl,
};

function execution(input: Readonly<Record<string, string>> = {
  question: "What changed?",
  disclosure: "true",
}): ActionExecutionRequestV1 {
  return {
    schemaVersion: 1,
    requestId: "quick:1",
    actionId: ACTION_IDS.quickAsk,
    intent: { kind: "ai.quick-ask" },
    context: {
      siteOrigin,
      product: "confluence",
      entity: {
        kind: "atlcli.entity.confluence-page",
        id: "42",
        key: "DOC",
        title: "Guide",
        url: pageUrl,
      },
      locale: "en-US",
      capabilities: [EXTENSION_ACTION_CAPABILITIES_V1.ai],
    },
    input,
  };
}

function answer(overrides: Partial<ChatAnswerV1> = {}): ChatAnswerV1 {
  return {
    schema: "atlcli.chat-answer/v1",
    messageMarkdown: "A bounded answer.",
    citations: [],
    evidenceRefs: [],
    gaps: [],
    strategy: {
      qualityMode: "quick",
      path: "direct",
      delegated: false,
      reasonCode: "quick-direct",
      reasonCodes: ["single-exact-context"],
      ambiguityDisposition: "none",
      requiredCapabilities: ["exact-read"],
      expectedComplexity: "simple",
      qualityRisks: [],
    },
    run: {
      model: "fixture-model",
      startedAt: "2026-08-12T08:00:00.000Z",
      completedAt: "2026-08-12T08:00:01.000Z",
      durationMs: 1_000,
      counts: { ptcCalls: 0, httpCalls: 1, jiraItems: 0, confluenceItems: 1 },
    },
    ...overrides,
  };
}

function chat(
  startTurn: BrowserChatTurnPortV1["startTurn"],
): BrowserChatTurnPortV1 {
  return {
    startTurn,
    execute: (input, stream) => startTurn(input, stream),
    stop: async () => "stopped",
  };
}

function executorWith(input: {
  hasProvider?: () => Promise<boolean>;
  startTurn?: BrowserChatTurnPortV1["startTurn"];
  metrics?: QuickAiMetricV1[];
  conversationId?: string;
}) {
  let chatCreations = 0;
  const metrics = input.metrics ?? [];
  const executor = createActionPaletteQuickAiExecutorV1({
    hasProvider: input.hasProvider ?? (async () => true),
    getConversationId: async () => input.conversationId,
    createChat() {
      chatCreations += 1;
      return chat(input.startTurn ?? (async (_request, stream) => {
        stream?.onSessionStart?.({
          conversationId: "research-session:quick-1",
          turnId: "research-turn:quick-1",
        });
        return answer();
      }));
    },
    observe: (metric) => metrics.push(metric),
    now: () => 1_000,
  });
  return { executor, metrics, chatCreations: () => chatCreations };
}

const assertCurrent = async (): Promise<ActionPaletteContextBindingV1> => binding;
const ignoreStream = async (): Promise<void> => undefined;

describe("action palette bounded Quick AI", () => {
  test("projects only the current exact Atlassian scope and rejects sensitive protocol fields", () => {
    const prepared = prepareActionPaletteQuickAiV1(execution());
    expect(prepared.product).toBe("confluence");
    expect(prepared.request.scope).toEqual({
      siteOrigin,
      jiraProjectKeys: [],
      confluenceSpaceKeys: ["DOC"],
    });
    expect(prepared.request.limits).toMatchObject({
      maxRunMs: 60_000,
      maxReportChars: 6_000,
      maxModelOutputTokens: 2_048,
      maxModelCostMicros: 250_000,
    });
    expect(JSON.stringify(prepared)).not.toContain("Private page body");

    const jira = prepareActionPaletteQuickAiV1({
      ...execution(),
      context: {
        ...execution().context,
        product: "jira",
        entity: {
          kind: "atlcli.entity.jira-issue",
          id: "ATLCLI-19",
          key: "ATLCLI-19",
          title: "Issue",
          url: `${siteOrigin}/browse/ATLCLI-19`,
        },
      },
    });
    expect(jira.request.scope).toMatchObject({ jiraProjectKeys: ["ATLCLI"], confluenceSpaceKeys: [] });

    for (const field of ["apiKey", "pageBody", "workspace", "researchRequest", "providerCredential"]) {
      expect(isActionPaletteRequestV1({
        kind: "action-palette:execute",
        requestId: "quick:wire",
        catalogRevision: "revision:1",
        actionId: ACTION_IDS.quickAsk,
        locale: "en-US",
        input: { question: "Why?", disclosure: "true" },
        [field]: "must-not-cross",
      })).toBe(false);
    }
  });

  test("does no Chat work after disclosure refusal or when the provider is unavailable", async () => {
    let providerChecks = 0;
    const refused = executorWith({
      hasProvider: async () => { providerChecks += 1; return true; },
    });
    await expect(refused.executor(
      execution({ question: "Why?", disclosure: "false" }),
      new AbortController().signal,
      assertCurrent,
      ignoreStream,
    )).rejects.toThrow("disclosure confirmation");
    expect(providerChecks).toBe(0);
    expect(refused.chatCreations()).toBe(0);

    const unavailable = executorWith({ hasProvider: async () => false });
    expect(await unavailable.executor(
      execution(),
      new AbortController().signal,
      assertCurrent,
      ignoreStream,
    )).toMatchObject({ status: "failed", errorCode: "atlcli.ai.provider-unavailable" });
    expect(unavailable.chatCreations()).toBe(0);
  });

  test("streams a bounded non-live-region answer and emits body-free metrics", async () => {
    const events: unknown[] = [];
    const metrics: QuickAiMetricV1[] = [];
    const fixture = executorWith({
      metrics,
      startTurn: async (_request, stream) => {
        stream?.onSessionStart?.({
          conversationId: "research-session:quick-stream",
          turnId: "research-turn:quick-stream",
        });
        stream?.onPresentation?.({
          kind: "chat-presentation",
          seq: 1,
          at: "2026-08-12T08:00:00.000Z",
          channel: "answer-markdown",
          status: "delta",
          delta: "Provisional answer",
        });
        return answer({ messageMarkdown: "Validated answer" });
      },
    });
    const result = await fixture.executor(
      execution({ question: "tenant prompt sentinel", disclosure: "true" }),
      new AbortController().signal,
      assertCurrent,
      async (event) => { events.push(event); },
    );
    expect(events).toEqual([{ sequence: 1, status: "delta", delta: "Provisional answer" }]);
    expect(result).toMatchObject({
      status: "completed",
      presentation: { kind: "markdown", text: "Validated answer", truncated: false },
      actions: [{ id: ACTION_IDS.openResearch }],
    });
    expect(JSON.stringify(metrics)).not.toContain("tenant prompt sentinel");
    expect(metrics).toEqual([
      { phase: "started", product: "confluence" },
      { phase: "completed", product: "confluence", durationMs: 0, outputChars: 16 },
    ]);
  });

  test("hands clarification and evidence-rich answers to the typed Research continuation", async () => {
    const clarification = executorWith({
      startTurn: async (_request, stream) => {
        stream?.onSessionStart?.({
          conversationId: "research-session:clarify",
          turnId: "research-turn:clarify",
        });
        throw new ChatUserQuestionRequiredError({
          schema: "atlcli.chat-user-question/v1",
          id: "question:1",
          prompt: "Which release?",
          required: true,
          responseKind: "free_text",
          maxLength: 200,
        });
      },
    });
    expect(await clarification.executor(
      execution(),
      new AbortController().signal,
      assertCurrent,
      ignoreStream,
    )).toMatchObject({
      status: "open-surface",
      target: {
        kind: "sidebar",
        screen: "research",
        continuationId: "research-session:clarify",
      },
    });

    const cited = executorWith({
      conversationId: "research-session:cited",
      startTurn: async () => answer({
        citations: [{ sourceId: "wiki:42", title: "Guide", url: pageUrl, product: "confluence" }],
        evidenceRefs: ["wiki:42"],
      }),
    });
    expect(await cited.executor(
      execution(),
      new AbortController().signal,
      assertCurrent,
      ignoreStream,
    )).toMatchObject({
      status: "open-surface",
      target: { continuationId: "research-session:cited" },
    });

    for (const code of [
      "plan-approval-required",
      "scope-approval-required",
      "limit-exceeded",
    ] as const) {
      const approval = executorWith({
        startTurn: async (_request, stream) => {
          stream?.onSessionStart?.({
            conversationId: `research-session:${code}`,
            turnId: `research-turn:${code}`,
          });
          throw new ResearchContractError(code, "Host-owned handoff required.");
        },
      });
      expect(await approval.executor(
        execution(),
        new AbortController().signal,
        assertCurrent,
        ignoreStream,
      )).toMatchObject({
        status: "open-surface",
        target: { continuationId: `research-session:${code}` },
      });
    }

    const long = executorWith({
      conversationId: "research-session:long",
      startTurn: async () => answer({ messageMarkdown: "x".repeat(6_001) }),
    });
    expect(await long.executor(
      execution(),
      new AbortController().signal,
      assertCurrent,
      ignoreStream,
    )).toMatchObject({
      status: "open-surface",
      target: { continuationId: "research-session:long" },
    });
  });

  test("contains permission and stream failures, rechecks stale pages, and propagates explicit cancel", async () => {
    for (const [error, code] of [
      [new ResearchContractError("access-denied", "private tenant detail"), "atlcli.ai.access-denied"],
      [new Error("stream secret"), "atlcli.ai.provider-error"],
    ] as const) {
      const fixture = executorWith({ startTurn: async () => { throw error; } });
      const result = await fixture.executor(
        execution(),
        new AbortController().signal,
        assertCurrent,
        ignoreStream,
      );
      expect(result).toMatchObject({ status: "failed", errorCode: code });
      expect(JSON.stringify(result)).not.toContain("private tenant detail");
      expect(JSON.stringify(result)).not.toContain("stream secret");
    }

    let guardCalls = 0;
    const stale = executorWith({ conversationId: "research-session:stale" });
    await expect(stale.executor(
      execution(),
      new AbortController().signal,
      async () => {
        guardCalls += 1;
        if (guardCalls === 2) throw new ActionPaletteContextError("stale-context");
        return binding;
      },
      ignoreStream,
    )).rejects.toMatchObject({ code: "stale-context" });

    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const cancelled = executorWith({
      startTurn: async (_request, stream) => new Promise<ChatAnswerV1>((_resolve, reject) => {
        markStarted?.();
        stream?.signal?.addEventListener("abort", () => reject(
          new ResearchContractError("cancelled", "cancelled"),
        ), { once: true });
      }),
    });
    const pending = cancelled.executor(execution(), controller.signal, assertCurrent, ignoreStream);
    await started;
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    expect(cancelled.metrics.at(-1)).toEqual({ phase: "cancelled", product: "confluence" });
  });
});

const dom = createPaletteReactHarness();
beforeEach(() => dom.setup());
afterEach(() => dom.teardown());
afterAll(() => expect(dom.leakedGlobals()).toEqual([]));

describe("action palette Quick AI presenter", () => {
  test("does no execution before explicit Submit, shows context/disclosure, streams quietly, and separates close from Cancel", async () => {
    const catalog = createActionCatalog(EXTENSION_ACTION_MODULES_V1, {
      ...execution().context,
      capabilities: [
        EXTENSION_ACTION_CAPABILITIES_V1.ai,
        EXTENSION_ACTION_CAPABILITIES_V1.surface,
      ],
    });
    const calls: ActionPaletteExecuteRequestV1[] = [];
    const signals: AbortSignal[] = [];
    let cancelCalls = 0;
    let closeCalls = 0;
    const executor: ActionPaletteExecutorV1 = {
      async execute(request, signal, onStream): Promise<ActionResultV1> {
        calls.push(request);
        signals.push(signal);
        onStream?.({ sequence: 1, status: "delta", delta: "Quiet stream" });
        return await new Promise<ActionResultV1>(() => undefined);
      },
      async cancel() { cancelCalls += 1; },
    };
    await dom.render(
      <ActionPaletteV1
        open
        catalog={catalog}
        executor={executor}
        contextLabel="Confluence · Guide"
        lifecycle={{
          onCloseRequested: () => { closeCalls += 1; },
        }}
      />,
    );
    await dom.click(`palette-option-${ACTION_IDS.quickAsk}`);
    expect(calls).toHaveLength(0);
    expect(dom.find("palette-input-form").textContent).toContain("Confluence · Guide");
    expect(dom.find("palette-input-form").textContent).toContain("selected LLM provider");
    await dom.setValue("palette-input-question", "Summarize this context");
    await dom.keyDown("palette-input-question", "Enter", { ctrlKey: true });
    expect(calls).toHaveLength(0);
    await dom.click("palette-input-disclosure");
    await dom.keyDown("palette-input-question", "Enter", { ctrlKey: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual({
      question: "Summarize this context",
      disclosure: "true",
    });
    expect(dom.find("palette-stream-text").textContent).toBe("Quiet stream");
    expect(dom.find("palette-stream-text").getAttribute("aria-live")).toBe("off");

    await dom.keyDown("palette-executing", "Escape");
    expect(closeCalls).toBe(1);
    expect(cancelCalls).toBe(0);
    expect(signals[0]?.aborted).toBe(true);
  });

  test("uses the separate explicit Cancel control", async () => {
    const catalog = createActionCatalog(EXTENSION_ACTION_MODULES_V1, {
      ...execution().context,
      capabilities: [EXTENSION_ACTION_CAPABILITIES_V1.ai],
    });
    let cancelCalls = 0;
    const executor: ActionPaletteExecutorV1 = {
      async execute() { return await new Promise<ActionResultV1>(() => undefined); },
      async cancel() { cancelCalls += 1; },
    };
    await dom.render(<ActionPaletteV1 open catalog={catalog} executor={executor} />);
    await dom.click(`palette-option-${ACTION_IDS.quickAsk}`);
    await dom.setValue("palette-input-question", "Summarize this context");
    await dom.click("palette-input-disclosure");
    await dom.keyDown("palette-input-question", "Enter", { ctrlKey: true });
    const cancel = [...dom.find("palette-executing").querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Cancel"),
    ) as HTMLButtonElement;
    cancel.click();
    await dom.flush();
    expect(cancelCalls).toBe(1);
  });
});
