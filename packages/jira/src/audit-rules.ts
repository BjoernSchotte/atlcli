/**
 * Configurable rules for `audit jira` (spec jira-audit-rules): the rule
 * registry, built-in profiles, validation of a rules file (already parsed
 * from YAML), overrides and threshold evaluation. Pure.
 */

import type { JiraField } from "./types.js";

export type AuditSeverity = "info" | "warning" | "error";
export type AuditLevel = "off" | AuditSeverity;
export type AuditCategory = "workflow" | "flow" | "hygiene" | "custom";
export type AuditProfileName = "minimal" | "default" | "strict";

/**
 * `flag`: present or not, one severity. `age`: a value in days that grows
 * (higher is worse). `until`: days left until a date (lower is worse).
 */
export type AuditRuleKind = "flag" | "age" | "until";

export interface AuditRuleDef {
  id: string;
  category: Exclude<AuditCategory, "custom">;
  kind: AuditRuleKind;
  title: string;
  /** Thresholds may be percentiles (`p85`) of the done reference set. */
  percentiles?: boolean;
  /** Needs the done issues and their changelogs; skipped in the digest unless `digest: true`. */
  expensive?: boolean;
  /** Name in `--checks` before rule ids existed. */
  legacy?: string;
}

export const JIRA_AUDIT_RULES: readonly AuditRuleDef[] = [
  { id: "workflow/resolved-not-done", category: "workflow", kind: "flag", title: "Resolved outside Done", legacy: "workflow" },
  { id: "flow/stuck-wip", category: "flow", kind: "age", title: "Stuck in progress", percentiles: true, expensive: true, legacy: "stuck-wip" },
  { id: "flow/status-aging", category: "flow", kind: "age", title: "Aging in status", percentiles: true, expensive: true },
  { id: "flow/unassigned-wip", category: "flow", kind: "flag", title: "In progress without assignee", legacy: "unassigned-wip" },
  { id: "hygiene/overdue", category: "hygiene", kind: "age", title: "Overdue" },
  { id: "hygiene/due-soon", category: "hygiene", kind: "until", title: "Due soon" },
  { id: "hygiene/flagged", category: "hygiene", kind: "age", title: "Flagged" },
  { id: "hygiene/stale", category: "hygiene", kind: "age", title: "Stale", legacy: "stale" },
  { id: "hygiene/no-parent", category: "hygiene", kind: "flag", title: "No parent" },
  { id: "hygiene/unestimated-in-sprint", category: "hygiene", kind: "flag", title: "Unestimated in sprint" },
  { id: "hygiene/done-without-version", category: "hygiene", kind: "flag", title: "Done without version" },
];

const RULES_BY_ID = new Map(JIRA_AUDIT_RULES.map((rule) => [rule.id, rule]));
const SEVERITIES: readonly AuditSeverity[] = ["info", "warning", "error"];
const LEVELS: readonly AuditLevel[] = ["off", ...SEVERITIES];
export const AUDIT_SEVERITY_RANK: Record<AuditSeverity, number> = { info: 0, warning: 1, error: 2 };

export type AuditThreshold = { days: number } | { percentile: number };

/** One rule's effective settings. */
export interface AuditRuleConfig {
  /** Flag rules: the severity, or off. Threshold rules: `off` or undefined. */
  level?: AuditLevel;
  thresholds?: Partial<Record<AuditSeverity, AuditThreshold>>;
  /** `hygiene/stale`: which categories count (default wip). */
  include?: Array<"todo" | "wip">;
  /** Run in the digest although the rule is expensive. */
  digest?: boolean;
}

export interface AuditCustomRule {
  id: string;
  jql: string;
  message: string;
}

export interface AuditOverrideMatch {
  project?: string[];
  issueType?: string[];
  status?: string[];
  jql?: string;
}

export interface AuditOverride {
  match: AuditOverrideMatch;
  /** Raw patches, applied in order to the rule in effect for the issue. */
  rules: Record<string, unknown>;
}

