import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ERROR_CODES, fail, getFlag, getFlags, hasFlag, output, type OutputOptions, stripControlChars } from "@atlcli/core";
import type { FixtureCall, JiraIssueView, PlannedOperation, ScriptMeta, ScriptRunPlan, SkippedWrite } from "@atlcli/script-runtime";
import {
  connect,
  describeOperation,
  displayPath,
  type Flags,
  loadImports,
  parseParams,
  readSource,
  scriptName,
  transpile,
  transpileModules,
} from "./script.js";
import { type OutputScope, renderInto } from "./output-files.js";
import { parseTemplateFlags, templateValuesFrom } from "./template-flags.js";

const runtime = () => import("@atlcli/script-runtime");
const TEST_SCHEMA = "atlcli.script-test/1" as const;
/** A script that exports `test(plan)` gets it called after each case. */
const TEST_EXPORT = /\bexport\s+(?:async\s+)?function\s+test\b|\bexport\s+const\s+test\b/;

export interface ScriptTestCase {
  name: string;
  params?: Record<string, string | number | boolean>;
  /** The issue a per-issue script runs for. */
  item?: JiraIssueView;
  /** Frozen clock for atlcli.render. */
  now: string;
  vars?: Record<string, unknown>;
  fixture: { calls: FixtureCall[] };
  /** What the plan must be; absent when only `test(plan)` checks it. */
  expect?: Snapshot;
}

/**
 * What a case compares. `outputs`: files the script wrote with atlcli.output,
 * by path, as text (up to 64 KB) or `sha256:<hex>`.
 */
interface Snapshot {
  operations: PlannedOperation[];
  skipped: SkippedWrite[];
  value: unknown;
  outputs?: Record<string, string>;
}

const OUTPUT_TEXT_LIMIT = 64 * 1024;

/** Output files of a test run, kept in memory. */
function memoryOutputs(): { port: OutputScope["port"]; files: Map<string, string> } {
  const files = new Map<string, string>();
  const open = new Map<string, { path: string; text: string }>();
  let next = 0;
  const file = (handle: string) => {
    const f = open.get(handle);
    if (!f) throw new Error("This output file is closed");
    return f;
  };
  return {
    files,
    port: {
      outputOpen: async (path) => {
        if (files.has(path) || [...open.values()].some((f) => f.path === path)) throw new Error(`${path} is already written by this run`);
        const handle = `mem${++next}`;
        open.set(handle, { path, text: "" });
        return handle;
      },
      outputWrite: async (handle, chunk) => {
        file(handle).text += chunk;
      },
      outputRender: (handle, template, options) => renderInto((chunk) => (file(handle).text += chunk), file(handle).path, template, options),
      outputClose: async (handle) => {
        const f = file(handle);
        open.delete(handle);
        files.set(f.path, f.text);
        return { path: f.path, bytes: Buffer.byteLength(f.text, "utf8"), sha256: createHash("sha256").update(f.text).digest("hex") };
      },
    },
  };
}

export interface ScriptTestFile {
  schema: typeof TEST_SCHEMA;
  /** Site the fixture was recorded against (Markdown conversion uses it). */
  baseUrl: string;
  cases: ScriptTestCase[];
}

interface CaseResult {
  script: string;
  case: string;
  status: "passed" | "failed";
  problems: string[];
}

export const testFileFor = (script: string) => join(dirname(script), `${basename(script).replace(/\.[^.]+$/, "")}.test.json`);

/** `atlcli script test <file|dir> [--case] [--update] [--record <name>]`. */
export async function testCommand(args: string[], flags: Flags, opts: OutputOptions): Promise<void> {
  const target = args[0];
  if (!target) fail(opts, 1, ERROR_CODES.USAGE, "Usage: atlcli script test <script.ts | dir> [--case <name>] [--update] [--record <name>]");
  const record = getFlag(flags, "record");
  if (record !== undefined) return recordCase(target, record, flags, opts);
  const scripts = (await stat(target).catch(() => undefined))?.isDirectory() ? await scriptsWithTests(target) : [target];
  if (scripts.length === 0) fail(opts, 1, ERROR_CODES.USAGE, `No *.test.json next to a script in ${target}`);
  const only = getFlag(flags, "case");
  const update = hasFlag(flags, "update");
  const results: CaseResult[] = [];
  for (const script of scripts) results.push(...(await runTests(script, only, update, opts)));
  if (only !== undefined && results.length === 0) fail(opts, 1, ERROR_CODES.USAGE, `No case named "${only}"`);
  const failed = results.filter((r) => r.status === "failed");
  if (opts.json) output({ schemaVersion: "1", results, passed: results.length - failed.length, failed: failed.length }, opts);
  else {
    const lines: string[] = [];
    let current = "";
    for (const r of results) {
      if (r.script !== current) lines.push((current = r.script));
      lines.push(`  ${r.status === "passed" ? "✓" : "✗"} ${r.case}`);
      for (const p of r.problems) lines.push(...p.split("\n").map((l) => `      ${stripControlChars(l)}`));
    }
    lines.push(`${results.length} case${results.length === 1 ? "" : "s"}: ${results.length - failed.length} passed, ${failed.length} failed${update ? " (expectations updated)" : ""}`);
    output(lines.join("\n"), opts);
  }
  // With --update, snapshot differences are rewritten, so what is left failed for real.
  if (failed.length > 0) process.exit(1);
}

