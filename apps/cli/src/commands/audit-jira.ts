/**
 * `audit jira` (spec digest-flow-metrics B3, spec jira-audit-rules):
 * report-only findings over live Jira data, under a rules file. Selection and
 * status mapping are shared with `jira analyze flow`, so both see the same
 * issue set; `collectJiraAudit` is shared with the digest.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import { ERROR_CODES, type OutputOptions, type Profile, fail, getFlag, hasFlag, output } from "@atlcli/core";
import {
  AUDIT_SEVERITY_RANK,
  type AuditRules,
  type AuditSeverity,
  AuditRulesError,
  DEFAULT_JIRA_STALE_DAYS,
  type JiraAuditBaseline,
  type JiraAuditFinding,
  type JiraAuditReportV2,
  type JiraClient,
  type JiraIssue,
  type StatusCategoryResolver,
  applyRulePatch,
  attachChangelogs,
  auditJiraIssues,
  createAuditBaseline,
  defaultAuditRules,
  findFlaggedField,
  isRuleActive,
  parseAuditBaseline,
  parseAuditRules,
  pruneAuditBaseline,
  renderJiraAuditMarkdown,
  renderJiraAuditText,
  resolveAuditChecks,
  restrictAuditRules,
  ruleTitle,
} from "@atlcli/jira";
import { loadJiraContext, loadStatusResolver, searchAll, selectionJql } from "./jira-flow.js";
import { profileFilePath, writeJsonAtomic } from "./profile-paths.js";

type Flags = Record<string, string | boolean | string[]>;

const DONE_WINDOW_DAYS = 90;
/** Resolved issues outside Done sampled for the workflow rule. */
const WORKFLOW_SAMPLE = 200;
export const AUDIT_RULES_FILE = "audit-rules.yaml";
const FAIL_ON = ["info", "warning", "error", "never"] as const;

/**
 * Where a rules file is looked up, first match wins: project, profile, global.
 * `cwd: null` skips the project file.
 */
export function auditRulesCandidates(profile: string, cwd: string | null = process.cwd()): string[] {
  return [
    ...(cwd === null ? [] : [join(cwd, ".atlcli", AUDIT_RULES_FILE)]),
    profileFilePath(profile, AUDIT_RULES_FILE),
    join(homedir(), ".atlcli", AUDIT_RULES_FILE),
  ];
}

export function auditBaselinePath(profile: string): string {
  return profileFilePath(profile, "audit-baseline.json");
}

/**
 * The rules in effect: `--rules`, else the first rules file found, else the
 * built-in default profile. Without a file, `audit.jira.staleDays` (profile,
 * then global) still sets the stale thresholds.
 */
export async function loadAuditRules(
  profile: Profile,
  globalStaleDays: [number, number, number] | undefined,
  rulesFlag?: string,
  cwd: string | null = process.cwd()
): Promise<AuditRules> {
  const path = rulesFlag ? resolvePath(rulesFlag) : auditRulesCandidates(profile.name, cwd).find((p) => existsSync(p));
  if (!path) {
    const rules = defaultAuditRules();
    const stale = profile.audit?.jira?.staleDays ?? globalStaleDays;
    return stale ? withStaleDays(rules, stale) : rules;
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new AuditRulesError(`Cannot read the rules file ${path}.`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    throw new AuditRulesError(`${path}: invalid YAML: ${(err as Error).message}`);
  }
  try {
    return parseAuditRules(parsed, path);
  } catch (err) {
    if (err instanceof AuditRulesError && !err.message.startsWith(path)) throw new AuditRulesError(`${path}: ${err.message}`);
    throw err;
  }
}

function withStaleDays(rules: AuditRules, [info, warning, error]: [number, number, number]): AuditRules {
  return {
    ...rules,
    rules: {
      ...rules.rules,
      "hygiene/stale": applyRulePatch(rules.rules["hygiene/stale"] ?? {}, { info, warning, error }, "hygiene/stale", "--stale"),
    },
  };
}

async function readBaseline(path: string): Promise<{ baseline?: JiraAuditBaseline; warning?: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {};
  }
  try {
    return { baseline: parseAuditBaseline(JSON.parse(text)) };
  } catch {
    return { warning: `${path} is unreadable; no baseline applied.` };
  }
}

