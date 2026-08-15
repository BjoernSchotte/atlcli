import {
  StateBackend,
  createDeepAgent,
  createSubAgentMiddleware,
  createSummarizationMiddleware,
  registerHarnessProfile,
} from "deepagents/node";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  type ResearchOneShotEventV1,
  type ResearchRequestV1,
} from "../../contracts.js";
import type { ResearchDispatchDiagnosticV1 } from "../../dispatch-adapter.js";
import type { ResearchModelCallObservationV1 } from "../../model-budget-middleware.js";
import {
  chatQualityPolicyV1,
  type ChatQualityModeV1,
} from "../../quality-policy.js";
import {
  createResearchEntityScopeSeedV1,
  createResearchKeyScopeSeedV1,
} from "../../scope-discovery.js";
import { createMemoryResearchWorkspace } from "../../workspace.js";
import type {
  ChatAcceptedAnswerProjectionV1,
  ChatAnswerV1,
  ChatTurnRequestV1,
} from "../contracts.js";
import {
  CHAT_EVALUATION_SCHEMA_V1,
  chatEvaluationScenarioFingerprintV1,
  type ChatEvaluationGapV1,
  type ChatEvaluationObservationV1,
  type ChatEvaluationScenarioV1,
  type ChatReleaseEvaluationVariantV1,
} from "../evaluation.js";
import { ChatUserQuestionRequiredError } from "../interaction.js";
import { createKiteweaveChatAgent } from "../runtime.js";
import { chatRuntimeFixtureV1, type ChatRuntimeFixtureV1 } from "./runtime-fixtures.js";
import { createChatRuntimeModelBindingV1 } from "./runtime-models.js";
import { createChatRuntimeProvidersV1 } from "./runtime-providers.js";

const runtime = createKiteweaveChatAgent({
  StateBackend,
  createDeepAgent,
  createSubAgentMiddleware,
  createSummarizationMiddleware,
  registerHarnessProfile,
});

function errorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(" <- ");
}

function sourceId(sourceRef: string): string {
  const separator = sourceRef.indexOf("#");
  return separator === -1 ? sourceRef : sourceRef.slice(0, separator);
}

function providerPreference(mode: ChatQualityModeV1): "fast" | "balanced" | "thorough" {
  return mode === "quick" ? "fast" : mode === "deep" ? "thorough" : "balanced";
}

function gapKind(fixture: ChatRuntimeFixtureV1, code: string, message: string): ChatEvaluationGapV1 | undefined {
  const gap = fixture.gaps.find((candidate) =>
    candidate.answer.code === code && candidate.answer.message === message
  );
  return gap ? { id: gap.id, kind: gap.kind } : undefined;
}

function scopeSeeds(scenario: ChatEvaluationScenarioV1) {
  const exact = scenario.scope.exactAnchorSourceIds.map((id) => {
    const source = scenario.sources.find((candidate) => candidate.id === id)!;
    const key = id.slice(id.indexOf(":") + 1);
    return createResearchEntityScopeSeedV1({
      tenantOrigin: scenario.tenantOrigin,
      product: source.product,
      entityKind: source.product === "jira" ? "issue" : "page",
      key,
      name: `Fixture ${key}`,
      source: "current_context",
      authority: "locked",
    });
  });
  return [
    ...exact,
    ...scenario.scope.jiraProjectKeys.map((key) => createResearchKeyScopeSeedV1({
      tenantOrigin: scenario.tenantOrigin,
      product: "jira",
      key,
      source: "cli_flag",
      authority: "approved",
    })),
    ...scenario.scope.confluenceSpaceKeys.map((key) => createResearchKeyScopeSeedV1({
      tenantOrigin: scenario.tenantOrigin,
      product: "confluence",
      key,
      source: "cli_flag",
      authority: "approved",
    })),
  ];
}

