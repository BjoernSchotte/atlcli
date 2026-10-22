/**
 * `audit jira`: findings over a set of open and recently done issues, under
 * configurable rules (spec digest-flow-metrics B3, spec jira-audit-rules).
 * Pure; the CLI fetches the issues, their changelogs, the site statuses and
 * the baseline, and passes `now`.
 */

import {
  AUDIT_SEVERITY_RANK,
  type AuditCategory,
  type AuditRuleConfig,
  type AuditRules,
  type AuditSeverity,
  JIRA_AUDIT_RULES,
  effectiveRule,
  isRuleActive,
  isRuleOff,
  ruleDef,
  ruleTitle,
  severityForValue,
} from "./audit-rules.js";
import {
  FLOW_MIN_PERCENTILE_SAMPLES,
  type StatusCategoryResolver,
  buildIssueFlowTimeline,
  percentile,
} from "./flow.js";
import type { JiraIssue } from "./types.js";

export type JiraAuditSeverity = AuditSeverity;

/** `--stale` and `audit.jira.staleDays` before the rules file existed. */
export const DEFAULT_JIRA_STALE_DAYS: [number, number, number] = [30, 60, 90];

export interface JiraAuditFinding {
  /** Rule id, e.g. `hygiene/stale` or a custom `team/bug-without-component`. */
  rule: string;
  category: AuditCategory;
  severity: JiraAuditSeverity;
  key: string;
  summary: string;
  status: string;
  assignee?: string;
  detail: string;
  ageDays?: number;
  /** What the baseline records: the issue key, or `status:<id>` for status-level rules. */
  subject: string;
}

export interface JiraAuditReportV2 {
  schemaVersion: "2";
  generatedAt: string;
  rules: { source: string; extends: string; minLevel: JiraAuditSeverity };
  summary: {
    total: number;
    bySeverity: Record<JiraAuditSeverity, number>;
    byRule: Record<string, number>;
    suppressed: { quiet: number; baseline: number; legacy: number };
  };
  /** Findings at or above the min level, not in the baseline and not legacy. */
  findings: JiraAuditFinding[];
  /** Per rule: findings below the min level. */
  quiet: Record<string, number>;
  /** Per rule: findings on issues not updated for `legacyDays`. */
  legacy: Record<string, number>;
  legacyDays: number | null;
  /** Baseline entries no current finding matches. */
  staleBaselineEntries: number;
  /** Inputs cut by a limit (open issues, done issues, custom rule ids): counts are lower bounds. */
  partial: string[];
  diagnostics: string[];
}

export interface JiraAuditBaseline {
  schemaVersion: 1;
  entries: Array<{ rule: string; subject: string; acceptedAt: string }>;
}

export interface JiraAuditInput {
  rules: AuditRules;
  open: JiraIssue[];
  done: JiraIssue[];
  resolve: StatusCategoryResolver;
  now: Date;
  /** Story-points field; without it the unestimated rule is skipped. */
  pointsField?: string;
  /** Keys of open issues in an open or active sprint; undefined skips the rule. */
  inOpenSprint?: Set<string>;
  /** Project keys that have at least one version. */
  projectsUsingVersions: Set<string>;
  /** Resolved issues outside the Done category, with their status and resolution history. */
  resolvedNotDone?: { issues: JiraIssue[]; truncated: boolean };
  /** The Flagged field id; undefined skips `hygiene/flagged`. */
  flaggedField?: string;
  /** Custom rule id → its hits. */
  custom?: Map<string, JiraIssue[]>;
  /** Per override index: the keys its `jql` matched. */
  jqlMatches?: Array<Set<string> | undefined>;
  /** The profile's baseline; undefined when there is none. */
  baseline?: JiraAuditBaseline;
  /** False with `--no-baseline`: neither the baseline nor the legacy cutoff applies. */
  useBaseline: boolean;
  /** Inputs whose search was cut by a limit. */
  partial?: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RULE_ORDER = new Map(JIRA_AUDIT_RULES.map((r, i) => [r.id, i]));

function isEpic(issue: JiraIssue): boolean {
  const type = issue.fields.issuetype as { name?: string; hierarchyLevel?: number } | undefined;
  return type?.hierarchyLevel === 1 || type?.name?.toLowerCase() === "epic";
}

function isSubtask(issue: JiraIssue): boolean {
  const type = issue.fields.issuetype as { subtask?: boolean; hierarchyLevel?: number } | undefined;
  return type?.subtask === true || type?.hierarchyLevel === -1;
}

function fieldValue(issue: JiraIssue, field: string): unknown {
  return (issue.fields as unknown as Record<string, unknown>)[field];
}

function present(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0);
}

