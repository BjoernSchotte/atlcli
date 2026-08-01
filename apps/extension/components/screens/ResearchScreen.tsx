import React, { useEffect, useMemo, useRef, useState } from "react";
import { FlaskConical } from "lucide-react";
import type {
  ScreenDefinition,
  ScreenProps,
} from "../../utils/screens/registry.js";
import {
  DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1,
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_ONE_SHOT_POLICY_SCHEMA_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  ResearchContractError,
  normalizeResearchOneShotPolicyV1,
  normalizeResearchRequestV1,
  type ResearchOneShotEventV1,
  type ResearchRequestedEffortV1,
  type ResearchRequestedPlanApprovalV1,
  type ResearchRequestedReconciliationV1,
  type ResearchRequestV1,
  type ResearchReportV1,
  type ResearchScopeExpansionModeV1,
  type ResearchScopeSeedV1,
} from "../../utils/research/contracts.js";
import { formatResearchOneShotEventV1 } from "../../utils/research/events.js";
import { createResearchKeyScopeSeedV1 } from "@atlcli/research/scope-discovery";
import {
  prepareResearchBriefPreflightV1,
  RESEARCH_PACKET_BODY_SCHEMA_V2,
} from "@atlcli/research";
import type {
  ResearchBriefClarificationRequiredV1,
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
import { useT } from "../../utils/i18n/context.js";
import { Alert, AlertTitle } from "../ui/alert.js";
import { Button } from "../ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card.js";
import {
  CheckboxField,
  FieldHelp,
  Input,
  Label,
  Select,
  SectionHeading,
} from "../ui/field.js";
import { cn } from "../ui/utils.js";

export const RESEARCH_SCREEN_ID = "research";
const MAX_RESEARCH_ACTIVITY_EVENTS = 500;

function splitScopeValues(value: string): string[] {
  return [...new Set(
    value.split(/[\s,;]+/).map((entry) => entry.trim()).filter(Boolean),
  )];
}

export function formatResearchActivityEvent(event: ResearchOneShotEventV1): string {
  return formatResearchOneShotEventV1(event);
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
    return {
      origin: parsed.origin,
      ...(activeSpaceKey ? { activeSpaceKey } : {}),
      ...(activeProjectKey ? { activeProjectKey } : {}),
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
  report: ResearchReportV1;
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

function FormattedReport({ report }: { report: ResearchReportV1 }): React.JSX.Element {
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

export function ResearchScreen({ ports, page }: ScreenProps): React.JSX.Element {
  const t = useT();
  const port = ports.research;
  const site = useMemo(() => currentSite(page), [page]);
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [question, setQuestion] = useState("");
  const [jiraProjects, setJiraProjects] = useState("");
  const [confluenceSpaces, setConfluenceSpaces] = useState("");
  const [includeCurrentContext, setIncludeCurrentContext] = useState(true);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [effort, setEffort] = useState<ResearchRequestedEffortV1>(
    DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1.requestedEffort,
  );
  const [planApproval, setPlanApproval] = useState<ResearchRequestedPlanApprovalV1>(
    DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1.requestedPlanApproval,
  );
  const [scopeExpansion, setScopeExpansion] = useState<ResearchScopeExpansionModeV1>(
    DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1.scopeExpansionMode,
  );
  const [reconciliation, setReconciliation] = useState<ResearchRequestedReconciliationV1>(
    DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1.requestedReconciliation,
  );
  const [disclosed, setDisclosed] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [activity, setActivity] = useState<ResearchOneShotEventV1[]>([]);
  const [report, setReport] = useState<ResearchReportV1 | null>(null);
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
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    void port?.hasApiKey().then((value) => {
      if (active) setHasKey(value);
    });
    return () => {
      active = false;
      abortRef.current?.abort();
    };
  }, [port]);

  if (!port) return <Alert tone="muted">{t("screen.unmet.capability.research")}</Alert>;

  async function run(retry?: ScopePreflightRetry): Promise<void> {
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
        const scope = inferResearchScope({
          siteOrigin: site.origin,
          question,
          jiraProjects,
          confluenceSpaces,
          activeSpaceKey: includeCurrentContext ? site.activeSpaceKey : undefined,
          activeProjectKey: includeCurrentContext ? site.activeProjectKey : undefined,
        });
        return normalizeResearchRequestV1({
          schema: RESEARCH_REQUEST_SCHEMA_V1,
          question,
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
          limits: DEFAULT_RESEARCH_LIMITS_V1,
          wikiProvider: "rest",
        });
      })();
      const scopeOutcome = await port!.resolveScope(
        initialRequest,
        retry ? { candidateSelections: [retry.selection] } : undefined,
      );
      if (scopeOutcome.kind === "clarification_required") {
        setScopeClarification({
          request: structuredClone(initialRequest),
          clarification: scopeOutcome.clarification,
          candidateChoices: scopeOutcome.candidateChoices,
          selectedCandidateId: "",
        });
        setActivity([]);
        setReport(null);
        setProgress("");
        return;
      }
      const request = scopeOutcome.request;
      setSubmittedRequest(structuredClone(request));
      const policy = normalizeResearchOneShotPolicyV1({
        schema: RESEARCH_ONE_SHOT_POLICY_SCHEMA_V1,
        requestedEffort: effort,
        requestedPlanApproval: planApproval,
        scopeExpansionMode: scopeExpansion,
        requestedReconciliation: reconciliation,
      });
      const briefOutcome = prepareResearchBriefPreflightV1(createStandardResearchBriefV1(request.question, {
        scope: request.scope,
        scopeBindings: request.scopeSeeds?.map((seed) => seed.binding),
        limits: request.limits,
        asOf: new Date().toISOString(),
        policy,
      }));
      if (briefOutcome.kind === "clarification_required") {
        setBriefClarification(briefOutcome.clarification);
        setActivity([]);
        setReport(null);
        setProgress("");
        return;
      }
      const graph = composeResearchGraphV1(briefOutcome.brief, {
        packetOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2,
      });
      const approvalRequired = researchPlanApprovalRequiredV1(graph);
      if (approvalRequired) {
        setPlanApprovalRequired(approvalRequired);
        setActivity([]);
        setReport(null);
        setProgress("");
        return;
      }
      if (apiKey.trim()) {
        await port!.setApiKey(apiKey);
        setApiKey("");
        setHasKey(true);
      } else if (!hasKey) {
        throw new ResearchContractError("missing-key", t("research.key.missing"));
      }
      const controller = new AbortController();
      abortRef.current = controller;
      setRunning(true);
      setProgress(t("research.running"));
      setActivity([]);
      setReport(null);
      const result = await port!.run(request, {
        signal: controller.signal,
        policy,
        onProgress: (value) => setProgress(value.message),
        onEvent: (event) => setActivity((current) =>
          [...current, event].slice(-MAX_RESEARCH_ACTIVITY_EVENTS)
        ),
      });
      setReport(result);
      setProgress("");
    } catch (value) {
      setError(value instanceof Error ? value.message : t("research.error"));
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }

  const previewScope = site
    ? inferResearchScope({
        siteOrigin: site.origin,
        question,
        jiraProjects,
        confluenceSpaces,
        activeSpaceKey: includeCurrentContext ? site.activeSpaceKey : undefined,
        activeProjectKey: includeCurrentContext ? site.activeProjectKey : undefined,
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

  return (
    <div className="flex flex-col gap-4" data-testid="research-screen">
      <header>
        <SectionHeading>{t("research.title")}</SectionHeading>
        <p className="mb-0 mt-1 text-xs text-muted-foreground">{t("research.description")}</p>
      </header>

      <Card>
        <CardContent className="flex flex-col gap-3 p-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="research-site">{t("research.site")}</Label>
            <Input id="research-site" value={site?.origin ?? ""} readOnly disabled />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="research-key">{t("research.key")}</Label>
            <Input
              id="research-key"
              data-testid="research-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              placeholder={t("research.key.placeholder")}
              onChange={(event) => setApiKey(event.target.value)}
              disabled={running}
            />
            <FieldHelp>{hasKey ? t("research.key.stored") : t("research.key.missing")}</FieldHelp>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasKey || running}
              onClick={() => {
                void port.clearApiKey().then(() => {
                  setHasKey(false);
                  setApiKey("");
                });
              }}
              data-testid="research-forget-key"
            >
              {t("research.key.forget")}
            </Button>
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
            <div className="flex flex-col gap-1">
              <Label htmlFor="research-effort">{t("research.effort")}</Label>
              <Select
                id="research-effort"
                data-testid="research-effort"
                value={effort}
                onChange={(event) => setEffort(event.target.value as ResearchRequestedEffortV1)}
                disabled={running}
              >
                <option value="auto">{t("research.effort.auto")}</option>
                <option value="lookup">{t("research.effort.lookup")}</option>
                <option value="analysis">{t("research.effort.analysis")}</option>
                <option value="deep">{t("research.effort.deep")}</option>
              </Select>
            </div>
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
          </div>
          <FieldHelp>{t("research.policy.help")}</FieldHelp>
          <FieldHelp>{t("research.keys.help")}</FieldHelp>
          {(site?.activeProjectKey || site?.activeSpaceKey) && (
            <CheckboxField
              checked={includeCurrentContext}
              onChange={(event) => setIncludeCurrentContext(event.target.checked)}
              disabled={running}
              label={t("research.currentContext", {
                context: site.activeProjectKey ?? site.activeSpaceKey ?? "",
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
          </Alert>
          <CheckboxField
            checked={disclosed}
            onChange={(event) => setDisclosed(event.target.checked)}
            disabled={running}
            label={t("research.disclosure")}
            data-testid="research-disclosure"
          />
          <div className="flex gap-2">
            <Button
              className="flex-1"
              onClick={() => void run()}
              disabled={running || !site}
              data-testid="research-run"
            >
              {running ? t("research.running") : t("research.run")}
            </Button>
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
          {activity.length > 0 && (
            <details open aria-live="polite" data-testid="research-activity">
              <summary className="mt-2 cursor-pointer text-xs font-medium">{t("research.activity")}</summary>
              <ol className="m-0 mt-1 max-h-64 space-y-1 overflow-auto pl-5 text-xs text-muted-foreground">
                {activity.map((event) => (
                  <li key={event.seq} data-event-kind={event.kind}>
                    <code>{formatResearchActivityEvent(event)}</code>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </CardContent>
      </Card>

      {error && (
        <Alert tone="danger" role="alert" data-testid="research-error">
          <AlertTitle>{t("research.error")}</AlertTitle>
          <p className="m-0 mt-1">{error}</p>
        </Alert>
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

      {report && (
        <Card data-testid="research-report">
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
  order: 35,
  navigation: "primary",
  requirements: [{ kind: "capability", capability: "research" }],
};
