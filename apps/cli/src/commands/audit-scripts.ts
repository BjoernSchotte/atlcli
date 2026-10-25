/**
 * Audit rule scripts in the CLI: the built-ins, a team's own rules (found in
 * `~/.atlcli/audit/`, `./.atlcli/audit/`, the rules file's `scripts:` and
 * `--script`), planned fixes (`--fix`) and reports (`--report`, `--template`,
 * a rule's `export function report`). Shared by `audit jira` and `audit wiki`.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  AuditRegistry,
  type AuditFinding,
  type AuditReportV3,
  type AuditRuleScript,
  AuditScriptError,
  DEFAULT_MARKDOWN_TEMPLATE,
  loadAuditRule,
  markdownModel,
} from "@atlcli/audit";
import { ERROR_CODES, fail, getFlag, getFlags, hasFlag, initJinja, output, type OutputOptions, type Profile } from "@atlcli/core";
import { renderJinja } from "@atlcli/jinja";
import type { PlannedOperation, RunScriptOptions, ScriptPort, ScriptRunPlan } from "@atlcli/script-runtime";
import { BUILTIN_CONFLUENCE_AUDIT_RULES, BUILTIN_JIRA_AUDIT_RULES } from "../builtin-scripts/audit/index.js";

type Variant = RunScriptOptions["variant"];
type Flags = Record<string, string | boolean | string[]>;
export type AuditProduct = "jira" | "confluence";

const transpile = (source: string) => new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(source);
const runtime = () => import("@atlcli/script-runtime");

/** The built-in rules of a product, loaded (meta read, nothing run). */
export async function loadBuiltinAuditRules(product: AuditProduct, variant?: Variant): Promise<AuditRuleScript[]> {
  const sources = product === "jira" ? BUILTIN_JIRA_AUDIT_RULES : BUILTIN_CONFLUENCE_AUDIT_RULES;
  return Promise.all(sources.map((source) => loadAuditRule(source, "built-in", transpile, variant)));
}

/** A registry over rule scripts, in their order. */
export function registryOf(scripts: AuditRuleScript[]): AuditRegistry {
  return new AuditRegistry(scripts.map((s) => s.def));
}

/** Directories searched for rule scripts, in order: user-wide, then the project. */
export function auditScriptDirs(cwd: string | null = process.cwd()): string[] {
  return [join(homedir(), ".atlcli", "audit"), ...(cwd === null ? [] : [join(cwd, ".atlcli", "audit")])];
}

async function scriptsIn(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith(".d.ts")).sort().map((f) => join(dir, f));
}

/**
 * The rules of a product: built-ins, then scripts from the audit directories,
 * the rules file and `--script`. A script with the id of an earlier rule
 * replaces it in place (so the report order stays). Scripts for the other
 * product are skipped, except ones named with `--script`.
 */
export async function loadAuditScripts(
  product: AuditProduct,
  options: { cwd?: string | null; fileScripts?: { base: string; paths: string[] }; extra?: string[]; variant?: Variant },
): Promise<{ scripts: AuditRuleScript[]; diagnostics: string[] }> {
  const scripts = await loadBuiltinAuditRules(product, options.variant);
  const diagnostics: string[] = [];
  const sources: Array<{ path: string; explicit: boolean }> = [];
  for (const dir of auditScriptDirs(options.cwd === undefined ? process.cwd() : options.cwd)) {
    for (const path of await scriptsIn(dir)) sources.push({ path, explicit: false });
  }
  for (const p of options.fileScripts?.paths ?? []) sources.push({ path: resolve(options.fileScripts!.base, p), explicit: false });
  for (const p of options.extra ?? []) sources.push({ path: resolve(p), explicit: true });

  const seen = new Set<string>();
  for (const { path, explicit } of sources) {
    if (seen.has(path)) continue;
    seen.add(path);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      throw new AuditScriptError(`Cannot read the audit rule ${path}`);
    }
    const rule = await loadAuditRule(text, path, transpile, options.variant);
    if (rule.meta.product !== product) {
      if (explicit) throw new AuditScriptError(`${path} is a ${rule.meta.product} rule; use it with atlcli audit ${rule.meta.product === "jira" ? "jira" : "wiki"}`);
      continue;
    }
    const at = scripts.findIndex((s) => s.meta.id === rule.meta.id);
    if (at >= 0) {
      diagnostics.push(`${rule.meta.id} from ${path} replaces the ${scripts[at]!.origin === "built-in" ? "built-in rule" : `rule from ${scripts[at]!.origin}`}.`);
      scripts[at] = rule;
    } else {
      scripts.push(rule);
    }
  }
  return { scripts, diagnostics };
}

