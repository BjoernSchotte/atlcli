import { appendFileSync, existsSync, statSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  ERROR_CODES,
  fail,
  getActiveProfile,
  getFlag,
  getFlags,
  hasFlag,
  loadConfig,
  output,
  type OutputOptions,
  type Profile,
  promptConfirm,
  stripControlChars,
} from "@atlcli/core";
import type {
  ApplyReport,
  PlannedOperation,
  ScriptError,
  ScriptPlanV1,
  ScriptPort,
  Templating,
} from "@atlcli/script-runtime";
import { assertCliAuthSupported } from "./session-guard.js";
import { parseTemplateFlags, templateValuesFrom } from "./template-flags.js";

export type Flags = Record<string, string | boolean | string[]>;

/** The runtime (zod, QuickJS, WASM) loads only when a script command runs. */
const runtime = () => import("@atlcli/script-runtime");

export function scriptHelp(): string {
  return `Usage: atlcli script <command> [options]

Run TypeScript automation scripts for Jira and Confluence in a sandbox.
Writes are planned first; nothing changes until the plan is applied.

  for await (const issue of atlcli.jira.search("project = ATLCLI AND updated < -180d")) {
    await atlcli.jira.comment(issue.key, "Closing as stale");
    await atlcli.jira.transition(issue.key, "Won't Do");
  }

No boilerplate: atlcli.* is always there; share helpers with relative imports
(./util.ts). Add \`export const meta = { … }\` only to restrict permissions,
declare secrets or typed params.

Commands:
  run <file>             Plan the script; show the plan (nothing changes)
  run -e <code>          Run inline code instead of a file
  apply <plan.json>      Apply a plan written with run --plan-out
  apply <job-id>         Apply the reviewed plans of a per-issue job
  resume <job-id>        Continue an interrupted per-issue job
  jobs [job-id]          List per-issue jobs, or show one
  check <file>           Validate meta and type-check (needs tsc on PATH)
  test <file|dir>        Replay recorded cases (<name>.test.json) offline and compare the plans
  init [dir]             Write atlcli.d.ts, tsconfig.json and an example script

Options for run:
  --param <name=value>   Script parameter, repeatable (available as atlcli.params)
  --plan-out <file>      Write the plan as JSON (for review, CI artifacts, apply)
  --apply                Apply the plan right away (asks first)
  --yes                  Apply without asking (required without a terminal or with --json)
  --profile <name>       Profile to run against
  --json                 Machine-readable output

Per issue (--each, or meta.each in the script):
  --each "<jql>"         Run \`export default async (issue) => …\` once per issue; a resumable
                         job under ~/.atlcli/jobs. Without --apply it only plans
  --concurrency <n>      Issues in flight at once, 1–32 (4)
  --max-failures <n|%>   Stop after this many failed issues (10%, at least 10)
  --max-items <n>        Process at most n issues this run (the rest on resume)
  Limits (--timeout, --max-calls, --max-writes) apply per issue: 60s, 500, 50.

Options for apply:
  --resume               Continue a plan whose earlier apply stopped (journal next to it)
  --concurrency <n>      Operations in flight at once, 1–32 (1); same issue/page stays in order
  --yes                  Apply without asking

Options for resume:
  --script <file>        Continue with a fixed script (planning or streaming jobs)
  --yes, --concurrency, --max-failures as for run

Options for test:
  --record <name>        Plan once against the site (nothing changes) and store what the
                         script read and planned as a case; with --param, --each <KEY>, --now
  --case <name>          Run one case
  --update               Rewrite the cases' expected plans from what the script plans now

Options for init:
  --each "<jql>"         Write each.ts, a per-issue script for this query
  --example <name>       Write one of the examples (list them with --list-examples)

Templates for run (atlcli.render):
  --var <name=value>     Template variable, repeatable (a.b=v nests; JSON values allowed)
  --vars-file <file>     YAML file with values (and optional variables: declarations)
  --now <iso>            Freeze the clock for today/now (repeat a plan exactly)
  --strict               Fail on any template warning (unresolved {{…}} and others)

Limits for run (defaults in parentheses):
  --timeout <duration>   Whole run, e.g. 90s, 10m, 1h; a bare number is seconds; 0 = none (1h)
  --max-writes <n>       Operations per plan; overrides meta.limits.maxWrites; 0 = none (10000)
  --max-calls <n>        Jira/Confluence calls per run; 0 = none (100000)
  --memory <MB>          Script memory (64)

JQL in atlcli.jira.search and --each may use linkedIssuesOf("…"), subtasksOf("…"),
hasAttachments("…") and more (see \`atlcli jira --help\`).

atlcli.confluence.export and atlcli.files write below the directory the plan is applied in.
atlcli.state keeps a JSON store per script in ~/.atlcli/state. atlcli.http needs
"http:<host>" in meta.permissions; atlcli.secret("NAME") reads ATLCLI_SECRET_NAME
into HTTP requests only.

Exit codes: 0 ok · 1 error · 2 drift (target changed since the plan; nothing written)
`;
}

export async function handleScript(args: string[], flags: Flags, opts: OutputOptions): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === "help" || hasFlag(flags, "help")) {
    output(scriptHelp(), opts);
    return;
  }
  // `--apply` is a switch here: `run --apply x.ts` must not read x.ts as its value.
  if (typeof flags.apply === "string") {
    rest.push(flags.apply);
    flags = { ...flags, apply: true };
  }
  switch (command) {
    case "run":
      return runCommand(rest, flags, opts);
    case "apply": {
      const { applyJobCommand, isJobRef } = await import("./script-jobs.js");
      if (rest[0] && isJobRef(rest[0])) return applyJobCommand(rest[0], flags, opts);
      return applyCommand(rest, flags, opts);
    }
    case "resume":
      return (await import("./script-jobs.js")).resumeCommand(rest, flags, opts);
    case "jobs":
      return (await import("./script-jobs.js")).jobsCommand(rest, opts);
    case "check":
      return checkCommand(rest, opts);
    case "test":
      return (await import("./script-test.js")).testCommand(rest, flags, opts);
    case "init":
      return initCommand(rest, flags, opts);
    default:
      fail(opts, 1, ERROR_CODES.USAGE, `Unknown script command: ${command}. Run \`atlcli script help\`.`);
  }
}