async function scriptsWithTests(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".test.json")) continue;
    const parent = (entry as { parentPath?: string }).parentPath ?? dir;
    if (parent.split(/[\\/]/).includes("node_modules")) continue;
    const base = join(parent, entry.name.slice(0, -".test.json".length));
    const script = [`${base}.ts`, `${base}.js`].find((p) => existsSync(p));
    if (script) found.push(script);
  }
  return found.sort();
}

async function readTestFile(path: string, opts: OutputOptions): Promise<ScriptTestFile | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    const file = JSON.parse(await readFile(path, "utf8")) as ScriptTestFile;
    if (file.schema !== TEST_SCHEMA || !Array.isArray(file.cases)) throw new Error(`expected schema ${TEST_SCHEMA} with cases`);
    return file;
  } catch (error) {
    fail(opts, 1, ERROR_CODES.VALIDATION, `${displayPath(path)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const writeTestFile = (path: string, file: ScriptTestFile) => writeFile(path, JSON.stringify(file, null, 2) + "\n", "utf8");

/** The script, its imports and meta, ready to plan. */
async function loadScript(script: string, opts: OutputOptions) {
  const source = await readSource(script, opts);
  const modules = transpileModules(await loadImports(script, source, opts), opts);
  const js = transpile(source, opts);
  const rt = await runtime();
  let meta: ScriptMeta;
  try {
    meta = await rt.inspectScript(js);
  } catch (error) {
    fail(opts, 1, ERROR_CODES.VALIDATION, `${displayPath(script)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { js, modules, meta, name: meta.name ?? scriptName({ path: script }), hasTest: TEST_EXPORT.test(js) };
}

/** The parts of a run a case compares, as plain JSON. */
function snapshot(run: ScriptRunPlan, files: Map<string, string>): Snapshot {
  const plain = JSON.parse(JSON.stringify({ operations: run.operations, skipped: run.skipped, value: run.value })) as Snapshot;
  if (files.size === 0) return plain;
  const outputs = Object.fromEntries(
    [...files].map(([path, text]) => [path, text.length <= OUTPUT_TEXT_LIMIT ? text : `sha256:${createHash("sha256").update(text).digest("hex")}`]),
  );
  return { ...plain, outputs };
}

async function runTests(script: string, only: string | undefined, update: boolean, opts: OutputOptions): Promise<CaseResult[]> {
  const testPath = testFileFor(script);
  const file = await readTestFile(testPath, opts);
  if (!file) fail(opts, 1, ERROR_CODES.USAGE, `${displayPath(script)} has no ${basename(testPath)}; record a case with: atlcli script test ${displayPath(script)} --record <name>`);
  const loaded = await loadScript(script, opts);
  const rt = await runtime();
  const { createCliScriptPort } = await import("./script-port.js");
  const unused = (): never => {
    throw new Error("a script test reads only from its fixture");
  };
  const base = createCliScriptPort(unused, unused, file.baseUrl, { profileName: "test" });
  const results: CaseResult[] = [];
  let changed = false;
  for (const c of file.cases) {
    if (only !== undefined && c.name !== only) continue;
    const problems: string[] = [];
    const outputs = memoryOutputs();
    const plan = (entry?: { name: string; item: unknown }) => {
      const { port } = rt.replayPort(c.fixture.calls, { ...base, ...outputs.port });
      return rt.planScript(loaded.js, {
        port,
        modules: loaded.modules,
        name: loaded.name,
        ...(c.params ? { params: c.params } : {}),
        ...(entry
          ? { entry: entry.name, item: entry.item, prelude: "globalThis.__atlcliArgs = (plan) => [plan];" }
          : c.item !== undefined
            ? { item: c.item }
            : {}),
        templating: { vars: c.vars ?? {}, now: c.now, strict: false },
        limits: { deadlineMs: 60_000 },
        onLog: (level, message) => {
          if (!opts.json) process.stderr.write(`${c.name}: ${level === "info" ? "" : `${level}: `}${stripControlChars(message)}\n`);
        },
      });
    };
    let actual: Snapshot | undefined;
    try {
      actual = snapshot(await plan(), outputs.files);
    } catch (error) {
      problems.push(`The script failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (actual) {
      if (update) {
        c.expect = actual;
        changed = true;
      } else if (c.expect) problems.push(...compare(c.expect, actual));
      if (loaded.hasTest) {
        try {
          await plan({ name: "test", item: actual });
        } catch (error) {
          problems.push(`test(plan) failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (!c.expect) problems.push("Nothing to check: the case has no expect and the script exports no test(plan)");
    }
    results.push({ script: displayPath(resolve(script)), case: c.name, status: problems.length ? "failed" : "passed", problems });
  }
  if (changed) await writeTestFile(testPath, file);
  return results;
}

/** Differences between an expected and an actual plan, one readable entry each. */
export function compare(expected: NonNullable<ScriptTestCase["expect"]>, actual: NonNullable<ScriptTestCase["expect"]>): string[] {
  const problems: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  const n = Math.max(expected.operations.length, actual.operations.length);
  const ops: string[] = [];
  for (let i = 0; i < n; i++) {
    const e = expected.operations[i];
    const a = actual.operations[i];
    if (e && a && same(e, a)) continue;
    const show = (op: PlannedOperation) => {
      const text = describeOperation(op).trim();
      return e && a && describeOperation(e) === describeOperation(a) ? `${text} ${JSON.stringify(canonical(op.args))}${op.precondition ? ` if ${JSON.stringify(op.precondition)}` : ""}` : text;
    };
    if (e) ops.push(`- #${i + 1} ${show(e)}`);
    if (a) ops.push(`+ #${i + 1} ${show(a)}`);
  }
  if (ops.length) problems.push(`Operations differ (- expected, + actual):\n${ops.join("\n")}`);
  if (!same(expected.skipped, actual.skipped)) {
    problems.push(`Unchanged writes differ:\n- ${JSON.stringify(expected.skipped)}\n+ ${JSON.stringify(actual.skipped)}`);
  }
  if (!same(expected.value, actual.value)) problems.push(`Result differs:\n- ${JSON.stringify(expected.value)}\n+ ${JSON.stringify(actual.value)}`);
  const want = expected.outputs ?? {};
  const got = actual.outputs ?? {};
  for (const path of [...new Set([...Object.keys(want), ...Object.keys(got)])].sort()) {
    if (want[path] === got[path]) continue;
    if (!(path in got)) problems.push(`Output ${path} was not written`);
    else if (!(path in want)) problems.push(`Output ${path} was written but is not expected`);
    else problems.push(`Output ${path} differs:\n- ${JSON.stringify(want[path]).slice(0, 400)}\n+ ${JSON.stringify(got[path]).slice(0, 400)}`);
  }
  return problems;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

/** `--record <name>`: plans once against the live site (never applies) and stores what it read and planned. */
async function recordCase(script: string, name: string, flags: Flags, opts: OutputOptions): Promise<void> {
  if (!name) fail(opts, 1, ERROR_CODES.USAGE, "--record needs a case name");
  const loaded = await loadScript(script, opts);
  const rt = await runtime();
  const { profile, port: live } = await connect(flags, opts);
  const params = parseParams(getFlags(flags, "param"), opts);
  const templating = templateValuesFrom(await parseTemplateFlags(flags, opts));
  const secrets = new Map<string, string>();
  for (const secret of loaded.meta.secrets ?? []) {
    const value = live.secret?.(secret);
    if (value) secrets.set(value, secret);
  }
  const each = getFlag(flags, "each");
  let item: JiraIssueView | undefined;
  if (each !== undefined) {
    const { DEFAULT_EACH_FIELDS } = await import("./script-jobs.js");
    try {
      item = await live.jiraGetIssue(each, { fields: loaded.meta.each?.fields ?? DEFAULT_EACH_FIELDS });
    } catch (error) {
      fail(opts, 1, ERROR_CODES.API, `Cannot read ${each}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const outputs = memoryOutputs();
  const { port, calls } = rt.recordingPort({ ...live, ...outputs.port }, secrets);
  let run: ScriptRunPlan;
  try {
    run = await rt.planScript(loaded.js, {
      port,
      modules: loaded.modules,
      name: loaded.name,
      params,
      ...(item ? { item } : {}),
      templating,
      onLog: (level, message) => process.stderr.write(`${level === "info" ? "" : `${level}: `}${stripControlChars(message)}\n`),
    });
  } catch (error) {
    fail(opts, 1, ERROR_CODES.VALIDATION, `Script failed while recording: ${error instanceof Error ? error.message : String(error)}`);
  }
  const testPath = testFileFor(script);
  const file: ScriptTestFile = (await readTestFile(testPath, opts)) ?? { schema: TEST_SCHEMA, baseUrl: profile.baseUrl, cases: [] };
  const c: ScriptTestCase = {
    name,
    ...(Object.keys(run.params).length ? { params: run.params } : {}),
    ...(item ? { item } : {}),
    now: templating.now,
    ...(Object.keys(templating.vars).length ? { vars: templating.vars } : {}),
    fixture: { calls },
    expect: snapshot(run, outputs.files),
  };
  const at = file.cases.findIndex((x) => x.name === name);
  if (at >= 0) file.cases[at] = c;
  else file.cases.push(c);
  await writeTestFile(testPath, file);
  const summary = { file: displayPath(testPath), case: name, calls: calls.length, operations: run.operations.length, replaced: at >= 0 };
  if (opts.json) output({ schemaVersion: "1", recorded: summary }, opts);
  else {
    output(
      `${at >= 0 ? "Re-recorded" : "Recorded"} case "${name}" in ${summary.file}: ${calls.length} read${calls.length === 1 ? "" : "s"}, ${run.operations.length} planned operation${run.operations.length === 1 ? "" : "s"}. Nothing was changed.\n` +
        "The fixture holds what the script read from the site; review it before you commit it.",
      opts,
    );
  }
}
