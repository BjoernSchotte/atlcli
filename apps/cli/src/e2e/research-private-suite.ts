import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const SUITE_SCHEMA = "atlcli.research-private-suite/v1";
const METRICS_SCHEMA = "atlcli.research-private-suite-metrics/v1";
const MAXIMUM_CASES = 16;
const CASE_ID = /^[A-Z][A-Z0-9_-]{0,39}$/;
const SCOPE_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface ResearchPrivateSuiteCaseV1 {
  id: string;
  question: string;
  projectKeys: string[];
  spaceKeys: string[];
}

export interface ResearchPrivateSuiteV1 {
  schema: typeof SUITE_SCHEMA;
  profile: string;
  asOf: string;
  timezone: string;
  reportLanguage: "en" | "de";
  effort: "lookup" | "deep";
  reconciliation: "off" | "auto" | "required";
  scopeExpansion: "strict" | "ask" | "exact-linked";
  maxRunMinutes: number;
  maxCostUsd: number;
  cases: ResearchPrivateSuiteCaseV1[];
}

export interface ResearchPrivateSuiteMetricsV1 {
  schema: typeof METRICS_SCHEMA;
  startedAt: string;
  completedAt: string;
  runs: Array<{
    id: string;
    status: "completed" | "failed";
    durationMs: number;
    markdownBytes: number;
    complete?: boolean;
    counts?: {
      ptcCalls: number;
      httpCalls: number;
      jiraItems: number;
      confluenceItems: number;
    };
  }>;
}

export interface ResearchPrivateSuiteCliArguments {
  mode: "source" | "built";
  suitePath: string;
  outputDirectory: string;
}

export interface ResearchPrivateSuiteProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ResearchPrivateSuiteProcessRunner = (
  command: readonly string[],
  caseId: string,
) => Promise<ResearchPrivateSuiteProcessResult>;