export interface AuditRules {
  extends: AuditProfileName;
  minLevel: AuditSeverity;
  /** Findings on issues not updated for this many days are counted as legacy; null turns it off. */
  legacyDays: number | null;
  rules: Record<string, AuditRuleConfig>;
  custom: AuditCustomRule[];
  overrides: AuditOverride[];
  flaggedField?: string;
  /** Where the rules came from, for the report. */
  source: string;
}

export class AuditRulesError extends Error {}

type Patch = string | Record<string, unknown>;

const PROFILES: Record<AuditProfileName, { minLevel: AuditSeverity; legacyDays: number | null; rules: Record<string, Patch> }> = {
  minimal: {
    minLevel: "warning",
    legacyDays: 180,
    rules: {
      "workflow/resolved-not-done": "warning",
      "flow/unassigned-wip": "warning",
      "hygiene/overdue": { warning: "7d", error: "30d" },
      "hygiene/flagged": { warning: "10d" },
      "hygiene/stale": { error: "90d" },
    },
  },
  default: {
    minLevel: "warning",
    legacyDays: 180,
    rules: {
      "workflow/resolved-not-done": "warning",
      "flow/stuck-wip": { warning: "p85", error: "p95" },
      "flow/unassigned-wip": "warning",
      "hygiene/overdue": { warning: "0d", error: "14d" },
      "hygiene/due-soon": { info: "3d" },
      "hygiene/flagged": { warning: "3d", error: "10d" },
      "hygiene/stale": { info: "30d", warning: "60d", error: "90d" },
      "hygiene/no-parent": "info",
      "hygiene/unestimated-in-sprint": "warning",
      "hygiene/done-without-version": "info",
    },
  },
  strict: {
    minLevel: "info",
    legacyDays: null,
    rules: {
      "workflow/resolved-not-done": "error",
      "flow/stuck-wip": { warning: "p85", error: "p95" },
      "flow/status-aging": { warning: "p85", error: "p95" },
      "flow/unassigned-wip": "error",
      "hygiene/overdue": { error: "0d" },
      "hygiene/due-soon": { warning: "3d" },
      "hygiene/flagged": { warning: "1d", error: "5d" },
      "hygiene/stale": { info: "30d", warning: "60d", error: "90d", include: ["todo", "wip"] },
      "hygiene/no-parent": "warning",
      "hygiene/unestimated-in-sprint": "error",
      "hygiene/done-without-version": "warning",
    },
  },
};

export const AUDIT_PROFILES = Object.keys(PROFILES) as AuditProfileName[];

/** `30d`, `2w`, `30` (days) or, where allowed, `p85`. */
function parseThreshold(value: unknown, def: AuditRuleDef | undefined, path: string): AuditThreshold {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return { days: value };
  if (typeof value === "string") {
    const days = /^(\d+(?:\.\d+)?)\s*([dw]?)$/i.exec(value.trim());
    if (days) return { days: Number(days[1]) * (days[2].toLowerCase() === "w" ? 7 : 1) };
    const pct = /^p(\d{1,2})$/i.exec(value.trim());
    if (pct && def?.percentiles) return { percentile: Number(pct[1]) };
    if (pct) throw new AuditRulesError(`${path}: percentiles are only allowed for ${JIRA_AUDIT_RULES.filter((r) => r.percentiles).map((r) => r.id).join(", ")}.`);
  }
  throw new AuditRulesError(`${path}: expected days (30d, 2w, 30) ${def?.percentiles ? "or a percentile (p85) " : ""}— got ${JSON.stringify(value)}.`);
}

