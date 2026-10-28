/**
 * Research presentation model — the pure half of the Kiteweave AI screen.
 *
 * Everything here is side-effect-free: request-input parsing, the activity
 * timeline derivation (`researchTimelineSteps`, `streamedChatAnswer`), scope
 * inference (`inferResearchScope`) and the small state shapes the screen
 * threads through its handlers. Extracted verbatim from `ResearchScreen.tsx`
 * (sidebar redesign, 2026-10) so the screen file holds orchestration and JSX
 * only; the public test surface is re-exported there unchanged.
 */
import type { ScreenProps } from "../../utils/screens/registry.js";
import {
  ResearchContractError,
  type ChatPresentationStreamEventV1,
  type ResearchOneShotEventV1,
  type ChatQualityPolicyV1,
  type ResearchRequestedEffortV1,
  type ResearchRequestedPlanApprovalV1,
  type ResearchRequestedReconciliationV1,
  type ResearchRequestV1,
  type ResearchScopeExpansionModeV1,
  type ResearchScopeSeedV1,
} from "../../utils/research/contracts.js";
import type {
  ChatUserQuestionV1,
  ResearchSessionClarificationReviewV1,
  ResearchSessionScopeClarificationReviewV1,
  ResearchScopeCandidateSelectionV1,
  ResearchScopeCandidateV1,
  ResearchScopeClarificationRequiredV1,
} from "@atlcli/research";
import {
  createResearchEntityScopeSeedV1,
  createResearchKeyScopeSeedV1,
} from "@atlcli/research/scope-discovery";
import { useT } from "../../utils/i18n/context.js";

export const RESEARCH_SCREEN_ID = "research";
export const MAX_RESEARCH_ACTIVITY_EVENTS = 500;
export const MICROS_PER_USD = 1_000_000;
export const MIN_RESEARCH_MODEL_COST_USD = 0.01;
export const MAX_RESEARCH_MODEL_COST_USD = 25;
export const MIN_RESEARCH_RUN_MINUTES = 1;
export const MAX_RESEARCH_RUN_MINUTES = 10;

export type ResearchInteractionMode = "chat" | "deep";

export interface PendingChatQuestionState {
  conversationId: string;
  turnId: string;
  question: ChatUserQuestionV1;
  request?: ResearchRequestV1;
  qualityPolicy?: ChatQualityPolicyV1;
}

export const RESEARCH_INTERACTION_MODE_POLICY = {
  chat: {
    requestedEffort: "auto",
    requestedPlanApproval: "automatic",
    scopeExpansionMode: "ask",
    requestedReconciliation: "off",
  },
  deep: {
    requestedEffort: "deep",
    requestedPlanApproval: "default",
    scopeExpansionMode: "ask",
    requestedReconciliation: "auto",
  },
} as const satisfies Record<ResearchInteractionMode, {
  requestedEffort: ResearchRequestedEffortV1;
  requestedPlanApproval: ResearchRequestedPlanApprovalV1;
  scopeExpansionMode: ResearchScopeExpansionModeV1;
  requestedReconciliation: ResearchRequestedReconciliationV1;
}>;

export function modelCostMicrosFromUsdInput(value: string, invalidMessage: string): number {
  const usd = Number(value);
  const micros = Math.round(usd * MICROS_PER_USD);
  if (
    !Number.isFinite(usd)
    || micros < MIN_RESEARCH_MODEL_COST_USD * MICROS_PER_USD
    || micros > MAX_RESEARCH_MODEL_COST_USD * MICROS_PER_USD
  ) {
    throw new ResearchContractError("invalid-request", invalidMessage);
  }
  return micros;
}

export function runDurationMsFromMinutesInput(value: string, invalidMessage: string): number {
  const minutes = Number(value);
  if (!Number.isSafeInteger(minutes) || minutes < MIN_RESEARCH_RUN_MINUTES || minutes > MAX_RESEARCH_RUN_MINUTES) {
    throw new ResearchContractError("invalid-request", invalidMessage);
  }
  return minutes * 60_000;
}

export function splitScopeValues(value: string): string[] {
  return [...new Set(
    value.split(/[\s,;]+/).map((entry) => entry.trim()).filter(Boolean),
  )];
}