function sorted(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

function fmt(days: number): string {
  return `${days.toFixed(1)} d`;
}

/** Day after the due date, UTC midnight: the issue is overdue from then on. */
function dueEnd(duedate: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(duedate);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1) : undefined;
}

/** When the Flagged field was last set, from the changelog; undefined when the history has no such change. */
function flaggedSince(issue: JiraIssue, field: string): string | undefined {
  let since: string | undefined;
  const histories = [...(issue.changelog?.histories ?? [])].sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
  for (const history of histories) {
    for (const item of history.items) {
      const id = (item as { fieldId?: string }).fieldId;
      if (id !== field && item.field.toLowerCase() !== "flagged") continue;
      const to = Object.hasOwn(item, "toString") ? item.toString : null;
      since = present(to) ? history.created : undefined;
    }
  }
  return since;
}

/**
 * Where an issue's current resolution came from: set in the same history entry
 * that moved it into `statusId` (`on-entry`), set in another entry (`kept`),
 * or not visible in the history.
 */
function resolutionOrigin(issue: JiraIssue, statusId: string | undefined): "on-entry" | "kept" | undefined {
  const histories = [...(issue.changelog?.histories ?? [])].sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
  const id = (item: { field: string; fieldId?: string }) => item.fieldId ?? item.field.toLowerCase();
  const setting = histories.find((h) => h.items.some((item) => id(item) === "resolution" && present(item.to ?? (Object.hasOwn(item, "toString") ? item.toString : null))));
  if (!setting) return undefined;
  return setting.items.some((item) => id(item) === "status" && item.to === statusId) ? "on-entry" : "kept";
}