function valueAfter(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function externalAbsolutePath(value: string, option: string, repositoryRoot = REPOSITORY_ROOT): string {
  if (!isAbsolute(value)) throw new Error(`${option} must be an absolute path.`);
  const path = resolve(value);
  if (isInside(resolve(repositoryRoot), path)) throw new Error(`${option} must point outside the repository.`);
  return path;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`));
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function boundedCost(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 25) {
    throw new Error("Suite maxCostUsd is invalid.");
  }
  return value;
}

function scopeKeys(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 8 || value.some((entry) => typeof entry !== "string" || !SCOPE_KEY.test(entry))) {
    throw new Error(`Suite ${label} is invalid.`);
  }
  if (new Set(value).size !== value.length) throw new Error(`Suite ${label} contains duplicates.`);
  return [...value];
}

/** Parse private operator input without ever serializing it into metrics. */
export function parseResearchPrivateSuiteV1(value: unknown): ResearchPrivateSuiteV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Private research suite is invalid.");
  const suite = value as Partial<ResearchPrivateSuiteV1>;
  if (suite.schema !== SUITE_SCHEMA || typeof suite.profile !== "string" || suite.profile.length === 0 || suite.profile.length > 120 ||
      !validDate(suite.asOf) || typeof suite.timezone !== "string" || suite.timezone.length === 0 || suite.timezone.length > 80 ||
      (suite.reportLanguage !== undefined && suite.reportLanguage !== "en" && suite.reportLanguage !== "de") ||
      (suite.effort !== "lookup" && suite.effort !== "deep") ||
      (suite.reconciliation !== "off" && suite.reconciliation !== "auto" && suite.reconciliation !== "required") ||
      (suite.scopeExpansion !== "strict" && suite.scopeExpansion !== "ask" && suite.scopeExpansion !== "exact-linked") ||
      !Array.isArray(suite.cases) || suite.cases.length === 0 || suite.cases.length > MAXIMUM_CASES) {
    throw new Error("Private research suite is invalid.");
  }
  const ids = new Set<string>();
  const cases = suite.cases.map((entry): ResearchPrivateSuiteCaseV1 => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Private research suite case is invalid.");
    const candidate = entry as Partial<ResearchPrivateSuiteCaseV1>;
    if (typeof candidate.id !== "string" || !CASE_ID.test(candidate.id) || ids.has(candidate.id) ||
        typeof candidate.question !== "string" || candidate.question.trim().length === 0 || candidate.question.length > 4_000) {
      throw new Error("Private research suite case is invalid.");
    }
    ids.add(candidate.id);
    return {
      id: candidate.id,
      question: candidate.question,
      projectKeys: scopeKeys(candidate.projectKeys, "projectKeys"),
      spaceKeys: scopeKeys(candidate.spaceKeys, "spaceKeys"),
    };
  });
  return {
    schema: SUITE_SCHEMA,
    profile: suite.profile,
    asOf: suite.asOf,
    timezone: suite.timezone,
    reportLanguage: suite.reportLanguage ?? "en",
    effort: suite.effort,
    reconciliation: suite.reconciliation,
    scopeExpansion: suite.scopeExpansion,
    maxRunMinutes: boundedInteger(suite.maxRunMinutes, 1, 10, "Suite maxRunMinutes"),
    maxCostUsd: boundedCost(suite.maxCostUsd),
    cases,
  };
}

export function parseResearchPrivateSuiteCliArguments(
  argv: readonly string[],
  repositoryRoot = REPOSITORY_ROOT,
): ResearchPrivateSuiteCliArguments {
  let mode: ResearchPrivateSuiteCliArguments["mode"] = "source";
  let suitePath = "";
  let outputDirectory = "";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const take = (option: string): string => {
      const value = valueAfter(argv, index, option);
      index += 1;
      return value;
    };
    if (argument === "--mode") {
      const value = take("--mode");
      if (value !== "source" && value !== "built") throw new Error("--mode must be source or built.");
      mode = value;
    } else if (argument === "--suite") {
      suitePath = take("--suite");
    } else if (argument === "--output-dir") {
      outputDirectory = take("--output-dir");
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return {
    mode,
    suitePath: externalAbsolutePath(suitePath, "--suite", repositoryRoot),
    outputDirectory: externalAbsolutePath(outputDirectory, "--output-dir", repositoryRoot),
  };
}

function cliExecutable(mode: ResearchPrivateSuiteCliArguments["mode"], repositoryRoot: string): string[] {
  return mode === "source"
    ? [process.execPath, "--conditions=development", "run", "--cwd", "apps/cli", "src/index.ts"]
    : [process.execPath, resolve(repositoryRoot, "dist/index.js")];
}

export function researchPrivateSuiteReportPath(outputDirectory: string, caseId: string): string {
  return join(outputDirectory, `${caseId}.md`);
}

export function buildResearchPrivateSuiteCommand(
  input: ResearchPrivateSuiteCliArguments,
  suite: ResearchPrivateSuiteV1,
  entry: ResearchPrivateSuiteCaseV1,
  repositoryRoot = REPOSITORY_ROOT,
): string[] {
  return [
    ...cliExecutable(input.mode, repositoryRoot),
    "research",
    entry.question,
    "--profile", suite.profile,
    ...entry.projectKeys.flatMap((key) => ["--project", key]),
    ...entry.spaceKeys.flatMap((key) => ["--space", key]),
    "--as-of", suite.asOf,
    "--timezone", suite.timezone,
    "--language", suite.reportLanguage,
    "--effort", suite.effort,
    "--reconciliation", suite.reconciliation,
    "--scope-expansion", suite.scopeExpansion,
    "--plan-approval", "automatic",
    "--max-run-minutes", String(suite.maxRunMinutes),
    "--max-cost-usd", String(suite.maxCostUsd),
    "--json",
    "--output", researchPrivateSuiteReportPath(input.outputDirectory, entry.id),
  ];
}

type ResearchPrivateSuiteRunCounts = NonNullable<ResearchPrivateSuiteMetricsV1["runs"][number]["counts"]>;

function safeRunProjection(value: unknown): ResearchPrivateSuiteRunCounts | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const run = value as { counts?: unknown };
  const counts = run.counts;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return undefined;
  const candidate = counts as Partial<ResearchPrivateSuiteRunCounts>;
  const { ptcCalls, httpCalls, jiraItems, confluenceItems } = candidate;
  if (typeof ptcCalls !== "number" || !Number.isSafeInteger(ptcCalls) || ptcCalls < 0 ||
      typeof httpCalls !== "number" || !Number.isSafeInteger(httpCalls) || httpCalls < 0 ||
      typeof jiraItems !== "number" || !Number.isSafeInteger(jiraItems) || jiraItems < 0 ||
      typeof confluenceItems !== "number" || !Number.isSafeInteger(confluenceItems) || confluenceItems < 0) return undefined;
  return {
    ptcCalls,
    httpCalls,
    jiraItems,
    confluenceItems,
  };
}

export function projectResearchPrivateSuiteMetricsRun(
  caseId: string,
  result: ResearchPrivateSuiteProcessResult,
  durationMs: number,
  markdownBytes: number,
): ResearchPrivateSuiteMetricsV1["runs"][number] {
  if (result.exitCode !== 0) {
    return { id: caseId, status: "failed", durationMs, markdownBytes: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { id: caseId, status: "failed", durationMs, markdownBytes: 0 };
  }
  const report = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as { report?: unknown }).report
    : undefined;
  const complete = report && typeof report === "object" && !Array.isArray(report) &&
    typeof (report as { run?: { complete?: unknown } }).run?.complete === "boolean"
    ? (report as { run: { complete: boolean } }).run.complete
    : undefined;
  const counts = safeRunProjection(report && typeof report === "object" && !Array.isArray(report)
    ? (report as { run?: unknown }).run
    : undefined);
  return {
    id: caseId,
    status: "completed",
    durationMs,
    markdownBytes,
    ...(complete === undefined ? {} : { complete }),
    ...(counts === undefined ? {} : { counts }),
  };
}

/**
 * Execute a private query set. The only repository-visible result is this
 * generic harness: reports, logs, private questions, scope keys, and provider
 * JSON stay in the caller-selected directory outside the checkout.
 */
export async function runResearchPrivateSuite(
  input: ResearchPrivateSuiteCliArguments,
  suite: ResearchPrivateSuiteV1,
  runner: ResearchPrivateSuiteProcessRunner,
  now: () => Date = () => new Date(),
): Promise<ResearchPrivateSuiteMetricsV1> {
  await mkdir(input.outputDirectory, { recursive: true, mode: 0o700 });
  const startedAt = now().toISOString();
  const runs: ResearchPrivateSuiteMetricsV1["runs"] = [];
  for (const entry of suite.cases) {
    const startedAtMs = now().getTime();
    const result = await runner(buildResearchPrivateSuiteCommand(input, suite, entry), entry.id);
    await writeFile(join(input.outputDirectory, `${entry.id}.run.log`), result.stderr, { mode: 0o600 });
    const reportPath = researchPrivateSuiteReportPath(input.outputDirectory, entry.id);
    let markdownBytes = 0;
    if (result.exitCode === 0) {
      const markdown = await readFile(reportPath, "utf8");
      if (!markdown.startsWith("# ") || !markdown.includes("\n## Sources\n")) {
        throw new Error(`Private research suite report is incomplete for ${entry.id}.`);
      }
      markdownBytes = new TextEncoder().encode(markdown).byteLength;
    }
    runs.push(projectResearchPrivateSuiteMetricsRun(entry.id, result, Math.max(0, now().getTime() - startedAtMs), markdownBytes));
  }
  const metrics: ResearchPrivateSuiteMetricsV1 = {
    schema: METRICS_SCHEMA,
    startedAt,
    completedAt: now().toISOString(),
    runs,
  };
  await writeFile(join(input.outputDirectory, "metrics.json"), `${JSON.stringify(metrics, undefined, 2)}\n`, { mode: 0o600 });
  return metrics;
}

async function captureAndForward(stream: ReadableStream<Uint8Array>, forward: (chunk: string) => void): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let captured = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    captured += chunk;
    if (chunk) forward(chunk);
  }
  const tail = decoder.decode();
  captured += tail;
  if (tail) forward(tail);
  return captured;
}

async function main(argv = Bun.argv.slice(2)): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error("ANTHROPIC_API_KEY is missing from the process environment.");
  }
  const input = parseResearchPrivateSuiteCliArguments(argv);
  const suite = parseResearchPrivateSuiteV1(JSON.parse(await readFile(input.suitePath, "utf8")));
  const metrics = await runResearchPrivateSuite(input, suite, async (command) => {
    const child = Bun.spawn([...command], {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, ATLCLI_DISABLE_UPDATE_CHECK: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      captureAndForward(child.stderr, (chunk) => process.stderr.write(chunk)),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  });
  process.stderr.write(`[research-e2e] private-suite cases=${metrics.runs.length} output=${input.outputDirectory}\n`);
  if (metrics.runs.some((entry) => entry.status !== "completed")) {
    throw new Error("One or more private research suite cases failed; inspect the local metrics and run logs.");
  }
}

if (import.meta.main) await main();
