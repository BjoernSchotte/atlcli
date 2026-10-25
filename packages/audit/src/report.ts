/**
 * Findings, suppression (baseline → legacy → min level), the baseline file
 * and the report, for every audited product. Pure.
 */
import { AUDIT_SEVERITY_RANK, type AuditCategory, type AuditRules, type AuditSeverity } from "./config.js";

export type AuditTargetKind = "issue" | "page" | "status" | "space" | "other";

export interface AuditFinding {
  /** Rule id, e.g. `hygiene/stale`, a custom `team/bug-without-component`, or a script's id. */
  rule: string;
  category: AuditCategory;
  severity: AuditSeverity;
  /** What the finding is about. */
  target: { kind: AuditTargetKind; key: string; url?: string };
  /** The issue key or page id (also `target.key`). */
  key: string;
  /** Issue summary or page title. */
  summary: string;
  status: string;
  assignee?: string;
  detail: string;
  ageDays?: number;
  /** What the baseline records: usually the key; `status:<id>` for status-level rules. */
  subject: string;
  /** Set when the rule script exports `fix`: `--fix` can plan a change for it. */
  fixable?: boolean;
}

export interface AuditReportV3 {
  schemaVersion: "3";
  product: "jira" | "confluence";
  generatedAt: string;
  query: string;
  rules: { source: string; extends: string; minLevel: AuditSeverity };
  summary: {
    total: number;
    bySeverity: Record<AuditSeverity, number>;
    byRule: Record<string, number>;
    suppressed: { quiet: number; baseline: number; legacy: number };
  };
  /** Findings at or above the min level, not in the baseline and not legacy. */
  findings: AuditFinding[];
  /** Per rule: findings below the min level. */
  quiet: Record<string, number>;
  /** Per rule: findings on items not updated for `legacyDays`. */
  legacy: Record<string, number>;
  legacyDays: number | null;
  /** Baseline entries no current finding matches. */
  staleBaselineEntries: number;
  /** Inputs cut by a limit: counts are lower bounds. */
  partial: string[];
  diagnostics: string[];
  /** Rule titles by id, for renderers and templates. */
  titles: Record<string, string>;
}

export interface AuditBaseline {
  schemaVersion: 1;
  entries: Array<{ rule: string; subject: string; acceptedAt: string }>;
}