/** Apply the rules. `candidates` are all findings before baseline, legacy and min level (for `--update-baseline`). */
export function auditJiraIssues(input: JiraAuditInput): { report: JiraAuditReportV2; candidates: JiraAuditFinding[] } {
  const { now, rules } = input;
  const nowMs = now.getTime();
  const diagnostics: string[] = [];
  const raw: Array<{ finding: JiraAuditFinding; updated?: string }> = [];

  const config = (ruleId: string, issue: JiraIssue): AuditRuleConfig =>
    effectiveRule(
      rules,
      ruleId,
      {
        key: issue.key,
        project: issue.fields.project?.key,
        issueType: issue.fields.issuetype as { id?: string; name?: string } | undefined,
        status: issue.fields.status ?? undefined,
      },
      input.jqlMatches
    );
  // A rule that is off everywhere (base and overrides) is skipped up front.
  const anywhere = (ruleId: string) => isRuleActive(rules, ruleId);

  const base = (issue: JiraIssue, ruleId: string, severity: JiraAuditSeverity, detail: string, ageDays?: number) => {
    raw.push({
      updated: issue.fields.updated ?? issue.fields.created,
      finding: {
        rule: ruleId,
        category: ruleDef(ruleId)?.category ?? "custom",
        severity,
        key: issue.key,
        summary: issue.fields.summary ?? "",
        status: issue.fields.status?.name ?? "",
        ...(issue.fields.assignee?.displayName ? { assignee: issue.fields.assignee.displayName } : {}),
        detail,
        ...(ageDays !== undefined ? { ageDays: Math.floor(ageDays) } : {}),
        subject: issue.key,
      },
    });
  };

  // Reference sets from the done issues: cycle times, and the time spent per status.
  // Epics are containers that run as long as their children; they are left out
  // of the flow rules and of these reference sets.
  const doneTimelines = input.done.filter((issue) => !isEpic(issue)).map((issue) => buildIssueFlowTimeline(issue, input.resolve));
  const cycle = sorted(
    doneTimelines.flatMap((t) =>
      t.startedAt && t.doneAt && t.unknownStatuses.length === 0 ? [(Date.parse(t.doneAt) - Date.parse(t.startedAt)) / DAY_MS] : []
    )
  );
  const cyclePercentile = (p: number) => (cycle.length >= FLOW_MIN_PERCENTILE_SAMPLES ? percentile(cycle, p) : undefined);
  const inStatus = new Map<string, number[]>();
  for (const t of doneTimelines) {
    for (const interval of t.intervals) {
      if (!interval.to || !interval.statusId || interval.category === "done") continue;
      const list = inStatus.get(interval.statusId) ?? [];
      list.push((Date.parse(interval.to) - Date.parse(interval.from)) / DAY_MS);
      inStatus.set(interval.statusId, list);
    }
  }
  for (const [id, list] of inStatus) inStatus.set(id, sorted(list));
  let stuckSkipped = false;
  const agingSkipped = new Set<string>();

  for (const issue of input.open) {
    const timeline = buildIssueFlowTimeline(issue, input.resolve);
    const category = timeline.currentCategory;
    if (category === "done") continue;

    const epic = isEpic(issue);
    if (category === "wip" && !epic && anywhere("flow/stuck-wip")) {
      const c = config("flow/stuck-wip", issue);
      if (!isRuleOff(c, "flow/stuck-wip")) {
        const age = (nowMs - Date.parse(timeline.startedAt ?? timeline.created)) / DAY_MS;
        if (Object.values(c.thresholds ?? {}).some((t) => "percentile" in t) && cycle.length < FLOW_MIN_PERCENTILE_SAMPLES) stuckSkipped = true;
        const hit = severityForValue(c, "age", age, cyclePercentile);
        if (hit) {
          const what = "percentile" in hit.threshold ? `the cycle-time P${hit.threshold.percentile} (${fmt(hit.limit)})` : `${fmt(hit.limit)}`;
          base(issue, "flow/stuck-wip", hit.severity, `In progress for ${Math.floor(age)} d, above ${what}.`, age);
        }
      }
    }

    if (category === "wip" && !epic && anywhere("flow/status-aging")) {
      const c = config("flow/status-aging", issue);
      const current = timeline.intervals[timeline.intervals.length - 1];
      if (!isRuleOff(c, "flow/status-aging") && current) {
        const age = (nowMs - Date.parse(current.from)) / DAY_MS;
        // The issue's own status wins over a history that may not record the last move.
        const statusId = issue.fields.status?.id ?? current.statusId;
        const samples = (statusId ? inStatus.get(statusId) : undefined) ?? [];
        const statusPercentile = (p: number) => (samples.length >= FLOW_MIN_PERCENTILE_SAMPLES ? percentile(samples, p) : undefined);
        if (samples.length < FLOW_MIN_PERCENTILE_SAMPLES && Object.values(c.thresholds ?? {}).some((t) => "percentile" in t)) {
          agingSkipped.add(issue.fields.status?.name ?? current.statusName ?? "?");
        }
        const hit = severityForValue(c, "age", age, statusPercentile);
        if (hit) {
          const status = issue.fields.status?.name ?? current.statusName ?? "?";
          const what = "percentile" in hit.threshold ? `the P${hit.threshold.percentile} for "${status}" (${fmt(hit.limit)})` : fmt(hit.limit);
          base(issue, "flow/status-aging", hit.severity, `In "${status}" for ${Math.floor(age)} d, above ${what}.`, age);
        }
      }
    }

    if (category === "wip" && !issue.fields.assignee && anywhere("flow/unassigned-wip")) {
      const c = config("flow/unassigned-wip", issue);
      if (!isRuleOff(c, "flow/unassigned-wip")) base(issue, "flow/unassigned-wip", c.level as AuditSeverity, "In progress without an assignee.");
    }

    const duedate = issue.fields.duedate as string | undefined | null;
    const end = duedate ? dueEnd(duedate) : undefined;
    if (end !== undefined && nowMs >= end && anywhere("hygiene/overdue")) {
      const c = config("hygiene/overdue", issue);
      const over = (nowMs - end) / DAY_MS;
      const hit = isRuleOff(c, "hygiene/overdue") ? undefined : severityForValue(c, "age", over, () => undefined);
      if (hit) base(issue, "hygiene/overdue", hit.severity, `Due ${duedate!.slice(0, 10)}, ${Math.floor(over)} d overdue.`, over);
    }
    if (end !== undefined && nowMs < end && anywhere("hygiene/due-soon")) {
      const c = config("hygiene/due-soon", issue);
      const left = (end - nowMs) / DAY_MS;
      const hit = isRuleOff(c, "hygiene/due-soon") ? undefined : severityForValue(c, "until", left, () => undefined);
      if (hit) base(issue, "hygiene/due-soon", hit.severity, `Due ${duedate!.slice(0, 10)}, in ${Math.ceil(left)} d.`);
    }

    if (input.flaggedField && present(fieldValue(issue, input.flaggedField)) && anywhere("hygiene/flagged")) {
      const c = config("hygiene/flagged", issue);
      if (!isRuleOff(c, "hygiene/flagged")) {
        const since = flaggedSince(issue, input.flaggedField);
        const from = since ?? issue.fields.updated ?? issue.fields.created;
        const age = from ? (nowMs - Date.parse(from)) / DAY_MS : 0;
        const hit = severityForValue(c, "age", age, () => undefined);
        if (hit) {
          base(issue, "hygiene/flagged", hit.severity, since ? `Flagged for ${Math.floor(age)} d.` : `Flagged for at least ${Math.floor(age)} d (since the last update).`, age);
        }
      }
    }

    const updated = issue.fields.updated ?? issue.fields.created;
    if (updated && anywhere("hygiene/stale")) {
      const c = config("hygiene/stale", issue);
      const include = c.include ?? ["wip"];
      if (!isRuleOff(c, "hygiene/stale") && include.includes(category === "wip" ? "wip" : "todo")) {
        const age = (nowMs - Date.parse(updated)) / DAY_MS;
        const hit = severityForValue(c, "age", age, () => undefined);
        if (hit) base(issue, "hygiene/stale", hit.severity, `Not updated for ${Math.floor(age)} d.`, age);
      }
    }

    if (!issue.fields.parent && !isEpic(issue) && !isSubtask(issue) && anywhere("hygiene/no-parent")) {
      const c = config("hygiene/no-parent", issue);
      if (!isRuleOff(c, "hygiene/no-parent")) base(issue, "hygiene/no-parent", c.level as AuditSeverity, "No parent (epic).");
    }

    if (input.pointsField && input.inOpenSprint?.has(issue.key) && !present(fieldValue(issue, input.pointsField)) && anywhere("hygiene/unestimated-in-sprint")) {
      const c = config("hygiene/unestimated-in-sprint", issue);
      if (!isRuleOff(c, "hygiene/unestimated-in-sprint")) base(issue, "hygiene/unestimated-in-sprint", c.level as AuditSeverity, "In an open sprint without story points.");
    }
  }

  if (stuckSkipped) {
    diagnostics.push(`flow/stuck-wip percentiles skipped: ${cycle.length} completed issue(s) with a cycle time, need ${FLOW_MIN_PERCENTILE_SAMPLES}.`);
  }
  if (agingSkipped.size) {
    diagnostics.push(`flow/status-aging percentiles skipped for ${[...agingSkipped].map((s) => `"${s}"`).join(", ")}: fewer than ${FLOW_MIN_PERCENTILE_SAMPLES} done issues passed through.`);
  }
  if (anywhere("hygiene/unestimated-in-sprint")) {
    if (!input.pointsField) diagnostics.push("hygiene/unestimated-in-sprint skipped: no story points field detected.");
    else if (!input.inOpenSprint) diagnostics.push("hygiene/unestimated-in-sprint skipped: open sprints could not be read.");
  }
  if (anywhere("hygiene/flagged") && !input.flaggedField) diagnostics.push("hygiene/flagged skipped: no Flagged field found (set flagged.field in the rules file).");

  if (anywhere("hygiene/done-without-version")) {
    for (const issue of input.done) {
      const project = issue.fields.project?.key;
      if (!project || !input.projectsUsingVersions.has(project) || issue.fields.fixVersions?.length) continue;
      const c = config("hygiene/done-without-version", issue);
      if (!isRuleOff(c, "hygiene/done-without-version")) {
        base(issue, "hygiene/done-without-version", c.level as AuditSeverity, `Done without a fix version, although ${project} uses versions.`);
      }
    }
  }

  // A status holding resolved issues outside the Done category: either the
  // status means done (a workflow mistake that skews every category-based
  // number) or the issues kept their resolution when moved there. The
  // changelog tells which: a workflow that sets the resolution in the same
  // step that enters the status treats the status as done.
  if (input.resolvedNotDone && anywhere("workflow/resolved-not-done")) {
    const ruleId = "workflow/resolved-not-done";
    const byStatus = new Map<string, { status: NonNullable<JiraIssue["fields"]["status"]>; keys: string[]; severity: AuditSeverity; onEntry: number; kept: number }>();
    for (const issue of input.resolvedNotDone.issues) {
      const status = issue.fields.status;
      if (!status || input.resolve(status) === "done") continue;
      const c = config(ruleId, issue);
      if (isRuleOff(c, ruleId)) continue;
      const id = status.id ?? status.name;
      const entry = byStatus.get(id) ?? { status, keys: [], severity: c.level as AuditSeverity, onEntry: 0, kept: 0 };
      entry.keys.push(issue.key);
      const how = resolutionOrigin(issue, status.id);
      if (how === "on-entry") entry.onEntry++;
      if (how === "kept") entry.kept++;
      if (AUDIT_SEVERITY_RANK[c.level as AuditSeverity] > AUDIT_SEVERITY_RANK[entry.severity]) entry.severity = c.level as AuditSeverity;
      byStatus.set(id, entry);
    }
    for (const [id, { status, keys, severity, onEntry, kept }] of byStatus) {
      const statusCategory = (status.statusCategory as { name?: string } | undefined)?.name ?? status.statusCategory?.key ?? "?";
      const count = `${keys.length}${input.resolvedNotDone.truncated ? "+" : ""} resolved issue(s)`;
      const examples = `${keys.slice(0, 5).join(", ")}${keys.length > 5 ? ", …" : ""}`;
      const asDone = `move it to Done in the workflow, or map it: --status-map "${status.name}=done"`;
      const clear = "clear the resolution on these issues";
      const detail =
        onEntry > kept
          ? `${count}; for ${onEntry} the transition into this status set the resolution (${examples}). If the status means done, ${asDone}; if not, stop that transition from setting a resolution.`
          : kept > onEntry
            ? `${count}; for ${kept} the resolution was set elsewhere and kept when they moved here (${examples}). Fix: ${clear}.`
            : `${count} (${examples}); the history does not show where the resolution was set. Either the status means done (${asDone}) or ${clear}.`;
      raw.push({
        finding: {
          rule: ruleId,
          category: "workflow",
          severity,
          key: keys[0],
          summary: `Status "${status.name}" (${statusCategory} category)`,
          status: status.name,
          detail,
          subject: `status:${id}`,
        },
      });
    }
  }

  for (const rule of rules.custom) {
    for (const issue of input.custom?.get(rule.id) ?? []) {
      const c = config(rule.id, issue);
      if (!isRuleOff(c, rule.id)) base(issue, rule.id, c.level as AuditSeverity, rule.message);
    }
  }

  const customOrder = new Map(rules.custom.map((c, i) => [c.id, JIRA_AUDIT_RULES.length + i]));
  const order = (id: string) => RULE_ORDER.get(id) ?? customOrder.get(id) ?? Number.MAX_SAFE_INTEGER;
  raw.sort(
    (a, b) =>
      order(a.finding.rule) - order(b.finding.rule) ||
      AUDIT_SEVERITY_RANK[b.finding.severity] - AUDIT_SEVERITY_RANK[a.finding.severity] ||
      (b.finding.ageDays ?? -1) - (a.finding.ageDays ?? -1) ||
      a.finding.key.localeCompare(b.finding.key, undefined, { numeric: true })
  );

  // Suppression: baseline, then the legacy cutoff, then the min level.
  const accepted = new Set(input.useBaseline ? (input.baseline?.entries ?? []).map((e) => `${e.rule}\u0000${e.subject}`) : []);
  const legacyBefore = input.useBaseline && rules.legacyDays !== null ? nowMs - rules.legacyDays * DAY_MS : undefined;
  const findings: JiraAuditFinding[] = [];
  const quiet: Record<string, number> = {};
  const legacy: Record<string, number> = {};
  const seen = new Set<string>();
  let baselined = 0;
  for (const { finding, updated } of raw) {
    const id = `${finding.rule}\u0000${finding.subject}`;
    seen.add(id);
    if (accepted.has(id)) {
      baselined++;
    } else if (legacyBefore !== undefined && finding.category !== "workflow" && updated && Date.parse(updated) < legacyBefore) {
      legacy[finding.rule] = (legacy[finding.rule] ?? 0) + 1;
    } else if (AUDIT_SEVERITY_RANK[finding.severity] < AUDIT_SEVERITY_RANK[rules.minLevel]) {
      quiet[finding.rule] = (quiet[finding.rule] ?? 0) + 1;
    } else {
      findings.push(finding);
    }
  }
  const staleBaselineEntries = input.useBaseline ? [...accepted].filter((id) => !seen.has(id)).length : 0;

  const bySeverity = { error: 0, warning: 0, info: 0 };
  const byRule: Record<string, number> = {};
  for (const finding of findings) {
    bySeverity[finding.severity]++;
    byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1;
  }
  const sum = (r: Record<string, number>) => Object.values(r).reduce((n, v) => n + v, 0);

  return {
    candidates: raw.map((r) => r.finding),
    report: {
      schemaVersion: "2",
      generatedAt: now.toISOString(),
      rules: { source: rules.source, extends: rules.extends, minLevel: rules.minLevel },
      summary: {
        total: findings.length,
        bySeverity,
        byRule,
        suppressed: { quiet: sum(quiet), baseline: baselined, legacy: sum(legacy) },
      },
      findings,
      quiet,
      legacy,
      legacyDays: input.useBaseline ? rules.legacyDays : null,
      staleBaselineEntries,
      partial: [...new Set(input.partial ?? [])],
      diagnostics,
    },
  };
}

