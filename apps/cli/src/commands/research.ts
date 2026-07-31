import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  ERROR_CODES,
  type OutputOptions,
  fail,
  getActiveProfile,
  getFlag,
  getFlags,
  hasFlag,
  loadConfig,
  output,
  resolveDefaults,
} from "@atlcli/core";
import type { Profile } from "@atlcli/core";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  normalizeResearchRequestV1,
  type ResearchRequestV1,
} from "../../../extension/utils/research/contracts.js";
import { ResearchRunBudget } from "../../../extension/utils/research/budget.js";
import { createRestResearchProviders } from "../../../extension/utils/research/rest-provider.js";
import {
  RESEARCH_MODEL_ID,
  runResearchAgent,
} from "../../../extension/utils/research/agent-runtime.js";
import {
  FileSystemResearchWorkspace,
  type ResearchWorkspace,
} from "@atlcli/research/node";
import { composeResearchGraphV1 } from "@atlcli/research/graph";

export interface ResearchCliInput {
  question: string;
  profile?: string;
  projectKeys: string[];
  spaceKeys: string[];
  from?: string;
  to?: string;
  asOf?: string;
  timezone?: string;
  outputPath?: string;
  maxRunMinutes: number;
  keepSession: boolean;
}

const DEFAULT_MAX_RUN_MINUTES = 10;
const MAX_MAX_RUN_MINUTES = 10;

export function researchArtifactPath(now = new Date()): string {
  const timestamp = now.toISOString().replace(/[T:.Z]/g, "-").replace(/-+$/, "");
  return join(homedir(), "Documents", "atlcli", "artefacts", `research-${timestamp}`, "report.md");
}

function uniqueKeys(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toUpperCase()).filter(Boolean))];
}

export function parseResearchCliInput(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
): ResearchCliInput {
  const unsupported = ["session", "resume", "plan-approval", "plan-only"].filter((key) => hasFlag(flags, key));
  if (unsupported.length > 0) {
    throw new Error(`The following research flags are reserved for durable sessions: ${unsupported.map((key) => `--${key}`).join(", ")}`);
  }
  const question = args.join(" ").trim();
  if (!question) throw new Error("A research question is required. Example: atlcli research \"Which Jira and Confluence items are related?\"");
  const from = getFlag(flags, "from");
  const to = getFlag(flags, "to");
  const asOf = getFlag(flags, "as-of");
  const timezone = getFlag(flags, "timezone");
  const maxRunMinutesFlag = getFlag(flags, "max-run-minutes");
  if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error("--as-of must use YYYY-MM-DD.");
  if (hasFlag(flags, "max-run-minutes") && maxRunMinutesFlag === undefined) {
    throw new Error("--max-run-minutes requires an integer value.");
  }
  const maxRunMinutes = maxRunMinutesFlag === undefined
    ? DEFAULT_MAX_RUN_MINUTES
    : Number(maxRunMinutesFlag);
  if (!Number.isSafeInteger(maxRunMinutes) || maxRunMinutes < 1 || maxRunMinutes > MAX_MAX_RUN_MINUTES) {
    throw new Error(`--max-run-minutes must be an integer between 1 and ${MAX_MAX_RUN_MINUTES}.`);
  }
  return {
    question: [question, asOf ? `As-of date: ${asOf}.` : "", timezone ? `Timezone: ${timezone}.` : ""].filter(Boolean).join("\n\n"),
    profile: getFlag(flags, "profile"),
    projectKeys: uniqueKeys(getFlags(flags, "project")),
    spaceKeys: uniqueKeys(getFlags(flags, "space")),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(asOf ? { asOf } : {}),
    ...(timezone ? { timezone } : {}),
    ...(getFlag(flags, "output") ? { outputPath: getFlag(flags, "output") } : {}),
    maxRunMinutes,
    keepSession: hasFlag(flags, "keep-session"),
  };
}

export function buildResearchRequest(input: ResearchCliInput, profile: Profile): ResearchRequestV1 {
  const defaults = resolveDefaults({ profiles: {}, currentProfile: undefined }, profile);
  const projectKeys = input.projectKeys.length > 0 ? input.projectKeys : uniqueKeys(defaults.project ? [defaults.project] : []);
  const spaceKeys = input.spaceKeys.length > 0 ? input.spaceKeys : uniqueKeys(defaults.space ? [defaults.space] : []);
  const siteOrigin = new URL(profile.baseUrl).origin;
  return normalizeResearchRequestV1({
    schema: RESEARCH_REQUEST_SCHEMA_V1,
    question: input.question,
    scope: {
      siteOrigin,
      jiraProjectKeys: projectKeys,
      confluenceSpaceKeys: spaceKeys,
      ...((input.from || input.to) ? {
        timeWindow: {
          ...(input.from ? { from: input.from } : {}),
          ...(input.to ? { to: input.to } : {}),
        },
      } : {}),
    },
    limits: {
      ...DEFAULT_RESEARCH_LIMITS_V1,
      pageSize: 10,
      maxSearchPagesPerProduct: 4,
      maxItemsPerProduct: 30,
      maxDetailItemsPerProduct: 8,
      maxBodyCharsPerItem: 6_000,
      maxPtcCalls: 32,
      maxHttpCalls: 40,
      maxModelOutputTokens: 4_096,
      // The CLI controls only the complete workflow deadline. Individual
      // QuickJS/PTC operations retain their tighter contract limits.
      maxRunMs: input.maxRunMinutes * 60_000,
    },
    wikiProvider: "rest",
  });
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function assertApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new Error("ANTHROPIC_API_KEY is missing. Set it in the process environment; it is never read from a CLI flag.");
  return key;
}

