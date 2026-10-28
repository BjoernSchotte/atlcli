/**
 * Research answer presentation — the stateless React half of the Kiteweave AI
 * screen: activity marks, suggestion icons, the clarification notice, source
 * links, the V1/V2 report renderers, safe chat Markdown and the streaming
 * turn. Extracted verbatim from `ResearchScreen.tsx` (sidebar redesign,
 * 2026-10); the screen re-exports the tested pieces unchanged.
 */
import React, { useEffect, useState } from "react";
import { Streamdown } from "streamdown";
import { ChevronRight, FileText, MessageCircle, Search } from "lucide-react";
import type { ResearchBriefClarificationRequiredV1 } from "@atlcli/research";
import type {
  ChatAnswerV1,
  ResearchReport,
  ResearchRequestV1,
} from "../../utils/research/contracts.js";
import { useT } from "../../utils/i18n/context.js";
import { Alert, AlertTitle } from "../ui/alert.js";
import { cn } from "../ui/utils.js";
import {
  chatReasoningSummary,
  researchActivityDetailMessages,
  researchTimelineSteps,
  streamedChatAnswer,
  type ResearchSuggestionKind,
  type ResearchTimelineEventV1,
  type ResearchTimelineStepKind,
} from "./model.js";

export function KiteActivityMark(): React.JSX.Element {
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

export function ActiveActivityDots(): React.JSX.Element {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5"
      aria-hidden="true"
      data-testid="research-active-dots"
    >
      <span className="kiteweave-agent-dot size-1 rounded-full bg-current" />
      <span className="kiteweave-agent-dot size-1 rounded-full bg-current [animation-delay:120ms]" />
      <span className="kiteweave-agent-dot size-1 rounded-full bg-current [animation-delay:240ms]" />
    </span>
  );
}

