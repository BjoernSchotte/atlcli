/**
 * `audit jira`: hygiene findings over a set of open and recently done issues
 * (spec digest-flow-metrics B3). Pure; the CLI fetches the issues, their
 * status changelogs and the site statuses, and passes `now`.
 */

import {
  FLOW_MIN_PERCENTILE_SAMPLES,
  type StatusCategoryResolver,
  buildIssueFlowTimeline,
  percentile,
} from "./flow.js";
import type { JiraIssue } from "./types.js";

export type JiraAuditCheck = "stuck-wip" | "unassigned-wip" | "stale" | "hygiene";
export type JiraAuditSeverity = "info" | "warning" | "error";

export const JIRA_AUDIT_CHECKS: readonly JiraAuditCheck[] = ["stuck-wip", "unassigned-wip", "stale", "hygiene"];
export const DEFAULT_JIRA_STALE_DAYS: [number, number, number] = [30, 60, 90];

export interface JiraAuditFinding {
  check: JiraAuditCheck;
  rule: string;
  severity: JiraAuditSeverity;
  key: string;
  summary: string;
  status: string;
  assignee?: string;
  detail: string;
  ageDays?: number;
}

export interface JiraAuditReportV1 {
  schemaVersion: "1";
  generatedAt: string;
  summary: {
    total: number;
    bySeverity: Record<JiraAuditSeverity, number>;
    byCheck: Record<JiraAuditCheck, number>;
  };
  findings: JiraAuditFinding[];
  diagnostics: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SEVERITY_RANK: Record<JiraAuditSeverity, number> = { error: 0, warning: 1, info: 2 };

function days(fromIso: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(fromIso)) / DAY_MS);
}

function isEpic(issue: JiraIssue): boolean {
  const type = issue.fields.issuetype as { name?: string; hierarchyLevel?: number } | undefined;
  return type?.hierarchyLevel === 1 || type?.name?.toLowerCase() === "epic";
}

function isSubtask(issue: JiraIssue): boolean {
  const type = issue.fields.issuetype as { subtask?: boolean; hierarchyLevel?: number } | undefined;
  return type?.subtask === true || type?.hierarchyLevel === -1;
}

function hasPoints(issue: JiraIssue, pointsField: string): boolean {
  const value = issue.fields[pointsField as keyof JiraIssue["fields"]];
  return value !== null && value !== undefined && value !== "";
}

export function auditJiraIssues(input: {
  open: JiraIssue[];
  done: JiraIssue[];
  resolve: StatusCategoryResolver;
  now: Date;
  staleThresholds: [number, number, number];
  checks: Set<JiraAuditCheck>;
  includeTodo: boolean;
  /** Story-points field; without it the unestimated rule is skipped. */
  pointsField?: string;
  /** Keys of open issues in an open or active sprint; undefined skips the rule. */
  inOpenSprint?: Set<string>;
  /** Project keys that have at least one version. */
  projectsUsingVersions: Set<string>;
}): JiraAuditReportV1 {
  const { now, checks } = input;
  const findings: JiraAuditFinding[] = [];
  const diagnostics: string[] = [];

  const base = (issue: JiraIssue) => ({
    key: issue.key,
    summary: issue.fields.summary ?? "",
    status: issue.fields.status?.name ?? "",
    ...(issue.fields.assignee?.displayName ? { assignee: issue.fields.assignee.displayName } : {}),
  });

  const cycleDays = input.done
    .map((issue) => buildIssueFlowTimeline(issue, input.resolve))
    .flatMap((t) =>
      t.startedAt && t.doneAt && t.unknownStatuses.length === 0
        ? [(Date.parse(t.doneAt) - Date.parse(t.startedAt)) / DAY_MS]
        : []
    )
    .sort((a, b) => a - b);
  const enough = cycleDays.length >= FLOW_MIN_PERCENTILE_SAMPLES;
  const p85 = enough ? percentile(cycleDays, 85) : undefined;
  const p95 = enough ? percentile(cycleDays, 95) : undefined;
  if (checks.has("stuck-wip") && !enough) {
    diagnostics.push(
      `stuck-wip skipped: ${cycleDays.length} completed issue(s) with a cycle time, need ${FLOW_MIN_PERCENTILE_SAMPLES} for a P85.`
    );
  }

  const [staleInfo, staleWarn, staleError] = input.staleThresholds;

  for (const issue of input.open) {
    const timeline = buildIssueFlowTimeline(issue, input.resolve);
    const category = timeline.currentCategory;

    if (checks.has("stuck-wip") && category === "wip" && p85 !== undefined && p95 !== undefined) {
      const age = (now.getTime() - Date.parse(timeline.startedAt ?? timeline.created)) / DAY_MS;
      if (age > p85) {
        const severity = age > p95 ? "error" : "warning";
        findings.push({
          check: "stuck-wip",
          rule: "stuck-wip",
          severity,
          ...base(issue),
          ageDays: Math.floor(age),
          detail: `In progress for ${Math.floor(age)} d, above the cycle-time ${severity === "error" ? `P95 (${p95.toFixed(1)} d)` : `P85 (${p85.toFixed(1)} d)`}.`,
        });
      }
    }

    if (checks.has("unassigned-wip") && category === "wip" && !issue.fields.assignee) {
      findings.push({
        check: "unassigned-wip",
        rule: "unassigned-wip",
        severity: "warning",
        ...base(issue),
        detail: "In progress without an assignee.",
      });
    }

    const updated = issue.fields.updated ?? issue.fields.created;
    if (
      checks.has("stale") &&
      updated &&
      (category === "wip" || (input.includeTodo && category === "todo"))
    ) {
      const age = days(updated, now);
      const severity: JiraAuditSeverity | undefined =
        age >= staleError ? "error" : age >= staleWarn ? "warning" : age >= staleInfo ? "info" : undefined;
      if (severity) {
        findings.push({
          check: "stale",
          rule: "stale",
          severity,
          ...base(issue),
          ageDays: age,
          detail: `Not updated for ${age} d.`,
        });
      }
    }

    if (checks.has("hygiene")) {
      if (!issue.fields.parent && !isEpic(issue) && !isSubtask(issue)) {
        findings.push({
          check: "hygiene",
          rule: "no-parent",
          severity: "info",
          ...base(issue),
          detail: "No parent (epic).",
        });
      }
      if (input.pointsField && input.inOpenSprint?.has(issue.key) && !hasPoints(issue, input.pointsField)) {
        findings.push({
          check: "hygiene",
          rule: "unestimated-in-sprint",
          severity: "warning",
          ...base(issue),
          detail: "In an open sprint without story points.",
        });
      }
    }
  }

  if (checks.has("hygiene")) {
    if (!input.pointsField) diagnostics.push("unestimated-in-sprint skipped: no story points field detected.");
    else if (!input.inOpenSprint) diagnostics.push("unestimated-in-sprint skipped: open sprints could not be read.");
    for (const issue of input.done) {
      const project = issue.fields.project?.key;
      if (project && input.projectsUsingVersions.has(project) && !(issue.fields.fixVersions?.length)) {
        findings.push({
          check: "hygiene",
          rule: "done-without-version",
          severity: "info",
          ...base(issue),
          detail: `Done without a fix version, although ${project} uses versions.`,
        });
      }
    }
  }

  findings.sort(
    (a, b) =>
      JIRA_AUDIT_CHECKS.indexOf(a.check) - JIRA_AUDIT_CHECKS.indexOf(b.check) ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (b.ageDays ?? -1) - (a.ageDays ?? -1) ||
      a.rule.localeCompare(b.rule) ||
      a.key.localeCompare(b.key, undefined, { numeric: true })
  );

  const bySeverity = { error: 0, warning: 0, info: 0 };
  const byCheck = Object.fromEntries(JIRA_AUDIT_CHECKS.map((c) => [c, 0])) as Record<JiraAuditCheck, number>;
  for (const finding of findings) {
    bySeverity[finding.severity]++;
    byCheck[finding.check]++;
  }

  return {
    schemaVersion: "1",
    generatedAt: now.toISOString(),
    summary: { total: findings.length, bySeverity, byCheck },
    findings,
    diagnostics,
  };
}

