import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { createInterface as createLineInterface } from "node:readline";
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
  DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1,
  DEFAULT_RESEARCH_LIMITS_V1,
  CHAT_QUALITY_MODES_V1,
  FileSystemResearchWorkspace,
  RESEARCH_MODEL_ID,
  RESEARCH_PACKET_BODY_SCHEMA_V2,
  RESEARCH_ONE_SHOT_POLICY_SCHEMA_V1,
  RESEARCH_REQUESTED_EFFORTS_V1,
  RESEARCH_REQUESTED_RECONCILIATIONS_V1,
  RESEARCH_REPORT_LANGUAGES_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  RESEARCH_SCOPE_EXPANSION_MODES_V1,
  ResearchScopeCatalogBroker,
  ResearchRunBudget,
  approveResearchScopeExpansionV1,
  continueResearchSessionScopeClarificationV1,
  WorkspaceResearchClaimLedgerV1,
  WorkspaceResearchEvidenceStoreV1,
  WorkspaceResearchOutlineStoreV1,
  createResearchSessionV1,
  createResearchKeyScopeSeedV1,
  researchPolicyFromBriefV1,
  researchRequestFromBriefV1,
  createRestResearchProviders,
  createRestScopeCatalogProviders,
  formatResearchOneShotEventV1,
  normalizeResearchOneShotPolicyV1,
  normalizeResearchRequestV1,
  prepareResearchBriefPreflightV1,
  prepareResearchScopePreflightV1,
  applyChatQualityResourcePolicyV1,
  prepareDirectChatRequestV1,
  openDurableChatConversationWorkspaceV1,
  chatPolicyForThinkingModeV1,
  chatQualityPolicyForModeV1,
  runResearchAgent,
  runChatAgent as runKiteweaveChatAgent,
  CHAT_SESSION_PATH_V1,
  parseChatSessionV1,
  type ResearchBriefPreflightOutcomeV1,
  type ChatQualityPolicyV1,
  type ChatAnswerV1,
  ChatUserQuestionRequiredError,
  CHAT_USER_QUESTION_ANSWER_SCHEMA_V1,
  type ChatUserQuestionAnswerV1,
  type ChatUserQuestionV1,
  type ChatPresentationStreamEventV1,
  type ChatResumeEnvelopeV1,
  type ChatScopeClarificationReviewV1,
  type ChatTurnRequestV1,
  type ResearchBriefV1,
  type ResearchOneShotPolicyV1,
  type ResearchRequestV1,
  type ResearchReportLanguageV1,
  type ResearchOneShotEventV1,
  type ResearchReport,
  type ResearchScopePreflightOptionsV1,
  type ResearchScopePreflightOutcomeV1,
  type ResearchScopeSeedV1,
  type ResearchScopeBindingV1,
  type ResearchSessionTurnV1,
  type ResearchSessionStoreV1,
  type ResearchSessionV1,
  type ResearchWorkspace,
  type WorkspaceChatInteractionControllerV1,
  type ResearchClaimV1,
  type ResearchEvidenceRecordV1,
  type ResearchOutlineV1,
  appendResearchSessionTurnV1,
  initializeResearchSessionClarificationWaitV1,
  initializeResearchSessionScopeClarificationWaitV1,
  initializeResearchSessionTurnV1,
  projectResearchSessionScopeClarificationReviewV1,
  proposeResearchGraphForReadyBriefV1,
  refreshResearchSessionScopeClarificationV1,
  recoverResearchSessionForResumeV1,
  isRecoverableConsumedRetrievalContinuationV1,
  resolveResearchSessionScopeClarificationV1,
  projectChatScopeClarificationReviewV1,
  resolveChatScopeClarificationV1,
} from "@atlcli/research/node";
import { createCliChatAgentPortV1 } from "./chat-agent-port.js";
import { handleCliChatControlLineV1 } from "./chat-controls.js";
import {
  formatCliChatActivityV1,
  formatCliChatCapabilityDetailV1,
} from "./chat-activity.js";
import { SqliteResearchSessionStoreV1 } from "@atlcli/research/bun";
import {
  composeResearchGraphV1,
  createStandardResearchBriefV1,
  diffResearchPlansV1,
  projectSelectedResearchRolesV1,
  researchPlanApprovalRequiredV1,
  type ResearchGraphV1,
} from "@atlcli/research/graph";

export const MAX_AUTOMATIC_CHAT_STREAM_RESUMES_V1 = 2;

export function shouldAutomaticallyResumeChatStreamV1(input: {
  checkpointAvailable: boolean;
  completedAttempts: number;
}): boolean {
  return input.checkpointAvailable &&
    Number.isInteger(input.completedAttempts) &&
    input.completedAttempts >= 0 &&
    input.completedAttempts < MAX_AUTOMATIC_CHAT_STREAM_RESUMES_V1;
}

export interface ResearchCliInput {
  question: string;
  profile?: string;
  projectKeys: string[];
  spaceKeys: string[];
  from?: string;
  to?: string;
  asOf?: string;
  timezone?: string;
  reportLanguage?: ResearchReportLanguageV1;
  outputPath?: string;
  maxRunMinutes: number;
  /** Conservative provider-cost ceiling for a new durable session, in USD. */
  maxCostUsd?: number;
  /** Explicit run-wide input-token ceiling for diagnostic and advanced runs. */
  maxTotalModelInputTokens?: number;
  keepSession: boolean;
  planOnly: boolean;
  /** Resume is deliberately limited to a no-dispatch authentication wait in T4. */
  resumeSessionId?: string;
  /** A new question against a terminal session's preserved scope and policy. */
  newTurnSessionId?: string;
  policy: ResearchOneShotPolicyV1;
  /** Present only for direct Chat; research workflow policy remains separate. */
  qualityPolicy?: ChatQualityPolicyV1;
  /** Whether this turn explicitly selected a mode instead of inheriting it. */
  thinkingModeExplicit?: boolean;
  /** Revision-fenced answer to a durable Chat scope choice. */
  chatScopeSelection?: {
    revision: number;
    mentionId: string;
    candidateId: string;
  };
}

/**
 * Stable opaque CLI principal/cache fences. Raw profile names, usernames and
 * email addresses never enter retained Chat state.
 */
export function cliChatHostIdentityV1(profile: Profile): {
  userId: string;
  providerCacheIdentity: string;
} {
  const principalMaterial = JSON.stringify({
    tenantOrigin: new URL(profile.baseUrl).origin,
    profileName: profile.name,
    authType: profile.auth.type,
    principalHint: profile.auth.email ?? profile.auth.username ?? profile.name,
  });
  const principalHash = createHash("sha256")
    .update(principalMaterial)
    .digest("hex")
    .slice(0, 48);
  return {
    userId: `cli-principal:${principalHash}`,
    providerCacheIdentity: `anthropic:cli-principal:${principalHash}`,
  };
}

const DEFAULT_MAX_RUN_MINUTES = 10;
const MAX_MAX_RUN_MINUTES = 10;
const MAX_MODEL_COST_USD = 25;
const MAX_TOTAL_MODEL_INPUT_TOKENS = 1_000_000;
const T2_RESEARCH_FLAGS = new Set([
  "profile",
  "project",
  "space",
  "from",
  "to",
  "as-of",
  "timezone",
  "language",
  "max-run-minutes",
  "max-cost-usd",
  "max-total-model-input-tokens",
  "output",
  "effort",
  "plan-approval",
  "scope-expansion",
  "reconciliation",
  "keep-session",
  "plan-only",
  "resume",
  "session",
  "json",
  "no-log",
  "help",
  "h",
]);
const T2_VALUE_FLAGS = [
  "profile",
  "project",
  "space",
  "from",
  "to",
  "as-of",
  "timezone",
  "language",
  "max-run-minutes",
  "max-cost-usd",
  "max-total-model-input-tokens",
  "output",
  "effort",
  "plan-approval",
  "scope-expansion",
  "reconciliation",
  "resume",
  "session",
] as const;
const T2_SINGLE_VALUE_FLAGS = T2_VALUE_FLAGS.filter(
  (key) => key !== "project" && key !== "space",
);
const T2_BOOLEAN_FLAGS = [
  "keep-session",
  "plan-only",
  "json",
  "no-log",
  "help",
  "h",
] as const;
const RESEARCH_SESSION_ID_PATTERN = /^research-session:[A-Za-z0-9._-]{1,120}$/;
const CHAT_CONTEXT_REQUEST_PATH_V1 = "/.atlcli/chat-context/v1/request.json";

export interface ResearchCliWorkspace extends ResearchWorkspace {
  readonly root: string;
  dispose(): Promise<void>;
}

export interface ResearchCliAgentInput {
  apiKey: string;
  profile: Profile;
  request: ResearchRequestV1;
  workspace: ResearchWorkspace;
  sessionId: string;
  durableSession: {
    store: ResearchSessionStoreV1;
    sessionId: string;
    turnId: string;
  };
  researchGraph: ResearchGraphV1;
  brief: ResearchBriefV1;
  signal: AbortSignal;
  onEvent: (event: ResearchOneShotEventV1) => void;
  writeDiagnostic: (message: string) => void;
}

export interface ResearchCliChatAgentInput {
  apiKey: string;
  profile: Profile;
  request: ResearchRequestV1;
  workspace: ResearchWorkspace;
  sessionId: string;
  turnId: string;
  conversation: { sessionId: string };
  policy: ResearchOneShotPolicyV1;
  qualityPolicy: ChatQualityPolicyV1;
  resumeAnswer?: ChatUserQuestionAnswerV1;
  resumeCheckpoint?: { kind: "stream-interruption" | "steering" };
  signal: AbortSignal;
  onEvent: (event: ResearchOneShotEventV1) => void;
  onChatPresentation: (event: ChatPresentationStreamEventV1) => void;
  onInteractionReady?(controller: WorkspaceChatInteractionControllerV1): void;
  onResumeEnvelopeReady?(resume: ChatResumeEnvelopeV1): void;
  writeDiagnostic: (message: string) => void;
}

export interface ResearchCliDependencies {
  resolveProfile(name?: string): Promise<Profile | undefined>;
  resolveScope(input: {
    profile: Profile;
    request: ResearchRequestV1;
    /** Only an exact durable candidate selection can be submitted on recovery. */
    options?: ResearchScopePreflightOptionsV1;
  }): Promise<ResearchScopePreflightOutcomeV1>;
  prepareBrief(input: {
    request: ResearchRequestV1;
    policy: ResearchOneShotPolicyV1;
    asOf: string;
    timezone?: string;
    sessionId?: string;
    turnId?: string;
    /** A follow-up turn inherits only persisted, host-approved bindings. */
    scopeBindings?: readonly ResearchScopeBindingV1[];
  }): ResearchBriefPreflightOutcomeV1;
  readApiKey(): string | undefined;
  createWorkspace(): Promise<ResearchCliWorkspace>;
  runAgent(input: ResearchCliAgentInput): Promise<ResearchReport>;
  runChatAgent(input: ResearchCliChatAgentInput): Promise<ChatAnswerV1>;
  askChatUserQuestion(question: ChatUserQuestionV1): Promise<ChatUserQuestionAnswerV1>;
  writeAtomic(path: string, contents: string): Promise<void>;
  artifactPath(): string;
  createDurableSessionId(): string;
  createDurableTurnId(): string;
  openSessionStore(): Promise<{
    store: ResearchSessionStoreV1;
    /** Production hosts supply the retained session workspace; test hosts may use the temporary fallback. */
    workspace?(sessionId: string): Promise<ResearchWorkspace>;
    close(): void;
  }>;
  writeStdout(contents: string): void;
  writeStderr(contents: string): void;
  emitOutput(data: unknown, opts: OutputOptions): void;
  fail(
    opts: OutputOptions,
    code: number,
    errCode: string,
    message: string,
    details?: Record<string, unknown>,
  ): never;
  scheduleAbort(callback: () => void, milliseconds: number): unknown;
  cancelScheduledAbort(handle: unknown): void;
  listenForInterrupt(callback: () => void): () => void;
  listenForChatInput(callback: (line: string) => void | Promise<void>): () => void;
}

export function researchArtifactPath(now = new Date()): string {
  const timestamp = now
    .toISOString()
    .replace(/[T:.Z]/g, "-")
    .replace(/-+$/, "");
  return join(
    homedir(),
    "Documents",
    "atlcli",
    "artefacts",
    `research-${timestamp}`,
    "report.md",
  );
}

function uniqueKeys(values: string[], uppercase = true): string[] {
  return [
    ...new Set(
      values
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => (uppercase ? value.toUpperCase() : value)),
    ),
  ];
}

function normalizeAsOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (
      !Number.isNaN(parsed.valueOf()) &&
      parsed.toISOString().slice(0, 10) === value
    ) {
      return value;
    }
  }
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }
  throw new Error(
    "--as-of must use YYYY-MM-DD or an ISO 8601 timestamp with timezone.",
  );
}

function normalizeTimezone(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value;
  } catch {
    throw new Error("--timezone must be a valid IANA timezone name.");
  }
}

function enumFlag<T extends string>(
  flags: Record<string, string | boolean | string[]>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = getFlag(flags, key);
  if (value === undefined) return fallback;
  if (!allowed.includes(value as T)) {
    throw new Error(`--${key} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

export function parseResearchCliInput(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
): ResearchCliInput {
  const secretFlags = ["api-key", "apikey", "anthropic-key", "key"].filter(
    (key) => hasFlag(flags, key),
  );
  if (secretFlags.length > 0) {
    throw new Error(
      "Anthropic API keys are never accepted as command-line flags. Set ANTHROPIC_API_KEY in the process environment.",
    );
  }
  const unknown = Object.keys(flags).filter(
    (key) => !T2_RESEARCH_FLAGS.has(key),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown research option${unknown.length === 1 ? "" : "s"}: ${unknown.map((key) => `--${key}`).join(", ")}. Run \`atlcli research --help\`.`,
    );
  }
  for (const key of T2_VALUE_FLAGS) {
    if (!hasFlag(flags, key)) continue;
    const value = flags[key];
    const values =
      typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
    if (
      values.length === 0 ||
      values.some((entry) => entry.trim().length === 0)
    ) {
      throw new Error(`--${key} requires a value.`);
    }
  }
  for (const key of T2_SINGLE_VALUE_FLAGS) {
    if (Array.isArray(flags[key]))
      throw new Error(`--${key} may be specified only once.`);
  }
  for (const key of T2_BOOLEAN_FLAGS) {
    if (flags[key] !== undefined && flags[key] !== true) {
      throw new Error(`--${key} does not accept a value.`);
    }
  }
  const resumeSessionId = getFlag(flags, "resume");
  if (resumeSessionId !== undefined) {
    requireSessionId(resumeSessionId);
    if (args.length > 0) {
      throw new Error(
        "--resume does not accept a new research question. Start a new turn after durable multi-turn support is available.",
      );
    }
    const incompatible = Object.keys(flags).filter(
      (key) =>
        ![
          "resume",
          "profile",
          "output",
          "keep-session",
          "json",
          "no-log",
          "help",
          "h",
        ].includes(key),
    );
    if (incompatible.length > 0) {
      throw new Error(
        `--resume cannot change persisted scope, policy, or deadline: ${incompatible.map((key) => `--${key}`).join(", ")}.`,
      );
    }
    return {
      question: "",
      profile: getFlag(flags, "profile"),
      projectKeys: [],
      spaceKeys: [],
      ...(getFlag(flags, "output")
        ? { outputPath: getFlag(flags, "output") }
        : {}),
      maxRunMinutes: DEFAULT_MAX_RUN_MINUTES,
      reportLanguage: "en",
      keepSession: hasFlag(flags, "keep-session"),
      planOnly: false,
      resumeSessionId,
      policy: DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1,
    };
  }
  const newTurnSessionId = getFlag(flags, "session");
  if (newTurnSessionId !== undefined) {
    requireSessionId(newTurnSessionId);
    const question = args.join(" ").trim();
    if (!question)
      throw new Error("A new research question is required with --session.");
    const incompatible = Object.keys(flags).filter(
      (key) =>
        ![
          "session",
          "profile",
          "output",
          "keep-session",
          "json",
          "no-log",
          "help",
          "h",
        ].includes(key),
    );
    if (incompatible.length > 0) {
      throw new Error(
        `--session preserves the existing scope, policy, and deadline: ${incompatible.map((key) => `--${key}`).join(", ")}.`,
      );
    }
    return {
      question,
      profile: getFlag(flags, "profile"),
      projectKeys: [],
      spaceKeys: [],
      ...(getFlag(flags, "output")
        ? { outputPath: getFlag(flags, "output") }
        : {}),
      maxRunMinutes: DEFAULT_MAX_RUN_MINUTES,
      reportLanguage: "en",
      keepSession: hasFlag(flags, "keep-session"),
      planOnly: false,
      newTurnSessionId,
      policy: DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1,
    };
  }
  const question = args.join(" ").trim();
  if (!question)
    throw new Error(
      'A research question is required. Example: atlcli research "Which Jira and Confluence items are related?"',
    );
  const from = getFlag(flags, "from");
  const to = getFlag(flags, "to");
  const asOf = normalizeAsOf(getFlag(flags, "as-of"));
  const timezone = normalizeTimezone(getFlag(flags, "timezone"));
  const reportLanguage = enumFlag(
    flags,
    "language",
    RESEARCH_REPORT_LANGUAGES_V1,
    "en",
  );
  const maxRunMinutesFlag = getFlag(flags, "max-run-minutes");
  const maxRunMinutes =
    maxRunMinutesFlag === undefined
      ? DEFAULT_MAX_RUN_MINUTES
      : Number(maxRunMinutesFlag);
  if (
    !Number.isSafeInteger(maxRunMinutes) ||
    maxRunMinutes < 1 ||
    maxRunMinutes > MAX_MAX_RUN_MINUTES
  ) {
    throw new Error(
      `--max-run-minutes must be an integer between 1 and ${MAX_MAX_RUN_MINUTES}.`,
    );
  }
  const maxCostUsdFlag = getFlag(flags, "max-cost-usd");
  const maxCostUsd =
    maxCostUsdFlag === undefined ? undefined : Number(maxCostUsdFlag);
  if (
    maxCostUsd !== undefined &&
    (!Number.isFinite(maxCostUsd) ||
      maxCostUsd <= 0 ||
      maxCostUsd > MAX_MODEL_COST_USD)
  ) {
    throw new Error(
      `--max-cost-usd must be a number greater than 0 and at most ${MAX_MODEL_COST_USD}.`,
    );
  }
  const maxTotalModelInputTokensFlag = getFlag(
    flags,
    "max-total-model-input-tokens",
  );
  const maxTotalModelInputTokens =
    maxTotalModelInputTokensFlag === undefined
      ? undefined
      : Number(maxTotalModelInputTokensFlag);
  if (
    maxTotalModelInputTokens !== undefined &&
    (!Number.isSafeInteger(maxTotalModelInputTokens) ||
      maxTotalModelInputTokens < 1_000 ||
      maxTotalModelInputTokens > MAX_TOTAL_MODEL_INPUT_TOKENS)
  ) {
    throw new Error(
      `--max-total-model-input-tokens must be an integer between 1000 and ${MAX_TOTAL_MODEL_INPUT_TOKENS}.`,
    );
  }
  const requestedPlanApproval =
    getFlag(flags, "plan-approval") ??
    DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1.requestedPlanApproval;
  if (
    requestedPlanApproval !== "default" &&
    requestedPlanApproval !== "automatic"
  ) {
    throw new Error(
      "--plan-approval supports only automatic in the one-shot path; durable required approval arrives in T4.",
    );
  }
  const policy = normalizeResearchOneShotPolicyV1({
    schema: RESEARCH_ONE_SHOT_POLICY_SCHEMA_V1,
    requestedEffort: enumFlag(
      flags,
      "effort",
      RESEARCH_REQUESTED_EFFORTS_V1,
      DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1.requestedEffort,
    ),
    requestedPlanApproval,
    scopeExpansionMode: enumFlag(
      flags,
      "scope-expansion",
      RESEARCH_SCOPE_EXPANSION_MODES_V1,
      DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1.scopeExpansionMode,
    ),
    requestedReconciliation: enumFlag(
      flags,
      "reconciliation",
      RESEARCH_REQUESTED_RECONCILIATIONS_V1,
      DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1.requestedReconciliation,
    ),
  });
  return {
    question: [
      question,
      asOf
        ? reportLanguage === "de"
          ? `Stichtag: ${asOf}.`
          : `As-of date: ${asOf}.`
        : "",
      timezone
        ? reportLanguage === "de"
          ? `Zeitzone: ${timezone}.`
          : `Timezone: ${timezone}.`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    profile: getFlag(flags, "profile"),
    projectKeys: uniqueKeys(getFlags(flags, "project")),
    spaceKeys: uniqueKeys(getFlags(flags, "space"), false),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(asOf ? { asOf } : {}),
    ...(timezone ? { timezone } : {}),
    reportLanguage,
    ...(getFlag(flags, "output")
      ? { outputPath: getFlag(flags, "output") }
      : {}),
    maxRunMinutes,
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    ...(maxTotalModelInputTokens === undefined
      ? {}
      : { maxTotalModelInputTokens }),
    keepSession: hasFlag(flags, "keep-session"),
    planOnly: hasFlag(flags, "plan-only"),
    policy,
  };
}

export function parseChatCliInput(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
): ResearchCliInput {
  const thinkingMode = enumFlag(
    flags,
    "thinking",
    CHAT_QUALITY_MODES_V1,
    "auto",
  );
  const researchFlags = { ...flags };
  delete researchFlags.thinking;
  const scopeRevision = getFlag(flags, "scope-revision");
  const scopeMention = getFlag(flags, "scope-mention");
  const scopeCandidate = getFlag(flags, "scope-candidate");
  delete researchFlags["scope-revision"];
  delete researchFlags["scope-mention"];
  delete researchFlags["scope-candidate"];
  const researchOnly = [
    "from",
    "to",
    "as-of",
    "timezone",
    "effort",
    "plan-approval",
    "scope-expansion",
    "reconciliation",
    "plan-only",
    "resume",
  ].filter((key) => hasFlag(flags, key));
  if (researchOnly.length > 0) {
    throw new Error(
      `Chat does not accept research workflow options: ${researchOnly.map((key) => `--${key}`).join(", ")}. Use \`atlcli research\` for a planned deep-research run.`,
    );
  }
  const parsed = parseResearchCliInput(args, researchFlags);
  const scopeParts = [scopeRevision, scopeMention, scopeCandidate];
  if (scopeParts.some((value) => value !== undefined) &&
      scopeParts.some((value) => value === undefined)) {
    throw new Error(
      "Chat scope clarification requires --scope-revision, --scope-mention, and --scope-candidate together.",
    );
  }
  if (scopeRevision !== undefined && !parsed.newTurnSessionId) {
    throw new Error("Chat scope clarification requires the retained --session ID.");
  }
  const revision = scopeRevision === undefined ? undefined : Number(scopeRevision);
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) {
    throw new Error("--scope-revision must be a positive integer.");
  }
  return {
    ...parsed,
    policy: chatPolicyForThinkingModeV1(thinkingMode),
    qualityPolicy: chatQualityPolicyForModeV1(thinkingMode),
    thinkingModeExplicit: hasFlag(flags, "thinking"),
    planOnly: false,
    ...(revision === undefined ? {} : {
      chatScopeSelection: {
        revision,
        mentionId: scopeMention!,
        candidateId: scopeCandidate!,
      },
    }),
  };
}