async function runCommand(args: string[], flags: Flags, opts: OutputOptions): Promise<void> {
  const inline = getFlag(flags, "eval") ?? getFlag(flags, "e");
  const file = args[0];
  if (!inline && !file) fail(opts, 1, ERROR_CODES.USAGE, "Usage: atlcli script run <file> | -e <code>");
  const source = inline ?? (await readSource(file!, opts));
  const params = parseParams(getFlags(flags, "param"), opts);
  const { limits, maxWrites } = parseLimits(flags, opts);
  const templating = templateValuesFrom(await parseTemplateFlags(flags, opts));
  const origin = file ? { path: relative(process.cwd(), resolve(file)) } : { name: "inline" };
  // Per-issue mode: --each, or meta.each (only scripts mentioning it pay for the meta read).
  if (flags.each !== undefined || /\beach\b/.test(source)) {
    const rt = await runtime();
    const meta = await guard(opts, () => rt.inspectScript(transpile(source, opts)));
    if (flags.each !== undefined || meta.each) {
      const { runEach } = await import("./script-jobs.js");
      return runEach(source, origin, meta, params, templating, flags, opts);
    }
  }
  await planAndApply(
    source,
    origin,
    params,
    { limits, maxWrites },
    flags,
    opts,
    templating,
  );
}

/**
 * Plans `source`, prints or writes the plan, and applies it with `--apply`:
 * the whole of `script run` after argument parsing. Built-in scripts such as
 * `jira project copy-issues` run through here too, so they share the plan
 * file, confirmation and apply report.
 */
/** Plan and state-store name when meta has none: the file name without extension. */
export function scriptName(origin: { path: string } | { name: string }): string {
  return "path" in origin ? origin.path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "") : origin.name;
}

export async function planAndApply(
  source: string,
  origin: { path: string } | { name: string },
  params: Record<string, unknown>,
  { limits, maxWrites }: ReturnType<typeof parseLimits>,
  flags: Flags,
  opts: OutputOptions,
  templating?: Templating,
): Promise<void> {
  const modules = "path" in origin ? await loadImports(origin.path, source, opts) : {};
  const { profile, port } = await connect(flags, opts);
  const rt = await runtime();

  const run = await guard(opts, () =>
    rt.planScript(transpile(source, opts), {
      port,
      name: scriptName(origin),
      modules: transpileModules(modules, opts),
      params,
      limits,
      ...(maxWrites !== undefined ? { maxWrites } : {}),
      ...(templating ? { templating } : {}),
      onLog: (level, message) => process.stderr.write(`${level === "info" ? "" : `${level}: `}${stripControlChars(message)}\n`),
    }),
  );
  const plan = await rt.createScriptPlan(run, {
    source: digestSource(source, modules),
    ...origin,
    baseUrl: profile.baseUrl,
    profile: profile.name,
  });
  await outputOrApplyPlan(plan, { profile, port }, flags, opts);
}

/**
 * Prints a plan (and writes `--plan-out`), or applies it with `--apply`:
 * confirmation, journal, concurrency and the apply report. Shared by
 * `script run` and planned changes from elsewhere (`audit … --fix`).
 */
export async function outputOrApplyPlan(
  plan: ScriptPlanV1,
  { profile, port }: { profile: Profile; port: ScriptPort },
  flags: Flags,
  opts: OutputOptions,
): Promise<void> {
  const rt = await runtime();
  const planOut = getFlag(flags, "plan-out");
  if (planOut) {
    await writeFile(planOut, rt.serializeScriptPlan(plan), "utf8");
    // A journal next to it belonged to the plan this one replaces.
    await rm(journalPath(planOut), { force: true });
  }

  const apply = hasFlag(flags, "apply");
  if (!apply || plan.operations.length === 0) {
    if (opts.json) output({ schemaVersion: "1", plan }, opts);
    else output(renderPlan(plan, planOut, apply), opts);
    return;
  }
  if (!opts.json) output(renderPlan(plan, planOut, true), opts);
  await confirmApply(plan, flags, opts);
  const journal = planOut ? await openJournal(planOut, plan, { fresh: true }, opts) : undefined;
  const report = await rt.applyScriptPlan(plan, {
    port,
    baseUrl: profile.baseUrl,
    concurrency: parseConcurrency(flags, opts, 1),
    onOperation: track(plan, opts, journal),
  });
  finish(plan, report, opts, planOut);
}

