/**
 * Audit rule configuration (spec jira-audit-rules, generalized for scripted
 * rules): profiles, validation of a rules file (already parsed from YAML),
 * overrides and threshold evaluation. The rules themselves come from a
 * registry, built from the `meta.audit` of the loaded rule scripts. Pure.
 */

export type AuditSeverity = "info" | "warning" | "error";
export type AuditLevel = "off" | AuditSeverity;
/** Built-in categories are workflow, flow, hygiene (Jira) and content, links, people, structure (wiki); scripts may add their own. */
export type AuditCategory = string;
export type AuditProfileName = "minimal" | "default" | "strict";

/**
 * `flag`: present or not, one severity. `age`: a value in days that grows
 * (higher is worse). `until`: days left until a date (lower is worse).
 */
export type AuditRuleKind = "flag" | "age" | "until";

export interface AuditRuleDef {
  id: string;
  category: AuditCategory;
  kind: AuditRuleKind;
  title: string;
  /** Thresholds may be percentiles (`p85`) of a reference set the host provides. */
  percentiles?: boolean;
  /** Needs data that is slow to fetch; skipped in the digest unless `digest: true`. */
  expensive?: boolean;
  /** Name in `--checks` before rule ids existed. */
  legacy?: string;
  /** List options a patch may set, with their allowed values, e.g. `include: [todo, wip]`; an empty list allows any text. */
  options?: Record<string, readonly string[]>;
  /** Settings per built-in profile (patch grammar); a profile without an entry leaves the rule off. */
  profiles?: Partial<Record<AuditProfileName, Patch>>;
}

/** The rules a run knows, in report order. */
export class AuditRegistry {
  private readonly byId: Map<string, AuditRuleDef>;
  constructor(readonly defs: readonly AuditRuleDef[]) {
    this.byId = new Map(defs.map((d) => [d.id, d]));
  }
  get(id: string): AuditRuleDef | undefined {
    return this.byId.get(id);
  }
  has(id: string): boolean {
    return this.byId.has(id);
  }
  ids(): string[] {
    return this.defs.map((d) => d.id);
  }
}

const SEVERITIES: readonly AuditSeverity[] = ["info", "warning", "error"];
const LEVELS: readonly AuditLevel[] = ["off", ...SEVERITIES];
export const AUDIT_SEVERITY_RANK: Record<AuditSeverity, number> = { info: 0, warning: 1, error: 2 };

export type AuditThreshold = { days: number } | { percentile: number };

/** One rule's effective settings. */
export interface AuditRuleConfig {
  /** Flag rules: the severity, or off. Threshold rules: `off` or undefined. */
  level?: AuditLevel;
  thresholds?: Partial<Record<AuditSeverity, AuditThreshold>>;
  /** Rule options declared in `meta.audit.options`, e.g. `include` of `hygiene/stale`. */
  options?: Record<string, string[]>;
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
  /** Rule scripts named in the file (`scripts: [...]`), relative to it. */
  scripts: string[];
  /** Where the rules came from, for the report. */
  source: string;
}

export class AuditRulesError extends Error {}

export type Patch = string | Record<string, unknown>;

/** Profile-wide settings; the per-rule settings live with each rule (`meta.audit.profiles`). */
const PROFILES: Record<AuditProfileName, { minLevel: AuditSeverity; legacyDays: number | null }> = {
  minimal: { minLevel: "warning", legacyDays: 180 },
  default: { minLevel: "warning", legacyDays: 180 },
  strict: { minLevel: "info", legacyDays: null },
};

export const AUDIT_PROFILES = Object.keys(PROFILES) as AuditProfileName[];