function oneLineChatLabel(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function formatChatScopeClarificationForCliV1(
  review: ChatScopeClarificationReviewV1,
): string {
  const candidates = review.clarification.candidates.map((candidate) => {
    const label = oneLineChatLabel(candidate.name);
    const key = candidate.key ? ` (${candidate.key})` : "";
    const status = candidate.status === "archived" ? " [archived]" : "";
    return `  - ${candidate.id}: ${candidate.product} ${label}${key}${status}`;
  });
  const resolution = candidates.length > 0
    ? [
        "Resume with one listed candidate ID:",
        `  atlcli chat --session ${review.sessionId} --scope-revision ${review.revision} --scope-mention ${review.clarification.mentionId} --scope-candidate <candidate-id> continue`,
      ]
    : ["Rerun the original question with an exact --project <KEY> or --space <KEY> context."];
  return [
    "[chat] Scope clarification required before content or model work.",
    `Prompt: ${oneLineChatLabel(review.clarification.rerunGuidance[0] ?? "Choose the intended Atlassian scope.")}`,
    `Session: ${review.sessionId}`,
    `Revision: ${review.revision}`,
    `Mention: ${review.clarification.mentionId}`,
    "Candidates:",
    ...(candidates.length > 0 ? candidates : ["  - No selectable candidate is currently available."]),
    ...resolution,
    "",
  ].join("\n");
}

function requireSessionId(value: string | undefined): string {
  if (!value || !RESEARCH_SESSION_ID_PATTERN.test(value)) {
    throw new Error("A valid durable research session ID is required.");
  }
  return value;
}

function singleSessionFlag(
  flags: Record<string, string | boolean | string[]>,
  key: string,
  required = false,
): string | undefined {
  const value = flags[key];
  if (value === undefined) {
    if (required) throw new Error(`--${key} requires a value.`);
    return undefined;
  }
  if (typeof value !== "string" || !value.trim())
    throw new Error(`--${key} requires a value.`);
  return value.trim();
}

function assertSessionFlags(
  flags: Record<string, string | boolean | string[]>,
  allowedValues: readonly string[],
  allowedBooleans: readonly string[] = [],
  repeatableValues: readonly string[] = [],
): void {
  const permitted = new Set([
    ...allowedValues,
    ...allowedBooleans,
    ...repeatableValues,
    "json",
    "no-log",
    "help",
    "h",
  ]);
  const unknown = Object.keys(flags).filter((key) => !permitted.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown research session option${unknown.length === 1 ? "" : "s"}: ${unknown.map((key) => `--${key}`).join(", ")}.`,
    );
  }
  for (const key of ["json", "no-log", "help", "h", ...allowedBooleans]) {
    if (flags[key] !== undefined && flags[key] !== true)
      throw new Error(`--${key} does not accept a value.`);
  }
  for (const key of allowedValues) {
    if (
      flags[key] !== undefined &&
      (typeof flags[key] !== "string" ||
        Array.isArray(flags[key]) ||
        !flags[key])
    ) {
      throw new Error(`--${key} requires a value.`);
    }
  }
  for (const key of repeatableValues) {
    if (
      flags[key] !== undefined &&
      getFlags(flags, key).some((value) => !value.trim())
    ) {
      throw new Error(`--${key} requires a value.`);
    }
    if (flags[key] !== undefined && getFlags(flags, key).length === 0) {
      throw new Error(`--${key} requires a value.`);
    }
  }
}

function boundedSessionLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("--limit must be an integer between 1 and 100.");
  }
  return parsed;
}

function expectedSessionRevision(value: string | undefined): number {
  if (value === undefined) throw new Error("--revision requires a value.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error("--revision must be a positive integer.");
  return parsed;
}

interface ResearchClarificationAnswerInputV1 {
  questionId: string;
  response: string;
}

interface ResearchAssumptionDecisionInputV1 {
  assumptionId: string;
  decision: "accepted" | "rejected";
}

function splitResearchSessionAssignment(
  value: string,
  option: string,
): [string, string] {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`${option} must use <id>=<value>.`);
  }
  return [value.slice(0, separator).trim(), value.slice(separator + 1).trim()];
}

function clarificationAnswersFromSessionFlags(
  flags: Record<string, string | boolean | string[]>,
): ResearchClarificationAnswerInputV1[] {
  const answers = getFlags(flags, "answer").map((value) => {
    const [questionId, response] = splitResearchSessionAssignment(
      value,
      "--answer",
    );
    if (
      !/^clarification:[A-Za-z0-9._-]{1,120}$/.test(questionId) ||
      !response ||
      response.length > 2_000
    ) {
      throw new Error(
        "--answer must use a valid clarification ID and a response of at most 2000 characters.",
      );
    }
    return { questionId, response };
  });
  if (
    new Set(answers.map((answer) => answer.questionId)).size !== answers.length
  ) {
    throw new Error("--answer cannot repeat a clarification ID.");
  }
  return answers;
}

function assumptionDecisionsFromSessionFlags(
  flags: Record<string, string | boolean | string[]>,
): ResearchAssumptionDecisionInputV1[] {
  const decisions = getFlags(flags, "assumption").map((value) => {
    const [assumptionId, decision] = splitResearchSessionAssignment(
      value,
      "--assumption",
    );
    if (
      !/^assumption:[A-Za-z0-9._-]{1,120}$/.test(assumptionId) ||
      (decision !== "accepted" && decision !== "rejected")
    ) {
      throw new Error(
        "--assumption must use <assumption-id>=accepted|rejected.",
      );
    }
    return { assumptionId, decision } as const;
  });
  if (
    new Set(decisions.map((decision) => decision.assumptionId)).size !==
    decisions.length
  ) {
    throw new Error("--assumption cannot repeat an assumption ID.");
  }
  return decisions;
}

/**
 * The CLI may name only one already-persisted candidate. It cannot attach a
 * replacement request, scope, policy, or candidate body to this action.
 */
function scopeClarificationSelectionFromSessionFlags(
  flags: Record<string, string | boolean | string[]>,
): {
  schema: "atlcli.research-scope-candidate-selection/v1";
  mentionId: string;
  candidateId: string;
} {
  const mentionId = singleSessionFlag(flags, "mention", true)!;
  const candidateId = singleSessionFlag(flags, "candidate", true)!;
  if (!/^mention:[A-Za-z0-9._-]{1,120}$/.test(mentionId)) {
    throw new Error("--mention requires a valid durable scope mention ID.");
  }
  if (!/^research-scope-candidate:[A-Za-z0-9._-]{1,160}$/.test(candidateId)) {
    throw new Error("--candidate requires a valid durable scope candidate ID.");
  }
  return {
    schema: "atlcli.research-scope-candidate-selection/v1",
    mentionId,
    candidateId,
  };
}

function requiredEvidenceId(value: string | undefined): string {
  if (!value || !/^evidence:[a-f0-9]{48}$/.test(value)) {
    throw new Error("A valid retained evidence ID is required.");
  }
  return value;
}

function activeSessionTurn(
  session: ResearchSessionV1,
): ResearchSessionTurnV1 | undefined {
  return (
    session.turns.find((turn) => turn.id === session.activeTurnId) ??
    session.turns.at(-1)
  );
}

async function scopeClarificationReviewForCliSession(input: {
  session: ResearchSessionV1;
  profileName: string | undefined;
  opts: OutputOptions;
  dependencies: ResearchCliDependencies;
}) {
  const profile = await input.dependencies.resolveProfile(input.profileName);
  if (!profile) {
    input.dependencies.fail(
      input.opts,
      1,
      ERROR_CODES.AUTH,
      "No active profile found. Run `atlcli auth login` or select --profile.",
      { profile: input.profileName },
    );
  }
  const tenantOrigin = new URL(profile.baseUrl).origin;
  const review = projectResearchSessionScopeClarificationReviewV1(
    input.session,
    tenantOrigin,
  );
  if (!review) {
    throw new Error(
      "The selected profile cannot access a pending research scope clarification for this session.",
    );
  }
  return { profile, tenantOrigin, review };
}

function scopeApprovalBindingV1(input: {
  turn: ResearchSessionTurnV1;
  proposalId: string;
  approvedAt: string;
}): ResearchScopeBindingV1 {
  const proposal = input.turn.scopeExpansionProposals.find(
    (candidate) => candidate.id === input.proposalId,
  );
  if (!proposal || proposal.status !== "proposed") {
    throw new Error(
      "Research scope expansion proposal is stale, unknown, or already resolved.",
    );
  }
  const candidate = input.turn.scopeCandidates.find(
    (entry) => entry.id === proposal.candidateId,
  );
  if (!candidate) {
    throw new Error(
      "Research scope expansion candidate is no longer available.",
    );
  }
  return {
    schema: "atlcli.research-scope-binding/v1",
    id: `scope-binding:${candidate.id}`,
    tenantOrigin: candidate.tenantOrigin,
    product: candidate.product,
    entityKind: candidate.entityKind,
    entityRef: candidate.entityRef,
    ...(candidate.key ? { key: candidate.key } : {}),
    name: candidate.name,
    source: "research_discovery",
    authority: "approved",
    candidateId: candidate.id,
    approvedAt: input.approvedAt,
  };
}

function projectSessionGraph(
  graph: ResearchGraphV1 | undefined,
): Record<string, unknown> | undefined {
  if (!graph) return undefined;
  return {
    revision: graph.revision,
    status: graph.status,
    resolvedEffort: graph.resolvedEffort,
    roles: projectSelectedResearchRolesV1(graph),
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      roleId: node.roleId,
      dependencies: node.dependencies,
      grantedCapabilityIds: node.grantedCapabilityIds,
      budget: node.budget,
      status: node.status,
    })),
    approvalEnvelope: graph.approvalEnvelope,
    reconciliationPolicy: graph.reconciliationPolicy,
  };
}

/** Excludes source bodies, task prompts, provider data, packet bodies, and hidden reasoning. */
function projectResearchSessionV1(
  session: ResearchSessionV1,
): Record<string, unknown> {
  const turn = activeSessionTurn(session);
  const taskStatusCounts: Record<string, number> = {};
  for (const task of turn?.tasks ?? [])
    taskStatusCounts[task.status] = (taskStatusCounts[task.status] ?? 0) + 1;
  return {
    schema: "atlcli.research-session-view/v1",
    sessionId: session.sessionId,
    revision: session.revision,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lease: { epoch: session.lease.epoch, expiresAt: session.lease.expiresAt },
    retention: session.retention,
    turn: turn && {
      id: turn.id,
      revision: turn.revision,
      createdAt: turn.createdAt,
      brief: turn.brief && {
        revision: turn.brief.revision,
        objective: turn.brief.objective,
        scope: turn.brief.scope,
        scopeBindings: turn.scopeBindings,
        limits: turn.brief.limits,
        clarificationQuestionIds: turn.brief.clarificationQuestions.map(
          (question) => question.id,
        ),
        unresolvedAssumptionIds: turn.brief.assumptions
          .filter(
            (assumption) =>
              assumption.requiresUserDecision &&
              !turn.assumptionDecisions.some(
                (decision) => decision.assumptionId === assumption.id,
              ),
          )
          .map((assumption) => assumption.id),
      },
      graph: projectSessionGraph(turn.graph),
      planRevisions: (turn.planRevisions ?? []).map((revision) => ({
        id: revision.id,
        basedOnBriefRevision: revision.basedOnBriefRevision,
        basedOnGraphRevision: revision.basedOnGraphRevision,
        revisedBriefRevision: revision.revisedBriefRevision,
        proposedGraphRevision: revision.proposedGraphRevision,
        state: revision.state,
        hasInstruction: revision.instruction !== undefined,
        ...(revision.planDiff ? { planDiff: revision.planDiff } : {}),
      })),
      scopeRevisions: (turn.scopeRevisions ?? []).map((revision) => ({
        id: revision.id,
        proposalId: revision.proposalId,
        basedOnBriefRevision: revision.basedOnBriefRevision,
        basedOnGraphRevision: revision.basedOnGraphRevision,
        revisedBriefRevision: revision.revisedBriefRevision,
        proposedGraphRevision: revision.proposedGraphRevision,
        state: revision.state,
        ...(revision.planDiff ? { planDiff: revision.planDiff } : {}),
      })),
      steering: turn.steering.map((control) => ({
        id: control.id,
        basedOnGraphRevision: control.basedOnGraphRevision,
        requestedAt: control.requestedAt,
        state: control.state,
        ...(control.appliedAt === undefined
          ? {}
          : { appliedAt: control.appliedAt }),
        ...(control.appliedGraphRevision === undefined
          ? {}
          : { appliedGraphRevision: control.appliedGraphRevision }),
        ...(control.planDiff === undefined
          ? {}
          : { planDiff: control.planDiff }),
      })),
      scope: {
        candidates: turn.scopeCandidates.map((candidate) => ({
          id: candidate.id,
          product: candidate.product,
          entityKind: candidate.entityKind,
          ...(candidate.key ? { key: candidate.key } : {}),
          name: candidate.name,
          ...(candidate.canonicalUrl
            ? { canonicalUrl: candidate.canonicalUrl }
            : {}),
          ...(candidate.status ? { status: candidate.status } : {}),
          ...(candidate.match ? { match: candidate.match } : {}),
        })),
        bindings: turn.scopeBindings,
        resolutions: turn.scopeResolutions,
        expansionProposals: turn.scopeExpansionProposals.map((proposal) => ({
          id: proposal.id,
          candidateId: proposal.candidateId,
          expansionKind: proposal.expansionKind,
          basedOnBriefRevision: proposal.basedOnBriefRevision,
          basedOnGraphRevision: proposal.basedOnGraphRevision,
          reason: proposal.reason,
          status: proposal.status,
          ...(proposal.approvedBindingId
            ? { approvedBindingId: proposal.approvedBindingId }
            : {}),
        })),
      },
      work: {
        taskCount: turn.tasks.length,
        taskStatusCounts,
        dispatchState: turn.tasks.length === 0 ? "not_started" : "recorded",
        acceptedPacketCount: turn.acceptedPackets.length,
        reconciliationDispositionCount: turn.reconciliationDispositions.length,
        checkpointCount: turn.checkpoints.length,
      },
    },
  };
}

function projectResearchSessionPlanV1(
  session: ResearchSessionV1,
): Record<string, unknown> {
  const turn = activeSessionTurn(session);
  const latestPlanRevision = turn?.planRevisions?.at(-1);
  const latestScopeRevision = turn?.scopeRevisions?.at(-1);
  const planDiff =
    latestScopeRevision?.planDiff ?? latestPlanRevision?.planDiff;
  return {
    ...projectResearchSessionV1(session),
    kind: "plan",
    planMutable: session.status === "waiting_plan_approval",
    ...(planDiff ? { planDiff } : {}),
  };
}

/**
 * Evidence inspection is intentionally limited to durable metadata. Source
 * text requires the separate, explicit `sessions evidence --include-text`
 * command so ordinary session inspection cannot accidentally disclose it.
 */
function projectResearchEvidenceMetadataV1(
  record: ResearchEvidenceRecordV1,
): Record<string, unknown> {
  return {
    id: record.id,
    identity: record.identity,
    source: record.source,
    authority: record.authority,
    version: record.version,
    contentChars: record.contentChars,
    chunkCount: record.chunkIds.length,
    linkTargetCount: record.linkTargets.length,
  };
}

function projectResearchClaimMetadataV1(
  claim: ResearchClaimV1,
): Record<string, unknown> {
  return {
    id: claim.id,
    classification: claim.classification,
    statement: claim.statement,
    evidenceIds: claim.evidenceIds,
    evidenceSpanCount: claim.evidenceSpans.length,
    scopeBindingIds: claim.scopeBindingIds,
    freshness: claim.freshness,
    createdAt: claim.createdAt,
    freshnessCheckedAt: claim.freshnessCheckedAt,
    ...(claim.invalidatedAt === undefined
      ? {}
      : { invalidatedAt: claim.invalidatedAt }),
    ...(claim.invalidationReason === undefined
      ? {}
      : { invalidationReason: claim.invalidationReason }),
  };
}

function projectResearchOutlineMetadataV1(
  outline: ResearchOutlineV1,
): Record<string, unknown> {
  return {
    id: outline.id,
    revision: outline.revision,
    basedOnBriefRevision: outline.basedOnBriefRevision,
    ...(outline.supersedesOutlineId === undefined
      ? {}
      : { supersedesOutlineId: outline.supersedesOutlineId }),
    createdAt: outline.createdAt,
    sections: outline.sections.map((section) => ({
      id: section.id,
      title: section.title,
      question: section.question,
      claimIds: section.claimIds,
      evidenceIds: section.evidenceIds,
      contradictionIds: section.contradictionIds,
      coverageTargetIds: section.coverageTargetIds,
      dependsOnSectionIds: section.dependsOnSectionIds,
    })),
    contradictions: outline.contradictions.map((contradiction) => ({
      id: contradiction.id,
      claimIds: contradiction.claimIds,
      evidenceIds: contradiction.evidenceIds,
      status: contradiction.status,
      detectedAt: contradiction.detectedAt,
      ...(contradiction.resolvedAt === undefined
        ? {}
        : { resolvedAt: contradiction.resolvedAt }),
    })),
    coverage: outline.coverage,
  };
}

type ResearchSessionInspectionKindV1 =
  | "evidence"
  | "claims"
  | "outline"
  | "reconciliation";

function selectedResearchSessionInspectionV1(
  flags: Record<string, string | boolean | string[]>,
): ResearchSessionInspectionKindV1 | undefined {
  const selected = (
    ["evidence", "claims", "outline", "reconciliation"] as const
  ).filter((kind) => flags[kind] === true);
  if (selected.length > 1) {
    throw new Error(
      "Select at most one research session inspection view at a time.",
    );
  }
  return selected[0];
}

async function projectResearchSessionInspectionV1(input: {
  store: ResearchSessionStoreV1;
  session: ResearchSessionV1;
  kind: ResearchSessionInspectionKindV1;
  limit?: number;
}): Promise<Record<string, unknown>> {
  const turn = activeSessionTurn(input.session);
  const workspace = await input.store.workspace(input.session.sessionId);
  const evidence = new WorkspaceResearchEvidenceStoreV1(workspace);
  const claims = new WorkspaceResearchClaimLedgerV1(workspace, evidence);
  const base = {
    schema: "atlcli.research-session-inspection/v1",
    sessionId: input.session.sessionId,
    ...(turn ? { turnId: turn.id } : {}),
    kind: input.kind,
  };
  if (input.kind === "evidence") {
    const page = await evidence.list({ limit: input.limit ?? 100 });
    return {
      ...base,
      items: page.records.map(projectResearchEvidenceMetadataV1),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }
  if (input.kind === "claims") {
    const page = await claims.list({ limit: input.limit ?? 100 });
    return {
      ...base,
      items: page.claims.map(projectResearchClaimMetadataV1),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }
  if (input.kind === "outline") {
    if (!turn?.brief) return { ...base, outline: undefined };
    const outlines = new WorkspaceResearchOutlineStoreV1({
      workspace,
      evidenceStore: evidence,
      claimLedger: claims,
      coverageTargets: turn.brief.coverageTargets,
    });
    const current = await outlines.current();
    return {
      ...base,
      outline: current ? projectResearchOutlineMetadataV1(current) : undefined,
    };
  }
  return {
    ...base,
    items: (turn?.reconciliationDispositions ?? []).map((disposition) => ({
      id: disposition.id,
      reconciliationPacketRef: disposition.reconciliationPacketRef,
      defectId: disposition.defectId,
      basedOnGraphRevision: disposition.basedOnGraphRevision,
      decision: disposition.decision,
      reasonCode: disposition.reasonCode,
      ...(disposition.resultingGraphRevision === undefined
        ? {}
        : { resultingGraphRevision: disposition.resultingGraphRevision }),
      ...(disposition.resultingNodeId === undefined
        ? {}
        : { resultingNodeId: disposition.resultingNodeId }),
      resultingClaimIds: disposition.resultingClaimIds,
      recordedAt: disposition.recordedAt,
    })),
  };
}

async function requireStoredResearchSession(
  store: ResearchSessionStoreV1,
  sessionId: string,
): Promise<ResearchSessionV1> {
  const session = await store.read(sessionId);
  if (!session) throw new Error("Research session was not found.");
  return session;
}

export async function handleResearchSessions(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
  dependencies: ResearchCliDependencies = defaultResearchCliDependencies,
): Promise<void> {
  const [command, sessionArg] = args;
  if (!command || command === "help") {
    dependencies.emitOutput(researchHelp(), opts);
    return;
  }
  if (command === "list") {
    if (args.length !== 1)
      throw new Error(
        "Usage: atlcli research sessions list [--limit <1-100>] [--cursor <session-id>].",
      );
    assertSessionFlags(flags, ["limit", "cursor"]);
    const limit = boundedSessionLimit(singleSessionFlag(flags, "limit"));
    const cursor = singleSessionFlag(flags, "cursor");
    if (cursor !== undefined) requireSessionId(cursor);
    const opened = await dependencies.openSessionStore();
    try {
      const page = await opened.store.list({
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      dependencies.emitOutput(
        {
          schema: "atlcli.research-session-list/v1",
          sessions: page.sessions.map(projectResearchSessionV1),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        },
        opts,
      );
    } finally {
      opened.close();
    }
    return;
  }
  if (
    command !== "show" &&
    command !== "plan" &&
    command !== "evidence" &&
    command !== "scope-clarification" &&
    command !== "choose-scope" &&
    command !== "continue-scope-clarification" &&
    command !== "clarify" &&
    command !== "approve" &&
    command !== "reject-plan" &&
    command !== "revise-plan" &&
    command !== "approve-scope" &&
    command !== "reject-scope" &&
    command !== "cancel" &&
    command !== "pause" &&
    command !== "steer" &&
    command !== "resume" &&
    command !== "delete"
  ) {
    throw new Error(
      `Unknown research sessions command: ${command}. Run \`atlcli research --help\`.`,
    );
  }
  const sessionId = requireSessionId(sessionArg);
  if (command === "show" || command === "plan") {
    if (args.length !== 2)
      throw new Error(
        `Usage: atlcli research sessions ${command} <session-id>.`,
      );
    assertSessionFlags(
      flags,
      command === "show" ? ["limit"] : [],
      command === "show"
        ? ["evidence", "claims", "outline", "reconciliation"]
        : [],
    );
    const inspection =
      command === "show"
        ? selectedResearchSessionInspectionV1(flags)
        : undefined;
    const limit =
      command === "show"
        ? boundedSessionLimit(singleSessionFlag(flags, "limit"))
        : undefined;
    const opened = await dependencies.openSessionStore();
    try {
      const session = await requireStoredResearchSession(
        opened.store,
        sessionId,
      );
      const view =
        command === "plan"
          ? projectResearchSessionPlanV1(session)
          : inspection
            ? await projectResearchSessionInspectionV1({
                store: opened.store,
                session,
                kind: inspection,
                ...(limit === undefined ? {} : { limit }),
              })
            : projectResearchSessionV1(session);
      dependencies.emitOutput(view, opts);
    } finally {
      opened.close();
    }
    return;
  }
  if (command === "evidence") {
    if (args.length !== 2)
      throw new Error(
        "Usage: atlcli research sessions evidence <session-id> --id <evidence-id> [--include-text].",
      );
    assertSessionFlags(flags, ["id"], ["include-text"]);
    const evidenceId = requiredEvidenceId(singleSessionFlag(flags, "id", true));
    const includeText = flags["include-text"] === true;
    const opened = await dependencies.openSessionStore();
    try {
      await requireStoredResearchSession(opened.store, sessionId);
      const evidence = new WorkspaceResearchEvidenceStoreV1(
        await opened.store.workspace(sessionId),
      );
      const record = await evidence.get(evidenceId);
      if (!record) throw new Error("Retained research evidence was not found.");
      const chunks = includeText ? await evidence.chunks(record.id) : undefined;
      dependencies.emitOutput(
        {
          schema: "atlcli.research-session-evidence-view/v1",
          sessionId,
          evidence: projectResearchEvidenceMetadataV1(record),
          ...(chunks === undefined
            ? {}
            : { sourceText: chunks.map((chunk) => chunk.text).join("") }),
        },
        opts,
      );
    } finally {
      opened.close();
    }
    return;
  }
  if (command === "pause") {
    if (args.length !== 2)
      throw new Error(
        "Usage: atlcli research sessions pause <session-id> --revision <session-revision>.",
      );
    assertSessionFlags(flags, ["revision"]);
    const revision = expectedSessionRevision(
      singleSessionFlag(flags, "revision", true),
    );
    const opened = await dependencies.openSessionStore();
    try {
      const session = await requireStoredResearchSession(
        opened.store,
        sessionId,
      );
      if (session.revision !== revision) {
        throw new Error(
          "Research session revision is stale; inspect the current session and retry with its exact revision.",
        );
      }
      let paused = (
        await opened.store.commit(sessionId, {
          kind: "request_pause",
          expectedRevision: session.revision,
          expectedLeaseEpoch: session.lease.epoch,
          at: new Date().toISOString(),
        })
      ).session;
      const turn = activeSessionTurn(paused);
      const hasUnsettledDispatch =
        turn?.tasks.some(
          (task) =>
            task.status === "ready" ||
            task.status === "running" ||
            task.status === "outcome_unknown",
        ) ?? false;
      const canAcknowledgeLocally =
        !hasUnsettledDispatch &&
        (turn?.tasks.length ?? 0) === 0 &&
        (turn?.acceptedPackets.length ?? 0) === 0 &&
        turn?.graphSelectionCommittedAt === undefined;
      // A control-only CLI process has reached a durable scheduler boundary
      // only before every kind of dispatch. In that case it may acknowledge
      // its own pause; otherwise the retained runner must observe the request
      // and checkpoint it without this command guessing a result.
      if (canAcknowledgeLocally) {
        paused = (
          await opened.store.commit(sessionId, {
            kind: "acknowledge_pause",
            expectedRevision: paused.revision,
            expectedLeaseEpoch: paused.lease.epoch,
            at: new Date().toISOString(),
          })
        ).session;
      }
      dependencies.writeStderr(
        `[research] session=${sessionId} action=pause revision=${paused.revision} status=${paused.status}${canAcknowledgeLocally ? " checkpoint=acknowledged" : " checkpoint=pending"}\n`,
      );
      dependencies.emitOutput(projectResearchSessionV1(paused), opts);
    } finally {
      opened.close();
    }
    return;
  }
  if (command === "steer") {
    if (args.length !== 2) {
      throw new Error(
        "Usage: atlcli research sessions steer <session-id> --revision <session-revision> --graph-revision <graph-revision> --instruction <focus-or-priority>.",
      );
    }
    assertSessionFlags(flags, ["revision", "graph-revision", "instruction"]);
    const revision = expectedSessionRevision(
      singleSessionFlag(flags, "revision", true),
    );
    const graphRevision = expectedSessionRevision(
      singleSessionFlag(flags, "graph-revision", true),
    );
    const instruction = singleSessionFlag(flags, "instruction", true);
    if (!instruction) throw new Error("--instruction requires a value.");
    const opened = await dependencies.openSessionStore();
    try {
      const session = await requireStoredResearchSession(
        opened.store,
        sessionId,
      );
      if (session.revision !== revision) {
        throw new Error(
          "Research session revision is stale; inspect the current session and retry with its exact revision.",
        );
      }
      const steered = (
        await opened.store.commit(sessionId, {
          kind: "request_steering",
          steeringId: `steering:${randomUUID()}`,
          basedOnGraphRevision: graphRevision,
          request: instruction,
          expectedRevision: session.revision,
          expectedLeaseEpoch: session.lease.epoch,
          at: new Date().toISOString(),
        })
      ).session;
      dependencies.writeStderr(
        `[research] session=${sessionId} action=steer revision=${steered.revision} status=${steered.status} graph_revision=${graphRevision}\n`,
      );
      dependencies.emitOutput(projectResearchSessionV1(steered), opts);
    } finally {
      opened.close();
    }
    return;
  }
  if (command === "resume") {
    if (args.length !== 2)
      throw new Error(
        "Usage: atlcli research sessions resume <session-id> --revision <session-revision>.",
      );
    assertSessionFlags(flags, ["revision"]);
    const revision = expectedSessionRevision(
      singleSessionFlag(flags, "revision", true),
    );
    const opened = await dependencies.openSessionStore();
    try {
      const session = await requireStoredResearchSession(
        opened.store,
        sessionId,
      );
      if (session.revision !== revision) {
        throw new Error(
          "Research session revision is stale; inspect the current session and retry with its exact revision.",
        );
      }
      const turn = activeSessionTurn(session);
      if (
        session.status !== "paused" ||
        !turn?.brief ||
        turn.tasks.length > 0 ||
        turn.acceptedPackets.length > 0 ||
        turn.graphSelectionCommittedAt !== undefined
      ) {
        throw new Error(
          "Only an acknowledged paused research session can be resumed by this control command.",
        );
      }
      const at = new Date().toISOString();
      const resumed = await recoverResearchSessionForResumeV1({
        store: opened.store,
        sessionId,
        ownerId: `owner:cli-resume-control-${process.pid}`,
        leaseExpiresAt: new Date(
          Date.parse(at) + turn.brief.limits.maxRunMs,
        ).toISOString(),
        at,
      });
      if (resumed.status !== "running") {
        throw new Error(
          "Research session resume did not reach its runnable state.",
        );
      }
      // This control action deliberately does not construct a workspace,
      // provider, or model. Release the freshly claimed lease so the public
      // `atlcli research --resume <id>` execution path can reclaim it.
      const released = (
        await opened.store.commit(sessionId, {
          kind: "release_lease",
          expectedRevision: resumed.revision,
          expectedLeaseEpoch: resumed.lease.epoch,
          at,
        })
      ).session;
      dependencies.writeStderr(
        `[research] session=${sessionId} action=resume revision=${released.revision} status=${released.status} dispatch=deferred\n`,
      );
      dependencies.emitOutput(projectResearchSessionV1(released), opts);
    } finally {
      opened.close();
    }
    return;
  }
  if (command === "scope-clarification") {
    if (args.length !== 2) {
      throw new Error(
        "Usage: atlcli research sessions scope-clarification <session-id> [--profile <name>].",
      );
    }
    assertSessionFlags(flags, ["profile"]);
    const profileName = singleSessionFlag(flags, "profile");
    const opened = await dependencies.openSessionStore();
    try {
      const session = await requireStoredResearchSession(
        opened.store,
        sessionId,
      );
      const { review } = await scopeClarificationReviewForCliSession({
        session,
        profileName,
        opts,
        dependencies,
      });
      dependencies.emitOutput(review, opts);
    } finally {
      opened.close();
    }
    return;
  }
  if (command === "choose-scope") {
    if (args.length !== 2) {
      throw new Error(
        "Usage: atlcli research sessions choose-scope <session-id> --revision <session-revision> --mention <scope-mention-id> --candidate <scope-candidate-id> [--profile <name>].",
      );
    }
    assertSessionFlags(flags, ["revision", "mention", "candidate", "profile"]);
    const revision = expectedSessionRevision(
      singleSessionFlag(flags, "revision", true),
    );
    const selection = scopeClarificationSelectionFromSessionFlags(flags);
    const profileName = singleSessionFlag(flags, "profile");
    const opened = await dependencies.openSessionStore();
    try {
      const session = await requireStoredResearchSession(
        opened.store,
        sessionId,
      );
      if (session.revision !== revision) {
        throw new Error(
          "Research session revision is stale; inspect the current scope clarification and retry with its exact revision.",
        );
      }
      const { profile, tenantOrigin, review } =
        await scopeClarificationReviewForCliSession({
          session,
          profileName,
          opts,
          dependencies,
        });
      if (
        review.stage !== "choice_required" ||
        selection.mentionId !== review.clarification.mentionId
      ) {
        throw new Error(
          "Research scope clarification is stale; inspect the current candidate choice and retry.",
        );
      }
      if (
        !review.clarification.candidates.some(
          (candidate) => candidate.id === selection.candidateId,
        )
      ) {
        throw new Error(
          "The selected research scope candidate is unavailable.",
        );
      }
      const scopeClarification = session.scopeClarification;
      if (!scopeClarification) {
        throw new Error(
          "The durable research scope clarification is missing its original request.",
        );
      }
      // This fresh catalog pass is intentionally the only provider activity in
      // this command. The caller submits a candidate ID; the host retains the
      // tenant, original request, policy, and every resolved scope value.
      const scopeOutcome = await dependencies.resolveScope({
        profile,
        request: scopeClarification.request,
        options: { candidateSelections: [selection] },
      });
      const at = new Date().toISOString();
      if (scopeOutcome.kind === "clarification_required") {
        const refreshed = await refreshResearchSessionScopeClarificationV1({
          store: opened.store,
          sessionId,
          expectedRevision: session.revision,
          expectedLeaseEpoch: session.lease.epoch,
          clarification: scopeOutcome.clarification,
          candidateChoices: scopeOutcome.candidateChoices,
          at,
        });
        const nextReview = projectResearchSessionScopeClarificationReviewV1(
          refreshed,
          tenantOrigin,
        );
        if (!nextReview)
          throw new Error(
            "The refreshed research scope clarification could not be projected.",
          );
        dependencies.writeStderr(
          `[research] session=${sessionId} action=choose-scope status=${refreshed.status} refreshed=true\n`,
        );
        dependencies.emitOutput(nextReview, opts);
        return;
      }
      const committed = await resolveResearchSessionScopeClarificationV1({
        store: opened.store,
        sessionId,
        expectedRevision: session.revision,
        expectedLeaseEpoch: session.lease.epoch,
        selection,
        resolvedRequest: scopeOutcome.request,
        packetOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2,
        releaseApprovedLease: true,
        at,
      });
      const nextReview = projectResearchSessionScopeClarificationReviewV1(
        committed,
        tenantOrigin,
      );
      dependencies.writeStderr(
        `[research] session=${sessionId} action=choose-scope revision=${committed.revision} status=${committed.status}\n`,
      );
      dependencies.emitOutput(
        {
          schema: "atlcli.research-scope-clarification-resolution/v1",
          ...(nextReview === undefined
            ? {
                stage: "resolved",
                session: projectResearchSessionV1(committed),
              }
            : { stage: "recovery_required", review: nextReview }),
        },
        opts,
      );
    } finally {
      opened.close();
    }
    return;
  }
  if (command === "continue-scope-clarification") {
    if (args.length !== 2) {
      throw new Error(
        "Usage: atlcli research sessions continue-scope-clarification <session-id> --revision <session-revision> [--profile <name>].",
      );
    }
    assertSessionFlags(flags, ["revision", "profile"]);
    const revision = expectedSessionRevision(
      singleSessionFlag(flags, "revision", true),
    );
    const profileName = singleSessionFlag(flags, "profile");
    const opened = await dependencies.openSessionStore();
    try {
      const session = await requireStoredResearchSession(
        opened.store,
        sessionId,
      );
      if (session.revision !== revision) {
        throw new Error(
          "Research session revision is stale; inspect the current scope clarification and retry with its exact revision.",
        );
      }
      const { tenantOrigin, review } =
        await scopeClarificationReviewForCliSession({
          session,
          profileName,
          opts,
          dependencies,
        });
      if (review.stage === "choice_required") {
        throw new Error(
          "Research scope clarification still requires a candidate choice.",
        );
      }
      const committed = await continueResearchSessionScopeClarificationV1({
        store: opened.store,
        sessionId,
        expectedRevision: session.revision,
        expectedLeaseEpoch: session.lease.epoch,
        packetOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2,
        releaseApprovedLease: true,
        at: new Date().toISOString(),
      });
      const nextReview = projectResearchSessionScopeClarificationReviewV1(
        committed,
        tenantOrigin,
      );
      dependencies.writeStderr(
        `[research] session=${sessionId} action=continue-scope-clarification revision=${committed.revision} status=${committed.status}\n`,
      );
      dependencies.emitOutput(
        {
          schema: "atlcli.research-scope-clarification-resolution/v1",
          ...(nextReview === undefined
            ? {
                stage: "resolved",
                session: projectResearchSessionV1(committed),
              }
            : { stage: "recovery_required", review: nextReview }),
        },
        opts,
      );
    } finally {
      opened.close();
    }
    return;
  }
  if (command === "delete") {
    if (args.length !== 2)
      throw new Error(
        "Usage: atlcli research sessions delete <session-id> --revision <session-revision>.",
      );
    assertSessionFlags(flags, ["revision"]);
    const revision = expectedSessionRevision(
      singleSessionFlag(flags, "revision", true),
    );
    const opened = await dependencies.openSessionStore();
    try {
      let session = await requireStoredResearchSession(opened.store, sessionId);
      if (session.revision !== revision)
        throw new Error(
          "Research session revision is stale; inspect the current session and retry with its exact revision.",
        );
      session = (
        await opened.store.commit(sessionId, {
          kind: "request_deletion",
          expectedRevision: session.revision,
          expectedLeaseEpoch: session.lease.epoch,
          at: new Date().toISOString(),
        })
      ).session;
      session = (
        await opened.store.commit(sessionId, {
          kind: "delete",
          expectedRevision: session.revision,
          expectedLeaseEpoch: session.lease.epoch,
          at: new Date().toISOString(),
        })
      ).session;
      if (!(await opened.store.eraseDeleted(session.sessionId))) {
        throw new Error(
          "Research session deletion did not remove the owned data.",
        );
      }
      dependencies.writeStderr(
        `[research] session=${sessionId} action=delete erased=true\n`,
      );
      dependencies.emitOutput(
        {
          schema: "atlcli.research-session-deletion/v1",
          sessionId,
          deleted: true,
        },
        opts,
      );
    } finally {
      opened.close();
    }
    return;
  }
  if (command === "cancel") {
    if (args.length !== 2)
      throw new Error(
        "Usage: atlcli research sessions cancel <session-id> --revision <session-revision>.",
      );
    assertSessionFlags(flags, ["revision"]);
    const revision = expectedSessionRevision(
      singleSessionFlag(flags, "revision", true),
    );
    const opened = await dependencies.openSessionStore();
    try {
      const session = await requireStoredResearchSession(
        opened.store,
        sessionId,
      );
      if (session.revision !== revision)
        throw new Error(
          "Research session revision is stale; inspect the current session and retry with its exact revision.",
        );
      const cancelled = await opened.store.commit(sessionId, {
        kind: "cancel",
        expectedRevision: session.revision,
        expectedLeaseEpoch: session.lease.epoch,
        at: new Date().toISOString(),
      });
      dependencies.writeStderr(
        `[research] session=${sessionId} action=cancel revision=${cancelled.session.revision} status=${cancelled.session.status}\n`,
      );
      dependencies.emitOutput(
        projectResearchSessionV1(cancelled.session),
        opts,
      );
    } finally {
      opened.close();
    }
    return;
  }
  if (command === "clarify") {
    if (args.length !== 2) {
      throw new Error(
        "Usage: atlcli research sessions clarify <session-id> --revision <session-revision> --brief-revision <brief-revision> [--answer <question-id>=<response>] [--assumption <assumption-id>=accepted|rejected].",
      );
    }
    assertSessionFlags(
      flags,
      ["revision", "brief-revision"],
      [],
      ["answer", "assumption"],
    );
    const revision = expectedSessionRevision(
      singleSessionFlag(flags, "revision", true),
    );
    const briefRevision = expectedSessionRevision(
      singleSessionFlag(flags, "brief-revision", true),
    );
    const answers = clarificationAnswersFromSessionFlags(flags);
    const assumptionDecisions = assumptionDecisionsFromSessionFlags(flags);
    const opened = await dependencies.openSessionStore();
    try {
      const session = await requireStoredResearchSession(
        opened.store,
        sessionId,
      );
      if (session.revision !== revision) {
        throw new Error(
          "Research session revision is stale; inspect the current clarification and retry with its exact revision.",
        );
      }
      const turn = activeSessionTurn(session);
      if (!turn?.brief)
        throw new Error("Research session has no active brief to clarify.");
      if (turn.brief.revision !== briefRevision) {
        throw new Error(
          "Research brief revision is stale; inspect the current clarification and retry with its exact brief revision.",
        );
      }
      const resolved = (
        await opened.store.commit(sessionId, {
          kind: "resolve_clarifications",
          briefRevision,
          answers,
          assumptionDecisions,
          expectedRevision: session.revision,
          expectedLeaseEpoch: session.lease.epoch,
          at: new Date().toISOString(),
        })
      ).session;
      const resolvedTurn = activeSessionTurn(resolved);
      if (
        !resolvedTurn?.brief ||
        resolvedTurn.graph ||
        resolved.status !== "planning"
      ) {
        throw new Error(
          "Research clarification did not produce a graph-ready durable brief.",
        );
      }
      const planned = await proposeResearchGraphForReadyBriefV1({
        store: opened.store,
        sessionId,
        expectedRevision: resolved.revision,
        expectedLeaseEpoch: resolved.lease.epoch,
        packetOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2,
        approveAutomatically:
          resolvedTurn.brief.resolvedPlanApproval === "automatic",
        releaseApprovedLease: true,
        at: new Date().toISOString(),
      });
      dependencies.writeStderr(
        `[research] session=${sessionId} action=clarify revision=${planned.revision} brief_revision=${resolvedTurn.brief.revision} status=${planned.status}\n`,
      );
      dependencies.emitOutput(projectResearchSessionPlanV1(planned), opts);
    } finally {
      opened.close();
    }
    return;
  }
  if (command === "revise-plan") {
    if (args.length !== 2) {
      throw new Error(
        "Usage: atlcli research sessions revise-plan <session-id> --revision <session-revision> --graph-revision <graph-revision> [--instruction <correction>].",
      );
    }
    assertSessionFlags(flags, ["revision", "graph-revision", "instruction"]);
    const revision = expectedSessionRevision(
      singleSessionFlag(flags, "revision", true),
    );
    const graphRevision = expectedSessionRevision(
      singleSessionFlag(flags, "graph-revision", true),
    );
    const instruction = singleSessionFlag(flags, "instruction");
    const opened = await dependencies.openSessionStore();
    try {
      let current = await requireStoredResearchSession(opened.store, sessionId);
      if (current.revision !== revision)
        throw new Error(
          "Research session revision is stale; inspect the current plan and retry with its exact revision.",
        );
      const currentTurn = activeSessionTurn(current);
      const currentGraph = currentTurn?.graph;
      if (
        !currentTurn?.brief ||
        !currentGraph ||
        currentGraph.revision !== graphRevision
      ) {
        throw new Error(
          "Research graph revision is stale; inspect the current plan and retry with its exact graph revision.",
        );
      }
      if (current.status === "waiting_plan_revision") {
        if (!instruction)
          throw new Error(
            "--instruction is required while a rejected plan is waiting for a revision.",
          );
        current = (
          await opened.store.commit(sessionId, {
            kind: "request_plan_revision",
            graphRevision,
            instruction,
            expectedRevision: current.revision,
            expectedLeaseEpoch: current.lease.epoch,
            at: new Date().toISOString(),
          })
        ).session;
      } else if (current.status === "planning") {
        if (instruction)
          throw new Error(
            "A plan revision is already being composed; retry without --instruction to recover the durable boundary.",
          );
        const pending = activeSessionTurn(current)?.planRevisions?.at(-1);
        if (
          pending?.state !== "revision_requested" ||
          pending.basedOnGraphRevision !== graphRevision
        ) {
          throw new Error(
            "Research session is not waiting for a durable plan revision.",
          );
        }
      } else {
        throw new Error("Research session is not waiting for a plan revision.");
      }
      const planned = await proposeResearchGraphForReadyBriefV1({
        store: opened.store,
        sessionId,
        expectedRevision: current.revision,
        expectedLeaseEpoch: current.lease.epoch,
        packetOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2,
        approveAutomatically: false,
        at: new Date().toISOString(),
      });
      const revisedTurn = activeSessionTurn(planned);
      const revisionRecord = revisedTurn?.planRevisions?.at(-1);
      if (
        !revisedTurn?.brief ||
        !revisedTurn.graph ||
        !revisionRecord?.planDiff
      ) {
        throw new Error(
          "Research plan revision did not produce a durable review diff.",
        );
      }
      // Recalculate from the immutable snapshots as a defensive check that a
      // store implementation did not substitute the persisted review surface.
      const planDiff = diffResearchPlansV1({
        fromBrief: revisionRecord.rejectedBrief,
        fromGraph: revisionRecord.rejectedGraph,
        toBrief: revisedTurn.brief,
        toGraph: revisedTurn.graph,
      });
      if (
        JSON.stringify(planDiff) !== JSON.stringify(revisionRecord.planDiff)
      ) {
        throw new Error(
          "Research plan revision diff does not match its durable plan snapshots.",
        );
      }
      dependencies.writeStderr(
        `[research] session=${sessionId} action=revise-plan revision=${planned.revision} graph_revision=${revisedTurn.graph.revision} status=${planned.status}\n`,
      );
      dependencies.emitOutput(projectResearchSessionPlanV1(planned), opts);
    } finally {
      opened.close();
    }
    return;
  }
  if (command === "approve-scope" || command === "reject-scope") {
    if (args.length !== 2) {
      throw new Error(
        `Usage: atlcli research sessions ${command} <session-id> --revision <session-revision> --brief-revision <brief-revision> --graph-revision <graph-revision> --proposal <scope-expansion-id>.`,
      );
    }
    assertSessionFlags(flags, [
      "revision",
      "brief-revision",
      "graph-revision",
      "proposal",
    ]);
    const revision = expectedSessionRevision(
      singleSessionFlag(flags, "revision", true),
    );
    const briefRevision = expectedSessionRevision(
      singleSessionFlag(flags, "brief-revision", true),
    );
    const graphRevision = expectedSessionRevision(
      singleSessionFlag(flags, "graph-revision", true),
    );
    const proposalId = singleSessionFlag(flags, "proposal", true)!;
    if (!/^scope-expansion:[A-Za-z0-9._-]{1,120}$/.test(proposalId)) {
      throw new Error("--proposal requires a valid scope expansion ID.");
    }
    const opened = await dependencies.openSessionStore();
    try {
      const session = await requireStoredResearchSession(
        opened.store,
        sessionId,
      );
      if (session.revision !== revision) {
        throw new Error(
          "Research session revision is stale; inspect the current scope proposal and retry with its exact revision.",
        );
      }
      const turn = activeSessionTurn(session);
      if (
        !turn?.brief ||
        !turn.graph ||
        turn.brief.revision !== briefRevision ||
        turn.graph.revision !== graphRevision
      ) {
        throw new Error(
          "Research brief or graph revision is stale; inspect the current scope proposal and retry with its exact revisions.",
        );
      }
      const at = new Date().toISOString();
      const committed =
        command === "approve-scope"
          ? await approveResearchScopeExpansionV1({
              store: opened.store,
              sessionId,
              proposalId,
              binding: scopeApprovalBindingV1({
                turn,
                proposalId,
                approvedAt: at,
              }),
              expectedRevision: session.revision,
              expectedLeaseEpoch: session.lease.epoch,
              at,
            })
          : (
              await opened.store.commit(sessionId, {
                kind: "reject_scope_expansion",
                proposalId,
                expectedRevision: session.revision,
                expectedLeaseEpoch: session.lease.epoch,
                at,
              })
            ).session;
      dependencies.writeStderr(
        `[research] session=${sessionId} action=${command} revision=${committed.revision} status=${committed.status}\n`,
      );
      dependencies.emitOutput(projectResearchSessionPlanV1(committed), opts);
    } finally {
      opened.close();
    }
    return;
  }
  if (command === "approve" || command === "reject-plan") {
    if (args.length !== 2)
      throw new Error(
        `Usage: atlcli research sessions ${command} <session-id> --revision <session-revision> --graph-revision <graph-revision>${command === "reject-plan" ? " --instruction <correction>" : ""}.`,
      );
    assertSessionFlags(
      flags,
      command === "approve"
        ? ["revision", "graph-revision"]
        : ["revision", "graph-revision", "instruction"],
    );
    const revision = expectedSessionRevision(
      singleSessionFlag(flags, "revision", true),
    );
    const graphRevision = expectedSessionRevision(
      singleSessionFlag(flags, "graph-revision", true),
    );
    const instruction =
      command === "reject-plan"
        ? singleSessionFlag(flags, "instruction", true)
        : undefined;
    const opened = await dependencies.openSessionStore();
    try {
      const session = await requireStoredResearchSession(
        opened.store,
        sessionId,
      );
      if (session.revision !== revision)
        throw new Error(
          "Research session revision is stale; inspect the current plan and retry with its exact revision.",
        );
      const turn = activeSessionTurn(session);
      const graph = turn?.graph;
      if (!turn?.brief || !graph || graph.revision !== graphRevision)
        throw new Error(
          "Research graph revision is stale; inspect the current plan and retry with its exact graph revision.",
        );
      let committedSession = (
        await opened.store.commit(
          sessionId,
          command === "approve"
            ? {
                kind: "approve_graph",
                graphRevision,
                expectedRevision: session.revision,
                expectedLeaseEpoch: session.lease.epoch,
                at: new Date().toISOString(),
              }
            : {
                kind: "reject_plan",
                graphRevision,
                reason: instruction!,
                expectedRevision: session.revision,
                expectedLeaseEpoch: session.lease.epoch,
                at: new Date().toISOString(),
              },
        )
      ).session;
      if (command === "approve") {
        committedSession = (
          await opened.store.commit(sessionId, {
            kind: "release_lease",
            expectedRevision: committedSession.revision,
            expectedLeaseEpoch: committedSession.lease.epoch,
            at: new Date().toISOString(),
          })
        ).session;
      } else {
        const requested = await opened.store.commit(sessionId, {
          kind: "request_plan_revision",
          graphRevision,
          instruction: instruction!,
          expectedRevision: committedSession.revision,
          expectedLeaseEpoch: committedSession.lease.epoch,
          at: new Date().toISOString(),
        });
        committedSession = await proposeResearchGraphForReadyBriefV1({
          store: opened.store,
          sessionId,
          expectedRevision: requested.session.revision,
          expectedLeaseEpoch: requested.session.lease.epoch,
          packetOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2,
          approveAutomatically: false,
          at: new Date().toISOString(),
        });
        const revisedTurn = activeSessionTurn(committedSession);
        const revisionRecord = revisedTurn?.planRevisions?.at(-1);
        if (
          !revisedTurn?.brief ||
          !revisedTurn.graph ||
          !revisionRecord?.planDiff
        ) {
          throw new Error(
            "Research plan rejection did not produce a durable review diff.",
          );
        }
        const planDiff = diffResearchPlansV1({
          fromBrief: revisionRecord.rejectedBrief,
          fromGraph: revisionRecord.rejectedGraph,
          toBrief: revisedTurn.brief,
          toGraph: revisedTurn.graph,
        });
        if (
          JSON.stringify(planDiff) !== JSON.stringify(revisionRecord.planDiff)
        ) {
          throw new Error(
            "Research plan revision diff does not match its durable plan snapshots.",
          );
        }
      }
      dependencies.writeStderr(
        `[research] session=${sessionId} action=${command} revision=${committedSession.revision} status=${committedSession.status}\n`,
      );
      dependencies.emitOutput(
        projectResearchSessionPlanV1(committedSession),
        opts,
      );
    } finally {
      opened.close();
    }
    return;
  }
}