export function researchErrorCodeV1(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if ("code" in value && typeof value.code === "string") return value.code;
  if (value instanceof Error) {
    if (value.name === "AbortError" || /\b(?:abort(?:ed)?|cancel(?:led|ed)?)\b/iu.test(value.message)) {
      return "cancelled";
    }
  }
  return undefined;
}

export type ResearchTimelineStepKind =
  | "thinking"
  | "planning"
  | "analyzing"
  | "confluence-search"
  | "confluence-read"
  | "confluence-section-read"
  | "bound-read"
  | "jira-search"
  | "jira-read"
  | "ranking"
  | "relationships"
  | "checking"
  | "synthesizing";

export interface ResearchTimelineStep {
  id: string;
  kind: ResearchTimelineStepKind;
  events: ResearchTimelineEventV1[];
}

export type ResearchTimelineEventV1 = ResearchOneShotEventV1 | ChatPresentationStreamEventV1;

export function appendTimelineEvent(
  current: readonly ResearchTimelineEventV1[],
  event: ResearchTimelineEventV1,
): ResearchTimelineEventV1[] {
  const previous = current.at(-1);
  if (event.kind === "chat-presentation" && event.status === "delta" &&
    previous?.kind === "chat-presentation" && previous.status === "delta" &&
    previous.channel === event.channel) {
    return [
      ...current.slice(0, -1),
      {
        ...event,
        delta: `${previous.delta ?? ""}${event.delta ?? ""}`.slice(-12_000),
      },
    ].slice(-MAX_RESEARCH_ACTIVITY_EVENTS);
  }
  return [...current, event].slice(-MAX_RESEARCH_ACTIVITY_EVENTS);
}

export type ResearchSuggestionKind = "summarize" | "connections" | "changes";

export interface ResearchChatTurnPresentation {
  kind: ResearchSuggestionKind;
  label: string;
}

export function researchActivityMessage(
  event: Extract<ResearchOneShotEventV1, { kind: "activity" }>,
  t: ReturnType<typeof useT>,
): string {
  const semanticKey = `research.chat.activity.${event.code}.${event.status}`;
  if ([
    "strategy",
    "direct-read",
    "search",
    "source-selection",
    "child-work",
    "critique",
    "repair",
    "synthesis",
    "gap",
    "hitl",
    "steering",
    "stop",
    "continuation",
    "completion",
  ].includes(event.code)) {
    return t(semanticKey as Parameters<typeof t>[0]);
  }
  if (event.code === "model-assessing") {
    if (event.status === "started") return t("research.chat.activity.model-assessing.started");
    if (event.status === "completed") return t("research.chat.activity.model-assessing.completed");
    return t("research.chat.activity.model-assessing.failed");
  }
  if (event.code === "answer-drafting") {
    return event.status === "started"
      ? t("research.chat.activity.answer-drafting.started")
      : event.status === "completed"
        ? t("research.chat.activity.answer-draft-ready.completed")
        : t("research.chat.activity.answer-drafting.failed");
  }
  if (event.code === "next-step-ready") {
    return event.status === "completed"
      ? t("research.chat.activity.next-step-ready.completed")
      : t("research.chat.activity.model-assessing.failed");
  }
  if (event.code === "answer-draft-ready") {
    return event.status === "completed"
      ? t("research.chat.activity.answer-draft-ready.completed")
      : t("research.chat.activity.model-assessing.failed");
  }
  if (event.code === "bounded-workflow-running") {
    return event.status === "started"
      ? t("research.chat.activity.bounded-workflow-running.started")
      : event.status === "completed"
        ? t("research.chat.activity.bounded-workflow-complete.completed")
        : t("research.chat.activity.bounded-workflow-failed.failed");
  }
  if (event.code === "bounded-workflow-complete") {
    return event.status === "completed"
      ? t("research.chat.activity.bounded-workflow-complete.completed")
      : t("research.chat.activity.bounded-workflow-failed.failed");
  }
  return t("research.chat.activity.bounded-workflow-failed.failed");
}