async function applyCommand(args: string[], flags: Flags, opts: OutputOptions): Promise<void> {
  const file = args[0];
  if (!file) fail(opts, 1, ERROR_CODES.USAGE, "Usage: atlcli script apply <plan.json>");
  const rt = await runtime();
  let plan: ScriptPlanV1;
  try {
    plan = await rt.parseScriptPlan(await readSource(file, opts));
  } catch (error) {
    fail(opts, 1, ERROR_CODES.VALIDATION, messageOf(error));
  }
  const { profile, port } = await connect(flags, opts);
  if (rt.normalizeBaseUrl(profile.baseUrl) !== plan.target.baseUrl) {
    fail(opts, 1, ERROR_CODES.VALIDATION, `Plan targets ${plan.target.baseUrl}, but profile ${profile.name} is ${profile.baseUrl}.`);
  }
  if (plan.operations.length === 0) {
    output(opts.json ? { schemaVersion: "1", plan, report: { status: "applied", drift: [], operations: [] } } : "Nothing to apply.", opts);
    return;
  }
  const journal = await openJournal(file, plan, { resume: hasFlag(flags, "resume") }, opts);
  if (journal.done.size === plan.operations.length) {
    output(opts.json ? { schemaVersion: "1", plan, report: { status: "applied", drift: [], operations: [] } } : "Everything in this plan is already applied.", opts);
    return;
  }
  if (!opts.json) {
    output(renderPlan(plan, undefined, true), opts);
    if (journal.done.size > 0) output(`Resuming: ${journal.done.size} of ${plan.operations.length} operations were applied before.`, opts);
  }
  await confirmApply(plan, flags, opts, journal.done.size);
  const report = await rt.applyScriptPlan(plan, {
    port,
    baseUrl: profile.baseUrl,
    done: journal.done,
    concurrency: parseConcurrency(flags, opts, 1),
    onOperation: track(plan, opts, journal),
  });
  finish(plan, report, opts, file);
}

/** Journal of an apply: the plan digest, then one JSON line per applied operation. */
export function journalPath(planFile: string): string {
  return `${planFile}.journal.jsonl`;
}

interface Journal {
  done: Map<number, Record<string, unknown>>;
  record(seq: number, result: Record<string, unknown>): void;
}

/**
 * Opens the journal next to a plan file. `fresh` starts a new one (a plan just
 * written). Otherwise an existing journal of this plan means an earlier apply
 * got partway: continuing needs `--resume`, because applying a plan twice
 * would repeat comments and creates.
 */
async function openJournal(planFile: string, plan: ScriptPlanV1, mode: { fresh?: boolean; resume?: boolean }, opts: OutputOptions): Promise<Journal> {
  const path = journalPath(planFile);
  const done = new Map<number, Record<string, unknown>>();
  if (!mode.fresh && existsSync(path)) {
    const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
    let header: { plan?: string } = {};
    try {
      header = JSON.parse(lines[0] ?? "{}");
      // A line cut off by a crash is the last one; it never counted as applied.
      for (const line of lines.slice(1)) {
        try {
          const entry = JSON.parse(line) as { seq: number; result: Record<string, unknown> };
          done.set(entry.seq, entry.result);
        } catch {}
      }
    } catch {}
    if (header.plan !== plan.digest) {
      fail(opts, 1, ERROR_CODES.VALIDATION, `${displayPath(path)} belongs to a different plan. Move it away to apply this one.`);
    }
    if (done.size > 0 && !mode.resume) {
      fail(
        opts,
        1,
        ERROR_CODES.USAGE,
        `${done.size} of ${plan.operations.length} operations of this plan were already applied (${displayPath(path)}). Continue with --resume; applying a plan twice repeats its writes.`,
      );
    }
  } else {
    await writeFile(path, JSON.stringify({ plan: plan.digest }) + "\n", "utf8");
  }
  return {
    done,
    // Synchronous, so a line is on disk before the next operation starts.
    record: (seq, result) => appendFileSync(path, JSON.stringify({ seq, result }) + "\n"),
  };
}

export function parseConcurrency(flags: Flags, opts: OutputOptions, fallback: number): number {
  const raw = getFlag(flags, "concurrency");
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > 32) fail(opts, 1, ERROR_CODES.USAGE, `--concurrency expects 1 to 32, got "${raw}"`);
  return Number(raw);
}

async function checkCommand(args: string[], opts: OutputOptions): Promise<void> {
  const file = args[0];
  if (!file) fail(opts, 1, ERROR_CODES.USAGE, "Usage: atlcli script check <file>");
  const source = await readSource(file, opts);
  const rt = await runtime();
  const meta = await guard(opts, () => rt.inspectScript(transpile(source, opts)));
  const modules = await loadImports(file, source, opts);
  transpileModules(modules, opts);
  const typecheck = await typeCheck(resolve(file));
  if (opts.json) {
    output({ schemaVersion: "1", meta, typecheck }, opts);
  } else {
    const lines = [
      `meta: ${meta.permissions ? `permissions ${meta.permissions.join(", ")}` : "no permissions declared (all verbs allowed; writes are always planned)"}`,
      `types: ${typecheck.status === "ok" ? "ok" : typecheck.status === "skipped" ? `skipped (${typecheck.reason})` : "errors"}`,
    ];
    if (typecheck.status === "errors") lines.push(typecheck.output.trimEnd());
    output(lines.join("\n"), opts);
  }
  if (typecheck.status === "errors") process.exit(1);
}

const EXAMPLE = `// Run: atlcli script run example.ts   (shows the plan; add --apply to execute)
for await (const issue of atlcli.jira.search(\`project = \${atlcli.params.project ?? "ATLCLI"} AND updated < -180d\`, { limit: 20 })) {
  console.log(issue.key, issue.fields.summary);
  // await atlcli.jira.comment(issue.key, "Closing as stale");
}
`;

export const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": [],
    "strict": true,
    "noEmit": true,
    "moduleDetection": "force",
    "erasableSyntaxOnly": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true
  },
  "include": ["**/*.ts"]
}
`;

/** Skeleton for `init --each "<jql>"`. */
export function eachSkeleton(jql: string): string {
  return `// Runs once per issue of meta.each.jql.
//   atlcli script run each.ts            plans every issue (a job); nothing changes
//   atlcli script apply <job-id>         applies the reviewed plans
//   atlcli script run each.ts --apply    plans and applies issue by issue
//   atlcli script resume <job-id>        continues an interrupted job
// Make it safe to run twice: check before you write. Status, labels, assignee
// and page updates that change nothing are skipped; comments and creates are not.
export const meta = {
  each: { jql: ${JSON.stringify(jql)}, fields: ["summary", "status", "labels"] },
};