export function buildResearchRequest(
  input: ResearchCliInput,
  profile: Profile,
  options: { includeProfileDefaults?: boolean } = {},
): ResearchRequestV1 {
  const defaults = resolveDefaults(
    { profiles: {}, currentProfile: undefined },
    profile,
  );
  const projectKeys =
    input.projectKeys.length > 0
      ? input.projectKeys
      : options.includeProfileDefaults === false
        ? []
        : uniqueKeys(defaults.project ? [defaults.project] : []);
  const spaceKeys =
    input.spaceKeys.length > 0
      ? input.spaceKeys
      : options.includeProfileDefaults === false
        ? []
        : uniqueKeys(defaults.space ? [defaults.space] : [], false);
  const siteOrigin = new URL(profile.baseUrl).origin;
  const scopeSeeds: ResearchScopeSeedV1[] = [
    ...projectKeys.map((key) =>
      createResearchKeyScopeSeedV1({
        tenantOrigin: siteOrigin,
        product: "jira",
        key,
        source: input.projectKeys.length > 0 ? "cli_flag" : "profile_default",
        authority: input.projectKeys.length > 0 ? "locked" : "approved",
      }),
    ),
    ...spaceKeys.map((key) =>
      createResearchKeyScopeSeedV1({
        tenantOrigin: siteOrigin,
        product: "confluence",
        key,
        source: input.spaceKeys.length > 0 ? "cli_flag" : "profile_default",
        authority: input.spaceKeys.length > 0 ? "locked" : "approved",
      }),
    ),
  ];
  return normalizeResearchRequestV1({
    schema: RESEARCH_REQUEST_SCHEMA_V1,
    question: input.question,
    scope: {
      siteOrigin,
      jiraProjectKeys: projectKeys,
      confluenceSpaceKeys: spaceKeys,
      ...(input.from || input.to
        ? {
            timeWindow: {
              ...(input.from ? { from: input.from } : {}),
              ...(input.to ? { to: input.to } : {}),
            },
          }
        : {}),
    },
    scopeSeeds,
    limits: {
      ...DEFAULT_RESEARCH_LIMITS_V1,
      pageSize: 10,
      // Auto research uses the contract's practical bounded maximum. A
      // single-product worker can search ten pages and read fifty ranked
      // details; cross-product runs split the shared PTC ceiling fairly.
      // Anything beyond this envelope remains a visible coverage limitation.
      maxSearchPagesPerProduct: 10,
      maxItemsPerProduct: 100,
      maxDetailItemsPerProduct: 50,
      // Research claims may only cite complete detail projections. Keep the
      // contract maximum so ordinary long-form Confluence pages are not
      // silently reduced to excerpts before synthesis.
      maxBodyCharsPerItem: 50_000,
      maxPtcCalls: 80,
      maxHttpCalls: 128,
      // The dynamic supervisor emits one complete QuickJS workflow before any
      // subagent runs. Its provider budget must accommodate that program;
      // 4,096 tokens can terminate mid-tool-input for a valid six-node graph.
      maxModelOutputTokens: 8_000,
      ...(input.maxCostUsd === undefined
        ? {}
        : { maxModelCostMicros: Math.floor(input.maxCostUsd * 1_000_000) }),
      ...(input.maxTotalModelInputTokens === undefined
        ? {}
        : { maxTotalModelInputTokens: input.maxTotalModelInputTokens }),
      // The CLI controls only the complete workflow deadline. Individual
      // QuickJS/PTC operations retain their tighter contract limits.
      maxRunMs: input.maxRunMinutes * 60_000,
    },
    wikiProvider: "rest",
    reportLanguage: input.reportLanguage ?? "en",
  });
}

