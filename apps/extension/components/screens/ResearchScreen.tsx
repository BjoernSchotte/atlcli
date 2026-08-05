import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronRight,
  FileText,
  FlaskConical,
  MessageCircle,
  Menu,
  Pencil,
  Plus,
  Search,
  Square,
  Telescope,
  Trash2,
  X,
} from "lucide-react";
import {
  CopilotChatConfigurationProvider,
} from "@copilotkit/react-core/v2/headless";
import type {
  ScreenDefinition,
  ScreenProps,
} from "../../utils/screens/registry.js";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  chatQualityPolicyForModeV1,
  chatPolicyForThinkingModeV1,
  RESEARCH_ONE_SHOT_POLICY_SCHEMA_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  ResearchContractError,
  normalizeResearchOneShotPolicyV1,
  normalizeResearchRequestV1,
  type ResearchOneShotEventV1,
  type ChatThinkingModeV1,
  type ChatAnswerV1,
  type ResearchPort,
  type ResearchRequestedEffortV1,
  type ResearchRequestedPlanApprovalV1,
  type ResearchRequestedReconciliationV1,
  type ResearchRequestV1,
  type ResearchReport,
  type ResearchScopeExpansionModeV1,
  type ResearchScopeSeedV1,
} from "../../utils/research/contracts.js";
import {
  createResearchEntityScopeSeedV1,
  createResearchKeyScopeSeedV1,
} from "@atlcli/research/scope-discovery";
import {
  prepareDirectChatRequestV1,
  prepareResearchBriefPreflightV1,
  RESEARCH_PACKET_BODY_SCHEMA_V2,
} from "@atlcli/research";
import type {
  ResearchBriefClarificationRequiredV1,
  ResearchSessionClarificationReviewV1,
  ResearchSessionScopeClarificationReviewV1,
  ResearchResumableSessionV1,
  ResearchRetainedSessionV1,
  ResearchSessionPlanReviewV1,
  ResearchSessionScopeReviewV1,
  ResearchScopeCandidateSelectionV1,
  ResearchScopeCandidateV1,
  ResearchScopeClarificationRequiredV1,
} from "@atlcli/research";
import {
  composeResearchGraphV1,
  createStandardResearchBriefV1,
  researchPlanApprovalRequiredV1,
  type ResearchPlanApprovalRequiredV1,
} from "@atlcli/research/graph";
import { useI18n, useT } from "../../utils/i18n/context.js";
import { Alert, AlertTitle } from "../ui/alert.js";
import { Button } from "../ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card.js";
import {
  CheckboxField,
  FieldHelp,
  Input,
  Label,
  Select,
} from "../ui/field.js";
import { cn } from "../ui/utils.js";

export const RESEARCH_SCREEN_ID = "research";
const MAX_RESEARCH_ACTIVITY_EVENTS = 500;
const MICROS_PER_USD = 1_000_000;
const MIN_RESEARCH_MODEL_COST_USD = 0.01;
const MAX_RESEARCH_MODEL_COST_USD = 25;
const MIN_RESEARCH_RUN_MINUTES = 1;
const MAX_RESEARCH_RUN_MINUTES = 10;

type ResearchInteractionMode = "chat" | "deep";

