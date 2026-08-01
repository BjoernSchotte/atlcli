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
  createResearchKeyScopeSeedV1,
  createRestResearchProviders,
  createRestScopeCatalogProviders,
  formatResearchOneShotEventV1,
  normalizeResearchOneShotPolicyV1,
  normalizeResearchRequestV1,
  prepareResearchScopePreflightV1,
  runResearchAgent,
  type ResearchOneShotPolicyV1,
  type ResearchRequestV1,
  type ResearchOneShotEventV1,
  type ResearchReportV1,
  type ResearchScopePreflightOutcomeV1,
  type ResearchScopeSeedV1,
  type ResearchWorkspace,
} from "@atlcli/research/node";
import {
  composeStandardResearchGraphV1,
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
const T2_BOOLEAN_FLAGS = ["keep-session", "json", "no-log", "help", "h"] as const;

export interface ResearchCliWorkspace extends ResearchWorkspace {
  readonly root: string;
  dispose(): Promise<void>;
}

export interface ResearchCliAgentInput {
  apiKey: string;
  profile: Profile;
  request: ResearchRequestV1;
  workspace: ResearchCliWorkspace;
  sessionId: string;
  researchGraph: ResearchGraphV1;
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
  readApiKey(): string | undefined;
  createWorkspace(): Promise<ResearchCliWorkspace>;
  runAgent(input: ResearchCliAgentInput): Promise<ResearchReportV1>;
  writeAtomic(path: string, contents: string): Promise<void>;
  artifactPath(): string;
  createSessionId(): string;
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
    "plan-only",
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
    policy,
  };
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
      maxSearchPagesPerProduct: 4,
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

function assertApiKey(dependencies: ResearchCliDependencies): string {
  const key = dependencies.readApiKey()?.trim();
  if (!key) throw new Error("ANTHROPIC_API_KEY is missing. Set it in the process environment; it is never read from a CLI flag.");
  return key;
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
      runId: input.sessionId,
      researchGraph: input.researchGraph,
      workspace: input.workspace,
      options: {
        signal: input.signal,
        onEvent: input.onEvent,
      },
    });
  },
  writeAtomic: writeResearchMarkdownAtomic,
  artifactPath: () => researchArtifactPath(),
  createSessionId: () => `research-${randomUUID()}`,
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
  const researchGraph = composeStandardResearchGraphV1(request.question, {
    scope: request.scope,
    scopeBindings: request.scopeSeeds?.map((seed) => seed.binding),
    limits: request.limits,
    asOf: new Date().toISOString(),
    timezone: input.timezone,
    policy: input.policy,
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
  const apiKey = assertApiKey(dependencies);
  const workspace = await dependencies.createWorkspace();
  const sessionId = dependencies.createSessionId();
  const controller = new AbortController();
  const timeout = dependencies.scheduleAbort(
    () => controller.abort(new Error("Research run timed out.")),
    request.limits.maxRunMs,
  );
  const onInterrupt = (): void => controller.abort(new Error("Research run cancelled."));
  const removeInterruptListener = dependencies.listenForInterrupt(onInterrupt);
  try {
    dependencies.writeStderr(`[research] model=${RESEARCH_MODEL_ID} profile=${profile.name} project=${request.scope.jiraProjectKeys.join(",")} space=${request.scope.confluenceSpaceKeys.join(",")}\n`);
    if (input.keepSession) {
      dependencies.writeStderr(`[research] session=${sessionId} workspace=${workspace.root}\n`);
    }
    const report = await dependencies.runAgent({
      apiKey,
      profile,
      request,
      workspace,
      sessionId,
      researchGraph,
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
    dependencies.cancelScheduledAbort(timeout);
    removeInterruptListener();
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
  --as-of <date/time>    Add a fixed date or timezone-qualified timestamp
  --timezone <name>      Add an explicit timezone to the question
  --max-run-minutes <n>  Complete workflow deadline, 1-10 (default: 10)
  --effort <mode>         auto|lookup|analysis|deep (default: auto)
  --plan-approval <mode>  automatic; omitted deep plans stop for review
  --scope-expansion <m>   strict|ask|exact-linked (default: ask)
  --reconciliation <m>    off|auto|required (default: auto)
  --output <path>        Atomically write the generated Markdown
  --keep-session         Retain the temporary session workspace
  --json                 Emit the structured report as JSON
  --help                 Show this help

ANTHROPIC_API_KEY must be supplied through the process environment.
Required plan approval and durable session flags such as --resume arrive in T4.
`;
}
