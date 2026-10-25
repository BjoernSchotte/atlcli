/**
 * Per-issue script runs (`atlcli script run x.ts --each "<jql>"`) as resumable
 * jobs. A job snapshots the matching issue ids once, then runs the script once
 * per issue, a batch at a time, and records every outcome as a JSON line under
 * `~/.atlcli/jobs/<id>/`. Nothing is kept in memory but counters, so tens of
 * thousands of issues are fine, and an interrupted job continues where it
 * stopped (`atlcli script resume <id>`).
 *
 * Two modes:
 * - plan (default): every issue's plan goes to plans.jsonl, nothing changes;
 *   `atlcli script apply <id>` applies them later.
 * - stream (`--apply`): each issue is planned and applied right away.
 */
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ERROR_CODES, fail, getFlag, hasFlag, output, type OutputOptions, promptConfirm, stripControlChars } from "@atlcli/core";
import type { JiraIssueView, PlannedOperation, ScriptMeta, ScriptPort, Templating } from "@atlcli/script-runtime";
import { connect, describeOperation, displayPath, type Flags, guard, parseConcurrency, parseLimits, readSource, transpile } from "./script.js";

const runtime = () => import("@atlcli/script-runtime");

export const JOB_SCHEMA = "atlcli.script-job/1" as const;
/** Fields each issue comes with unless meta.each.fields says otherwise. */
export const DEFAULT_EACH_FIELDS = ["summary", "status", "assignee", "priority", "issuetype", "labels"];
/** Limits per issue unless flags say otherwise. */
const EACH_LIMITS = { deadlineMs: 60_000, maxHostCalls: 500 };
const EACH_MAX_WRITES = 50;
// ponytail: one fresh QuickJS runtime per issue (isolation, per-issue limits).
// Under Bun the process RSS climbs to a plateau of about 1.2 GB however many
// issues run (2k and 20k measured alike; WASM and JS heaps stay flat). Reuse a
// runtime per worker if that plateau ever matters.
const BATCH = 100;

type Phase = "planning" | "planned" | "applying";

export interface ScriptJob {
  schema: typeof JOB_SCHEMA;
  id: string;
  createdAt: string;
  updatedAt: string;
  script: { name: string; path?: string; sha256: string };
  params: Record<string, string | number | boolean>;
  jql: string;
  fields: string[];
  target: { baseUrl: string; profile: string };
  /** plan: review first, apply with `script apply <id>`; stream: plan and apply each issue at once. */
  mode: "plan" | "stream";
  phase: Phase;
  /** Why the last run stopped early (signal, failure threshold); absent when it ran through. */
  stopped?: string;
  limits: { deadlineMs?: number; memoryBytes?: number; maxHostCalls?: number; maxWrites?: number };
  concurrency: number;
  maxFailures: string;
  templating?: Templating;
  total: number;
  /** SHA-256 of plans.jsonl once planning finished; apply refuses an edited file. */
  plansDigest?: string;
}

/** One line of plans.jsonl (planning) or results.jsonl (applying). */
interface Outcome {
  id: string;
  key: string;
  status: "planned" | "unchanged" | "applied" | "drift" | "failed" | "error" | "gone";
  operations?: PlannedOperation[];
  ops?: number;
  value?: unknown;
  error?: string;
}

/** Statuses after which an issue is done; anything else is retried on resume. */
const FINISHED = new Set<Outcome["status"]>(["planned", "unchanged", "applied", "gone"]);

export const jobsRoot = () => join(homedir(), ".atlcli", "jobs");
const jobDir = (id: string) => join(jobsRoot(), id);
const file = (job: ScriptJob, name: "job.json" | "items.jsonl" | "plans.jsonl" | "results.jsonl" | "script.ts") => join(jobDir(job.id), name);
const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

// ============ Entry points ============

