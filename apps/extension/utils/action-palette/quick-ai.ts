import {
  ACTION_IDS,
  type ActionAffordanceV1,
  type ActionExecutionRequestV1,
  type ActionResultV1,
} from "@atlcli/action-registry";
import {
  ChatUserQuestionRequiredError,
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  ResearchContractError,
  applyChatQualityResourcePolicyV1,
  chatQualityPolicyForModeV1,
  normalizeResearchRequestV1,
  prepareDirectChatRequestV1,
  type ChatPresentationStreamEventV1,
  type ResearchRequestV1,
} from "@atlcli/research";
import {
  createResearchEntityScopeSeedV1,
  createResearchKeyScopeSeedV1,
} from "@atlcli/research/scope-discovery";
import {
  ActionPaletteContextError,
  type ActionPaletteContextBindingV1,
} from "./context.js";
import type {
  ActionPaletteExecutionStreamV1,
  ActionPaletteExecutorEntryV1,
} from "./background-host.js";
import type { BrowserChatTurnPortV1 } from "../research/chat-turn-port.js";
import { EXTENSION_ACTION_CAPABILITIES_V1 } from "./catalog.js";

const MAX_QUICK_ANSWER_CHARS = 6_000;

export interface QuickAiMetricV1 {
  readonly phase: "started" | "completed" | "handoff" | "failed" | "cancelled";
  readonly product: "confluence" | "jira";
  readonly durationMs?: number;
  readonly outputChars?: number;
  readonly errorCode?: string;
}

export interface ActionPaletteQuickAiDepsV1 {
  hasProvider(): Promise<boolean>;
  createChat(binding: ActionPaletteContextBindingV1): BrowserChatTurnPortV1;
  getConversationId(): Promise<string | undefined>;
  observe?(metric: QuickAiMetricV1): void;
  now?: () => number;
}

function projectCurrentScope(request: ActionExecutionRequestV1): {
  product: "confluence" | "jira";
  projectKeys: string[];
  spaceKeys: string[];
  seeds: ResearchRequestV1["scopeSeeds"];
} {
  const entity = request.context.entity;
  if (request.context.product === "confluence" &&
      entity?.kind === "atlcli.entity.confluence-page" && entity.key) {
    return {
      product: "confluence",
      projectKeys: [],
      spaceKeys: [entity.key],
      seeds: [
        createResearchKeyScopeSeedV1({
          tenantOrigin: request.context.siteOrigin,
          product: "confluence",
          key: entity.key,
          source: "current_context",
          authority: "approved",
        }),
        createResearchEntityScopeSeedV1({
          tenantOrigin: request.context.siteOrigin,
          product: "confluence",
          entityKind: "page",
          key: entity.id,
          name: entity.title ?? entity.id,
          source: "current_context",
          authority: "approved",
        }),
      ],
    };
  }
  if (request.context.product === "jira" && entity?.kind === "atlcli.entity.jira-issue") {
    const issueKey = entity.key ?? entity.id;
    const projectKey = issueKey.replace(/-[1-9][0-9]*$/u, "");
    if (projectKey === issueKey) throw new ResearchContractError("invalid-request", "The Jira issue key is invalid.");
    return {
      product: "jira",
      projectKeys: [projectKey],
      spaceKeys: [],
      seeds: [
        createResearchKeyScopeSeedV1({
          tenantOrigin: request.context.siteOrigin,
          product: "jira",
          key: projectKey,
          source: "current_context",
          authority: "approved",
        }),
        createResearchEntityScopeSeedV1({
          tenantOrigin: request.context.siteOrigin,
          product: "jira",
          entityKind: "issue",
          key: issueKey,
          name: entity.title ?? issueKey,
          source: "current_context",
          authority: "approved",
        }),
      ],
    };
  }
  throw new ResearchContractError(
    "not-atlassian",
    "Quick AI requires a current Confluence page or Jira issue.",
  );
}

/** Pure, host-neutral request/policy projection shared by every palette invocation. */
export function prepareActionPaletteQuickAiV1(
  request: ActionExecutionRequestV1,
): { request: ResearchRequestV1; product: "confluence" | "jira" } {
  const question = request.input?.question?.trim() ?? "";
  if (!question || request.input?.disclosure !== "true") {
    throw new ResearchContractError(
      "invalid-request",
      "Quick AI requires a prompt and per-invocation disclosure confirmation.",
    );
  }
  const scope = projectCurrentScope(request);
  const prepared = normalizeResearchRequestV1({
    schema: RESEARCH_REQUEST_SCHEMA_V1,
    question,
    scope: {
      siteOrigin: request.context.siteOrigin,
      jiraProjectKeys: scope.projectKeys,
      confluenceSpaceKeys: scope.spaceKeys,
    },
    scopeSeeds: scope.seeds,
    reportLanguage: request.context.locale.toLowerCase().startsWith("de") ? "de" : "en",
    limits: {
      ...DEFAULT_RESEARCH_LIMITS_V1,
      maxRunMs: 60_000,
      maxReportChars: MAX_QUICK_ANSWER_CHARS,
      maxModelOutputTokens: 2_048,
      maxModelCostMicros: 250_000,
    },
    wikiProvider: "rest",
  });
  return {
    request: prepareDirectChatRequestV1(
      applyChatQualityResourcePolicyV1(prepared, "quick"),
    ),
    product: scope.product,
  };
}

