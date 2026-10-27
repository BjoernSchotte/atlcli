/**
 * Audit rules are scripts: `export const meta = { audit: { … } }` plus a
 * function that judges one item (`scope: "item"`, the default) or the whole
 * data set (`scope: "run"`). Built-in rules ship as such scripts and run the
 * same way as a team's own. Rules run in the script sandbox, batch by batch,
 * read-only: a write verb ends the run (fixes go through `export async function fix`).
 */
import { inspectScript, planScript, ScriptError, type RunScriptOptions, type ScriptPort, type ScriptRunPlan } from "@atlcli/script-runtime";
import type { AuditProfileName, AuditRuleConfig, AuditRuleDef, AuditRuleKind, AuditSeverity, Patch } from "./config.js";
import type { AuditPrincipalRef, AuditTargetKind } from "./report.js";

type Variant = NonNullable<RunScriptOptions["variant"]>;

/** What an audit judges: Jira issues, wiki pages, or who can access what. */
export type AuditProduct = "jira" | "confluence" | "access";
const PRODUCTS: readonly AuditProduct[] = ["jira", "confluence", "access"];

const ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const KINDS: readonly AuditRuleKind[] = ["flag", "age", "until"];

/** `meta.audit` as a rule script declares it. */
export interface AuditMeta {
  id: string;
  product: AuditProduct;
  title: string;
  category: string;
  kind: AuditRuleKind;
  /** item (default): `default(item, rule)` per item; run: `default(data, rule)` once. */
  scope: "item" | "run";
  /** Which items the host passes (Jira: open, done, resolved-not-done; wiki: pages; access: resources, spaces, projects, pages, users). */
  items?: string;
  /** Extra fields the host loads for the items. */
  fields: string[];
  /** Host data the rule needs (Jira: changelog, done, sprint, versions, flow, flagged, points). */
  needs: string[];
  percentiles?: boolean;
  expensive?: boolean;
  legacy?: string;
  options?: Record<string, string[]>;
  /** Settings when no rules file says otherwise: the default profile's, or per profile. */
  defaults?: Patch;
  profiles?: Partial<Record<AuditProfileName, Patch>>;
}

export interface AuditRuleScript {
  meta: AuditMeta;
  def: AuditRuleDef;
  /** Script source as written (for --print-rule). */
  source: string;
  /** Type-stripped JavaScript. */
  js: string;
  /** Type-stripped files the rule imports, by path relative to it. */
  modules?: Record<string, string>;
  /** Where it came from: `built-in`, a file path, … */
  origin: string;
  hasFix: boolean;
  hasReport: boolean;
}

export class AuditScriptError extends Error {}

const list = (v: unknown, path: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new AuditScriptError(`${path}: expected a list of strings`);
  return v as string[];
};

