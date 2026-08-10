import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  finalizeChatReleaseCandidateProofV1,
  finalizeChatReleaseCandidateRunV1,
  fingerprintChatReleaseCandidateManifestV1,
  type ChatReleaseCandidateCheckResultV1,
  type ChatReleaseCandidateFailureCodeV1,
  type ChatReleaseCandidateProofV1,
  type ChatReleaseCandidateRunV1,
  type ChatReleaseCandidateVariantV1,
} from "../../../../packages/research/src/chat-agent/release-candidate-matrix.js";
import { chatMarkdownIntegrityIssuesV1 } from "../../../../packages/research/src/chat-agent/answer.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const SUITE_SCHEMA = "atlcli.chat-private-suite/v1";
const REVIEW_SCHEMA = "atlcli.chat-private-review/v1";
const CASE_ID = /^CASE[0-9]{2,4}$/u;
const VARIANTS = ["quick", "auto", "deep", "deep-research"] as const;
const CHAT_VARIANTS = ["quick", "auto", "deep"] as const;

interface ChatPrivateGoldV1 {
  requiredSourceUrls: string[];
  allowedSourceUrls: string[];
  requiredFactGroups: string[][];
  requiredOrderedFactGroups: string[][];
  forbiddenClaims: string[];
  expectAbstention: boolean;
}

interface ChatPrivateTurnV1 {
  question: string;
  gold: ChatPrivateGoldV1;
}

interface ChatPrivateCaseV1 {
  id: string;
  projectKeys: string[];
  spaceKeys: string[];
  variants: ChatReleaseCandidateVariantV1[];
  turns: ChatPrivateTurnV1[];
}

export interface ChatPrivateSuiteV1 {
  schema: typeof SUITE_SCHEMA;
  profile: string;
  reportLanguage: "en" | "de";
  maxRunMinutes: number;
  maxCostUsd: number;
  pricing: { inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number };
  cases: ChatPrivateCaseV1[];
}

interface BooleanReviewV1 {
  usefulness: boolean;
  sourceChoice: boolean;
  citations: boolean;
  visibleActivity: boolean;
  followUpCoherence: boolean;
  latencyCostTradeoff: boolean;
}

interface InstalledReviewV1 {
  caseId: string;
  variant: "quick" | "auto" | "deep";
  durationMs: number;
  costMicros: number;
  sourceSelection: boolean;
  citationSupport: boolean;
  outcome: boolean;
  modeIsolation: boolean;
  visibleActivity: boolean;
}

export interface ChatPrivateReviewV1 {
  schema: typeof REVIEW_SCHEMA;
  runs: Array<{ caseId: string; variant: ChatReleaseCandidateVariantV1; review: BooleanReviewV1 }>;
  installedRuns: InstalledReviewV1[];
}

interface ProcessResultV1 { exitCode: number; stdout: string; stderr: string }
export type ChatPrivateProcessRunnerV1 = (command: readonly string[], context: {
  caseId: string;
  variant: ChatReleaseCandidateVariantV1;
  turnIndex: number;
}) => Promise<ProcessResultV1>;

export interface ChatPrivateSuiteArgumentsV1 {
  suitePath: string;
  outputDirectory: string;
  reviewPath?: string;
  mode: "source" | "built";
  caseId?: string;
  variant?: ChatReleaseCandidateVariantV1;
}

export interface ChatPrivateProofAuthorityV1 {
  /** Test-only injection seam; production callers always use the clean Git checkout. */
  sourceRevision?: () => Promise<string>;
}