function requests(scenario: ChatEvaluationScenarioV1, mode: ChatQualityModeV1): {
  turn: ChatTurnRequestV1;
  brokerRequest: ResearchRequestV1;
} {
  const scope = {
    siteOrigin: scenario.tenantOrigin,
    jiraProjectKeys: [...scenario.scope.jiraProjectKeys],
    confluenceSpaceKeys: [...scenario.scope.confluenceSpaceKeys],
  };
  const limits = {
    ...DEFAULT_RESEARCH_LIMITS_V1,
    maxRunMs: scenario.budget.maxDurationMs,
    maxModelCalls: Math.max(DEFAULT_RESEARCH_LIMITS_V1.maxModelCalls, scenario.budget.maxModelCalls),
    maxTotalModelInputTokens: 1_000_000,
    maxTotalModelOutputTokens: 128_000,
    maxModelCostMicros: 100_000_000,
  };
  const exactContextProducts = [...new Set(
    scenario.scope.exactAnchorSourceIds.map((id) =>
      scenario.sources.find((source) => source.id === id)!.product
    ).filter((product) => product === "jira"
      ? scenario.scope.jiraProjectKeys.length === 0
      : scenario.scope.confluenceSpaceKeys.length === 0),
  )];
  return {
    turn: {
      schema: "atlcli.chat-turn-request/v1",
      conversationId: `chat-conversation:rc-${scenario.id.slice("chat-gold:".length)}-${mode}`,
      turnId: `chat-turn:rc-${scenario.id.slice("chat-gold:".length)}-${mode}`,
      question: scenario.question,
      scope,
      limits,
      wikiProvider: "rest",
    },
    brokerRequest: {
      schema: "atlcli.research-request/v1",
      question: scenario.question,
      scope,
      limits,
      wikiProvider: "rest",
      scopeSeeds: scopeSeeds(scenario),
      ...(exactContextProducts.length > 0 ? { exactContextProducts } : {}),
    },
  };
}

function observedTokens(observations: readonly ResearchModelCallObservationV1[]): {
  input: number;
  output: number;
  peakInput: number;
} {
  const inputs = observations.map((observation) => {
    const usage = observation.observedUsage;
    return usage
      ? usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens
      : 0;
  });
  return {
    input: inputs.reduce((sum, value) => sum + value, 0),
    output: observations.reduce((sum, observation) =>
      sum + (observation.observedUsage?.outputTokens ?? 0), 0),
    peakInput: Math.max(0, ...inputs),
  };
}

/**
 * Execute one customer-free gold case through the production Chat root and
 * project only body-free facts that the runtime actually admitted.
 */