/** Validates `meta.audit` of a rule script. */
export function parseAuditMeta(raw: unknown, origin: string): AuditMeta {
  const at = (key: string) => `${origin}: meta.audit.${key}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AuditScriptError(`${origin}: an audit rule needs export const meta = { audit: { id, product, … } }`);
  const a = raw as Record<string, unknown>;
  const known = new Set(["id", "product", "title", "category", "kind", "scope", "items", "fields", "needs", "percentiles", "expensive", "legacy", "options", "defaults", "profiles", "description"]);
  for (const key of Object.keys(a)) if (!known.has(key)) throw new AuditScriptError(`${at(key)}: unknown key`);
  if (typeof a.id !== "string" || !ID.test(a.id)) throw new AuditScriptError(`${at("id")}: expected "<group>/<name>" in lower case, e.g. team/done-without-component`);
  if (!PRODUCTS.includes(a.product as AuditProduct)) throw new AuditScriptError(`${at("product")}: expected ${PRODUCTS.join(", ")}`);
  const kind = (a.kind ?? "flag") as AuditRuleKind;
  if (!KINDS.includes(kind)) throw new AuditScriptError(`${at("kind")}: expected flag, age or until`);
  const scope = a.scope ?? "item";
  if (scope !== "item" && scope !== "run") throw new AuditScriptError(`${at("scope")}: expected item or run`);
  const options: Record<string, string[]> = {};
  if (a.options !== undefined) {
    if (!a.options || typeof a.options !== "object") throw new AuditScriptError(`${at("options")}: expected { name: [allowed values] }`);
    for (const [k, v] of Object.entries(a.options)) options[k] = list(v, at(`options.${k}`));
  }
  const profiles = a.profiles as AuditMeta["profiles"];
  if (profiles !== undefined && (typeof profiles !== "object" || Object.keys(profiles).some((p) => !["minimal", "default", "strict"].includes(p)))) {
    throw new AuditScriptError(`${at("profiles")}: expected { minimal?, default?, strict? }`);
  }
  return {
    id: a.id,
    product: a.product as AuditProduct,
    title: typeof a.title === "string" ? a.title : a.id,
    category: typeof a.category === "string" ? a.category : a.id.split("/")[0]!,
    kind,
    scope,
    ...(typeof a.items === "string" ? { items: a.items } : {}),
    fields: list(a.fields, at("fields")),
    needs: list(a.needs, at("needs")),
    ...(a.percentiles === true ? { percentiles: true } : {}),
    ...(a.expensive === true ? { expensive: true } : {}),
    ...(typeof a.legacy === "string" ? { legacy: a.legacy } : {}),
    ...(Object.keys(options).length ? { options } : {}),
    ...(a.defaults !== undefined ? { defaults: a.defaults as Patch } : {}),
    ...(profiles ? { profiles } : {}),
  };
}

/**
 * The registry entry of a rule: its own profiles, or `defaults` for every
 * profile. A flag rule that names neither is a warning everywhere.
 */
export function ruleDefOf(meta: AuditMeta): AuditRuleDef {
  const defaults = meta.defaults ?? (meta.profiles === undefined && meta.kind === "flag" ? "warning" : undefined);
  const profiles: Partial<Record<AuditProfileName, Patch>> = defaults !== undefined ? { minimal: defaults, default: defaults, strict: defaults } : {};
  return {
    id: meta.id,
    category: meta.category,
    kind: meta.kind,
    title: meta.title,
    ...(meta.percentiles ? { percentiles: true } : {}),
    ...(meta.expensive ? { expensive: true } : {}),
    ...(meta.legacy ? { legacy: meta.legacy } : {}),
    ...(meta.options ? { options: meta.options } : {}),
    profiles: { ...profiles, ...meta.profiles },
  };
}

const FIX_EXPORT = /\bexport\s+(?:async\s+)?function\s+fix\b|\bexport\s+const\s+fix\b/;
const REPORT_EXPORT = /\bexport\s+(?:async\s+)?function\s+report\b|\bexport\s+const\s+report\b/;

/** Loads a rule script: meta first (no rule code runs), then which exports it has. */
export async function loadAuditRule(
  source: string,
  origin: string,
  transpile: (src: string) => string,
  variant?: Variant,
  modules?: Record<string, string>,
): Promise<AuditRuleScript> {
  const js = transpile(source);
  let meta;
  try {
    meta = await inspectScript(js, variant ? { variant } : {});
  } catch (error) {
    throw new AuditScriptError(`${origin}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const audit = parseAuditMeta((meta as { audit?: unknown }).audit, origin);
  return {
    meta: audit,
    def: ruleDefOf(audit),
    source,
    js,
    ...(modules && Object.keys(modules).length ? { modules } : {}),
    origin,
    hasFix: FIX_EXPORT.test(js),
    hasReport: REPORT_EXPORT.test(js),
  };
}

/**
 * Guest helpers: the `rule` object every call gets (`rule.config`,
 * `rule.facts`, `rule.now`, `rule.severity(value)`, `rule.finding({…})`).
 * `rule.severity` returns `{ severity, threshold, limit }` for the most severe
 * threshold the value passes, or undefined.
 * Threshold logic mirrors `severityForValue` in config.ts.
 */
const PRELUDE = `(() => {
  const SEV = ["error", "warning", "info"];
  const severityFor = (config, kind, value, pct) => {
    for (const s of SEV) {
      const t = config && config.thresholds && config.thresholds[s];
      if (!t) continue;
      const limit = "days" in t ? t.days : pct(t.percentile);
      if (limit === undefined || limit === null) continue;
      const passed = kind === "until" ? value <= limit : "percentile" in t ? value > limit : value >= limit;
      if (passed) return { severity: s, threshold: t, limit };
    }
    return undefined;
  };
  globalThis.__atlcliArgs = (it) => {
    const facts = it.facts || {};
    const rule = Object.freeze({
      id: it.rule.id,
      kind: it.rule.kind,
      config: it.config,
      facts,
      now: it.now,
      severity: (value, config) => severityFor(config || it.config, it.rule.kind, value, (p) => (facts.percentiles ? facts.percentiles[p] : undefined)),
      finding: (f) => Object.assign({}, f, { __atlcliFinding: true }),
    });
    return [it.item, rule];
  };
})();`;