/** A baseline accepting every candidate; entries already accepted keep their date. */
export function createAuditBaseline(candidates: JiraAuditFinding[], now: Date, previous?: JiraAuditBaseline): JiraAuditBaseline {
  const before = new Map((previous?.entries ?? []).map((e) => [`${e.rule}\u0000${e.subject}`, e.acceptedAt]));
  const entries = new Map<string, JiraAuditBaseline["entries"][number]>();
  for (const f of candidates) {
    const id = `${f.rule}\u0000${f.subject}`;
    entries.set(id, { rule: f.rule, subject: f.subject, acceptedAt: before.get(id) ?? now.toISOString() });
  }
  return { schemaVersion: 1, entries: [...entries.values()].sort((a, b) => a.rule.localeCompare(b.rule) || a.subject.localeCompare(b.subject, undefined, { numeric: true })) };
}

/** Drop baseline entries no current finding matches. */
export function pruneAuditBaseline(baseline: JiraAuditBaseline, candidates: JiraAuditFinding[]): JiraAuditBaseline {
  const live = new Set(candidates.map((f) => `${f.rule}\u0000${f.subject}`));
  return { schemaVersion: 1, entries: baseline.entries.filter((e) => live.has(`${e.rule}\u0000${e.subject}`)) };
}

/** Parse a baseline file; throws on anything that is not one. */
export function parseAuditBaseline(raw: unknown): JiraAuditBaseline {
  const value = raw as JiraAuditBaseline;
  if (value?.schemaVersion !== 1 || !Array.isArray(value.entries)) throw new Error("not an audit baseline (schemaVersion 1)");
  return {
    schemaVersion: 1,
    entries: value.entries.filter(
      (e) => typeof e?.rule === "string" && typeof e?.subject === "string" && typeof e?.acceptedAt === "string"
    ),
  };
}

