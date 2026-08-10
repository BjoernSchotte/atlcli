import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const MAXIMUM_QUESTIONS = 16;

export interface ResearchMultiTurnCliArguments {
  mode: "source" | "built";
  outputDirectory: string;
  questions: string[];
  profile: string;
  projectKeys: string[];
  spaceKeys: string[];
  maxRunMinutes: number;
  maxCostUsd: number;
}

export interface ResearchMultiTurnRunResult {
  sessionId: string;
  reportPaths: string[];
}

export interface ResearchMultiTurnProcessResult {
  exitCode: number;
  stdout: string;
}

export type ResearchMultiTurnProcessRunner = (
  command: readonly string[],
  turn: number,
) => Promise<ResearchMultiTurnProcessResult>;

function valueAfter(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function boundedMinutes(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new Error("--max-run-minutes must be an integer from 1 to 10.");
  }
  return parsed;
}

function boundedCost(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 25) {
    throw new Error("--max-cost-usd must be a number greater than 0 and at most 25.");
  }
  return parsed;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function normalizedKeys(values: readonly string[]): string[] {
  return [...new Set(values.flatMap((value) => value.split(",").map((part) => part.trim()).filter(Boolean)))];
}

export function normalizeResearchMultiTurnOutputDirectory(
  value: string,
  repositoryRoot = REPOSITORY_ROOT,
): string {
  if (!isAbsolute(value)) throw new Error("--output-dir must be an absolute path.");
  const outputDirectory = resolve(value);
  if (isInside(resolve(repositoryRoot), outputDirectory)) {
    throw new Error("--output-dir must point outside the repository.");
  }
  return outputDirectory;
}

/**
 * Parse a deliberately small live-proof harness. The first question creates a
 * session and fixes its provider ceiling; every later question uses
 * `--session`, which cannot widen that stored scope, deadline, or cost limit.
 */
export function parseResearchMultiTurnCliArguments(
  argv: readonly string[],
  environment: Record<string, string | undefined> = process.env,
): ResearchMultiTurnCliArguments {
  let mode: ResearchMultiTurnCliArguments["mode"] = "source";
  let outputDirectory = "";
  const questions: string[] = [];
  let profile = environment.ATLCLI_RESEARCH_PROFILE?.trim() || "mayflower";
  const projectKeys: string[] = [];
  const spaceKeys: string[] = [];
  let maxRunMinutes = 10;
  let maxCostUsd = 2;

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
    } else if (argument === "--output-dir") {
      outputDirectory = take("--output-dir");
    } else if (argument === "--question") {
      questions.push(take("--question"));
    } else if (argument === "--profile") {
      profile = take("--profile");
    } else if (argument === "--project") {
      projectKeys.push(take("--project"));
    } else if (argument === "--space") {
      spaceKeys.push(take("--space"));
    } else if (argument === "--max-run-minutes") {
      maxRunMinutes = boundedMinutes(take("--max-run-minutes"));
    } else if (argument === "--max-cost-usd") {
      maxCostUsd = boundedCost(take("--max-cost-usd"));
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (questions.length < 2 || questions.length > MAXIMUM_QUESTIONS) {
    throw new Error(`Provide --question at least twice and at most ${MAXIMUM_QUESTIONS} times.`);
  }
  if (!profile) throw new Error("--profile requires a value.");
  const normalizedProjectKeys = normalizedKeys(projectKeys);
  const normalizedSpaceKeys = normalizedKeys(spaceKeys);
  return {
    mode,
    outputDirectory: normalizeResearchMultiTurnOutputDirectory(outputDirectory),
    questions,
    profile,
    projectKeys: normalizedProjectKeys.length > 0
      ? normalizedProjectKeys
      : [environment.ATLCLI_RESEARCH_E2E_PROJECT?.trim() || "ATLCLI"],
    spaceKeys: normalizedSpaceKeys.length > 0
      ? normalizedSpaceKeys
      : [environment.ATLCLI_RESEARCH_E2E_SPACE?.trim() || "DOCSY"],
    maxRunMinutes,
    maxCostUsd,
  };
}

function publicCliExecutable(
  mode: ResearchMultiTurnCliArguments["mode"],
  repositoryRoot: string,
): string[] {
  return mode === "source"
    ? [process.execPath, "--conditions=development", "run", "--cwd", "apps/cli", "src/index.ts"]
    : [process.execPath, resolve(repositoryRoot, "dist/index.js")];
}