export interface CollectJiraAuditOptions {
  /** Base JQL, without ORDER BY. */
  base: string;
  rules: AuditRules;
  scope: { resolve: StatusCategoryResolver; open: string; done: string };
  limit: number;
  baseline?: JiraAuditBaseline;
  useBaseline: boolean;
  pointsField?: string;
  now?: Date;
}

/** Fetch what the active rules need, then apply them. */
export async function collectJiraAudit(
  client: JiraClient,
  opts: CollectJiraAuditOptions
): Promise<{ report: JiraAuditReportV2; candidates: JiraAuditFinding[] }> {
  const { base, rules, scope, limit } = opts;
  const active = (id: string) => isRuleActive(rules, id);
  const needDone = active("flow/stuck-wip") || active("flow/status-aging") || active("hygiene/done-without-version");
  const needHistory = active("flow/stuck-wip") || active("flow/status-aging");

  const pointsField = active("hygiene/unestimated-in-sprint")
    ? opts.pointsField ?? (await client.detectStoryPointsField()) ?? undefined
    : undefined;
  const flaggedField = active("hygiene/flagged") ? rules.flaggedField ?? findFlaggedField(await client.getFields()) : undefined;

  const fields = [
    "summary", "status", "issuetype", "assignee", "updated", "created", "parent", "fixVersions", "project", "duedate",
    ...(pointsField ? [pointsField] : []),
    ...(flaggedField ? [flaggedField] : []),
  ];
  const partial: string[] = [];

  const [openResult, doneResult] = await Promise.all([
    searchAll(client, `(${base}) AND ${scope.open} ORDER BY key ASC`, fields, limit),
    needDone
      ? searchAll(client, `(${base}) AND ${scope.done} AND updated >= -${DONE_WINDOW_DAYS}d ORDER BY key ASC`, fields, limit)
      : Promise.resolve({ issues: [] as JiraIssue[], truncated: false }),
  ]);
  if (openResult.truncated) partial.push("open issues");
  if (doneResult.truncated) partial.push("done issues");

  const historyFor = [
    ...(needHistory ? [...openResult.issues, ...doneResult.issues] : []),
    ...(!needHistory && flaggedField ? openResult.issues.filter((i) => (i.fields as unknown as Record<string, unknown>)[flaggedField] != null) : []),
  ];
  const logs = historyFor.length
    ? await client.getChangelogs(historyFor, { fieldIds: ["status", ...(flaggedField ? [flaggedField] : [])] })
    : new Map();

  const [inOpenSprint, projectsUsingVersions, resolvedNotDone, custom, jqlMatches] = await Promise.all([
    (async () => {
      if (!pointsField) return undefined;
      try {
        const inSprint = await searchAll(client, `(${base}) AND ${scope.open} AND sprint in openSprints()`, ["summary"], limit);
        return new Set(inSprint.issues.map((i) => i.key));
      } catch {
        // No Agile / sprint field on this site: the rule is skipped with a diagnostic.
        return undefined;
      }
    })(),
    (async () => {
      const used = new Set<string>();
      if (!active("hygiene/done-without-version")) return used;
      const projects = [...new Set(doneResult.issues.map((i) => i.fields.project?.key).filter((k): k is string => Boolean(k)))];
      await Promise.all(
        projects.map(async (key) => {
          if ((await client.getProjectVersions(key)).length > 0) used.add(key);
        })
      );
      return used;
    })(),
    (async () => {
      if (!active("workflow/resolved-not-done")) return undefined;
      // Raw category on purpose: this finds the statuses a status map may be missing.
      const sample = await searchAll(client, `(${base}) AND statusCategory != Done AND resolution IS NOT EMPTY ORDER BY updated DESC`, ["summary", "status", "issuetype", "project", "updated"], WORKFLOW_SAMPLE);
      // Statuses mapped to done are not reported; their issues need no history.
      const candidates = sample.issues.filter((i) => i.fields.status && scope.resolve(i.fields.status) !== "done");
      const history = candidates.length ? await client.getChangelogs(candidates, { fieldIds: ["status", "resolution"] }) : new Map();
      return { issues: attachChangelogs(candidates, history), truncated: sample.truncated };
    })(),
    (async () => {
      const hits = new Map<string, JiraIssue[]>();
      await Promise.all(
        rules.custom.filter((c) => active(c.id)).map(async (c) => {
          const result = await searchAll(client, `(${base}) AND (${c.jql}) ORDER BY key ASC`, fields, limit);
          if (result.truncated) partial.push(c.id);
          hits.set(c.id, result.issues);
        })
      );
      return hits;
    })(),
    Promise.all(
      rules.overrides.map(async (o) =>
        o.match.jql ? new Set((await searchAll(client, `(${base}) AND (${o.match.jql})`, ["summary"], limit)).issues.map((i) => i.key)) : undefined
      )
    ),
  ]);

  return auditJiraIssues({
    rules,
    open: attachChangelogs(openResult.issues, logs),
    done: attachChangelogs(doneResult.issues, logs),
    resolve: scope.resolve,
    now: opts.now ?? new Date(),
    pointsField,
    inOpenSprint,
    projectsUsingVersions,
    resolvedNotDone,
    flaggedField,
    custom,
    jqlMatches,
    baseline: opts.baseline,
    useBaseline: opts.useBaseline,
    partial,
  });
}