export function buildChatRequest(
  input: ResearchCliInput,
  profile: Profile,
): ResearchRequestV1 {
  const request = buildResearchRequest(input, profile, {
    includeProfileDefaults: false,
  });
  const bounded = applyChatQualityResourcePolicyV1(
    request,
    input.qualityPolicy?.mode ?? "auto",
  );
  return normalizeResearchRequestV1({
    ...bounded,
    limits: {
      ...bounded.limits,
      maxModelCostMicros:
        input.maxCostUsd === undefined
          ? DEFAULT_RESEARCH_LIMITS_V1.maxModelCostMicros
          : request.limits.maxModelCostMicros,
    },
  });
}

export async function writeResearchMarkdownAtomic(
  path: string,
  contents: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, contents, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function readApiKey(dependencies: ResearchCliDependencies): string | undefined {
  const key = dependencies.readApiKey()?.trim();
  return key || undefined;
}

function selectedOptionIds(
  question: Extract<ChatUserQuestionV1, { responseKind: "single_choice" | "multiple_choice" | "mixed" }>,
  raw: string,
): string[] {
  const indexes = raw
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isSafeInteger(value));
  const unique = [...new Set(indexes)];
  if (unique.some((value) => value < 1 || value > question.options.length)) {
    throw new Error("Choose only the displayed option numbers.");
  }
  return unique.map((value) => question.options[value - 1]!.id);
}