/** `--print-rule <id>` and `--list-rules`; true when one of them was handled. */
export function handleRuleListing(scripts: AuditRuleScript[], flags: Flags, opts: OutputOptions): boolean {
  const printRule = getFlag(flags, "print-rule");
  if (printRule !== undefined) {
    const rule = scripts.find((s) => s.meta.id === printRule);
    if (!rule) fail(opts, 1, ERROR_CODES.USAGE, `No rule "${printRule}". Rules: ${scripts.map((s) => s.meta.id).join(", ")}`);
    process.stdout.write(rule.source.endsWith("\n") ? rule.source : `${rule.source}\n`);
    return true;
  }
  if (hasFlag(flags, "print-template")) {
    process.stdout.write(DEFAULT_MARKDOWN_TEMPLATE);
    return true;
  }
  if (hasFlag(flags, "list-rules")) {
    const rows = scripts.map((s) => ({
      id: s.meta.id,
      title: s.meta.title,
      kind: s.meta.kind,
      origin: s.origin,
      fix: s.hasFix,
      report: s.hasReport,
      profiles: s.def.profiles ?? {},
    }));
    if (opts.json) output({ schemaVersion: "1", rules: rows }, opts);
    else {
      const width = Math.max(...rows.map((r) => r.id.length));
      output(rows.map((r) => `${r.id.padEnd(width)}  ${r.title}${r.fix ? " [fix]" : ""}${r.report ? " [report]" : ""}${r.origin === "built-in" ? "" : `  (${r.origin})`}`).join("\n"), opts);
    }
    return true;
  }
  return false;
}

/**
 * Plans the fixes for the listed findings: each rule's `fix(finding, item)`
 * runs once per finding of that rule (all in one sandbox run per rule), and
 * the plans are merged into one. Writes are planned, never executed here.
 */
export async function planAuditFixes(
  findings: AuditFinding[],
  scripts: AuditRuleScript[],
  itemFor: (finding: AuditFinding) => unknown,
  port: ScriptPort,
  onLog?: (level: "info" | "warn" | "error", message: string) => void,
): Promise<ScriptRunPlan> {
  const rt = await runtime();
  const runs: ScriptRunPlan[] = [];
  for (const script of scripts) {
    if (!script.hasFix) continue;
    const mine = findings.filter((f) => f.rule === script.meta.id);
    if (!mine.length) continue;
    runs.push(
      await rt.planScript(script.js, {
        port,
        items: mine.map((finding) => ({ finding, item: itemFor(finding) ?? null })),
        entry: "fix",
        prelude: "globalThis.__atlcliArgs = (it) => [it.finding, it.item];",
        limits: { deadlineMs: 60_000 + mine.length * 2_000, maxHostCalls: 1_000 + mine.length * 50 },
        maxWrites: Math.max(100, mine.length * 20),
        ...(onLog ? { onLog } : {}),
      }),
    );
  }
  return mergeRunPlans(runs);
}

/** One plan from several: sequence numbers and `plan:<n>` references are shifted per part. */
export function mergeRunPlans(runs: ScriptRunPlan[]): ScriptRunPlan {
  const operations: PlannedOperation[] = [];
  const shift = (value: unknown, by: number): unknown => {
    if (typeof value === "string") return value.replace(/\bplan:(\d+)\b/g, (_, n) => `plan:${Number(n) + by}`);
    if (Array.isArray(value)) return value.map((v) => shift(v, by));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shift(v, by)]));
    return value;
  };
  for (const run of runs) {
    const by = operations.length;
    for (const op of run.operations) {
      operations.push({ ...op, seq: op.seq + by, args: shift(op.args, by) as Record<string, unknown>, dependsOn: op.dependsOn.map((d) => d + by) });
    }
  }
  return {
    meta: { name: "audit-fix", description: "Fixes proposed by audit rules" },
    params: {},
    value: null,
    operations,
    skipped: runs.flatMap((r) => r.skipped),
    hostCalls: runs.reduce((n, r) => n + r.hostCalls, 0),
    renderWarnings: runs.flatMap((r) => r.renderWarnings),
  };
}