function continueInResearch(continuationId: string): ActionAffordanceV1 {
  return {
    schemaVersion: 1,
    id: ACTION_IDS.openResearch,
    title: {
      key: "atlcli.action.quick-ask.continue",
      fallback: "Continue in Research",
    },
    intent: {
      kind: "surface.open",
      target: { kind: "sidebar", screen: "research", continuationId },
    },
    requirements: [{
      kind: "capability",
      capability: EXTENSION_ACTION_CAPABILITIES_V1.surface,
    }],
    effect: "external-navigation",
  };
}

function handoff(continuationId: string): ActionResultV1 {
  return {
    status: "open-surface",
    target: { kind: "sidebar", screen: "research", continuationId },
    actions: [continueInResearch(continuationId)],
  };
}

const HANDOFF_CODES = new Set([
  "plan-approval-required",
  "scope-approval-required",
  "clarification-required",
  "limit-exceeded",
]);

export function createActionPaletteQuickAiExecutorV1(
  deps: ActionPaletteQuickAiDepsV1,
): ActionPaletteExecutorEntryV1["execute"] {
  const now = deps.now ?? Date.now;
  return async (execution, signal, assertContextCurrent, emit) => {
    signal.throwIfAborted();
    const prepared = prepareActionPaletteQuickAiV1(execution);
    if (!await deps.hasProvider()) {
      return {
        status: "failed",
        errorCode: "atlcli.ai.provider-unavailable",
        messageKey: "atlcli.action.quick-ask.provider-unavailable",
        retryable: false,
      };
    }
    const binding = await assertContextCurrent();
    signal.throwIfAborted();
    const startedAt = now();
    deps.observe?.({ phase: "started", product: prepared.product });
    let continuationId = await deps.getConversationId();
    const chat = deps.createChat(binding);
    let streamedChars = 0;
    let streamQueue = Promise.resolve();
    const queueStream = (event: ActionPaletteExecutionStreamV1): void => {
      streamQueue = streamQueue.then(() => emit(event)).catch(() => undefined);
    };
    const forward = (event: ChatPresentationStreamEventV1): void => {
      if (!event || event.channel !== "answer-markdown") return;
      if (event.status === "delta" && event.delta) {
        const delta = event.delta.slice(0, Math.max(0, MAX_QUICK_ANSWER_CHARS - streamedChars));
        if (!delta) return;
        streamedChars += delta.length;
        queueStream({ sequence: event.seq, status: "delta", delta });
      } else if (event.status === "reset") {
        streamedChars = 0;
        queueStream({ sequence: event.seq, status: "reset" });
      } else {
        queueStream({ sequence: event.seq, status: event.status });
      }
    };
    try {
      const answer = await chat.startTurn({
        request: prepared.request,
        qualityPolicy: chatQualityPolicyForModeV1("quick"),
        ...(continuationId ? { conversationId: continuationId } : {}),
      }, {
        signal,
        onSessionStart(session) { continuationId = session.conversationId; },
        onPresentation: forward,
      });
      await streamQueue;
      await assertContextCurrent();
      if (!continuationId) throw new ResearchContractError("invalid-report", "Chat returned no continuation identity.");
      const requiresHandoff = answer.messageMarkdown.length > MAX_QUICK_ANSWER_CHARS ||
        answer.citations.length > 0 || answer.gaps.length > 0 || answer.strategy.delegated;
      deps.observe?.({
        phase: requiresHandoff ? "handoff" : "completed",
        product: prepared.product,
        durationMs: now() - startedAt,
        outputChars: Math.min(answer.messageMarkdown.length, MAX_QUICK_ANSWER_CHARS),
      });
      if (requiresHandoff) return handoff(continuationId);
      return {
        status: "completed",
        messageKey: "atlcli.action.quick-ask.completed",
        presentation: {
          kind: "markdown",
          text: answer.messageMarkdown,
          truncated: false,
        },
        actions: [continueInResearch(continuationId)],
      };
    } catch (error) {
      if (error instanceof ActionPaletteContextError) throw error;
      if (signal.aborted) {
        deps.observe?.({ phase: "cancelled", product: prepared.product });
        throw error;
      }
      if (error instanceof ChatUserQuestionRequiredError) {
        continuationId ??= await deps.getConversationId();
        if (continuationId) {
          deps.observe?.({ phase: "handoff", product: prepared.product });
          return handoff(continuationId);
        }
      }
      if (error instanceof ResearchContractError && HANDOFF_CODES.has(error.code)) {
        continuationId ??= await deps.getConversationId();
        if (continuationId) {
          deps.observe?.({ phase: "handoff", product: prepared.product, errorCode: error.code });
          return handoff(continuationId);
        }
      }
      const code = error instanceof ResearchContractError ? error.code : "provider-error";
      deps.observe?.({ phase: "failed", product: prepared.product, errorCode: code });
      return {
        status: "failed",
        errorCode: `atlcli.ai.${code}`,
        messageKey: `atlcli.action.quick-ask.${code}`,
        retryable: code === "provider-error" || code === "rate-limited",
      };
    }
  };
}