/** `script run x.ts --each ["<jql>"]`, or a script with meta.each. */
export async function runEach(
  source: string,
  origin: { path: string } | { name: string },
  meta: ScriptMeta,
  params: Record<string, string>,
  templating: Templating | undefined,
  flags: Flags,
  opts: OutputOptions,
): Promise<void> {
  const flagJql = typeof flags.each === "string" ? flags.each : undefined;
  const jql = flagJql ?? meta.each?.jql;
  if (!jql) fail(opts, 1, ERROR_CODES.USAGE, 'Per-issue mode needs a query: --each "<jql>" or meta.each.jql.');
  const rt = await runtime();
  let resolvedParams: Record<string, string | number | boolean>;
  try {
    resolvedParams = rt.resolveScriptParams(meta, params);
  } catch (error) {
    fail(opts, 1, ERROR_CODES.USAGE, error instanceof Error ? error.message : String(error));
  }
  const { limits, maxWrites } = parseLimits(flags, opts);
  const { profile, port } = await connect(flags, opts);
  const name = meta.name ?? ("path" in origin ? origin.path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "") : origin.name);
  const now = new Date();
  const job: ScriptJob = {
    schema: JOB_SCHEMA,
    id: `${now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}-${name.replace(/[^a-z0-9-]/gi, "").toLowerCase() || "script"}-${randomBytes(2).toString("hex")}`,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    script: { name, ...("path" in origin ? { path: origin.path } : {}), sha256: sha256(source) },
    params: resolvedParams,
    jql,
    fields: meta.each?.fields ?? DEFAULT_EACH_FIELDS,
    target: { baseUrl: profile.baseUrl.replace(/\/+$/, ""), profile: profile.name },
    mode: hasFlag(flags, "apply") ? "stream" : "plan",
    phase: hasFlag(flags, "apply") ? "applying" : "planning",
    limits: { ...EACH_LIMITS, ...limits, maxWrites: maxWrites ?? EACH_MAX_WRITES },
    concurrency: parseConcurrency(flags, opts, 4),
    maxFailures: parseMaxFailures(getFlag(flags, "max-failures") ?? "10%", opts),
    ...(templating ? { templating } : {}),
    total: 0,
  };
  // The script must at least parse and carry valid meta before any snapshot.
  await guard(opts, () => rt.inspectScript(transpile(source, opts)));

  await mkdir(jobDir(job.id), { recursive: true });
  await writeFile(file(job, "script.ts"), source, "utf8");
  job.total = await snapshot(job, port, opts);
  await saveJob(job);
  if (job.mode === "stream") await confirmStream(job, flags, opts);
  await processJob(job, source, port, flags, opts);
}

/** `script resume <id> [--script file]`: continues planning or applying. */
export async function resumeCommand(args: string[], flags: Flags, opts: OutputOptions): Promise<void> {
  const job = await loadJob(args[0], opts);
  if (job.phase === "planned") {
    fail(opts, 1, ERROR_CODES.USAGE, `Job ${job.id} is fully planned. Apply it with: atlcli script apply ${job.id}`);
  }
  const replacement = getFlag(flags, "script");
  if (replacement && job.mode === "plan" && job.phase === "applying") {
    fail(opts, 1, ERROR_CODES.USAGE, "This job applies reviewed plans; the script cannot change any more.");
  }
  let source = await readFile(file(job, "script.ts"), "utf8");
  if (replacement) {
    source = await readSource(replacement, opts);
    job.script.sha256 = sha256(source);
    await writeFile(file(job, "script.ts"), source, "utf8");
  }
  job.concurrency = parseConcurrency(flags, opts, job.concurrency);
  const maxFailures = getFlag(flags, "max-failures");
  if (maxFailures !== undefined) job.maxFailures = parseMaxFailures(maxFailures, opts);
  const { profile, port } = await connect({ ...flags, profile: job.target.profile }, opts);
  checkTarget(job, profile.baseUrl, opts);
  if (job.mode === "plan" && job.phase === "applying") return applyPlannedJob(job, port, flags, opts, true);
  await processJob(job, source, port, flags, opts);
}