export async function handleResearch(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
): Promise<void> {
  if (hasFlag(flags, "help") || hasFlag(flags, "h")) {
    output(researchHelp(), opts);
    return;
  }
  const input = parseResearchCliInput(args, flags);
  const config = await loadConfig();
  const profile = getActiveProfile(config, input.profile);
  if (!profile) {
    fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login` or select --profile.", { profile: input.profile });
  }
  const request = buildResearchRequest(input, profile);
  const researchGraph = composeResearchGraphV1({
    schema: "atlcli.research-brief/v1",
    question: request.question,
    products: ["jira", "confluence"],
    effort: "standard",
    reconciliation: "auto",
  });
  const apiKey = assertApiKey();
  const workspace = await FileSystemResearchWorkspace.createTemporary();
  const sessionId = `research-${randomUUID()}`;
  const budget = new ResearchRunBudget(request.limits);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Research run timed out.")), request.limits.maxRunMs);
  const onInterrupt = (): void => controller.abort(new Error("Research run cancelled."));
  process.once("SIGINT", onInterrupt);
  try {
    await workspace.writeFile("/session/request.json", JSON.stringify({ ...request, sessionId }, null, 2));
    const providers = createRestResearchProviders(profile, request, budget, { allowProfileAuth: true });
    process.stderr.write(`[research] model=${RESEARCH_MODEL_ID} profile=${profile.name} project=${request.scope.jiraProjectKeys.join(",")} space=${request.scope.confluenceSpaceKeys.join(",")} key=present\n`);
    const report = await runResearchAgent({
      apiKey,
      request,
      providers,
      budget,
      runId: sessionId,
      researchGraph,
      onPtcDiagnostic: (diagnostic) => process.stderr.write(`[research] ptc=${diagnostic.tool} kind=${diagnostic.inputKind} outcome=${diagnostic.outcome}${diagnostic.itemCount === undefined ? "" : ` items=${diagnostic.itemCount}`}${diagnostic.termination === undefined ? "" : ` termination=${diagnostic.termination}`}${diagnostic.errorCode === undefined ? "" : ` error=${diagnostic.errorCode}`}\n`),
      onSubagentDiagnostic: (diagnostic) => process.stderr.write(`[research] subagent=${diagnostic.role} status=${diagnostic.status}${diagnostic.durationMs === undefined ? "" : ` duration_ms=${diagnostic.durationMs}`}${diagnostic.errorCode === undefined ? "" : ` error=${diagnostic.errorCode}`}${diagnostic.errorMessage === undefined ? "" : ` message=${JSON.stringify(diagnostic.errorMessage)}`}\n`),
      options: {
        signal: controller.signal,
        onProgress: (progress) => process.stderr.write(`[research] phase=${progress.phase} calls=${progress.completedCalls}/${progress.maxCalls}\n`),
      },
    });
    await workspace.writeFile("/artifacts/report.md", report.markdown);
    const artifactPath = researchArtifactPath();
    try {
      await writeAtomic(artifactPath, report.markdown);
      process.stderr.write(`[research] artifact=${artifactPath}\n`);
    } catch (error) {
      process.stderr.write(`[research] artifact=unavailable reason=${error instanceof Error ? error.name : "unknown"}\n`);
    }
    if (input.outputPath) await writeAtomic(input.outputPath, report.markdown);
    if (input.keepSession) {
      process.stderr.write(`[research] session=${sessionId} workspace=${workspace.root}\n`);
    }
    output(opts.json ? { sessionId, artifactPath, report } : report.markdown, opts);
  } finally {
    clearTimeout(timeout);
    process.removeListener("SIGINT", onInterrupt);
    if (!input.keepSession) await workspace.dispose();
  }
}

export function researchHelp(): string {
  return `atlcli research <question>

Run a bounded, read-only Jira + Confluence research question through DeepAgentsJS and QuickJS PTC.

Options:
  --profile <name>       Auth profile (for example mayflower)
  --project <key>        Jira project key (repeatable; profile default otherwise)
  --space <key>          Confluence space key (repeatable; profile default otherwise)
  --from <YYYY-MM-DD>    Inclusive lower date bound
  --to <YYYY-MM-DD>      Inclusive upper date bound
  --as-of <YYYY-MM-DD>   Add a fixed as-of date to the question
  --timezone <name>      Add an explicit timezone to the question
  --max-run-minutes <n>  Complete workflow deadline, 1-10 (default: 10)
  --output <path>        Atomically write the generated Markdown
  --keep-session         Retain the temporary session workspace
  --json                 Emit the structured report as JSON
  --help                 Show this help

ANTHROPIC_API_KEY must be supplied through the process environment.
Durable session flags such as --resume are reserved for a later phase.
`;
}