function isLevel(value: unknown): value is AuditLevel {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

/**
 * Apply one patch to a rule's settings. A level string turns a flag rule to
 * that level; on a threshold rule it keeps the first threshold and gives it
 * that severity. An object merges thresholds and options; a threshold set to
 * `off` is removed.
 */
export function applyRulePatch(current: AuditRuleConfig, patch: unknown, ruleId: string, path: string): AuditRuleConfig {
  const def = RULES_BY_ID.get(ruleId);
  const kind: AuditRuleKind = def?.kind ?? "flag";
  if (typeof patch === "string") {
    if (!isLevel(patch)) throw new AuditRulesError(`${path}: expected off, info, warning or error — got "${patch}".`);
    if (patch === "off" || kind === "flag") return { ...current, level: patch };
    // The mildest threshold (severities run info → error).
    const first = SEVERITIES.map((s) => current.thresholds?.[s]).find((t): t is AuditThreshold => Boolean(t));
    if (!first) throw new AuditRulesError(`${path}: ${ruleId} has no thresholds to apply "${patch}" to; give them, e.g. { ${patch}: 30d }.`);
    return { ...current, level: undefined, thresholds: { [patch]: first } };
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new AuditRulesError(`${path}: expected a level or an object.`);
  }
  const next: AuditRuleConfig = { ...current, thresholds: { ...current.thresholds } };
  for (const [key, value] of Object.entries(patch)) {
    const at = `${path}.${key}`;
    if ((SEVERITIES as readonly string[]).includes(key)) {
      if (kind === "flag") throw new AuditRulesError(`${at}: ${ruleId} has no thresholds; use a level, e.g. ${ruleId}: warning.`);
      if (value === "off") delete next.thresholds![key as AuditSeverity];
      else next.thresholds![key as AuditSeverity] = parseThreshold(value, def, at);
      if (next.level === "off") next.level = undefined;
    } else if (key === "severity") {
      if (!isLevel(value)) throw new AuditRulesError(`${at}: expected off, info, warning or error.`);
      if (kind !== "flag" && value !== "off") throw new AuditRulesError(`${at}: ${ruleId} takes thresholds, e.g. { warning: 30d }.`);
      next.level = value;
    } else if (key === "include" && ruleId === "hygiene/stale") {
      const list = Array.isArray(value) ? value : [value];
      if (list.length === 0 || list.some((v) => v !== "todo" && v !== "wip")) throw new AuditRulesError(`${at}: expected a list of todo and wip.`);
      next.include = list as Array<"todo" | "wip">;
    } else if (key === "digest") {
      if (typeof value !== "boolean") throw new AuditRulesError(`${at}: expected true or false.`);
      next.digest = value;
    } else {
      throw new AuditRulesError(`${at}: unknown option "${key}".`);
    }
  }
  if (kind === "flag") delete next.thresholds;
  return next;
}

/** True when the rule produces nothing with these settings. */
export function isRuleOff(config: AuditRuleConfig | undefined, ruleId: string): boolean {
  if (!config || config.level === "off") return true;
  const kind = RULES_BY_ID.get(ruleId)?.kind ?? "flag";
  if (kind === "flag") return config.level === undefined;
  return !config.thresholds || Object.keys(config.thresholds).length === 0;
}

function profileRules(name: AuditProfileName): Record<string, AuditRuleConfig> {
  const rules: Record<string, AuditRuleConfig> = {};
  for (const def of JIRA_AUDIT_RULES) rules[def.id] = { level: "off" };
  for (const [id, patch] of Object.entries(PROFILES[name].rules)) {
    rules[id] = applyRulePatch({}, patch, id, `profile ${name}.${id}`);
  }
  return rules;
}

/** The rules of a built-in profile, before any file. */
export function defaultAuditRules(profile: AuditProfileName = "default", source = `built-in profile ${profile}`): AuditRules {
  return {
    extends: profile,
    minLevel: PROFILES[profile].minLevel,
    legacyDays: PROFILES[profile].legacyDays,
    rules: profileRules(profile),
    custom: [],
    overrides: [],
    source,
  };
}

const CUSTOM_ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const TOP_LEVEL = new Set(["version", "extends", "minLevel", "rules", "custom", "overrides", "baseline", "flagged"]);

function stringList(value: unknown, path: string): string[] {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0 || list.some((v) => typeof v !== "string" && typeof v !== "number")) {
    throw new AuditRulesError(`${path}: expected a string or a list of strings.`);
  }
  return list.map(String);
}

function parseDays(value: unknown, path: string): number | null {
  if (value === "off" || value === false) return null;
  const t = parseThreshold(value, undefined, path);
  return "days" in t ? t.days : null;
}