function grouped(report: JiraAuditReportV2): Array<[string, JiraAuditFinding[]]> {
  const groups = new Map<string, JiraAuditFinding[]>();
  for (const finding of report.findings) groups.set(finding.rule, [...(groups.get(finding.rule) ?? []), finding]);
  return [...groups];
}

function footer(report: JiraAuditReportV2): string[] {
  const lines: string[] = [];
  const { suppressed } = report.summary;
  if (suppressed.quiet) {
    const by = Object.entries(report.quiet).map(([rule, n]) => `${rule} ${n}`).join(", ");
    lines.push(`Quiet: ${suppressed.quiet} finding(s) below ${report.rules.minLevel} (${by}); --min-level info lists them.`);
  }
  if (suppressed.legacy) {
    const by = Object.entries(report.legacy).map(([rule, n]) => `${rule} ${n}`).join(", ");
    lines.push(`Legacy: ${suppressed.legacy} finding(s) on issues not updated for ${report.legacyDays} d (${by}); --update-baseline accepts them, --no-baseline lists them.`);
  }
  if (suppressed.baseline) lines.push(`Baseline: ${suppressed.baseline} accepted finding(s) not shown.`);
  if (report.staleBaselineEntries) lines.push(`Baseline: ${report.staleBaselineEntries} entr(y/ies) no longer match; --prune-baseline removes them.`);
  if (report.partial.length) lines.push(`Partial: ${report.partial.join(", ")} hit a limit; counts are lower bounds.`);
  return lines;
}