export async function runChatRuntimeObservationV1(input: {
  scenario: ChatEvaluationScenarioV1;
  mode: ChatQualityModeV1;
  variant?: "quick" | "auto" | "deep";
  defectiveAnswer?: boolean;
}): Promise<ChatEvaluationObservationV1> {
  const fixture = chatRuntimeFixtureV1(input.scenario.id);
  if (input.defectiveAnswer) {
    const admittedSourceRef = fixture.blocks
      .flatMap((block) => block.sourceRefs)
      .at(0);
    if (!admittedSourceRef) {
      throw new Error("The defective-answer fixture requires one admitted source.");
    }
    fixture.blocks = [{
      id: "assertion:defective-runtime-answer",
      markdown: "An unrelated archive is authoritative.",
      sourceRefs: [admittedSourceRef],
      assertion: "positive",
      scope: "none",
    }];
  }
  const provider = createChatRuntimeProvidersV1(fixture);
  const modelObservations: ResearchModelCallObservationV1[] = [];
  const dispatches: ResearchDispatchDiagnosticV1[] = [];
  const events: ResearchOneShotEventV1[] = [];
  const subagentDiagnostics: unknown[] = [];
  const agentDiagnostics: unknown[] = [];
  const routeRoles: string[] = [];
  let projection: ChatAcceptedAnswerProjectionV1 = { blocks: [] };
  let answer: ChatAnswerV1 | undefined;
  let paused = false;
  const started = performance.now();
  const request = requests(input.scenario, input.mode);
  const modelBinding = createChatRuntimeModelBindingV1({
    scenario: input.scenario,
    fixture,
    mode: input.mode,
  });
  const underlyingRoute = modelBinding.modelForRoute;
  if (underlyingRoute) {
    modelBinding.modelForRoute = (routeRequest) => {
      routeRoles.push(
        `${routeRequest.role}:${routeRequest.preference}:${routeRequest.profileId ?? "root"}`,
      );
      return underlyingRoute(routeRequest);
    };
  }
  try {
    answer = await runtime.runChatAgent({
      ...request,
      modelBinding,
      providers: provider.providers,
      workspace: createMemoryResearchWorkspace(),
      hostIdentity: {
        userId: "principal:customer-free-release-matrix",
        providerCacheIdentity: "provider-cache:customer-free-release-matrix",
      },
      qualityPolicy: chatQualityPolicyV1(input.mode),
      onAcceptedAnswerProjection: (value) => { projection = structuredClone(value); },
      onModelCallObservation: (value) => { modelObservations.push(structuredClone(value)); },
      onDispatchDiagnostic: (value) => { dispatches.push(structuredClone(value)); },
      onSubagentResultDiagnostic: (value) => {
        subagentDiagnostics.push(structuredClone(value));
      },
      onAgentDiagnostic: (value) => { agentDiagnostics.push(structuredClone(value)); },
      onEvent: (value) => { events.push(structuredClone(value)); },
    });
  } catch (error) {
    if (error instanceof ChatUserQuestionRequiredError) paused = true;
    else {
      throw new Error(
        `${errorChain(error)}; routes=${routeRoles.join(",")}; subagents=${JSON.stringify(subagentDiagnostics)}; agents=${JSON.stringify(agentDiagnostics)}; providerCalls=${JSON.stringify(provider.observation.calls)}`,
        { cause: error },
      );
    }
  }
  const latencyMs = Math.ceil(performance.now() - started);
  const acceptedBlocks = projection.blocks;
  const fixtureHasPositiveAnswer = fixture.blocks.some((block) => block.assertion === "positive");
  const selectedSourceIds = [...new Set([
    ...acceptedBlocks.flatMap((block) => block.sourceRefs.map(sourceId)),
    ...(answer?.gaps.flatMap((gap) => gap.sourceIds) ?? []),
  ])].sort();
  const knownRelationshipIds = new Set(Object.keys(input.scenario.gold.relationshipSupport));
  const publishedAssertionIds = acceptedBlocks
    .filter((block) => block.assertion !== "none" && !knownRelationshipIds.has(block.id))
    .map((block) => block.id)
    .sort((left, right) => left.localeCompare(right, "en-US"));
  const publishedRelationshipIds = acceptedBlocks
    .map((block) => block.id)
    .filter((id) => knownRelationshipIds.has(id))
    .sort((left, right) => left.localeCompare(right, "en-US"));
  const citations = acceptedBlocks.flatMap((block) => {
    if (!publishedAssertionIds.includes(block.id) && !publishedRelationshipIds.includes(block.id)) {
      return [];
    }
    return [...new Set(block.sourceRefs.map(sourceId))].map((id) => ({
      targetId: block.id,
      sourceId: id,
      canonicalUrl: input.scenario.sources.find((source) => source.id === id)!.canonicalUrl,
    }));
  });
  const observedGaps = (answer?.gaps ?? fixture.gaps.map((gap) => gap.answer))
    .flatMap((gap) => {
      const mapped = gapKind(fixture, gap.code, gap.message);
      return mapped ? [mapped] : [];
    });
  const tokens = observedTokens(modelObservations);
  const completedTasks = [...new Set(dispatches.filter((entry) =>
    entry.status === "completed" && entry.taskId
  ).map((entry) => entry.taskId!))];
  const ptc = answer?.run.counts.ptcCalls ?? 0;
  const http = answer?.run.counts.httpCalls ?? provider.observation.calls.length;
  const outcome = paused
    ? "paused" as const
    : !fixtureHasPositiveAnswer && answer?.gaps.length
      ? "abstained" as const
      : "answer" as const;
  const strategy = answer?.strategy.path ?? input.scenario.gold.expectedStrategyByMode[input.mode];
  return {
    schema: CHAT_EVALUATION_SCHEMA_V1,
    scenarioId: input.scenario.id,
    scenarioFingerprint: chatEvaluationScenarioFingerprintV1(input.scenario),
    variant: input.variant ?? input.mode,
    outcome,
    qualityMode: input.mode,
    providerReasoningPreference: providerPreference(input.mode),
    strategy: {
      execution: strategy,
      reasonCodes: [...(answer?.strategy.reasonCodes ?? ["scope-ambiguity-detected"])].sort(),
    },
    workflow: {
      runtimePath: "chat-agent",
      rootExecutions: 1,
      subagentTasks: completedTasks.filter((taskId) => taskId !== "task:synth").length,
      synthesizerTasks: completedTasks.includes("task:synth") ? 1 : 0,
      researchReportFinalizations: 0,
    },
    selectedSourceIds,
    discoveredSourceIds: [...provider.observation.discoveredSourceIds].sort(),
    detailedSourceIds: [...provider.observation.detailedSourceIds]
      .filter((id) => selectedSourceIds.includes(id))
      .sort(),
    publishedAssertionIds,
    publishedRelationshipIds,
    citations,
    gaps: observedGaps,
    calls: { model: modelObservations.length, ptc, http },
    tokens: { input: tokens.input, output: tokens.output },
    modelCostMicros: 0,
    peakSupervisorInputTokens: tokens.peakInput,
    latencyMs,
    finalMarkdownChars: answer?.messageMarkdown.length ?? 0,
  };
}