/**
 * Validate a parsed rules file and resolve it against its profile. Errors
 * name the path inside the file, e.g. `rules.hygiene/stale.warning`.
 */
export function parseAuditRules(raw: unknown, source: string): AuditRules {
  if (raw === null || raw === undefined) return defaultAuditRules("default", source);
  if (typeof raw !== "object" || Array.isArray(raw)) throw new AuditRulesError(`${source}: expected a mapping at the top level.`);
  const file = raw as Record<string, unknown>;
  for (const key of Object.keys(file)) {
    if (!TOP_LEVEL.has(key)) throw new AuditRulesError(`${source}: unknown key "${key}". Use ${[...TOP_LEVEL].join(", ")}.`);
  }
  if (file.version !== undefined && file.version !== 1) throw new AuditRulesError(`${source}: version must be 1.`);
  const profile = file.extends ?? "default";
  if (!AUDIT_PROFILES.includes(profile as AuditProfileName)) {
    throw new AuditRulesError(`${source}: extends must be one of ${AUDIT_PROFILES.join(", ")}.`);
  }
  const rules = defaultAuditRules(profile as AuditProfileName, source);

  if (file.minLevel !== undefined) {
    if (!(SEVERITIES as readonly unknown[]).includes(file.minLevel)) throw new AuditRulesError(`${source}: minLevel must be info, warning or error.`);
    rules.minLevel = file.minLevel as AuditSeverity;
  }

  const custom = file.custom ?? [];
  if (!Array.isArray(custom)) throw new AuditRulesError(`${source}: custom must be a list.`);
  custom.forEach((entry, i) => {
    const path = `custom[${i}]`;
    const c = entry as Record<string, unknown>;
    if (!c || typeof c !== "object") throw new AuditRulesError(`${path}: expected a mapping.`);
    for (const key of Object.keys(c)) {
      if (!["id", "jql", "severity", "message"].includes(key)) throw new AuditRulesError(`${path}: unknown key "${key}".`);
    }
    if (typeof c.id !== "string" || !CUSTOM_ID.test(c.id)) throw new AuditRulesError(`${path}.id: expected "<group>/<name>" in lower case, e.g. team/bug-without-component.`);
    if (RULES_BY_ID.has(c.id) || rules.custom.some((r) => r.id === c.id)) throw new AuditRulesError(`${path}.id: "${c.id}" is already a rule.`);
    if (typeof c.jql !== "string" || !c.jql.trim()) throw new AuditRulesError(`${path}.jql: expected a JQL query.`);
    if (/\border\s+by\b/i.test(c.jql)) throw new AuditRulesError(`${path}.jql: leave out ORDER BY; the scope is ANDed in.`);
    const severity = c.severity ?? "warning";
    if (!isLevel(severity)) throw new AuditRulesError(`${path}.severity: expected off, info, warning or error.`);
    rules.custom.push({ id: c.id, jql: c.jql.trim(), message: typeof c.message === "string" ? c.message : c.id });
    rules.rules[c.id] = { level: severity };
  });

  const known = (id: string) => RULES_BY_ID.has(id) || rules.custom.some((c) => c.id === id);
  const ruleMap = (value: unknown, path: string): Record<string, unknown> => {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuditRulesError(`${path}: expected a mapping of rule ids.`);
    for (const id of Object.keys(value)) {
      if (!known(id)) throw new AuditRulesError(`${path}: unknown rule "${id}". Rules: ${[...RULES_BY_ID.keys()].join(", ")}.`);
    }
    return value as Record<string, unknown>;
  };

  for (const [id, patch] of Object.entries(ruleMap(file.rules, "rules"))) {
    rules.rules[id] = applyRulePatch(rules.rules[id] ?? {}, patch, id, `rules.${id}`);
  }

  const overrides = file.overrides ?? [];
  if (!Array.isArray(overrides)) throw new AuditRulesError(`${source}: overrides must be a list.`);
  overrides.forEach((entry, i) => {
    const path = `overrides[${i}]`;
    const o = entry as Record<string, unknown>;
    if (!o || typeof o !== "object" || !o.match || typeof o.match !== "object") throw new AuditRulesError(`${path}: expected { match, rules }.`);
    const m = o.match as Record<string, unknown>;
    const match: AuditOverrideMatch = {};
    for (const [key, value] of Object.entries(m)) {
      if (key === "jql") {
        if (typeof value !== "string" || !value.trim()) throw new AuditRulesError(`${path}.match.jql: expected a JQL query.`);
        match.jql = value.trim();
      } else if (key === "project" || key === "issueType" || key === "status") {
        match[key] = stringList(value, `${path}.match.${key}`);
      } else {
        throw new AuditRulesError(`${path}.match: unknown key "${key}". Use project, issueType, status, jql.`);
      }
    }
    if (Object.keys(match).length === 0) throw new AuditRulesError(`${path}.match: give at least one of project, issueType, status, jql.`);
    const patches = ruleMap(o.rules, `${path}.rules`);
    // Validate each patch now, so a bad override fails at load time.
    for (const [id, patch] of Object.entries(patches)) applyRulePatch(rules.rules[id] ?? {}, patch, id, `${path}.rules.${id}`);
    rules.overrides.push({ match, rules: patches });
  });

  if (file.baseline !== undefined) {
    const b = file.baseline as Record<string, unknown>;
    if (!b || typeof b !== "object") throw new AuditRulesError(`baseline: expected { olderThan }.`);
    for (const key of Object.keys(b)) if (key !== "olderThan") throw new AuditRulesError(`baseline: unknown key "${key}".`);
    if (b.olderThan !== undefined) rules.legacyDays = parseDays(b.olderThan, "baseline.olderThan");
  }

  if (file.flagged !== undefined) {
    const f = file.flagged as Record<string, unknown>;
    if (!f || typeof f !== "object" || typeof f.field !== "string") throw new AuditRulesError(`flagged: expected { field: customfield_12345 }.`);
    rules.flaggedField = f.field;
  }
  return rules;
}

