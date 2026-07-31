import { getActiveProfile, loadConfig } from "@atlcli/core/node";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  normalizeResearchRequestV1,
  type ResearchReportV1,
} from "../utils/research/contracts.js";
import { ResearchRunBudget } from "../utils/research/budget.js";
import { createRestResearchProviders } from "../utils/research/rest-provider.js";
import {
  RESEARCH_MODEL_ID,
  runResearchAgent,
} from "../utils/research/agent-runtime.js";
import type { ResearchPtcDiagnosticV1 } from "../utils/research/agent-tools.js";
import {
  composeStandardResearchGraphV1,
  type ResearchGraphRoleV1,
} from "@atlcli/research/graph";
import type { ResearchSubagentDiagnosticV1 } from "../utils/research/dynamic-subagents.js";

const PROFILE_NAME = Bun.env.ATLCLI_RESEARCH_PROFILE?.trim() || "mayflower";
const PROJECT_KEY = Bun.env.ATLCLI_RESEARCH_JIRA_PROJECT?.trim() || "ATLCLI";
const SPACE_KEY = Bun.env.ATLCLI_RESEARCH_CONFLUENCE_SPACE?.trim() || "DOCSY";
const WINDOW_FROM = Bun.env.ATLCLI_RESEARCH_FROM?.trim();
const WINDOW_TO = Bun.env.ATLCLI_RESEARCH_TO?.trim();
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export interface LiveResearchHarnessArguments {
  outputPath: string;
  question?: string;
  maxRunMinutes: number;
}

export interface SanitizedLiveResearchMetricsV1 {
  schema: "atlcli.research-live-characterization/v1";
  model: string;
  complete: boolean;
  durationMs: number;
  counts: ResearchReportV1["run"]["counts"];
  usage?: ResearchReportV1["run"]["usage"];
  sourceCount: number;
  findingCount: number;
  relationshipCount: number;
  limitationCount: number;
  warningCount: number;
  reportBytes: number;
  ptcDiagnostics: Array<{
    tool: ResearchPtcDiagnosticV1["tool"];
    inputKind: ResearchPtcDiagnosticV1["inputKind"];
    outcome: ResearchPtcDiagnosticV1["outcome"];
    count: number;
  }>;
  subagentDiagnostics: Array<{
    role: ResearchGraphRoleV1;
    status: ResearchSubagentDiagnosticV1["status"];
    count: number;
    totalDurationMs: number;
  }>;
}

function valueAfter(
  argv: readonly string[],
  index: number,
  option: string,
): { value: string; nextIndex: number } {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return { value, nextIndex: index + 1 };
}

function boundedMinutes(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new Error("--max-run-minutes must be an integer from 1 to 10.");
  }
  return parsed;
}

export function parseLiveResearchHarnessArguments(
  argv: readonly string[],
): LiveResearchHarnessArguments {
  let outputPath = "";
  let question: string | undefined;
  let maxRunMinutes = 10;
  const positionalQuestion: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--output") {
      const parsed = valueAfter(argv, index, "--output");
      outputPath = parsed.value;
      index = parsed.nextIndex;
    } else if (argument.startsWith("--output=")) {
      outputPath = argument.slice("--output=".length).trim();
    } else if (argument === "--question") {
      const parsed = valueAfter(argv, index, "--question");
      question = parsed.value;
      index = parsed.nextIndex;
    } else if (argument.startsWith("--question=")) {
      question = argument.slice("--question=".length).trim();
    } else if (argument === "--max-run-minutes") {
      const parsed = valueAfter(argv, index, "--max-run-minutes");
      maxRunMinutes = boundedMinutes(parsed.value);
      index = parsed.nextIndex;
    } else if (argument.startsWith("--max-run-minutes=")) {
      maxRunMinutes = boundedMinutes(
        argument.slice("--max-run-minutes=".length).trim(),
      );
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      positionalQuestion.push(argument);
    }
  }

  if (!outputPath) {
    throw new Error("--output is required and must point outside the repository.");
  }
  if (question && positionalQuestion.length > 0) {
    throw new Error("Use either --question or a positional question, not both.");
  }
  const positional = positionalQuestion.join(" ").trim();
  return {
    outputPath,
    ...(question || positional ? { question: question || positional } : {}),
    maxRunMinutes,
  };
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

export function normalizeLiveResearchOutputPath(
  value: string,
  repositoryRoot = REPOSITORY_ROOT,
): string {
  if (!isAbsolute(value)) {
    throw new Error("--output must be an absolute path.");
  }
  if (extname(value).toLowerCase() !== ".md") {
    throw new Error("--output must use the .md extension.");
  }
  const outputPath = resolve(value);
  if (isInside(resolve(repositoryRoot), outputPath)) {
    throw new Error("--output must point outside the repository.");
  }
  return outputPath;
}