/** `--fix`: plans the listed findings' fixes and prints or applies the plan like `atlcli script run`. */
export async function runAuditFixes(
  report: AuditReportV3,
  scripts: AuditRuleScript[],
  itemFor: (finding: AuditFinding) => unknown,
  ctx: { profile: Profile; port: ScriptPort },
  flags: Flags,
  opts: OutputOptions,
): Promise<void> {
  const fixable = report.findings.filter((f) => f.fixable);
  if (fixable.length === 0) {
    output(opts.json ? { schemaVersion: "1", fixes: 0 } : "No listed finding has a fix (a rule proposes one with export async function fix(finding, item)).", opts);
    return;
  }
  const run = await planAuditFixes(fixable, scripts, itemFor, ctx.port, (level, message) =>
    process.stderr.write(`${level === "info" ? "" : `${level}: `}${message}\n`),
  );
  const rt = await runtime();
  const plan = await rt.createScriptPlan(run, {
    source: scripts.filter((s) => s.hasFix).map((s) => s.source).join("\n"),
    name: `audit-${report.product}-fix`,
    baseUrl: ctx.profile.baseUrl,
    profile: ctx.profile.name,
  });
  const { outputOrApplyPlan } = await import("./script.js");
  await outputOrApplyPlan(plan, ctx, flags, opts);
}

/**
 * A custom report, when one is asked for: `--template <file>` (Jinja over the
 * report, other templates in its directory can be included), else a rule's
 * `export function report(model)` (`--report-script <id>`, or the last rule
 * that has one), else the default Markdown template with `--markdown`.
 * Returns undefined when the normal output applies.
 */
export async function customAuditReport(
  report: AuditReportV3,
  scripts: AuditRuleScript[],
  port: ScriptPort,
  flags: Flags,
  opts: OutputOptions,
): Promise<string | undefined> {
  const templatePath = getFlag(flags, "template");
  const reportScript = getFlag(flags, "report-script");
  const model = markdownModel(report);
  if (templatePath) {
    await initJinja();
    const path = resolve(templatePath);
    const templates: Record<string, string> = {};
    for (const f of await readdir(dirname(path))) {
      if (/\.(j2|jinja|md|txt|html)$/.test(f)) templates[f] = await readFile(join(dirname(path), f), "utf8");
    }
    const { text, warnings } = renderJinja(templates[basename(path)] ?? (await readFile(path, "utf8")), model, { templates, lines: true, tolerant: false });
    const error = warnings.find((w) => w.code === "parse-error" || w.code === "render-error");
    if (error) fail(opts, 1, ERROR_CODES.VALIDATION, `${templatePath}: ${error.message}`);
    return text;
  }
  const withReport = scripts.filter((s) => s.hasReport);
  const chosen = reportScript !== undefined ? withReport.find((s) => s.meta.id === reportScript) : withReport.at(-1);
  if (reportScript !== undefined && !chosen) {
    fail(opts, 1, ERROR_CODES.USAGE, `No rule "${reportScript}" with export function report. Rules with one: ${withReport.map((s) => s.meta.id).join(", ") || "none"}`);
  }
  if (chosen && (reportScript !== undefined || getFlag(flags, "report") !== undefined || hasFlag(flags, "markdown"))) {
    const rt = await runtime();
    const run = await rt.planScript(chosen.js, {
      port,
      item: model,
      entry: "report",
      prelude: "globalThis.__atlcliArgs = (model) => [model];",
      readOnly: "a report only reads",
      limits: { deadlineMs: 5 * 60_000 },
    });
    if (typeof run.value !== "string") fail(opts, 1, ERROR_CODES.VALIDATION, `${chosen.meta.id}: export function report must return the report text (got ${typeof run.value})`);
    return run.value;
  }
  if (hasFlag(flags, "markdown") || getFlag(flags, "report") !== undefined) {
    await initJinja();
    return renderJinja(DEFAULT_MARKDOWN_TEMPLATE, model, { lines: true }).text;
  }
  return undefined;
}

/** Writes a custom report to `--report <file>` (saying so on stderr), or prints it. */
export async function emitAuditReport(text: string, flags: Flags, opts: OutputOptions): Promise<void> {
  const file = getFlag(flags, "report");
  if (file) {
    await writeFile(file, text.endsWith("\n") ? text : `${text}\n`, "utf8");
    if (!opts.json) process.stderr.write(`Report written to ${file}\n`);
    return;
  }
  output(text, opts);
}

/** `--script <file>` values. */
export const scriptFlags = (flags: Flags) => getFlags(flags, "script");