/** What a rule returned for one item, as the host reads it. */
export interface RuleHit {
  severity?: AuditSeverity;
  detail: string;
  ageDays?: number;
  /** Overrides for run-scope rules and status-level findings. */
  key?: string;
  summary?: string;
  status?: string;
  assignee?: string;
  subject?: string;
  updated?: string;
  /** Run-scope rules: what the finding is about, when not an item. */
  target?: { kind: AuditTargetKind; key: string; url?: string };
  /** Access rules: the user, group or class the finding is about (fixes read it). */
  principal?: AuditPrincipalRef;
}

export interface RuleEntry {
  item: unknown;
  config: AuditRuleConfig;
  facts?: Record<string, unknown>;
}

export interface RunRuleOptions {
  port: ScriptPort;
  now: Date;
  variant?: Variant;
  /** Items per sandbox run (default 200). */
  batch?: number;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
}

const READ_ONLY = "audit rules only read; propose a change with export async function fix(finding, item) instead";
/** Rules find; files are written by the report (`export async function report(model, out)`). */
export const NO_OUTPUT = "audit rules write no files; write files in export async function report(model, out)";

/** Runs an item rule over entries: one sandbox run per batch. Returns the hits per entry index. */
export async function runItemRule(rule: AuditRuleScript, entries: RuleEntry[], options: RunRuleOptions): Promise<Array<{ index: number; hits: RuleHit[] }>> {
  const size = options.batch ?? 200;
  const out: Array<{ index: number; hits: RuleHit[] }> = [];
  for (let start = 0; start < entries.length; start += size) {
    const batch = entries.slice(start, start + size);
    const run = await guard(rule, () =>
      planScript(rule.js, {
        ...(rule.modules ? { modules: rule.modules } : {}),
        port: options.port,
        items: batch.map((e) => ({ item: e.item, config: e.config, facts: e.facts ?? {}, now: options.now.getTime(), rule: { id: rule.meta.id, kind: rule.meta.kind } })),
        prelude: PRELUDE,
        readOnly: READ_ONLY,
        noOutput: NO_OUTPUT,
        limits: { deadlineMs: 60_000 + batch.length * 1_000, maxHostCalls: 100 + batch.length * 50 },
        ...(options.variant ? { variant: options.variant } : {}),
        ...(options.onLog ? { onLog: options.onLog } : {}),
      }),
    );
    (run.value as unknown[]).forEach((value, i) => {
      const hits = toHits(value, rule);
      if (hits.length) out.push({ index: start + i, hits });
    });
  }
  return out;
}

/** Runs a run-scope rule once over all entries. */
export async function runDataRule(rule: AuditRuleScript, data: unknown, config: AuditRuleConfig, options: RunRuleOptions): Promise<RuleHit[]> {
  const run = await guard(rule, () =>
    planScript(rule.js, {
      port: options.port,
      items: [{ item: data, config, facts: {}, now: options.now.getTime(), rule: { id: rule.meta.id, kind: rule.meta.kind } }],
      prelude: PRELUDE,
      readOnly: READ_ONLY,
      noOutput: NO_OUTPUT,
      limits: { deadlineMs: 10 * 60_000 },
      ...(options.variant ? { variant: options.variant } : {}),
      ...(options.onLog ? { onLog: options.onLog } : {}),
    }),
  );
  return toHits((run.value as unknown[])[0], rule);
}

async function guard(rule: AuditRuleScript, fn: () => Promise<ScriptRunPlan>): Promise<ScriptRunPlan> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ScriptError) throw new AuditScriptError(`Audit rule ${rule.meta.id} (${rule.origin}) failed (${error.kind}): ${error.message}`);
    throw error;
  }
}

function toHits(value: unknown, rule: AuditRuleScript): RuleHit[] {
  if (value === null || value === undefined || value === false) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((v) => {
    if (!v || typeof v !== "object" || typeof (v as { detail?: unknown }).detail !== "string") {
      throw new AuditScriptError(`Audit rule ${rule.meta.id} returned ${JSON.stringify(v)}; return rule.finding({ detail }) or nothing`);
    }
    const { __atlcliFinding: _, ...hit } = v as RuleHit & { __atlcliFinding?: boolean };
    return hit;
  });
}