export default async (issue: JiraIssue) => {
  const labels = issue.fields.labels as string[];
  console.log(issue.key, issue.fields.summary);
  // if (!labels.includes("triaged")) await atlcli.jira.addLabels(issue.key, ["triaged"]);
};
`;
}

async function initCommand(args: string[], flags: Flags, opts: OutputOptions): Promise<void> {
  const { SCRIPT_EXAMPLES, exampleDescription } = await import("../builtin-scripts/examples.js");
  if (hasFlag(flags, "list-examples")) {
    if (opts.json) output({ schemaVersion: "1", examples: SCRIPT_EXAMPLES.map((e) => ({ name: e.name, mode: e.mode, description: exampleDescription(e) })) }, opts);
    else output(SCRIPT_EXAMPLES.map((e) => `${e.name.padEnd(18)} ${e.mode.padEnd(5)} ${exampleDescription(e)}`).join("\n"), opts);
    return;
  }
  const exampleName = getFlag(flags, "example");
  const example = exampleName === undefined ? undefined : SCRIPT_EXAMPLES.find((e) => e.name === exampleName);
  if (exampleName !== undefined && !example) {
    fail(opts, 1, ERROR_CODES.USAGE, `Unknown example "${exampleName}". Available: ${SCRIPT_EXAMPLES.map((e) => e.name).join(", ")}`);
  }
  const each = getFlag(flags, "each");
  if (hasFlag(flags, "each") && !each) fail(opts, 1, ERROR_CODES.USAGE, 'init --each needs the query: --each "<jql>"');
  const dir = resolve(args[0] ?? ".");
  await mkdir(dir, { recursive: true });
  const { ATLCLI_SCRIPT_TYPES } = await runtime();
  const force = hasFlag(flags, "force");
  const files: Array<[string, string]> = [
    ["atlcli.d.ts", ATLCLI_SCRIPT_TYPES],
    ["tsconfig.json", TSCONFIG],
    example ? [`${example.name}.ts`, example.source] : each ? ["each.ts", eachSkeleton(each)] : ["example.ts", EXAMPLE],
  ];
  const written: string[] = [];
  const kept: string[] = [];
  for (const [name, content] of files) {
    const path = join(dir, name);
    // atlcli.d.ts tracks the CLI version, so it is always refreshed.
    if (existsSync(path) && !force && name !== "atlcli.d.ts") {
      kept.push(name);
      continue;
    }
    await writeFile(path, content, "utf8");
    written.push(name);
  }
  if (opts.json) output({ schemaVersion: "1", dir, written, kept }, opts);
  else {
    output(
      [
        `Wrote ${written.join(", ") || "nothing"} in ${dir}`,
        ...(kept.length ? [`Kept existing ${kept.join(", ")} (use --force to overwrite)`] : []),
        `Next: atlcli script run ${displayPath(join(dir, files[2]![0]))}`,
      ].join("\n"),
      opts,
    );
  }
}

// ============ Helpers ============

export async function readSource(file: string, opts: OutputOptions): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    fail(opts, 1, ERROR_CODES.IO, `Cannot read ${file}: ${messageOf(error)}`);
  }
}

/** Type stripping only; scripts are erasable-syntax TypeScript or plain JavaScript. */
export function transpile(source: string, opts: OutputOptions, path?: string): string {
  try {
    return new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(source);
  } catch (error) {
    fail(opts, 1, ERROR_CODES.VALIDATION, `${path ?? "Script"} does not parse: ${messageOf(error)}`);
  }
}

/**
 * The files a script imports, transitively: path relative to the script's
 * directory → source as written. Only relative imports of files inside that
 * directory are allowed (links pointing out are refused); anything else fails
 * here, before the script runs.
 */
export async function readImports(file: string, source: string): Promise<Record<string, string>> {
  const rt = await runtime();
  const root = await realpath(dirname(resolve(file)));
  const modules: Record<string, string> = {};
  const queue: Array<[string, string]> = [[rt.SCRIPT_MODULE, source]];
  const scanner = new Bun.Transpiler({ loader: "ts" });
  while (queue.length > 0) {
    const [base, text] = queue.shift()!;
    const where = base === rt.SCRIPT_MODULE ? displayPath(resolve(file)) : base;
    let imports: Array<{ path: string }>;
    try {
      imports = scanner.scanImports(text);
    } catch (error) {
      throw new Error(`${where} does not parse: ${messageOf(error)}`);
    }
    for (const { path } of imports) {
      const candidates = rt.moduleCandidates(base, path);
      if (candidates instanceof Error) throw new Error(`${where}: ${candidates.message}`);
      const hit = candidates.find((c) => {
        try {
          return statSync(join(root, c)).isFile();
        } catch {
          return false;
        }
      });
      if (!hit) throw new Error(`${where}: cannot find ${path}`);
      if (Object.hasOwn(modules, hit)) continue;
      const real = await realpath(join(root, hit));
      if (!real.startsWith(root + sep)) throw new Error(`${where}: ${path} leads outside the script's directory`);
      modules[hit] = await readFile(real, "utf8");
      queue.push([hit, modules[hit]]);
    }
  }
  return modules;
}

/** readImports for a command's own script: problems end the command. */
export async function loadImports(file: string, source: string, opts: OutputOptions): Promise<Record<string, string>> {
  try {
    return await readImports(file, source);
  } catch (error) {
    fail(opts, 1, ERROR_CODES.VALIDATION, messageOf(error));
  }
}

/** Type-stripped modules for the sandbox. */
export function transpileModules(modules: Record<string, string>, opts: OutputOptions): Record<string, string> {
  return Object.fromEntries(Object.entries(modules).map(([path, source]) => [path, transpile(source, opts, path)]));
}

