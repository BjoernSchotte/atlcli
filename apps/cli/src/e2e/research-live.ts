import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

export interface ResearchLiveCliArguments {
  mode: "source" | "built";
  outputPath: string;
  question: string;
  profile: string;
  projectKeys: string[];
  spaceKeys: string[];
  maxRunMinutes: number;
  maxCostUsd?: number;
  maxTotalModelInputTokens?: number;
}

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

function boundedInputTokens(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 1_000_000) {
    throw new Error(
      "--max-total-model-input-tokens must be an integer from 1000 to 1000000.",
    );
  }
  return parsed;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function normalizeResearchLiveOutputPath(
  value: string,
  repositoryRoot = REPOSITORY_ROOT,
): string {
  if (!isAbsolute(value)) throw new Error("--output must be an absolute path.");
  if (extname(value).toLowerCase() !== ".md") {
    throw new Error("--output must use the .md extension.");
  }
  const outputPath = resolve(value);
  if (isInside(resolve(repositoryRoot), outputPath)) {
    throw new Error("--output must point outside the repository.");
  }
  return outputPath;
}

export function parseResearchLiveCliArguments(
  argv: readonly string[],
  environment: Record<string, string | undefined> = process.env,
): ResearchLiveCliArguments {
  let mode: ResearchLiveCliArguments["mode"] = "source";
  let outputPath = "";
  let question = "";
  let profile = environment.ATLCLI_RESEARCH_PROFILE?.trim() || "mayflower";
  const projectKeys: string[] = [];
  const spaceKeys: string[] = [];
  let maxRunMinutes = 10;
  let maxCostUsd: number | undefined;
  let maxTotalModelInputTokens: number | undefined;

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
    } else if (argument === "--output") {
      outputPath = take("--output");
    } else if (argument === "--question") {
      question = take("--question");
    } else if (argument === "--profile") {
      profile = take("--profile");
    } else if (argument === "--project") {
      projectKeys.push(...take("--project").split(",").map((value) => value.trim()).filter(Boolean));
    } else if (argument === "--space") {
      spaceKeys.push(...take("--space").split(",").map((value) => value.trim()).filter(Boolean));
    } else if (argument === "--max-run-minutes") {
      maxRunMinutes = boundedMinutes(take("--max-run-minutes"));
    } else if (argument === "--max-cost-usd") {
      maxCostUsd = boundedCost(take("--max-cost-usd"));
    } else if (argument === "--max-total-model-input-tokens") {
      maxTotalModelInputTokens = boundedInputTokens(
        take("--max-total-model-input-tokens"),
      );
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  const projects = projectKeys.length > 0
    ? projectKeys
    : [environment.ATLCLI_RESEARCH_E2E_PROJECT?.trim() || "ATLCLI"];
  const spaces = spaceKeys.length > 0
    ? spaceKeys
    : [environment.ATLCLI_RESEARCH_E2E_SPACE?.trim() || "DOCSY"];
  const defaultQuestion = `Which recent Jira work in project ${projects.join(", ")} is explicitly related to documentation in Confluence space ${spaces.join(", ")}? Use only read-only evidence, distinguish explicit links from inferred topical overlap, and include direct source URLs.`;
  return {
    mode,
    outputPath: normalizeResearchLiveOutputPath(outputPath),
    question: question || defaultQuestion,
    profile,
    projectKeys: [...new Set(projects)],
    spaceKeys: [...new Set(spaces)],
    maxRunMinutes,
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    ...(maxTotalModelInputTokens === undefined
      ? {}
      : { maxTotalModelInputTokens }),
  };
}

export function buildResearchLiveCliCommand(
  input: ResearchLiveCliArguments,
  repositoryRoot = REPOSITORY_ROOT,
): string[] {
  const executable = input.mode === "source"
    ? [process.execPath, "--conditions=development", "run", "--cwd", "apps/cli", "src/index.ts"]
    : [process.execPath, resolve(repositoryRoot, "dist/index.js")];
  return [
    ...executable,
    "research",
    input.question,
    "--profile", input.profile,
    ...input.projectKeys.flatMap((key) => ["--project", key]),
    ...input.spaceKeys.flatMap((key) => ["--space", key]),
    "--max-run-minutes", String(input.maxRunMinutes),
    ...(input.maxCostUsd === undefined
      ? []
      : ["--max-cost-usd", String(input.maxCostUsd)]),
    ...(input.maxTotalModelInputTokens === undefined
      ? []
      : [
          "--max-total-model-input-tokens",
          String(input.maxTotalModelInputTokens),
        ]),
    "--output", input.outputPath,
  ];
}

export async function verifyResearchLiveDelivery(
  stdout: string,
  outputPath: string,
): Promise<void> {
  const written = await readFile(outputPath, "utf8");
  if (written !== stdout) {
    throw new Error("CLI stdout and --output Markdown bytes differ.");
  }
  if (!written.startsWith("# ") || !written.includes("\n## Sources\n")) {
    throw new Error("CLI output is not the expected complete Markdown report shape.");
  }
}

export async function captureAndForwardResearchStream(
  stream: ReadableStream<Uint8Array>,
  forward: (chunk: string) => void,
): Promise<string> {
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

export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  const input = parseResearchLiveCliArguments(argv);
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error("ANTHROPIC_API_KEY is missing from the process environment.");
  }
  const command = buildResearchLiveCliCommand(input);
  const child = Bun.spawn(command, {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, ATLCLI_DISABLE_UPDATE_CHECK: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , exitCode] = await Promise.all([
    captureAndForwardResearchStream(child.stdout, (chunk) => process.stdout.write(chunk)),
    captureAndForwardResearchStream(child.stderr, (chunk) => process.stderr.write(chunk)),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Research CLI exited with code ${exitCode}.`);
  await verifyResearchLiveDelivery(stdout, input.outputPath);
  process.stderr.write(`[research-e2e] mode=${input.mode} output=${input.outputPath} bytes=${new TextEncoder().encode(stdout).byteLength}\n`);
}

if (import.meta.main) await main();