/** `30d`, `2w`, `30` (days) or, where allowed, `p85`. */
function parseThreshold(value: unknown, def: AuditRuleDef | undefined, path: string, registry?: AuditRegistry): AuditThreshold {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return { days: value };
  if (typeof value === "string") {
    const days = /^(\d+(?:\.\d+)?)\s*([dw]?)$/i.exec(value.trim());
    if (days) return { days: Number(days[1]) * (days[2].toLowerCase() === "w" ? 7 : 1) };
    const pct = /^p(\d{1,2})$/i.exec(value.trim());
    if (pct && def?.percentiles) return { percentile: Number(pct[1]) };
    if (pct) throw new AuditRulesError(`${path}: percentiles are only allowed for ${(registry?.defs ?? []).filter((r) => r.percentiles).map((r) => r.id).join(", ") || "rules that declare them"}.`);
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
export function applyRulePatch(current: AuditRuleConfig, patch: unknown, ruleId: string, path: string, registry: AuditRegistry): AuditRuleConfig {
  const def = registry.get(ruleId);
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
      else next.thresholds![key as AuditSeverity] = parseThreshold(value, def, at, registry);
      if (next.level === "off") next.level = undefined;
    } else if (key === "severity") {
      if (!isLevel(value)) throw new AuditRulesError(`${at}: expected off, info, warning or error.`);
      if (kind !== "flag" && value !== "off") throw new AuditRulesError(`${at}: ${ruleId} takes thresholds, e.g. { warning: 30d }.`);
      next.level = value;
    } else if (def?.options && key in def.options) {
      const allowed = def.options[key]!;
      const list = Array.isArray(value) ? value : [value];
      if (list.length === 0 || list.some((v) => typeof v !== "string" || (allowed.length > 0 && !allowed.includes(v)))) {
        throw new AuditRulesError(`${at}: expected ${allowed.length ? `a list of ${allowed.join(" and ")}` : "text or a list of texts"}.`);
      }
      next.options = { ...next.options, [key]: list as string[] };
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
export function isRuleOff(config: AuditRuleConfig | undefined, ruleId: string, registry: AuditRegistry): boolean {
  if (!config || config.level === "off") return true;
  const kind = registry.get(ruleId)?.kind ?? "flag";
  if (kind === "flag") return config.level === undefined;
  return !config.thresholds || Object.keys(config.thresholds).length === 0;
}

function profileRules(name: AuditProfileName, registry: AuditRegistry): Record<string, AuditRuleConfig> {
  const rules: Record<string, AuditRuleConfig> = {};
  for (const def of registry.defs) {
    const patch = def.profiles?.[name];
    rules[def.id] = patch === undefined ? { level: "off" } : applyRulePatch({}, patch, def.id, `${def.id} profile ${name}`, registry);
  }
  return rules;
}

/** The rules of a built-in profile, before any file. */
export function defaultAuditRules(registry: AuditRegistry, profile: AuditProfileName = "default", source = `built-in profile ${profile}`): AuditRules {
  return {
    extends: profile,
    minLevel: PROFILES[profile].minLevel,
    legacyDays: PROFILES[profile].legacyDays,
    rules: profileRules(profile, registry),
    custom: [],
    overrides: [],
    scripts: [],
    source,
  };
}

const CUSTOM_ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const TOP_LEVEL = new Set(["version", "extends", "minLevel", "rules", "custom", "overrides", "baseline", "flagged", "scripts", "confluence"]);
const CONFLUENCE_KEYS = new Set(["extends", "minLevel", "rules", "scripts"]);

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
export function parseAuditRules(raw: unknown, source: string, registry: AuditRegistry): AuditRules {
  if (raw === null || raw === undefined) return defaultAuditRules(registry, "default", source);
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
  const rules = defaultAuditRules(registry, profile as AuditProfileName, source);

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
    if (registry.has(c.id) || rules.custom.some((r) => r.id === c.id)) throw new AuditRulesError(`${path}.id: "${c.id}" is already a rule.`);
    if (typeof c.jql !== "string" || !c.jql.trim()) throw new AuditRulesError(`${path}.jql: expected a JQL query.`);
    if (/\border\s+by\b/i.test(c.jql)) throw new AuditRulesError(`${path}.jql: leave out ORDER BY; the scope is ANDed in.`);
    const severity = c.severity ?? "warning";
    if (!isLevel(severity)) throw new AuditRulesError(`${path}.severity: expected off, info, warning or error.`);
    rules.custom.push({ id: c.id, jql: c.jql.trim(), message: typeof c.message === "string" ? c.message : c.id });
    rules.rules[c.id] = { level: severity };
  });

  const known = (id: string) => registry.has(id) || rules.custom.some((c) => c.id === id);
  const ruleMap = (value: unknown, path: string): Record<string, unknown> => {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuditRulesError(`${path}: expected a mapping of rule ids.`);
    for (const id of Object.keys(value)) {
      if (!known(id)) throw new AuditRulesError(`${path}: unknown rule "${id}". Rules: ${registry.ids().join(", ")}.`);
    }
    return value as Record<string, unknown>;
  };

  for (const [id, patch] of Object.entries(ruleMap(file.rules, "rules"))) {
    rules.rules[id] = applyRulePatch(rules.rules[id] ?? {}, patch, id, `rules.${id}`, registry);
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
    for (const [id, patch] of Object.entries(patches)) applyRulePatch(rules.rules[id] ?? {}, patch, id, `${path}.rules.${id}`, registry);
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

  if (file.scripts !== undefined) rules.scripts = stringList(file.scripts, "scripts");
  return rules;
}

/**
 * The rules for `audit wiki`: the file's `confluence:` section (extends,
 * minLevel, rules, scripts), resolved like the top level. Pages have no
 * legacy cutoff: a stale page is by definition not updated.
 */
export function parseConfluenceAuditRules(raw: unknown, source: string, registry: AuditRegistry): AuditRules {
  const section = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).confluence : undefined;
  if (section !== undefined && section !== null) {
    if (typeof section !== "object" || Array.isArray(section)) throw new AuditRulesError(`${source}: confluence: expected a mapping.`);
    for (const key of Object.keys(section)) {
      if (!CONFLUENCE_KEYS.has(key)) throw new AuditRulesError(`${source}: confluence: unknown key "${key}". Use ${[...CONFLUENCE_KEYS].join(", ")}.`);
    }
  }
  try {
    return { ...parseAuditRules(section ?? null, source, registry), legacyDays: null };
  } catch (err) {
    if (err instanceof AuditRulesError && !err.message.startsWith(source)) throw new AuditRulesError(`confluence.${err.message}`);
    throw err;
  }
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
  registry: AuditRegistry,
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
    config = applyRulePatch(config, override.rules[ruleId], ruleId, `overrides[${i}].rules.${ruleId}`, registry);
  });
  return config;
}