/** What a plan's script digest covers: the script and, in path order, every file it imports. */
export function digestSource(source: string, modules: Record<string, string>): string {
  const paths = Object.keys(modules).sort();
  return paths.length === 0 ? source : [source, ...paths.map((p) => `\n//# atlcli-module ${p}\n${modules[p]}`)].join("");
}

/** `--timeout`, `--memory`, `--max-calls`, `--max-writes`; unset flags keep the runtime defaults. */
export function parseLimits(
  flags: Flags,
  opts: OutputOptions,
): { limits: { deadlineMs?: number; memoryBytes?: number; maxHostCalls?: number }; maxWrites?: number } {
  /** A positive whole number; with `unlimited`, 0 means no limit (Infinity). */
  const count = (name: string, unlimited = true): number | undefined => {
    const raw = getFlag(flags, name);
    if (raw === undefined) return undefined;
    if (unlimited && raw === "0") return Infinity;
    if (!/^[1-9]\d*$/.test(raw)) {
      fail(opts, 1, ERROR_CODES.USAGE, `--${name} expects a positive whole number${unlimited ? " (0 for no limit)" : ""}, got "${raw}"`);
    }
    return Number(raw);
  };
  const limits: { deadlineMs?: number; memoryBytes?: number; maxHostCalls?: number } = {};
  const timeout = getFlag(flags, "timeout");
  if (timeout === "0") limits.deadlineMs = Infinity;
  else if (timeout !== undefined) {
    const match = /^([1-9]\d*)(ms|s|m|h)?$/.exec(timeout);
    if (!match) fail(opts, 1, ERROR_CODES.USAGE, `--timeout expects a duration like 90s, 10m or 1h, got "${timeout}"`);
    const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[(match[2] ?? "s") as "ms" | "s" | "m" | "h"];
    limits.deadlineMs = Number(match[1]) * unit;
  }
  const memory = count("memory", false);
  if (memory !== undefined) limits.memoryBytes = memory * 1024 * 1024;
  const calls = count("max-calls");
  if (calls !== undefined) limits.maxHostCalls = calls;
  const maxWrites = count("max-writes");
  return { limits, ...(maxWrites !== undefined ? { maxWrites } : {}) };
}

