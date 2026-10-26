/**
 * Audit rule scripts in the CLI: the built-ins, a team's own rules (found in
 * `~/.atlcli/audit/`, `./.atlcli/audit/`, the rules file's `scripts:` and
 * `--script`), planned fixes (`--fix`) and reports (`--report`, `--template`,
 * a rule's `export function report`). Shared by `audit jira` and `audit wiki`.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  AuditRegistry,
  type AuditFinding,
  type AuditReportV3,
  type AuditRuleConfig,
  type AuditRuleScript,
  AuditScriptError,
  DEFAULT_MARKDOWN_TEMPLATE,
  loadAuditRule,
  markdownModel,
  NO_OUTPUT,
  writeReportCsv,
  writeReportJson,
  writeReportJsonl,
} from "@atlcli/audit";
import { ERROR_CODES, fail, getFlag, getFlags, hasFlag, initJinja, output, type OutputOptions, type Profile } from "@atlcli/core";
import { JinjaError, streamJinja } from "@atlcli/jinja";
import type { PlannedOperation, RunScriptOptions, ScriptPort, ScriptRunPlan } from "@atlcli/script-runtime";
import { AtomicFile, formatSize, singleOutputPort } from "./output-files.js";
import { BUILTIN_CONFLUENCE_AUDIT_RULES, BUILTIN_JIRA_AUDIT_RULES } from "../builtin-scripts/audit/index.js";

type Variant = RunScriptOptions["variant"];
type Flags = Record<string, string | boolean | string[]>;
export type AuditProduct = "jira" | "confluence";

const transpile = (source: string) => new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(source);
const runtime = () => import("@atlcli/script-runtime");

/** A rule's relative imports, type-stripped; problems become an AuditScriptError. */
async function readRuleImports(path: string, source: string): Promise<Record<string, string>> {
  const { readImports } = await import("./script.js");
  try {
    const modules = await readImports(path, source);
    return Object.fromEntries(Object.entries(modules).map(([p, src]) => [p, transpile(src)]));
  } catch (error) {
    throw new AuditScriptError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

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
    const modules = await readRuleImports(path, text);
    const rule = await loadAuditRule(text, path, transpile, options.variant, modules);
    if (rule.meta.product !== product) {
      if (explicit) throw new AuditScriptError(`${path} is a ${rule.meta.product} rule; use it with atlcli audit ${rule.meta.product === "jira" ? "jira" : "wiki"}`);
      continue;
    }
    const at = scripts.findIndex((s) => s.meta.id === rule.meta.id);
    if (at >= 0) {
      const replaced = scripts[at]!;
      diagnostics.push(`${rule.meta.id} from ${path} replaces the ${replaced.origin === "built-in" ? "built-in rule" : `rule from ${replaced.origin}`}.`);
      // The older check name (`--checks stale`) belongs to the id, so it carries over.
      const legacy = rule.meta.legacy ?? replaced.meta.legacy;
      scripts[at] = legacy ? { ...rule, meta: { ...rule.meta, legacy }, def: { ...rule.def, legacy } } : rule;
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
 * Plans the fixes for the listed findings: each rule's `fix(finding, item, rule)`
 * runs once per finding of that rule (all in one sandbox run per rule), and
 * the plans are merged into one. Writes are planned, never executed here.
 */
export async function planAuditFixes(
  findings: AuditFinding[],
  scripts: AuditRuleScript[],
  itemFor: (finding: AuditFinding) => unknown,
  port: ScriptPort,
  onLog?: (level: "info" | "warn" | "error", message: string) => void,
  configFor?: (finding: AuditFinding) => AuditRuleConfig | undefined,
): Promise<ScriptRunPlan> {
  const rt = await runtime();
  const runs: ScriptRunPlan[] = [];
  const now = Date.now();
  for (const script of scripts) {
    if (!script.hasFix) continue;
    const mine = findings.filter((f) => f.rule === script.meta.id);
    if (!mine.length) continue;
    runs.push(
      await rt.planScript(script.js, {
        port,
        ...(script.modules ? { modules: script.modules } : {}),
        items: mine.map((finding) => ({ finding, item: itemFor(finding) ?? null, rule: { id: script.meta.id, config: configFor?.(finding) ?? {}, now } })),
        entry: "fix",
        noOutput: NO_OUTPUT,
        prelude: "globalThis.__atlcliArgs = (it) => [it.finding, it.item, Object.freeze(it.rule)];",
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
  ctx: { profile: Profile; port: ScriptPort; configFor?: (finding: AuditFinding) => AuditRuleConfig | undefined },
  flags: Flags,
  opts: OutputOptions,
): Promise<void> {
  const fixable = report.findings.filter((f) => f.fixable);
  if (fixable.length === 0) {
    output(opts.json ? { schemaVersion: "1", fixes: 0 } : "No listed finding has a fix (a rule proposes one with export async function fix(finding, item)).", opts);
    return;
  }
  const run = await planAuditFixes(
    fixable,
    scripts,
    itemFor,
    ctx.port,
    (level, message) => process.stderr.write(`${level === "info" ? "" : `${level}: `}${message}\n`),
    ctx.configFor,
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

export type AuditOutputFormat = "md" | "json" | "jsonl" | "csv";
const AUDIT_FORMATS: readonly AuditOutputFormat[] = ["md", "json", "jsonl", "csv"];

/** `--format`, else the `--output` file's extension (.json, .jsonl/.ndjson, .csv; anything else is Markdown). */
export function auditFormatOf(file: string): AuditOutputFormat {
  const ext = file.toLowerCase().split(".").pop();
  return ext === "json" ? "json" : ext === "jsonl" || ext === "ndjson" ? "jsonl" : ext === "csv" ? "csv" : "md";
}

/** The `report` export's `out`: opened on first use, closed by the host after the export returned (a returned string is written too). */
const REPORT_PRELUDE = `(() => {
  let writer;
  const open = () => (writer ??= atlcli.output("report"));
  const call = (name) => async (...args) => (await open())[name](...args);
  const out = Object.freeze({ path: "report", write: call("write"), line: call("line"), row: call("row"), json: call("json"), render: call("render") });
  globalThis.__atlcliArgs = (model) => [model, out];
  globalThis.__atlcliAfter = async (result) => {
    if (typeof result === "string") await out.write(result.endsWith("\\n") ? result : result + "\\n");
    return writer ? (await writer).close() : null;
  };
})();`;

/**
 * Writes the audit's output, streamed so no report is one string in memory:
 *
 * - `--output <file>` / `--format md|json|jsonl|csv` (`--report <file>` is
 *   `--format md --output <file>`): the file is replaced only once complete.
 * - Markdown is `--template <file>` (Jinja; templates beside it can be
 *   included), else a rule's `export function report(model, out)`
 *   (`--report-script <id>`, or the last rule that has one), else the default
 *   template.
 * - Without them: the JSON report with `--json`, else `text()`.
 */
export async function emitAuditOutput(
  report: AuditReportV3,
  scripts: AuditRuleScript[],
  port: ScriptPort,
  flags: Flags,
  opts: OutputOptions,
  text: () => string,
): Promise<void> {
  const reportFile = getFlag(flags, "report");
  const file = getFlag(flags, "output") ?? reportFile;
  const formatFlag = getFlag(flags, "format");
  if (formatFlag !== undefined && !AUDIT_FORMATS.includes(formatFlag as AuditOutputFormat)) {
    fail(opts, 1, ERROR_CODES.USAGE, `--format takes ${AUDIT_FORMATS.join(", ")}, not ${JSON.stringify(formatFlag)}`);
  }
  const markdownOnly = getFlag(flags, "template") !== undefined || getFlag(flags, "report-script") !== undefined || hasFlag(flags, "markdown");
  const format = (formatFlag as AuditOutputFormat | undefined) ?? (reportFile !== undefined || markdownOnly ? "md" : file !== undefined ? auditFormatOf(file) : undefined);
  if (markdownOnly && format !== "md") fail(opts, 1, ERROR_CODES.USAGE, "--template, --markdown and --report-script make a Markdown report; drop --format or use --format md");

  const json = opts.json || hasFlag(flags, "json");
  const stdout = (chunk: string) => void process.stdout.write(chunk);
  if (format === undefined) {
    if (json) writeReportJson(report, stdout);
    else output(text(), opts);
    return;
  }
  const target = file === undefined ? undefined : resolve(file);
  if (target) await mkdir(dirname(target), { recursive: true });
  const sink = target ? new AtomicFile(target) : undefined;
  const write = sink ? (chunk: string) => sink.write(chunk) : stdout;
  try {
    if (format === "md") await writeMarkdownReport(report, scripts, port, flags, opts, write, file ?? "report");
    else if (format === "json") writeReportJson(report, write);
    else if (format === "jsonl") writeReportJsonl(report, write);
    else writeReportCsv(report, write);
  } catch (error) {
    sink?.abort();
    throw error;
  }
  if (!sink) return;
  const { bytes } = sink.commit();
  if (!json) process.stderr.write(`Report written to ${file} (${formatSize(bytes)})\n`);
  // The file holds the report; --json still prints the JSON report.
  if (json) writeReportJson(report, stdout);
}

async function writeMarkdownReport(
  report: AuditReportV3,
  scripts: AuditRuleScript[],
  port: ScriptPort,
  flags: Flags,
  opts: OutputOptions,
  write: (chunk: string) => void,
  name: string,
): Promise<void> {
  const model = markdownModel(report);
  await initJinja();
  const templatePath = getFlag(flags, "template");
  if (templatePath) {
    const path = resolve(templatePath);
    const templates: Record<string, string> = {};
    for (const f of await readdir(dirname(path))) {
      if (/\.(j2|jinja|md|txt|html)$/.test(f)) templates[f] = await readFile(join(dirname(path), f), "utf8");
    }
    try {
      streamJinja(templates[basename(path)] ?? (await readFile(path, "utf8")), model, write, { templates, lines: true, tolerant: false });
    } catch (error) {
      if (error instanceof JinjaError) fail(opts, 1, ERROR_CODES.VALIDATION, `${templatePath}: ${error.message}`);
      throw error;
    }
    return;
  }
  const reportScript = getFlag(flags, "report-script");
  const withReport = scripts.filter((s) => s.hasReport);
  const chosen = reportScript !== undefined ? withReport.find((s) => s.meta.id === reportScript) : withReport.at(-1);
  if (reportScript !== undefined && !chosen) {
    fail(opts, 1, ERROR_CODES.USAGE, `No rule "${reportScript}" with export function report. Rules with one: ${withReport.map((s) => s.meta.id).join(", ") || "none"}`);
  }
  if (!chosen) {
    streamJinja(DEFAULT_MARKDOWN_TEMPLATE, model, write, { lines: true });
    return;
  }
  const rt = await runtime();
  const run = await rt.planScript(chosen.js, {
    port: { ...port, ...singleOutputPort(write, name) },
    ...(chosen.modules ? { modules: chosen.modules } : {}),
    item: model,
    entry: "report",
    prelude: REPORT_PRELUDE,
    readOnly: "a report only reads",
    limits: { deadlineMs: 5 * 60_000 },
  });
  if (run.value === null) fail(opts, 1, ERROR_CODES.VALIDATION, `${chosen.meta.id}: export function report must write to out or return the report text`);
}

/** `--script <file>` values. */
export const scriptFlags = (flags: Flags) => getFlags(flags, "script");

export const AUDIT_RULE_SKELETONS: Record<AuditProduct, string> = {
  jira: `// An audit rule: runs read-only for every open issue of \`atlcli audit jira\`.
// Print a built-in to start from: atlcli audit jira --print-rule hygiene/stale
export const meta = {
  audit: {
    id: "team/bug-without-component",
    product: "jira",
    title: "Bugs need a component",
    fields: ["components"],
    defaults: "warning",
    profiles: { strict: "error" },
  },
};

export default (issue: JiraIssue, rule: AuditRule) => {
  const type = issue.fields.issuetype as { name?: string } | null;
  const components = issue.fields.components as unknown[] | null;
  if (type?.name !== "Bug" || components?.length) return;
  return rule.finding({ detail: "Bug without a component." });
};

// Optional: \`atlcli audit jira --fix\` plans this for every listed finding.
// export async function fix(finding: AuditFinding, issue: JiraIssue) {
//   await atlcli.jira.update(issue.key, { fields: { components: [{ name: "General" }] } });
// }
`,
  confluence: `// An audit rule: runs read-only for every page of \`atlcli audit wiki\`.
// Print a built-in to start from: atlcli audit wiki --list-rules
export const meta = {
  audit: {
    id: "team/missing-owner-label",
    product: "confluence",
    title: "Pages need an owner label",
    defaults: "info",
  },
};

export default (page: AuditPage, rule: AuditRule) => {
  if (page.labels.some((l) => l.startsWith("owner-"))) return;
  return rule.finding({ detail: "No owner-* label." });
};

// Optional: \`atlcli audit wiki --fix\` plans this for every listed finding.
// export async function fix(finding: AuditFinding, page: AuditPage) {
//   await atlcli.confluence.addLabels(page.id, ["owner-unknown"]);
// }
`,
};

/** `atlcli audit init [--product jira|confluence] [--force]`: a rule skeleton and types in ./.atlcli/audit/. */
export async function handleAuditInit(flags: Flags, opts: OutputOptions): Promise<void> {
  const product = (getFlag(flags, "product") ?? "jira") as AuditProduct;
  if (product !== "jira" && product !== "confluence") fail(opts, 1, ERROR_CODES.USAGE, "--product must be jira or confluence.");
  const dir = join(process.cwd(), ".atlcli", "audit");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  const { ATLCLI_SCRIPT_TYPES } = await runtime();
  const { TSCONFIG } = await import("./script.js");
  const rule = product === "jira" ? "bug-without-component.ts" : "missing-owner-label.ts";
  const written: string[] = [];
  const kept: string[] = [];
  for (const [name, content] of [["atlcli.d.ts", ATLCLI_SCRIPT_TYPES], ["tsconfig.json", TSCONFIG], [rule, AUDIT_RULE_SKELETONS[product]]] as const) {
    const path = join(dir, name);
    // atlcli.d.ts tracks the CLI version, so it is always refreshed.
    if (existsSync(path) && !hasFlag(flags, "force") && name !== "atlcli.d.ts") {
      kept.push(name);
      continue;
    }
    await writeFile(path, content, "utf8");
    written.push(name);
  }
  if (opts.json) return output({ schemaVersion: "1", dir, written, kept }, opts);
  output(
    [
      `Wrote ${written.join(", ") || "nothing"} in ${dir}`,
      ...(kept.length ? [`Kept existing ${kept.join(", ")} (use --force to overwrite)`] : []),
      `Rules in this directory run with every 'atlcli audit ${product === "jira" ? "jira" : "wiki"}' here; check with --list-rules.`,
    ].join("\n"),
    opts,
  );
}