export function chatPrivateSuiteEnvironmentV1(
  args: ChatPrivateSuiteArgumentsV1,
  base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return {
    ...base,
    ATLCLI_DISABLE_UPDATE_CHECK: "1",
    ATLCLI_RESEARCH_SESSIONS_DIR: join(args.outputDirectory, "sessions"),
  };
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function externalPath(value: string, label: string, repositoryRoot = REPOSITORY_ROOT): string {
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
  const path = resolve(value);
  if (inside(resolve(repositoryRoot), path)) throw new Error(`${label} must point outside the repository.`);
  return path;
}

function finiteNumber(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function strings(value: unknown, label: string, maximum = 32): string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${label} is invalid.`);
  }
  return value.map((entry) => entry.trim());
}

function gold(value: unknown): ChatPrivateGoldV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Private Chat gold is invalid.");
  const candidate = value as Partial<ChatPrivateGoldV1>;
  if (!Array.isArray(candidate.requiredFactGroups) || candidate.requiredFactGroups.length > 24 ||
      candidate.requiredFactGroups.some((group) => !Array.isArray(group) || group.length === 0 || group.length > 8 ||
        group.some((entry) => typeof entry !== "string" || !entry.trim())) ||
      typeof candidate.expectAbstention !== "boolean") {
    throw new Error("Private Chat gold is invalid.");
  }
  return {
    requiredSourceUrls: strings(candidate.requiredSourceUrls, "Private required sources"),
    allowedSourceUrls: strings(candidate.allowedSourceUrls, "Private allowed sources"),
    requiredFactGroups: candidate.requiredFactGroups.map((group) => group.map((entry) => entry.trim())),
    requiredOrderedFactGroups: candidate.requiredOrderedFactGroups === undefined
      ? []
      : (() => {
          if (!Array.isArray(candidate.requiredOrderedFactGroups) ||
              candidate.requiredOrderedFactGroups.length > 24 ||
              candidate.requiredOrderedFactGroups.some((group) =>
                !Array.isArray(group) || group.length === 0 || group.length > 8 ||
                group.some((entry) => typeof entry !== "string" || !entry.trim())
              )) {
            throw new Error("Private ordered fact groups are invalid.");
          }
          return candidate.requiredOrderedFactGroups.map((group) =>
            group.map((entry) => entry.trim())
          );
        })(),
    forbiddenClaims: strings(candidate.forbiddenClaims, "Private forbidden claims"),
    expectAbstention: candidate.expectAbstention,
  };
}

export function parseChatPrivateSuiteV1(value: unknown): ChatPrivateSuiteV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Private Chat suite is invalid.");
  const suite = value as Partial<ChatPrivateSuiteV1>;
  if (suite.schema !== SUITE_SCHEMA || typeof suite.profile !== "string" || !suite.profile.trim() ||
      (suite.reportLanguage !== "en" && suite.reportLanguage !== "de") ||
      !Number.isSafeInteger(suite.maxRunMinutes) || (suite.maxRunMinutes ?? 0) < 1 || (suite.maxRunMinutes ?? 0) > 10 ||
      !suite.pricing || !Array.isArray(suite.cases) || suite.cases.length < 2 || suite.cases.length > 8) {
    throw new Error("Private Chat suite is invalid.");
  }
  const ids = new Set<string>();
  const cases = suite.cases.map((entry): ChatPrivateCaseV1 => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Private Chat case is invalid.");
    const candidate = entry as Partial<ChatPrivateCaseV1>;
    if (typeof candidate.id !== "string" || !CASE_ID.test(candidate.id) || ids.has(candidate.id) ||
        !Array.isArray(candidate.variants) || candidate.variants.length === 0 ||
        candidate.variants.some((variant) => !VARIANTS.includes(variant)) || new Set(candidate.variants).size !== candidate.variants.length ||
        !Array.isArray(candidate.turns) || candidate.turns.length === 0 || candidate.turns.length > 3) {
      throw new Error("Private Chat case is invalid.");
    }
    ids.add(candidate.id);
    const turns = candidate.turns.map((turn): ChatPrivateTurnV1 => {
      if (!turn || typeof turn !== "object" || Array.isArray(turn)) throw new Error("Private Chat turn is invalid.");
      const item = turn as Partial<ChatPrivateTurnV1>;
      if (typeof item.question !== "string" || item.question.trim().length < 3 || item.question.length > 4_000) {
        throw new Error("Private Chat turn is invalid.");
      }
      return { question: item.question.trim(), gold: gold(item.gold) };
    });
    return {
      id: candidate.id,
      projectKeys: strings(candidate.projectKeys, "Private project keys", 8),
      spaceKeys: strings(candidate.spaceKeys, "Private space keys", 8),
      variants: [...candidate.variants],
      turns,
    };
  });
  return {
    schema: SUITE_SCHEMA,
    profile: suite.profile.trim(),
    reportLanguage: suite.reportLanguage,
    maxRunMinutes: suite.maxRunMinutes!,
    maxCostUsd: finiteNumber(suite.maxCostUsd, 0.01, 25, "Private maxCostUsd"),
    pricing: {
      inputUsdPerMillionTokens: finiteNumber(suite.pricing.inputUsdPerMillionTokens, 0, 1_000, "Private input pricing"),
      outputUsdPerMillionTokens: finiteNumber(suite.pricing.outputUsdPerMillionTokens, 0, 1_000, "Private output pricing"),
    },
    cases,
  };
}

export function parseChatPrivateSuiteArgumentsV1(argv: readonly string[], repositoryRoot = REPOSITORY_ROOT): ChatPrivateSuiteArgumentsV1 {
  let suitePath = "";
  let outputDirectory = "";
  let reviewPath: string | undefined;
  let mode: ChatPrivateSuiteArgumentsV1["mode"] = "source";
  let caseId: string | undefined;
  let variant: ChatReleaseCandidateVariantV1 | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!;
    const take = (): string => {
      const value = argv[index + 1]?.trim();
      if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
      index += 1;
      return value;
    };
    if (option === "--suite") suitePath = take();
    else if (option === "--output-dir") outputDirectory = take();
    else if (option === "--review") reviewPath = take();
    else if (option === "--case") {
      const value = take();
      if (!CASE_ID.test(value)) throw new Error("--case must be an opaque private case ID.");
      caseId = value;
    } else if (option === "--variant") {
      const value = take() as ChatReleaseCandidateVariantV1;
      if (!VARIANTS.includes(value)) throw new Error("--variant is invalid.");
      variant = value;
    }
    else if (option === "--mode") {
      const value = take();
      if (value !== "source" && value !== "built") throw new Error("--mode must be source or built.");
      mode = value;
    } else throw new Error(`Unknown option: ${option}`);
  }
  return {
    suitePath: externalPath(suitePath, "--suite", repositoryRoot),
    outputDirectory: externalPath(outputDirectory, "--output-dir", repositoryRoot),
    ...(reviewPath ? { reviewPath: externalPath(reviewPath, "--review", repositoryRoot) } : {}),
    ...(caseId ? { caseId } : {}),
    ...(variant ? { variant } : {}),
    mode,
  };
}

/** Select one bounded live proof without copying private suite data. */
export function selectChatPrivateSuiteV1(
  suite: ChatPrivateSuiteV1,
  args: Pick<ChatPrivateSuiteArgumentsV1, "caseId" | "variant">,
): ChatPrivateSuiteV1 {
  const cases = suite.cases
    .filter((entry) => args.caseId === undefined || entry.id === args.caseId)
    .map((entry) => ({
      ...structuredClone(entry),
      variants: entry.variants.filter((variant) =>
        args.variant === undefined || variant === args.variant
      ),
    }))
    .filter((entry) => entry.variants.length > 0);
  if (cases.length === 0) {
    throw new Error("The selected private case and variant are not present in the suite.");
  }
  return { ...structuredClone(suite), cases };
}

function executable(mode: ChatPrivateSuiteArgumentsV1["mode"], repositoryRoot: string): string[] {
  return mode === "source"
    ? [process.execPath, "--conditions=development", "run", "--cwd", "apps/cli", "src/index.ts"]
    : [process.execPath, resolve(repositoryRoot, "dist/index.js")];
}

export function buildChatPrivateCommandV1(input: {
  args: ChatPrivateSuiteArgumentsV1;
  suite: ChatPrivateSuiteV1;
  entry: ChatPrivateCaseV1;
  variant: ChatReleaseCandidateVariantV1;
  turnIndex: number;
  sessionId?: string;
  outputPath: string;
  repositoryRoot?: string;
}): string[] {
  const root = input.repositoryRoot ?? REPOSITORY_ROOT;
  const turn = input.entry.turns[input.turnIndex]!;
  if (input.variant === "deep-research") {
    if (input.turnIndex !== 0) throw new Error("Deep Research private runs are one-shot controls.");
    return [
      ...executable(input.args.mode, root), "research", turn.question,
      "--profile", input.suite.profile,
      ...input.entry.projectKeys.flatMap((key) => ["--project", key]),
      ...input.entry.spaceKeys.flatMap((key) => ["--space", key]),
      "--language", input.suite.reportLanguage,
      "--effort", "deep", "--plan-approval", "automatic", "--scope-expansion", "strict",
      "--reconciliation", "auto", "--max-run-minutes", String(input.suite.maxRunMinutes),
      "--max-cost-usd", String(input.suite.maxCostUsd), "--json", "--no-log", "--output", input.outputPath,
    ];
  }
  const retained = input.sessionId !== undefined;
  const scopeOrSession: string[] = input.sessionId !== undefined
    ? ["--session", input.sessionId]
    : [
        ...input.entry.projectKeys.flatMap((key) => ["--project", key]),
        ...input.entry.spaceKeys.flatMap((key) => ["--space", key]),
      ];
  return [
    ...executable(input.args.mode, root), "chat", turn.question,
    ...scopeOrSession,
    "--profile", input.suite.profile, "--thinking", input.variant,
    ...(retained ? [] : [
      "--language", input.suite.reportLanguage, "--max-run-minutes", String(input.suite.maxRunMinutes),
      "--max-cost-usd", String(input.suite.maxCostUsd),
    ]),
    "--keep-session", "--json", "--no-log", "--output", input.outputPath,
  ];
}

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\p{Dash_Punctuation}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("de-DE");
}

function normalizedFact(value: string): string {
  return normalized(value)
    .replace(
      /(\d+(?:[.,]\d+)?)\s*(?:→|->)\s*(\d+(?:[.,]\d+)?)\s*(%|[\p{L}][\p{L}\d./_-]{0,24})/gu,
      "$1 $3 $2 $3",
    )
    .replace(/\bt\s*&\s*m\b/gu, "time material")
    .replace(/\btime\s*(?:&|and)\s*material\b/gu, "time material")
    .replace(/\bvorrang\s+vor\b/gu, "vor")
    .replace(/\bverlustfrei(?:e|em|en|er|es)?\b/gu, "verlustfrei")
    .replace(/\bverlustlos(?:e|em|en|er|es)?\b/gu, "verlustlos")
    .replace(/\b(?:weder|nicht\s+als)\b/gu, "kein")
    .replace(/\b(?:keine|keinen|keiner|keines)\b/gu, "kein")
    .replace(/\b(?:ein|eine|einen|einem|einer|eines)\b/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function privateFactGroupMatchesV1(
  markdown: string,
  alternatives: readonly string[],
): boolean {
  const body = normalizedFact(markdown);
  return alternatives.some((alternative) => body.includes(normalizedFact(alternative)));
}

/**
 * Verify an operator-authored semantic order without persisting answer text in
 * the release receipt. Each group may contain wording alternatives; the first
 * matching occurrence of every successive group must move forward.
 */
export function privateOrderedFactGroupsMatchV1(
  markdown: string,
  groups: readonly (readonly string[])[],
): boolean {
  if (groups.length === 0) return true;
  const body = normalizedFact(markdown);
  let after = -1;
  for (const alternatives of groups) {
    const positions = alternatives
      .map((alternative) => normalizedFact(alternative))
      .filter(Boolean)
      .map((alternative) => body.indexOf(alternative, after + 1))
      .filter((position) => position >= 0);
    if (positions.length === 0) return false;
    after = Math.min(...positions);
  }
  return true;
}

export function privateForbiddenClaimMatchesV1(
  markdown: string,
  claim: string,
): boolean {
  const body = normalized(markdown);
  const needle = normalized(claim);
  if (!needle) return false;
  let offset = 0;
  while (offset < body.length) {
    const index = body.indexOf(needle, offset);
    if (index === -1) return false;
    const sentenceStart = Math.max(
      body.lastIndexOf(".", index - 1),
      body.lastIndexOf("!", index - 1),
      body.lastIndexOf("?", index - 1),
      body.lastIndexOf(";", index - 1),
      body.lastIndexOf("\n", index - 1),
    ) + 1;
    const prefix = body.slice(sentenceStart, index).slice(-120);
    const negated = /(?:\bnicht\b|\bkein(?:e[rmns]?)?\b|\bweder\b|\bohne\b|\bungeeignet\b|\bunmöglich\b|\bzu groß,?\s+um\b)[^.!?;]{0,100}$/u
      .test(prefix);
    if (!negated) return true;
    offset = index + needle.length;
  }
  return false;
}

export function normalizePrivateSourceIdentityV1(value: string): string {
  try {
    const url = new URL(value);
    const page = url.pathname.match(/\/wiki\/.*?\/pages\/(\d+)/u);
    if (page) return `wiki:${page[1]}`;
    const blog = url.pathname.match(/\/wiki\/.*?\/blog\/\d{4}\/\d{2}\/\d{2}\/(\d+)(?:\/|$)/u);
    if (blog) return `wiki:${blog[1]}`;
    const issue = url.pathname.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)/u);
    if (issue) return `jira:${issue[1]}`;
    return `${url.origin}${url.pathname.replace(/\/$/u, "")}`;
  } catch {
    return value.trim();
  }
}

interface ProjectedAnswerV1 {
  markdown: string;
  sourceUrls: string[];
  qualityMode: ChatReleaseCandidateVariantV1;
  durationMs: number;
  modelCalls: number;
  ptcCalls: number;
  httpCalls: number;
  inputTokens: number;
  outputTokens: number;
  sessionId?: string;
}

export function projectPrivateAnswerV1(stdout: string, variant: ChatReleaseCandidateVariantV1): ProjectedAnswerV1 {
  const value = JSON.parse(stdout) as Record<string, unknown>;
  if (variant === "deep-research") {
    const report = value.report as { markdown?: unknown; sources?: Array<{ url?: unknown }>; run?: Record<string, unknown> } | undefined;
    if (!report || typeof report.markdown !== "string" || !Array.isArray(report.sources)) throw new Error("Private Research output is invalid.");
    const run = report.run ?? {};
    const usage = run.usage as Record<string, unknown> | undefined;
    const counts = run.counts as Record<string, unknown> | undefined;
    return {
      markdown: report.markdown,
      sourceUrls: report.sources.flatMap((source) => typeof source.url === "string" ? [source.url] : []),
      qualityMode: variant,
      durationMs: typeof run.durationMs === "number" ? run.durationMs : 0,
      modelCalls: typeof counts?.modelCalls === "number" ? counts.modelCalls : 0,
      ptcCalls: typeof counts?.ptcCalls === "number" ? counts.ptcCalls : 0,
      httpCalls: typeof counts?.httpCalls === "number" ? counts.httpCalls : 0,
      inputTokens: typeof usage?.inputTokens === "number" ? usage.inputTokens : 0,
      outputTokens: typeof usage?.outputTokens === "number" ? usage.outputTokens : 0,
      ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
    };
  }
  const answer = value.answer as { messageMarkdown?: unknown; citations?: Array<{ url?: unknown }>; strategy?: { qualityMode?: unknown }; run?: Record<string, unknown> } | undefined;
  if (!answer || typeof answer.messageMarkdown !== "string" || !Array.isArray(answer.citations) || answer.strategy?.qualityMode !== variant) {
    throw new Error("Private Chat output is invalid.");
  }
  const run = answer.run ?? {};
  const usage = run.usage as Record<string, unknown> | undefined;
  const counts = run.counts as Record<string, unknown> | undefined;
  const routing = run.modelRouting as { callsByRoute?: Record<string, number> } | undefined;
  return {
    markdown: answer.messageMarkdown,
    sourceUrls: answer.citations.flatMap((source) => typeof source.url === "string" ? [source.url] : []),
    qualityMode: variant,
    durationMs: typeof run.durationMs === "number" ? run.durationMs : 0,
    modelCalls: Object.values(routing?.callsByRoute ?? {}).reduce((sum, count) => sum + count, 0),
    ptcCalls: typeof counts?.ptcCalls === "number" ? counts.ptcCalls : 0,
    httpCalls: typeof counts?.httpCalls === "number" ? counts.httpCalls : 0,
    inputTokens: typeof usage?.inputTokens === "number" ? usage.inputTokens : 0,
    outputTokens: typeof usage?.outputTokens === "number" ? usage.outputTokens : 0,
    ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
  };
}

function evaluateGold(answer: ProjectedAnswerV1, gold: ChatPrivateGoldV1): {
  sourceSelection: boolean;
  citationSupport: boolean;
  requiredFactCoverage: boolean;
  claimSupport: boolean;
  outcome: boolean;
} {
  const actual = new Set(answer.sourceUrls.map(normalizePrivateSourceIdentityV1));
  const required = gold.requiredSourceUrls.map(normalizePrivateSourceIdentityV1);
  const allowed = new Set(gold.allowedSourceUrls.map(normalizePrivateSourceIdentityV1));
  const sourceSelection = required.every((source) => actual.has(source)) && [...actual].every((source) => allowed.has(source));
  const citationSupport = answer.sourceUrls.length > 0 && answer.sourceUrls.every((url) => /^https:\/\//u.test(url));
  const body = normalized(answer.markdown);
  const facts = gold.requiredFactGroups.every((alternatives) =>
    privateFactGroupMatchesV1(answer.markdown, alternatives)
  ) && privateOrderedFactGroupsMatchV1(
    answer.markdown,
    gold.requiredOrderedFactGroups,
  );
  const forbidden = gold.forbiddenClaims.some((claim) =>
    privateForbiddenClaimMatchesV1(answer.markdown, claim)
  );
  const abstained = /(?:nicht (?:ausreichend )?belegt|keine (?:ausreichenden )?belege|cannot (?:be )?establish|insufficient evidence)/iu.test(answer.markdown);
  return {
    sourceSelection,
    citationSupport,
    requiredFactCoverage: facts,
    claimSupport: !forbidden,
    outcome: gold.expectAbstention ? abstained : facts && !forbidden,
  };
}

function check(name: ChatReleaseCandidateCheckResultV1["check"], passed: boolean, applicable = true): ChatReleaseCandidateCheckResultV1 {
  return { check: name, status: applicable ? (passed ? "passed" : "failed") : "not-applicable" };
}

function failureCodes(checks: readonly ChatReleaseCandidateCheckResultV1[]): ChatReleaseCandidateFailureCodeV1[] {
  const failed = new Set(checks.filter((entry) => entry.status === "failed").map((entry) => entry.check));
  const codes: ChatReleaseCandidateFailureCodeV1[] = [];
  if (failed.has("source-selection")) codes.push("wrong-source");
  if (failed.has("citation-support")) codes.push("citation-invalid");
  if (failed.has("required-fact-coverage")) codes.push("required-fact-missing");
  if (failed.has("claim-support")) codes.push("unsupported-claim");
  if (failed.has("outcome")) codes.push("outcome-incorrect");
  if (failed.has("mode-isolation")) codes.push("mode-isolation-failed");
  if (failed.has("three-turn-new-acquisition") || failed.has("follow-up-coherence")) codes.push("lifecycle-failed");
  if (failed.has("answer-integrity")) codes.push("answer-integrity-failed");
  return codes;
}

/**
 * Research reports intentionally restate supported claims between their summary,
 * findings, and per-claim source notes. The conversational de-duplication
 * heuristic is therefore not a valid report gate. Grammar and evidence-
 * classification conflicts remain blocking in every mode.
 */
export function privateAnswerIntegrityIssuesV1(
  markdown: string,
  variant: ChatReleaseCandidateVariantV1,
): string[] {
  const issues = chatMarkdownIntegrityIssuesV1(markdown);
  return variant === "deep-research"
    ? issues.filter((issue) => issue !== "repeated-prose")
    : issues;
}

async function privateRun(input: {
  entry: ChatPrivateCaseV1;
  variant: ChatReleaseCandidateVariantV1;
  answers: ProjectedAnswerV1[];
  pricing: ChatPrivateSuiteV1["pricing"];
}): Promise<ChatReleaseCandidateRunV1> {
  const scored = input.answers.map((answer, index) => evaluateGold(answer, input.entry.turns[index]!.gold));
  const connected = input.variant === "deep-research" ||
    (input.answers.length === input.entry.turns.length && new Set(input.answers.map((answer) => answer.sessionId)).size === 1);
  const threeTurn = input.variant !== "deep-research" && input.entry.turns.length === 3;
  const checks = [
    check("source-selection", scored.every((entry) => entry.sourceSelection)),
    check("citation-support", scored.every((entry) => entry.citationSupport)),
    check("required-fact-coverage", scored.every((entry) => entry.requiredFactCoverage)),
    check("claim-support", scored.every((entry) => entry.claimSupport)),
    check("outcome", scored.every((entry) => entry.outcome)),
    check("mode-isolation", input.answers.every((answer) => answer.qualityMode === input.variant)),
    check("three-turn-new-acquisition", connected, threeTurn),
    check("follow-up-coherence", connected && scored.slice(1).every((entry) => entry.outcome), input.variant !== "deep-research" && input.entry.turns.length > 1),
    check("answer-integrity", input.answers.every((answer) =>
      privateAnswerIntegrityIssuesV1(answer.markdown, input.variant).length === 0
    )),
  ];
  const failures = failureCodes(checks);
  const sum = (key: "durationMs" | "modelCalls" | "ptcCalls" | "httpCalls" | "inputTokens" | "outputTokens") =>
    input.answers.reduce((total, answer) => total + answer[key], 0);
  const inputTokens = sum("inputTokens");
  const outputTokens = sum("outputTokens");
  return finalizeChatReleaseCandidateRunV1({
    schema: "atlcli.chat-release-candidate-run/v1",
    caseId: `private:${input.entry.id}`,
    variant: input.variant,
    status: failures.length === 0 ? "passed" : "failed",
    checks,
    failureCodes: failures,
    measurements: {
      durationMs: sum("durationMs"), modelCalls: sum("modelCalls"), ptcCalls: sum("ptcCalls"), httpCalls: sum("httpCalls"),
      inputTokens, outputTokens,
      costMicros: Math.ceil(inputTokens * input.pricing.inputUsdPerMillionTokens + outputTokens * input.pricing.outputUsdPerMillionTokens),
    },
  });
}

export function requireCleanPrivateProofRevisionV1(input: {
  revision: string;
  porcelainStatus: string;
}): string {
  const revision = input.revision.trim();
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error("Private release proof requires one full Git commit revision.");
  }
  if (input.porcelainStatus.trim()) {
    throw new Error(
      "Private release proof requires a clean worktree; commit or remove every tracked and untracked change first.",
    );
  }
  return revision;
}

async function sourceRevision(): Promise<string> {
  const porcelainStatus = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  );
  const revision = execFileSync(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  );
  return requireCleanPrivateProofRevisionV1({ revision, porcelainStatus });
}

async function writeProof(path: string, proof: ChatReleaseCandidateProofV1): Promise<void> {
  await writeFile(path, `${JSON.stringify(proof, undefined, 2)}\n`, { mode: 0o600 });
}

export async function runChatPrivateSuiteV1(
  args: ChatPrivateSuiteArgumentsV1,
  suite: ChatPrivateSuiteV1,
  runner: ChatPrivateProcessRunnerV1,
  authority: ChatPrivateProofAuthorityV1 = {},
): Promise<ChatReleaseCandidateProofV1> {
  await mkdir(args.outputDirectory, { recursive: true, mode: 0o700 });
  const runs: ChatReleaseCandidateRunV1[] = [];
  for (const entry of suite.cases) {
    for (const variant of entry.variants) {
      const answers: ProjectedAnswerV1[] = [];
      let sessionId: string | undefined;
      const turns = variant === "deep-research" ? entry.turns.slice(0, 1) : entry.turns;
      for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
        const prefix = `${entry.id}.${variant}.turn-${turnIndex + 1}`;
        const outputPath = join(args.outputDirectory, `${prefix}.md`);
        const result = await runner(buildChatPrivateCommandV1({ args, suite, entry, variant, turnIndex, sessionId, outputPath }), {
          caseId: entry.id, variant, turnIndex,
        });
        await writeFile(join(args.outputDirectory, `${prefix}.stdout.json`), result.stdout, { mode: 0o600 });
        await writeFile(join(args.outputDirectory, `${prefix}.stderr.log`), result.stderr, { mode: 0o600 });
        if (result.exitCode !== 0) throw new Error(`Private case ${entry.id} ${variant} turn ${turnIndex + 1} failed.`);
        const answer = projectPrivateAnswerV1(result.stdout, variant);
        if (variant !== "deep-research" && !answer.sessionId) throw new Error("Private Chat output omitted its durable session ID.");
        sessionId = answer.sessionId;
        answers.push(answer);
      }
      runs.push(await privateRun({ entry, variant, answers, pricing: suite.pricing }));
    }
  }
  const proof = await finalizeChatReleaseCandidateProofV1({
    proofId: "private-cli-quality", producer: "private-cli-runner", producedAt: new Date().toISOString(),
    sourceRevision: await (authority.sourceRevision ?? sourceRevision)(),
    manifestFingerprint: await fingerprintChatReleaseCandidateManifestV1(), runs,
  });
  await writeProof(join(args.outputDirectory, "private-cli-proof.json"), proof);
  return proof;
}

function parseReview(value: unknown): ChatPrivateReviewV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Private review is invalid.");
  const review = value as Partial<ChatPrivateReviewV1>;
  if (review.schema !== REVIEW_SCHEMA || !Array.isArray(review.runs) || !Array.isArray(review.installedRuns)) throw new Error("Private review is invalid.");
  const runs = review.runs.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Private review run is invalid.");
    const item = entry as ChatPrivateReviewV1["runs"][number];
    if (!CASE_ID.test(item.caseId) || !VARIANTS.includes(item.variant) || !item.review ||
        Object.values(item.review).some((decision) => typeof decision !== "boolean")) throw new Error("Private review run is invalid.");
    return structuredClone(item);
  });
  const installedRuns = review.installedRuns.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Installed review run is invalid.");
    const item = entry as InstalledReviewV1;
    if (!CASE_ID.test(item.caseId) || !CHAT_VARIANTS.includes(item.variant) ||
        !Number.isSafeInteger(item.durationMs) || item.durationMs < 0 || !Number.isSafeInteger(item.costMicros) || item.costMicros < 0 ||
        [item.sourceSelection, item.citationSupport, item.outcome, item.modeIsolation, item.visibleActivity].some((decision) => typeof decision !== "boolean")) {
      throw new Error("Installed review run is invalid.");
    }
    return structuredClone(item);
  });
  return { schema: REVIEW_SCHEMA, runs, installedRuns };
}

export async function finalizeChatPrivateReviewV1(
  args: ChatPrivateSuiteArgumentsV1,
  reviewValue: unknown,
  authority: ChatPrivateProofAuthorityV1 = {},
): Promise<{
  operator: ChatReleaseCandidateProofV1;
  installed: ChatReleaseCandidateProofV1;
}> {
  await mkdir(args.outputDirectory, { recursive: true, mode: 0o700 });
  const review = parseReview(reviewValue);
  const revision = await (authority.sourceRevision ?? sourceRevision)();
  const manifest = await fingerprintChatReleaseCandidateManifestV1();
  const operatorRuns = await Promise.all(review.runs.map(async (entry) => {
    const decisions = entry.review;
    const checks = [
      check("usefulness", decisions.usefulness), check("source-selection", decisions.sourceChoice),
      check("citation-support", decisions.citations), check("visible-activity", decisions.visibleActivity),
      check("follow-up-coherence", decisions.followUpCoherence), check("latency-cost-tradeoff", decisions.latencyCostTradeoff),
    ];
    const failed = checks.some((entry) => entry.status === "failed");
    return finalizeChatReleaseCandidateRunV1({
      schema: "atlcli.chat-release-candidate-run/v1", caseId: `private:${entry.caseId}`, variant: entry.variant,
      status: failed ? "failed" : "passed", checks,
      failureCodes: failed ? ["operator-review-rejected"] : [], measurements: { durationMs: 0 },
    });
  }));
  const installedRuns = await Promise.all(review.installedRuns.map(async (entry) => {
    const checks = [
      check("source-selection", entry.sourceSelection), check("citation-support", entry.citationSupport),
      check("outcome", entry.outcome), check("mode-isolation", entry.modeIsolation), check("visible-activity", entry.visibleActivity),
    ];
    const failed = checks.some((item) => item.status === "failed");
    return finalizeChatReleaseCandidateRunV1({
      schema: "atlcli.chat-release-candidate-run/v1", caseId: `private:${entry.caseId}`, variant: entry.variant,
      status: failed ? "failed" : "passed", checks,
      failureCodes: failed ? ["operator-review-rejected"] : [],
      measurements: { durationMs: entry.durationMs, costMicros: entry.costMicros },
    });
  }));
  const operator = await finalizeChatReleaseCandidateProofV1({
    proofId: "private-operator-review", producer: "operator-review", producedAt: new Date().toISOString(),
    sourceRevision: revision, manifestFingerprint: manifest, runs: operatorRuns,
  });
  const installed = await finalizeChatReleaseCandidateProofV1({
    proofId: "private-installed-mv3", producer: "installed-production-mv3", producedAt: new Date().toISOString(),
    sourceRevision: revision, manifestFingerprint: manifest, runs: installedRuns,
  });
  await writeProof(join(args.outputDirectory, "private-operator-proof.json"), operator);
  await writeProof(join(args.outputDirectory, "private-installed-proof.json"), installed);
  return { operator, installed };
}

async function capture(stream: ReadableStream<Uint8Array>, forward: boolean): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    result += chunk;
    if (forward) process.stderr.write(chunk);
  }
  result += decoder.decode();
  return result;
}

async function main(argv = Bun.argv.slice(2)): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error("ANTHROPIC_API_KEY is missing from the process environment.");
  const args = parseChatPrivateSuiteArgumentsV1(argv);
  const suite = selectChatPrivateSuiteV1(
    parseChatPrivateSuiteV1(JSON.parse(await readFile(args.suitePath, "utf8"))),
    args,
  );
  const proof = await runChatPrivateSuiteV1(args, suite, async (command) => {
    const child = Bun.spawn([...command], {
      cwd: REPOSITORY_ROOT, env: chatPrivateSuiteEnvironmentV1(args),
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([capture(child.stdout, false), capture(child.stderr, true), child.exited]);
    return { stdout, stderr, exitCode };
  });
  if (args.reviewPath) await finalizeChatPrivateReviewV1(args, JSON.parse(await readFile(args.reviewPath, "utf8")));
  if (proof.status !== "passed") throw new Error("Private Chat suite failed its local gold; inspect the external artifacts.");
  process.stderr.write(`[chat-e2e] private-suite cases=${proof.measurements.caseCount} runs=${proof.measurements.runCount}\n`);
}

if (import.meta.main) await main();