const RESEARCH_INTERACTION_MODE_POLICY = {
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

function modelCostMicrosFromUsdInput(value: string, invalidMessage: string): number {
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

function runDurationMsFromMinutesInput(value: string, invalidMessage: string): number {
  const minutes = Number(value);
  if (!Number.isSafeInteger(minutes) || minutes < MIN_RESEARCH_RUN_MINUTES || minutes > MAX_RESEARCH_RUN_MINUTES) {
    throw new ResearchContractError("invalid-request", invalidMessage);
  }
  return minutes * 60_000;
}

function splitScopeValues(value: string): string[] {
  return [...new Set(
    value.split(/[\s,;]+/).map((entry) => entry.trim()).filter(Boolean),
  )];
}

function researchErrorCodeV1(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if ("code" in value && typeof value.code === "string") return value.code;
  if (value instanceof Error) {
    if (value.name === "AbortError" || /\b(?:abort(?:ed)?|cancel(?:led|ed)?)\b/iu.test(value.message)) {
      return "cancelled";
    }
  }
  return undefined;
}

type ResearchTimelineStepKind =
  | "thinking"
  | "planning"
  | "confluence-search"
  | "confluence-read"
  | "bound-read"
  | "jira-search"
  | "jira-read"
  | "ranking"
  | "relationships"
  | "checking"
  | "synthesizing";

interface ResearchTimelineStep {
  id: string;
  kind: ResearchTimelineStepKind;
  events: ResearchOneShotEventV1[];
}

function researchActivityDetailMessages(
  events: readonly ResearchOneShotEventV1[],
  t: ReturnType<typeof useT>,
): string[] {
  const messages = events.flatMap((event): string[] => {
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
    return [];
  });
  return [...new Set(messages)];
}

function timelineStepKind(event: ResearchOneShotEventV1): ResearchTimelineStepKind | null {
  if (event.kind === "phase") {
    if (event.phase === "preparing") return "planning";
    if (event.phase === "rendering") return "synthesizing";
    return null;
  }
  if (event.kind === "brief" || event.kind === "plan") return "planning";
  if (event.kind === "capability") {
    if (event.toolId === "atlassian.bound.read") return "bound-read";
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
  events: readonly ResearchOneShotEventV1[],
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

function KiteActivityMark(): React.JSX.Element {
  return (
    <svg
      className="kiteweave-agent-kite size-5 shrink-0 overflow-visible"
      viewBox="0 0 48 54"
      aria-hidden="true"
      data-testid="research-active-kite"
    >
      <path className="fill-primary" d="M24 3 6 24l18 20V3Z" />
      <path className="fill-success" d="m24 3 18 21-18 20V3Z" />
      <path
        className="fill-none stroke-background"
        d="M6 24h36M24 44c5 3 1 6 5 8"
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
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

interface PendingScopeClarification {
  request: ResearchRequestV1;
  clarification: ResearchScopeClarificationRequiredV1;
  candidateChoices: ResearchScopeCandidateV1[];
  selectedCandidateId: string;
}

interface ScopePreflightRetry {
  request: ResearchRequestV1;
  selection: ResearchScopeCandidateSelectionV1;
}

export function ResearchBriefClarificationNotice({
  clarification,
}: {
  clarification: ResearchBriefClarificationRequiredV1;
}): React.JSX.Element {
  const t = useT();
  return (
    <Alert tone="muted" role="status" data-testid="research-brief-clarification-required">
      <AlertTitle>{t("research.briefClarification")}</AlertTitle>
      <p className="m-0 mt-1">
        {t("research.briefClarification.value", {
          revision: String(clarification.briefRevision),
        })}
      </p>
      {clarification.questions.length > 0 && (
        <div className="mt-2">
          <strong className="text-xs">{t("research.briefClarification.questions")}</strong>
          <ul className="mb-0 mt-1 pl-5 text-xs">
            {clarification.questions.map((question) => (
              <li key={question.id}>{question.prompt}</li>
            ))}
          </ul>
        </div>
      )}
      {clarification.assumptionsRequiringDecision.length > 0 && (
        <div className="mt-2">
          <strong className="text-xs">{t("research.briefClarification.assumptions")}</strong>
          <ul className="mb-0 mt-1 pl-5 text-xs">
            {clarification.assumptionsRequiringDecision.map((assumption) => (
              <li key={assumption.id}>{assumption.text}</li>
            ))}
          </ul>
        </div>
      )}
    </Alert>
  );
}

function currentSite(page: ScreenProps["page"]): {
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

function SourceLinks({
  sourceIds,
  report,
}: {
  sourceIds: readonly string[];
  report: Pick<ResearchReport, "sources">;
}): React.JSX.Element {
  const sources = new Map(report.sources.map((source) => [source.id, source]));
  return (
    <span className="text-xs text-muted-foreground">
      {sourceIds.map((sourceId, index) => {
        const source = sources.get(sourceId);
        if (!source) return null;
        return (
          <React.Fragment key={sourceId}>
            {index > 0 ? ", " : ""}
            <a className="underline underline-offset-2" href={source.url} target="_blank" rel="noreferrer">
              {source.title}
            </a>
          </React.Fragment>
        );
      })}
    </span>
  );
}

function V1FormattedReport({ report }: { report: Extract<ResearchReport, { schema: "atlcli.research-report/v1" }> }): React.JSX.Element {
  const t = useT();
  return (
    <article className="flex flex-col gap-4 text-sm" data-testid="research-formatted-report">
      <header>
        <h2 className="m-0 font-serif text-xl font-semibold">{report.title}</h2>
        <p className="mb-0 mt-1 text-xs text-muted-foreground">{report.question}</p>
      </header>
      <section>
        <h3 className="mb-1 mt-0 text-sm font-semibold">{t("research.summary")}</h3>
        <p className="m-0 whitespace-pre-wrap">{report.executiveSummary}</p>
      </section>
      <section>
        <h3 className="mb-2 mt-0 text-sm font-semibold">{t("research.findings")}</h3>
        <ol className="m-0 flex flex-col gap-3 pl-5">
          {report.findings.map((finding) => (
            <li key={finding.id}>
              <strong>{finding.summary}</strong>
              {finding.detail && <p className="mb-1 mt-1 whitespace-pre-wrap">{finding.detail}</p>}
              <SourceLinks sourceIds={finding.sourceIds} report={report} />
            </li>
          ))}
        </ol>
      </section>
      <section>
        <h3 className="mb-2 mt-0 text-sm font-semibold">{t("research.relationships")}</h3>
        <ul className="m-0 flex flex-col gap-2 pl-5">
          {report.relationships.map((relationship) => (
            <li key={relationship.id}>
              <span className="mr-1 rounded bg-muted px-1 py-0.5 text-xs font-semibold uppercase">
                {relationship.classification}
              </span>
              <code>{relationship.jiraIssueKey}</code> ↔ <code>{relationship.confluenceContentId}</code>
              <span>: {relationship.summary}</span>{" "}
              <SourceLinks sourceIds={relationship.sourceIds} report={report} />
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3 className="mb-1 mt-0 text-sm font-semibold">{t("research.limitations")}</h3>
        <ul className="m-0 pl-5">
          {report.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
        </ul>
      </section>
      <section>
        <h3 className="mb-1 mt-0 text-sm font-semibold">{t("research.sources")}</h3>
        <ol className="m-0 pl-5">
          {report.sources.map((source) => (
            <li key={source.id}>
              <a className="underline underline-offset-2" href={source.url} target="_blank" rel="noreferrer">
                {source.title}
              </a>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}

function V2FormattedReport({ report }: { report: Extract<ResearchReport, { schema: "atlcli.research-report/v2" }> }): React.JSX.Element {
  const t = useT();
  const claims = new Map(report.claims.map((claim) => [claim.id, claim]));
  const reconciliation = report.reconciliation ?? [];
  return (
    <article className="flex flex-col gap-4 text-sm" data-testid="research-formatted-report">
      <header>
        <h2 className="m-0 font-serif text-xl font-semibold">{report.title}</h2>
        <p className="mb-0 mt-1 text-xs text-muted-foreground">{report.question}</p>
      </header>
      <section>
        <h3 className="mb-1 mt-0 text-sm font-semibold">{t("research.summary")}</h3>
        <ul className="m-0 flex flex-col gap-2 pl-5">
          {report.executiveSummaryClaimIds.map((claimId) => {
            const claim = claims.get(claimId);
            return claim ? <li key={claim.id}>{claim.statement}</li> : null;
          })}
        </ul>
      </section>
      {report.sections.map((section) => (
        <section key={section.id}>
          <h3 className="mb-1 mt-0 text-sm font-semibold">{section.title}</h3>
          <p className="mb-2 mt-0 text-xs text-muted-foreground">{section.question}</p>
          <ol className="m-0 flex flex-col gap-3 pl-5">
            {section.claimIds.map((claimId) => {
              const claim = claims.get(claimId);
              return claim ? (
              <li key={claim.id}>
                <strong>{claim.statement}</strong>
                <span
                  className="ml-2 rounded bg-muted px-1 py-0.5 text-xs text-muted-foreground"
                  data-testid={`research-claim-freshness-${claim.id}`}
                >
                  {t("research.claim.freshness.current")}
                </span>
                <SourceLinks sourceIds={claim.sourceIds} report={report} />
              </li>
              ) : null;
            })}
          </ol>
        </section>
      ))}
      {report.coverage.length > 0 && (
        <section>
          <h3 className="mb-1 mt-0 text-sm font-semibold">{t("research.coverage")}</h3>
          <ul className="m-0 pl-5">
            {report.coverage.map((entry) => (
              <li key={entry.targetId}>
                <code>{entry.targetId}</code>: {entry.status}; {entry.distinctSourceCount} {t(
                  entry.distinctSourceCount === 1
                    ? "research.coverage.distinctSource"
                    : "research.coverage.distinctSources",
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {reconciliation.length > 0 && (
        <section>
          <h3 className="mb-1 mt-0 text-sm font-semibold">{t("research.reconciliation.outcomes")}</h3>
          <ul className="m-0 pl-5">
            {reconciliation.map((outcome) => (
              <li key={outcome.defectId} data-testid={`research-reconciliation-${outcome.defectId}`}>
                <code>{outcome.target.kind}: {outcome.target.id}</code>: {outcome.decision} ({outcome.reasonCode})
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h3 className="mb-1 mt-0 text-sm font-semibold">{t("research.limitations")}</h3>
        <ul className="m-0 pl-5">
          {report.limitations.length > 0
            ? report.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)
            : <li>{t("research.noneReported")}</li>}
        </ul>
      </section>
      <section>
        <h3 className="mb-1 mt-0 text-sm font-semibold">{t("research.sources")}</h3>
        <ol className="m-0 pl-5">
          {report.sources.map((source) => (
            <li key={source.id}>
              <a className="underline underline-offset-2" href={source.url} target="_blank" rel="noreferrer">
                {source.title}
              </a>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}

function FormattedReport({ report }: { report: ResearchReport }): React.JSX.Element {
  return report.schema === "atlcli.research-report/v2"
    ? <V2FormattedReport report={report} />
    : <V1FormattedReport report={report} />;
}

function ChatAnswer({ answer }: { answer: ChatAnswerV1 }): React.JSX.Element {
  const t = useT();
  return (
    <article className="space-y-3 text-sm leading-6" data-testid="research-chat-answer">
      <p className="m-0 whitespace-pre-wrap">{answer.messageMarkdown}</p>
      {answer.citations.length > 0 && (
        <details className="rounded-lg border border-border/70 px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
            {t("research.chat.sources", { count: answer.citations.length })}
          </summary>
          <ol className="mb-0 mt-2 space-y-1 pl-5 text-xs">
            {answer.citations.map((source) => (
              <li key={source.sourceId}>
                <a className="underline underline-offset-2" href={source.url} target="_blank" rel="noreferrer">
                  {source.title}
                </a>
              </li>
            ))}
          </ol>
        </details>
      )}
    </article>
  );
}

/** Presenter-only compatibility for retained pre-C1 results; new Chat runs never create this shape. */
function LegacyChatAnswer({ report }: { report: ResearchReport }): React.JSX.Element {
  const t = useT();
  const statements = report.schema === "atlcli.research-report/v2"
    ? report.executiveSummaryClaimIds
      .map((claimId) => report.claims.find((claim) => claim.id === claimId)?.statement)
      .filter((statement): statement is string => Boolean(statement))
    : report.findings.length > 0 || report.relationships.length > 0
      ? [report.executiveSummary].filter(Boolean)
      : [];
  const fallback = report.limitations[0] ?? t("research.chat.answerUnavailable");
  return (
    <article className="space-y-3 text-sm leading-6" data-testid="research-chat-answer">
      {(statements.length > 0 ? statements : [fallback]).map((statement) => (
        <p className="m-0" key={statement}>{statement}</p>
      ))}
    </article>
  );
}

function ResearchStreamingTurn({
  activity,
  progress,
  running,
  request,
}: {
  activity: readonly ResearchOneShotEventV1[];
  progress: string;
  running: boolean;
  request?: ResearchRequestV1 | null;
}): React.JSX.Element | null {
  const t = useT();
  if (!running && activity.length === 0) return null;
  const steps = researchTimelineSteps(activity, running);
  const exactPage = request?.exactContextProducts?.includes("confluence")
    ? request.scopeSeeds?.find((seed) =>
      seed.binding.source === "current_context" &&
      seed.binding.product === "confluence" &&
      seed.binding.entityKind === "page",
    )?.binding
    : undefined;
  const exactIssue = request?.exactContextProducts?.includes("jira")
    ? request.scopeSeeds?.find((seed) =>
      seed.binding.source === "current_context" &&
      seed.binding.product === "jira" &&
      seed.binding.entityKind === "issue",
    )?.binding
    : undefined;
  // Ranking validates the one host-bound entity reference internally, but it
  // is not a user-visible discovery step when there is only one exact page.
  // Showing it as "relevant results selected" suggested a broad search that
  // never happened and duplicated the direct-context selection row.
  const displaySteps = exactPage
    ? steps.filter((step) => step.kind !== "ranking")
    : steps;
  const label = (kind: ResearchTimelineStepKind): string => {
    switch (kind) {
      case "thinking": return t("research.chat.phase.thinking");
      case "planning": return t("research.chat.phase.planning");
      case "confluence-search": return exactPage
        ? t("research.chat.phase.confluenceContext")
        : t("research.chat.phase.confluenceSearch");
      case "confluence-read": return exactPage
        ? t("research.chat.phase.confluenceContextRead", { name: exactPage.name })
        : t("research.chat.phase.confluenceRead");
      case "bound-read": return exactPage
        ? t("research.chat.phase.confluenceContextRead", { name: exactPage.name })
        : exactIssue
          ? t("research.chat.phase.jiraContextRead", { name: exactIssue.name })
          : t("research.chat.phase.boundRead");
      case "jira-search": return t("research.chat.phase.jiraSearch");
      case "jira-read": return t("research.chat.phase.jiraRead");
      case "ranking": return t("research.chat.phase.ranking");
      case "relationships": return t("research.chat.phase.relationships");
      case "checking": return t("research.chat.phase.checking");
      case "synthesizing": return t("research.chat.phase.synthesizing");
    }
  };
  const description = (kind: ResearchTimelineStepKind): string => {
    switch (kind) {
      case "thinking": return t("research.chat.phase.thinking.description");
      case "planning": return t("research.chat.phase.planning.description");
      case "confluence-search": return exactPage
        ? t("research.chat.phase.confluenceContext.description")
        : t("research.chat.phase.confluenceSearch.description");
      case "confluence-read": return t("research.chat.phase.confluenceRead.description");
      case "bound-read": return t("research.chat.phase.boundRead.description");
      case "jira-search": return t("research.chat.phase.jiraSearch.description");
      case "jira-read": return t("research.chat.phase.jiraRead.description");
      case "ranking": return t("research.chat.phase.ranking.description");
      case "relationships": return t("research.chat.phase.relationships.description");
      case "checking": return t("research.chat.phase.checking.description");
      case "synthesizing": return t("research.chat.phase.synthesizing.description");
    }
  };
  return (
    <section
      className="space-y-1 py-1 text-sm"
      aria-live="polite"
      data-testid="research-streaming-turn"
    >
      <div className="space-y-1" data-testid="research-activity">
        {displaySteps.map((step, index) => {
          const active = running && index === displaySteps.length - 1;
          const details = exactPage && step.kind === "confluence-search"
            ? [t("research.chat.detail.confluenceContextSelected")]
            : researchActivityDetailMessages(step.events, t);
          if (step.kind === "planning") {
            details.push(exactPage
              ? t("research.chat.detail.planExactContext", { name: exactPage.name })
              : t("research.chat.detail.planScopedDiscovery"));
          }
          const summary = (
            <span className={cn(
              "flex min-h-9 items-center gap-2.5 rounded-lg px-2 py-1.5",
              active ? "font-medium text-foreground" : "text-muted-foreground",
            )}>
              {active ? <KiteActivityMark /> : <span className="size-5 shrink-0" aria-hidden="true" />}
              <span className="min-w-0 flex-1">
                <span className="block">{label(step.kind)}</span>
                <span className="mt-0.5 block text-xs font-normal leading-4 text-muted-foreground">
                  {description(step.kind)}
                </span>
              </span>
              {details.length > 0 && (
                <ChevronRight
                  className="size-4 shrink-0 transition-transform group-open:rotate-90"
                  aria-hidden="true"
                />
              )}
              {active && (
                <span className="sr-only">{t("research.chat.phase.inProgress")}</span>
              )}
            </span>
          );
          if (details.length === 0) {
            return <div key={step.id}>{summary}</div>;
          }
          return (
            <details
              key={step.id}
              className="group rounded-lg"
              data-testid={`research-timeline-step-${index}`}
            >
              <summary
                className="cursor-pointer list-none rounded-lg marker:content-none hover:bg-muted/70"
                aria-label={`${label(step.kind)}. ${t("research.chat.phase.showDetails")}`}
              >
                {summary}
              </summary>
              <ol className="m-0 ml-9 mt-1 max-h-64 space-y-1 overflow-auto pl-0 text-xs text-muted-foreground">
                {details.map((detail) => (
                  <li className="rounded-md bg-muted/70 px-2 py-1" key={detail}>{detail}</li>
                ))}
              </ol>
            </details>
          );
        })}
      </div>
      {progress && <span className="sr-only">{progress}</span>}
    </section>
  );
}

export function ResearchScreen({ ports, page }: ScreenProps): React.JSX.Element {
  const t = useT();
  const { locale } = useI18n();
  const port = ports.research;
  const site = useMemo(() => currentSite(page), [page]);
  const [hasKey, setHasKey] = useState(false);
  const [question, setQuestion] = useState("");
  const [chatTurns, setChatTurns] = useState<Array<{
    id: string;
    content: string;
    state: "sent" | "queued" | "steering";
  }>>([]);
  const [queuedChatMessages, setQueuedChatMessages] = useState<Array<{
    id: string;
    content: string;
    baseQuestion?: string;
  }>>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [immediateSteering, setImmediateSteering] = useState<{
    instruction: string;
    sessionId: string;
  } | null>(null);
  const [queuedTurnBeingEdited, setQueuedTurnBeingEdited] = useState<string | null>(null);
  const [queuedTurnDraft, setQueuedTurnDraft] = useState("");
  const [composerAddMenuOpen, setComposerAddMenuOpen] = useState(false);
  const [conversationMenuOpen, setConversationMenuOpen] = useState(false);
  const [interactionMode, setInteractionMode] = useState<ResearchInteractionMode>("chat");
  const [chatThinkingMode, setChatThinkingMode] = useState<ChatThinkingModeV1>("auto");
  const [jiraProjects, setJiraProjects] = useState("");
  const [confluenceSpaces, setConfluenceSpaces] = useState("");
  const [includeCurrentContext, setIncludeCurrentContext] = useState(true);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [maxCostUsd, setMaxCostUsd] = useState(
    String(DEFAULT_RESEARCH_LIMITS_V1.maxModelCostMicros / MICROS_PER_USD),
  );
  const [maxRunMinutes, setMaxRunMinutes] = useState(
    String(Math.ceil(DEFAULT_RESEARCH_LIMITS_V1.maxRunMs / 60_000)),
  );
  const effort = RESEARCH_INTERACTION_MODE_POLICY.deep.requestedEffort;
  const [planApproval, setPlanApproval] = useState<ResearchRequestedPlanApprovalV1>(
    RESEARCH_INTERACTION_MODE_POLICY.chat.requestedPlanApproval,
  );
  const [scopeExpansion, setScopeExpansion] = useState<ResearchScopeExpansionModeV1>(
    RESEARCH_INTERACTION_MODE_POLICY.chat.scopeExpansionMode,
  );
  const [reconciliation, setReconciliation] = useState<ResearchRequestedReconciliationV1>(
    RESEARCH_INTERACTION_MODE_POLICY.chat.requestedReconciliation,
  );
  const [disclosed, setDisclosed] = useState(false);
  const [running, setRunning] = useState(false);
  const [pauseRequested, setPauseRequested] = useState(false);
  const [progress, setProgress] = useState("");
  const [activity, setActivity] = useState<ResearchOneShotEventV1[]>([]);
  const [report, setReport] = useState<ResearchReport | ChatAnswerV1 | null>(null);
  const [raw, setRaw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planApprovalRequired, setPlanApprovalRequired] =
    useState<ResearchPlanApprovalRequiredV1 | null>(null);
  const [scopeClarification, setScopeClarification] =
    useState<PendingScopeClarification | null>(null);
  const [briefClarification, setBriefClarification] =
    useState<ResearchBriefClarificationRequiredV1 | null>(null);
  const [submittedRequest, setSubmittedRequest] =
    useState<ResearchRequestV1 | null>(null);
  const [actionStatus, setActionStatus] = useState("");
  const [resumableSessions, setResumableSessions] = useState<
    ResearchResumableSessionV1[]
  >([]);
  const [retainedSessions, setRetainedSessions] = useState<
    ResearchRetainedSessionV1[]
  >([]);
  const [scopeReviews, setScopeReviews] = useState<
    ResearchSessionScopeReviewV1[]
  >([]);
  const [scopePlanReviews, setScopePlanReviews] = useState<
    ResearchSessionScopeReviewV1[]
  >([]);
  const [planReviews, setPlanReviews] = useState<ResearchSessionPlanReviewV1[]>([]);
  const [clarificationReviews, setClarificationReviews] = useState<
    ResearchSessionClarificationReviewV1[]
  >([]);
  const [scopeClarificationReviews, setScopeClarificationReviews] = useState<
    ResearchSessionScopeClarificationReviewV1[]
  >([]);
  const [clarificationAnswers, setClarificationAnswers] = useState<Record<string, string>>({});
  const [clarificationDecisions, setClarificationDecisions] = useState<Record<string, "accepted" | "rejected" | "">>({});
  const [scopeClarificationSelections, setScopeClarificationSelections] = useState<Record<string, string>>({});
  const [planRevisionInstructions, setPlanRevisionInstructions] = useState<Record<string, string>>({});
  const [steeringInstructions, setSteeringInstructions] = useState<Record<string, string>>({});
  const [followUpQuestions, setFollowUpQuestions] = useState<Record<string, string>>({});
  const [scopeReviewActionId, setScopeReviewActionId] = useState<string | null>(null);
  const [scopePlanReviewActionId, setScopePlanReviewActionId] = useState<string | null>(null);
  const [planReviewActionId, setPlanReviewActionId] = useState<string | null>(null);
  const [clarificationActionId, setClarificationActionId] = useState<string | null>(null);
  const [scopeClarificationActionId, setScopeClarificationActionId] = useState<string | null>(null);
  const [followUpActionId, setFollowUpActionId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const chatTurnSequence = useRef(0);
  const activeSessionIdRef = useRef<string | null>(null);
  const activeChatConversationIdRef = useRef<string | null>(null);
  const queueDrainInFlight = useRef(false);
  const failedQueuedTurnId = useRef<string | null>(null);
  const expectedDirectSteeringAbort = useRef(false);
  const planReviewListingGeneration = useRef(0);

  useEffect(() => {
    let active = true;
    void port?.hasApiKey().then((value) => {
      if (active) setHasKey(value);
    });
    return () => {
      active = false;
    };
  }, [port]);

  useEffect(() => {
    let active = true;
    if (!port?.listResumableSessions || !site) {
      setResumableSessions([]);
      return () => { active = false; };
    }
    void port.listResumableSessions()
      .then((sessions) => {
        if (active) setResumableSessions(sessions);
      })
      // Session discovery is an optional convenience, never a prerequisite
      // for a new one-shot run. The host retains the detailed error on an
      // explicit resume request instead of presenting it during mount.
      .catch(() => {
        if (active) setResumableSessions([]);
      });
    return () => { active = false; };
  }, [port, site]);

  useEffect(() => {
    let active = true;
    if (!port?.listRetainedSessions || !site) {
      setRetainedSessions([]);
      return () => { active = false; };
    }
    void port.listRetainedSessions()
      .then((sessions) => {
        if (active) setRetainedSessions(sessions);
      })
      .catch(() => {
        if (active) setRetainedSessions([]);
      });
    return () => { active = false; };
  }, [port, site]);

  useEffect(() => {
    let active = true;
    if (!port?.listScopeClarificationReviews || !site) {
      setScopeClarificationReviews([]);
      return () => { active = false; };
    }
    void port.listScopeClarificationReviews()
      .then((reviews) => {
        if (active) setScopeClarificationReviews(reviews);
      })
      .catch(() => {
        if (active) setScopeClarificationReviews([]);
      });
    return () => { active = false; };
  }, [port, site]);

  useEffect(() => {
    let active = true;
    if (!port?.listClarificationReviews || !site) {
      setClarificationReviews([]);
      return () => { active = false; };
    }
    void port.listClarificationReviews()
      .then((reviews) => {
        if (active) setClarificationReviews(reviews);
      })
      .catch(() => {
        if (active) setClarificationReviews([]);
      });
    return () => { active = false; };
  }, [port, site]);

  useEffect(() => {
    let active = true;
    const generation = ++planReviewListingGeneration.current;
    if (!port?.listPlanReviews || !site) {
      setPlanReviews([]);
      return () => { active = false; };
    }
    void port.listPlanReviews()
      .then((reviews) => {
        if (active && generation === planReviewListingGeneration.current) setPlanReviews(reviews);
      })
      .catch(() => {
        if (active && generation === planReviewListingGeneration.current) setPlanReviews([]);
      });
    return () => { active = false; };
  }, [port, site]);

  useEffect(() => {
    let active = true;
    if (!port?.listScopePlanReviews || !site) {
      setScopePlanReviews([]);
      return () => { active = false; };
    }
    void port.listScopePlanReviews()
      .then((reviews) => {
        if (active) setScopePlanReviews(reviews);
      })
      // Like scope review, this is advisory discovery. Approval remains fully
      // revision-fenced by the extension background before any session changes.
      .catch(() => {
        if (active) setScopePlanReviews([]);
      });
    return () => { active = false; };
  }, [port, site]);

  useEffect(() => {
    let active = true;
    if (!port?.listScopeReviews || !site) {
      setScopeReviews([]);
      return () => { active = false; };
    }
    void port.listScopeReviews()
      .then((reviews) => {
        if (active) setScopeReviews(reviews);
      })
      // Scope-review discovery is advisory. A visible card always performs a
      // fully revision-fenced host action, so a background refresh failure can
      // never turn into an implicit decision.
      .catch(() => {
        if (active) setScopeReviews([]);
      });
    return () => { active = false; };
  }, [port, site]);

  async function refreshResumableSessions(): Promise<void> {
    if (!port?.listResumableSessions || !site) {
      setResumableSessions([]);
      return;
    }
    try {
      setResumableSessions(await port.listResumableSessions());
    } catch {
      setResumableSessions([]);
    }
  }

  async function refreshRetainedSessions(): Promise<void> {
    if (!port?.listRetainedSessions || !site) {
      setRetainedSessions([]);
      return;
    }
    try {
      setRetainedSessions(await port.listRetainedSessions());
    } catch {
      setRetainedSessions([]);
    }
  }

  async function refreshScopeReviews(): Promise<void> {
    if (!port?.listScopeReviews || !site) {
      setScopeReviews([]);
      return;
    }
    try {
      setScopeReviews(await port.listScopeReviews());
    } catch {
      setScopeReviews([]);
    }
  }

  async function refreshScopePlanReviews(): Promise<void> {
    if (!port?.listScopePlanReviews || !site) {
      setScopePlanReviews([]);
      return;
    }
    try {
      setScopePlanReviews(await port.listScopePlanReviews());
    } catch {
      setScopePlanReviews([]);
    }
  }

  async function refreshPlanReviews(): Promise<void> {
    const generation = ++planReviewListingGeneration.current;
    if (!port?.listPlanReviews || !site) {
      setPlanReviews([]);
      return;
    }
    try {
      const reviews = await port.listPlanReviews();
      if (generation === planReviewListingGeneration.current) setPlanReviews(reviews);
    } catch {
      if (generation === planReviewListingGeneration.current) setPlanReviews([]);
    }
  }

  async function refreshClarificationReviews(): Promise<void> {
    if (!port?.listClarificationReviews || !site) {
      setClarificationReviews([]);
      return;
    }
    try {
      setClarificationReviews(await port.listClarificationReviews());
    } catch {
      setClarificationReviews([]);
    }
  }

  async function refreshScopeClarificationReviews(): Promise<void> {
    if (!port?.listScopeClarificationReviews || !site) {
      setScopeClarificationReviews([]);
      return;
    }
    try {
      setScopeClarificationReviews(await port.listScopeClarificationReviews());
    } catch {
      setScopeClarificationReviews([]);
    }
  }

  if (!port) return <Alert tone="muted">{t("screen.unmet.capability.research")}</Alert>;

  function trackActiveSession(sessionId: string): void {
    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
  }

  function clearStaleRetainedSession(): void {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    setRetainedSessions((current) => current.filter((candidate) => candidate.sessionId !== sessionId));
  }

  async function run(
    retry?: ScopePreflightRetry,
    questionOverride?: string,
    existingTurnId?: string,
  ): Promise<boolean> {
    setError(null);
    setPlanApprovalRequired(null);
    setScopeClarification(null);
    setBriefClarification(null);
    setActionStatus("");
    if (!retry) setSubmittedRequest(null);
    try {
      if (!site) throw new ResearchContractError("not-atlassian", t("research.siteMissing"));
      if (!disclosed) {
        throw new ResearchContractError("invalid-request", t("research.disclosure"));
      }
      const initialRequest = retry?.request ?? (() => {
        const requestedQuestion = questionOverride ?? question;
        const maxModelCostMicros = modelCostMicrosFromUsdInput(
          maxCostUsd,
          t("research.maxCost.invalid"),
        );
        const maxRunMs = runDurationMsFromMinutesInput(
          maxRunMinutes,
          t("research.maxRuntime.invalid"),
        );
        const scope = inferResearchScope({
          siteOrigin: site.origin,
          question: requestedQuestion,
          jiraProjects,
          confluenceSpaces,
          activeSpaceKey: site.activeSpaceKey,
          activeProjectKey: site.activeProjectKey,
          activeEntity: includeCurrentContext ? site.activeEntity : undefined,
        });
        return normalizeResearchRequestV1({
          schema: RESEARCH_REQUEST_SCHEMA_V1,
          question: requestedQuestion,
          scope: {
            siteOrigin: site.origin,
            jiraProjectKeys: scope.jiraProjectKeys,
            confluenceSpaceKeys: scope.confluenceSpaceKeys,
            timeWindow: {
              ...(from ? { from } : {}),
              ...(to ? { to } : {}),
            },
          },
          scopeSeeds: scope.scopeSeeds,
          reportLanguage: locale,
          limits: {
            ...DEFAULT_RESEARCH_LIMITS_V1,
            maxModelCostMicros,
            maxRunMs,
          },
          wikiProvider: "rest",
        });
      })();
      if (!retry && !existingTurnId) {
        chatTurnSequence.current += 1;
        setChatTurns((current) => [...current, {
          id: `research-user-turn:${chatTurnSequence.current}`,
          content: initialRequest.question,
          state: "sent",
        }]);
      }
      const policy = interactionMode === "chat"
        ? chatPolicyForThinkingModeV1(chatThinkingMode)
        : normalizeResearchOneShotPolicyV1({
            schema: RESEARCH_ONE_SHOT_POLICY_SCHEMA_V1,
            requestedEffort: effort,
            requestedPlanApproval: planApproval,
            scopeExpansionMode: scopeExpansion,
            requestedReconciliation: reconciliation,
          });
      const scopeOutcome = await port!.resolveScope(
        initialRequest,
        retry ? { candidateSelections: [retry.selection] } : undefined,
      );
      if (scopeOutcome.kind === "clarification_required") {
        if (port!.prepareScopeClarificationReview) {
          const review = await port!.prepareScopeClarificationReview(initialRequest, policy);
          setScopeClarificationReviews((current) => [
            review,
            ...current.filter((candidate) => candidate.sessionId !== review.sessionId),
          ]);
          setActivity([]);
          setReport(null);
          setProgress("");
          setActionStatus(t("research.clarificationReview.prepared"));
          return true;
        }
        setScopeClarification({
          request: structuredClone(initialRequest),
          clarification: scopeOutcome.clarification,
          candidateChoices: scopeOutcome.candidateChoices,
          selectedCandidateId: "",
        });
        setActivity([]);
        setReport(null);
        setProgress("");
        return true;
      }
      const request = interactionMode === "chat"
        ? prepareDirectChatRequestV1(scopeOutcome.request)
        : scopeOutcome.request;
      setSubmittedRequest(structuredClone(request));
      if (interactionMode === "deep") {
        const briefOutcome = prepareResearchBriefPreflightV1(createStandardResearchBriefV1(request.question, {
          scope: request.scope,
          scopeBindings: request.scopeSeeds?.map((seed) => seed.binding),
          limits: request.limits,
          asOf: new Date().toISOString(),
          policy,
        }));
        if (briefOutcome.kind === "clarification_required") {
          if (port!.prepareClarificationReview) {
            const review = await port!.prepareClarificationReview(request, policy);
            setClarificationReviews((current) => [
              review,
              ...current.filter((candidate) => candidate.sessionId !== review.sessionId),
            ]);
            setActivity([]);
            setReport(null);
            setProgress("");
            setActionStatus(t("research.clarificationReview.prepared"));
            return true;
          }
          setBriefClarification(briefOutcome.clarification);
          setActivity([]);
          setReport(null);
          setProgress("");
          return true;
        }
        const graph = composeResearchGraphV1(briefOutcome.brief, {
          packetOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2,
        });
        const approvalRequired = researchPlanApprovalRequiredV1(graph);
        if (approvalRequired) {
          if (port!.preparePlanReview) {
            const review = await port!.preparePlanReview(request, policy);
            ++planReviewListingGeneration.current;
            setPlanReviews((current) => [
              review,
              ...current.filter((candidate) => candidate.sessionId !== review.sessionId),
            ]);
            setActivity([]);
            setReport(null);
            setProgress("");
            setActionStatus(t("research.planReview.prepared"));
            return true;
          }
          setPlanApprovalRequired(approvalRequired);
          setActivity([]);
          setReport(null);
          setProgress("");
          return true;
        }
      }
      if (!hasKey) {
        throw new ResearchContractError("missing-key", t("research.key.missing"));
      }
      const controller = new AbortController();
      abortRef.current = controller;
      setRunning(true);
      setPauseRequested(false);
      setProgress(t(interactionMode === "chat" ? "research.chat.running" : "research.running"));
      setActivity([]);
      setReport(null);
      const result = await port!.run(request, {
        signal: controller.signal,
        mode: interactionMode === "chat" ? "chat" : "research",
        ...(interactionMode === "chat" && activeChatConversationIdRef.current
          ? { conversationId: activeChatConversationIdRef.current }
          : {}),
        policy,
        ...(interactionMode === "chat"
          ? { qualityPolicy: chatQualityPolicyForModeV1(chatThinkingMode) }
          : {}),
        onSessionStart: (session) => {
          if (interactionMode === "chat") {
            activeChatConversationIdRef.current = session.sessionId;
          } else {
            trackActiveSession(session.sessionId);
          }
        },
        onProgress: () => setProgress(t(
          interactionMode === "chat" ? "research.chat.running" : "research.running",
        )),
        onEvent: (event) => setActivity((current) =>
          [...current, event].slice(-MAX_RESEARCH_ACTIVITY_EVENTS)
        ),
      });
      setReport(result);
      setProgress("");
      return true;
    } catch (value) {
      const errorCode = researchErrorCodeV1(value);
      if (expectedDirectSteeringAbort.current) {
        setProgress("");
      } else if (errorCode === "cancelled") {
        setActionStatus(t("research.stopped"));
        setProgress("");
      } else if (errorCode === "paused" || errorCode === "scope-approval-required") {
        setActionStatus(t(errorCode === "paused" ? "research.paused" : "research.scopeApprovalRequired"));
        setProgress("");
      } else {
        setError(value instanceof Error ? value.message : t("research.error"));
      }
      return false;
    } finally {
      abortRef.current = null;
      clearStaleRetainedSession();
      setRunning(false);
      setPauseRequested(false);
      expectedDirectSteeringAbort.current = false;
      void refreshResumableSessions();
      void refreshRetainedSessions();
      void refreshScopeReviews();
      void refreshScopePlanReviews();
      void refreshPlanReviews();
      void refreshClarificationReviews();
      void refreshScopeClarificationReviews();
    }
  }

  async function resume(session: ResearchResumableSessionV1): Promise<void> {
    if (!port?.resume) return;
    setError(null);
    setPlanApprovalRequired(null);
    setScopeClarification(null);
    setBriefClarification(null);
    setActionStatus("");
    try {
      if (!hasKey) {
        throw new ResearchContractError("missing-key", t("research.key.missing"));
      }
      const controller = new AbortController();
      abortRef.current = controller;
      trackActiveSession(session.sessionId);
      setRunning(true);
      setPauseRequested(false);
      setProgress(t("research.running"));
      setActivity([]);
      setReport(null);
      const result = await port.resume(session.sessionId, {
        signal: controller.signal,
        onSessionStart: (started) => trackActiveSession(started.sessionId),
        onProgress: (value) => setProgress(value.message),
        onEvent: (event) => setActivity((current) =>
          [...current, event].slice(-MAX_RESEARCH_ACTIVITY_EVENTS)
        ),
      });
      setReport(result);
      setProgress("");
    } catch (value) {
      const errorCode = researchErrorCodeV1(value);
      if (errorCode === "cancelled") {
        setActionStatus(t("research.stopped"));
        setProgress("");
      } else if (errorCode === "paused" || errorCode === "scope-approval-required") {
        setActionStatus(t(errorCode === "paused" ? "research.paused" : "research.scopeApprovalRequired"));
        setProgress("");
      } else {
        setError(value instanceof Error ? value.message : t("research.error"));
      }
    } finally {
      abortRef.current = null;
      clearStaleRetainedSession();
      setRunning(false);
      setPauseRequested(false);
      void refreshResumableSessions();
      void refreshRetainedSessions();
      void refreshScopeReviews();
      void refreshScopePlanReviews();
      void refreshPlanReviews();
      void refreshClarificationReviews();
    }
  }

  async function requestPause(): Promise<void> {
    if (!port?.pauseActiveRun || !running || pauseRequested) return;
    setError(null);
    try {
      setPauseRequested(true);
      const status = await port.pauseActiveRun();
      setActionStatus(t(
        status === "paused" ? "research.paused" : "research.pauseRequested",
      ));
    } catch (value) {
      setPauseRequested(false);
      setError(value instanceof Error ? value.message : t("research.error"));
    }
  }

  async function submitChatMessage(value: string): Promise<void> {
    const content = value.trim();
    if (!content) return;
    if (running) {
      chatTurnSequence.current += 1;
      const queued = {
        id: `research-user-turn:${chatTurnSequence.current}`,
        content,
        ...(interactionMode === "chat" && submittedRequest?.question
          ? { baseQuestion: submittedRequest.question }
          : {}),
      };
      setQueuedChatMessages((current) => [...current, queued]);
      setChatTurns((current) => [...current, { ...queued, state: "queued" }]);
      setActionStatus(t("research.chat.queued"));
      return;
    }
    setQuestion(content);
    const accepted = await run(undefined, content);
    if (!accepted) setQuestion(content);
  }

  async function submitImmediateSteering(value: string): Promise<void> {
    const content = value.trim();
    if (!content) return;
    if (!running) {
      await submitChatMessage(content);
      return;
    }
    if (interactionMode === "chat") {
      chatTurnSequence.current += 1;
      const queued = {
        id: `research-steering-turn:${chatTurnSequence.current}`,
        content,
        ...(submittedRequest?.question ? { baseQuestion: submittedRequest.question } : {}),
      };
      setQueuedChatMessages((current) => [queued, ...current]);
      setChatTurns((current) => [...current, { id: queued.id, content, state: "steering" }]);
      expectedDirectSteeringAbort.current = true;
      abortRef.current?.abort();
      setActionStatus(t("research.chat.steeringCheckpoint"));
      return;
    }
    if (!activeSessionId) {
      setError(t("research.chat.steeringUnavailable"));
      return;
    }
    chatTurnSequence.current += 1;
    setChatTurns((current) => [...current, {
      id: `research-steering-turn:${chatTurnSequence.current}`,
      content,
      state: "steering",
    }]);
    setImmediateSteering({ instruction: content, sessionId: activeSessionId });
    setActionStatus(t("research.chat.steeringCheckpoint"));
    await requestPause();
  }

  function beginQueuedTurnEdit(turn: { id: string; content: string }): void {
    setQueuedTurnBeingEdited(turn.id);
    setQueuedTurnDraft(turn.content);
  }

  function saveQueuedTurnEdit(turnId: string): void {
    const content = queuedTurnDraft.trim();
    if (!content) return;
    failedQueuedTurnId.current = null;
    setQueuedChatMessages((current) => current.map((candidate) =>
      candidate.id === turnId ? { ...candidate, content } : candidate
    ));
    setChatTurns((current) => current.map((turn) =>
      turn.id === turnId ? { ...turn, content } : turn
    ));
    setQueuedTurnBeingEdited(null);
    setQueuedTurnDraft("");
  }

  function removeQueuedTurn(turnId: string): void {
    if (failedQueuedTurnId.current === turnId) failedQueuedTurnId.current = null;
    setQueuedChatMessages((current) => current.filter((candidate) => candidate.id !== turnId));
    setChatTurns((current) => current.filter((turn) => turn.id !== turnId));
    if (queuedTurnBeingEdited === turnId) {
      setQueuedTurnBeingEdited(null);
      setQueuedTurnDraft("");
    }
  }

  useEffect(() => {
    if (
      !immediateSteering ||
      running ||
      !port?.listResumableSessions ||
      !port.requestSteering ||
      !port.resume
    ) return;
    let cancelled = false;
    void (async () => {
      try {
        const sessions = await port.listResumableSessions!();
        const session = sessions.find((candidate) =>
          candidate.sessionId === immediateSteering.sessionId,
        );
        if (!session || cancelled) return;
        await port.requestSteering!({
          sessionId: session.sessionId,
          revision: session.revision,
          instruction: immediateSteering.instruction,
        });
        const refreshed = await port.listResumableSessions!();
        if (cancelled) return;
        setResumableSessions(refreshed);
        setImmediateSteering(null);
        setActionStatus(t("research.chat.steeringApplied"));
        const resumed = refreshed.find((candidate) => candidate.sessionId === session.sessionId);
        if (resumed) await resume(resumed);
      } catch (value) {
        if (!cancelled) {
          setImmediateSteering(null);
          setError(value instanceof Error ? value.message : t("research.error"));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [immediateSteering, port, running, t]);

  useEffect(() => {
    const queued = queuedChatMessages[0];
    const session = activeSessionId
      ? retainedSessions.find((candidate) => candidate.sessionId === activeSessionId)
      : undefined;
    if (running || !queued || queueDrainInFlight.current || failedQueuedTurnId.current === queued.id) return;

    if (interactionMode === "chat" && !session) {
      queueDrainInFlight.current = true;
      void (async () => {
        const accepted = await run(undefined, queued.content, queued.id);
        if (!accepted) {
          failedQueuedTurnId.current = queued.id;
          return;
        }
        setQueuedChatMessages((current) => current.filter((candidate) => candidate.id !== queued.id));
        setChatTurns((current) => current.map((turn) =>
          turn.id === queued.id ? { ...turn, state: "sent" } : turn
        ));
      })().finally(() => {
        queueDrainInFlight.current = false;
      });
      return;
    }

    if (!session || !port?.prepareFollowUpTurn) return;

    let cancelled = false;
    queueDrainInFlight.current = true;
    void (async () => {
      setError(null);
      setActionStatus("");
      setFollowUpActionId(session.sessionId);
      try {
        const outcome = await port.prepareFollowUpTurn!({
          sessionId: session.sessionId,
          revision: session.revision,
          question: queued.content,
        });
        if (cancelled) return;
        setQueuedChatMessages((current) => current.filter((candidate) => candidate.id !== queued.id));
        setChatTurns((current) => current.map((turn) =>
          turn.id === queued.id ? { ...turn, state: "sent" } : turn
        ));
        if (outcome.kind === "plan_review") {
          ++planReviewListingGeneration.current;
          setPlanReviews((current) => [
            outcome.review,
            ...current.filter((candidate) => candidate.sessionId !== outcome.review.sessionId),
          ]);
          setActionStatus(t("research.followUp.prepared"));
          return;
        }
        setResumableSessions((current) => [
          outcome.session,
          ...current.filter((candidate) => candidate.sessionId !== outcome.session.sessionId),
        ]);
        setActionStatus(t("research.followUp.prepared"));
        await resume(outcome.session);
      } catch (value) {
        if (!cancelled) {
          failedQueuedTurnId.current = queued.id;
          setError(value instanceof Error ? value.message : t("research.error"));
        }
      } finally {
        queueDrainInFlight.current = false;
        if (!cancelled) {
          setFollowUpActionId(null);
          void refreshRetainedSessions();
          void refreshResumableSessions();
          void refreshPlanReviews();
        }
      }
    })();
    return () => { cancelled = true; };
  }, [
    activeSessionId,
    interactionMode,
    port,
    queuedChatMessages,
    report,
    retainedSessions,
    running,
    t,
  ]);

  async function prepareFollowUpTurn(session: ResearchRetainedSessionV1): Promise<void> {
    const question = followUpQuestions[session.sessionId]?.trim();
    if (!question || !port?.prepareFollowUpTurn) return;
    setError(null);
    setActionStatus("");
    setFollowUpActionId(session.sessionId);
    try {
      const outcome = await port.prepareFollowUpTurn({
        sessionId: session.sessionId,
        revision: session.revision,
        question,
      });
      setFollowUpQuestions((current) => ({ ...current, [session.sessionId]: "" }));
      if (outcome.kind === "plan_review") {
        ++planReviewListingGeneration.current;
        setPlanReviews((current) => [
          outcome.review,
          ...current.filter((candidate) => candidate.sessionId !== outcome.review.sessionId),
        ]);
      } else {
        setResumableSessions((current) => [
          outcome.session,
          ...current.filter((candidate) => candidate.sessionId !== outcome.session.sessionId),
        ]);
      }
      setActionStatus(t("research.followUp.prepared"));
    } catch (value) {
      setError(value instanceof Error ? value.message : t("research.error"));
    } finally {
      setFollowUpActionId(null);
      void refreshRetainedSessions();
      void refreshResumableSessions();
      void refreshPlanReviews();
    }
  }

  async function requestSteering(session: ResearchResumableSessionV1): Promise<void> {
    const instruction = steeringInstructions[session.sessionId]?.trim();
    if (!instruction || !port?.requestSteering) return;
    setError(null);
    try {
      await port.requestSteering({
        sessionId: session.sessionId,
        revision: session.revision,
        instruction,
      });
      setSteeringInstructions((current) => ({ ...current, [session.sessionId]: "" }));
      setActionStatus(t("research.steering.saved"));
      await refreshResumableSessions();
    } catch (value) {
      setError(value instanceof Error ? value.message : t("research.error"));
    }
  }

  async function decideScopeReview(
    review: ResearchSessionScopeReviewV1,
    proposal: ResearchSessionScopeReviewV1["turn"]["expansionProposals"][number],
    decision: "approve" | "reject",
  ): Promise<void> {
    const actionId = `${review.sessionId}:${proposal.id}`;
    const decide = decision === "approve"
      ? port?.approveScopeReview
      : port?.rejectScopeReview;
    if (!decide) return;
    setError(null);
    setActionStatus("");
    setScopeReviewActionId(actionId);
    try {
      const updated = await decide({
        sessionId: review.sessionId,
        revision: review.revision,
        briefRevision: review.turn.briefRevision,
        graphRevision: review.turn.graphRevision,
        proposalId: proposal.id,
      });
      setScopeReviews((current) => current.map((candidate) =>
        candidate.sessionId === updated.sessionId ? updated : candidate,
      ));
      setActionStatus(t(
        decision === "approve"
          ? "research.scopeReview.approved"
          : "research.scopeReview.rejected",
      ));
      await refreshScopeReviews();
      await refreshScopePlanReviews();
      await refreshPlanReviews();
      void refreshResumableSessions();
    } catch (value) {
      setError(value instanceof Error ? value.message : t("research.error"));
    } finally {
      setScopeReviewActionId(null);
    }
  }

  async function approveScopePlanReview(
    review: ResearchSessionScopeReviewV1,
  ): Promise<void> {
    if (!port?.approveScopePlanReview) return;
    const actionId = review.sessionId;
    setError(null);
    setActionStatus("");
    setScopePlanReviewActionId(actionId);
    try {
      const updated = await port.approveScopePlanReview({
        sessionId: review.sessionId,
        revision: review.revision,
        briefRevision: review.turn.briefRevision,
        graphRevision: review.turn.graphRevision,
      });
      setScopePlanReviews((current) => current.map((candidate) =>
        candidate.sessionId === updated.sessionId ? updated : candidate,
      ));
      setActionStatus(t("research.scopePlanReview.approved"));
      await refreshScopePlanReviews();
      void refreshScopeReviews();
      void refreshResumableSessions();
    } catch (value) {
      setError(value instanceof Error ? value.message : t("research.error"));
    } finally {
      setScopePlanReviewActionId(null);
    }
  }

  async function approvePlanReview(review: ResearchSessionPlanReviewV1): Promise<void> {
    if (!port?.approvePlanReview) return;
    setError(null);
    setActionStatus("");
    setPlanReviewActionId(review.sessionId);
    try {
      const session = await port.approvePlanReview({
        sessionId: review.sessionId,
        revision: review.revision,
        briefRevision: review.turn.briefRevision,
        graphRevision: review.turn.graphRevision,
      });
      setPlanReviews((current) => current.filter((candidate) => candidate.sessionId !== review.sessionId));
      setResumableSessions((current) => [
        session,
        ...current.filter((candidate) => candidate.sessionId !== session.sessionId),
      ]);
      setActionStatus(t("research.planReview.approved"));
      await refreshPlanReviews();
      void refreshResumableSessions();
    } catch (value) {
      setError(value instanceof Error ? value.message : t("research.error"));
    } finally {
      setPlanReviewActionId(null);
    }
  }

  async function rejectPlanReview(review: ResearchSessionPlanReviewV1): Promise<void> {
    if (!port?.rejectPlanReview) return;
    const instruction = planRevisionInstructions[review.sessionId]?.trim() ?? "";
    if (!instruction) {
      setError(t("research.planReview.correctionRequired"));
      return;
    }
    setError(null);
    setActionStatus("");
    setPlanReviewActionId(review.sessionId);
    try {
      const replacement = await port.rejectPlanReview({
        sessionId: review.sessionId,
        revision: review.revision,
        briefRevision: review.turn.briefRevision,
        graphRevision: review.turn.graphRevision,
        instruction,
      });
      setPlanRevisionInstructions((current) => {
        const next = { ...current };
        delete next[review.sessionId];
        return next;
      });
      setPlanReviews((current) => [
        replacement,
        ...current.filter((candidate) => candidate.sessionId !== review.sessionId),
      ]);
      setActionStatus(t("research.planReview.revised"));
      await refreshPlanReviews();
    } catch (value) {
      setError(value instanceof Error ? value.message : t("research.error"));
    } finally {
      setPlanReviewActionId(null);
    }
  }

  function clarificationAnswerKey(
    review: ResearchSessionClarificationReviewV1,
    questionId: string,
  ): string {
    return `${review.sessionId}:${review.revision}:${questionId}`;
  }

  function clarificationDecisionKey(
    review: ResearchSessionClarificationReviewV1,
    assumptionId: string,
  ): string {
    return `${review.sessionId}:${review.revision}:${assumptionId}`;
  }

  function applyClarificationOutcome(
    review: ResearchSessionClarificationReviewV1,
    outcome: Awaited<ReturnType<NonNullable<ResearchPort["resolveClarificationReview"]>>>,
  ): void {
    setClarificationReviews((current) => current.filter((candidate) =>
      candidate.sessionId !== review.sessionId,
    ));
    if (outcome.kind === "plan_review") {
      setPlanReviews((current) => [
        outcome.review,
        ...current.filter((candidate) => candidate.sessionId !== outcome.review.sessionId),
      ]);
      setActionStatus(t("research.clarificationReview.planPrepared"));
      return;
    }
    setResumableSessions((current) => [
      outcome.session,
      ...current.filter((candidate) => candidate.sessionId !== outcome.session.sessionId),
    ]);
    setActionStatus(t("research.clarificationReview.resumable"));
  }

  function scopeClarificationSelectionKey(
    review: ResearchSessionScopeClarificationReviewV1,
  ): string {
    return `${review.sessionId}:${review.revision}`;
  }

  function applyScopeClarificationOutcome(
    review: ResearchSessionScopeClarificationReviewV1,
    outcome: Awaited<ReturnType<NonNullable<ResearchPort["resolveScopeClarificationReview"]>>>,
  ): void {
    setScopeClarificationReviews((current) => current.filter((candidate) =>
      candidate.sessionId !== review.sessionId,
    ));
    if (outcome.kind === "scope_clarification") {
      setScopeClarificationReviews((current) => [
        outcome.review,
        ...current.filter((candidate) => candidate.sessionId !== outcome.review.sessionId),
      ]);
      setActionStatus(t("research.clarificationReview.prepared"));
      return;
    }
    if (outcome.kind === "clarification_review") {
      setClarificationReviews((current) => [
        outcome.review,
        ...current.filter((candidate) => candidate.sessionId !== outcome.review.sessionId),
      ]);
      setActionStatus(t("research.clarificationReview.prepared"));
      return;
    }
    if (outcome.kind === "plan_review") {
      setPlanReviews((current) => [
        outcome.review,
        ...current.filter((candidate) => candidate.sessionId !== outcome.review.sessionId),
      ]);
      setActionStatus(t("research.clarificationReview.planPrepared"));
      return;
    }
    setResumableSessions((current) => [
      outcome.session,
      ...current.filter((candidate) => candidate.sessionId !== outcome.session.sessionId),
    ]);
    setActionStatus(t("research.clarificationReview.resumable"));
  }

  async function resolveScopeClarificationReview(
    review: ResearchSessionScopeClarificationReviewV1,
  ): Promise<void> {
    if (!port?.resolveScopeClarificationReview || review.stage !== "choice_required") return;
    const selectionKey = scopeClarificationSelectionKey(review);
    const candidateId = scopeClarificationSelections[selectionKey];
    if (!candidateId) return;
    setError(null);
    setActionStatus("");
    setScopeClarificationActionId(selectionKey);
    try {
      const outcome = await port.resolveScopeClarificationReview({
        sessionId: review.sessionId,
        revision: review.revision,
        selection: {
          schema: "atlcli.research-scope-candidate-selection/v1",
          mentionId: review.clarification.mentionId,
          candidateId,
        },
      });
      applyScopeClarificationOutcome(review, outcome);
      await refreshScopeClarificationReviews();
      void refreshClarificationReviews();
      void refreshPlanReviews();
      void refreshResumableSessions();
    } catch (value) {
      setError(value instanceof Error ? value.message : t("research.error"));
    } finally {
      setScopeClarificationActionId(null);
    }
  }

  async function continueScopeClarificationReview(
    review: ResearchSessionScopeClarificationReviewV1,
  ): Promise<void> {
    if (!port?.continueScopeClarificationReview || review.stage === "choice_required") return;
    const actionId = scopeClarificationSelectionKey(review);
    setError(null);
    setActionStatus("");
    setScopeClarificationActionId(actionId);
    try {
      const outcome = await port.continueScopeClarificationReview({
        sessionId: review.sessionId,
        revision: review.revision,
      });
      applyScopeClarificationOutcome(review, outcome);
      await refreshScopeClarificationReviews();
      void refreshClarificationReviews();
      void refreshPlanReviews();
      void refreshResumableSessions();
    } catch (value) {
      setError(value instanceof Error ? value.message : t("research.error"));
    } finally {
      setScopeClarificationActionId(null);
    }
  }

  async function resolveClarificationReview(
    review: ResearchSessionClarificationReviewV1,
  ): Promise<void> {
    if (!port?.resolveClarificationReview || review.stage !== "answer_required") return;
    const actionId = `${review.sessionId}:${review.revision}`;
    setError(null);
    setActionStatus("");
    setClarificationActionId(actionId);
    try {
      const outcome = await port.resolveClarificationReview({
        sessionId: review.sessionId,
        revision: review.revision,
        briefRevision: review.turn.briefRevision,
        answers: review.turn.questions.map((question) => ({
          questionId: question.id,
          response: clarificationAnswers[clarificationAnswerKey(review, question.id)] ?? "",
        })),
        assumptionDecisions: review.turn.assumptions.map((assumption) => ({
          assumptionId: assumption.id,
          decision: clarificationDecisions[clarificationDecisionKey(review, assumption.id)] as "accepted" | "rejected",
        })),
      });
      applyClarificationOutcome(review, outcome);
      await refreshClarificationReviews();
      void refreshPlanReviews();
      void refreshResumableSessions();
    } catch (value) {
      setError(value instanceof Error ? value.message : t("research.error"));
    } finally {
      setClarificationActionId(null);
    }
  }

  async function continueClarificationReview(
    review: ResearchSessionClarificationReviewV1,
  ): Promise<void> {
    if (!port?.continueClarificationReview || review.stage !== "plan_required") return;
    const actionId = `${review.sessionId}:${review.revision}`;
    setError(null);
    setActionStatus("");
    setClarificationActionId(actionId);
    try {
      const outcome = await port.continueClarificationReview({
        sessionId: review.sessionId,
        revision: review.revision,
        briefRevision: review.turn.briefRevision,
      });
      applyClarificationOutcome(review, outcome);
      await refreshClarificationReviews();
      void refreshPlanReviews();
      void refreshResumableSessions();
    } catch (value) {
      setError(value instanceof Error ? value.message : t("research.error"));
    } finally {
      setClarificationActionId(null);
    }
  }

  const previewScope = site
    ? inferResearchScope({
        siteOrigin: site.origin,
        question,
        jiraProjects,
        confluenceSpaces,
        activeSpaceKey: site.activeSpaceKey,
        activeProjectKey: site.activeProjectKey,
      activeEntity: includeCurrentContext ? site.activeEntity : undefined,
    })
    : null;
  const removableScopeSeeds = (previewScope?.scopeSeeds ?? []).filter(
    (seed) => seed.binding.source === "ui_added" || seed.binding.source === "current_context",
  );

  function removeScopeChip(seed: ResearchScopeSeedV1): void {
    if (seed.binding.source === "current_context") {
      setIncludeCurrentContext(false);
      return;
    }
    const current = seed.binding.product === "jira" ? jiraProjects : confluenceSpaces;
    const next = splitScopeValues(current).filter(
      (key) => key.toLocaleUpperCase("en-US") !== seed.binding.key?.toLocaleUpperCase("en-US"),
    ).join(", ");
    if (seed.binding.product === "jira") setJiraProjects(next);
    else setConfluenceSpaces(next);
  }

  function selectInteractionMode(
    mode: ResearchInteractionMode,
    thinkingMode: ChatThinkingModeV1 = chatThinkingMode,
  ): void {
    const policy = mode === "chat"
      ? chatPolicyForThinkingModeV1(thinkingMode)
      : RESEARCH_INTERACTION_MODE_POLICY.deep;
    setInteractionMode(mode);
    setPlanApproval(policy.requestedPlanApproval);
    setScopeExpansion(policy.scopeExpansionMode);
    setReconciliation(policy.requestedReconciliation);
  }

  function selectChatThinkingMode(mode: ChatThinkingModeV1): void {
    setChatThinkingMode(mode);
  }

  async function startNewConversation(): Promise<void> {
    if (running) return;
    await port?.resetChatConversation?.();
    setChatThinkingMode("auto");
    selectInteractionMode("chat", "auto");
    setQuestion("");
    setChatTurns([]);
    setQueuedChatMessages([]);
    setActiveSessionId(null);
    activeSessionIdRef.current = null;
    activeChatConversationIdRef.current = null;
    setImmediateSteering(null);
    setSubmittedRequest(null);
    setReport(null);
    setError(null);
    setActivity([]);
    setProgress("");
    setActionStatus("");
    setConversationMenuOpen(false);
  }

  /**
   * CopilotKit owns the chat configuration contract. The host renders the
   * compact composer shell itself because the full message-renderer barrel
   * includes dynamic code renderers that are forbidden by MV3 CSP.
   */
  function ComposerAddMenuButton({
    className: _className,
    onAddFile: _onAddFile,
    toolsMenu: _toolsMenu,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    onAddFile?: () => void;
    toolsMenu?: unknown;
  },
  ): React.JSX.Element {
    return (
      <div className="relative">
        {composerAddMenuOpen && (
          <div
            role="region"
            aria-label={t("research.chat.addMenu.label")}
            className="absolute bottom-full left-0 z-30 mb-2 w-64 rounded-lg border bg-popover p-3 text-sm text-muted-foreground shadow-lg"
            data-testid="research-composer-add-menu"
          >
            <p className="m-0">{t("research.chat.addMenu.empty")}</p>
          </div>
        )}
        <Button
          {...props}
          size="icon"
          variant={composerAddMenuOpen ? "outline" : "ghost"}
          className="size-9 rounded-md"
          aria-label={t(
            composerAddMenuOpen
              ? "research.chat.addMenu.close"
              : "research.chat.addMenu.open",
          )}
          aria-expanded={composerAddMenuOpen}
          data-testid="research-composer-add-menu-toggle"
          onClick={(event) => {
            props.onClick?.(event);
            if (!event.defaultPrevented) setComposerAddMenuOpen((open) => !open);
          }}
        >
          {composerAddMenuOpen
            ? <X className="size-4" aria-hidden="true" />
            : <Plus className="size-4" aria-hidden="true" />}
        </Button>
      </div>
    );
  }

  function ComposerSendButton({
    className: _className,
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
    const submitLabel = interactionMode === "chat"
      ? t("research.chat.send")
      : t("research.run");
    return (
      <Button
        {...props}
        size="icon"
        className={cn(
          "size-9 shrink-0 rounded-lg text-primary-foreground disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100",
          running
            ? "bg-destructive hover:bg-destructive/90"
            : "bg-primary hover:bg-primary/90",
        )}
        aria-label={running ? t("research.stop") : submitLabel}
        title={running ? t("research.stop") : submitLabel}
        data-testid="research-run"
      >
        {children ?? (running
          ? <Square className="size-3.5 fill-current" aria-hidden="true" />
          : <ArrowUp className="size-4" aria-hidden="true" />)}
      </Button>
    );
  }

  const hasConversation = chatTurns.length > 0 || running || Boolean(report) || Boolean(error);
  const currentContextLabel = site?.contextLabel;
  const displayScopeKeys = (
    keys: readonly string[],
    product: "jira" | "confluence",
  ): string => keys.map((key) => {
    if (product !== "confluence" || !key.startsWith("~")) return key;
    if (key === site?.activeSpaceKey && currentContextLabel) return currentContextLabel;
    return t("research.chat.personalSpace");
  }).join(", ") || "—";

  return (
    <div className="relative flex flex-col gap-3" data-testid="research-screen">
      <header className="flex items-center gap-1.5 px-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <Button
            size="icon"
            variant="ghost"
            className="-ml-2 size-9 shrink-0"
            aria-label={conversationMenuOpen
              ? t("research.chat.history.close")
              : t("research.chat.history.open")}
            aria-expanded={conversationMenuOpen}
            data-testid="research-conversation-menu-toggle"
            onClick={() => setConversationMenuOpen((open) => !open)}
          >
            {conversationMenuOpen
              ? <X className="size-4.5" aria-hidden="true" />
              : <Menu className="size-4.5" aria-hidden="true" />}
          </Button>
          <div className="min-w-0">
          <h1 className="m-0 text-lg font-semibold tracking-tight text-foreground">
            {interactionMode === "deep"
              ? t("research.chat.mode.deep")
              : t("research.chat.title")}
          </h1>
          </div>
        </div>
      </header>

      {conversationMenuOpen && (
        <section
          className="absolute inset-x-0 top-12 z-40 max-h-[calc(100vh-5rem)] overflow-auto rounded-xl border bg-background p-3 shadow-xl"
          aria-label={t("research.chat.history.title")}
          data-testid="research-conversation-menu"
        >
          <Button
            className="w-full justify-start"
            variant="ghost"
            disabled={running}
            onClick={() => void startNewConversation()}
            data-testid="research-new-conversation"
          >
            <Pencil className="size-4" aria-hidden="true" />
            {t("research.chat.history.new")}
          </Button>
          <div className="my-2 border-t" />
          <h2 className="m-0 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("research.chat.history.title")}
          </h2>
          {resumableSessions.length === 0 && retainedSessions.length === 0 && (
            <p className="mb-0 mt-2 px-2 text-sm text-muted-foreground">
              {t("research.chat.history.empty")}
            </p>
          )}
          {resumableSessions.length > 0 && (
            <div className="mt-2 space-y-1" data-testid="research-resumable-sessions">
              {resumableSessions.map((session, index) => (
                <div className="rounded-lg border p-2 text-xs" key={session.sessionId} data-testid={`research-resumable-session-${index}`}>
                  <p className="m-0 font-medium">{session.question}</p>
                  <p className="mb-0 mt-1 text-muted-foreground">
                    {t("research.resumeScope", {
                      jira: displayScopeKeys(session.scope.jiraProjectKeys, "jira"),
                      confluence: displayScopeKeys(session.scope.confluenceSpaceKeys, "confluence"),
                      status: session.status,
                    })}
                  </p>
                  <Button className="mt-2" size="sm" disabled={running || !disclosed || !hasKey} data-testid={`research-resume-${index}`} onClick={() => void resume(session)}>
                    {t("research.resume")}
                  </Button>
                  {port?.requestSteering && session.status === "paused" && (
                    <div className="mt-2 flex gap-2">
                      <Input
                        value={steeringInstructions[session.sessionId] ?? ""}
                        onChange={(event) => setSteeringInstructions((current) => ({ ...current, [session.sessionId]: event.target.value }))}
                        placeholder={t("research.steering.placeholder")}
                        disabled={running}
                        data-testid={`research-steering-input-${index}`}
                      />
                      <Button size="sm" variant="outline" disabled={running || !(steeringInstructions[session.sessionId] ?? "").trim()} data-testid={`research-steering-submit-${index}`} onClick={() => void requestSteering(session)}>
                        {t("research.steering.submit")}
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {retainedSessions.length > 0 && (
            <div className="mt-2 space-y-1" data-testid="research-retained-sessions">
              {retainedSessions.map((session, index) => {
                const preparing = followUpActionId === session.sessionId;
                const followUpQuestion = followUpQuestions[session.sessionId] ?? "";
                return (
                  <details className="rounded-lg border p-2 text-xs" key={session.sessionId} data-testid={`research-retained-session-${index}`}>
                    <summary className="cursor-pointer font-medium">{session.question}</summary>
                    <p className="mb-0 mt-1 text-muted-foreground">
                      {t("research.resumeScope", {
                        jira: displayScopeKeys(session.scope.jiraProjectKeys, "jira"),
                        confluence: displayScopeKeys(session.scope.confluenceSpaceKeys, "confluence"),
                        status: session.status,
                      })}
                    </p>
                    <Label className="mt-2 block" htmlFor={`research-follow-up-question-${index}`}>
                      {t("research.followUp.question")}
                    </Label>
                    <textarea
                      id={`research-follow-up-question-${index}`}
                      className="mt-1 w-full rounded-md border bg-background p-2 text-xs"
                      rows={3}
                      maxLength={10_000}
                      disabled={running || followUpActionId !== null}
                      data-testid={`research-follow-up-question-${index}`}
                      placeholder={t("research.followUp.placeholder")}
                      value={followUpQuestion}
                      onChange={(event) => setFollowUpQuestions((current) => ({ ...current, [session.sessionId]: event.target.value }))}
                    />
                    <Button className="mt-2" size="sm" disabled={running || followUpActionId !== null || !followUpQuestion.trim()} data-testid={`research-follow-up-prepare-${index}`} onClick={() => void prepareFollowUpTurn(session)}>
                      {preparing ? t("research.followUp.preparing") : t("research.followUp.prepare")}
                    </Button>
                  </details>
                );
              })}
            </div>
          )}
        </section>
      )}

      <CopilotChatConfigurationProvider
        labels={{
          chatInputPlaceholder: t("research.chat.placeholder"),
          chatInputToolbarAddButtonLabel: t("research.chat.addContext"),
          chatInputToolbarToolsButtonLabel: t("research.chat.settings"),
        }}
      >
        <section className="flex min-h-[28rem] flex-col gap-3" data-testid="research-chat">
          <div className="flex flex-1 flex-col gap-3 overflow-auto px-0.5" data-testid="research-chat-timeline">
            {!hasConversation && (
              <div className="py-2" data-testid="research-chat-welcome">
                <p className="m-0 text-sm leading-6 text-muted-foreground">
                  {t("research.chat.welcome")}
                </p>
                <div className="my-4 border-t border-border/70" aria-hidden="true" />
                <div className="flex flex-col gap-1" data-testid="research-chat-suggestions">
                  <button
                    type="button"
                    className="group flex min-h-11 items-center gap-3 rounded-xl px-2.5 text-left text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => setQuestion(t("research.chat.suggestion.summarizePrompt"))}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground group-hover:text-foreground">
                      <FileText className="size-4.5" aria-hidden="true" />
                    </span>
                    <span>{t("research.chat.suggestion.summarize")}</span>
                  </button>
                  <button
                    type="button"
                    className="group flex min-h-11 items-center gap-3 rounded-xl px-2.5 text-left text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      selectInteractionMode("deep");
                      setQuestion(t("research.chat.suggestion.connectionsPrompt"));
                    }}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground group-hover:text-foreground">
                      <Search className="size-4.5" aria-hidden="true" />
                    </span>
                    <span>{t("research.chat.suggestion.connections")}</span>
                  </button>
                  <button
                    type="button"
                    className="group flex min-h-11 items-center gap-3 rounded-xl px-2.5 text-left text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => setQuestion(t("research.chat.suggestion.changesPrompt"))}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground group-hover:text-foreground">
                      <MessageCircle className="size-4.5" aria-hidden="true" />
                    </span>
                    <span>{t("research.chat.suggestion.changes")}</span>
                  </button>
                </div>
              </div>
            )}
            {chatTurns.map((turn) => (
              <div key={turn.id} className="flex flex-col gap-1">
                {turn.state !== "sent" && queuedTurnBeingEdited === turn.id ? (
                  <div className="max-w-[92%] self-end rounded-lg border bg-muted p-2">
                    <textarea
                      className="min-h-20 w-full resize-y rounded-md border bg-background px-2 py-1.5 text-sm text-foreground"
                      value={queuedTurnDraft}
                      onChange={(event) => setQueuedTurnDraft(event.target.value)}
                      aria-label={t("research.chat.editQueued")}
                      data-testid={`research-queued-edit-${turn.id}`}
                    />
                    <div className="mt-2 flex justify-end gap-1.5">
                      <Button
                        size="sm"
                        disabled={!queuedTurnDraft.trim()}
                        onClick={() => saveQueuedTurnEdit(turn.id)}
                        data-testid={`research-queued-save-${turn.id}`}
                      >
                        {t("research.chat.saveQueued")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setQueuedTurnBeingEdited(null);
                          setQueuedTurnDraft("");
                        }}
                        data-testid={`research-queued-cancel-${turn.id}`}
                      >
                        {t("research.chat.cancelQueued")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div
                    className="max-w-[92%] self-end rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
                    data-testid={`research-chat-user-${turn.id}`}
                  >
                    {turn.content}
                  </div>
                )}
                {turn.state !== "sent" && (
                  <div className="flex items-center justify-end gap-1">
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                      {turn.state === "queued"
                        ? t("research.chat.queued")
                        : t("research.chat.steeringCheckpoint")}
                    </span>
                    {queuedTurnBeingEdited !== turn.id && (
                      <>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-7"
                          aria-label={t("research.chat.editQueued")}
                          title={t("research.chat.editQueued")}
                          onClick={() => beginQueuedTurnEdit(turn)}
                          data-testid={`research-queued-edit-${turn.id}`}
                        >
                          <Pencil className="size-3.5" aria-hidden="true" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-7 text-destructive hover:text-destructive"
                          aria-label={t("research.chat.removeQueued")}
                          title={t("research.chat.removeQueued")}
                          onClick={() => removeQueuedTurn(turn.id)}
                          data-testid={`research-queued-remove-${turn.id}`}
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
            <ResearchStreamingTurn
              activity={activity}
              progress={progress}
              running={running}
              request={submittedRequest}
            />
            {error && (
              <Alert tone="danger" role="alert" data-testid="research-error">
                <AlertTitle>{t("research.error")}</AlertTitle>
                <p className="m-0 mt-1">{error}</p>
                <details className="mt-3" data-testid="research-error-diagnostics">
                  <summary className="cursor-pointer text-sm font-medium">
                    {t("research.chat.errorDiagnostics")}
                  </summary>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">{t("research.chat.errorDiagnostics.mode")}</dt>
                    <dd className="m-0">{interactionMode === "chat"
                      ? t("research.chat.mode.chat")
                      : t("research.chat.mode.deep")}</dd>
                    <dt className="text-muted-foreground">{t("research.chat.errorDiagnostics.context")}</dt>
                    <dd className="m-0 break-words">{currentContextLabel ?? t("research.chat.errorDiagnostics.noContext")}</dd>
                    <dt className="text-muted-foreground">{t("research.chat.errorDiagnostics.result")}</dt>
                    <dd className="m-0">{t("research.chat.errorDiagnostics.noReport")}</dd>
                  </dl>
                </details>
              </Alert>
            )}
            {report && (
              <div className="rounded-lg border border-border/70 bg-card px-3 py-2" data-testid="research-chat-report">
                {report.schema === "atlcli.chat-answer/v1"
                  ? <ChatAnswer answer={report} />
                  : interactionMode === "chat"
                    ? <LegacyChatAnswer report={report} />
                    : <FormattedReport report={report} />}
                <div className="mt-3 flex flex-wrap gap-2 border-t pt-3">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void port.copyMarkdown(
                      report.schema === "atlcli.chat-answer/v1"
                        ? report.messageMarkdown
                        : report.markdown,
                    ).then(() => setActionStatus(t("research.copied")))}
                    data-testid="research-copy"
                  >
                    {t("research.copy")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void port.downloadMarkdown(
                      report.schema === "atlcli.chat-answer/v1"
                        ? report.messageMarkdown
                        : report.markdown,
                      report.schema === "atlcli.chat-answer/v1"
                        ? "chat-answer.md"
                        : `${report.title}.md`,
                    ).then(() => setActionStatus(t("research.downloaded")))}
                    data-testid="research-download"
                  >
                    {t("research.download")}
                  </Button>
                </div>
              </div>
            )}
          </div>
          {includeCurrentContext && currentContextLabel ? (
            <div
              className="flex min-h-11 items-center gap-2 rounded-xl bg-muted px-3 py-2 text-xs"
              data-testid="research-context-chips"
            >
              <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="shrink-0 font-medium text-muted-foreground">{t("research.chat.context")}</span>
              <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={currentContextLabel}>
                {currentContextLabel}
              </span>
              <Button
                size="icon"
                variant="ghost"
                className="size-8 shrink-0 rounded-lg text-muted-foreground"
                aria-label={t("research.chat.context.remove")}
                onClick={() => setIncludeCurrentContext(false)}
                data-testid="research-current-context-remove"
              >
                <X aria-hidden="true" />
              </Button>
            </div>
          ) : null}
          <div
            data-copilotkit="true"
            className="w-full"
            data-testid="research-chat-composer"
          >
            <div
              className="overflow-visible rounded-[22px] border border-input bg-card transition-colors focus-within:border-ring"
              data-testid="research-chat-composer-shell"
            >
              <textarea
                data-testid="copilot-chat-textarea"
                value={question}
                onChange={(event) => setQuestion(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                  const value = event.currentTarget.value;
                  if (event.metaKey && event.shiftKey) {
                    event.preventDefault();
                    setQuestion("");
                    void submitImmediateSteering(value);
                    return;
                  }
                  if (!event.shiftKey) {
                    event.preventDefault();
                    setQuestion("");
                    void submitChatMessage(value);
                  }
                }}
                placeholder={t("research.chat.placeholder")}
                className="min-h-24 w-full resize-none border-0 bg-transparent px-4 pb-2 pt-3 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-none"
                aria-label={t("research.chat.placeholder")}
              />
              <div className="flex items-center gap-1.5 border-t border-border/70 px-2.5 py-2">
                <ComposerAddMenuButton />
                <div
                  className="flex min-w-0 items-center rounded-lg bg-muted p-0.5"
                  role="group"
                  aria-label={t("research.chat.mode.label")}
                >
                  <button
                    type="button"
                    className={cn(
                      "inline-flex min-h-7 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors",
                      interactionMode === "chat"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    aria-pressed={interactionMode === "chat"}
                    onClick={() => selectInteractionMode("chat")}
                    data-testid="research-mode-chat"
                  >
                    <MessageCircle className="size-3.5" aria-hidden="true" />
                    {t("research.chat.mode.chat")}
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "inline-flex min-h-7 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors",
                      interactionMode === "deep"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    aria-pressed={interactionMode === "deep"}
                    onClick={() => selectInteractionMode("deep")}
                    data-testid="research-mode-deep"
                  >
                    <Telescope className="size-3.5" aria-hidden="true" />
                    {t("research.chat.mode.deepShort")}
                  </button>
                </div>
                {interactionMode === "chat" && (
                  <Select
                    value={chatThinkingMode}
                    onChange={(event) => selectChatThinkingMode(
                      event.target.value as ChatThinkingModeV1,
                    )}
                    disabled={running}
                    aria-label={t("research.chat.thinking.label")}
                    title={t("research.chat.thinking.label")}
                    className="h-7 w-[7.75rem] min-w-0 rounded-md border-0 bg-transparent px-1 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid="research-chat-thinking"
                  >
                    <option value="auto">{t("research.chat.thinking.auto")}</option>
                    <option value="quick">{t("research.chat.thinking.quick")}</option>
                    <option value="deep">{t("research.chat.thinking.deep")}</option>
                  </Select>
                )}
                <div className="ml-auto">
                  <ComposerSendButton
                    disabled={running ? false : question.trim().length === 0}
                    onClick={() => {
                      if (running) {
                        abortRef.current?.abort(new ResearchContractError("cancelled", t("research.stopped")));
                        return;
                      }
                      const value = question;
                      setQuestion("");
                      void submitChatMessage(value);
                    }}
                  />
                </div>
              </div>
              <label className="flex cursor-pointer items-start gap-2 border-t border-border/60 px-3 py-2 text-[11px] leading-4 text-muted-foreground">
                <input
                  type="checkbox"
                  className="mt-px size-3.5 shrink-0 rounded border-input accent-primary"
                  checked={disclosed}
                  onChange={(event) => setDisclosed(event.target.checked)}
                  disabled={running}
                  data-testid="research-disclosure"
                />
                <span>{t("research.disclosure")}</span>
              </label>
            </div>
          </div>
          <p className="m-0 px-1 text-center text-[11px] text-muted-foreground">
            {running
              ? t("research.chat.composerHelp.running")
              : t("research.chat.composerHelp.idle")}
          </p>
        </section>
      </CopilotChatConfigurationProvider>

      <details
        className="hidden"
        aria-hidden="true"
        data-testid="research-settings"
      >
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{t("research.chat.settings")}</summary>
        <Card>
        <CardContent className="flex flex-col gap-3 p-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="research-site">{t("research.site")}</Label>
            <Input id="research-site" value={site?.origin ?? ""} readOnly disabled />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="research-question">{t("research.question")}</Label>
            <textarea
              id="research-question"
              data-testid="research-question"
              className="min-h-28 w-full resize-y rounded-md border bg-background px-2.5 py-2 text-sm text-foreground placeholder:text-muted-foreground"
              value={question}
              maxLength={2_000}
              placeholder={t("research.question.placeholder")}
              onChange={(event) => setQuestion(event.target.value)}
              disabled={running}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="research-jira">{t("research.jiraProjects")}</Label>
              <Input id="research-jira" data-testid="research-jira" value={jiraProjects} onChange={(event) => setJiraProjects(event.target.value)} disabled={running} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="research-wiki">{t("research.confluenceSpaces")}</Label>
              <Input id="research-wiki" data-testid="research-wiki" value={confluenceSpaces} onChange={(event) => setConfluenceSpaces(event.target.value)} disabled={running} />
            </div>
          </div>
          {removableScopeSeeds.length > 0 && (
            <div className="flex flex-wrap gap-1" data-testid="research-scope-chips">
              {removableScopeSeeds.map((seed, index) => (
                <button
                  key={seed.binding.id}
                  type="button"
                  className="rounded-full border bg-muted px-2 py-1 text-xs"
                  disabled={running}
                  onClick={() => removeScopeChip(seed)}
                  data-testid={`research-scope-chip-${index}`}
                  aria-label={t("research.scopeChip.remove", {
                    scope: `${seed.binding.product}: ${seed.binding.key ?? seed.binding.name}`,
                  })}
                >
                  {seed.binding.product}: {seed.binding.key ?? seed.binding.name} ×
                </button>
              ))}
            </div>
          )}
          {submittedRequest && (
            <div
              className="rounded-md border bg-muted/50 p-2 text-xs"
              data-testid="research-submitted-scope"
            >
              <strong>{t("research.submittedScope")}</strong>{" "}
              {[
                ...submittedRequest.scope.jiraProjectKeys.map((key) => `jira:${key}`),
                ...submittedRequest.scope.confluenceSpaceKeys.map((key) => `confluence:${key}`),
              ].join(", ")}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            {interactionMode === "deep" && (
              <>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="research-plan-approval">{t("research.planApproval")}</Label>
                  <Select
                    id="research-plan-approval"
                    data-testid="research-plan-approval"
                    value={planApproval}
                    onChange={(event) => setPlanApproval(event.target.value as ResearchRequestedPlanApprovalV1)}
                    disabled={running}
                  >
                    <option value="default">{t("research.planApproval.default")}</option>
                    <option value="automatic">{t("research.planApproval.automatic")}</option>
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="research-scope-expansion">{t("research.scopeExpansion")}</Label>
                  <Select
                    id="research-scope-expansion"
                    data-testid="research-scope-expansion"
                    value={scopeExpansion}
                    onChange={(event) => setScopeExpansion(event.target.value as ResearchScopeExpansionModeV1)}
                    disabled={running}
                  >
                    <option value="strict">{t("research.scopeExpansion.strict")}</option>
                    <option value="ask">{t("research.scopeExpansion.ask")}</option>
                    <option value="exact-linked">{t("research.scopeExpansion.exactLinked")}</option>
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="research-reconciliation">{t("research.reconciliation")}</Label>
                  <Select
                    id="research-reconciliation"
                    data-testid="research-reconciliation"
                    value={reconciliation}
                    onChange={(event) => setReconciliation(event.target.value as ResearchRequestedReconciliationV1)}
                    disabled={running}
                  >
                    <option value="off">{t("research.reconciliation.off")}</option>
                    <option value="auto">{t("research.reconciliation.auto")}</option>
                    <option value="required">{t("research.reconciliation.required")}</option>
                  </Select>
                </div>
              </>
            )}
            <div className="flex flex-col gap-1">
              <Label htmlFor="research-max-cost-usd">{t("research.maxCost")}</Label>
              <Input
                id="research-max-cost-usd"
                data-testid="research-max-cost-usd"
                type="number"
                inputMode="decimal"
                min={MIN_RESEARCH_MODEL_COST_USD}
                max={MAX_RESEARCH_MODEL_COST_USD}
                step="0.01"
                value={maxCostUsd}
                onChange={(event) => setMaxCostUsd(event.target.value)}
                disabled={running}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="research-max-run-minutes">{t("research.maxRuntime")}</Label>
              <Input
                id="research-max-run-minutes"
                data-testid="research-max-run-minutes"
                type="number"
                inputMode="numeric"
                min={MIN_RESEARCH_RUN_MINUTES}
                max={MAX_RESEARCH_RUN_MINUTES}
                step="1"
                value={maxRunMinutes}
                onChange={(event) => setMaxRunMinutes(event.target.value)}
                disabled={running}
              />
            </div>
          </div>
          <FieldHelp>{t("research.policy.help")}</FieldHelp>
          <FieldHelp>{t("research.maxCost.help")}</FieldHelp>
          <FieldHelp>{t("research.maxRuntime.help")}</FieldHelp>
          <FieldHelp>{t("research.keys.help")}</FieldHelp>
          {site?.activeEntity && (
            <CheckboxField
              checked={includeCurrentContext}
              onChange={(event) => setIncludeCurrentContext(event.target.checked)}
              disabled={running}
              label={t("research.currentContext", {
                context: site.activeEntity.name,
              })}
              data-testid="research-current-context"
            />
          )}
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="research-from">{t("research.from")}</Label>
              <Input id="research-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} disabled={running} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="research-to">{t("research.to")}</Label>
              <Input id="research-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} disabled={running} />
            </div>
          </div>
          <Alert tone="muted">
            <AlertTitle>{t("research.limits")}</AlertTitle>
            <p className="m-0 mt-1">{t("research.limits.value")}</p>
            <p className="m-0 mt-1" data-testid="research-model-cost-summary">
              {t("research.maxCost.value", { cost: maxCostUsd || "—" })}
            </p>
            <p className="m-0 mt-1" data-testid="research-max-runtime-summary">
              {t("research.maxRuntime.value", { minutes: maxRunMinutes || "—" })}
            </p>
          </Alert>
          <div className="flex gap-2">
            <Button
              className="flex-1"
              onClick={() => void run()}
              disabled={running || !site}
              data-testid="research-run-advanced"
            >
              {running
                ? t(interactionMode === "chat" ? "research.chat.running" : "research.running")
                : t(interactionMode === "chat" ? "research.chat.send" : "research.run")}
            </Button>
            {port.pauseActiveRun && (
              <Button
                variant="outline"
                onClick={() => void requestPause()}
                disabled={!running || pauseRequested}
                data-testid="research-pause"
              >
                {t("research.pause")}
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => abortRef.current?.abort()}
              disabled={!running}
              data-testid="research-cancel"
            >
              {t("research.cancel")}
            </Button>
          </div>
          {progress && <p role="status" className="m-0 text-xs text-muted-foreground">{progress}</p>}
        </CardContent>
      </Card>
      </details>

      {scopeReviews.length > 0 && (
        <Card data-testid="research-scope-reviews">
          <CardHeader>
            <CardTitle>{t("research.scopeReview.title")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {scopeReviews.flatMap((review, reviewIndex) => review.turn.expansionProposals
              .filter((proposal) => proposal.status === "proposed")
              .map((proposal, proposalIndex) => {
                const candidate = review.turn.candidates.find(
                  (entry) => entry.id === proposal.candidateId,
                );
                const actionId = `${review.sessionId}:${proposal.id}`;
                const deciding = scopeReviewActionId === actionId;
                return (
                  <div
                    key={proposal.id}
                    className="rounded-md border p-2 text-xs"
                    data-testid={`research-scope-review-${reviewIndex}-${proposalIndex}`}
                  >
                    <p className="m-0 font-medium">
                      {candidate
                        ? t("research.scopeReview.candidate", {
                          product: candidate.product,
                          scope: candidate.key ?? candidate.name,
                        })
                        : t("research.scopeReview.unknownCandidate")}
                    </p>
                    <p className="mb-0 mt-1 text-muted-foreground">
                      {t("research.scopeReview.kind", { kind: proposal.expansionKind })}
                    </p>
                    <p className="mb-0 mt-1 text-muted-foreground">{proposal.reason}</p>
                    <p className="mb-0 mt-1 text-muted-foreground">
                      {t("research.scopeReview.revision", {
                        brief: String(review.turn.briefRevision),
                        graph: String(review.turn.graphRevision),
                      })}
                    </p>
                    <div className="mt-2 flex gap-2">
                      <Button
                        size="sm"
                        disabled={running || scopeReviewActionId !== null}
                        data-testid={`research-scope-review-approve-${reviewIndex}-${proposalIndex}`}
                        onClick={() => void decideScopeReview(review, proposal, "approve")}
                      >
                        {deciding ? t("research.scopeReview.deciding") : t("research.scopeReview.approve")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={running || scopeReviewActionId !== null}
                        data-testid={`research-scope-review-reject-${reviewIndex}-${proposalIndex}`}
                        onClick={() => void decideScopeReview(review, proposal, "reject")}
                      >
                        {t("research.scopeReview.reject")}
                      </Button>
                    </div>
                  </div>
                );
              }))}
          </CardContent>
        </Card>
      )}

      {scopePlanReviews.length > 0 && (
        <Card data-testid="research-scope-plan-reviews">
          <CardHeader>
            <CardTitle>{t("research.scopePlanReview.title")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {scopePlanReviews.flatMap((review, reviewIndex) => {
              const scopeRevision = review.turn.scopeRevisions.find((revision) =>
                revision.state === "proposed" &&
                revision.proposedGraphRevision === review.turn.graphRevision,
              );
              if (!scopeRevision) return [];
              const deciding = scopePlanReviewActionId === review.sessionId;
              return [(
                <div
                  key={review.sessionId}
                  className="rounded-md border p-2 text-xs"
                  data-testid={`research-scope-plan-review-${reviewIndex}`}
                >
                  <p className="m-0 font-medium">
                    {t("research.scopePlanReview.value", {
                      brief: String(review.turn.briefRevision),
                      graph: String(review.turn.graphRevision),
                    })}
                  </p>
                  <p className="mb-0 mt-1 text-muted-foreground">
                    {t("research.scopePlanReview.scope", {
                      scopes: review.turn.bindings
                        .filter((binding) => binding.authority === "approved")
                        .map((binding) => binding.key ?? binding.name)
                        .join(", ") || "—",
                    })}
                  </p>
                  {scopeRevision.planDiff?.addedRoleIds.length ? (
                    <p className="mb-0 mt-1 text-muted-foreground">
                      {t("research.scopePlanReview.roles", {
                        roles: scopeRevision.planDiff.addedRoleIds.join(", "),
                      })}
                    </p>
                  ) : null}
                  {scopeRevision.planDiff?.addedCapabilityIds.length ? (
                    <p className="mb-0 mt-1 text-muted-foreground">
                      {t("research.scopePlanReview.capabilities", {
                        capabilities: scopeRevision.planDiff.addedCapabilityIds.join(", "),
                      })}
                    </p>
                  ) : null}
                  <p className="mb-0 mt-1 text-muted-foreground">
                    {t("research.scopePlanReview.noRetrieval")}
                  </p>
                  <Button
                    className="mt-2"
                    size="sm"
                    disabled={running || scopePlanReviewActionId !== null}
                    data-testid={`research-scope-plan-review-approve-${reviewIndex}`}
                    onClick={() => void approveScopePlanReview(review)}
                  >
                    {deciding
                      ? t("research.scopePlanReview.deciding")
                      : t("research.scopePlanReview.approve")}
                  </Button>
                </div>
              )];
            })}
          </CardContent>
        </Card>
      )}

      {interactionMode === "deep" && clarificationReviews.length > 0 && (
        <Card data-testid="research-clarification-reviews">
          <CardHeader>
            <CardTitle>{t("research.clarificationReview.title")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {clarificationReviews.map((review, index) => {
              const deciding = clarificationActionId === `${review.sessionId}:${review.revision}`;
              const answersReady = review.stage !== "answer_required" || review.turn.questions.every(
                (question) => (clarificationAnswers[clarificationAnswerKey(review, question.id)] ?? "").trim(),
              );
              const decisionsReady = review.stage !== "answer_required" || review.turn.assumptions.every(
                (assumption) => {
                  const decision = clarificationDecisions[clarificationDecisionKey(review, assumption.id)];
                  return decision === "accepted" || decision === "rejected";
                },
              );
              return (
                <div
                  key={review.sessionId}
                  className="rounded-md border p-2 text-xs"
                  data-testid={`research-clarification-review-${index}`}
                >
                  <p className="m-0 font-medium">
                    {t("research.clarificationReview.value", {
                      brief: String(review.turn.briefRevision),
                    })}
                  </p>
                  <p className="mb-0 mt-1 text-muted-foreground">
                    {t("research.clarificationReview.scope", {
                      jira: displayScopeKeys(review.turn.scope.jiraProjectKeys, "jira"),
                      confluence: displayScopeKeys(review.turn.scope.confluenceSpaceKeys, "confluence"),
                    })}
                  </p>
                  {review.stage === "answer_required" ? (
                    <div className="mt-2 flex flex-col gap-3">
                      {review.turn.questions.map((question) => {
                        const key = clarificationAnswerKey(review, question.id);
                        return (
                          <div key={question.id} className="flex flex-col gap-1">
                            <Label htmlFor={`research-clarification-answer-${index}-${question.id}`}>
                              {question.prompt}
                            </Label>
                            <textarea
                              id={`research-clarification-answer-${index}-${question.id}`}
                              data-testid={`research-clarification-answer-${index}-${question.id}`}
                              className="min-h-20 w-full resize-y rounded-md border bg-background px-2.5 py-2 text-sm text-foreground"
                              value={clarificationAnswers[key] ?? ""}
                              maxLength={2_000}
                              disabled={running || deciding}
                              onChange={(event) => setClarificationAnswers((current) => ({
                                ...current,
                                [key]: event.target.value,
                              }))}
                            />
                          </div>
                        );
                      })}
                      {review.turn.assumptions.map((assumption) => {
                        const key = clarificationDecisionKey(review, assumption.id);
                        return (
                          <div key={assumption.id} className="flex flex-col gap-1">
                            <Label htmlFor={`research-clarification-assumption-${index}-${assumption.id}`}>
                              {assumption.text}
                            </Label>
                            <Select
                              id={`research-clarification-assumption-${index}-${assumption.id}`}
                              data-testid={`research-clarification-assumption-${index}-${assumption.id}`}
                              value={clarificationDecisions[key] ?? ""}
                              disabled={running || deciding}
                              onChange={(event) => setClarificationDecisions((current) => ({
                                ...current,
                                [key]: event.target.value as "accepted" | "rejected" | "",
                              }))}
                            >
                              <option value="">{t("research.clarificationReview.decisionPlaceholder")}</option>
                              <option value="accepted">{t("research.clarificationReview.accept")}</option>
                              <option value="rejected">{t("research.clarificationReview.reject")}</option>
                            </Select>
                          </div>
                        );
                      })}
                      <p className="mb-0 text-muted-foreground">
                        {t("research.clarificationReview.noRetrieval")}
                      </p>
                      <Button
                        size="sm"
                        disabled={running || deciding || !answersReady || !decisionsReady}
                        data-testid={`research-clarification-resolve-${index}`}
                        onClick={() => void resolveClarificationReview(review)}
                      >
                        {deciding
                          ? t("research.clarificationReview.deciding")
                          : t("research.clarificationReview.resolve")}
                      </Button>
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-col gap-2">
                      <p className="mb-0 text-muted-foreground">
                        {t("research.clarificationReview.planRequired")}
                      </p>
                      <Button
                        size="sm"
                        disabled={running || deciding}
                        data-testid={`research-clarification-continue-${index}`}
                        onClick={() => void continueClarificationReview(review)}
                      >
                        {deciding
                          ? t("research.clarificationReview.deciding")
                          : t("research.clarificationReview.continue")}
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {interactionMode === "deep" && planReviews.length > 0 && (
        <Card data-testid="research-plan-reviews">
          <CardHeader>
            <CardTitle>{t("research.planReview.title")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {planReviews.map((review, index) => {
              const deciding = planReviewActionId === review.sessionId;
              const timeWindow = review.turn.timeWindow;
              const bindings = review.turn.scopeBindings?.map((binding) => [
                `${binding.product}/${binding.entityKind}`,
                binding.key ?? binding.name,
                `(${binding.authority}, ${binding.source})`,
              ].join(" ")).join(", ") ?? "—";
              const coverageTargets = review.turn.coverageTargets?.map((target) =>
                `${target.id} [${target.sourceClasses.join("/")}; ≥${target.minimumDistinctSources}]`,
              ).join(", ") ?? "—";
              const replanEnvelope = review.turn.replanEnvelope;
              return (
                <div
                  key={review.sessionId}
                  className="rounded-md border p-2 text-xs"
                  data-testid={`research-plan-review-${index}`}
                >
                  <p className="m-0 font-medium">
                    {t("research.planReview.value", {
                      effort: review.turn.resolvedEffort,
                      brief: String(review.turn.briefRevision),
                      graph: String(review.turn.graphRevision),
                    })}
                  </p>
                  <p className="mb-0 mt-1 text-muted-foreground">
                    {t("research.planReview.roles", {
                      roles: review.turn.selectedRoleIds.join(", "),
                    })}
                  </p>
                  <p className="mb-0 mt-1 text-muted-foreground">
                    {t("research.planReview.scope", {
                      jira: displayScopeKeys(review.turn.scope.jiraProjectKeys, "jira"),
                      confluence: displayScopeKeys(review.turn.scope.confluenceSpaceKeys, "confluence"),
                    })}
                  </p>
                  {timeWindow && (
                    <p className="mb-0 mt-1 text-muted-foreground" data-testid={`research-plan-review-time-window-${index}`}>
                      {t("research.planReview.timeWindow", {
                        from: timeWindow.from ?? "—",
                        to: timeWindow.to ?? "—",
                      })}
                    </p>
                  )}
                  {review.turn.scopeBindings && (
                    <p className="mb-0 mt-1 text-muted-foreground" data-testid={`research-plan-review-bindings-${index}`}>
                      {t("research.planReview.bindings", { bindings })}
                    </p>
                  )}
                  {review.turn.coverageTargets && (
                    <p className="mb-0 mt-1 text-muted-foreground" data-testid={`research-plan-review-coverage-${index}`}>
                      {t("research.planReview.coverage", { targets: coverageTargets })}
                    </p>
                  )}
                  {replanEnvelope && (
                    <p className="mb-0 mt-1 text-muted-foreground" data-testid={`research-plan-review-replan-envelope-${index}`}>
                      {t("research.planReview.replanEnvelope", {
                        roles: replanEnvelope.optionalRoleIds.join(", ") || "—",
                        capabilities: replanEnvelope.allowedCapabilityIds.join(", ") || "—",
                        parallel: String(replanEnvelope.maxParallelNodes),
                        waves: String(replanEnvelope.maxResearchWaves),
                        reconciliationWaves: String(replanEnvelope.maxReconciliationWaves),
                      })}
                    </p>
                  )}
                  <p className="mb-0 mt-1 text-muted-foreground" data-testid={`research-plan-review-budget-${index}`}>
                    {t("research.planReview.budget", {
                      ptc: String(review.turn.budget.maxPtcCalls),
                      http: String(review.turn.budget.maxHttpCalls),
                      modelCalls: String(review.turn.budget.maxModelCalls ?? "—"),
                      tokens: String(
                        review.turn.budget.maxTotalModelInputTokens + review.turn.budget.maxTotalModelOutputTokens,
                      ),
                      cost: `$${(review.turn.budget.maxModelCostMicros / MICROS_PER_USD).toFixed(2)}`,
                      minutes: String(Math.ceil(review.turn.budget.maxRunMs / 60_000)),
                    })}
                  </p>
                  <p className="mb-0 mt-1 text-muted-foreground">
                    {t("research.planReview.noRetrieval")}
                  </p>
                  <Label className="mt-2 block" htmlFor={`research-plan-review-correction-${index}`}>
                    {t("research.planReview.correction")}
                  </Label>
                  <textarea
                    id={`research-plan-review-correction-${index}`}
                    className="mt-1 w-full rounded-md border bg-background p-2 text-xs"
                    rows={3}
                    maxLength={2_000}
                    disabled={running || planReviewActionId !== null}
                    data-testid={`research-plan-review-correction-${index}`}
                    placeholder={t("research.planReview.correctionPlaceholder")}
                    value={planRevisionInstructions[review.sessionId] ?? ""}
                    onChange={(event) => setPlanRevisionInstructions((current) => ({
                      ...current,
                      [review.sessionId]: event.target.value,
                    }))}
                  />
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={running || planReviewActionId !== null}
                      data-testid={`research-plan-review-approve-${index}`}
                      onClick={() => void approvePlanReview(review)}
                    >
                      {deciding ? t("research.planReview.deciding") : t("research.planReview.approve")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={running || planReviewActionId !== null ||
                        !(planRevisionInstructions[review.sessionId]?.trim())}
                      data-testid={`research-plan-review-revise-${index}`}
                      onClick={() => void rejectPlanReview(review)}
                    >
                      {deciding ? t("research.planReview.deciding") : t("research.planReview.revise")}
                    </Button>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {actionStatus && !report && (
        <p
          role="status"
          className="m-0 text-xs text-muted-foreground"
          data-testid="research-action-status"
        >
          {actionStatus}
        </p>
      )}

      {planApprovalRequired && (
        <Alert tone="muted" role="status" data-testid="research-plan-approval-required">
          <AlertTitle>{t("research.planRequired")}</AlertTitle>
          <p className="m-0 mt-1">
            {t("research.planRequired.value", {
              effort: planApprovalRequired.resolvedEffort,
              revision: String(planApprovalRequired.graphRevision),
            })}
          </p>
          <p className="m-0 mt-1 text-xs">
            {t("research.planRequired.roles")}: {planApprovalRequired.selectedRoleIds.join(", ")}
          </p>
          <ul className="mb-0 mt-1 pl-5 text-xs">
            {planApprovalRequired.rerunGuidance.map((guidance) => (
              <li key={guidance}>{guidance}</li>
            ))}
          </ul>
        </Alert>
      )}

      {scopeClarificationReviews.length > 0 && (
        <Card data-testid="research-scope-clarification-reviews">
          <CardHeader>
            <CardTitle>{t("research.scopeClarification")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {scopeClarificationReviews.map((review, index) => {
              const actionId = scopeClarificationSelectionKey(review);
              const deciding = scopeClarificationActionId === actionId;
              const selectedCandidateId = scopeClarificationSelections[actionId] ?? "";
              return (
                <div
                  key={review.sessionId}
                  className="rounded-md border p-2 text-xs"
                  data-testid={`research-scope-clarification-review-${index}`}
                >
                  <p className="m-0 text-muted-foreground">
                    {t("research.scopeClarification.value", {
                      reason: review.clarification.reason,
                    })}
                  </p>
                  {review.stage === "choice_required" && review.clarification.candidates.length > 0 && (
                    <div className="mt-2 flex flex-col gap-2">
                      <Label htmlFor={`research-scope-clarification-picker-${index}`}>
                        {t("research.scopeClarification.choose")}
                      </Label>
                      <Select
                        id={`research-scope-clarification-picker-${index}`}
                        data-testid={`research-scope-clarification-picker-${index}`}
                        value={selectedCandidateId}
                        disabled={running || deciding}
                        onChange={(event) => setScopeClarificationSelections((current) => ({
                          ...current,
                          [actionId]: event.target.value,
                        }))}
                      >
                        <option value="">{t("research.scopeClarification.placeholder")}</option>
                        {review.clarification.candidates.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.product}: {candidate.name}
                            {candidate.key ? ` (${candidate.key})` : ""}
                            {candidate.status === "archived" ? " — archived" : ""}
                          </option>
                        ))}
                      </Select>
                      <Button
                        size="sm"
                        disabled={running || deciding || !selectedCandidateId}
                        data-testid={`research-scope-clarification-resolve-${index}`}
                        onClick={() => void resolveScopeClarificationReview(review)}
                      >
                        {deciding
                          ? t("research.clarificationReview.deciding")
                          : t("research.scopeClarification.continue")}
                      </Button>
                    </div>
                  )}
                  {review.stage !== "choice_required" && (
                    <div className="mt-2 flex flex-col gap-2">
                      <p className="mb-0 text-muted-foreground">
                        {t("research.clarificationReview.noRetrieval")}
                      </p>
                      <Button
                        size="sm"
                        disabled={running || deciding}
                        data-testid={`research-scope-clarification-continue-${index}`}
                        onClick={() => void continueScopeClarificationReview(review)}
                      >
                        {deciding
                          ? t("research.clarificationReview.deciding")
                          : t("research.scopeClarification.continue")}
                      </Button>
                    </div>
                  )}
                  <ul className="mb-0 mt-2 pl-5 text-muted-foreground">
                    {review.clarification.rerunGuidance.map((guidance) => (
                      <li key={guidance}>{guidance}</li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {scopeClarification && (
        <Alert tone="muted" role="status" data-testid="research-scope-clarification-required">
          <AlertTitle>{t("research.scopeClarification")}</AlertTitle>
          <p className="m-0 mt-1">
            {t("research.scopeClarification.value", {
              reason: scopeClarification.clarification.reason,
            })}
          </p>
          {scopeClarification.candidateChoices.length > 0 && (
            <div className="mt-2 flex flex-col gap-2">
              <Label htmlFor="research-scope-candidate-picker">
                {t("research.scopeClarification.choose")}
              </Label>
              <Select
                id="research-scope-candidate-picker"
                data-testid="research-scope-candidate-picker"
                value={scopeClarification.selectedCandidateId}
                onChange={(event) => setScopeClarification((current) =>
                  current ? { ...current, selectedCandidateId: event.target.value } : current
                )}
              >
                <option value="">{t("research.scopeClarification.placeholder")}</option>
                {scopeClarification.candidateChoices.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.product}: {candidate.name}
                    {candidate.key ? ` (${candidate.key})` : ""}
                    {candidate.status === "archived" ? " — archived" : ""}
                  </option>
                ))}
              </Select>
              <Button
                size="sm"
                disabled={!scopeClarification.selectedCandidateId || running}
                data-testid="research-scope-candidate-continue"
                onClick={() => {
                  if (!scopeClarification.selectedCandidateId) return;
                  void run({
                    request: scopeClarification.request,
                    selection: {
                      schema: "atlcli.research-scope-candidate-selection/v1",
                      mentionId: scopeClarification.clarification.mentionId,
                      candidateId: scopeClarification.selectedCandidateId,
                    },
                  });
                }}
              >
                {t("research.scopeClarification.continue")}
              </Button>
            </div>
          )}
          <ul className="mb-0 mt-1 pl-5 text-xs">
            {scopeClarification.clarification.rerunGuidance.map((guidance) => (
              <li key={guidance}>{guidance}</li>
            ))}
          </ul>
        </Alert>
      )}

      {briefClarification && (
        <ResearchBriefClarificationNotice clarification={briefClarification} />
      )}

      {report && report.schema !== "atlcli.chat-answer/v1" && (
        <details className="rounded-lg border bg-muted/20" data-testid="research-report">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{t("research.diagnostics")}</summary>
          <Card>
          <CardHeader>
            <CardTitle>{report.title}</CardTitle>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={raw ? "outline" : "secondary"}
                onClick={() => setRaw(false)}
                data-testid="research-formatted"
              >
                {t("research.formatted")}
              </Button>
              <Button
                size="sm"
                variant={raw ? "secondary" : "outline"}
                onClick={() => setRaw(true)}
                data-testid="research-raw"
              >
                {t("research.raw")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void port.copyMarkdown(report.markdown).then(() => setActionStatus(t("research.copied")))}
                data-testid="research-copy"
              >
                {t("research.copy")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void port.downloadMarkdown(report.markdown, `${report.title}.md`).then(() => setActionStatus(t("research.downloaded")))}
                data-testid="research-download"
              >
                {t("research.download")}
              </Button>
            </div>
            {actionStatus && <span role="status" className="text-xs text-muted-foreground">{actionStatus}</span>}
          </CardHeader>
          <CardContent>
            {raw ? (
              <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs" data-testid="research-raw-markdown">
                {report.markdown}
              </pre>
            ) : (
              <FormattedReport report={report} />
            )}
            <section className={cn("mt-4 border-t pt-3 text-xs")}>
              <h3 className="mb-1 mt-0 font-semibold">{t("research.diagnostics")}</h3>
              <dl className="m-0 grid grid-cols-2 gap-x-2 gap-y-1">
                <dt>Model</dt><dd className="m-0">{report.run.model}</dd>
                <dt>Duration</dt><dd className="m-0">{report.run.durationMs} ms</dd>
                <dt>PTC / HTTP</dt><dd className="m-0">{report.run.counts.ptcCalls} / {report.run.counts.httpCalls}</dd>
                <dt>Jira / Confluence</dt><dd className="m-0">{report.run.counts.jiraItems} / {report.run.counts.confluenceItems}</dd>
                <dt>Tokens</dt><dd className="m-0">{report.run.usage ? `${report.run.usage.inputTokens ?? "?"} / ${report.run.usage.outputTokens ?? "?"}` : "—"}</dd>
                <dt>Provider</dt><dd className="m-0">{report.run.wikiProvider}</dd>
              </dl>
            </section>
          </CardContent>
          </Card>
        </details>
      )}
    </div>
  );
}

export const researchScreenDefinition: ScreenDefinition = {
  id: RESEARCH_SCREEN_ID,
  labelKey: "screen.research.label",
  descriptionKey: "screen.research.description",
  icon: FlaskConical,
  component: ResearchScreen,
  order: 1,
  navigation: "primary",
  workspace: "ai",
  requirements: [{ kind: "capability", capability: "research" }],
};