const CHECK_TITLES: Record<JiraAuditCheck, string> = {
  "stuck-wip": "Stuck in progress",
  "unassigned-wip": "In progress without assignee",
  stale: "Stale",
  hygiene: "Hygiene",
};

function grouped(report: JiraAuditReportV1): Array<[JiraAuditCheck, JiraAuditFinding[]]> {
  return JIRA_AUDIT_CHECKS.map((check) => [check, report.findings.filter((f) => f.check === check)] as [JiraAuditCheck, JiraAuditFinding[]])
    .filter(([, list]) => list.length > 0);
}

/** Plain-text report for the terminal. */
export function renderJiraAuditText(report: JiraAuditReportV1, query: string): string {
  const { summary } = report;
  const lines = [
    `Jira audit: ${summary.total} finding(s) — ${summary.bySeverity.error} error, ${summary.bySeverity.warning} warning, ${summary.bySeverity.info} info`,
    `Query: ${query}`,
  ];
  for (const [check, list] of grouped(report)) {
    lines.push("", `${CHECK_TITLES[check]} (${list.length})`);
    for (const f of list) {
      lines.push(`  [${f.severity}] ${f.key}  ${f.summary}${f.assignee ? ` (${f.assignee})` : ""} — ${f.detail}`);
    }
  }
  if (summary.total === 0) lines.push("", "No findings.");
  if (report.diagnostics.length) lines.push("", ...report.diagnostics.map((d) => `Note: ${d}`));
  return lines.join("\n");
}

function mdCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Markdown report, e.g. for a Confluence page or a retro. */
export function renderJiraAuditMarkdown(report: JiraAuditReportV1, query: string, baseUrl?: string): string {
  const { summary } = report;
  const lines = [
    "# Jira audit",
    "",
    `Generated ${report.generatedAt.slice(0, 10)} · \`${query.replace(/`/g, "'")}\``,
    "",
    `**${summary.total}** finding(s): ${summary.bySeverity.error} error, ${summary.bySeverity.warning} warning, ${summary.bySeverity.info} info.`,
  ];
  for (const [check, list] of grouped(report)) {
    lines.push("", `## ${CHECK_TITLES[check]} (${list.length})`, "", "| Severity | Issue | Summary | Assignee | Finding |", "|---|---|---|---|---|");
    for (const f of list) {
      const key = baseUrl ? `[${f.key}](${baseUrl}/browse/${f.key})` : f.key;
      lines.push(`| ${f.severity} | ${key} | ${mdCell(f.summary)} | ${mdCell(f.assignee ?? "")} | ${mdCell(f.detail)} |`);
    }
  }
  if (report.diagnostics.length) lines.push("", ...report.diagnostics.map((d) => `> ${d}`));
  return `${lines.join("\n")}\n`;
}