/** Portable line-oriented CLI presenter for the shared durable HITL contract. */
export async function promptChatUserQuestionV1(input: {
  question: ChatUserQuestionV1;
  ask(prompt: string): Promise<string>;
  write(message: string): void;
}): Promise<ChatUserQuestionAnswerV1> {
  const question = input.question;
  input.write(`\nKiteweave needs your input:\n${question.prompt}\n`);
  if ("options" in question) {
    question.options.forEach((option, index) => {
      input.write(`  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}\n`);
    });
  }
  if (question.responseKind === "assumption") {
    input.write(`Assumption: ${question.assumption}\n`);
  }
  while (true) {
    try {
      if (question.responseKind === "free_text") {
        const text = (await input.ask("> ")).trim();
        if ((question.required && !text) || text.length > question.maxLength) {
          throw new Error(`Enter between 1 and ${question.maxLength} characters.`);
        }
        return {
          schema: CHAT_USER_QUESTION_ANSWER_SCHEMA_V1,
          questionId: question.id,
          value: { kind: "text", text },
        };
      }
      if (question.responseKind === "assumption") {
        const decision = (await input.ask("Accept this assumption? [y/n] ")).trim().toLowerCase();
        if (!["y", "yes", "j", "ja", "n", "no", "nein"].includes(decision)) {
          throw new Error("Answer yes or no.");
        }
        return {
          schema: CHAT_USER_QUESTION_ANSWER_SCHEMA_V1,
          questionId: question.id,
          value: {
            kind: "assumption",
            decision: ["y", "yes", "j", "ja"].includes(decision) ? "accepted" : "rejected",
          },
        };
      }
      const mixed = question.responseKind === "mixed";
      const raw = await input.ask(mixed
        ? "Choose numbers separated by commas; add optional text after |: "
        : question.responseKind === "single_choice"
          ? "Choose one number: "
          : "Choose numbers separated by commas: ");
      const [selection = "", freeTextRaw] = mixed ? raw.split("|", 2) : [raw];
      const optionIds = selectedOptionIds(question, selection);
      const freeText = freeTextRaw?.trim();
      const minimum = question.responseKind === "single_choice" ? 1 : question.minSelections;
      const maximum = question.responseKind === "single_choice" ? 1 : question.maxSelections;
      if (optionIds.length > maximum || (optionIds.length < minimum && !freeText) ||
          (question.required && optionIds.length === 0 && !freeText)) {
        throw new Error(`Choose between ${minimum} and ${maximum} options${mixed ? " or provide text" : ""}.`);
      }
      if (mixed && freeText && freeText.length > question.maxLength) {
        throw new Error(`Additional text is limited to ${question.maxLength} characters.`);
      }
      return {
        schema: CHAT_USER_QUESTION_ANSWER_SCHEMA_V1,
        questionId: question.id,
        value: mixed
          ? { kind: "mixed", optionIds, ...(freeText ? { text: freeText } : {}) }
          : { kind: "selection", optionIds },
      };
    } catch (error) {
      input.write(`${error instanceof Error ? error.message : "The answer is invalid."}\n`);
    }
  }
}

export const defaultResearchCliDependencies: ResearchCliDependencies = {
  async resolveProfile(name) {
    return getActiveProfile(await loadConfig(), name);
  },
  async resolveScope(input) {
    const broker = new ResearchScopeCatalogBroker({
      tenantOrigin: input.request.scope.siteOrigin,
      providers: createRestScopeCatalogProviders(
        input.profile,
        input.request.scope.siteOrigin,
        { allowProfileAuth: true },
      ),
    });
    return prepareResearchScopePreflightV1({
      request: input.request,
      catalog: broker,
      automaticApproval: true,
      ...(input.options?.candidateSelections === undefined
        ? {}
        : { candidateSelections: input.options.candidateSelections }),
    });
  },
  prepareBrief(input) {
    return prepareResearchBriefPreflightV1(
      createStandardResearchBriefV1(input.request.question, {
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.turnId ? { turnId: input.turnId } : {}),
        scope: input.request.scope,
        scopeBindings:
          input.scopeBindings ??
          input.request.scopeSeeds?.map((seed) => seed.binding),
        limits: input.request.limits,
        asOf: input.asOf,
        timezone: input.timezone,
        policy: input.policy,
        reportLanguage: input.request.reportLanguage,
      }),
    );
  },
  readApiKey: () => process.env.ANTHROPIC_API_KEY,
  async askChatUserQuestion(question) {
    if (!process.stdin.isTTY) {
      throw new Error("Chat requires user input, but stdin is not interactive.");
    }
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await promptChatUserQuestionV1({
        question,
        ask: (prompt) => terminal.question(prompt),
        write: (message) => process.stderr.write(message),
      });
    } finally {
      terminal.close();
    }
  },
  createWorkspace: () => FileSystemResearchWorkspace.createTemporary(),
  async runAgent(input) {
    const budget = new ResearchRunBudget(input.request.limits);
    const providers = createRestResearchProviders(
      input.profile,
      input.request,
      budget,
      { allowProfileAuth: true },
    );
    return runResearchAgent({
      apiKey: input.apiKey,
      request: input.request,
      providers,
      budget,
      scopeCatalog: {
        tenantOrigin: input.request.scope.siteOrigin,
        broker: new ResearchScopeCatalogBroker({
          tenantOrigin: input.request.scope.siteOrigin,
          providers: createRestScopeCatalogProviders(
            input.profile,
            input.request.scope.siteOrigin,
            { allowProfileAuth: true },
          ),
        }),
      },
      runId: input.sessionId,
      researchGraph: input.researchGraph,
      brief: input.brief,
      workspace: input.workspace,
      durableSession: input.durableSession,
      options: {
        signal: input.signal,
        onEvent: input.onEvent,
      },
    });
  },
  async runChatAgent(input) {
    const budget = new ResearchRunBudget(input.request.limits);
    const providers = createRestResearchProviders(
      input.profile,
      input.request,
      budget,
      { allowProfileAuth: true },
    );
    const turn: ChatTurnRequestV1 = {
      schema: "atlcli.chat-turn-request/v1",
      conversationId: input.sessionId,
      turnId: input.turnId,
      question: input.request.question,
      scope: input.request.scope,
      limits: input.request.limits,
      wikiProvider: input.request.wikiProvider,
      ...(input.request.reportLanguage ? { locale: input.request.reportLanguage } : {}),
      ...(input.request.scopeSeeds ? { scopeSeeds: input.request.scopeSeeds } : {}),
      ...(input.request.exactContextProducts
        ? { exactContextProducts: input.request.exactContextProducts }
        : {}),
    };
    return runKiteweaveChatAgent({
      apiKey: input.apiKey,
      hostIdentity: cliChatHostIdentityV1(input.profile),
      turn,
      brokerRequest: input.request,
      providers,
      budget,
      workspace: input.workspace,
      qualityPolicy: input.qualityPolicy,
      resumeAnswer: input.resumeAnswer,
      resumeCheckpoint: input.resumeCheckpoint,
      signal: input.signal,
      onEvent: input.onEvent,
      onChatPresentation: input.onChatPresentation,
      onInteractionReady: input.onInteractionReady,
      onResumeEnvelopeReady: input.onResumeEnvelopeReady,
      onAgentDiagnostic: (diagnostic) => {
        if (diagnostic.kind === "model-step") {
          input.writeDiagnostic(
            `model status=${diagnostic.status} tools=${diagnostic.toolNames?.join(",") || "none"}${diagnostic.stopReason ? ` stop=${diagnostic.stopReason}` : ""}`,
          );
          return;
        }
        input.writeDiagnostic(
          `eval status=${diagnostic.status}${diagnostic.profileId ? ` profile=${diagnostic.profileId}` : ""}${diagnostic.attempt === undefined ? "" : ` attempt=${diagnostic.attempt}`}${diagnostic.codeChars === undefined ? "" : ` code_chars=${diagnostic.codeChars}`}${diagnostic.capabilityNames === undefined ? "" : ` capabilities=${diagnostic.capabilityNames.join(",") || "none"}`}${diagnostic.usesToolsNamespace === undefined ? "" : ` tools_namespace=${diagnostic.usesToolsNamespace}`}${diagnostic.searchInputShapes === undefined ? "" : ` shapes=${diagnostic.searchInputShapes.join(",") || "none"}`}${diagnostic.argumentKeys === undefined ? "" : ` keys=${diagnostic.argumentKeys.join(",") || "none"}`}${diagnostic.resultChars === undefined ? "" : ` chars=${diagnostic.resultChars}`}${diagnostic.errorKind ? ` error=${diagnostic.errorKind}` : ""}${diagnostic.subagentErrorCode ? ` child_code=${diagnostic.subagentErrorCode}` : ""}${diagnostic.errorCode ? ` code=${diagnostic.errorCode}` : ""}`,
        );
      },
    });
  },
  writeAtomic: writeResearchMarkdownAtomic,
  artifactPath: () => researchArtifactPath(),
  createDurableSessionId: () => `research-session:${randomUUID()}`,
  createDurableTurnId: () => `research-turn:${randomUUID()}`,
  async openSessionStore() {
    const configuredRoot = process.env.ATLCLI_RESEARCH_SESSIONS_DIR?.trim();
    const root = configuredRoot
      ? resolve(configuredRoot)
      : join(homedir(), ".atlcli", "research-sessions");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const store = new SqliteResearchSessionStoreV1({
      databasePath: join(root, "catalog.sqlite"),
      root,
    });
    return {
      store,
      workspace: (sessionId) => store.workspace(sessionId),
      close: () => store.close(),
    };
  },
  writeStdout: (contents) => process.stdout.write(contents),
  writeStderr: (contents) => process.stderr.write(contents),
  emitOutput: output,
  fail,
  scheduleAbort: (callback, milliseconds) => setTimeout(callback, milliseconds),
  cancelScheduledAbort: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
  listenForInterrupt(callback) {
    process.once("SIGINT", callback);
    return () => process.removeListener("SIGINT", callback);
  },
  listenForChatInput(callback) {
    if (!process.stdin.isTTY) return () => {};
    const terminal = createLineInterface({ input: process.stdin, terminal: false });
    const onLine = (line: string): void => { void callback(line); };
    terminal.on("line", onLine);
    return () => {
      terminal.removeListener("line", onLine);
      terminal.close();
    };
  },
};

interface RunEstablishedResearchCliSessionInput {
  input: ResearchCliInput;
  opts: OutputOptions;
  dependencies: ResearchCliDependencies;
  profile: Profile;
  request: ResearchRequestV1;
  workspace: ResearchWorkspace;
  store: ResearchSessionStoreV1;
  sessionId: string;
  turnId: string;
  researchGraph: ResearchGraphV1;
  brief: ResearchBriefV1;
  apiKey: string;
}