export function SuggestionIcon({ kind }: { kind: ResearchSuggestionKind }): React.JSX.Element {
  if (kind === "summarize") return <FileText className="size-4" aria-hidden="true" />;
  if (kind === "connections") return <Search className="size-4" aria-hidden="true" />;
  return <MessageCircle className="size-4" aria-hidden="true" />;
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

export function SourceLinks({
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

export function V1FormattedReport({ report }: { report: Extract<ResearchReport, { schema: "atlcli.research-report/v1" }> }): React.JSX.Element {
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

export function V2FormattedReport({ report }: { report: Extract<ResearchReport, { schema: "atlcli.research-report/v2" }> }): React.JSX.Element {
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

export function FormattedReport({ report }: { report: ResearchReport }): React.JSX.Element {
  return report.schema === "atlcli.research-report/v2"
    ? <V2FormattedReport report={report} />
    : <V1FormattedReport report={report} />;
}

export function safeChatMarkdownHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const parsed = new URL(href);
    return parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

export function ChatMarkdown({
  markdown,
  streaming = false,
  currentCitationUrls = new Set<string>(),
  currentContextLabel = "Current context",
  onCurrentContextNavigate,
}: {
  markdown: string;
  streaming?: boolean;
  currentCitationUrls?: ReadonlySet<string>;
  currentContextLabel?: string;
  onCurrentContextNavigate?: (url: string) => void;
}): React.JSX.Element {
  return (
    <div className="space-y-3 break-words" data-testid="research-chat-markdown">
      <Streamdown
        mode={streaming ? "streaming" : "static"}
        controls={false}
        components={{
          h1: ({ children }) => <h2 className="mb-2 mt-4 text-lg font-semibold leading-6 first:mt-0">{children}</h2>,
          h2: ({ children }) => <h3 className="mb-2 mt-4 text-base font-semibold leading-6 first:mt-0">{children}</h3>,
          h3: ({ children }) => <h4 className="mb-1.5 mt-3 text-sm font-semibold leading-5 first:mt-0">{children}</h4>,
          h4: ({ children }) => <h5 className="mb-1.5 mt-3 text-sm font-medium leading-5 first:mt-0">{children}</h5>,
          p: ({ children }) => <p className="my-2 whitespace-pre-wrap first:mt-0 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-border pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          code: ({ children, className }) => className
            ? <code className={cn("block overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs", className)}>{children}</code>
            : <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{children}</code>,
          pre: ({ children }) => <pre className="my-3 overflow-x-auto">{children}</pre>,
          a: ({ children, href }) => {
            const safeHref = safeChatMarkdownHref(href);
            const isCurrentContext = safeHref !== undefined && currentCitationUrls.has(safeHref);
            if (safeHref && isCurrentContext && new URL(safeHref).hash.length === 0) {
              return (
                <span
                  className="whitespace-nowrap rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                  data-current-context-citation="page"
                >
                  {currentContextLabel}
                </span>
              );
            }
            if (safeHref && isCurrentContext && onCurrentContextNavigate) {
              return (
                <button
                  type="button"
                  className="break-words text-left underline underline-offset-2"
                  data-current-context-citation="section"
                  onClick={() => onCurrentContextNavigate(safeHref)}
                >
                  {children}
                </button>
              );
            }
            return safeHref
              ? (
                <a
                  className="break-all underline underline-offset-2"
                  href={safeHref}
                  target="_blank"
                  rel="noreferrer"
                >
                  {children}
                </a>
              )
              : <span>{children}</span>;
          },
          table: ({ children }) => <table className="my-3 w-full border-collapse text-xs">{children}</table>,
          th: ({ children }) => <th className="border border-border bg-muted px-2 py-1 text-left font-semibold">{children}</th>,
          td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
          hr: () => <hr className="my-4 border-border" />,
        }}
      >
        {markdown}
      </Streamdown>
    </div>
  );
}

export function ChatAnswer({
  answer,
  currentSourceId,
  currentContextLabel,
  onCurrentContextNavigate,
}: {
  answer: ChatAnswerV1;
  currentSourceId?: string;
  currentContextLabel: string;
  onCurrentContextNavigate?: (url: string) => void;
}): React.JSX.Element {
  const t = useT();
  const currentCitations = answer.citations.filter((source) => source.sourceId === currentSourceId);
  const currentCitationUrls = new Set(
    currentCitations.flatMap((source) => safeChatMarkdownHref(source.url) ?? []),
  );
  return (
    <article className="space-y-3 text-sm leading-6" data-testid="research-chat-answer">
      <ChatMarkdown
        markdown={answer.messageMarkdown}
        currentCitationUrls={currentCitationUrls}
        currentContextLabel={currentContextLabel}
        onCurrentContextNavigate={onCurrentContextNavigate}
      />
      {answer.citations.length > 0 && (
        <details className="rounded-lg border border-border/70 px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
            {t("research.chat.sources", { count: answer.citations.length })}
          </summary>
          <ol className="mb-0 mt-2 space-y-1 pl-5 text-xs">
            {answer.citations.map((source) => {
              const isCurrentContext = source.sourceId === currentSourceId;
              const key = `${source.sourceId}#${source.section?.sectionId ?? "item"}`;
              return (
                <li key={key}>
                  {isCurrentContext && !source.section
                    ? <span className="text-muted-foreground">{currentContextLabel}</span>
                    : isCurrentContext && onCurrentContextNavigate
                      ? (
                        <button
                          type="button"
                          className="text-left underline underline-offset-2"
                          onClick={() => onCurrentContextNavigate(source.url)}
                        >
                          {source.title}
                        </button>
                      )
                      : (
                        <a className="underline underline-offset-2" href={source.url} target="_blank" rel="noreferrer">
                          {source.title}
                        </a>
                      )}
                </li>
              );
            })}
          </ol>
        </details>
      )}
    </article>
  );
}

/** Presenter-only compatibility for retained pre-C1 results; new Chat runs never create this shape. */
export function LegacyChatAnswer({ report }: { report: ResearchReport }): React.JSX.Element {
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

export function ResearchStreamingTurn({
  activity,
  progress,
  running,
  request,
}: {
  activity: readonly ResearchTimelineEventV1[];
  progress: string;
  running: boolean;
  request?: ResearchRequestV1 | null;
}): React.JSX.Element | null {
  const t = useT();
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
  const answerDraft = streamedChatAnswer(activity);
  // Ranking validates the one host-bound entity reference internally, but it
  // is not a user-visible discovery step when there is only one exact page.
  // Showing it as "relevant results selected" suggested a broad search that
  // never happened and duplicated the direct-context selection row.
  const displaySteps = exactPage
    ? steps.filter((step) => step.kind !== "ranking")
    : steps;
  const activeStepId = running ? displaySteps.at(-1)?.id : undefined;
  const [activeSeconds, setActiveSeconds] = useState(0);
  useEffect(() => {
    setActiveSeconds(0);
    if (!activeStepId) return;
    const startedAt = Date.now();
    const interval = globalThis.setInterval(() => {
      setActiveSeconds(Math.max(1, Math.floor((Date.now() - startedAt) / 1_000)));
    }, 1_000);
    return () => globalThis.clearInterval(interval);
  }, [activeStepId]);
  if (!running && activity.length === 0) return null;
  const label = (kind: ResearchTimelineStepKind): string => {
    switch (kind) {
      case "thinking": return t("research.chat.phase.thinking");
      case "planning": return t("research.chat.phase.planning");
      case "analyzing": return t("research.chat.phase.analyzing");
      case "confluence-search": return exactPage
        ? t("research.chat.phase.confluenceContext")
        : t("research.chat.phase.confluenceSearch");
      case "confluence-read": return exactPage
        ? t("research.chat.phase.confluenceContextRead", { name: exactPage.name })
        : t("research.chat.phase.confluenceRead");
      case "confluence-section-read": return t("research.chat.phase.confluenceSectionRead");
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
      case "analyzing": return t("research.chat.phase.analyzing.description");
      case "confluence-search": return exactPage
        ? t("research.chat.phase.confluenceContext.description")
        : t("research.chat.phase.confluenceSearch.description");
      case "confluence-read": return t("research.chat.phase.confluenceRead.description");
      case "confluence-section-read": return t("research.chat.phase.confluenceSectionRead.description");
      case "bound-read": return exactPage
        ? t("research.chat.phase.confluenceContextRead.description")
        : exactIssue
          ? t("research.chat.phase.jiraContextRead.description")
          : t("research.chat.phase.boundRead.description");
      case "jira-search": return t("research.chat.phase.jiraSearch.description");
      case "jira-read": return t("research.chat.phase.jiraRead.description");
      case "ranking": return t("research.chat.phase.ranking.description");
      case "relationships": return t("research.chat.phase.relationships.description");
      case "checking": return t("research.chat.phase.checking.description");
      case "synthesizing": return t("research.chat.phase.synthesizing.description");
    }
  };
  const activeDetail = (kind: ResearchTimelineStepKind): string =>
    kind === "analyzing"
      ? t("research.chat.phase.analyzing.active")
      : t("research.chat.phase.active");
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
            : exactPage && step.kind === "bound-read"
              ? [t("research.chat.detail.boundRead", { label: exactPage.name })]
              : researchActivityDetailMessages(step.events, t);
          if (step.kind === "planning") {
            details.push(exactPage
              ? t("research.chat.detail.planExactContext", { name: exactPage.name })
              : t("research.chat.detail.planScopedDiscovery"));
          }
          const reasoningSummary = chatReasoningSummary(step.events);
          const activityLine = (
            <span className={cn(
              "flex min-h-9 items-start gap-2.5 px-2 py-1.5",
              active ? "font-medium text-foreground" : "text-muted-foreground",
            )}>
              <span className="mt-0.5">
                {active ? <KiteActivityMark /> : <span className="block size-5 shrink-0" aria-hidden="true" />}
              </span>
              <span className="min-w-0 flex-1 leading-5">
                <span className="line-clamp-2 block">{label(step.kind)}</span>
                {active && reasoningSummary && (
                  <span
                    className="mt-0.5 line-clamp-2 block text-xs font-normal leading-4 text-muted-foreground"
                    data-testid="research-live-reasoning-summary"
                  >
                    {reasoningSummary}
                  </span>
                )}
              </span>
              {active && (
                <span
                  className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-normal tabular-nums text-muted-foreground"
                  data-testid="research-active-progress"
                >
                  <span>{t("research.chat.phase.elapsed", { seconds: String(activeSeconds) })}</span>
                  <ActiveActivityDots />
                </span>
              )}
              <ChevronRight
                className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
                aria-hidden="true"
              />
              {active && (
                <span className="sr-only" data-testid="research-active-label">
                  {t("research.chat.phase.inProgress")}
                </span>
              )}
            </span>
          );
          return (
            <details
              key={step.id}
              className="group"
              data-testid={`research-timeline-step-${index}`}
            >
              <summary
                className="cursor-pointer list-none rounded-md marker:content-none hover:bg-muted/60"
                aria-label={`${label(step.kind)}. ${t("research.chat.phase.showDetails")}`}
              >
                {activityLine}
              </summary>
              <div className="ml-9 mr-5 space-y-1 pb-2 text-xs leading-4 text-muted-foreground">
                <p className="m-0">{description(step.kind)}</p>
                {details.map((detail) => (
                  <p className="m-0" data-testid="research-activity-outcome" key={detail}>
                    {detail}
                  </p>
                ))}
                {active && (
                  <p className="m-0" data-testid="research-active-detail">
                    {activeDetail(step.kind)} {t("research.chat.phase.elapsedLong", {
                      seconds: String(activeSeconds),
                    })}
                  </p>
                )}
                {reasoningSummary && (
                  <div
                    className="mt-2 rounded-md bg-muted/60 px-2.5 py-2 text-xs leading-4 text-foreground"
                    data-testid="research-reasoning-summary"
                  >
                    <p className="m-0 mb-1 font-medium text-muted-foreground">
                      {t("research.chat.presentation.reasoningSummary")}
                    </p>
                    <p className="m-0 whitespace-pre-wrap">{reasoningSummary}</p>
                  </div>
                )}
              </div>
            </details>
          );
        })}
      </div>
      {running && answerDraft && (
        <article
          className="mt-3 py-1 text-sm leading-6"
          aria-label={t("research.chat.presentation.answerDraft")}
          data-testid="research-streaming-answer"
        >
          <ChatMarkdown markdown={answerDraft} streaming />
        </article>
      )}
      {progress && <span className="sr-only">{progress}</span>}
    </section>
  );
}

