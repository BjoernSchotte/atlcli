import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
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
} from "@atlcli/script-runtime";
import { assertCliAuthSupported } from "./session-guard.js";

type Flags = Record<string, string | boolean | string[]>;

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

No imports, no boilerplate: atlcli.* is always there. Add
\`export const meta = { … }\` only to restrict permissions or declare typed params.

Commands:
  run <file>             Run the script and show the plan (dry run)
  run -e <code>          Run inline code instead of a file
  apply <plan.json>      Apply a plan written with run --plan-out
  check <file>           Validate meta and type-check (needs tsc on PATH)
  init [dir]             Write atlcli.d.ts, tsconfig.json and an example script

Options for run:
  --param <name=value>   Script parameter, repeatable (available as atlcli.params)
  --plan-out <file>      Write the plan as JSON (for review, CI artifacts, apply)
  --apply                Apply the plan right away (asks first)
  --yes                  Apply without asking (required without a terminal or with --json)
  --profile <name>       Profile to run against
  --json                 Machine-readable output

Limits for run (defaults in parentheses):
  --timeout <duration>   Whole run, e.g. 90s, 10m, 1h; a bare number is seconds (5m)
  --max-writes <n>       Operations per plan; overrides meta.limits.maxWrites (100)
  --max-calls <n>        Jira/Confluence calls per run (10000)
  --memory <MB>          Script memory (64)

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
    case "apply":
      return applyCommand(rest, flags, opts);
    case "check":
      return checkCommand(rest, opts);
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
  const { profile, port } = await connect(flags, opts);
  const rt = await runtime();

  const run = await guard(opts, () =>
    rt.planScript(transpile(source, opts), {
      port,
      params,
      limits,
      ...(maxWrites !== undefined ? { maxWrites } : {}),
      onLog: (level, message) => process.stderr.write(`${level === "info" ? "" : `${level}: `}${stripControlChars(message)}\n`),
    }),
  );
  const plan = await rt.createScriptPlan(run, {
    source,
    ...(file ? { path: relative(process.cwd(), resolve(file)) } : { name: "inline" }),
    baseUrl: profile.baseUrl,
    profile: profile.name,
  });
  const planOut = getFlag(flags, "plan-out");
  if (planOut) await writeFile(planOut, rt.serializeScriptPlan(plan), "utf8");

  const apply = hasFlag(flags, "apply");
  if (!apply || plan.operations.length === 0) {
    if (opts.json) output({ schemaVersion: "1", plan }, opts);
    else output(renderPlan(plan, planOut, apply), opts);
    return;
  }
  if (!opts.json) output(renderPlan(plan, planOut, true), opts);
  await confirmApply(plan, flags, opts);
  const report = await rt.applyScriptPlan(plan, { port, baseUrl: profile.baseUrl, onOperation: progress(opts) });
  finish(plan, report, opts);
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
  if (!opts.json) output(renderPlan(plan, undefined, true), opts);
  await confirmApply(plan, flags, opts);
  const report = await rt.applyScriptPlan(plan, { port, baseUrl: profile.baseUrl, onOperation: progress(opts) });
  finish(plan, report, opts);
}

async function checkCommand(args: string[], opts: OutputOptions): Promise<void> {
  const file = args[0];
  if (!file) fail(opts, 1, ERROR_CODES.USAGE, "Usage: atlcli script check <file>");
  const source = await readSource(file, opts);
  const rt = await runtime();
  const meta = await guard(opts, () => rt.inspectScript(transpile(source, opts)));
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

const TSCONFIG = `{
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
    "skipLibCheck": true
  },
  "include": ["*.ts"]
}
`;

async function initCommand(args: string[], flags: Flags, opts: OutputOptions): Promise<void> {
  const dir = resolve(args[0] ?? ".");
  await mkdir(dir, { recursive: true });
  const { ATLCLI_SCRIPT_TYPES } = await runtime();
  const force = hasFlag(flags, "force");
  const files: Array<[string, string]> = [
    ["atlcli.d.ts", ATLCLI_SCRIPT_TYPES],
    ["tsconfig.json", TSCONFIG],
    ["example.ts", EXAMPLE],
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
        `Next: atlcli script run ${displayPath(join(dir, "example.ts"))}`,
      ].join("\n"),
      opts,
    );
  }
}

// ============ Helpers ============

async function readSource(file: string, opts: OutputOptions): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    fail(opts, 1, ERROR_CODES.IO, `Cannot read ${file}: ${messageOf(error)}`);
  }
}

/** Type stripping only; scripts are erasable-syntax TypeScript or plain JavaScript. */
function transpile(source: string, opts: OutputOptions): string {
  try {
    return new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(source);
  } catch (error) {
    fail(opts, 1, ERROR_CODES.VALIDATION, `Script does not parse: ${messageOf(error)}`);
  }
}

/** `--timeout`, `--memory`, `--max-calls`, `--max-writes`; unset flags keep the runtime defaults. */
function parseLimits(
  flags: Flags,
  opts: OutputOptions,
): { limits: { deadlineMs?: number; memoryBytes?: number; maxHostCalls?: number }; maxWrites?: number } {
  const count = (name: string): number | undefined => {
    const raw = getFlag(flags, name);
    if (raw === undefined) return undefined;
    if (!/^[1-9]\d*$/.test(raw)) fail(opts, 1, ERROR_CODES.USAGE, `--${name} expects a positive whole number, got "${raw}"`);
    return Number(raw);
  };
  const limits: { deadlineMs?: number; memoryBytes?: number; maxHostCalls?: number } = {};
  const timeout = getFlag(flags, "timeout");
  if (timeout !== undefined) {
    const match = /^([1-9]\d*)(ms|s|m|h)?$/.exec(timeout);
    if (!match) fail(opts, 1, ERROR_CODES.USAGE, `--timeout expects a duration like 90s, 10m or 1h, got "${timeout}"`);
    const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[(match[2] ?? "s") as "ms" | "s" | "m" | "h"];
    limits.deadlineMs = Number(match[1]) * unit;
  }
  const memory = count("memory");
  if (memory !== undefined) limits.memoryBytes = memory * 1024 * 1024;
  const calls = count("max-calls");
  if (calls !== undefined) limits.maxHostCalls = calls;
  const maxWrites = count("max-writes");
  return { limits, ...(maxWrites !== undefined ? { maxWrites } : {}) };
}

function parseParams(raw: string[], opts: OutputOptions): Record<string, string> {
  const params: Record<string, string> = {};
  for (const entry of raw) {
    const eq = entry.indexOf("=");
    if (eq <= 0) fail(opts, 1, ERROR_CODES.USAGE, `--param expects name=value, got "${entry}"`);
    params[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return params;
}

async function connect(flags: Flags, opts: OutputOptions): Promise<{ profile: Profile; port: ScriptPort }> {
  const config = await loadConfig();
  const profile = getActiveProfile(config, getFlag(flags, "profile"));
  if (!profile) fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.");
  assertCliAuthSupported(profile, opts);
  const { createLazyCliScriptPort } = await import("./script-port.js");
  return { profile, port: createLazyCliScriptPort(profile) };
}

/** Script errors (invalid meta, limits, denied permissions, guest exceptions) as CLI failures. */
async function guard<T>(opts: OutputOptions, fn: () => Promise<T>): Promise<T> {
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

async function confirmApply(plan: ScriptPlanV1, flags: Flags, opts: OutputOptions): Promise<void> {
  if (hasFlag(flags, "yes")) return;
  if (opts.json || !process.stdin.isTTY) {
    fail(opts, 1, ERROR_CODES.USAGE, "Applying needs confirmation: pass --yes (required without a terminal or with --json).");
  }
  const n = plan.operations.length;
  if (!(await promptConfirm(`Apply ${n} operation${n === 1 ? "" : "s"} to ${plan.target.baseUrl}?`))) {
    fail(opts, 1, ERROR_CODES.USAGE, "Not applied.");
  }
}

function progress(opts: OutputOptions) {
  return (r: { seq: number; status: string; error?: string }) => {
    if (opts.json) return;
    if (r.status === "applied") process.stderr.write(`  ✓ ${r.seq}\n`);
    if (r.status === "failed") process.stderr.write(`  ✗ ${r.seq}: ${stripControlChars(r.error ?? "")}\n`);
  };
}

function finish(plan: ScriptPlanV1, report: ApplyReport, opts: OutputOptions): void {
  if (report.status === "drift") {
    const lines = report.drift.map((d) => `  #${d.seq} ${describePrecondition(d.precondition)}: now ${d.actual}`);
    fail(opts, 2, ERROR_CODES.VALIDATION, ["Targets changed since the plan was made; nothing was written:", ...lines, "Re-run the script to plan again."].join("\n"), {
      report,
    });
  }
  if (report.status === "failed") {
    const failed = report.operations.find((o) => o.status === "failed")!;
    const done = report.operations.filter((o) => o.status === "applied").length;
    fail(opts, 1, ERROR_CODES.API, `Operation #${failed.seq} failed: ${failed.error}. ${done} of ${plan.operations.length} operations were applied; the rest were skipped.`, {
      report,
    });
  }
  if (opts.json) output({ schemaVersion: "1", plan, report }, opts);
  else output(`Applied ${report.operations.length} operation${report.operations.length === 1 ? "" : "s"}.${createdSummary(report)}`, opts);
}

