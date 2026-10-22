/**
 * `audit jira` (spec digest-flow-metrics B3): report-only hygiene findings
 * over live Jira data. Selection and status mapping are shared with
 * `jira analyze flow`, so both see the same issue set.
 */
import { ERROR_CODES, type OutputOptions, fail, getFlag, hasFlag, output } from "@atlcli/core";
import {
  DEFAULT_JIRA_STALE_DAYS,
  JIRA_AUDIT_CHECKS,
  type JiraAuditCheck,
  attachChangelogs,
  auditJiraIssues,
  renderJiraAuditMarkdown,
  renderJiraAuditText,
} from "@atlcli/jira";
import { loadJiraContext, loadStatusResolver, searchAll, selectionJql } from "./jira-flow.js";

type Flags = Record<string, string | boolean | string[]>;

const DONE_WINDOW_DAYS = 90;

/** `"stale,hygiene"` → checks; unknown names are a usage error. */
export function parseAuditChecks(value: string | undefined): Set<JiraAuditCheck> | string {
  if (value === undefined) return new Set(JIRA_AUDIT_CHECKS);
  const checks = new Set<JiraAuditCheck>();
  for (const part of value.split(",").map((p) => p.trim()).filter(Boolean)) {
    if (!JIRA_AUDIT_CHECKS.includes(part as JiraAuditCheck)) {
      return `Unknown check "${part}". Use ${JIRA_AUDIT_CHECKS.join(", ")}.`;
    }
    checks.add(part as JiraAuditCheck);
  }
  return checks.size ? checks : `--checks is empty. Use ${JIRA_AUDIT_CHECKS.join(", ")}.`;
}

/** `"30,60,90"` → ascending positive thresholds, or an error message. */
export function parseStaleDays(value: string): [number, number, number] | string {
  const parts = value.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 1) || !(parts[0] < parts[1] && parts[1] < parts[2])) {
    return `--stale needs three ascending day counts, e.g. 30,60,90.`;
  }
  return parts as [number, number, number];
}

export async function handleAuditJira(args: string[], flags: Flags, opts: OutputOptions): Promise<void> {
  if (args[0] === "help" || hasFlag(flags, "help")) {
    output(auditJiraHelp(), opts);
    return;
  }
  const checks = parseAuditChecks(getFlag(flags, "checks"));
  if (typeof checks === "string") fail(opts, 1, ERROR_CODES.USAGE, checks);
  const limitRaw = getFlag(flags, "limit");
  const limit = limitRaw === undefined ? 1000 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) fail(opts, 1, ERROR_CODES.USAGE, "--limit must be a positive integer.");

  const ctx = await loadJiraContext(flags, opts);
  let stale = ctx.profile.audit?.jira?.staleDays ?? ctx.config.audit?.jira?.staleDays ?? DEFAULT_JIRA_STALE_DAYS;
  const staleFlag = getFlag(flags, "stale");
  if (staleFlag !== undefined) {
    const parsed = parseStaleDays(staleFlag);
    if (typeof parsed === "string") fail(opts, 1, ERROR_CODES.USAGE, parsed);
    stale = parsed;
  }

  const base = await selectionJql(ctx, flags, opts);
  const resolve = await loadStatusResolver(ctx, flags, opts);
  const pointsField = getFlag(flags, "points-field") ?? (await ctx.client.detectStoryPointsField()) ?? undefined;
  const fields = ["summary", "status", "issuetype", "assignee", "updated", "created", "parent", "fixVersions", "project", ...(pointsField ? [pointsField] : [])];

  const [openResult, doneResult] = await Promise.all([
    searchAll(ctx.client, `(${base}) AND statusCategory != Done ORDER BY key ASC`, fields, limit),
    searchAll(ctx.client, `(${base}) AND statusCategory = Done AND resolved >= -${DONE_WINDOW_DAYS}d ORDER BY key ASC`, fields, limit),
  ]);
  const logs = await ctx.client.getChangelogs([...openResult.issues, ...doneResult.issues], { fieldIds: ["status"] });

  let inOpenSprint: Set<string> | undefined;
  if (checks.has("hygiene") && pointsField) {
    try {
      const inSprint = await searchAll(ctx.client, `(${base}) AND statusCategory != Done AND sprint in openSprints()`, ["summary"], limit);
      inOpenSprint = new Set(inSprint.issues.map((i) => i.key));
    } catch {
      // No Agile / sprint field on this site: the rule is skipped with a diagnostic.
    }
  }

  const projectsUsingVersions = new Set<string>();
  if (checks.has("hygiene")) {
    const projects = [...new Set(doneResult.issues.map((i) => i.fields.project?.key).filter((k): k is string => Boolean(k)))];
    await Promise.all(
      projects.map(async (key) => {
        if ((await ctx.client.getProjectVersions(key)).length > 0) projectsUsingVersions.add(key);
      })
    );
  }

  const report = auditJiraIssues({
    open: attachChangelogs(openResult.issues, logs),
    done: attachChangelogs(doneResult.issues, logs),
    resolve,
    now: new Date(),
    staleThresholds: stale,
    checks,
    includeTodo: hasFlag(flags, "all"),
    pointsField,
    inOpenSprint,
    projectsUsingVersions,
  });
  if (openResult.truncated || doneResult.truncated) {
    report.diagnostics.push(`truncated: more than ${limit} issues matched; raise --limit or narrow the query.`);
  }

  if (opts.json) {
    output({ ...report, query: base }, opts);
  } else if (hasFlag(flags, "markdown")) {
    output(renderJiraAuditMarkdown(report, base, ctx.client.siteUrl), opts);
  } else {
    output(renderJiraAuditText(report, base), opts);
  }
}

export function auditJiraHelp(): string {
  return `Usage: atlcli audit jira [--project KEY | --board ID | --jql JQL] [options]

Report-only hygiene findings over open issues and issues done in the last ${DONE_WINDOW_DAYS} days.

Checks (all run unless --checks is given):
  stuck-wip        In progress longer than the cycle-time P85 (warning) / P95 (error)
  unassigned-wip   In progress without an assignee (warning)
  stale            No update for 30 / 60 / 90 days (info / warning / error); in-progress only unless --all
  hygiene          no-parent (info), unestimated-in-sprint (warning), done-without-version (info)

Options:
  --project <key>       Project (default: defaults.project)
  --board <id>          Use the board's saved filter (default: defaults.board)
  --jql <jql>           Any JQL; wins over --board and --project
  --checks <list>       Comma-separated subset, e.g. stale,hygiene
  --all                 Include to-do issues in the stale check
  --stale <a,b,c>       Stale thresholds in days (default: 30,60,90; config audit.jira.staleDays)
  --status-map <map>    Override status categories, e.g. "Code Review=wip"
  --points-field <id>   Story points field (auto-detected)
  --limit <n>           Max issues per query (default: 1000)
  --markdown            Markdown report
  --json                JSON report

Examples:
  atlcli audit jira --project ATLCLI
  atlcli audit jira --board 123 --checks stuck-wip,unassigned-wip
  atlcli audit jira --jql "project = ATLCLI AND component = API" --markdown > audit.md`;
}