export async function handleAuditJira(args: string[], flags: Flags, opts: OutputOptions): Promise<void> {
  if (args[0] === "help" || hasFlag(flags, "help")) {
    output(auditJiraHelp(), opts);
    return;
  }
  const limitRaw = getFlag(flags, "limit");
  const limit = limitRaw === undefined ? 1000 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) fail(opts, 1, ERROR_CODES.USAGE, "--limit must be a positive integer.");
  const failOn = (getFlag(flags, "fail-on") ?? "error") as (typeof FAIL_ON)[number];
  if (!FAIL_ON.includes(failOn)) fail(opts, 1, ERROR_CODES.USAGE, `--fail-on must be one of ${FAIL_ON.join(", ")}.`);
  const minLevel = getFlag(flags, "min-level");
  if (minLevel !== undefined && !["info", "warning", "error"].includes(minLevel)) {
    fail(opts, 1, ERROR_CODES.USAGE, "--min-level must be info, warning or error.");
  }

  const ctx = await loadJiraContext(flags, opts);
  let rules: AuditRules;
  try {
    rules = await loadAuditRules(ctx.profile, ctx.config.audit?.jira?.staleDays, getFlag(flags, "rules"));
  } catch (err) {
    fail(opts, 1, ERROR_CODES.USAGE, (err as Error).message);
  }
  const staleFlag = getFlag(flags, "stale");
  if (staleFlag !== undefined) {
    const parsed = parseStaleDays(staleFlag);
    if (typeof parsed === "string") fail(opts, 1, ERROR_CODES.USAGE, parsed);
    rules = withStaleDays(rules, parsed);
  }
  if (hasFlag(flags, "all")) {
    rules.rules["hygiene/stale"] = applyRulePatch(rules.rules["hygiene/stale"] ?? {}, { include: ["todo", "wip"] }, "hygiene/stale", "--all");
  }
  const checksFlag = getFlag(flags, "checks");
  if (checksFlag !== undefined) {
    const checks = resolveAuditChecks(checksFlag, rules.custom.map((c) => c.id));
    if (typeof checks === "string") fail(opts, 1, ERROR_CODES.USAGE, checks);
    rules = restrictAuditRules(rules, checks);
  }
  if (minLevel) rules.minLevel = minLevel as AuditSeverity;
  const flaggedFlag = getFlag(flags, "flagged-field");
  if (flaggedFlag) rules.flaggedField = flaggedFlag;

  const baselinePath = auditBaselinePath(ctx.profile.name);
  const useBaseline = !hasFlag(flags, "no-baseline");
  const { baseline, warning: baselineWarning } = await readBaseline(baselinePath);

  const base = await selectionJql(ctx, flags, opts);
  const scope = await loadStatusResolver(ctx, flags, opts);
  const { report, candidates } = await collectJiraAudit(ctx.client, {
    base,
    rules,
    scope,
    limit,
    baseline,
    useBaseline,
    pointsField: getFlag(flags, "points-field"),
  });
  if (baselineWarning) report.diagnostics.push(baselineWarning);

  if (hasFlag(flags, "update-baseline")) {
    const next = createAuditBaseline(candidates, new Date(), baseline);
    await writeJsonAtomic(baselinePath, next);
    report.diagnostics.push(`Baseline: ${next.entries.length} finding(s) accepted in ${baselinePath}.`);
  } else if (hasFlag(flags, "prune-baseline") && baseline) {
    const next = pruneAuditBaseline(baseline, candidates);
    await writeJsonAtomic(baselinePath, next);
    report.diagnostics.push(`Baseline: ${baseline.entries.length - next.entries.length} stale entr(y/ies) removed.`);
    report.staleBaselineEntries = 0;
  }

  const titles = (rule: string) => ruleTitle(rule, rules.custom);
  if (opts.json) {
    output({ ...report, query: base }, opts);
  } else if (hasFlag(flags, "markdown")) {
    output(renderJiraAuditMarkdown(report, base, ctx.client.siteUrl, titles), opts);
  } else {
    output(renderJiraAuditText(report, base, titles), opts);
  }

  if (failOn !== "never" && report.findings.some((f) => AUDIT_SEVERITY_RANK[f.severity] >= AUDIT_SEVERITY_RANK[failOn])) {
    process.exitCode = 2;
  }
}