/** What an issue looks like to override matching. */
export interface AuditIssueContext {
  key: string;
  project?: string;
  issueType?: { id?: string; name?: string };
  status?: { id?: string; name?: string };
}

function matchesAny(values: string[] | undefined, candidates: Array<string | undefined>): boolean {
  if (!values) return true;
  const wanted = values.map((v) => v.toLowerCase());
  return candidates.some((c) => c !== undefined && wanted.includes(c.toLowerCase()));
}

/**
 * The rule's settings for one issue: the base rule, then every matching
 * override in order. `jqlMatches[i]` holds the keys matched by override i's
 * JQL (fetched by the caller); without it an override with `jql` never matches.
 */
export function effectiveRule(
  rules: AuditRules,
  ruleId: string,
  issue: AuditIssueContext,
  jqlMatches: Array<Set<string> | undefined> = []
): AuditRuleConfig {
  let config = rules.rules[ruleId] ?? { level: "off" };
  rules.overrides.forEach((override, i) => {
    if (!(ruleId in override.rules)) return;
    const m = override.match;
    if (!matchesAny(m.project, [issue.project, issue.key.split("-")[0]])) return;
    if (!matchesAny(m.issueType, [issue.issueType?.id, issue.issueType?.name])) return;
    if (!matchesAny(m.status, [issue.status?.id, issue.status?.name])) return;
    if (m.jql !== undefined && !jqlMatches[i]?.has(issue.key)) return;
    config = applyRulePatch(config, override.rules[ruleId], ruleId, `overrides[${i}].rules.${ruleId}`);
  });
  return config;
}

/** True when the rule can produce findings for some issue: on in the base, or named by an override. */
export function isRuleActive(rules: AuditRules, ruleId: string): boolean {
  return !isRuleOff(rules.rules[ruleId], ruleId) || rules.overrides.some((o) => ruleId in o.rules);
}