/** `script apply <job-id>`: applies a planned job's reviewed plans (continues a partial apply). */
export async function applyJobCommand(idOrDir: string, flags: Flags, opts: OutputOptions): Promise<void> {
  const job = await loadJob(idOrDir, opts);
  if (job.mode === "stream") fail(opts, 1, ERROR_CODES.USAGE, `Job ${job.id} applies as it runs; continue it with: atlcli script resume ${job.id}`);
  if (job.phase === "planning") {
    fail(opts, 1, ERROR_CODES.USAGE, `Job ${job.id} is not fully planned yet; finish it first: atlcli script resume ${job.id}`);
  }
  const { profile, port } = await connect({ ...flags, profile: job.target.profile }, opts);
  checkTarget(job, profile.baseUrl, opts);
  if (job.plansDigest !== sha256(await readFile(file(job, "plans.jsonl"), "utf8").catch(() => ""))) {
    fail(opts, 1, ERROR_CODES.VALIDATION, `The plans of job ${job.id} were modified after planning; re-run the script to plan again.`);
  }
  await applyPlannedJob(job, port, flags, opts, job.phase === "applying");
}

/** `script jobs [id]`. */
export async function jobsCommand(args: string[], opts: OutputOptions): Promise<void> {
  if (args[0]) {
    const job = await loadJob(args[0], opts);
    const counts = await countOutcomes(job);
    const samples = (await readOutcomes(job, job.phase === "planning" || job.phase === "planned" ? "plans.jsonl" : "results.jsonl"))
      .filter((o) => !FINISHED.has(o.status))
      .slice(0, 20);
    if (opts.json) {
      output({ schemaVersion: "1", job, counts, errors: samples }, opts);
      return;
    }
    output(
      [
        `${job.id}  ${job.script.name} → ${job.target.baseUrl} (profile ${job.target.profile})`,
        `Query: ${job.jql}`,
        `Mode: ${job.mode}, phase: ${job.phase}${job.stopped ? `, stopped: ${job.stopped}` : ""}`,
        `Issues: ${job.total} · ${formatCounts(counts.byStatus)}`,
        ...(samples.length ? ["Not done:", ...samples.map((o) => `  ${o.key} ${o.status}${o.error ? `: ${stripControlChars(o.error)}` : ""}`)] : []),
        nextStep(job, counts),
      ].join("\n"),
      opts,
    );
    return;
  }
  const ids = existsSync(jobsRoot()) ? (await readdir(jobsRoot())).sort().reverse() : [];
  const jobs: ScriptJob[] = [];
  for (const id of ids) {
    try {
      jobs.push(JSON.parse(await readFile(join(jobsRoot(), id, "job.json"), "utf8")));
    } catch {}
  }
  if (opts.json) {
    output({ schemaVersion: "1", jobs }, opts);
    return;
  }
  if (jobs.length === 0) {
    output("No script jobs yet. Start one with: atlcli script run <file> --each \"<jql>\"", opts);
    return;
  }
  const lines = [];
  for (const job of jobs) {
    const counts = await countOutcomes(job);
    lines.push(`${job.id}  ${job.mode}/${job.phase}${job.stopped ? " (stopped)" : ""}  ${counts.done}/${job.total}  ${job.script.name}`);
  }
  output(lines.join("\n"), opts);
}

// ============ Running ============