/** True when the rule can produce findings for some issue: on in the base, or named by an override. */
export function isRuleActive(rules: AuditRules, ruleId: string, registry: AuditRegistry): boolean {
  return !isRuleOff(rules.rules[ruleId], ruleId, registry) || rules.overrides.some((o) => ruleId in o.rules);
}

/** The highest severity this rule can reach anywhere (base or any override). */
export function maxRuleSeverity(rules: AuditRules, ruleId: string, registry: AuditRegistry): AuditSeverity | undefined {
  const configs = [rules.rules[ruleId] ?? { level: "off" as const }];
  for (const [i, override] of rules.overrides.entries()) {
    if (ruleId in override.rules) configs.push(applyRulePatch(configs[0]!, override.rules[ruleId], ruleId, `overrides[${i}]`, registry));
  }
  let max: AuditSeverity | undefined;
  for (const config of configs) {
    if (isRuleOff(config, ruleId, registry)) continue;
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
export function resolveAuditChecks(value: string, registry: AuditRegistry, customIds: string[] = []): Set<string> | string {
  const ids = new Set<string>();
  const categories = [...new Set(registry.defs.map((r) => r.category))];
  for (const part of value.split(",").map((p) => p.trim()).filter(Boolean)) {
    const matched = [
      ...registry.defs.filter((r) => r.id === part || r.legacy === part || r.category === part).map((r) => r.id),
      ...customIds.filter((id) => id === part || part === "custom"),
    ];
    if (matched.length === 0) {
      return `Unknown check "${part}". Use a rule id (${registry.ids().join(", ")}), a category (${[...categories, "custom"].join(", ")}) or a custom rule id.`;
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
export function digestAuditRules(rules: AuditRules, registry: AuditRegistry): AuditRules {
  const keep = new Set(
    Object.keys(rules.rules).filter(
      (id) => maxRuleSeverity(rules, id, registry) === "error" && (!registry.get(id)?.expensive || rules.rules[id]!.digest === true)
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

export function ruleTitle(id: string, registry: AuditRegistry, custom: AuditCustomRule[] = []): string {
  return registry.get(id)?.title ?? custom.find((c) => c.id === id)?.message ?? id;
}
