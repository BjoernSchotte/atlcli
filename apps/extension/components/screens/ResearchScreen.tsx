import React, { useEffect, useMemo, useRef, useState } from "react";
import { FlaskConical } from "lucide-react";
import type {
  ScreenDefinition,
  ScreenProps,
} from "../../utils/screens/registry.js";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  ResearchContractError,
  normalizeResearchRequestV1,
  type ResearchOneShotEventV1,
  type ResearchReportV1,
  type ResearchScopeSeedV1,
} from "../../utils/research/contracts.js";
import { createResearchKeyScopeSeedV1 } from "@atlcli/research/scope-discovery";
import { useT } from "../../utils/i18n/context.js";
import { Alert, AlertTitle } from "../ui/alert.js";
import { Button } from "../ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card.js";
import {
  CheckboxField,
  FieldHelp,
  Input,
  Label,
  SectionHeading,
} from "../ui/field.js";
import { cn } from "../ui/utils.js";

export const RESEARCH_SCREEN_ID = "research";
const MAX_RESEARCH_ACTIVITY_EVENTS = 100;

export function formatResearchActivityEvent(event: ResearchOneShotEventV1): string {
  switch (event.kind) {
    case "phase":
      return `phase · ${event.phase}`;
    case "progress":
      return `budget · ${event.completed}/${event.maximum} calls`;
    case "task":
      return `task · ${event.taskId} · ${event.status}`;
    case "capability":
      return [
        `tool · ${event.toolId}`,
        event.inputKind,
        event.status,
        event.itemCount === undefined ? "" : `${event.itemCount} items`,
        event.termination ?? "",
        event.resultBytes === undefined ? "" : `${event.resultBytes} bytes`,
        event.truncated === undefined ? "" : `truncated ${event.truncated}`,
        event.durationMs === undefined ? "" : `${event.durationMs} ms`,
        event.errorCode ?? "",
      ].filter(Boolean).join(" · ");
    case "subagent":
      return [
        `agent · ${event.roleId}`,
        event.status,
        event.attempt === undefined ? "" : `attempt ${event.attempt}`,
        event.durationMs === undefined ? "" : `${event.durationMs} ms`,
        event.errorCode ?? "",
      ].filter(Boolean).join(" · ");
    case "decision":
      return [
        "decision",
        event.reasonCode,
        event.status,
        event.codeBytes === undefined ? "" : `${event.codeBytes} code bytes`,
        event.codeHash ?? "",
        event.errorCode ?? "",
      ].filter(Boolean).join(" · ");
    case "artifact":
      return `artifact · ${event.path}`;
  }
}

export function inferResearchScope(input: {
  siteOrigin: string;
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
  const values = (value: string): string[] =>
    [...new Set(value.split(/[\s,;]+/).map((entry) => entry.trim()).filter(Boolean))];
  const manualProjects = values(input.jiraProjects).map((key) => key.toUpperCase());
  const manualSpaces = values(input.confluenceSpaces);
  let questionProjects: string[] = [];
  let questionSpaces: string[] = [];
  if (manualProjects.length === 0) {
    questionProjects = [
      ...new Set(
        [...input.question.matchAll(/\b([A-Z][A-Z0-9]{1,19})-\d+\b/g)].map(
          (match) => match[1]!
        )
      ),
    ];
    if (questionProjects.length === 0) {
      const named = input.question.match(
        /jira[-\s]*(?:projekt|project)(?:key)?\s*[:=]?\s*([A-Z][A-Z0-9]{1,19})/i
      );
      if (named?.[1]) questionProjects = [named[1].toUpperCase()];
    }
  }
  if (manualSpaces.length === 0) {
    const named = input.question.match(
      /(?:confluence[-\s]*)?space(?:key)?\s*[:=]?\s*([A-Za-z0-9~][A-Za-z0-9._~-]{0,254})/i
    );
    if (named?.[1]) questionSpaces = [named[1]];
  }
  const currentProjects = input.activeProjectKey ? [input.activeProjectKey.toUpperCase()] : [];
  const currentSpaces = input.activeSpaceKey ? [input.activeSpaceKey] : [];
  const jiraProjectKeys = manualProjects.length > 0
    ? manualProjects
    : questionProjects.length > 0
      ? questionProjects
      : currentProjects;
  const confluenceSpaceKeys = manualSpaces.length > 0
    ? manualSpaces
    : questionSpaces.length > 0
      ? questionSpaces
      : currentSpaces;
  const seeds = (
    product: "jira" | "confluence",
    manual: string[],
    natural: string[],
    current: string[],
  ): ResearchScopeSeedV1[] => [
    ...manual.map((key) => createResearchKeyScopeSeedV1({
      tenantOrigin: input.siteOrigin,
      product,
      key,
      source: "ui_added",
      authority: "locked",
    })),
    ...natural.map((key) => createResearchKeyScopeSeedV1({
      tenantOrigin: input.siteOrigin,
      product,
      key,
      source: "natural_language",
      authority: "approved",
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
      ...seeds("jira", manualProjects, questionProjects, currentProjects),
      ...seeds("confluence", manualSpaces, questionSpaces, currentSpaces),
    ],
  };
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
  const [disclosed, setDisclosed] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [activity, setActivity] = useState<ResearchOneShotEventV1[]>([]);
  const [report, setReport] = useState<ResearchReportV1 | null>(null);
  const [raw, setRaw] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  async function run(): Promise<void> {
    setError(null);
    setActionStatus("");
    try {
      if (!site) throw new ResearchContractError("not-atlassian", t("research.siteMissing"));
      if (!disclosed) {
        throw new ResearchContractError("invalid-request", t("research.disclosure"));
      }
      if (apiKey.trim()) {
        await port!.setApiKey(apiKey);
        setApiKey("");
        setHasKey(true);
      } else if (!hasKey) {
        throw new ResearchContractError("missing-key", t("research.key.missing"));
      }
      const scope = inferResearchScope({
        siteOrigin: site.origin,
        question,
        jiraProjects,
        confluenceSpaces,
        activeSpaceKey: includeCurrentContext ? site.activeSpaceKey : undefined,
        activeProjectKey: includeCurrentContext ? site.activeProjectKey : undefined,
      });
      const request = normalizeResearchRequestV1({
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
      const controller = new AbortController();
      abortRef.current = controller;
      setRunning(true);
      setProgress(t("research.running"));
      setActivity([]);
      setReport(null);
      const result = await port!.run(request, {
        signal: controller.signal,
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
              <Input id="research-jira" value={jiraProjects} onChange={(event) => setJiraProjects(event.target.value)} disabled={running} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="research-wiki">{t("research.confluenceSpaces")}</Label>
              <Input id="research-wiki" value={confluenceSpaces} onChange={(event) => setConfluenceSpaces(event.target.value)} disabled={running} />
            </div>
          </div>
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
