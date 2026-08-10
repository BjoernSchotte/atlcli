import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import {
  CAPABILITY_FREE_QUALITY_ADAPTER_V1,
  chatQualityPolicyV1,
  type ChatQualityModeV1,
} from "../../quality-policy.js";
import type { ChatEvaluationScenarioV1 } from "../evaluation.js";
import type {
  ChatModelBindingV1,
  ChatModelRouteRequestV1,
  ChatModelRouteV1,
} from "../model.js";
import type { ChatAnswerBlockV2 } from "../contracts.js";
import {
  deriveChatAcquisitionProductsV1,
  deriveChatStrategyDecisionV1,
} from "../strategy.js";
import type { ChatRuntimeFixtureV1 } from "./runtime-fixtures.js";

const usage = {
  input_tokens: 32,
  output_tokens: 16,
  total_tokens: 48,
};

function toolMessage(
  name: string,
  args: Record<string, unknown>,
  id: string,
): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: [{ name, args, id, type: "tool_call" }],
    usage_metadata: usage,
  });
}

function allText(messages: readonly BaseMessage[]): string {
  return messages.map((message) => [
    message.text,
    typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content),
    message instanceof AIMessage ? JSON.stringify(message.tool_calls ?? []) : "",
  ].join("\n")).join("\n");
}

function sourceId(sourceRef: string): string {
  const separator = sourceRef.indexOf("#");
  return separator === -1 ? sourceRef : sourceRef.slice(0, separator);
}

function semanticSourceIds(fixture: ChatRuntimeFixtureV1): string[] {
  return [...new Set([
    ...fixture.blocks.flatMap((block) => block.sourceRefs.map(sourceId)),
    ...fixture.relationships.flatMap((relationship) => [
      relationship.fromSourceId,
      relationship.toSourceId,
    ]),
    ...fixture.gaps.flatMap((gap) => gap.answer.sourceIds),
  ])];
}

function scenarioAnchors(scenario: ChatEvaluationScenarioV1) {
  return scenario.scope.exactAnchorSourceIds.map((id, index) => {
    const source = scenario.sources.find((candidate) => candidate.id === id);
    if (!source) throw new Error(`Runtime scenario is missing exact source ${id}.`);
    return {
      anchorRef: `research-anchor:fixture-${index}`,
      product: source.product,
      entityKind: source.product === "jira" ? "issue" as const : "page" as const,
      name: `Fixture ${source.product} anchor`,
    };
  });
}

function strategyDecision(
  scenario: ChatEvaluationScenarioV1,
  mode: ChatQualityModeV1,
  fixture: ChatRuntimeFixtureV1,
) {
  return deriveChatStrategyDecisionV1({
    qualityPolicy: chatQualityPolicyV1(mode),
    question: scenario.question,
    scope: {
      siteOrigin: scenario.tenantOrigin,
      jiraProjectKeys: [...scenario.scope.jiraProjectKeys],
      confluenceSpaceKeys: [...scenario.scope.confluenceSpaceKeys],
    },
    anchors: scenarioAnchors(scenario),
    unresolvedAmbiguity: fixture.ambiguousScope === true,
  });
}

function blocksFor(
  fixture: ChatRuntimeFixtureV1,
  mode: ChatQualityModeV1,
  stage: "draft" | "repair" | "synthesis",
): ChatAnswerBlockV2[] {
  const quickIds = fixture.quickBlockIds;
  const blocks = mode === "quick" && quickIds
    ? quickIds.length > 0
      ? fixture.blocks.filter((block) => quickIds.includes(block.id))
      : [{
          id: "answer-block:quick-evidence-scope",
          markdown: "The fast pass identified the relevant evidence but did not expand every analytical claim.",
          sourceRefs: semanticSourceIds(fixture),
          assertion: "none" as const,
          scope: "none" as const,
        }]
    : fixture.blocks;
  if (stage === "draft" && mode === "deep" && fixture.forceCriticRepair) {
    return structuredClone(blocks.slice(0, 1));
  }
  const relationshipBlocks = mode === "quick"
    ? []
    : fixture.relationships.map((relationship) => ({
        id: relationship.id,
        markdown: `The detailed sources explicitly establish the ${relationship.kind}.`,
        sourceRefs: [relationship.fromSourceId, relationship.toSourceId],
        assertion: "positive" as const,
        scope: "none" as const,
      }));
  return structuredClone([...blocks, ...relationshipBlocks]);
}

