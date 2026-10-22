/**
 * `jira analyze flow | aging | cfd` (spec digest-flow-metrics B2) and the
 * issue-selection and fetch shell that `audit jira` shares with them, so both
 * always see the same issue set.
 */
import {
  type Config,
  type DefaultsConfig,
  ERROR_CODES,
  type OutputOptions,
  type Profile,
  fail,
  getActiveProfile,
  getFlag,
  hasFlag,
  loadConfig,
  output,
  resolveDefaults,
} from "@atlcli/core";
import {
  JiraClient,
  type FlowCategory,
  type FlowMetricsV1,
  type JiraIssue,
  type StatusCategoryResolver,
  attachChangelogs,
  computeCumulativeFlow,
  computeFlowMetrics,
  createStatusCategoryResolver,
  escapeCsvValue,
  parseStatusMap,
  renderAgingText,
  renderCfdText,
  renderFlowText,
  resolveStatusMap,
  statusScopeJql,
} from "@atlcli/jira";
import { assertCliAuthSupported } from "./session-guard.js";

type Flags = Record<string, string | boolean | string[]>;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FLOW_LIMIT = 1000;
const SEARCH_PAGE = 100;

export interface IssueSelection {
  kind: "jql" | "board" | "project";
  value: string;
}

/** `--jql` > `--board` > `--project` > `defaults.board` > `defaults.project`. */
export function resolveIssueSelection(
  flags: { jql?: string; board?: string; project?: string },
  defaults: DefaultsConfig
): IssueSelection | undefined {
  if (flags.jql) return { kind: "jql", value: flags.jql };
  if (flags.board) return { kind: "board", value: flags.board };
  if (flags.project) return { kind: "project", value: flags.project };
  if (defaults.board !== undefined) return { kind: "board", value: String(defaults.board) };
  if (defaults.project) return { kind: "project", value: defaults.project };
  return undefined;
}