/** A finding before suppression, with what the legacy cutoff needs. */
export interface CandidateFinding {
  finding: AuditFinding;
  /** When the item last changed (ISO). */
  updated?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const id = (f: { rule: string; subject: string }) => `${f.rule}\u0000${f.subject}`;

/** Report order: rules in registry order, then severity, age and key. */
export function sortCandidates(raw: CandidateFinding[], ruleOrder: (rule: string) => number): CandidateFinding[] {
  return [...raw].sort(
    (a, b) =>
      ruleOrder(a.finding.rule) - ruleOrder(b.finding.rule) ||
      AUDIT_SEVERITY_RANK[b.finding.severity] - AUDIT_SEVERITY_RANK[a.finding.severity] ||
      (b.finding.ageDays ?? -1) - (a.finding.ageDays ?? -1) ||
      a.finding.key.localeCompare(b.finding.key, undefined, { numeric: true }),
  );
}

export interface ReportInput {
  product: AuditReportV3["product"];
  query: string;
  rules: AuditRules;
  now: Date;
  /** Sorted candidates. */
  candidates: CandidateFinding[];
  baseline?: AuditBaseline;
  /** False with `--no-baseline`: neither the baseline nor the legacy cutoff applies. */
  useBaseline: boolean;
  partial?: string[];
  diagnostics?: string[];
  titles: Record<string, string>;
  /** Categories exempt from the legacy cutoff (Jira: workflow). */
  noLegacy?: string[];
}

/** Suppression and counts. */
export function buildReport(input: ReportInput): AuditReportV3 {
  const { rules, now } = input;
  const accepted = new Set(input.useBaseline ? (input.baseline?.entries ?? []).map(id) : []);
  const legacyBefore = input.useBaseline && rules.legacyDays !== null ? now.getTime() - rules.legacyDays * DAY_MS : undefined;
  const noLegacy = new Set(input.noLegacy ?? []);
  const findings: AuditFinding[] = [];
  const quiet: Record<string, number> = {};
  const legacy: Record<string, number> = {};
  const seen = new Set<string>();
  let baselined = 0;
  for (const { finding, updated } of input.candidates) {
    const key = id(finding);
    seen.add(key);
    if (accepted.has(key)) {
      baselined++;
    } else if (legacyBefore !== undefined && !noLegacy.has(finding.category) && updated && Date.parse(updated) < legacyBefore) {
      legacy[finding.rule] = (legacy[finding.rule] ?? 0) + 1;
    } else if (AUDIT_SEVERITY_RANK[finding.severity] < AUDIT_SEVERITY_RANK[rules.minLevel]) {
      quiet[finding.rule] = (quiet[finding.rule] ?? 0) + 1;
    } else {
      findings.push(finding);
    }
  }
  const staleBaselineEntries = input.useBaseline ? [...accepted].filter((k) => !seen.has(k)).length : 0;
  const bySeverity = { error: 0, warning: 0, info: 0 };
  const byRule: Record<string, number> = {};
  for (const f of findings) {
    bySeverity[f.severity]++;
    byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  }
  const sum = (r: Record<string, number>) => Object.values(r).reduce((n, v) => n + v, 0);
  return {
    schemaVersion: "3",
    product: input.product,
    generatedAt: now.toISOString(),
    query: input.query,
    rules: { source: rules.source, extends: rules.extends, minLevel: rules.minLevel },
    summary: { total: findings.length, bySeverity, byRule, suppressed: { quiet: sum(quiet), baseline: baselined, legacy: sum(legacy) } },
    findings,
    quiet,
    legacy,
    legacyDays: input.useBaseline ? rules.legacyDays : null,
    staleBaselineEntries,
    partial: [...new Set(input.partial ?? [])],
    diagnostics: input.diagnostics ?? [],
    titles: input.titles,
  };
}

/** A baseline accepting every candidate; entries already accepted keep their date. */
export function createAuditBaseline(candidates: AuditFinding[], now: Date, previous?: AuditBaseline): AuditBaseline {
  const before = new Map((previous?.entries ?? []).map((e) => [id(e), e.acceptedAt]));
  const entries = new Map<string, AuditBaseline["entries"][number]>();
  for (const f of candidates) entries.set(id(f), { rule: f.rule, subject: f.subject, acceptedAt: before.get(id(f)) ?? now.toISOString() });
  return {
    schemaVersion: 1,
    entries: [...entries.values()].sort((a, b) => a.rule.localeCompare(b.rule) || a.subject.localeCompare(b.subject, undefined, { numeric: true })),
  };
}

/** Drop baseline entries no current finding matches. */
export function pruneAuditBaseline(baseline: AuditBaseline, candidates: AuditFinding[]): AuditBaseline {
  const live = new Set(candidates.map(id));
  return { schemaVersion: 1, entries: baseline.entries.filter((e) => live.has(id(e))) };
}

/** Parse a baseline file; throws on anything that is not one. */
export function parseAuditBaseline(raw: unknown): AuditBaseline {
  const value = raw as AuditBaseline;
  if (value?.schemaVersion !== 1 || !Array.isArray(value.entries)) throw new Error("not an audit baseline (schemaVersion 1)");
  return {
    schemaVersion: 1,
    entries: value.entries.filter((e) => typeof e?.rule === "string" && typeof e?.subject === "string" && typeof e?.acceptedAt === "string"),
  };
}

function grouped(report: AuditReportV3): Array<[string, AuditFinding[]]> {
  const groups = new Map<string, AuditFinding[]>();
  for (const f of report.findings) groups.set(f.rule, [...(groups.get(f.rule) ?? []), f]);
  return [...groups];
}

/** Notes under the findings: suppressed counts, stale baseline entries, partial inputs. */
export function reportFooter(report: AuditReportV3): string[] {
  const lines: string[] = [];
  const { suppressed } = report.summary;
  const noun = report.product === "jira" ? "issues" : "pages";
  if (suppressed.quiet) {
    const by = Object.entries(report.quiet).map(([rule, n]) => `${rule} ${n}`).join(", ");
    lines.push(`Quiet: ${suppressed.quiet} finding(s) below ${report.rules.minLevel} (${by}); --min-level info lists them.`);
  }
  if (suppressed.legacy) {
    const by = Object.entries(report.legacy).map(([rule, n]) => `${rule} ${n}`).join(", ");
    lines.push(`Legacy: ${suppressed.legacy} finding(s) on ${noun} not updated for ${report.legacyDays} d (${by}); --update-baseline accepts them, --no-baseline lists them.`);
  }
  if (suppressed.baseline) lines.push(`Baseline: ${suppressed.baseline} accepted finding(s) not shown.`);
  if (report.staleBaselineEntries) lines.push(`Baseline: ${report.staleBaselineEntries} entr(y/ies) no longer match; --prune-baseline removes them.`);
  if (report.partial.length) lines.push(`Partial: ${report.partial.join(", ")} hit a limit; counts are lower bounds.`);
  return lines;
}

/** Plain-text report for the terminal. */
export function renderAuditText(report: AuditReportV3): string {
  const { summary } = report;
  const name = report.product === "jira" ? "Jira" : "Wiki";
  const lines = [
    `${name} audit: ${summary.total} finding(s) — ${summary.bySeverity.error} error, ${summary.bySeverity.warning} warning, ${summary.bySeverity.info} info`,
    `${report.product === "jira" ? "Query" : "Scope"}: ${report.query}`,
    `Rules: ${report.rules.source} (extends ${report.rules.extends}, min level ${report.rules.minLevel})`,
  ];
  for (const [rule, list] of grouped(report)) {
    lines.push("", `${report.titles[rule] ?? rule} — ${rule} (${list.length})`);
    for (const f of list) lines.push(`  [${f.severity}] ${f.key}  ${f.summary}${f.assignee ? ` (${f.assignee})` : ""} — ${f.detail}`);
  }
  if (summary.total === 0) lines.push("", "No findings.");
  const notes = [...reportFooter(report), ...report.diagnostics.map((d) => `Note: ${d}`)];
  if (notes.length) lines.push("", ...notes);
  return lines.join("\n");
}

/**
 * The default Markdown report as a Jinja template (`--markdown`; print it
 * with `--print-template` to adapt it). Rendered in "lines" mode with the
 * report plus `groups` (findings by rule), `footer`, `query` and `baseUrl`.
 */
export const DEFAULT_MARKDOWN_TEMPLATE = `# {{ "Jira" if product == "jira" else "Wiki" }} audit

Generated {{ generatedAt | date }} · \`{{ query | replace("\`", "'") }}\` · rules: {{ rules.source | mdcell }} (extends {{ rules.extends }})

**{{ summary.total }}** finding(s): {{ summary.bySeverity.error }} error, {{ summary.bySeverity.warning }} warning, {{ summary.bySeverity.info }} info.
{% for group in groups %}

## {{ group.title | mdcell }} ({{ group.findings | length }})

| Severity | {{ "Issue" if product == "jira" else "Page" }} | Summary | {{ "Assignee" if product == "jira" else "Owner" }} | Finding |
|---|---|---|---|---|
{% for f in group.findings %}
| {{ f.severity }} | {% if f.target.url %}[{{ f.key }}]({{ f.target.url }}){% else %}{{ f.key }}{% endif %} | {{ f.summary | mdcell }} | {{ (f.assignee or "") | mdcell }} | {{ f.detail | mdcell }} |
{% endfor %}
{% endfor %}
{% if notes | length %}

{% for note in notes %}
> {{ note }}
{% endfor %}
{% endif %}
`;

/** Variables the Markdown template sees. */
export function markdownModel(report: AuditReportV3): Record<string, unknown> {
  return {
    ...report,
    groups: grouped(report).map(([rule, findings]) => ({ rule, title: report.titles[rule] ?? rule, findings })),
    notes: [...reportFooter(report), ...report.diagnostics],
  };
}