function packet(
  fixture: ChatRuntimeFixtureV1,
  product: "jira" | "confluence" | "exact",
  exactSourceIds: readonly string[],
): Record<string, unknown> {
  const allowed = new Set(product === "exact"
    ? exactSourceIds
    : semanticSourceIds(fixture).filter((id) =>
        (product === "jira" ? id.startsWith("jira:") : id.startsWith("wiki:")) &&
        !exactSourceIds.includes(id)
      ));
  const sourceIds = semanticSourceIds(fixture).filter((id) => allowed.has(id));
  return {
    schema: "atlcli.chat-evidence-packet/v1",
    sourceIds,
    claims: fixture.blocks.flatMap((block) => {
      const refs = block.sourceRefs.filter((ref) => allowed.has(sourceId(ref)));
      return refs.length === 0 ? [] : [{
        text: block.markdown,
        sourceIds: [...new Set(refs.map(sourceId))],
        sourceRefs: refs,
      }];
    }),
    relationships: fixture.relationships.filter((relationship) =>
      allowed.has(relationship.fromSourceId) && allowed.has(relationship.toSourceId)
    ).map((relationship) => ({
      fromSourceId: relationship.fromSourceId,
      toSourceId: relationship.toSourceId,
      kind: relationship.kind,
      support: `The fixture evidence explicitly records ${relationship.kind}.`,
    })),
    gaps: fixture.gaps.map((gap) => gap.answer.message),
  };
}

function analysisPacket(fixture: ChatRuntimeFixtureV1): Record<string, unknown> {
  return {
    schema: "atlcli.chat-analysis-packet/v1",
    claimRefs: fixture.blocks.map((block) => block.id),
    relationshipRefs: fixture.relationships.map((relationship) => relationship.id),
    contradictions: fixture.gaps.flatMap((gap) =>
      gap.kind === "unresolved-contradiction"
        ? [{ summary: gap.answer.message, sourceIds: gap.answer.sourceIds }]
        : []
    ),
    gaps: fixture.gaps.map((gap) => gap.answer.message),
  };
}

function answerDraft(
  fixture: ChatRuntimeFixtureV1,
  mode: ChatQualityModeV1,
  stage: "draft" | "repair" | "synthesis",
): Record<string, unknown> {
  return {
    blocks: blocksFor(fixture, mode, stage),
    gaps: fixture.gaps.map((gap) => gap.answer),
  };
}

function criticPacket(
  fixture: ChatRuntimeFixtureV1,
  mode: ChatQualityModeV1,
): Record<string, unknown> {
  const repair = mode === "deep" && fixture.forceCriticRepair === true;
  const supportingSourceId = semanticSourceIds(fixture)[0];
  return {
    schema: "atlcli.chat-critique-packet/v1",
    defects: repair ? [{
      defectId: "chat-defect:fixture-missing-question-part",
      code: "question-not-answered",
      severity: "material",
      message: "The provisional draft omits one required comparison dimension.",
      sourceIds: supportingSourceId ? [supportingSourceId] : [],
      repairAction: "resynthesize",
    }] : [],
    readyForSynthesis: !repair,
  };
}

function workflowProgram(
  scenario: ChatEvaluationScenarioV1,
  fixture: ChatRuntimeFixtureV1,
  anchorRefs: readonly string[],
  mode: ChatQualityModeV1,
): string {
  const decision = strategyDecision(scenario, mode, fixture);
  const tasks: Array<{
    taskId: string;
    profileId: string;
    objective: string;
    dependencyTaskIds: string[];
  }> = [];
  const acquisition: string[] = [];
  if (decision.requiredCapabilities.includes("exact-read")) {
    tasks.push({
      taskId: "task:exact",
      profileId: "exact-context-reader",
      objective: `Read only these host-attached exact sources: ${anchorRefs.join(", ")}.`,
      dependencyTaskIds: [],
    });
    acquisition.push("task:exact");
  }
  if (decision.requiredCapabilities.includes("confluence-discovery")) {
    tasks.push({
      taskId: "task:confluence",
      profileId: "confluence-search-reader",
      objective: "Find and read the relevant Confluence sources in the admitted space.",
      dependencyTaskIds: [],
    });
    acquisition.push("task:confluence");
  }
  if (decision.requiredCapabilities.includes("jira-discovery")) {
    tasks.push({
      taskId: "task:jira",
      profileId: "jira-search-reader",
      objective: "Find and read the relevant Jira sources in the admitted project.",
      dependencyTaskIds: [],
    });
    acquisition.push("task:jira");
  }
  const analysisProfile = fixture.relationships.length > 0
    ? "relationship-tracer"
    : fixture.gaps.some((gap) => gap.kind === "unresolved-contradiction")
      ? "contradiction-checker"
      : "comparison-analyst";
  tasks.push({
    taskId: "task:analysis",
    profileId: analysisProfile,
    objective: "Analyze only the accepted evidence for the user's question.",
    dependencyTaskIds: [...acquisition],
  });
  tasks.push({
    taskId: "task:draft",
    profileId: "answer-drafter",
    objective: "Draft a concise evidence-backed answer.",
    dependencyTaskIds: ["task:analysis"],
  });
  tasks.push({
    taskId: "task:critic",
    profileId: "answer-critic",
    objective: "Independently review the provisional answer.",
    dependencyTaskIds: ["task:draft"],
  });
  tasks.push({
    taskId: "task:synth",
    profileId: "chat-synthesizer",
    objective: "Write the final conversational answer.",
    dependencyTaskIds: ["task:draft", "task:critic"],
  });
  return [
    "const strategy = JSON.parse(await tools.chatStrategyDecide({}));",
    `const workflow = JSON.parse(await tools.chatWorkflowPropose(${JSON.stringify({ tasks, maxConcurrency: 1 })}));`,
    "const completed = JSON.parse(await tools.chatWorkflowRun({}));",
    "completed;",
  ].join("\n");
}