function createdSummary(report: ApplyReport): string {
  const created = report.operations
    .filter((o) => o.status === "applied" && (o.verb === "jira.create" || o.verb === "confluence.createPage"))
    .map((o) => String(o.result?.key ?? o.result?.id));
  return created.length ? ` Created: ${created.join(", ")}` : "";
}

export function renderPlan(plan: ScriptPlanV1, planOut: string | undefined, applying: boolean): string {
  const n = plan.operations.length;
  const lines = [`${plan.script.name} → ${plan.target.baseUrl}${plan.target.profile ? ` (profile ${plan.target.profile})` : ""}`];
  if (n === 0) lines.push("No changes planned.");
  else {
    lines.push(`Plan: ${n} operation${n === 1 ? "" : "s"}`);
    for (const op of plan.operations) lines.push(`  ${String(op.seq).padStart(3)}  ${describeOperation(op)}`);
  }
  if (plan.skipped.length > 0) {
    lines.push(`Unchanged, not planned: ${plan.skipped.length}`);
    for (const skip of plan.skipped) lines.push(`       page ${skip.target}${skip.title ? ` ${JSON.stringify(skip.title)}` : ""} (same content)`);
  }
  if (plan.value !== null) lines.push(`Result: ${JSON.stringify(plan.value)}`);
  if (planOut) lines.push(`Plan written to ${planOut} (digest ${plan.digest.slice(0, 12)})`);
  if (n > 0 && !applying) lines.push("Nothing was changed. Apply with --apply, or: atlcli script apply <plan.json>");
  return lines.join("\n");
}

function describeOperation(op: PlannedOperation): string {
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
      return `jira transition  ${ref(a.key)} → ${a.transition}${after}`;
    case "jira.comment":
      return `jira comment     ${ref(a.key)} ${text(a.markdown)}${after}`;
    case "confluence.createPage":
      return `page create      ${a.spaceKey} ${text(a.title)}${a.parentId ? ` under ${ref(a.parentId)}` : ""}${after}`;
    case "confluence.updatePage":
      return `page update      ${ref(a.id)} ${text(a.title)}${after}`;
    case "confluence.addLabels":
      return `page labels      ${ref(a.pageId)} + ${(a.labels as string[]).join(", ")}${after}`;
  }
}

function describePrecondition(pre: ScriptPlanV1["operations"][number]["precondition"] & {}): string {
  switch (pre.kind) {
    case "jira-issue-unchanged":
      return `${pre.key} last updated ${pre.updated}`;
    case "confluence-page-unchanged":
      return `page ${pre.id} at version ${pre.version}`;
    case "confluence-title-absent":
      return `no page "${pre.title}" in ${pre.spaceKey}`;
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
function displayPath(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith("..") ? rel : path;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