/** Drop a trailing `ORDER BY …` so the JQL can be wrapped in parentheses. */
export function stripOrderBy(jql: string): string {
  return jql.replace(/\s*\bORDER\s+BY\b[^"']*$/i, "").trim();
}

/** `90d`, `12w` or a bare number of days. */
export function parseWindowDays(value: string | undefined, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  const match = /^(\d+)\s*([dw]?)$/i.exec(value.trim());
  if (!match) return undefined;
  const n = Number(match[1]) * (match[2].toLowerCase() === "w" ? 7 : 1);
  return n > 0 ? n : undefined;
}

export interface JiraContext {
  client: JiraClient;
  config: Config;
  profile: Profile;
  defaults: DefaultsConfig;
}

export async function loadJiraContext(flags: Flags, opts: OutputOptions): Promise<JiraContext> {
  const config = await loadConfig();
  const profile = getActiveProfile(config, getFlag(flags, "profile"));
  if (!profile) fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.");
  assertCliAuthSupported(profile, opts);
  return { client: new JiraClient(profile), config, profile, defaults: resolveDefaults(config, profile) };
}

/** The base JQL for the selection flags, or a usage error. */
export async function selectionJql(ctx: JiraContext, flags: Flags, opts: OutputOptions): Promise<string> {
  const selection = resolveIssueSelection(
    { jql: getFlag(flags, "jql"), board: getFlag(flags, "board"), project: getFlag(flags, "project") },
    ctx.defaults
  );
  if (!selection) {
    fail(opts, 1, ERROR_CODES.USAGE, "Select issues with --project, --board or --jql (or set defaults.project / defaults.board).");
  }
  if (selection.kind === "jql") return stripOrderBy(selection.value);
  if (selection.kind === "project") return `project = "${selection.value.replace(/"/g, '\\"')}"`;
  const boardId = Number(selection.value);
  if (!Number.isInteger(boardId)) fail(opts, 1, ERROR_CODES.USAGE, `--board must be a board id, got "${selection.value}".`);
  return stripOrderBy(await ctx.client.getBoardFilterJql(boardId));
}

/** Search with `nextPageToken` until `limit`; `truncated` when more matched. */
export async function searchAll(
  client: JiraClient,
  jql: string,
  fields: string[],
  limit: number
): Promise<{ issues: JiraIssue[]; truncated: boolean }> {
  const issues: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  do {
    const page = await client.search(jql, {
      fields,
      maxResults: Math.min(SEARCH_PAGE, limit - issues.length),
      nextPageToken,
    });
    issues.push(...page.issues);
    nextPageToken = page.nextPageToken;
  } while (nextPageToken && issues.length < limit);
  return { issues: issues.slice(0, limit), truncated: Boolean(nextPageToken) || issues.length > limit };
}

export interface StatusScope {
  resolve: StatusCategoryResolver;
  /** JQL for not-done and done issues, agreeing with the status map. */
  open: string;
  done: string;
}

/** Status resolver from the site statuses plus global, profile and flag overrides. */
export async function loadStatusResolver(
  ctx: JiraContext,
  flags: Flags,
  opts: OutputOptions
): Promise<StatusScope> {
  let flagMap: Record<string, FlowCategory> | undefined;
  const spec = getFlag(flags, "status-map");
  if (spec !== undefined) {
    try {
      flagMap = parseStatusMap(spec);
    } catch (err) {
      fail(opts, 1, ERROR_CODES.USAGE, (err as Error).message);
    }
  }
  const overrides = resolveStatusMap(ctx.config.flow?.statusMap, ctx.profile.flow?.statusMap, flagMap);
  const statuses = await ctx.client.getStatuses();
  const resolve = createStatusCategoryResolver(statuses, overrides);
  return { resolve, ...statusScopeJql(statuses, resolve) };
}

function positiveInt(flags: Flags, name: string, fallback: number, opts: OutputOptions): number {
  const raw = getFlag(flags, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail(opts, 1, ERROR_CODES.USAGE, `--${name} must be a positive integer.`);
  return n;
}

interface FlowData {
  query: string;
  issues: JiraIssue[];
  resolve: StatusCategoryResolver;
  from: Date;
  now: Date;
  warnings: string[];
}

async function fetchFlowData(flags: Flags, opts: OutputOptions): Promise<FlowData> {
  const days = parseWindowDays(getFlag(flags, "since"), 90);
  if (days === undefined) fail(opts, 1, ERROR_CODES.USAGE, "--since must look like 90d, 12w or 30.");
  const limit = positiveInt(flags, "limit", DEFAULT_FLOW_LIMIT, opts);
  const ctx = await loadJiraContext(flags, opts);
  const base = await selectionJql(ctx, flags, opts);
  const { resolve, open } = await loadStatusResolver(ctx, flags, opts);
  const query = `(${base}) AND (${open} OR updated >= -${days}d) ORDER BY created ASC`;
  const { issues, truncated } = await searchAll(
    ctx.client,
    query,
    ["summary", "status", "issuetype", "created", "resolutiondate", "assignee"],
    limit
  );
  const logs = await ctx.client.getChangelogs(issues, { fieldIds: ["status"] });
  const now = new Date();
  return {
    query,
    issues: attachChangelogs(issues, logs),
    resolve,
    from: new Date(now.getTime() - days * DAY_MS),
    now,
    warnings: truncated ? [`truncated: more than ${limit} issues matched; raise --limit or narrow the query.`] : [],
  };
}

function csv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((row) => row.map(escapeCsvValue).join(",")).join("\n");
}

function emit(text: string, json: unknown, csvText: string, warnings: string[], flags: Flags, opts: OutputOptions): void {
  if (opts.json) {
    output(json, opts);
    return;
  }
  for (const warning of warnings) process.stderr.write(`Warning: ${warning}\n`);
  output(hasFlag(flags, "csv") ? csvText : text, opts);
}

function metricsJson(data: FlowData, metrics: FlowMetricsV1) {
  const { window, diagnostics, ...rest } = metrics;
  return {
    schemaVersion: "1",
    query: data.query,
    window,
    metrics: rest,
    diagnostics: { ...diagnostics, warnings: data.warnings },
  };
}

export async function handleAnalyzeFlow(flags: Flags, opts: OutputOptions): Promise<void> {
  const data = await fetchFlowData(flags, opts);
  const metrics = computeFlowMetrics({ ...data, to: data.now });
  emit(
    renderFlowText(metrics, data.query),
    metricsJson(data, metrics),
    csv(
      ["key", "type", "created", "startedAt", "doneAt", "leadDays", "cycleDays"],
      metrics.completed.map((c) => [c.key, c.type, c.created, c.startedAt, c.doneAt, c.leadDays, c.cycleDays])
    ),
    data.warnings,
    flags,
    opts
  );
}

export async function handleAnalyzeAging(flags: Flags, opts: OutputOptions): Promise<void> {
  const data = await fetchFlowData(flags, opts);
  const metrics = computeFlowMetrics({ ...data, to: data.now });
  emit(
    renderAgingText(metrics),
    {
      schemaVersion: "1",
      query: data.query,
      cycleTimeP85: metrics.cycleTime.p85,
      wip: metrics.wip,
      diagnostics: { ...metrics.diagnostics, warnings: data.warnings },
    },
    csv(
      ["key", "status", "startedAt", "ageDays", "overP85"],
      metrics.wip.aging.map((a) => [a.key, a.status, a.startedAt, a.ageDays, a.overP85])
    ),
    data.warnings,
    flags,
    opts
  );
}

export async function handleAnalyzeCfd(flags: Flags, opts: OutputOptions): Promise<void> {
  const groupBy = getFlag(flags, "group-by") ?? "status";
  if (groupBy !== "status" && groupBy !== "category") {
    fail(opts, 1, ERROR_CODES.USAGE, "--group-by must be status or category.");
  }
  const data = await fetchFlowData(flags, opts);
  const cfd = computeCumulativeFlow({ ...data, to: data.now, groupBy });
  emit(
    renderCfdText(cfd),
    {
      schemaVersion: "1",
      query: data.query,
      window: { from: data.from.toISOString(), to: data.now.toISOString() },
      ...cfd,
      diagnostics: { warnings: data.warnings },
    },
    csv(
      ["date", ...cfd.columns.map((c) => c.name)],
      cfd.days.map((d) => [d.date, ...cfd.columns.map((c) => d.counts[c.name] ?? 0)])
    ),
    data.warnings,
    flags,
    opts
  );
}
