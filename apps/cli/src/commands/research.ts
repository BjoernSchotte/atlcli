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
  DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1,
  DEFAULT_RESEARCH_LIMITS_V1,
  FileSystemResearchWorkspace,
  RESEARCH_MODEL_ID,
  RESEARCH_ONE_SHOT_POLICY_SCHEMA_V1,
  RESEARCH_REQUESTED_EFFORTS_V1,
  RESEARCH_REQUESTED_RECONCILIATIONS_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  RESEARCH_SCOPE_EXPANSION_MODES_V1,
  ResearchScopeCatalogBroker,
  ResearchRunBudget,
  createResearchSessionV1,
  createResearchKeyScopeSeedV1,
  createRestResearchProviders,
  createRestScopeCatalogProviders,
  formatResearchOneShotEventV1,
  normalizeResearchOneShotPolicyV1,
  normalizeResearchRequestV1,
  prepareResearchBriefPreflightV1,
  prepareResearchScopePreflightV1,
  runResearchAgent,
  type ResearchBriefPreflightOutcomeV1,
  type ResearchBriefV1,
  type ResearchOneShotPolicyV1,
  type ResearchRequestV1,
  type ResearchOneShotEventV1,
  type ResearchReportV1,
  type ResearchScopePreflightOutcomeV1,
  type ResearchScopeSeedV1,
  type ResearchSessionTurnV1,
  type ResearchSessionStoreV1,
  type ResearchSessionV1,
  type ResearchWorkspace,
  initializeResearchSessionTurnV1,
} from "@atlcli/research/node";
import { SqliteResearchSessionStoreV1 } from "@atlcli/research/bun";
import {
  composeResearchGraphV1,
  createStandardResearchBriefV1,
  projectSelectedResearchRolesV1,
  researchPlanApprovalRequiredV1,
  type ResearchGraphV1,
} from "@atlcli/research/graph";

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
  planOnly: boolean;
  policy: ResearchOneShotPolicyV1;
}

const DEFAULT_MAX_RUN_MINUTES = 10;
const MAX_MAX_RUN_MINUTES = 10;
const T2_RESEARCH_FLAGS = new Set([
  "profile",
  "project",
  "space",
  "from",
  "to",
  "as-of",
  "timezone",
  "max-run-minutes",
  "output",
  "effort",
  "plan-approval",
  "scope-expansion",
  "reconciliation",
  "keep-session",
  "plan-only",
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
  "max-run-minutes",
  "output",
  "effort",
  "plan-approval",
  "scope-expansion",
  "reconciliation",
] as const;
const T2_SINGLE_VALUE_FLAGS = T2_VALUE_FLAGS.filter(
  (key) => key !== "project" && key !== "space",
);
const T2_BOOLEAN_FLAGS = ["keep-session", "plan-only", "json", "no-log", "help", "h"] as const;
const RESEARCH_SESSION_ID_PATTERN = /^research-session:[A-Za-z0-9._-]{1,120}$/;

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

export interface ResearchCliDependencies {
  resolveProfile(name?: string): Promise<Profile | undefined>;
  resolveScope(input: {
    profile: Profile;
    request: ResearchRequestV1;
  }): Promise<ResearchScopePreflightOutcomeV1>;
  prepareBrief(input: {
    request: ResearchRequestV1;
    policy: ResearchOneShotPolicyV1;
    asOf: string;
    timezone?: string;
    sessionId?: string;
    turnId?: string;
  }): ResearchBriefPreflightOutcomeV1;
  readApiKey(): string | undefined;
  createWorkspace(): Promise<ResearchCliWorkspace>;
  runAgent(input: ResearchCliAgentInput): Promise<ResearchReportV1>;
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
}

export function researchArtifactPath(now = new Date()): string {
  const timestamp = now.toISOString().replace(/[T:.Z]/g, "-").replace(/-+$/, "");
  return join(homedir(), "Documents", "atlcli", "artefacts", `research-${timestamp}`, "report.md");
}

function uniqueKeys(values: string[], uppercase = true): string[] {
  return [...new Set(
    values
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => uppercase ? value.toUpperCase() : value),
  )];
}

function normalizeAsOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value) {
      return value;
    }
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }
  throw new Error("--as-of must use YYYY-MM-DD or an ISO 8601 timestamp with timezone.");
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
  const unsupported = [
    "session",
    "resume",
  ].filter((key) => hasFlag(flags, key));
  if (unsupported.length > 0) {
    throw new Error(`The following research flags are reserved for durable sessions: ${unsupported.map((key) => `--${key}`).join(", ")}`);
  }
  const secretFlags = ["api-key", "apikey", "anthropic-key", "key"].filter((key) => hasFlag(flags, key));
  if (secretFlags.length > 0) {
    throw new Error("Anthropic API keys are never accepted as command-line flags. Set ANTHROPIC_API_KEY in the process environment.");
  }
  const unknown = Object.keys(flags).filter((key) => !T2_RESEARCH_FLAGS.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown research option${unknown.length === 1 ? "" : "s"}: ${unknown.map((key) => `--${key}`).join(", ")}. Run \`atlcli research --help\`.`);
  }
  for (const key of T2_VALUE_FLAGS) {
    if (!hasFlag(flags, key)) continue;
    const value = flags[key];
    const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
    if (values.length === 0 || values.some((entry) => entry.trim().length === 0)) {
      throw new Error(`--${key} requires a value.`);
    }
  }
  for (const key of T2_SINGLE_VALUE_FLAGS) {
    if (Array.isArray(flags[key])) throw new Error(`--${key} may be specified only once.`);
  }
  for (const key of T2_BOOLEAN_FLAGS) {
    if (flags[key] !== undefined && flags[key] !== true) {
      throw new Error(`--${key} does not accept a value.`);
    }
  }
  const question = args.join(" ").trim();
  if (!question) throw new Error("A research question is required. Example: atlcli research \"Which Jira and Confluence items are related?\"");
  const from = getFlag(flags, "from");
  const to = getFlag(flags, "to");
  const asOf = normalizeAsOf(getFlag(flags, "as-of"));
  const timezone = normalizeTimezone(getFlag(flags, "timezone"));
  const maxRunMinutesFlag = getFlag(flags, "max-run-minutes");
  const maxRunMinutes = maxRunMinutesFlag === undefined
    ? DEFAULT_MAX_RUN_MINUTES
    : Number(maxRunMinutesFlag);
  if (!Number.isSafeInteger(maxRunMinutes) || maxRunMinutes < 1 || maxRunMinutes > MAX_MAX_RUN_MINUTES) {
    throw new Error(`--max-run-minutes must be an integer between 1 and ${MAX_MAX_RUN_MINUTES}.`);
  }
  const requestedPlanApproval = getFlag(flags, "plan-approval") ??
    DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1.requestedPlanApproval;
  if (requestedPlanApproval !== "default" && requestedPlanApproval !== "automatic") {
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
    question: [question, asOf ? `As-of date: ${asOf}.` : "", timezone ? `Timezone: ${timezone}.` : ""].filter(Boolean).join("\n\n"),
    profile: getFlag(flags, "profile"),
    projectKeys: uniqueKeys(getFlags(flags, "project")),
    spaceKeys: uniqueKeys(getFlags(flags, "space"), false),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(asOf ? { asOf } : {}),
    ...(timezone ? { timezone } : {}),
    ...(getFlag(flags, "output") ? { outputPath: getFlag(flags, "output") } : {}),
    maxRunMinutes,
    keepSession: hasFlag(flags, "keep-session"),
    planOnly: hasFlag(flags, "plan-only"),
    policy,
  };
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
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${key} requires a value.`);
  return value.trim();
}

function assertSessionFlags(
  flags: Record<string, string | boolean | string[]>,
  allowed: readonly string[],
): void {
  const permitted = new Set([...allowed, "json", "no-log", "help", "h"]);
  const unknown = Object.keys(flags).filter((key) => !permitted.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown research session option${unknown.length === 1 ? "" : "s"}: ${unknown.map((key) => `--${key}`).join(", ")}.`);
  }
  for (const key of ["json", "no-log", "help", "h"]) {
    if (flags[key] !== undefined && flags[key] !== true) throw new Error(`--${key} does not accept a value.`);
  }
  for (const key of allowed) {
    if (flags[key] !== undefined && (typeof flags[key] !== "string" || Array.isArray(flags[key]) || !flags[key])) {
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
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("--revision must be a positive integer.");
  return parsed;
}

function activeSessionTurn(session: ResearchSessionV1): ResearchSessionTurnV1 | undefined {
  return session.turns.find((turn) => turn.id === session.activeTurnId) ?? session.turns.at(-1);
}

function projectSessionGraph(graph: ResearchGraphV1 | undefined): Record<string, unknown> | undefined {
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
function projectResearchSessionV1(session: ResearchSessionV1): Record<string, unknown> {
  const turn = activeSessionTurn(session);
  const taskStatusCounts: Record<string, number> = {};
  for (const task of turn?.tasks ?? []) taskStatusCounts[task.status] = (taskStatusCounts[task.status] ?? 0) + 1;
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
        clarificationQuestionIds: turn.brief.clarificationQuestions.map((question) => question.id),
        unresolvedAssumptionIds: turn.brief.assumptions
          .filter((assumption) => assumption.requiresUserDecision && !turn.assumptionDecisions.some((decision) => decision.assumptionId === assumption.id))
          .map((assumption) => assumption.id),
      },
      graph: projectSessionGraph(turn.graph),
      scope: {
        candidateCount: turn.scopeCandidates.length,
        bindingCount: turn.scopeBindings.length,
        resolutionCount: turn.scopeResolutions.length,
        pendingExpansionProposalIds: turn.scopeExpansionProposals
          .filter((proposal) => proposal.status === "proposed")
          .map((proposal) => proposal.id),
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

function projectResearchSessionPlanV1(session: ResearchSessionV1): Record<string, unknown> {
  return {
    ...projectResearchSessionV1(session),
    kind: "plan",
    planMutable: session.status === "waiting_plan_approval",
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
    if (args.length !== 1) throw new Error("Usage: atlcli research sessions list [--limit <1-100>] [--cursor <session-id>].");
    assertSessionFlags(flags, ["limit", "cursor"]);
    const limit = boundedSessionLimit(singleSessionFlag(flags, "limit"));
    const cursor = singleSessionFlag(flags, "cursor");
    if (cursor !== undefined) requireSessionId(cursor);
    const opened = await dependencies.openSessionStore();
    try {
      const page = await opened.store.list({ ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) });
      dependencies.emitOutput({
        schema: "atlcli.research-session-list/v1",
        sessions: page.sessions.map(projectResearchSessionV1),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      }, opts);
    } finally {
      opened.close();
    }
    return;
  }
  if (command !== "show" && command !== "plan" && command !== "approve" && command !== "reject-plan") {
    throw new Error(`Unknown research sessions command: ${command}. Run \`atlcli research --help\`.`);
  }
  const sessionId = requireSessionId(sessionArg);
  if (command === "show" || command === "plan") {
    if (args.length !== 2) throw new Error(`Usage: atlcli research sessions ${command} <session-id>.`);
    assertSessionFlags(flags, []);
    const opened = await dependencies.openSessionStore();
    try {
      const session = await requireStoredResearchSession(opened.store, sessionId);
      dependencies.emitOutput(command === "plan" ? projectResearchSessionPlanV1(session) : projectResearchSessionV1(session), opts);
    } finally {
      opened.close();
    }
    return;
  }
  if (command === "approve" || command === "reject-plan") {
    if (args.length !== 2) throw new Error(`Usage: atlcli research sessions ${command} <session-id> --revision <session-revision>${command === "reject-plan" ? " --reason <reason>" : ""}.`);
    assertSessionFlags(flags, command === "approve" ? ["revision"] : ["revision", "reason"]);
    const revision = expectedSessionRevision(singleSessionFlag(flags, "revision", true));
    const reason = command === "reject-plan" ? singleSessionFlag(flags, "reason", true) : undefined;
    const opened = await dependencies.openSessionStore();
    try {
      const session = await requireStoredResearchSession(opened.store, sessionId);
      if (session.revision !== revision) throw new Error("Research session revision is stale; inspect the current plan and retry with its exact revision.");
      const graph = activeSessionTurn(session)?.graph;
      if (!graph) throw new Error("Research session has no active graph to decide.");
      const committed = await opened.store.commit(sessionId, command === "approve"
        ? {
            kind: "approve_graph",
            graphRevision: graph.revision,
            expectedRevision: session.revision,
            expectedLeaseEpoch: session.lease.epoch,
            at: new Date().toISOString(),
          }
        : {
            kind: "reject_plan",
            graphRevision: graph.revision,
            reason: reason!,
            expectedRevision: session.revision,
            expectedLeaseEpoch: session.lease.epoch,
            at: new Date().toISOString(),
          });
      dependencies.writeStderr(`[research] session=${sessionId} action=${command} revision=${committed.session.revision} status=${committed.session.status}\n`);
      dependencies.emitOutput(projectResearchSessionPlanV1(committed.session), opts);
    } finally {
      opened.close();
    }
    return;
  }
}

export function buildResearchRequest(input: ResearchCliInput, profile: Profile): ResearchRequestV1 {
  const defaults = resolveDefaults({ profiles: {}, currentProfile: undefined }, profile);
  const projectKeys = input.projectKeys.length > 0 ? input.projectKeys : uniqueKeys(defaults.project ? [defaults.project] : []);
  const spaceKeys = input.spaceKeys.length > 0 ? input.spaceKeys : uniqueKeys(defaults.space ? [defaults.space] : [], false);
  const siteOrigin = new URL(profile.baseUrl).origin;
  const scopeSeeds: ResearchScopeSeedV1[] = [
    ...projectKeys.map((key) => createResearchKeyScopeSeedV1({
      tenantOrigin: siteOrigin,
      product: "jira",
      key,
      source: input.projectKeys.length > 0 ? "cli_flag" : "profile_default",
      authority: input.projectKeys.length > 0 ? "locked" : "approved",
    })),
    ...spaceKeys.map((key) => createResearchKeyScopeSeedV1({
      tenantOrigin: siteOrigin,
      product: "confluence",
      key,
      source: input.spaceKeys.length > 0 ? "cli_flag" : "profile_default",
      authority: input.spaceKeys.length > 0 ? "locked" : "approved",
    })),
  ];
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
    scopeSeeds,
    limits: {
      ...DEFAULT_RESEARCH_LIMITS_V1,
      pageSize: 10,
      // Acquisition uses at most four Jira searches. Keep one page per
      // product available for a host-authorized reconciliation repair, in
      // parity with the browser/default V1 budget.
      maxSearchPagesPerProduct: 5,
      maxItemsPerProduct: 30,
      maxDetailItemsPerProduct: 8,
      // Research claims may only cite complete detail projections. Keep the
      // contract maximum so ordinary long-form Confluence pages are not
      // silently reduced to excerpts before synthesis.
      maxBodyCharsPerItem: 50_000,
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

export async function writeResearchMarkdownAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function readApiKey(dependencies: ResearchCliDependencies): string | undefined {
  const key = dependencies.readApiKey()?.trim();
  return key || undefined;
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
    });
  },
  prepareBrief(input) {
    return prepareResearchBriefPreflightV1(createStandardResearchBriefV1(input.request.question, {
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      scope: input.request.scope,
      scopeBindings: input.request.scopeSeeds?.map((seed) => seed.binding),
      limits: input.request.limits,
      asOf: input.asOf,
      timezone: input.timezone,
      policy: input.policy,
    }));
  },
  readApiKey: () => process.env.ANTHROPIC_API_KEY,
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
  writeAtomic: writeResearchMarkdownAtomic,
  artifactPath: () => researchArtifactPath(),
  createDurableSessionId: () => `research-session:${randomUUID()}`,
  createDurableTurnId: () => `research-turn:${randomUUID()}`,
  async openSessionStore() {
    const root = join(homedir(), ".atlcli", "research-sessions");
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
  cancelScheduledAbort: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  listenForInterrupt(callback) {
    process.once("SIGINT", callback);
    return () => process.removeListener("SIGINT", callback);
  },
};

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
  const profile = await dependencies.resolveProfile(input.profile);
  if (!profile) {
    dependencies.fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login` or select --profile.", { profile: input.profile });
  }
  const initialRequest = buildResearchRequest(input, profile);
  const scopeOutcome = await dependencies.resolveScope({
    profile,
    request: initialRequest,
  });
  if (scopeOutcome.kind === "clarification_required") {
    const clarification = scopeOutcome.clarification;
    dependencies.writeStderr(
      `[research] stop_reason=clarification-required reason=${clarification.reason} mention=${clarification.mentionId} candidates=${clarification.candidateIds.length}\n`,
    );
    dependencies.fail(
      opts,
      2,
      ERROR_CODES.VALIDATION,
      `Research scope requires clarification. ${clarification.rerunGuidance.join(" ")}`,
      { outcome: scopeOutcome },
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
    dependencies.writeStderr(
      `[research] stop_reason=clarification-required brief_revision=${clarification.briefRevision} questions=${clarification.questions.length} assumptions=${clarification.assumptionsRequiringDecision.length}\n`,
    );
    dependencies.fail(
      opts,
      2,
      ERROR_CODES.VALIDATION,
      "Research brief requires clarification. Clarify the required question or decision assumption and rerun the one-shot command.",
      { outcome: briefOutcome },
    );
  }
  const researchGraph = composeResearchGraphV1(briefOutcome.brief);
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
      const session = await initializeResearchSessionTurnV1({
        store: opened.store,
        session: createResearchSessionV1({
          sessionId: durableSessionId!,
          ownerId: `owner:cli-${process.pid}`,
          createdAt: now,
          leaseExpiresAt: new Date(Date.parse(now) + request.limits.maxRunMs).toISOString(),
        }),
        brief: briefOutcome.brief,
        graph: researchGraph,
        approveAutomatically: briefOutcome.brief.resolvedPlanApproval === "automatic",
        at: now,
      });
      const graph = session.turns.find((turn) => turn.id === durableTurnId)?.graph;
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
      dependencies.writeStderr(`[research] session=${session.sessionId} status=${session.status} plan_only=true\n`);
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
  let timeout: unknown;
  let removeInterruptListener: (() => void) | undefined;
  try {
    const now = new Date().toISOString();
    const durableSession = await initializeResearchSessionTurnV1({
      store: opened.store,
      session: createResearchSessionV1({
        sessionId: durableSessionId,
        ownerId: `owner:cli-${process.pid}`,
        createdAt: now,
        leaseExpiresAt: new Date(Date.parse(now) + request.limits.maxRunMs).toISOString(),
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
      throw new Error("ANTHROPIC_API_KEY is missing. Set it in the process environment; it is never read from a CLI flag.");
    }
    if (opened.workspace) {
      workspace = await opened.workspace(durableSession.sessionId);
    } else {
      const temporaryWorkspace = await dependencies.createWorkspace();
      workspace = temporaryWorkspace;
      disposeWorkspace = () => temporaryWorkspace.dispose();
    }
    const sessionId = durableSession.sessionId;
    const controller = new AbortController();
    timeout = dependencies.scheduleAbort(
      () => controller.abort(new Error("Research run timed out.")),
      request.limits.maxRunMs,
    );
    const onInterrupt = (): void => controller.abort(new Error("Research run cancelled."));
    removeInterruptListener = dependencies.listenForInterrupt(onInterrupt);
    dependencies.writeStderr(`[research] model=${RESEARCH_MODEL_ID} profile=${profile.name} project=${request.scope.jiraProjectKeys.join(",")} space=${request.scope.confluenceSpaceKeys.join(",")}\n`);
    if (input.keepSession) {
      const root = "root" in workspace && typeof workspace.root === "string"
        ? workspace.root
        : "host-owned";
      dependencies.writeStderr(`[research] session=${sessionId} workspace=${root}\n`);
    }
    const report = await dependencies.runAgent({
      apiKey,
      profile,
      request,
      workspace,
      sessionId,
      durableSession: {
        store: opened.store,
        sessionId,
        turnId: durableTurnId,
      },
      researchGraph,
      brief: briefOutcome.brief,
      signal: controller.signal,
      writeDiagnostic: (message) => dependencies.writeStderr(`[research] ${message}\n`),
      onEvent: (event) => {
        if (event.kind === "phase") {
          dependencies.writeStderr(`[research] phase=${event.phase}\n`);
        } else if (event.kind === "progress") {
          dependencies.writeStderr(`[research] calls=${event.completed}/${event.maximum}\n`);
        } else if (event.kind === "brief") {
          dependencies.writeStderr(`[research] brief_revision=${event.revision}\n`);
        } else if (event.kind === "plan") {
          dependencies.writeStderr(
            `[research] graph_revision=${event.revision} graph_status=${event.status} effort=${event.resolvedEffort} nodes=${event.nodeCount} waves=${event.waveCount} max_parallel=${event.maxParallelNodes} roles=${event.selectedRoleIds.join(",") || "none"}\n`,
          );
        } else if (event.kind === "capability") {
          dependencies.writeStderr(
            `[research] tool=${event.toolId} call=${event.callId} kind=${event.inputKind} status=${event.status}${event.inputKeys === undefined ? "" : ` input_keys=${event.inputKeys.join(",") || "none"}`}${event.queryKeys === undefined ? "" : ` query_keys=${event.queryKeys.join(",") || "none"}`}${event.itemCount === undefined ? "" : ` items=${event.itemCount}`}${event.complete === undefined ? "" : ` complete=${event.complete}`}${event.termination === undefined ? "" : ` termination=${event.termination}`}${event.resultBytes === undefined ? "" : ` result_bytes=${event.resultBytes}`}${event.truncated === undefined ? "" : ` truncated=${event.truncated}`}${event.durationMs === undefined ? "" : ` duration_ms=${event.durationMs}`}${event.errorCode === undefined ? "" : ` error=${event.errorCode}`}\n`,
          );
        } else if (event.kind === "subagent") {
          dependencies.writeStderr(
            `[research] subagent=${event.roleId} task=${event.taskId} status=${event.status}${event.attempt === undefined ? "" : ` attempt=${event.attempt}`}${event.durationMs === undefined ? "" : ` duration_ms=${event.durationMs}`}${event.errorCode === undefined ? "" : ` error=${event.errorCode}`}\n`,
          );
        } else if (event.kind === "task") {
          dependencies.writeStderr(
            `[research] task=${event.taskId} status=${event.status}${event.roleId === undefined ? "" : ` role=${event.roleId}`}${event.wave === undefined ? "" : ` wave=${event.wave}`}${event.dependencyTaskIds === undefined ? "" : ` dependencies=${event.dependencyTaskIds.length}`}${event.grantedCapabilityIds === undefined ? "" : ` grants=${event.grantedCapabilityIds.join(",") || "none"}`}${event.sourceCount === undefined ? "" : ` sources=${event.sourceCount}`}${event.findingCount === undefined ? "" : ` findings=${event.findingCount}`}${event.relationshipCount === undefined ? "" : ` relationships=${event.relationshipCount}`}${event.gapCount === undefined ? "" : ` gaps=${event.gapCount}`}${event.defectCount === undefined ? "" : ` defects=${event.defectCount}`}${event.inputTokens === undefined ? "" : ` input_tokens=${event.inputTokens}`}${event.outputTokens === undefined ? "" : ` output_tokens=${event.outputTokens}`}${event.resultBytes === undefined ? "" : ` result_bytes=${event.resultBytes}`}\n`,
          );
        } else if (event.kind === "decision") {
          dependencies.writeStderr(
            `[research] decision=${event.decisionId} status=${event.status} reason=${event.reasonCode}${event.taskId === undefined ? "" : ` task=${event.taskId}`}${event.codeBytes === undefined ? "" : ` code_bytes=${event.codeBytes}`}${event.codeHash === undefined ? "" : ` code_hash=${event.codeHash}`}${event.errorCode === undefined ? "" : ` error=${event.errorCode}`}\n`,
          );
        } else if (event.kind === "reconciliation") {
          dependencies.writeStderr(
            `[research] reconciliation=${event.taskId} status=${event.status}${event.defectCount === undefined ? "" : ` defects=${event.defectCount}`}${event.proposedFollowUpCount === undefined ? "" : ` follow_ups=${event.proposedFollowUpCount}`}\n`,
          );
        } else if (event.kind === "budget") {
          dependencies.writeStderr(
            `[research] budget=${event.metric} consumed=${event.consumed} maximum=${event.maximum}\n`,
          );
        } else if (event.kind === "artifact") {
          dependencies.writeStderr(`[research] workspace_artifact=${event.path}\n`);
        } else {
          dependencies.writeStderr(`[research] trace=${formatResearchOneShotEventV1(event)}\n`);
        }
      },
    });
    const artifactPath = dependencies.artifactPath();
    try {
      await dependencies.writeAtomic(artifactPath, report.markdown);
      dependencies.writeStderr(`[research] artifact=${artifactPath}\n`);
    } catch (error) {
      dependencies.writeStderr(`[research] artifact=unavailable reason=${error instanceof Error ? error.name : "unknown"}\n`);
    }
    if (input.outputPath) await dependencies.writeAtomic(input.outputPath, report.markdown);
    if (opts.json) dependencies.emitOutput({ sessionId, artifactPath, report }, opts);
    else dependencies.writeStdout(report.markdown);
  } finally {
    if (timeout !== undefined) dependencies.cancelScheduledAbort(timeout);
    removeInterruptListener?.();
    if (!input.keepSession) await disposeWorkspace?.();
    opened.close();
  }
}

export function researchHelp(): string {
  return `atlcli research <question>
atlcli research sessions <list|show|plan|approve|reject-plan>

Run a bounded, read-only Jira + Confluence research question through DeepAgentsJS and QuickJS PTC.

Options:
  --profile <name>       Auth profile (for example mayflower)
  --project <key>        Jira project key (repeatable; profile default otherwise)
  --space <key>          Confluence space key (repeatable; profile default otherwise)
  --from <YYYY-MM-DD>    Inclusive lower date bound
  --to <YYYY-MM-DD>      Inclusive upper date bound
  --as-of <date/time>    Add a fixed date or timezone-qualified timestamp
  --timezone <name>      Add an explicit timezone to the question
  --max-run-minutes <n>  Complete workflow deadline, 1-10 (default: 10)
  --effort <mode>         auto|lookup|analysis|deep (default: auto)
  --plan-approval <mode>  automatic; omitted deep plans stop for review
  --scope-expansion <m>   strict|ask|exact-linked (default: ask)
  --reconciliation <m>    off|auto|required (default: auto)
  --plan-only             Persist and print the sanitized durable research plan; do not run research
  --output <path>        Atomically write the generated Markdown
  --keep-session         Print the retained session workspace path
  --json                 Emit the structured report as JSON
  --help                 Show this help

Durable session commands:
  sessions list [--limit <1-100>] [--cursor <session-id>]
  sessions show <session-id>
  sessions plan <session-id>
  sessions approve <session-id> --revision <session-revision>
  sessions reject-plan <session-id> --revision <session-revision> --reason <reason>

ANTHROPIC_API_KEY must be supplied through the process environment.
--plan-only persists the brief and graph before any key, workspace, provider, or model access.
Session resume, steering, scope, and clarification commands arrive in later T4 checkpoints.
Approving a durable plan persists its exact revision only; it starts no model research until durable task dispatch arrives.
`;
}