export function researchActivityDetailMessages(
  events: readonly ResearchTimelineEventV1[],
  t: ReturnType<typeof useT>,
): string[] {
  const messages = events.flatMap((event): string[] => {
    if (event.kind === "chat-presentation") return [];
    if (event.kind === "capability") {
      if (event.status === "failed") return [t("research.chat.detail.readFailed")];
      if (event.status !== "completed") return [];
      const count = String(event.itemCount ?? 0);
      if (event.toolId === "wiki.search" || event.toolId === "wiki.space.search") {
        if (event.itemLabels?.length) {
          return event.itemLabels.map((label) => t("research.chat.detail.foundItem", { label }));
        }
        return [t("research.chat.detail.confluenceFound", { count })];
      }
      if (event.toolId === "wiki.page.get") {
        return [t("research.chat.detail.confluenceRead")];
      }
      if (event.toolId === "atlassian.bound.read") {
        if (event.itemLabels?.length) {
          return event.itemLabels.map((label) => t("research.chat.detail.boundRead", { label }));
        }
        return [t("research.chat.detail.boundReadGeneric")];
      }
      if (event.toolId === "atlassian.bound.section.read") {
        if (event.itemLabels?.length) {
          return event.itemLabels.map((label) => t("research.chat.detail.sectionRead", { label }));
        }
        return [t("research.chat.detail.sectionReadGeneric")];
      }
      if (event.toolId === "jira.issue.search" || event.toolId === "jira.project.search") {
        if (event.itemLabels?.length) {
          return event.itemLabels.map((label) => t("research.chat.detail.foundItem", { label }));
        }
        return [t("research.chat.detail.jiraFound", { count })];
      }
      if (event.toolId === "jira.issue.get") {
        return [t("research.chat.detail.jiraRead")];
      }
      if (event.toolId === "research.candidate.rank") {
        if (event.itemLabels?.length) {
          return event.itemLabels.map((label) => t("research.chat.detail.selectedItem", { label }));
        }
        return [t("research.chat.detail.selected", { count })];
      }
      return [];
    }
    if (event.kind === "retrieval" && event.detailReadCount > 0) {
      return [t("research.chat.detail.sourcesRead", { count: String(event.detailReadCount) })];
    }
    if (event.kind === "reconciliation" && event.status === "completed") {
      return [t("research.chat.detail.checked")];
    }
    if (event.kind === "steering") {
      return [t("research.chat.detail.steeringApplied")];
    }
    if (event.kind === "activity") {
      return [researchActivityMessage(event, t)];
    }
    return [];
  });
  return [...new Set(messages)];
}

export function chatReasoningSummary(events: readonly ResearchTimelineEventV1[]): string {
  return events
    .filter((event): event is ChatPresentationStreamEventV1 =>
      event.kind === "chat-presentation" &&
      event.channel === "reasoning-summary" &&
      event.status === "delta")
    .map((event) => event.delta ?? "")
    .join("")
    .trim();
}

export function streamedChatAnswer(events: readonly ResearchTimelineEventV1[]): string {
  let visible = "";
  let replacementPending = false;
  for (const event of events) {
    if (event.kind !== "chat-presentation" || event.channel !== "answer-markdown") continue;
    if (event.status === "reset") {
      replacementPending = true;
      continue;
    }
    if (event.status !== "delta") continue;
    if (replacementPending) {
      visible = event.delta ?? "";
      replacementPending = false;
    } else {
      visible += event.delta ?? "";
    }
  }
  return visible;
}