export function parseParams(raw: string[], opts: OutputOptions): Record<string, string> {
  const params: Record<string, string> = {};
  for (const entry of raw) {
    const eq = entry.indexOf("=");
    if (eq <= 0) fail(opts, 1, ERROR_CODES.USAGE, `--param expects name=value, got "${entry}"`);
    params[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return params;
}

export async function connect(flags: Flags, opts: OutputOptions): Promise<{ profile: Profile; port: ScriptPort }> {
  const config = await loadConfig();
  const profile = getActiveProfile(config, getFlag(flags, "profile"));
  if (!profile) fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.");
  assertCliAuthSupported(profile, opts);
  const { createLazyCliScriptPort } = await import("./script-port.js");
  return { profile, port: createLazyCliScriptPort(profile) };
}

/** Script errors (invalid meta, limits, denied permissions, guest exceptions) as CLI failures. */
export async function guard<T>(opts: OutputOptions, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const scriptError = error as ScriptError;
    if (scriptError?.name === "ScriptError") {
      fail(opts, 1, ERROR_CODES.VALIDATION, `Script failed (${scriptError.kind}): ${scriptError.message}`, {
        kind: scriptError.kind,
        ...(scriptError.guestStack ? { stack: scriptError.guestStack } : {}),
      });
    }
    throw error;
  }
}

async function confirmApply(plan: ScriptPlanV1, flags: Flags, opts: OutputOptions, alreadyDone = 0): Promise<void> {
  if (hasFlag(flags, "yes")) return;
  if (opts.json || !process.stdin.isTTY) {
    fail(opts, 1, ERROR_CODES.USAGE, "Applying needs confirmation: pass --yes (required without a terminal or with --json).");
  }
  const n = plan.operations.length - alreadyDone;
  const breakdown = n >= LARGE_PLAN ? ` (${verbCounts(plan.operations)})` : "";
  if (!(await promptConfirm(`Apply ${n} operation${n === 1 ? "" : "s"}${breakdown} to ${plan.target.baseUrl}?`))) {
    fail(opts, 1, ERROR_CODES.USAGE, "Not applied.");
  }
}

/** Plans from this many operations on are summarized rather than listed. */
const LARGE_PLAN = 200;

/** "120 jira.comment, 80 jira.addLabels", most frequent first. */
function verbCounts(operations: readonly PlannedOperation[]): string {
  const counts = new Map<string, number>();
  for (const op of operations) counts.set(op.verb, (counts.get(op.verb) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([verb, n]) => `${n} ${verb}`).join(", ");
}

/** Journals applied operations and reports progress: one line each, or a running count for large plans. */
function track(plan: ScriptPlanV1, opts: OutputOptions, journal?: Journal) {
  const large = plan.operations.length >= LARGE_PLAN;
  let applied = 0;
  return (r: { seq: number; status: string; error?: string; result?: Record<string, unknown> }) => {
    if (r.status === "applied") {
      journal?.record(r.seq, r.result ?? {});
      applied++;
    }
    if (opts.json) return;
    if (r.status === "failed") process.stderr.write(`  ✗ ${r.seq}: ${stripControlChars(r.error ?? "")}\n`);
    else if (!large) process.stderr.write(`  ✓ ${r.seq}\n`);
    else if (applied % 100 === 0) process.stderr.write(`  ✓ ${applied} applied\n`);
  };
}

function finish(plan: ScriptPlanV1, report: ApplyReport, opts: OutputOptions, planFile?: string): void {
  if (report.status === "drift") {
    const lines = report.drift.map((d) => `  #${d.seq} ${describePrecondition(d.precondition)}: now ${d.actual}`);
    fail(opts, 2, ERROR_CODES.VALIDATION, ["Targets changed since the plan was made; nothing was written:", ...lines, "Re-run the script to plan again."].join("\n"), {
      report,
    });
  }
  if (report.status === "failed") {
    const failed = report.operations.find((o) => o.status === "failed")!;
    const done = report.operations.filter((o) => o.status === "applied").length;
    const next = planFile
      ? ` Fix the cause, then continue with: atlcli script apply ${displayPath(planFile)} --resume`
      : " Pass --plan-out next time to be able to resume.";
    fail(opts, 1, ERROR_CODES.API, `Operation #${failed.seq} failed: ${failed.error?.replace(/\.$/, "")}. ${done} of ${plan.operations.length} operations were applied; the rest were skipped.${next}`, {
      report,
    });
  }
  if (opts.json) output({ schemaVersion: "1", plan, report }, opts);
  else output(`Applied ${report.operations.length} operation${report.operations.length === 1 ? "" : "s"}.${createdSummary(report)}`, opts);
}

/** Verbs that create something, with the word put before its id in the apply summary. */
const CREATED_LABEL: Partial<Record<PlannedOperation["verb"], string>> = {
  "jira.create": "",
  "jira.clone": "",
  "jira.createSprint": "sprint ",
  "jira.createVersion": "version ",
  "jira.createComponent": "component ",
  "confluence.createPage": "",
  "confluence.createBlogPost": "blog post ",
};

function createdSummary(report: ApplyReport): string {
  const created = report.operations
    .filter((o) => o.status === "applied" && CREATED_LABEL[o.verb] !== undefined)
    .map((o) => `${CREATED_LABEL[o.verb]}${String(o.result?.key ?? o.result?.id)}`);
  const exported = report.operations
    .filter((o) => o.status === "applied" && (o.verb === "confluence.export" || o.verb === "files.write"))
    .map((o) => String(o.result?.path));
  const unmoved = report.operations
    .filter((o) => o.status === "applied" && o.verb === "jira.setStatus" && o.result?.moved === false)
    .map((o) => `${String(o.result?.key)} → ${String(o.result?.status)}`);
  const list = (items: string[]) => (items.length > 20 ? `${items.slice(0, 20).join(", ")} and ${items.length - 20} more` : items.join(", "));
  return (
    `${created.length ? ` Created: ${list(created)}.` : ""}${exported.length ? ` Wrote: ${list(exported)}.` : ""}` +
    (unmoved.length ? `\nStatus unchanged (no direct transition): ${unmoved.join(", ")}.` : "")
  );
}

export function renderPlan(plan: ScriptPlanV1, planOut: string | undefined, applying: boolean): string {
  const n = plan.operations.length;
  const lines = [`${plan.script.name} → ${plan.target.baseUrl}${plan.target.profile ? ` (profile ${plan.target.profile})` : ""}`];
  if (n === 0) lines.push("No changes planned.");
  else {
    lines.push(`Plan: ${n} operation${n === 1 ? "" : "s"}${n >= LARGE_PLAN ? ` (${verbCounts(plan.operations)})` : ""}`);
    const shown = n >= LARGE_PLAN ? plan.operations.slice(0, 50) : plan.operations;
    for (const op of shown) lines.push(`  ${String(op.seq).padStart(3)}  ${describeOperation(op)}`);
    if (shown.length < n) lines.push(`  … and ${n - shown.length} more (all of them: --plan-out <file> or --json)`);
  }
  if (plan.skipped.length > 0) {
    lines.push(`Unchanged, not planned: ${plan.skipped.length}`);
    const why: Partial<Record<string, string>> = {
      "confluence.updatePage": "same content",
      "confluence.movePage": "already there",
      "jira.assign": "already assigned",
      "jira.addLabels": "labels already set",
      "jira.removeLabels": "labels not set",
      "jira.createVersion": "version exists",
      "jira.createComponent": "component exists",
      "jira.unlink": "no such link",
      "confluence.setProperty": "same value",
      "confluence.deleteProperty": "not set",
      "files.write": "same content",
      "state.set": "same value",
      "state.delete": "not set",
    };
    for (const skip of plan.skipped) {
      const what = skip.verb.startsWith("confluence.") ? `page ${skip.target}` : skip.target;
      lines.push(`       ${what}${skip.title ? ` ${JSON.stringify(skip.title)}` : ""} (${why[skip.verb] ?? "no change"})`);
    }
  }
  if (plan.templating) {
    lines.push(`Templates: rendered at ${plan.templating.now} (re-plan with --now ${plan.templating.now} to repeat it)`);
  }
  const warnings = plan.renderWarnings ?? [];
  if (warnings.length > 0) {
    lines.push(`Template warnings (${warnings.length}):`);
    for (const w of warnings.slice(0, 20)) {
      const at = w.line !== undefined ? ` ${w.line}:${w.column ?? 0}` : "";
      lines.push(`  ${w.unit ?? ""}${at}  ${stripControlChars(w.message)}`.trimEnd());
    }
    if (warnings.length > 20) lines.push(`  … and ${warnings.length - 20} more (see --json)`);
  }
  if (plan.value !== null) lines.push(`Result: ${JSON.stringify(plan.value)}`);
  if (planOut) lines.push(`Plan written to ${planOut} (digest ${plan.digest.slice(0, 12)})`);
  if (n > 0 && !applying) lines.push("Nothing was changed. Apply with --apply, or: atlcli script apply <plan.json>");
  return lines.join("\n");
}

/** " with fields resolution, comment" for transitions that set more than the status. */
function transitionExtras(a: Record<string, any>): string {
  const parts = [...Object.keys(a.fields ?? {}), ...(a.comment ? ["comment"] : [])];
  return parts.length ? ` with ${parts.join(", ")}` : "";
}

export function describeOperation(op: PlannedOperation): string {
  const a = op.args as Record<string, any>;
  const after = op.dependsOn.length ? `  (after #${op.dependsOn.join(", #")})` : "";
  const text = (s: unknown, max = 60) => {
    const one = String(s ?? "").replace(/\s+/g, " ").trim();
    return JSON.stringify(one.length > max ? `${one.slice(0, max - 1)}…` : one);
  };
  const ref = (s: unknown) => (/^plan:\d+$/.test(String(s)) ? `#${String(s).slice(5)}` : String(s));
  switch (op.verb) {
    case "jira.create":
      return `jira create      ${a.project} ${a.type} ${text(a.summary)}${after}`;
    case "jira.update":
      return `jira update      ${ref(a.key)} ${Object.keys(a).filter((k) => k !== "key").join(", ")}${after}`;
    case "jira.transition":
      return `jira transition  ${ref(a.key)} → ${a.transition}${transitionExtras(a)}${after}`;
    case "jira.setStatus":
      return `jira status      ${ref(a.key)} → ${a.status} (if a direct transition exists)${transitionExtras(a)}${after}`;
    case "jira.addWatcher":
      return `jira watch       ${ref(a.key)} + ${a.query}${after}`;
    case "jira.removeWatcher":
      return `jira watch       ${ref(a.key)} - ${a.query}${after}`;
    case "jira.notify": {
      const to = a.to as Record<string, unknown>;
      const who = [
        ...((to.users as unknown[] | undefined)?.length ? [`${(to.users as unknown[]).length} user(s)`] : []),
        ...((to.groups as string[] | undefined) ?? []).map((g) => `group ${g}`),
        ...["reporter", "assignee", "watchers", "voters"].filter((k) => to[k]),
      ];
      return `jira notify      ${ref(a.key)} ${text(a.subject)} → ${who.join(", ")}${after}`;
    }
    case "jira.comment":
      return `jira comment     ${ref(a.key)} ${"raw" in a ? "(raw)" : text(a.markdown)}${after}`;
    case "jira.copyAttachment":
      return `jira attach copy ${a.filename} (${bytes(a.size)}) ${a.id} → ${ref(a.to)}${after}`;
    case "confluence.createPage":
      return `page create      ${a.spaceKey} ${text(a.title)}${a.parentId ? ` under ${ref(a.parentId)}` : ""}${after}`;
    case "confluence.updatePage":
      return `page update      ${ref(a.id)} ${text(a.title)}${after}`;
    case "confluence.addLabels":
      return `page labels      ${ref(a.pageId)} + ${(a.labels as string[]).join(", ")}${after}`;
    case "confluence.removeLabels":
      return `page labels      ${ref(a.pageId)} - ${(a.labels as string[]).join(", ")}${after}`;
    case "confluence.comment":
      return `page comment     ${ref(a.pageId)} ${text(a.markdown)}${after}`;
    case "confluence.movePage":
      return `page move        ${ref(a.id)} under ${ref(a.parentId)}${after}`;
    case "confluence.deletePage":
      return `page DELETE      ${ref(a.id)} ${text(a.title)} (to trash)${after}`;
    case "confluence.archivePage":
      return `page ARCHIVE     ${ref(a.id)} ${text(a.title)}${after}`;
    case "confluence.attach":
      return `page attach      ${ref(a.pageId)} ${a.name} (${size(a)})${after}`;
    case "confluence.copyAttachment":
      return `page attach      ${ref(a.toPageId)} ${a.name} (copy of ${a.attachmentId} on page ${a.sourcePageId}, ${Math.ceil(Number(a.size) / 1024)} KB)${after}`;
    case "confluence.export":
      return `page export      ${ref(a.pageId)} → ${a.path}${after}`;
    case "jira.link":
      return `jira link        ${ref(a.from)} ${a.type} ${ref(a.to)}${after}`;
    case "jira.assign":
      return `jira assign      ${ref(a.key)} → ${a.assignee ? (a.user ?? "user") : "(unassigned)"}${after}`;
    case "jira.addLabels":
      return `jira labels      ${ref(a.key)} + ${(a.labels as string[]).join(", ")}${after}`;
    case "jira.removeLabels":
      return `jira labels      ${ref(a.key)} - ${(a.labels as string[]).join(", ")}${after}`;
    case "jira.attach":
      return `jira attach      ${ref(a.key)} ${a.name} (${size(a)})${after}`;
    case "jira.createSprint":
      return `sprint create    board ${a.boardId} ${text(a.name)}${after}`;
    case "jira.updateSprint":
      return `sprint update    ${ref(a.id)} ${a.state ? `→ ${a.state}` : Object.keys(a).filter((k) => k !== "id").join(", ")}${after}`;
    case "jira.moveToSprint":
      return `sprint add       ${ref(a.sprintId)} ← ${(a.keys as string[]).map(ref).join(", ")}${after}`;
    case "jira.request":
      return `jira REST        ${a.method} ${a.path}${a.body !== undefined ? ` (${bytes(JSON.stringify(a.body).length)} body)` : ""}${after}`;
    case "confluence.request":
      return `page REST        ${a.method} ${a.path}${a.body !== undefined ? ` (${bytes(JSON.stringify(a.body).length)} body)` : ""}${after}`;
    case "jira.updateComment":
      return `jira comment     ${ref(a.key)} edit ${a.id} ${"raw" in a ? "(raw)" : text(a.markdown)}${after}`;
    case "jira.deleteComment":
      return `jira comment     ${ref(a.key)} DELETE ${a.id}${after}`;
    case "jira.addWorklog":
      return `jira worklog     ${ref(a.key)} + ${duration(a.timeSpentSeconds)}${a.started ? ` at ${a.started}` : ""}${a.comment ? ` ${text(a.comment)}` : ""}${after}`;
    case "jira.createVersion":
      return `version create   ${a.project} ${text(a.name)}${versionExtras(a)}${after}`;
    case "jira.updateVersion":
      return `version update   ${ref(a.id)}${versionExtras(a)}${a.name ? ` name ${text(a.name)}` : ""}${after}`;
    case "jira.createComponent":
      return `component create ${a.project} ${text(a.name)}${a.leadQuery ? ` lead ${a.leadQuery}` : ""}${after}`;
    case "jira.updateComponent":
      return `component update ${ref(a.id)} ${Object.keys(a).filter((k) => k !== "id" && k !== "lead").map((k) => (k === "leadQuery" ? "lead" : k)).join(", ")}${after}`;
    case "jira.rank":
      return `jira rank        ${(a.keys as string[]).map(ref).join(", ")} ${a.before !== undefined ? `before ${ref(a.before)}` : `after ${ref(a.after)}`}${after}`;
    case "jira.deleteIssue":
      return `jira DELETE      ${ref(a.key)}${a.subtasks ? " with subtasks" : ""}${after}`;
    case "jira.clone":
      return `jira clone       ${ref(a.key)}${a.project ? ` into ${a.project}` : ""}${a.summary ? ` ${text(a.summary)}` : ""}${a.attachments ? " with attachments" : ""}${after}`;
    case "jira.unlink":
      return `jira unlink      ${ref(a.key)} link ${a.linkId}${after}`;
    case "confluence.setProperty":
      return `page property    ${ref(a.pageId)} ${a.key} = ${text(JSON.stringify(a.value), 40)}${after}`;
    case "confluence.deleteProperty":
      return `page property    ${ref(a.pageId)} DELETE ${a.key}${after}`;
    case "confluence.setRestrictions":
      return `page restrict    ${ref(a.pageId)} ${["read", "update"].filter((k) => a[k]).map((k) => `${k}: ${a[k].accountIds.length} user(s), ${a[k].groupIds.length} group(s)`).join("; ")}${after}`;
    case "confluence.createBlogPost":
      return `blog create      ${a.spaceKey} ${text(a.title)}${after}`;
    case "http.request":
      return `http             ${a.method} ${String(a.url).replace(/\?.*$/, "")}${a.body !== undefined ? ` (${bytes(Buffer.byteLength(a.body))} body)` : ""}${after}`;
    case "files.write":
      return `file write       ${a.path} (${size(a)})${after}`;
    case "state.set":
      return `state set        ${a.store}/${a.stateKey} = ${text(JSON.stringify(a.value), 40)}${after}`;
    case "state.delete":
      return `state DELETE     ${a.store}/${a.stateKey}${after}`;
  }
}

/** " released 2026-11-01, archived" for version operations. */
function versionExtras(a: Record<string, any>): string {
  const parts = [
    ...(a.released === true ? [`released${a.releaseDate ? ` ${a.releaseDate}` : ""}`] : a.released === false ? ["unreleased"] : []),
    ...(a.released === undefined && a.releaseDate ? [`release date ${a.releaseDate}`] : []),
    ...(a.startDate ? [`start ${a.startDate}`] : []),
    ...(a.archived === true ? ["archived"] : a.archived === false ? ["unarchived"] : []),
    ...(a.description !== undefined ? ["description"] : []),
  ];
  return parts.length ? ` ${parts.join(", ")}` : "";
}

/** 5400 → "1h 30m". */
function duration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return [h ? `${h}h` : "", m ? `${m}m` : ""].filter(Boolean).join(" ") || `${seconds}s`;
}

/** Decoded attachment size for the plan listing. */
function size(a: Record<string, any>): string {
  return bytes(a.encoding === "base64" ? Buffer.from(a.content, "base64").length : Buffer.byteLength(a.content));
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function describePrecondition(pre: ScriptPlanV1["operations"][number]["precondition"] & {}): string {
  switch (pre.kind) {
    case "jira-issue-unchanged":
      return `${pre.key} last updated ${pre.updated}`;
    case "jira-sprint-unchanged":
      return `sprint ${pre.id} ${pre.state}`;
    case "jira-attachment-unchanged":
      return `attachment ${pre.id} still ${bytes(pre.size)}`;
    case "confluence-page-unchanged":
      return `page ${pre.id} at version ${pre.version}`;
    case "confluence-title-absent":
      return `no page "${pre.title}" in ${pre.spaceKey}`;
    case "state-unchanged":
      return `state ${pre.store}/${pre.key} ${pre.digest ? "unchanged" : "unset"}`;
  }
}

async function typeCheck(file: string): Promise<{ status: "ok" } | { status: "skipped"; reason: string } | { status: "errors"; output: string }> {
  let dir = dirname(file);
  let tsconfig: string | undefined;
  for (;;) {
    if (existsSync(join(dir, "tsconfig.json"))) {
      tsconfig = join(dir, "tsconfig.json");
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!tsconfig) return { status: "skipped", reason: "no tsconfig.json; run `atlcli script init`" };
  const tsc = Bun.which("tsc", { cwd: dirname(tsconfig) });
  if (!tsc) return { status: "skipped", reason: "tsc not found on PATH" };
  const proc = Bun.spawn([tsc, "--noEmit", "-p", tsconfig], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return code === 0 ? { status: "ok" } : { status: "errors", output: stdout + stderr };
}

/** Relative when below the working directory, else absolute. */
export function displayPath(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith("..") ? rel : path;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