function agenticRootModel(input: {
  scenario: ChatEvaluationScenarioV1;
  fixture: ChatRuntimeFixtureV1;
  mode: ChatQualityModeV1;
}): BaseChatModel {
  const built = fakeModel();
  let step = 0;
  const respond = (messages: readonly BaseMessage[]): AIMessage => {
    if (step++ === 0) {
      const anchorRefs = [...new Set(
        allText(messages).match(/research-anchor:[A-Za-z0-9-]{1,200}/gu) ?? [],
      )];
      return toolMessage("eval", {
        code: workflowProgram(input.scenario, input.fixture, anchorRefs, input.mode),
      }, "fixture-agentic-workflow");
    }
    return new AIMessage({
      content: "The host-admitted workflow is complete.",
      usage_metadata: usage,
    });
  };
  for (let index = 0; index < 8; index += 1) built.respond(respond);
  return built;
}

function directRootModel(input: {
  scenario: ChatEvaluationScenarioV1;
  fixture: ChatRuntimeFixtureV1;
  mode: ChatQualityModeV1;
}): BaseChatModel {
  const built = fakeModel();
  const decision = strategyDecision(input.scenario, input.mode, input.fixture);
  const acquisition = deriveChatAcquisitionProductsV1({
    decision,
    scope: {
      siteOrigin: input.scenario.tenantOrigin,
      jiraProjectKeys: [...input.scenario.scope.jiraProjectKeys],
      confluenceSpaceKeys: [...input.scenario.scope.confluenceSpaceKeys],
    },
    anchors: scenarioAnchors(input.scenario),
  });
  let step = 0;
  const respond = (messages: readonly BaseMessage[]): AIMessage => {
    const current = step++;
    if (
      input.fixture.ambiguousScope &&
      current === 0 &&
      input.mode !== "quick"
    ) {
      return toolMessage("eval", {
        code: "JSON.parse(await tools.chatStrategyDecide({}))",
      }, `fixture-strategy-${input.mode}`);
    }
    if (
      input.fixture.ambiguousScope &&
      (current === 0 || current === 1)
    ) {
      return toolMessage("ask_user_question", {
        responseKind: "single_choice",
        prompt: "Which account management space should I use?",
        required: true,
        options: [
          { id: "space:europe", label: "Account management Europe" },
          { id: "space:platform", label: "Account management Platform" },
        ],
      }, `fixture-hitl-${input.mode}`);
    }
    if (current === 0) {
      const text = allText(messages);
      const anchorRefs = [...new Set(text.match(/research-anchor:[A-Za-z0-9-]{1,200}/gu) ?? [])];
      const statements: string[] = [];
      if (input.mode !== "quick") {
        statements.push("JSON.parse(await tools.chatStrategyDecide({}));");
      }
      for (const anchorRef of anchorRefs) {
        statements.push(`JSON.parse(await tools.atlassianBoundRead({ anchorRef: ${JSON.stringify(anchorRef)} }));`);
      }
      if (acquisition.searchProducts.includes("jira")) {
        statements.push("JSON.parse(await tools.chatJiraRetrievalAcquire({}));");
      }
      if (acquisition.searchProducts.includes("confluence")) {
        statements.push("JSON.parse(await tools.chatConfluenceRetrievalAcquire({}));");
      }
      if (input.fixture.scenarioId !== "chat-gold:long-page") {
        statements.push("({ complete: true });");
      }
      return toolMessage("eval", { code: statements.join("\n") }, `fixture-acquire-${input.mode}`);
    }
    if (input.fixture.scenarioId === "chat-gold:long-page" && current === 1) {
      const sectionRefs = allText(messages).match(/research-section:[A-Za-z0-9-]{1,200}/gu) ?? [];
      const sectionRef = sectionRefs.at(-1);
      if (!sectionRef) return new AIMessage({ content: "The required section reference is unavailable.", usage_metadata: usage });
      return toolMessage("eval", {
        code: `JSON.parse(await tools.atlassianBoundSectionRead({ sectionRef: ${JSON.stringify(sectionRef)} }))`,
      }, `fixture-section-${input.mode}`);
    }
    return toolMessage(
      "ChatAnswerDraftV2",
      answerDraft(
        input.fixture,
        input.mode,
        "synthesis",
      ),
      `fixture-answer-${input.mode}`,
    );
  };
  for (let index = 0; index < 8; index += 1) built.respond(respond);
  return built;
}