/** `"30,60,90"` → ascending positive thresholds, or an error message. */
export function parseStaleDays(value: string): [number, number, number] | string {
  const parts = value.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 1) || !(parts[0] < parts[1] && parts[1] < parts[2])) {
    return `--stale needs three ascending day counts, e.g. 30,60,90.`;
  }
  return parts as [number, number, number];
}

export function auditJiraHelp(): string {
  return `Usage: atlcli audit jira [--project KEY | --board ID | --jql JQL] [options]

Report-only findings over open issues and issues done in the last ${DONE_WINDOW_DAYS} days,
under a rules file (built-in profile "default" when there is none).

Rules (category/rule):
  workflow/resolved-not-done   Statuses holding resolved issues outside the Done category
  flow/stuck-wip               In progress longer than the cycle-time P85 / P95
  flow/status-aging            Longer in the current status than that status's P85 / P95
  flow/unassigned-wip          In progress without an assignee
  hygiene/overdue              Due date passed
  hygiene/due-soon             Due within a few days
  hygiene/flagged              Flagged (impediment) for days
  hygiene/stale                Not updated for 30 / 60 / 90 days
  hygiene/no-parent            No parent (epic)
  hygiene/unestimated-in-sprint  In an open sprint without story points
  hygiene/done-without-version Done without a fix version where the project uses versions

Rules file (first found): --rules <file>, ./.atlcli/${AUDIT_RULES_FILE},
  ~/.atlcli/profiles/<profile>/${AUDIT_RULES_FILE}, ~/.atlcli/${AUDIT_RULES_FILE}
Baseline: ~/.atlcli/profiles/<profile>/audit-baseline.json; without one, findings on
  issues not updated for 180 days count as legacy (one line per rule).

Options:
  --project <key>       Project (default: defaults.project)
  --board <id>          Use the board's saved filter (default: defaults.board)
  --jql <jql>           Any JQL; wins over --board and --project
  --rules <file>        Rules file to use
  --checks <list>       Only these rules: rule ids, categories (workflow, flow, hygiene,
                        custom) or the older names stuck-wip, unassigned-wip, stale
  --min-level <level>   List findings from this level (default: the rules file's minLevel)
  --fail-on <level>     Exit 2 when a listed finding reaches it: info, warning, error
                        (default), never
  --update-baseline     Accept every current finding into the baseline
  --prune-baseline      Remove baseline entries that no longer match
  --no-baseline         Ignore the baseline and the legacy cutoff
  --all                 Include to-do issues in hygiene/stale
  --stale <a,b,c>       Stale thresholds in days (default: 30,60,90; config audit.jira.staleDays)
  --status-map <map>    Override status categories, e.g. "Code Review=wip"
  --points-field <id>   Story points field (auto-detected)
  --flagged-field <id>  Flagged field (auto-detected by its JQL name Flagged)
  --limit <n>           Max issues per query (default: 1000)
  --markdown            Markdown report
  --json                JSON report (schemaVersion 2)

Exit codes: 0 ran, 1 failed or wrong arguments, 2 findings at --fail-on.

Examples:
  atlcli audit jira --project ATLCLI
  atlcli audit jira --board 123 --checks flow --min-level info
  atlcli audit jira --project GROW --update-baseline
  atlcli audit jira --jql "project = ATLCLI AND component = API" --markdown > audit.md`;
}