/** The highest severity this rule can reach anywhere (base or any override). */
export function maxRuleSeverity(rules: AuditRules, ruleId: string): AuditSeverity | undefined {
  const configs = [rules.rules[ruleId] ?? { level: "off" as const }];
  for (const [i, override] of rules.overrides.entries()) {
    if (ruleId in override.rules) configs.push(applyRulePatch(configs[0], override.rules[ruleId], ruleId, `overrides[${i}]`));
  }
  let max: AuditSeverity | undefined;
  for (const config of configs) {
    if (isRuleOff(config, ruleId)) continue;
    const levels = config.thresholds && Object.keys(config.thresholds).length ? (Object.keys(config.thresholds) as AuditSeverity[]) : [config.level as AuditSeverity];
    for (const level of levels) if (!max || AUDIT_SEVERITY_RANK[level] > AUDIT_SEVERITY_RANK[max]) max = level;
  }
  return max;
}

/**
 * The severity a measured value earns: the most severe threshold it passes.
 * Day thresholds are inclusive (`>= 30`); percentile thresholds are strict
 * (`> P85`), as a value equal to the percentile is not unusual.
 */
export function severityForValue(
  config: AuditRuleConfig,
  kind: AuditRuleKind,
  value: number,
  percentileValue: (p: number) => number | undefined
): { severity: AuditSeverity; threshold: AuditThreshold; limit: number } | undefined {
  for (const severity of [...SEVERITIES].reverse()) {
    const threshold = config.thresholds?.[severity];
    if (!threshold) continue;
    const limit = "days" in threshold ? threshold.days : percentileValue(threshold.percentile);
    if (limit === undefined) continue;
    const passed =
      kind === "until" ? value <= limit : "percentile" in threshold ? value > limit : value >= limit;
    if (passed) return { severity, threshold, limit };
  }
  return undefined;
}

/**
 * Resolve `--checks` entries (rule ids, categories, or the names before rule
 * ids: stuck-wip, unassigned-wip, stale, hygiene, workflow) to rule ids.
 */
export function resolveAuditChecks(value: string, customIds: string[] = []): Set<string> | string {
  const ids = new Set<string>();
  for (const part of value.split(",").map((p) => p.trim()).filter(Boolean)) {
    const matched = [
      ...JIRA_AUDIT_RULES.filter((r) => r.id === part || r.legacy === part || r.category === part).map((r) => r.id),
      ...customIds.filter((id) => id === part || part === "custom"),
    ];
    if (matched.length === 0) {
      return `Unknown check "${part}". Use a rule id (${JIRA_AUDIT_RULES.map((r) => r.id).join(", ")}), a category (workflow, flow, hygiene, custom) or a custom rule id.`;
    }
    for (const id of matched) ids.add(id);
  }
  return ids.size ? ids : "--checks is empty.";
}

/**
 * The rules for the digest's "Audit" section: only rules that can reach
 * `error`, without the expensive ones unless they set `digest: true`, and
 * only errors listed.
 */
export function digestAuditRules(rules: AuditRules): AuditRules {
  const keep = new Set(
    Object.keys(rules.rules).filter(
      (id) => maxRuleSeverity(rules, id) === "error" && (!RULES_BY_ID.get(id)?.expensive || rules.rules[id].digest === true)
    )
  );
  return { ...restrictAuditRules(rules, keep), minLevel: "error" };
}

/** Turn every rule outside `keep` off. */
export function restrictAuditRules(rules: AuditRules, keep: Set<string>): AuditRules {
  const next = { ...rules, rules: { ...rules.rules } };
  for (const id of Object.keys(next.rules)) if (!keep.has(id)) next.rules[id] = { level: "off" };
  return next;
}

/** The Flagged field: its JQL clause name `Flagged` is the same on every site and in every language. */
export function findFlaggedField(fields: JiraField[]): string | undefined {
  const candidates = fields.filter((f) => f.clauseNames?.some((c) => c.toLowerCase() === "flagged"));
  return (candidates.find((f) => f.schema?.custom?.endsWith(":multicheckboxes")) ?? candidates[0])?.id;
}

export function ruleTitle(id: string, custom: AuditCustomRule[] = []): string {
  return RULES_BY_ID.get(id)?.title ?? custom.find((c) => c.id === id)?.message ?? id;
}

export function ruleDef(id: string): AuditRuleDef | undefined {
  return RULES_BY_ID.get(id);
}