/** Ids and keys of every matching issue, written once; the job works off this list. */
async function snapshot(job: ScriptJob, port: ScriptPort, opts: OutputOptions): Promise<number> {
  const lines: string[] = [];
  let token: string | undefined;
  do {
    let page;
    try {
      page = await port.jiraSearch(job.jql, { fields: ["key"], maxResults: 1000, ...(token ? { pageToken: token } : {}) });
    } catch (error) {
      fail(opts, 1, ERROR_CODES.API, `Query failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const issue of page.issues) lines.push(JSON.stringify({ id: issue.id, key: issue.key }));
    token = page.nextPageToken;
    if (!opts.json && lines.length % 5000 < page.issues.length && lines.length >= 5000) {
      process.stderr.write(`  snapshot: ${lines.length} issues…\n`);
    }
  } while (token);
  await writeFile(file(job, "items.jsonl"), lines.length ? lines.join("\n") + "\n" : "", "utf8");
  return lines.length;
}

async function confirmStream(job: ScriptJob, flags: Flags, opts: OutputOptions): Promise<void> {
  if (hasFlag(flags, "yes") || job.total === 0) return;
  if (opts.json || !process.stdin.isTTY) {
    fail(opts, 1, ERROR_CODES.USAGE, `Applying needs confirmation: pass --yes (required without a terminal or with --json). Job ${job.id} is kept.`);
  }
  if (!(await promptConfirm(`Run ${job.script.name} on ${job.total} issues of ${job.target.baseUrl} and apply each issue's changes right away?`))) {
    fail(opts, 1, ERROR_CODES.USAGE, `Not applied. Review first without --apply, or continue later: atlcli script resume ${job.id} --yes`);
  }
}

interface Tally {
  [status: string]: number;
}

/** Plans (and in stream mode applies) every issue not done yet. */
async function processJob(job: ScriptJob, source: string, port: ScriptPort, flags: Flags, opts: OutputOptions): Promise<void> {
  const rt = await runtime();
  const js = transpile(source, opts);
  const out = job.mode === "plan" ? "plans.jsonl" : "results.jsonl";
  const finished = await finishedIds(job, out);
  const items = (await readItems(job)).filter((item) => !finished.has(item.id));
  const maxItems = getFlag(flags, "max-items");
  const todo = maxItems && /^[1-9]\d*$/.test(maxItems) ? items.slice(0, Number(maxItems)) : items;
  const threshold = failureLimit(job.maxFailures, todo.length);
  const memo = new Map<string, Promise<unknown>>();
  const tally: Tally = {};
  const verbs = new Map<string, number>();
  const firstOps: string[] = [];
  const stop = stopper(job, opts);
  let failures = 0;
  let processed = 0;
  job.stopped = undefined;
  await saveJob(job);

  for (let start = 0; start < todo.length && !stop.reason; start += BATCH) {
    const batch = todo.slice(start, start + BATCH);
    const issues = await fetchBatch(port, batch, job.fields);
    await rt.pool(batch, job.concurrency, async (item) => {
      if (stop.reason) return;
      const issue = issues.get(item.id);
      let outcome: Outcome;
      if (!issue) outcome = { ...item, status: "gone", error: "issue no longer exists or is not visible" };
      else outcome = await runItem(rt, job, js, port, issue, memo, opts);
      if (outcome.operations) {
        for (const op of outcome.operations) {
          verbs.set(op.verb, (verbs.get(op.verb) ?? 0) + 1);
          if (firstOps.length < 20) firstOps.push(`${outcome.key.padEnd(12)} ${describeOperation(op)}`);
        }
      }
      appendFileSync(file(job, out), JSON.stringify(outcome) + "\n");
      tally[outcome.status] = (tally[outcome.status] ?? 0) + 1;
      if (outcome.status === "error" || outcome.status === "failed") {
        failures++;
        if (!opts.json) process.stderr.write(`  ✗ ${outcome.key}: ${stripControlChars(outcome.error ?? outcome.status)}\n`);
        // A script that cannot run at all fails the same way for every issue.
        if (outcome.error?.startsWith("invalid-script:")) stop.set("the script is invalid; fix it and continue with resume --script <file>");
        if (failures >= threshold) stop.set(`${failures} failures (limit ${job.maxFailures}; change with --max-failures)`);
      }
      processed++;
      if (!opts.json && processed % 100 === 0) process.stderr.write(`  ${processed}/${todo.length} · ${formatCounts(tally)}\n`);
    });
  }
  stop.dispose();

  job.stopped = stop.reason;
  // Planned once every issue has a plan; errors keep the job open for a fixed script (resume --script).
  if (job.mode === "plan" && (await finishedIds(job, "plans.jsonl")).size === job.total) {
    job.phase = "planned";
    job.plansDigest = sha256(await readFile(file(job, "plans.jsonl"), "utf8").catch(() => ""));
  }
  await saveJob(job);
  report(job, tally, verbs, firstOps, await countOutcomes(job), opts);
}

async function runItem(
  rt: Awaited<ReturnType<typeof runtime>>,
  job: ScriptJob,
  js: string,
  port: ScriptPort,
  issue: JiraIssueView,
  memo: Map<string, Promise<unknown>>,
  opts: OutputOptions,
): Promise<Outcome> {
  const base = { id: issue.id, key: issue.key };
  const { maxWrites, ...limits } = job.limits;
  let run;
  try {
    run = await rt.planScript(js, {
      port,
      item: issue,
      params: job.params,
      limits,
      ...(maxWrites !== undefined ? { maxWrites } : {}),
      memo,
      ...(job.templating ? { templating: job.templating } : {}),
      onLog: (level, message) => {
        if (!opts.json) process.stderr.write(`${issue.key}: ${level === "info" ? "" : `${level}: `}${stripControlChars(message)}\n`);
      },
    });
  } catch (error) {
    const e = error as { kind?: string; message?: string };
    return { ...base, status: "error", error: e.kind ? `${e.kind}: ${e.message}` : String(error) };
  }
  const value = run.value === null ? {} : { value: run.value };
  if (run.operations.length === 0) return { ...base, status: "unchanged", ...value };
  if (job.mode === "plan") return { ...base, status: "planned", operations: run.operations, ...value };
  return applyItem(rt, job, port, base, run.operations, value);
}

async function applyItem(
  rt: Awaited<ReturnType<typeof runtime>>,
  job: ScriptJob,
  port: ScriptPort,
  base: { id: string; key: string },
  operations: PlannedOperation[],
  value: { value?: unknown },
): Promise<Outcome> {
  const report = await rt.applyScriptPlan({ target: { baseUrl: job.target.baseUrl }, operations }, { port, baseUrl: job.target.baseUrl });
  const ops = operations.length;
  if (report.status === "applied") return { ...base, status: "applied", ops, ...value };
  if (report.status === "drift") {
    return { ...base, status: "drift", ops, error: report.drift.map((d) => `#${d.seq} now ${d.actual}`).join("; ") };
  }
  const failed = report.operations.find((o) => o.status === "failed");
  const applied = report.operations.filter((o) => o.status === "applied").length;
  return { ...base, status: "failed", ops, error: `${failed?.verb}: ${failed?.error} (${applied} of ${ops} operations applied)` };
}

/** Applies the reviewed plans of a planned job, a batch of issues at a time. */
async function applyPlannedJob(job: ScriptJob, port: ScriptPort, flags: Flags, opts: OutputOptions, resuming: boolean): Promise<void> {
  const rt = await runtime();
  const finished = await finishedIds(job, "results.jsonl");
  const plans = (await readOutcomes(job, "plans.jsonl")).filter((o) => o.status === "planned" && !finished.has(o.id));
  if (plans.length === 0) {
    output(opts.json ? { schemaVersion: "1", job, counts: await countOutcomes(job) } : "Nothing left to apply.", opts);
    return;
  }
  const operations = plans.reduce((n, p) => n + (p.operations?.length ?? 0), 0);
  if (!opts.json) {
    output(`${resuming ? "Continuing: " : ""}${plans.length} issues, ${operations} operations → ${job.target.baseUrl}`, opts);
  }
  if (!hasFlag(flags, "yes")) {
    if (opts.json || !process.stdin.isTTY) fail(opts, 1, ERROR_CODES.USAGE, "Applying needs confirmation: pass --yes (required without a terminal or with --json).");
    if (!(await promptConfirm(`Apply ${operations} operations on ${plans.length} issues to ${job.target.baseUrl}?`))) fail(opts, 1, ERROR_CODES.USAGE, "Not applied.");
  }
  if (getFlag(flags, "concurrency") !== undefined) job.concurrency = parseConcurrency(flags, opts, job.concurrency);
  const threshold = failureLimit(job.maxFailures, plans.length);
  job.phase = "applying";
  job.stopped = undefined;
  await saveJob(job);
  const stop = stopper(job, opts);
  const tally: Tally = {};
  let failures = 0;
  let processed = 0;
  await rt.pool(plans, job.concurrency, async (plan) => {
    if (stop.reason) return;
    const outcome = await applyItem(rt, job, port, { id: plan.id, key: plan.key }, plan.operations ?? [], {});
    appendFileSync(file(job, "results.jsonl"), JSON.stringify(outcome) + "\n");
    tally[outcome.status] = (tally[outcome.status] ?? 0) + 1;
    if (outcome.status === "failed") {
      failures++;
      if (!opts.json) process.stderr.write(`  ✗ ${outcome.key}: ${stripControlChars(outcome.error ?? "")}\n`);
      if (failures >= threshold) stop.set(`${failures} failures (limit ${job.maxFailures}; change with --max-failures)`);
    }
    processed++;
    if (!opts.json && processed % 100 === 0) process.stderr.write(`  ${processed}/${plans.length} · ${formatCounts(tally)}\n`);
  });
  stop.dispose();
  job.stopped = stop.reason;
  await saveJob(job);
  report(job, tally, new Map(), [], await countOutcomes(job), opts);
}

/** Fetches a batch by id; ids the search does not return are read one by one (gone when unreadable). */
async function fetchBatch(port: ScriptPort, batch: Array<{ id: string; key: string }>, fields: string[]): Promise<Map<string, JiraIssueView>> {
  const found = new Map<string, JiraIssueView>();
  try {
    const page = await port.jiraSearch(`id in (${batch.map((i) => i.id).join(", ")})`, { fields, maxResults: batch.length });
    for (const issue of page.issues) found.set(issue.id, issue);
  } catch {
    // e.g. an id that no longer exists can fail the whole query; fall through to single reads.
  }
  for (const item of batch) {
    if (found.has(item.id)) continue;
    try {
      const issue = await port.jiraGetIssue(item.id, { fields });
      found.set(item.id, issue);
    } catch {}
  }
  return found;
}

/** Ctrl-C stops taking new issues (in-flight ones finish and are recorded); a second one exits. */
function stopper(job: ScriptJob, opts: OutputOptions) {
  const state = {
    reason: undefined as string | undefined,
    set(reason: string) {
      state.reason ??= reason;
    },
    dispose() {
      process.off("SIGINT", onSignal);
    },
  };
  const onSignal = () => {
    if (state.reason) process.exit(130);
    state.set("interrupted");
    if (!opts.json) process.stderr.write(`\nStopping after the issues in progress… (again to quit at once). Continue later: atlcli script resume ${job.id}\n`);
  };
  process.on("SIGINT", onSignal);
  return state;
}

// ============ Reporting ============

function report(job: ScriptJob, tally: Tally, verbs: Map<string, number>, firstOps: string[], counts: Counts, opts: OutputOptions): void {
  const exitCode = job.stopped ? 1 : 0;
  if (opts.json) {
    output({ schemaVersion: "1", job, run: tally, counts, operations: Object.fromEntries(verbs) }, opts);
    if (exitCode) process.exitCode = exitCode;
    return;
  }
  const lines = [`${job.script.name} → ${job.target.baseUrl} (profile ${job.target.profile}) · job ${job.id}`, `Issues: ${job.total} · ${formatCounts(counts.byStatus)}`];
  if (verbs.size > 0) {
    const total = [...verbs.values()].reduce((a, b) => a + b, 0);
    lines.push(`Planned operations this run: ${total} (${[...verbs].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${n} ${v}`).join(", ")})`);
    lines.push(...firstOps.map((op) => `  ${op}`));
    if (total > firstOps.length) lines.push(`  … see ${displayPath(file(job, "plans.jsonl"))} for all of them`);
  }
  if (job.stopped) lines.push(`Stopped: ${job.stopped}.`);
  lines.push(nextStep(job, counts));
  output(lines.join("\n"), opts);
  if (exitCode) process.exitCode = exitCode;
}

function nextStep(job: ScriptJob, counts: Counts): string {
  if (job.phase === "planned") return `Nothing was changed. Review the plans, then apply: atlcli script apply ${job.id}`;
  const plural = (n: number) => `${n} issue${n === 1 ? "" : "s"}`;
  // Reviewed plans cannot be re-planned: drifted issues need a new run.
  const drift = job.mode === "plan" && job.phase === "applying" ? (counts.byStatus.drift ?? 0) : 0;
  const retry = job.total - counts.done - drift;
  const lines: string[] = [];
  if (retry > 0) {
    lines.push(`${plural(retry)} not done; resuming retries them: atlcli script resume ${job.id}${job.mode === "plan" && job.phase === "planning" ? "" : " --yes"}`);
  }
  if (drift > 0) {
    lines.push(`${plural(drift)} changed after planning and ${drift === 1 ? "was" : "were"} left alone (atlcli script jobs ${job.id} lists ${drift === 1 ? "it" : "them"}). Plan ${drift === 1 ? "it" : "them"} again with a new run.`);
  }
  return lines.join("\n") || "Done.";
}

interface Counts {
  done: number;
  byStatus: Tally;
}

/** Latest outcome per issue of the job's current phase. */
async function countOutcomes(job: ScriptJob): Promise<Counts> {
  const name = job.phase === "applying" ? "results.jsonl" : "plans.jsonl";
  const latest = new Map<string, Outcome["status"]>();
  for (const o of await readOutcomes(job, name)) latest.set(o.id, o.status);
  const byStatus: Tally = {};
  let done = 0;
  for (const status of latest.values()) {
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (FINISHED.has(status)) done++;
  }
  // Applying a planned job: issues without changes were done at planning time.
  if (job.mode === "plan" && job.phase === "applying") {
    for (const o of await readOutcomes(job, "plans.jsonl")) {
      if (o.status !== "planned" && !latest.has(o.id)) {
        byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
        if (FINISHED.has(o.status)) done++;
      }
    }
  }
  return { done, byStatus };
}

const formatCounts = (tally: Tally) =>
  Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([status, n]) => `${n} ${status}`)
    .join(", ") || "nothing yet";

// ============ Storage ============

async function saveJob(job: ScriptJob): Promise<void> {
  job.updatedAt = new Date().toISOString();
  await writeFile(file(job, "job.json"), JSON.stringify(job, null, 2) + "\n", "utf8");
}

async function loadJob(idOrDir: string | undefined, opts: OutputOptions): Promise<ScriptJob> {
  if (!idOrDir) fail(opts, 1, ERROR_CODES.USAGE, "Give a job id (see: atlcli script jobs).");
  const dir = existsSync(join(idOrDir, "job.json")) ? idOrDir : jobDir(idOrDir);
  try {
    const job = JSON.parse(await readFile(join(dir, "job.json"), "utf8")) as ScriptJob;
    if (job.schema !== JOB_SCHEMA) throw new Error("unknown job format");
    return job;
  } catch (error) {
    fail(opts, 1, ERROR_CODES.USAGE, `No script job ${idOrDir} (${error instanceof Error ? error.message : String(error)}). List them with: atlcli script jobs`);
  }
}

/** True when `arg` names a job rather than a plan file. */
export function isJobRef(arg: string): boolean {
  return existsSync(join(arg, "job.json")) || (!arg.endsWith(".json") && existsSync(join(jobDir(arg), "job.json")));
}

function checkTarget(job: ScriptJob, baseUrl: string, opts: OutputOptions): void {
  if (baseUrl.replace(/\/+$/, "") !== job.target.baseUrl) {
    fail(opts, 1, ERROR_CODES.VALIDATION, `Job ${job.id} targets ${job.target.baseUrl}, but the profile is ${baseUrl}.`);
  }
}

async function readItems(job: ScriptJob): Promise<Array<{ id: string; key: string }>> {
  return (await readFile(file(job, "items.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** Outcomes in file order; a line cut off by a crash is ignored (that issue is redone). */
async function readOutcomes(job: ScriptJob, name: "plans.jsonl" | "results.jsonl"): Promise<Outcome[]> {
  const text = await readFile(file(job, name), "utf8").catch(() => "");
  const outcomes: Outcome[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      outcomes.push(JSON.parse(line));
    } catch {}
  }
  return outcomes;
}

async function finishedIds(job: ScriptJob, name: "plans.jsonl" | "results.jsonl"): Promise<Set<string>> {
  const latest = new Map<string, Outcome["status"]>();
  for (const o of await readOutcomes(job, name)) latest.set(o.id, o.status);
  return new Set([...latest].filter(([, status]) => FINISHED.has(status)).map(([id]) => id));
}

// ============ Flags ============

function parseMaxFailures(raw: string, opts: OutputOptions): string {
  if (!/^([1-9]\d*|([1-9]\d?|100)%)$/.test(raw)) fail(opts, 1, ERROR_CODES.USAGE, `--max-failures expects a count or a percentage like 10%, got "${raw}"`);
  return raw;
}

/** Failures that stop a run: a count, or a percentage of the issues to process (at least 10). */
export function failureLimit(maxFailures: string, items: number): number {
  if (maxFailures.endsWith("%")) return Math.max(10, Math.ceil((items * Number(maxFailures.slice(0, -1))) / 100));
  return Number(maxFailures);
}