async function runEstablishedResearchCliSession(
  input: RunEstablishedResearchCliSessionInput,
): Promise<void> {
  const controller = new AbortController();
  const timeout = input.dependencies.scheduleAbort(
    () => controller.abort(new Error("Research run timed out.")),
    input.request.limits.maxRunMs,
  );
  const removeInterruptListener = input.dependencies.listenForInterrupt(() =>
    controller.abort(new Error("Research run cancelled.")),
  );
  try {
    input.dependencies.writeStderr(
      `[research] model=${RESEARCH_MODEL_ID} profile=${input.profile.name} project=${input.request.scope.jiraProjectKeys.join(",")} space=${input.request.scope.confluenceSpaceKeys.join(",")}\n`,
    );
    if (input.input.keepSession) {
      const root =
        "root" in input.workspace && typeof input.workspace.root === "string"
          ? input.workspace.root
          : "host-owned";
      input.dependencies.writeStderr(
        `[research] session=${input.sessionId} workspace=${root}\n`,
      );
    }
    input.dependencies.writeStderr("[research] running — press Ctrl+C to stop\n");
    const report = await input.dependencies.runAgent({
          apiKey: input.apiKey,
          profile: input.profile,
          request: input.request,
          workspace: input.workspace,
          sessionId: input.sessionId,
          durableSession: {
            store: input.store,
            sessionId: input.sessionId,
            turnId: input.turnId,
          },
          researchGraph: input.researchGraph,
          brief: input.brief,
          signal: controller.signal,
          writeDiagnostic: (message) =>
            input.dependencies.writeStderr(`[research] ${message}\n`),
          onEvent: (event) => {
            if (event.kind === "phase") {
              input.dependencies.writeStderr(
                `[research] phase=${event.phase}\n`,
              );
            } else if (event.kind === "progress") {
              input.dependencies.writeStderr(
                `[research] calls=${event.completed}/${event.maximum}\n`,
              );
            } else if (event.kind === "brief") {
              input.dependencies.writeStderr(
                `[research] brief_revision=${event.revision}\n`,
              );
            } else if (event.kind === "plan") {
              input.dependencies.writeStderr(
                `[research] graph_revision=${event.revision} graph_status=${event.status} effort=${event.resolvedEffort} nodes=${event.nodeCount} waves=${event.waveCount} max_parallel=${event.maxParallelNodes} roles=${event.selectedRoleIds.join(",") || "none"}\n`,
              );
            } else if (event.kind === "capability") {
              input.dependencies.writeStderr(
                `[research] tool=${event.toolId} call=${event.callId} kind=${event.inputKind} status=${event.status}${event.inputKeys === undefined ? "" : ` input_keys=${event.inputKeys.join(",") || "none"}`}${event.queryKeys === undefined ? "" : ` query_keys=${event.queryKeys.join(",") || "none"}`}${event.itemCount === undefined ? "" : ` items=${event.itemCount}`}${event.complete === undefined ? "" : ` complete=${event.complete}`}${event.termination === undefined ? "" : ` termination=${event.termination}`}${event.resultBytes === undefined ? "" : ` result_bytes=${event.resultBytes}`}${event.truncated === undefined ? "" : ` truncated=${event.truncated}`}${event.durationMs === undefined ? "" : ` duration_ms=${event.durationMs}`}${event.errorCode === undefined ? "" : ` error=${event.errorCode}`}\n`,
              );
            } else if (event.kind === "subagent") {
              input.dependencies.writeStderr(
                `[research] subagent=${event.roleId} task=${event.taskId} status=${event.status}${event.attempt === undefined ? "" : ` attempt=${event.attempt}`}${event.durationMs === undefined ? "" : ` duration_ms=${event.durationMs}`}${event.errorCode === undefined ? "" : ` error=${event.errorCode}`}\n`,
              );
            } else if (event.kind === "task") {
              input.dependencies.writeStderr(
                `[research] task=${event.taskId} status=${event.status}${event.roleId === undefined ? "" : ` role=${event.roleId}`}${event.wave === undefined ? "" : ` wave=${event.wave}`}${event.dependencyTaskIds === undefined ? "" : ` dependencies=${event.dependencyTaskIds.length}`}${event.grantedCapabilityIds === undefined ? "" : ` grants=${event.grantedCapabilityIds.join(",") || "none"}`}${event.sourceCount === undefined ? "" : ` sources=${event.sourceCount}`}${event.findingCount === undefined ? "" : ` findings=${event.findingCount}`}${event.relationshipCount === undefined ? "" : ` relationships=${event.relationshipCount}`}${event.gapCount === undefined ? "" : ` gaps=${event.gapCount}`}${event.defectCount === undefined ? "" : ` defects=${event.defectCount}`}${event.inputTokens === undefined ? "" : ` input_tokens=${event.inputTokens}`}${event.outputTokens === undefined ? "" : ` output_tokens=${event.outputTokens}`}${event.resultBytes === undefined ? "" : ` result_bytes=${event.resultBytes}`}\n`,
              );
            } else if (event.kind === "decision") {
              input.dependencies.writeStderr(
                `[research] decision=${event.decisionId} status=${event.status} reason=${event.reasonCode}${event.taskId === undefined ? "" : ` task=${event.taskId}`}${event.codeBytes === undefined ? "" : ` code_bytes=${event.codeBytes}`}${event.codeHash === undefined ? "" : ` code_hash=${event.codeHash}`}${event.errorCode === undefined ? "" : ` error=${event.errorCode}`}\n`,
              );
            } else if (event.kind === "reconciliation") {
              input.dependencies.writeStderr(
                `[research] reconciliation=${event.taskId} status=${event.status}${event.defectCount === undefined ? "" : ` defects=${event.defectCount}`}${event.proposedFollowUpCount === undefined ? "" : ` follow_ups=${event.proposedFollowUpCount}`}\n`,
              );
            } else if (event.kind === "retrieval") {
              input.dependencies.writeStderr(
                `[research] retrieval graph_revision=${event.graphRevision} action=${event.action} reason=${event.reason} ranked=${event.rankedCandidateCount} detail_reads=${event.detailReadCount} new_sources=${event.newDetailSourceCount} duplicates=${event.duplicateDetailReadCount} coverage_gaps=${event.unresolvedCoverageTargetCount} contradictions=${event.unresolvedContradictionCount}\n`,
              );
            } else if (event.kind === "budget") {
              input.dependencies.writeStderr(
                `[research] budget=${event.metric} consumed=${event.consumed} maximum=${event.maximum}\n`,
              );
            } else if (event.kind === "artifact") {
              input.dependencies.writeStderr(
                `[research] workspace_artifact=${event.path}\n`,
              );
            } else {
              input.dependencies.writeStderr(
                `[research] trace=${formatResearchOneShotEventV1(event)}\n`,
              );
            }
          },
        });
    const artifactPath = input.dependencies.artifactPath();
    try {
      await input.dependencies.writeAtomic(artifactPath, report.markdown);
      input.dependencies.writeStderr(`[research] artifact=${artifactPath}\n`);
    } catch (error) {
      input.dependencies.writeStderr(
        `[research] artifact=unavailable reason=${error instanceof Error ? error.name : "unknown"}\n`,
      );
    }
    if (input.input.outputPath)
      await input.dependencies.writeAtomic(
        input.input.outputPath,
        report.markdown,
      );
    if (input.opts.json)
      input.dependencies.emitOutput(
        { sessionId: input.sessionId, artifactPath, report },
        input.opts,
      );
    else input.dependencies.writeStdout(report.markdown);
  } finally {
    input.dependencies.cancelScheduledAbort(timeout);
    removeInterruptListener();
  }
}

async function startNewResearchCliSessionTurn(
  input: ResearchCliInput,
  opts: OutputOptions,
  dependencies: ResearchCliDependencies,
): Promise<void> {
  const sessionId = input.newTurnSessionId;
  if (!sessionId)
    throw new Error(
      "A durable research session ID is required for a new turn.",
    );
  const profile = await dependencies.resolveProfile(input.profile);
  if (!profile) {
    dependencies.fail(
      opts,
      1,
      ERROR_CODES.AUTH,
      "No active profile found. Run `atlcli auth login` or select --profile.",
      { profile: input.profile },
    );
  }
  const opened = await dependencies.openSessionStore();
  let disposeWorkspace: (() => Promise<void>) | undefined;
  try {
    const stored = await requireStoredResearchSession(opened.store, sessionId);
    if (
      !["complete", "cancelled", "failed"].includes(stored.status) ||
      stored.retention.state === "deletion_requested" ||
      stored.retention.state === "deleted"
    ) {
      throw new Error(
        "A new research turn requires a retained terminal session.",
      );
    }
    const previousTurn = activeSessionTurn(stored);
    if (!previousTurn?.brief)
      throw new Error(
        "The retained research session has no prior brief to preserve.",
      );
    if (
      new URL(profile.baseUrl).origin !== previousTurn.brief.scope.siteOrigin
    ) {
      throw new Error(
        "The selected profile belongs to a different Atlassian tenant than the retained research session.",
      );
    }
    const turnId = dependencies.createDurableTurnId();
    const request = normalizeResearchRequestV1({
      ...researchRequestFromBriefV1(previousTurn.brief),
      question: input.question,
    });
    const briefOutcome = dependencies.prepareBrief({
      request,
      policy: researchPolicyFromBriefV1(previousTurn.brief),
      asOf: new Date().toISOString(),
      timezone: previousTurn.brief.timezone,
      sessionId,
      turnId,
      scopeBindings: previousTurn.scopeBindings,
    });
    if (briefOutcome.kind === "clarification_required") {
      dependencies.writeStderr(
        `[research] session=${sessionId} stop_reason=clarification-required brief_revision=${briefOutcome.clarification.briefRevision} questions=${briefOutcome.clarification.questions.length} assumptions=${briefOutcome.clarification.assumptionsRequiringDecision.length}\n`,
      );
      dependencies.fail(
        opts,
        2,
        ERROR_CODES.VALIDATION,
        "The new research turn requires clarification before it can be added to the retained session.",
        { outcome: briefOutcome },
      );
    }
    const researchGraph = composeResearchGraphV1(briefOutcome.brief, {
      packetOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2,
    });
    const appended = await appendResearchSessionTurnV1({
      store: opened.store,
      sessionId,
      brief: briefOutcome.brief,
      graph: researchGraph,
      approveAutomatically:
        briefOutcome.brief.resolvedPlanApproval === "automatic",
      at: new Date().toISOString(),
    });
    const appendedTurn = activeSessionTurn(appended);
    if (
      !appendedTurn?.brief ||
      !appendedTurn.graph ||
      appendedTurn.id !== turnId
    ) {
      throw new Error(
        "The retained research session did not persist its new turn.",
      );
    }
    dependencies.writeStderr(
      `[research] session=${sessionId} turn=${turnId} status=${appended.status} new_turn=true\n`,
    );
    if (appended.status === "waiting_plan_approval") {
      dependencies.emitOutput(projectResearchSessionPlanV1(appended), opts);
      return;
    }
    if (appended.status !== "running")
      throw new Error("The new durable research turn is not runnable.");
    const apiKey = readApiKey(dependencies);
    if (!apiKey) {
      const waiting = await opened.store.commit(sessionId, {
        kind: "wait_authentication",
        expectedRevision: appended.revision,
        expectedLeaseEpoch: appended.lease.epoch,
        at: new Date().toISOString(),
      });
      dependencies.writeStderr(
        `[research] session=${waiting.session.sessionId} status=${waiting.session.status} stop_reason=authentication-required\n`,
      );
      throw new Error(
        "ANTHROPIC_API_KEY is missing. Set it in the process environment; it is never read from a CLI flag.",
      );
    }
    const workspace = opened.workspace
      ? await opened.workspace(sessionId)
      : await dependencies.createWorkspace();
    if (!opened.workspace)
      disposeWorkspace = () => (workspace as ResearchCliWorkspace).dispose();
    await runEstablishedResearchCliSession({
      input,
      opts,
      dependencies,
      profile,
      request,
      workspace,
      store: opened.store,
      sessionId,
      turnId,
      researchGraph: appendedTurn.graph,
      brief: appendedTurn.brief,
      apiKey,
    });
  } finally {
    if (!input.keepSession) await disposeWorkspace?.();
    opened.close();
  }
}

async function resumeAuthenticationWaitingResearchSession(
  input: ResearchCliInput,
  opts: OutputOptions,
  dependencies: ResearchCliDependencies,
): Promise<void> {
  const sessionId = input.resumeSessionId;
  if (!sessionId)
    throw new Error("A durable research session ID is required to resume.");
  const profile = await dependencies.resolveProfile(input.profile);
  if (!profile) {
    dependencies.fail(
      opts,
      1,
      ERROR_CODES.AUTH,
      "No active profile found. Run `atlcli auth login` or select --profile.",
      { profile: input.profile },
    );
  }
  const opened = await dependencies.openSessionStore();
  let disposeWorkspace: (() => Promise<void>) | undefined;
  try {
    const stored = await requireStoredResearchSession(opened.store, sessionId);
    const turn = activeSessionTurn(stored);
    if (
      !turn?.brief ||
      !turn.graph ||
      ![
        "waiting_authentication",
        "waiting_quota",
        "waiting_steering",
        "paused",
        "running",
      ].includes(stored.status)
    ) {
      throw new Error(
        "Only a released durable research turn can be resumed by this command.",
      );
    }
    const issuedContinuations =
      turn.retrievalAssessments?.filter(
        (assessment) =>
          assessment.graphRevision === turn.graph!.revision &&
          assessment.continuation?.status === "issued",
      ) ?? [];
    const undispatched =
      turn.tasks.length === 0 &&
      turn.acceptedPackets.length === 0 &&
      turn.graphSelectionCommittedAt === undefined;
    const checkpointResumable =
      issuedContinuations.length === 1 &&
      turn.tasks.length > 0 &&
      turn.acceptedPackets.length > 0 &&
      turn.budgetState !== undefined;
    const consumedContinuationRecoverable =
      isRecoverableConsumedRetrievalContinuationV1(turn);
    if (
      !undispatched &&
      !checkpointResumable &&
      !consumedContinuationRecoverable
    ) {
      throw new Error(
        "This durable session has dispatch state without one safe issued retrieval continuation.",
      );
    }
    if (
      turn.graph.approvalEnvelope.status !== "approved" ||
      (undispatched
        ? turn.graph.status !== "approved"
        : turn.graph.status !== "running")
    ) {
      throw new Error(
        "The durable research graph is not in the required approved checkpoint state for resume.",
      );
    }
    if (new URL(profile.baseUrl).origin !== turn.brief.scope.siteOrigin) {
      throw new Error(
        "The selected profile belongs to a different Atlassian tenant than the durable research session.",
      );
    }
    const apiKey = readApiKey(dependencies);
    if (!apiKey) {
      if (stored.status === "running") {
        await opened.store.commit(stored.sessionId, {
          kind: "wait_authentication",
          expectedRevision: stored.revision,
          expectedLeaseEpoch: stored.lease.epoch,
          at: new Date().toISOString(),
        });
      }
      dependencies.writeStderr(
        `[research] session=${stored.sessionId} status=${stored.status} stop_reason=authentication-required\n`,
      );
      throw new Error(
        "ANTHROPIC_API_KEY is missing. Set it in the process environment; it is never read from a CLI flag.",
      );
    }
    const request = researchRequestFromBriefV1(turn.brief);
    const now = new Date().toISOString();
    const resumed = await recoverResearchSessionForResumeV1({
      store: opened.store,
      sessionId: stored.sessionId,
      ownerId: `owner:cli-${process.pid}`,
      leaseExpiresAt: new Date(
        Date.parse(now) + request.limits.maxRunMs,
      ).toISOString(),
      at: now,
    });
    const resumedTurn = activeSessionTurn(resumed);
    if (
      !resumedTurn?.brief ||
      !resumedTurn.graph ||
      resumedTurn.id !== turn.id
    ) {
      throw new Error(
        "Recovered research session no longer has its accepted turn and graph.",
      );
    }
    const workspace = opened.workspace
      ? await opened.workspace(resumed.sessionId)
      : await dependencies.createWorkspace();
    if (!opened.workspace) {
      const temporaryWorkspace = workspace as ResearchCliWorkspace;
      disposeWorkspace = () => temporaryWorkspace.dispose();
    }
    dependencies.writeStderr(
      `[research] session=${resumed.sessionId} status=${resumed.status} recovery=claimed lease_epoch=${resumed.lease.epoch}\n`,
    );
    await runEstablishedResearchCliSession({
      input,
      opts,
      dependencies,
      profile,
      request,
      workspace,
      store: opened.store,
      sessionId: resumed.sessionId,
      turnId: resumedTurn.id,
      researchGraph: resumedTurn.graph,
      brief: resumedTurn.brief,
      apiKey,
    });
  } finally {
    if (!input.keepSession) await disposeWorkspace?.();
    opened.close();
  }
}