export function timelineStepKind(event: ResearchTimelineEventV1): ResearchTimelineStepKind | null {
  if (event.kind === "chat-presentation") return null;
  if (event.kind === "phase") {
    if (event.phase === "preparing") return "planning";
    if (event.phase === "analyzing") return "analyzing";
    if (event.phase === "checking") return "checking";
    if (event.phase === "rendering") return "synthesizing";
    return null;
  }
  if (event.kind === "brief" || event.kind === "plan") return "planning";
  if (event.kind === "capability") {
    if (event.toolId === "atlassian.bound.read") return "bound-read";
    if (event.toolId === "atlassian.bound.section.read") return "confluence-section-read";
    if (event.toolId === "wiki.search" || event.toolId === "wiki.space.search") {
      return "confluence-search";
    }
    if (event.toolId === "wiki.page.get") return "confluence-read";
    if (event.toolId === "jira.issue.search" || event.toolId === "jira.project.search") {
      return "jira-search";
    }
    if (event.toolId === "jira.issue.get") return "jira-read";
    if (event.toolId === "research.candidate.rank") return "ranking";
    return "relationships";
  }
  if (event.kind === "subagent" || event.kind === "task") {
    const roleId = event.roleId ?? "";
    if (roleId.includes("synthesizer")) return "synthesizing";
    if (roleId.includes("reconciler") || roleId.includes("critic")) return "checking";
    if (roleId.includes("relationship") || roleId.includes("join")) return "relationships";
    return null;
  }
  if (event.kind === "reconciliation" || event.kind === "reconciliation_disposition") {
    return "checking";
  }
  // Retrieval summaries enrich the adjacent read/ranking step. Presenting
  // them as validation created a misleading duplicate “checking” phase.
  if (event.kind === "retrieval") return null;
  if (event.kind === "artifact") return null;
  if (event.kind === "activity") {
    if (event.code === "strategy" || event.code === "steering" || event.code === "continuation") return "planning";
    if (event.code === "model-assessing" || event.code === "child-work") return "analyzing";
    if (event.code === "critique" || event.code === "repair" || event.code === "gap") return "checking";
    if (event.code === "synthesis" || event.code === "answer-drafting" || event.code === "answer-draft-ready") return "synthesizing";
    return null;
  }
  if (event.kind === "decision") {
    if (event.decisionId === "direct-chat-agent-run") {
      return event.status === "started" ? "planning" : null;
    }
    return event.reasonCode.includes("validat") ? "checking" : "planning";
  }
  return null;
}

/**
 * Compress the body-free operator stream into a chat-sized sequence. Repeated
 * counters, budgets and start/finish pairs remain inspectable on the step that
 * owns them; they are not presented as dozens of apparent conversation turns.
 */
export function researchTimelineSteps(
  events: readonly ResearchTimelineEventV1[],
  running: boolean,
): ResearchTimelineStep[] {
  const steps: ResearchTimelineStep[] = [];
  for (const event of events) {
    const kind = timelineStepKind(event);
    const current = steps.at(-1);
    if (kind === null) {
      if (current) current.events.push(event);
      continue;
    }
    if (current?.kind === kind) {
      current.events.push(event);
      continue;
    }
    steps.push({ id: `research-step:${event.seq}`, kind, events: [event] });
  }
  if (running && steps.length === 0) {
    steps.push({ id: "research-step:thinking", kind: "thinking", events: [] });
  }
  return steps;
}
export function inferResearchScope(input: {
  siteOrigin: string;
  /**
   * The question is retained in this host-input shape for callers, but only
   * the shared, catalog-backed preflight is allowed to derive a scope from it.
   */
  question: string;
  jiraProjects: string;
  confluenceSpaces: string;
  activeSpaceKey?: string;
  activeProjectKey?: string;
  activeEntity?: {
    product: "jira" | "confluence";
    entityKind: "issue" | "page";
    key: string;
    name: string;
  };
}): {
  jiraProjectKeys: string[];
  confluenceSpaceKeys: string[];
  scopeSeeds: ResearchScopeSeedV1[];
} {
  const manualProjects = splitScopeValues(input.jiraProjects).map((key) => key.toUpperCase());
  const manualSpaces = splitScopeValues(input.confluenceSpaces);
  const currentProjects = input.activeProjectKey ? [input.activeProjectKey.toUpperCase()] : [];
  const currentSpaces = input.activeSpaceKey ? [input.activeSpaceKey] : [];
  const jiraProjectKeys = manualProjects.length > 0
    ? manualProjects
    : currentProjects;
  const confluenceSpaceKeys = manualSpaces.length > 0
    ? manualSpaces
    : currentSpaces;
  const seeds = (
    product: "jira" | "confluence",
    manual: string[],
    current: string[],
  ): ResearchScopeSeedV1[] => [
    ...manual.map((key) => createResearchKeyScopeSeedV1({
      tenantOrigin: input.siteOrigin,
      product,
      key,
      source: "ui_added",
      authority: "locked",
    })),
    ...current.map((key) => createResearchKeyScopeSeedV1({
      tenantOrigin: input.siteOrigin,
      product,
      key,
      source: "current_context",
      authority: "approved",
    })),
  ];
  return {
    jiraProjectKeys,
    confluenceSpaceKeys,
    scopeSeeds: [
      ...seeds("jira", manualProjects, currentProjects),
      ...seeds("confluence", manualSpaces, currentSpaces),
      ...(input.activeEntity
        ? [createResearchEntityScopeSeedV1({
            tenantOrigin: input.siteOrigin,
            ...input.activeEntity,
            source: "current_context",
            authority: "approved",
          })]
        : []),
    ],
  };
}