export async function writeLiveResearchMarkdownArtifact(
  value: string,
  markdown: string,
  repositoryRoot = REPOSITORY_ROOT,
): Promise<string> {
  const outputPath = normalizeLiveResearchOutputPath(value, repositoryRoot);
  await mkdir(dirname(outputPath), { recursive: true });
  const [realRepositoryRoot, realOutputParent] = await Promise.all([
    realpath(repositoryRoot),
    realpath(dirname(outputPath)),
  ]);
  if (isInside(realRepositoryRoot, realOutputParent)) {
    throw new Error("--output resolves inside the repository.");
  }
  await writeFile(outputPath, markdown, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return outputPath;
}

export function buildSanitizedLiveResearchMetricsV1(
  report: ResearchReportV1,
  diagnostics: readonly ResearchPtcDiagnosticV1[],
  subagentDiagnostics: readonly ResearchSubagentDiagnosticV1[] = [],
): SanitizedLiveResearchMetricsV1 {
  const aggregate = new Map<string, SanitizedLiveResearchMetricsV1["ptcDiagnostics"][number]>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.tool}:${diagnostic.inputKind}:${diagnostic.outcome}`;
    const current = aggregate.get(key);
    aggregate.set(key, {
      tool: diagnostic.tool,
      inputKind: diagnostic.inputKind,
      outcome: diagnostic.outcome,
      count: (current?.count ?? 0) + 1,
    });
  }
  const subagentAggregate = new Map<
    string,
    SanitizedLiveResearchMetricsV1["subagentDiagnostics"][number]
  >();
  for (const diagnostic of subagentDiagnostics) {
    const key = `${diagnostic.role}:${diagnostic.status}`;
    const current = subagentAggregate.get(key);
    subagentAggregate.set(key, {
      role: diagnostic.role,
      status: diagnostic.status,
      count: (current?.count ?? 0) + 1,
      totalDurationMs:
        (current?.totalDurationMs ?? 0) + (diagnostic.durationMs ?? 0),
    });
  }
  return {
    schema: "atlcli.research-live-characterization/v1",
    model: report.run.model,
    complete: report.run.complete,
    durationMs: report.run.durationMs,
    counts: report.run.counts,
    ...(report.run.usage ? { usage: report.run.usage } : {}),
    sourceCount: report.sources.length,
    findingCount: report.findings.length,
    relationshipCount: report.relationships.length,
    limitationCount: report.limitations.length,
    warningCount: report.run.warnings.length,
    reportBytes: new TextEncoder().encode(report.markdown).byteLength,
    ptcDiagnostics: [...aggregate.values()].sort((left, right) =>
      `${left.tool}:${left.inputKind}:${left.outcome}`.localeCompare(
        `${right.tool}:${right.inputKind}:${right.outcome}`,
      )
    ),
    subagentDiagnostics: [...subagentAggregate.values()].sort((left, right) =>
      `${left.role}:${left.status}`.localeCompare(`${right.role}:${right.status}`)
    ),
  };
}

function defaultQuestion(): string {
  return `Welche aktuellen Arbeiten und Dokumentationen im Jira-Projekt ${PROJECT_KEY} und Confluence-Space ${SPACE_KEY} betreffen browserbasierte Exporte oder Agentenfunktionalitäten, und welche Jira-Confluence-Beziehungen sind explizit belegt?`;
}

export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  const arguments_ = parseLiveResearchHarnessArguments(argv);
  const apiKey = Bun.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is missing. Add it to the ignored repository .env file."
    );
  }

  const config = await loadConfig();
  const profile = getActiveProfile(config, PROFILE_NAME);
  if (!profile) {
    throw new Error("The configured atlcli research profile does not exist.");
  }
  const siteOrigin = new URL(profile.baseUrl).origin;
  const request = normalizeResearchRequestV1({
    schema: RESEARCH_REQUEST_SCHEMA_V1,
    question: arguments_.question ?? defaultQuestion(),
    scope: {
      siteOrigin,
      jiraProjectKeys: [PROJECT_KEY],
      confluenceSpaceKeys: [SPACE_KEY],
      ...((WINDOW_FROM || WINDOW_TO)
        ? {
            timeWindow: {
              ...(WINDOW_FROM ? { from: WINDOW_FROM } : {}),
              ...(WINDOW_TO ? { to: WINDOW_TO } : {}),
            },
          }
        : {}),
    },
    limits: {
      ...DEFAULT_RESEARCH_LIMITS_V1,
      pageSize: 10,
      maxSearchPagesPerProduct: 4,
      maxItemsPerProduct: 30,
      maxDetailItemsPerProduct: 8,
      maxBodyCharsPerItem: 50_000,
      maxPtcCalls: 32,
      maxHttpCalls: 40,
      maxModelOutputTokens: 4_096,
      maxRunMs: arguments_.maxRunMinutes * 60_000,
    },
    wikiProvider: "rest",
  });
  const budget = new ResearchRunBudget(request.limits);
  const providers = createRestResearchProviders(
    profile,
    request,
    budget,
    { allowProfileAuth: true }
  );

  const diagnostics: ResearchPtcDiagnosticV1[] = [];
  const subagentDiagnostics: ResearchSubagentDiagnosticV1[] = [];
  const researchGraph = composeStandardResearchGraphV1(request.question);
  console.error(
    `[research-live] model=${RESEARCH_MODEL_ID} auth=profile key=present maxRunMinutes=${arguments_.maxRunMinutes}`
  );
  const report = await runResearchAgent({
    apiKey,
    request,
    providers,
    budget,
    runId: `profile-live-${crypto.randomUUID()}`,
    researchGraph,
    onPtcDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    onSubagentDiagnostic: (diagnostic) => subagentDiagnostics.push(diagnostic),
    options: {
      signal: AbortSignal.timeout(request.limits.maxRunMs),
      onProgress: (progress) =>
        console.error(`[research-live] phase=${progress.phase}`),
    },
  });
  const outputPath = await writeLiveResearchMarkdownArtifact(
    arguments_.outputPath,
    report.markdown,
  );
  console.log(JSON.stringify(
    buildSanitizedLiveResearchMetricsV1(
      report,
      diagnostics,
      subagentDiagnostics,
    ),
  ));
  console.error(`[research-live] artifact=${outputPath}`);
}

if (import.meta.main) await main();