function extractionModel(
  fixture: ChatRuntimeFixtureV1,
  exactSourceIds: readonly string[],
  profileId?: string,
): BaseChatModel {
  const built = fakeModel();
  const respond = (messages: readonly BaseMessage[]) => {
    const text = allText(messages);
    if (text.includes("internal exact-evidence extraction boundary")) {
      return toolMessage(
        "KiteweaveExactEvidenceExtractionV1",
        packet(fixture, "exact", exactSourceIds),
        "fixture-exact-packet",
      );
    }
    const product = profileId === "confluence-search-reader" ||
        (profileId === undefined && /Confluence discovery|Confluence sources|confluence-search-reader/iu.test(text))
      ? "confluence" as const
      : "jira" as const;
    const acquisitionCompleted = messages.some((message) =>
      message.getType() === "tool" &&
      JSON.stringify(message.content).includes("atlcli.chat-planned-acquisition/v1")
    );
    return acquisitionCompleted
      ? toolMessage(
          "ChatEvidencePacketV1",
          packet(fixture, product, exactSourceIds),
          `fixture-${product}-packet`,
        )
      : toolMessage(
          "eval",
          { code: "JSON.parse(await tools.chatRetrievalAcquire({}))" },
          `fixture-${product}-retrieve`,
        );
  };
  for (let index = 0; index < 64; index += 1) built.respond(respond);
  const originalStructuredOutput = built.withStructuredOutput.bind(built);
  built.withStructuredOutput = ((schema: unknown, options?: { name?: string }) => {
    if (options?.name !== "KiteweaveExactEvidenceExtractionV1") {
      return originalStructuredOutput(schema as never, options as never);
    }
    return {
      invoke: async () => {
        const parsed = packet(fixture, "exact", exactSourceIds);
        return {
          raw: toolMessage(
            "KiteweaveExactEvidenceExtractionV1",
            parsed,
            "fixture-exact-packet",
          ),
          parsed,
        };
      },
    };
  }) as typeof built.withStructuredOutput;
  return built;
}

function structuredModel(name: string, args: Record<string, unknown>): BaseChatModel {
  const built = fakeModel();
  for (let index = 0; index < 4; index += 1) {
    built.respond(toolMessage(name, args, `fixture-${name}-${index}`));
  }
  return built;
}

export function createChatRuntimeModelBindingV1(input: {
  scenario: ChatEvaluationScenarioV1;
  fixture: ChatRuntimeFixtureV1;
  mode: ChatQualityModeV1;
}): ChatModelBindingV1 {
  const direct = strategyDecision(input.scenario, input.mode, input.fixture).execution === "direct";
  const root = direct
    ? directRootModel(input)
    : agenticRootModel(input);
  const exactSourceIds = input.scenario.scope.exactAnchorSourceIds;
  let analysisIndex = 0;
  const route = (request: ChatModelRouteRequestV1): ChatModelRouteV1 => {
    let model: BaseChatModel;
    if (request.role === "root-planning") model = root;
    else if (request.role === "extraction") {
      model = extractionModel(input.fixture, exactSourceIds, request.profileId);
    }
    else if (request.role === "analysis") {
      analysisIndex += 1;
      model = structuredModel("ChatAnalysisPacketV1", analysisPacket(input.fixture));
    } else if (request.role === "drafting") {
      model = structuredModel("ChatProvisionalAnswerDraftV1", answerDraft(input.fixture, input.mode, "draft"));
    } else if (request.role === "critique") {
      model = structuredModel("ChatCritiquePacketV1", criticPacket(input.fixture, input.mode));
    } else if (request.role === "repair") {
      model = structuredModel("ChatRepairedAnswerDraftV1", answerDraft(input.fixture, input.mode, "repair"));
    } else {
      model = structuredModel("ChatAnswerDraftV2", answerDraft(input.fixture, input.mode, "synthesis"));
    }
    return {
      model,
      effectiveModelId: `fixture-${request.role}-${analysisIndex}`,
      requestedPreference: request.preference,
      effectivePreference: request.preference,
      thinkingMode: "provider-default",
      finalizationCorridor: "standard",
    };
  };
  return {
    model: root,
    modelId: "customer-free-runtime-fixture",
    qualityAdapter: CAPABILITY_FREE_QUALITY_ADAPTER_V1,
    structuredOutput: "tool",
    modelForRoute: route,
  };
}