/** Plain-text report for the terminal. */
export function renderJiraAuditText(report: JiraAuditReportV2, query: string, titles: (rule: string) => string = (r) => ruleTitle(r)): string {
  const { summary } = report;
  const lines = [
    `Jira audit: ${summary.total} finding(s) — ${summary.bySeverity.error} error, ${summary.bySeverity.warning} warning, ${summary.bySeverity.info} info`,
    `Query: ${query}`,
    `Rules: ${report.rules.source} (extends ${report.rules.extends}, min level ${report.rules.minLevel})`,
  ];
  for (const [rule, list] of grouped(report)) {
    lines.push("", `${titles(rule)} — ${rule} (${list.length})`);
    for (const f of list) {
      lines.push(`  [${f.severity}] ${f.key}  ${f.summary}${f.assignee ? ` (${f.assignee})` : ""} — ${f.detail}`);
    }
  }
  if (summary.total === 0) lines.push("", "No findings.");
  const notes = [...footer(report), ...report.diagnostics.map((d) => `Note: ${d}`)];
  if (notes.length) lines.push("", ...notes);
  return lines.join("\n");
}

function mdCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Markdown report, e.g. for a Confluence page or a retro. */
export function renderJiraAuditMarkdown(
  report: JiraAuditReportV2,
  query: string,
  baseUrl?: string,
  titles: (rule: string) => string = (r) => ruleTitle(r)
): string {
  const { summary } = report;
  const lines = [
    "# Jira audit",
    "",
    `Generated ${report.generatedAt.slice(0, 10)} · \`${query.replace(/`/g, "'")}\` · rules: ${mdCell(report.rules.source)} (extends ${report.rules.extends})`,
    "",
    `**${summary.total}** finding(s): ${summary.bySeverity.error} error, ${summary.bySeverity.warning} warning, ${summary.bySeverity.info} info.`,
  ];
  for (const [rule, list] of grouped(report)) {
    lines.push("", `## ${mdCell(titles(rule))} (${list.length})`, "", "| Severity | Issue | Summary | Assignee | Finding |", "|---|---|---|---|---|");
    for (const f of list) {
      const key = baseUrl ? `[${f.key}](${baseUrl}/browse/${f.key})` : f.key;
      lines.push(`| ${f.severity} | ${key} | ${mdCell(f.summary)} | ${mdCell(f.assignee ?? "")} | ${mdCell(f.detail)} |`);
    }
  }
  const notes = [...footer(report), ...report.diagnostics];
  if (notes.length) lines.push("", ...notes.map((d) => `> ${d}`));
  return `${lines.join("\n")}\n`;
}