async function runDirectChatCliConversation(input: {
  cli: ResearchCliInput;
  opts: OutputOptions;
  dependencies: ResearchCliDependencies;
  profile: Profile;
  request: ResearchRequestV1;
  workspace: ResearchWorkspace;
  store: ResearchSessionStoreV1;
  sessionId: string;
  apiKey: string;
}): Promise<void> {
  const controller = new AbortController();
  let removeChatInputListener = (): void => {};
  let controlInput = Promise.resolve();
  const timeout = input.dependencies.scheduleAbort(
    () => controller.abort(new Error("Chat run timed out.")),
    input.request.limits.maxRunMs,
  );
  const removeInterruptListener = input.dependencies.listenForInterrupt(() =>
    controller.abort(new Error("Chat run cancelled.")),
  );
  try {
    input.dependencies.writeStderr(
      `[chat] model=${RESEARCH_MODEL_ID} quality=${input.cli.qualityPolicy?.mode ?? "auto"} profile=${input.profile.name} session=${input.sessionId}\n`,
    );
    const contextLabels = [
      ...input.request.scope.confluenceSpaceKeys.map((key) => `Confluence ${key}`),
      ...input.request.scope.jiraProjectKeys.map((key) => `Jira ${key}`),
      ...(input.request.scopeSeeds?.map((seed) => seed.binding.name) ?? []),
    ];
    input.dependencies.writeStderr(
      `[chat] Context: ${contextLabels.length > 0 ? [...new Set(contextLabels)].join(", ") : "question only"}\n`,
    );
    input.dependencies.writeStderr("[chat] running — press Ctrl+C to stop\n");
    let checkpoint: { conversationId: string; turnId: string } | undefined;
    let answer: ChatAnswerV1;
    const port = createCliChatAgentPortV1({
      store: input.store,
      workspace: input.workspace,
      conversationId: input.sessionId,
      siteOrigin: input.request.scope.siteOrigin,
      hostIdentity: cliChatHostIdentityV1(input.profile),
      createTurnId: input.dependencies.createDurableTurnId,
      async execute(execution) {
        return input.dependencies.runChatAgent({
          apiKey: input.apiKey,
          profile: input.profile,
          request: execution.request,
          workspace: input.workspace,
          sessionId: execution.conversationId,
          turnId: execution.turnId,
          conversation: { sessionId: execution.conversationId },
          policy: input.cli.policy,
          qualityPolicy: execution.qualityPolicy,
          ...(execution.resumeAnswer ? { resumeAnswer: execution.resumeAnswer } : {}),
          ...(execution.resumeCheckpoint
            ? { resumeCheckpoint: execution.resumeCheckpoint }
            : {}),
          signal: execution.signal,
          writeDiagnostic: (message) => {
            if (process.env.ATLCLI_CHAT_DIAGNOSTICS === "1") {
              input.dependencies.writeStderr(`[chat-diagnostic] ${message}\n`);
            }
          },
          onEvent: execution.stream?.onEvent ?? (() => {}),
          onChatPresentation: execution.stream?.onPresentation ?? (() => {}),
          onInteractionReady: execution.onInteractionReady,
          onResumeEnvelopeReady: execution.onResumeEnvelopeReady,
        });
      },
    });
    const startChatInputListener = (): void => {
      removeChatInputListener();
      removeChatInputListener = input.dependencies.listenForChatInput((line) => {
        controlInput = controlInput.then(async () => {
          const result = await handleCliChatControlLineV1({
            line,
            port,
            siteOrigin: input.request.scope.siteOrigin,
            createId: (kind) => `chat-${kind}:${randomUUID()}`,
          });
          if (result.message) {
            input.dependencies.writeStderr(
              `[chat] ${result.message.replace(/\n/gu, "\n[chat] ")}\n`,
            );
          }
        }).catch((error: unknown) => {
          input.dependencies.writeStderr(
            `[chat] control failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
          );
        });
      });
    };
    startChatInputListener();
    input.dependencies.writeStderr(
      "[chat] Enter text to queue a follow-up; use /help for steering and queue controls.\n",
    );
    const presentationLocale = input.request.reportLanguage === "de" ? "de" : "en";
    const stream = {
      signal: controller.signal,
      onSessionStart(session: { conversationId: string; turnId: string }) {
        checkpoint = session;
      },
      onEvent(event: ResearchOneShotEventV1) {
        if (event.kind === "activity") {
          input.dependencies.writeStderr(
            `[chat] ${formatCliChatActivityV1(event, presentationLocale)}\n`,
          );
        } else if (event.kind === "capability") {
          const detail = formatCliChatCapabilityDetailV1(event, presentationLocale);
          if (detail) input.dependencies.writeStderr(`[chat]   ${detail}\n`);
        }
      },
      onPresentation(event: ChatPresentationStreamEventV1) {
        if (event.status === "started") {
          input.dependencies.writeStderr(
            event.channel === "reasoning-summary"
              ? "[chat] Kiteweave: "
              : "[chat] Answer: ",
          );
        } else if (event.status === "delta") {
          input.dependencies.writeStderr(event.delta ?? "");
        } else if (event.status === "reset") {
          input.dependencies.writeStderr(
            presentationLocale === "de"
              ? "\n[chat] Der vorläufige Entwurf wird korrigiert.\n[chat] Answer: "
              : "\n[chat] The provisional draft is being corrected.\n[chat] Answer: ",
          );
        } else {
          input.dependencies.writeStderr("\n");
        }
      },
    };
    const qualityPolicy = input.cli.qualityPolicy ?? chatQualityPolicyForModeV1("auto");
    const executeTurn = async (request: ResearchRequestV1): Promise<ChatAnswerV1> => {
      let action: "start" | "answer" | "steering" | "stream-interruption" = "start";
      let interruptionRetries = 0;
      while (true) {
        try {
          if (action === "start") {
            checkpoint = undefined;
            return await port.startTurn({
              request,
              qualityPolicy,
              conversationId: input.sessionId,
            }, stream);
          }
          if (!checkpoint) {
            throw new Error("Chat paused without publishing its durable checkpoint.");
          }
          if (action === "answer") {
            const pending = await port.getPendingQuestion(input.request.scope.siteOrigin);
            if (!pending) throw new Error("The durable Chat question is unavailable.");
            removeChatInputListener();
            let userAnswer: ChatUserQuestionAnswerV1;
            try {
              userAnswer = await input.dependencies.askChatUserQuestion(pending.question);
            } finally {
              startChatInputListener();
            }
            return await port.answerQuestion({
              siteOrigin: input.request.scope.siteOrigin,
              conversationId: checkpoint.conversationId,
              turnId: checkpoint.turnId,
              answer: userAnswer,
            }, stream);
          }
          return await port.resumeTurn({
            siteOrigin: input.request.scope.siteOrigin,
            conversationId: checkpoint.conversationId,
            turnId: checkpoint.turnId,
            kind: action,
          }, stream);
        } catch (error) {
          if (error instanceof ChatUserQuestionRequiredError) {
            action = "answer";
            continue;
          }
          const paused = error && typeof error === "object" && "code" in error &&
            error.code === "paused";
          if (!paused) throw error;
          await controlInput;
          const state = await port.getInteraction(input.request.scope.siteOrigin);
          if (state?.pendingSteering) {
            const pending = state.pendingSteering;
            await port.control({
              kind: "consume_steering",
              expectedRevision: state.revision,
              steeringId: pending.id,
              expectedSteeringRevision: pending.revision,
            });
            action = "steering";
            continue;
          }
          if (shouldAutomaticallyResumeChatStreamV1({
            checkpointAvailable: state?.streamInterruption !== undefined,
            completedAttempts: interruptionRetries,
          })) {
            interruptionRetries += 1;
            action = "stream-interruption";
            continue;
          }
          throw error;
        }
      }
    };
    const answers: ChatAnswerV1[] = [];
    answer = await executeTurn(input.request);
    answers.push(answer);
    await controlInput;
    while (true) {
      const state = await port.getInteraction(input.request.scope.siteOrigin);
      const queued = state?.queue[0];
      if (!state || !queued) break;
      input.dependencies.writeStderr(`[chat] follow-up=${queued.id} status=started\n`);
      const queuedAnswer = await executeTurn(
        normalizeResearchRequestV1({ ...input.request, question: queued.content }),
      );
      const current = await port.getInteraction(input.request.scope.siteOrigin);
      const admitted = current?.queue.find((candidate) => candidate.id === queued.id);
      if (!current || !admitted) {
        throw new Error("The completed queued Chat message lost its durable queue record.");
      }
      await port.control({
        kind: "remove",
        expectedRevision: current.revision,
        messageId: admitted.id,
        expectedMessageRevision: admitted.revision,
      });
      input.dependencies.writeStderr(`[chat] follow-up=${queued.id} status=completed\n`);
      answer = queuedAnswer;
      answers.push(answer);
    }
    const markdown = answers.map((entry) => entry.messageMarkdown).join("\n\n---\n\n");
    const artifactPath = input.dependencies.artifactPath();
    try {
      await input.dependencies.writeAtomic(artifactPath, markdown);
      input.dependencies.writeStderr(`[chat] artifact=${artifactPath}\n`);
    } catch (error) {
      input.dependencies.writeStderr(
        `[chat] artifact=unavailable reason=${error instanceof Error ? error.name : "unknown"}\n`,
      );
    }
    if (input.cli.outputPath) {
      await input.dependencies.writeAtomic(input.cli.outputPath, markdown);
    }
    if (input.opts.json) {
      input.dependencies.emitOutput(
        { sessionId: input.sessionId, artifactPath, answer, answers },
        input.opts,
      );
    } else {
      input.dependencies.writeStdout(markdown);
    }
  } finally {
    removeChatInputListener();
    await controlInput;
    input.dependencies.cancelScheduledAbort(timeout);
    removeInterruptListener();
  }
}

async function handleChatSessions(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
  dependencies: ResearchCliDependencies,
): Promise<void> {
  const allowed = new Set(["profile", "json", "help", "h"]);
  const unknown = Object.keys(flags).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown chat history option: --${unknown[0]}.`);
  }
  const command = args[0] ?? "list";
  if (command === "help" || hasFlag(flags, "help") || hasFlag(flags, "h")) {
    dependencies.emitOutput(
      "atlcli chat sessions <list|show|sources|artifact> [conversation-id]",
      opts,
    );
    return;
  }
  if (!["list", "show", "sources", "artifact"].includes(command)) {
    throw new Error("Chat history command must be list, show, sources, or artifact.");
  }
  const profile = await dependencies.resolveProfile(getFlag(flags, "profile"));
  if (!profile) {
    dependencies.fail(opts, 1, ERROR_CODES.AUTH, "No active profile found.");
  }
  const siteOrigin = new URL(profile.baseUrl).origin;
  const identity = cliChatHostIdentityV1(profile);
  const opened = await dependencies.openSessionStore();
  try {
    const targetId = args[1];
    const seedPage = await opened.store.list({ limit: 1 });
    const seedId = targetId ?? seedPage.sessions[0]?.sessionId;
    if (!seedId) {
      dependencies.emitOutput(command === "list" ? [] : null, opts);
      return;
    }
    const workspace = await opened.store.workspace(seedId);
    const port = createCliChatAgentPortV1({
      store: opened.store,
      workspace,
      conversationId: seedId,
      siteOrigin,
      hostIdentity: identity,
      createTurnId: dependencies.createDurableTurnId,
      async execute() {
        throw new Error("Chat history inspection cannot start model work.");
      },
    });
    if (command === "list") {
      const history = await port.listHistory(siteOrigin);
      if (opts.json) {
        dependencies.emitOutput(history, opts);
      } else {
        dependencies.writeStdout(history.length === 0
          ? "No retained Chat conversations.\n"
          : `${history.map((entry) => [
              entry.conversationId,
              entry.status ?? "empty",
              entry.updatedAt,
              entry.latestObjective ?? "",
            ].join("\t")).join("\n")}\n`);
      }
      return;
    }
    if (!targetId) throw new Error(`${command} requires a conversation ID.`);
    const replay = await port.replay({ siteOrigin, conversationId: targetId });
    if (!replay) throw new Error("The retained Chat conversation was not found.");
    if (command === "show") {
      if (opts.json) {
        dependencies.emitOutput(replay, opts);
      } else {
        for (const event of replay.events) {
          dependencies.writeStderr(
            `[chat] ${formatCliChatActivityV1(event, "en")}\n`,
          );
        }
        dependencies.writeStdout(replay.finalAnswer?.messageMarkdown ?? "No final answer.\n");
      }
      return;
    }
    const checkpoint = {
      siteOrigin,
      conversationId: targetId,
      turnId: replay.turnId,
    };
    if (command === "sources") {
      dependencies.emitOutput(await port.sources(checkpoint), opts);
      return;
    }
    const artifact = await port.artifact(checkpoint);
    if (opts.json) dependencies.emitOutput(artifact, opts);
    else dependencies.writeStdout(artifact?.markdown ?? "");
  } finally {
    opened.close();
  }
}

export async function handleChat(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
  dependencies: ResearchCliDependencies = defaultResearchCliDependencies,
): Promise<void> {
  if (args[0] === "sessions") {
    await handleChatSessions(args.slice(1), flags, opts, dependencies);
    return;
  }
  if (hasFlag(flags, "help") || hasFlag(flags, "h")) {
    dependencies.emitOutput(chatHelp(), opts);
    return;
  }
  const input = parseChatCliInput(args, flags);
  const profile = await dependencies.resolveProfile(input.profile);
  if (!profile) {
    dependencies.fail(
      opts,
      1,
      ERROR_CODES.AUTH,
      "No active profile found. Run `atlcli auth login` or select --profile.",
      { profile: input.profile },
    );
  }
  const opened = await dependencies.openSessionStore();
  try {
    let effectiveInput = input;
    let request: ResearchRequestV1;
    let workspace: ResearchWorkspace;
    let sessionId: string;
    if (input.newTurnSessionId) {
      const stored = await opened.store.read(input.newTurnSessionId);
      if (!stored) {
        throw new Error("The requested chat conversation does not exist.");
      }
      if (input.chatScopeSelection) {
        const state = stored.scopeClarification;
        const review = projectChatScopeClarificationReviewV1(
          stored,
          new URL(profile.baseUrl).origin,
        );
        if (!state || !review || stored.revision !== input.chatScopeSelection.revision ||
            review.clarification.mentionId !== input.chatScopeSelection.mentionId ||
            !review.clarification.candidates.some((candidate) =>
              candidate.id === input.chatScopeSelection!.candidateId
            )) {
          throw new Error("Chat scope clarification is stale; inspect the current review and retry.");
        }
        const selection = {
          schema: "atlcli.research-scope-candidate-selection/v1" as const,
          mentionId: input.chatScopeSelection.mentionId,
          candidateId: input.chatScopeSelection.candidateId,
        };
        const scopeOutcome = await dependencies.resolveScope({
          profile,
          request: state.request,
          options: { candidateSelections: [selection] },
        });
        if (scopeOutcome.kind === "clarification_required") {
          const refreshed = await refreshResearchSessionScopeClarificationV1({
            store: opened.store,
            sessionId: stored.sessionId,
            expectedRevision: stored.revision,
            expectedLeaseEpoch: stored.lease.epoch,
            clarification: scopeOutcome.clarification,
            candidateChoices: scopeOutcome.candidateChoices,
            at: new Date().toISOString(),
          });
          const review = projectChatScopeClarificationReviewV1(
            refreshed,
            state.request.scope.siteOrigin,
          );
          if (review && !opts.json) {
            dependencies.writeStderr(formatChatScopeClarificationForCliV1(review));
          }
          dependencies.fail(
            opts,
            2,
            ERROR_CODES.VALIDATION,
            "Chat scope still requires a candidate choice.",
            { review },
          );
        }
        const resolved = await resolveChatScopeClarificationV1({
          store: opened.store,
          sessionId: stored.sessionId,
          expectedRevision: stored.revision,
          expectedLeaseEpoch: stored.lease.epoch,
          selection,
          resolvedRequest: scopeOutcome.request,
          at: new Date().toISOString(),
        });
        request = prepareDirectChatRequestV1(resolved.request);
        sessionId = resolved.conversationSession.sessionId;
        const now = new Date().toISOString();
        workspace = await openDurableChatConversationWorkspaceV1({
          store: opened.store,
          sessionId,
          ownerId: `owner:cli-chat-${process.pid}`,
          createdAt: now,
          leaseExpiresAt: new Date(Date.parse(now) + request.limits.maxRunMs).toISOString(),
        });
        await workspace.writeFile(CHAT_CONTEXT_REQUEST_PATH_V1, JSON.stringify(request));
      } else {
        sessionId = input.newTurnSessionId;
        workspace = await opened.store.workspace(sessionId);
        const retained = await workspace.readFile(CHAT_CONTEXT_REQUEST_PATH_V1);
        if (!retained) {
          throw new Error("The retained session is not an ordinary chat conversation.");
        }
        const previous = normalizeResearchRequestV1(JSON.parse(retained));
        if (new URL(profile.baseUrl).origin !== previous.scope.siteOrigin) {
          throw new Error(
            "The selected profile belongs to a different Atlassian tenant than the retained chat conversation.",
          );
        }
        const rebound = await dependencies.resolveScope({
          profile,
          request: normalizeResearchRequestV1({ ...previous, question: input.question }),
        });
        if (rebound.kind === "clarification_required") {
          throw new Error("The retained chat scope could not be revalidated unambiguously.");
        }
        request = prepareDirectChatRequestV1({ ...rebound.request, question: input.question });
      }
    } else {
      const initial = buildChatRequest(input, profile);
      const scopeOutcome = await dependencies.resolveScope({
        profile,
        request: initial,
      });
      if (scopeOutcome.kind === "clarification_required") {
        const now = new Date().toISOString();
        const waiting = await initializeResearchSessionScopeClarificationWaitV1({
          store: opened.store,
          session: createResearchSessionV1({
            sessionId: dependencies.createDurableSessionId(),
            ownerId: `owner:cli-chat-scope-${process.pid}`,
            createdAt: now,
            leaseExpiresAt: new Date(Date.parse(now) + initial.limits.maxRunMs).toISOString(),
          }),
          request: initial,
          policy: input.policy,
          purpose: "chat",
          clarification: scopeOutcome.clarification,
          candidateChoices: scopeOutcome.candidateChoices,
          at: now,
        });
        const review = projectChatScopeClarificationReviewV1(
          waiting,
          initial.scope.siteOrigin,
        );
        if (review && !opts.json) {
          dependencies.writeStderr(formatChatScopeClarificationForCliV1(review));
        }
        dependencies.fail(
          opts,
          2,
          ERROR_CODES.VALIDATION,
          "Chat scope requires a durable candidate choice. Resume the retained session with its exact revision, mention, and candidate IDs.",
          { review },
        );
      }
      request = prepareDirectChatRequestV1(scopeOutcome.request);
      sessionId = dependencies.createDurableSessionId();
      const now = new Date().toISOString();
      workspace = await openDurableChatConversationWorkspaceV1({
        store: opened.store,
        sessionId,
        ownerId: `owner:cli-chat-${process.pid}`,
        createdAt: now,
        leaseExpiresAt: new Date(
          Date.parse(now) + request.limits.maxRunMs,
        ).toISOString(),
      });
      await workspace.writeFile(
        CHAT_CONTEXT_REQUEST_PATH_V1,
        JSON.stringify(request),
      );
    }
    if (input.newTurnSessionId && !input.thinkingModeExplicit) {
      const retainedSession = await workspace.readFile(CHAT_SESSION_PATH_V1);
      if (retainedSession) {
        const parsedSession = parseChatSessionV1(JSON.parse(retainedSession));
        const priorCompletedTurn = [...parsedSession.conversation.recentTurns]
          .reverse()
          .find((turn) => turn.status === "complete");
        if (priorCompletedTurn) {
          effectiveInput = {
            ...input,
            policy: chatPolicyForThinkingModeV1(priorCompletedTurn.qualityMode),
            qualityPolicy: chatQualityPolicyForModeV1(priorCompletedTurn.qualityMode),
          };
        }
      }
    }
    // Durable conversations retain approved scope and user ceilings, but each
    // new turn must use the current shared runtime corridor for its inherited
    // Chat mode. Otherwise a conversation created by an older build remains
    // permanently pinned to obsolete call/body limits after an upgrade.
    request = prepareDirectChatRequestV1(applyChatQualityResourcePolicyV1(
      request,
      effectiveInput.qualityPolicy?.mode ?? "auto",
    ));
    const apiKey = readApiKey(dependencies);
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is missing. Set it in the process environment; it is never read from a CLI flag.",
      );
    }
    await runDirectChatCliConversation({
      cli: effectiveInput,
      opts,
      dependencies,
      profile,
      request,
      workspace,
      store: opened.store,
      sessionId,
      apiKey,
    });
  } finally {
    opened.close();
  }
}

export async function handleResearch(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
  dependencies: ResearchCliDependencies = defaultResearchCliDependencies,
): Promise<void> {
  if (hasFlag(flags, "help") || hasFlag(flags, "h")) {
    dependencies.emitOutput(researchHelp(), opts);
    return;
  }
  if (args[0] === "sessions") {
    await handleResearchSessions(args.slice(1), flags, opts, dependencies);
    return;
  }
  const input = parseResearchCliInput(args, flags);
  if (input.resumeSessionId) {
    await resumeAuthenticationWaitingResearchSession(input, opts, dependencies);
    return;
  }
  if (input.newTurnSessionId) {
    await startNewResearchCliSessionTurn(input, opts, dependencies);
    return;
  }
  const profile = await dependencies.resolveProfile(input.profile);
  if (!profile) {
    dependencies.fail(
      opts,
      1,
      ERROR_CODES.AUTH,
      "No active profile found. Run `atlcli auth login` or select --profile.",
      { profile: input.profile },
    );
  }
  const initialRequest = buildResearchRequest(input, profile);
  const scopeOutcome = await dependencies.resolveScope({
    profile,
    request: initialRequest,
  });
  if (scopeOutcome.kind === "clarification_required") {
    const clarification = scopeOutcome.clarification;
    const opened = await dependencies.openSessionStore();
    let waiting: ResearchSessionV1 | undefined;
    let review: ReturnType<
      typeof projectResearchSessionScopeClarificationReviewV1
    >;
    try {
      const now = new Date().toISOString();
      waiting = await initializeResearchSessionScopeClarificationWaitV1({
        store: opened.store,
        session: createResearchSessionV1({
          sessionId: dependencies.createDurableSessionId(),
          ownerId: `owner:cli-scope-clarification-${process.pid}`,
          createdAt: now,
          leaseExpiresAt: new Date(
            Date.parse(now) + initialRequest.limits.maxRunMs,
          ).toISOString(),
        }),
        request: initialRequest,
        policy: input.policy,
        clarification,
        candidateChoices: scopeOutcome.candidateChoices,
        at: now,
      });
      review = projectResearchSessionScopeClarificationReviewV1(
        waiting,
        initialRequest.scope.siteOrigin,
      );
      if (!review || review.stage !== "choice_required") {
        throw new Error(
          "The durable research scope clarification could not be projected.",
        );
      }
    } finally {
      opened.close();
    }
    dependencies.writeStderr(
      `[research] session=${waiting!.sessionId} status=${waiting!.status} stop_reason=scope-clarification-required reason=${clarification.reason} mention=${clarification.mentionId} candidates=${clarification.candidateIds.length}\n`,
    );
    dependencies.fail(
      opts,
      2,
      ERROR_CODES.VALIDATION,
      "Research scope requires a durable candidate choice. Inspect the retained session, then submit its exact revision, mention, and candidate IDs.",
      {
        session: {
          sessionId: waiting!.sessionId,
          revision: waiting!.revision,
          status: waiting!.status,
        },
        review,
      },
    );
  }
  const request = scopeOutcome.request;
  const durableSessionId = dependencies.createDurableSessionId();
  const durableTurnId = dependencies.createDurableTurnId();
  const briefOutcome = dependencies.prepareBrief({
    request,
    policy: input.policy,
    asOf: new Date().toISOString(),
    timezone: input.timezone,
    sessionId: durableSessionId,
    turnId: durableTurnId,
  });
  if (briefOutcome.kind === "clarification_required") {
    const clarification = briefOutcome.clarification;
    const opened = await dependencies.openSessionStore();
    let waiting: ResearchSessionV1 | undefined;
    try {
      const now = new Date().toISOString();
      waiting = await initializeResearchSessionClarificationWaitV1({
        store: opened.store,
        session: createResearchSessionV1({
          sessionId: durableSessionId,
          ownerId: `owner:cli-${process.pid}`,
          createdAt: now,
          leaseExpiresAt: new Date(
            Date.parse(now) + request.limits.maxRunMs,
          ).toISOString(),
        }),
        brief: briefOutcome.brief,
        at: now,
      });
    } finally {
      opened.close();
    }
    dependencies.writeStderr(
      `[research] session=${waiting!.sessionId} status=${waiting!.status} stop_reason=clarification-required brief_revision=${clarification.briefRevision} questions=${clarification.questions.length} assumptions=${clarification.assumptionsRequiringDecision.length}\n`,
    );
    dependencies.fail(
      opts,
      2,
      ERROR_CODES.VALIDATION,
      "Research brief requires clarification. Inspect the retained session, then provide revision-fenced answers before research can continue.",
      {
        outcome: briefOutcome,
        session: {
          sessionId: waiting!.sessionId,
          revision: waiting!.revision,
          status: waiting!.status,
        },
      },
    );
  }
  const researchGraph = composeResearchGraphV1(briefOutcome.brief, {
    packetOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2,
  });
  const selectedRoles = projectSelectedResearchRolesV1(researchGraph);
  dependencies.writeStderr(
    `[research] brief_revision=${researchGraph.basedOnBriefRevision} graph_revision=${researchGraph.revision} graph_status=${researchGraph.status} effort=${researchGraph.resolvedEffort} plan_approval=${researchGraph.approvalEnvelope.status} scope_expansion=${researchGraph.approvalEnvelope.scopeDiscoveryPolicy.expansionMode} reconciliation=${researchGraph.reconciliationPolicy.mode}\n`,
  );
  dependencies.writeStderr(
    `[research] roles=${selectedRoles.join(",") || "none"} nodes=${researchGraph.nodes.map((node) => `${node.id}:${node.status}`).join(",")}\n`,
  );
  dependencies.writeStderr(
    `[research] scope_bindings=${(request.scopeSeeds ?? []).map((seed) => `${seed.binding.product}:${seed.binding.key}:${seed.binding.source}:${seed.binding.authority}`).join(",") || "none"}\n`,
  );
  if (input.planOnly) {
    const opened = await dependencies.openSessionStore();
    try {
      const now = new Date().toISOString();
      let session = await initializeResearchSessionTurnV1({
        store: opened.store,
        session: createResearchSessionV1({
          sessionId: durableSessionId!,
          ownerId: `owner:cli-${process.pid}`,
          createdAt: now,
          leaseExpiresAt: new Date(
            Date.parse(now) + request.limits.maxRunMs,
          ).toISOString(),
        }),
        brief: briefOutcome.brief,
        graph: researchGraph,
        approveAutomatically:
          briefOutcome.brief.resolvedPlanApproval === "automatic",
        at: now,
      });
      if (session.status === "running") {
        session = (
          await opened.store.commit(session.sessionId, {
            kind: "release_lease",
            expectedRevision: session.revision,
            expectedLeaseEpoch: session.lease.epoch,
            at: new Date().toISOString(),
          })
        ).session;
      }
      const graph = session.turns.find(
        (turn) => turn.id === durableTurnId,
      )?.graph;
      const plan = {
        sessionId: session.sessionId,
        sessionRevision: session.revision,
        status: session.status,
        brief: {
          revision: briefOutcome.brief.revision,
          objective: briefOutcome.brief.objective,
          scope: briefOutcome.brief.scope,
          scopeBindings: briefOutcome.brief.scopeBindings,
          limits: briefOutcome.brief.limits,
        },
        graph: graph && {
          revision: graph.revision,
          status: graph.status,
          roles: projectSelectedResearchRolesV1(graph),
          nodes: graph.nodes.map((node) => ({
            id: node.id,
            roleId: node.roleId,
            dependencies: node.dependencies,
            grantedCapabilityIds: node.grantedCapabilityIds,
            budget: node.budget,
          })),
          approvalEnvelope: graph.approvalEnvelope,
        },
      };
      dependencies.writeStderr(
        `[research] session=${session.sessionId} status=${session.status} plan_only=true\n`,
      );
      dependencies.emitOutput(plan, opts);
      return;
    } finally {
      opened.close();
    }
  }
  const approvalRequired = researchPlanApprovalRequiredV1(researchGraph);
  if (approvalRequired) {
    dependencies.writeStderr("[research] stop_reason=plan-approval-required\n");
    dependencies.fail(
      opts,
      2,
      ERROR_CODES.VALIDATION,
      "The resolved research plan requires approval. Review the plan and rerun with --plan-approval automatic.",
      { outcome: approvalRequired },
    );
  }
  const opened = await dependencies.openSessionStore();
  let workspace: ResearchWorkspace | undefined;
  let disposeWorkspace: (() => Promise<void>) | undefined;
  try {
    const now = new Date().toISOString();
    const durableSession = await initializeResearchSessionTurnV1({
      store: opened.store,
      session: createResearchSessionV1({
        sessionId: durableSessionId,
        ownerId: `owner:cli-${process.pid}`,
        createdAt: now,
        leaseExpiresAt: new Date(
          Date.parse(now) + request.limits.maxRunMs,
        ).toISOString(),
      }),
      brief: briefOutcome.brief,
      graph: researchGraph,
      approveAutomatically: true,
      at: now,
    });
    const apiKey = readApiKey(dependencies);
    if (!apiKey) {
      const waitingAt = new Date().toISOString();
      const waiting = await opened.store.commit(durableSession.sessionId, {
        kind: "wait_authentication",
        expectedRevision: durableSession.revision,
        expectedLeaseEpoch: durableSession.lease.epoch,
        at: waitingAt,
      });
      dependencies.writeStderr(
        `[research] session=${waiting.session.sessionId} status=${waiting.session.status} stop_reason=authentication-required\n`,
      );
      throw new Error(
        "ANTHROPIC_API_KEY is missing. Set it in the process environment; it is never read from a CLI flag.",
      );
    }
    if (opened.workspace) {
      workspace = await opened.workspace(durableSession.sessionId);
    } else {
      const temporaryWorkspace = await dependencies.createWorkspace();
      workspace = temporaryWorkspace;
      disposeWorkspace = () => temporaryWorkspace.dispose();
    }
    await runEstablishedResearchCliSession({
      input,
      opts,
      dependencies,
      profile,
      request,
      workspace,
      store: opened.store,
      sessionId: durableSession.sessionId,
      turnId: durableTurnId,
      researchGraph,
      brief: briefOutcome.brief,
      apiKey,
    });
  } finally {
    if (!input.keepSession) await disposeWorkspace?.();
    opened.close();
  }
}

export function chatHelp(): string {
  return `atlcli chat <question>
atlcli chat --session <conversation-id> <follow-up>
atlcli chat sessions <list|show|sources|artifact> [conversation-id]

Ask a bounded, read-only Jira or Confluence question without composing a Deep Research graph.
The first turn uses only explicit --project/--space context or scope named in the question;
profile defaults never widen an ordinary chat to an unrelated product. Follow-up turns restore
the same durable DeepAgentsJS conversation and approved scope.
Quick stays direct; Auto chooses a bounded strategy; Deep may compose focused specialists,
an independent critic, and one synthesizer. Deep is still ordinary Chat, not the separate
up-to-ten-minute Research report workflow. The fixed two-source Deep release gate is 120s
median and 180s worst-of-three; real provider and Atlassian latency can vary.

Options:
  --profile <name>       Auth profile
  --project <key>        Explicit Jira project context (repeatable)
  --space <key>          Explicit Confluence space context (repeatable)
  --session <id>         Continue a retained ordinary chat conversation
  --scope-revision <n>   Resolve a retained ambiguous scope at this exact revision
  --scope-mention <id>   Scope mention ID from the retained Chat review
  --scope-candidate <id> Candidate ID selected from the retained Chat review
  --thinking <mode>      auto|quick|deep (default: auto)
  --language <en|de>     Response language (default: en)
  --max-run-minutes <n>  Turn deadline, 1-10 (default: 10)
  --max-cost-usd <n>     Conservative model-cost ceiling, $0 < n <= $25
  --output <path>        Atomically write the generated Markdown
  --json                 Emit session ID and structured result as JSON
  --help                 Show this help

ANTHROPIC_API_KEY must be supplied through the process environment.
Jira and Confluence access is read-only. Press Ctrl+C to stop the active turn.
While a turn is active, enter text to queue a FIFO follow-up. Use /steer <instruction>
for immediate steering at the next safe checkpoint, /queue to inspect pending input,
/edit <id> <text> or /delete <id> to change it, /stop to cancel, and /help for help.
`;
}

export function researchHelp(): string {
  return `atlcli research <question>
atlcli research --resume <session-id>
atlcli research --session <session-id> <question>
atlcli research sessions <list|show|evidence|plan|scope-clarification|choose-scope|continue-scope-clarification|clarify|approve|reject-plan|revise-plan|approve-scope|reject-scope|pause|steer|resume|cancel|delete>

Run a bounded, read-only Jira + Confluence research question through DeepAgentsJS and QuickJS PTC.

Options:
  --profile <name>       Auth profile (for example mayflower)
  --project <key>        Jira project key (repeatable; profile default otherwise)
  --space <key>          Confluence space key (repeatable; profile default otherwise)
  --from <YYYY-MM-DD>    Inclusive lower date bound
  --to <YYYY-MM-DD>      Inclusive upper date bound
  --as-of <date/time>    Add a fixed date or timezone-qualified timestamp
  --timezone <name>      Add an explicit timezone to the question
  --language <en|de>     Language for model prose and deterministic Markdown copy (default: en)
  --max-run-minutes <n>  Complete workflow deadline, 1-10 (default: 10)
  --max-cost-usd <n>     Immutable conservative Claude ceiling for a new durable session, including resumes, $0 < n <= $25 (default: $2)
  --max-total-model-input-tokens <n>
                         Advanced immutable run-wide input-token ceiling, 1,000-1,000,000 (default: 350,000)
  --effort <mode>         Deep-research planning depth: auto|lookup|analysis|deep (default: auto)
  --plan-approval <mode>  automatic; omitted deep plans stop for review
  --scope-expansion <m>   strict|ask|exact-linked (default: ask)
  --reconciliation <m>    off|auto|required (default: auto)
  --plan-only             Persist and print the sanitized durable research plan; do not run research
  --resume <session-id>   Resume an undispatched wait or one issued durable retrieval continuation
  --session <session-id>  Add a question to a terminal session using its retained scope and policy
  --output <path>        Atomically write the generated Markdown
  --keep-session         Print the retained session workspace path
  --json                 Emit the structured report as JSON
  --help                 Show this help

Environment:
  ATLCLI_RESEARCH_SESSIONS_DIR
                         Override the durable session directory for isolated
                         automation and E2E runs (default: ~/.atlcli/research-sessions)

Durable session commands:
  sessions list [--limit <1-100>] [--cursor <session-id>]
  sessions show <session-id> [--evidence|--claims|--outline|--reconciliation] [--limit <1-100>]
  sessions evidence <session-id> --id <evidence-id> [--include-text]
  sessions plan <session-id>
  sessions clarify <session-id> --revision <session-revision> --brief-revision <brief-revision>
      [--answer <question-id>=<response>] [--assumption <assumption-id>=accepted|rejected]
  sessions approve <session-id> --revision <session-revision> --graph-revision <graph-revision>
  sessions reject-plan <session-id> --revision <session-revision> --graph-revision <graph-revision>
      --instruction <correction>
  sessions revise-plan <session-id> --revision <session-revision> --graph-revision <graph-revision>
      [--instruction <correction>]
  sessions scope-clarification <session-id> [--profile <name>]
  sessions choose-scope <session-id> --revision <session-revision>
      --mention <scope-mention-id> --candidate <scope-candidate-id> [--profile <name>]
  sessions continue-scope-clarification <session-id> --revision <session-revision> [--profile <name>]
  sessions approve-scope <session-id> --revision <session-revision> --brief-revision <brief-revision>
      --graph-revision <graph-revision> --proposal <scope-expansion-id>
  sessions reject-scope <session-id> --revision <session-revision> --brief-revision <brief-revision>
      --graph-revision <graph-revision> --proposal <scope-expansion-id>
  sessions pause <session-id> --revision <session-revision>
  sessions steer <session-id> --revision <session-revision> --graph-revision <graph-revision>
      --instruction <focus-or-priority>
  sessions resume <session-id> --revision <session-revision>
  sessions cancel <session-id> --revision <session-revision>
  sessions delete <session-id> --revision <session-revision>

ANTHROPIC_API_KEY must be supplied through the process environment.
--plan-only persists the brief and graph before any key, workspace, provider, or model access.
An ambiguous natural-language project or space is stored as a tenant-bound, catalog-only
scope-clarification wait before key, workspace, provider, or model access. Inspect it with
the sessions scope-clarification command, then choose its exact revision-fenced candidate; the CLI
freshly rechecks only that candidate against the retained request before it can create a brief.
The sessions pause command records a cooperative pause request and acknowledges it only at a durable
no-in-flight-task checkpoint. The sessions steer command accepts a bounded focus/prioritization request
only from that persisted checkpoint; it cannot add scope, tools, roles, or budget. Then run
\`atlcli research --resume <session-id>\` to let the existing supervisor continuation apply the graph diff.
The sessions resume command makes an acknowledged undispatched pause runnable again,
then releases its lease; it does not start provider/model work—use research --resume to dispatch.
--resume preserves the accepted brief, graph, scope, limits, accepted packets, and durable retrieval budget. Model-spend limits apply to each dispatched agent run. It resumes only an undispatched wait or one host-issued retrieval continuation; a pending steering request is applied only through that continuation.
--session preserves the terminal session's scope, policy, and deadline; it does not silently expand scope.
Approving a durable plan persists its exact graph revision only; it starts no model research until durable task dispatch arrives.
Rejecting a plan records the exact correction, materializes a new immutable brief and graph revision, and stops again for explicit approval.
Session inspection views expose bounded durable metadata only. Source text is returned only by the separate
\`sessions evidence <session-id> --id <evidence-id> --include-text\` command.
`;
}