export function researchMultiTurnReportPath(
  outputDirectory: string,
  turn: number,
): string {
  return resolve(outputDirectory, `turn-${String(turn).padStart(2, "0")}.md`);
}

export function buildResearchMultiTurnCliCommand(
  input: ResearchMultiTurnCliArguments,
  turn: number,
  sessionId: string | undefined,
  repositoryRoot = REPOSITORY_ROOT,
): string[] {
  if (!Number.isSafeInteger(turn) || turn < 1 || turn > input.questions.length) {
    throw new Error("Research multi-turn harness turn is outside its question set.");
  }
  const question = input.questions[turn - 1]!;
  const command = [
    ...publicCliExecutable(input.mode, repositoryRoot),
    "research",
    question,
    "--profile", input.profile,
    "--output", researchMultiTurnReportPath(input.outputDirectory, turn),
    "--json",
  ];
  if (sessionId) {
    command.push("--session", sessionId);
  } else {
    command.push(
      ...input.projectKeys.flatMap((key) => ["--project", key]),
      ...input.spaceKeys.flatMap((key) => ["--space", key]),
      "--max-run-minutes", String(input.maxRunMinutes),
      "--max-cost-usd", String(input.maxCostUsd),
    );
  }
  return command;
}

function parseSessionId(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Research multi-turn command did not emit one JSON result.");
  }
  const sessionId = parsed && typeof parsed === "object" ? (parsed as { sessionId?: unknown }).sessionId : undefined;
  if (typeof sessionId !== "string" || !/^research-session:[A-Za-z0-9._-]{1,120}$/.test(sessionId)) {
    throw new Error("Research multi-turn command did not return a valid durable session ID.");
  }
  return sessionId;
}

async function verifyReport(path: string): Promise<void> {
  const markdown = await readFile(path, "utf8");
  if (!markdown.startsWith("# ") || !markdown.includes("\n## Sources\n")) {
    throw new Error(`Research multi-turn report is incomplete: ${path}`);
  }
}

/** Run every question in a new process while retaining precisely one session. */
export async function runResearchMultiTurnHarness(
  input: ResearchMultiTurnCliArguments,
  runner: ResearchMultiTurnProcessRunner,
): Promise<ResearchMultiTurnRunResult> {
  await mkdir(input.outputDirectory, { recursive: true, mode: 0o700 });
  let sessionId: string | undefined;
  const reportPaths: string[] = [];
  for (let turn = 1; turn <= input.questions.length; turn += 1) {
    const result = await runner(buildResearchMultiTurnCliCommand(input, turn, sessionId), turn);
    if (result.exitCode !== 0) {
      throw new Error(`Research multi-turn command failed at turn ${turn} with exit code ${result.exitCode}.`);
    }
    const returnedSessionId = parseSessionId(result.stdout);
    if (sessionId && returnedSessionId !== sessionId) {
      throw new Error("Research multi-turn command changed its durable session ID.");
    }
    sessionId = returnedSessionId;
    const reportPath = researchMultiTurnReportPath(input.outputDirectory, turn);
    await verifyReport(reportPath);
    reportPaths.push(reportPath);
  }
  if (!sessionId) throw new Error("Research multi-turn harness did not create a session.");
  return { sessionId, reportPaths };
}

async function forwardStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (chunk) process.stderr.write(chunk);
  }
  const tail = decoder.decode();
  if (tail) process.stderr.write(tail);
}

async function main(argv = Bun.argv.slice(2)): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error("ANTHROPIC_API_KEY is missing from the process environment.");
  }
  const input = parseResearchMultiTurnCliArguments(argv);
  const result = await runResearchMultiTurnHarness(input, async (command, turn) => {
    const child = Bun.spawn([...command], {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, ATLCLI_DISABLE_UPDATE_CHECK: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
      forwardStderr(child.stderr),
    ]);
    process.stderr.write(`[research-e2e] turn=${turn} exit=${exitCode}\n`);
    return { exitCode, stdout };
  });
  process.stderr.write(
    `[research-e2e] session=${result.sessionId} turns=${result.reportPaths.length} output=${input.outputDirectory}\n`,
  );
}

if (import.meta.main) await main();