export interface PendingScopeClarification {
  request: ResearchRequestV1;
  clarification: ResearchScopeClarificationRequiredV1;
  candidateChoices: ResearchScopeCandidateV1[];
  selectedCandidateId: string;
}

export interface ScopePreflightRetry {
  request: ResearchRequestV1;
  selection?: ResearchScopeCandidateSelectionV1;
  alreadyResolved?: boolean;
  conversationId?: string;
  qualityPolicy?: ChatQualityPolicyV1;
  chatCheckpointResume?: {
    turnId: string;
    kind: "stream-interruption" | "steering";
  };
}

export function currentSite(page: ScreenProps["page"]): {
  origin: string;
  activeSpaceKey?: string;
  activeProjectKey?: string;
  contextLabel?: string;
  contextProduct?: "Confluence" | "Jira";
  activeEntity?: {
    product: "jira" | "confluence";
    entityKind: "issue" | "page";
    key: string;
    name: string;
  };
} | null {
  const url =
    page.status === "loaded" || page.status === "loading" || page.status === "error"
      ? page.ref.url
      : page.status === "unsupported"
        ? page.url
        : null;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const entity = page.status === "unsupported"
      ? page.entity
      : page.status === "loading" || page.status === "loaded" || page.status === "error"
        ? page.ref.entity
        : undefined;
    const activeSpaceKey = entity?.product === "confluence" && "spaceKey" in entity
      ? entity.spaceKey
      : page.status === "loaded"
        ? page.page.details.spaceKey
        : undefined;
    const activeProjectKey = entity?.product === "jira" ? entity.projectKey : undefined;
    const contextLabel = page.status === "loaded"
      ? page.page.details.title
      : entity?.product === "jira" && entity.type === "issue"
        ? entity.issueKey
        : entity?.product === "jira"
          ? entity.projectKey
          : entity?.product === "confluence" && "spaceKey" in entity
            ? entity.spaceKey
            : undefined;
    const activeEntity = page.status === "loaded"
      ? {
          product: "confluence" as const,
          entityKind: "page" as const,
          key: page.page.details.id,
          name: page.page.details.title,
        }
      : entity?.product === "confluence" && entity.type === "page"
        ? {
            product: "confluence" as const,
            entityKind: "page" as const,
            key: entity.pageId,
            name: contextLabel ?? entity.pageId,
          }
        : entity?.product === "jira" && entity.type === "issue"
          ? {
              product: "jira" as const,
              entityKind: "issue" as const,
              key: entity.issueKey,
              name: contextLabel ?? entity.issueKey,
            }
          : undefined;
    return {
      origin: parsed.origin,
      ...(activeSpaceKey ? { activeSpaceKey } : {}),
      ...(activeProjectKey ? { activeProjectKey } : {}),
      ...(contextLabel ? { contextLabel } : {}),
      ...(activeEntity ? { activeEntity } : {}),
      ...(entity?.product === "confluence"
        ? { contextProduct: "Confluence" as const }
        : entity?.product === "jira"
          ? { contextProduct: "Jira" as const }
          : {}),
    };
  } catch {
    return null;
  }
}


/** Draft-map key for a clarification question's free-text answer. */
export function clarificationAnswerKey(
  review: ResearchSessionClarificationReviewV1,
  questionId: string,
): string {
  return `${review.sessionId}:${review.revision}:${questionId}`;
}

/** Draft-map key for a clarification assumption's accept/reject decision. */
export function clarificationDecisionKey(
  review: ResearchSessionClarificationReviewV1,
  assumptionId: string,
): string {
  return `${review.sessionId}:${review.revision}:${assumptionId}`;
}

/** Draft-map key for a scope clarification's candidate selection. */
export function scopeClarificationSelectionKey(
  review: ResearchSessionScopeClarificationReviewV1,
): string {
  return `${review.sessionId}:${review.revision}`;
}
