import {
  DEFAULT_RESEARCH_LIMITS_V1,
  ResearchRunBudget,
  chatQualityPolicyV1,
  createMemoryResearchWorkspace,
  normalizeResearchRequestV1,
  prepareDirectChatRequestV1,
  runChatAgent,
  type ChatPresentationStreamEventV1,
  type ChatQualityModeV1,
  type ChatTurnRequestV1,
  type ResearchOneShotEventV1,
} from "@atlcli/research/node";
import {
  SYNTHETIC_PROJECT_KEY,
  SYNTHETIC_SITE_ORIGIN,
  SYNTHETIC_SPACE_KEY,
  syntheticResearchProviders,
} from "./research-agent-live.js";

const DEFAULT_QUESTION =
  "Compare the synthetic Jira implementation tasks with the synthetic Confluence design pages, explain their relationships, and identify any evidence gap.";

export interface ChatAgentLiveArgumentsV1 {
  mode: ChatQualityModeV1;
  question: string;
  exactPage: boolean;
}

export function parseChatAgentLiveArgumentsV1(argv: readonly string[]): ChatAgentLiveArgumentsV1 {
  let mode: ChatQualityModeV1 = "deep";
  let exactPage = false;
  const questionParts: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--thinking") {
      const value = argv[index + 1];
      if (value !== "quick" && value !== "auto" && value !== "deep") {
        throw new Error("--thinking must be quick, auto, or deep.");
      }
      mode = value;
      index += 1;
      continue;
    }
    if (argument === "--exact-page") {
      exactPage = true;
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    questionParts.push(argument);
  }
  return {
    mode,
    question: questionParts.join(" ").trim() || (exactPage
      ? "Summarize the attached synthetic Confluence page and cite its central design decision."
      : DEFAULT_QUESTION),
    exactPage,
  };
}

export async function runChatAgentLiveV1(): Promise<void> {
  const apiKey = Bun.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is missing. Add it to the ignored repository .env file.",
    );
  }
  const argumentsV1 = parseChatAgentLiveArgumentsV1(Bun.argv.slice(2));
  const request = prepareDirectChatRequestV1(normalizeResearchRequestV1({
    schema: "atlcli.research-request/v1",
    question: argumentsV1.question,
    scope: {
      siteOrigin: SYNTHETIC_SITE_ORIGIN,
      jiraProjectKeys: argumentsV1.exactPage ? [] : [SYNTHETIC_PROJECT_KEY],
      confluenceSpaceKeys: [SYNTHETIC_SPACE_KEY],
    },
    ...(argumentsV1.exactPage
      ? {
          scopeSeeds: [{
            binding: {
              schema: "atlcli.research-scope-binding/v1",
              id: "scope-binding:current:synthetic-space-kb",
              tenantOrigin: SYNTHETIC_SITE_ORIGIN,
              product: "confluence",
              entityKind: "space",
              entityRef: "research-scope-entity:synthetic-space-kb",
              key: SYNTHETIC_SPACE_KEY,
              name: "Synthetic knowledge base",
              source: "current_context",
              authority: "approved",
            },
            precedence: 300,
          }, {
            binding: {
              schema: "atlcli.research-scope-binding/v1",
              id: "scope-binding:current:synthetic-page-1001",
              tenantOrigin: SYNTHETIC_SITE_ORIGIN,
              product: "confluence",
              entityKind: "page",
              entityRef: "research-scope-entity:synthetic-page-1001",
              key: "1001",
              name: "Research design",
              source: "current_context",
              authority: "approved",
            },
            precedence: 300,
          }],
          exactContextProducts: ["confluence" as const],
        }
      : {}),
    limits: {
      ...DEFAULT_RESEARCH_LIMITS_V1,
      // The production default is much larger. Keep this synthetic live proof
      // bounded without forcing several extra provider turns for pagination.
      pageSize: 4,
      maxSearchPagesPerProduct: argumentsV1.exactPage ? 3 : 9,
      maxItemsPerProduct: argumentsV1.exactPage ? 4 : 12,
      maxDetailItemsPerProduct: 4,
      maxPtcCalls: argumentsV1.mode === "quick" ? 16 : 24,
      maxHttpCalls: 20,
      maxModelOutputTokens: 8_000,
      maxRunMs: 5 * 60_000,
    },
    wikiProvider: "rest",
  }));
  const conversationId = `synthetic-chat-${crypto.randomUUID()}`;
  const turn: ChatTurnRequestV1 = {
    schema: "atlcli.chat-turn-request/v1",
    conversationId,
    turnId: `turn-${crypto.randomUUID()}`,
    question: request.question,
    scope: request.scope,
    limits: request.limits,
    wikiProvider: request.wikiProvider,
    ...(request.exactContextProducts?.length
      ? { exactContextProducts: request.exactContextProducts }
      : {}),
  };
  const presentation: ChatPresentationStreamEventV1[] = [];
  const durableEvents: ResearchOneShotEventV1[] = [];
  const startedAt = performance.now();
  const answer = await runChatAgent({
    apiKey,
    turn,
    brokerRequest: request,
    providers: syntheticResearchProviders(),
    budget: new ResearchRunBudget(request.limits),
    workspace: createMemoryResearchWorkspace(),
    qualityPolicy: chatQualityPolicyV1(argumentsV1.mode),
    signal: AbortSignal.timeout(request.limits.maxRunMs),
    onEvent: (event) => {
      durableEvents.push(event);
      if (event.kind === "capability") {
        console.error(`[chat-live] capability=${event.toolId} status=${event.status}`);
      }
    },
    onAgentDiagnostic: (diagnostic) => {
      if (diagnostic.kind === "model-step") {
        console.error(
          `[chat-live] model=${diagnostic.purpose} status=${diagnostic.status}`,
        );
        return;
      }
      console.error(
        `[chat-live] eval=${diagnostic.status}${diagnostic.profileId ? ` profile=${diagnostic.profileId}` : ""}${diagnostic.attempt === undefined ? "" : ` attempt=${diagnostic.attempt}`}${diagnostic.codeChars === undefined ? "" : ` chars=${diagnostic.codeChars}`}${diagnostic.capabilityNames === undefined ? "" : ` capabilities=${diagnostic.capabilityNames.join(",") || "none"}`}${diagnostic.searchInputShapes === undefined ? "" : ` shapes=${diagnostic.searchInputShapes.join(",") || "none"}`}${diagnostic.argumentKeys === undefined ? "" : ` keys=${diagnostic.argumentKeys.join(",") || "none"}`}${diagnostic.errorKind ? ` kind=${diagnostic.errorKind}` : ""}${diagnostic.subagentErrorCode ? ` child_error=${diagnostic.subagentErrorCode}` : ""}${diagnostic.errorCode ? ` error=${diagnostic.errorCode}` : ""}`,
      );
    },
    onDispatchDiagnostic: (diagnostic) => {
      console.error(
        `[chat-live] dispatch=${diagnostic.status}${diagnostic.taskId ? ` task=${diagnostic.taskId}` : ""}${diagnostic.code ? ` code=${diagnostic.code}` : ""}${diagnostic.resultBytes === undefined ? "" : ` bytes=${diagnostic.resultBytes}`}`,
      );
    },
    onSubagentResultDiagnostic: (diagnostic) => {
      console.error(
        `[chat-live] result=${diagnostic.status} profile=${diagnostic.profileId} phase=${diagnostic.phase} kind=${diagnostic.valueKind}${diagnostic.objectKeys ? ` keys=${diagnostic.objectKeys.join(",")}` : ""}${diagnostic.referenceKinds ? ` refs=${diagnostic.referenceKinds.join(",") || "none"}` : ""}${diagnostic.unknownReferenceKinds ? ` unknown_refs=${diagnostic.unknownReferenceKinds.join(",") || "none"}` : ""}`,
      );
    },
    onChatPresentation: (event) => {
      presentation.push(event);
      if (event.status === "started") {
        console.error(`[chat-live] ${event.channel} `);
      } else if (event.status === "delta") {
        console.error(event.delta ?? "");
      } else {
        console.error("\n");
      }
    },
  });
  const reasoningDeltas = presentation.filter((event) =>
    event.channel === "reasoning-summary" && event.status === "delta");
  const answerDeltas = presentation.filter((event) =>
    event.channel === "answer-markdown" && event.status === "delta");
  if (argumentsV1.mode !== "quick" && reasoningDeltas.length === 0) {
    // Adaptive thinking is explicitly allowed to skip a thinking block. This
    // is an observed provider outcome, not a broken stream transport. The
    // separate Anthropic -> DeepAgents v3 contract test proves projection when
    // a summarized block is present.
    console.error("[chat-live] The provider emitted no summarized reasoning block for this run.\n");
  }
  if (durableEvents.some((event) =>
    (event as { kind: string }).kind === "chat-presentation")) {
    throw new Error("Ephemeral presentation content crossed into the durable event stream.");
  }
  if (answerDeltas.length === 0) {
    throw new Error("The provider-backed Chat run completed without a streamed Markdown answer.");
  }
  console.error(JSON.stringify({
    kind: "chat-live-proof",
    source: "synthetic",
    mode: argumentsV1.mode,
    strategy: answer.strategy.path,
    durationMs: Math.round(performance.now() - startedAt),
    presentationEvents: presentation.length,
    reasoningDeltaCount: reasoningDeltas.length,
    reasoningSummaryObserved: reasoningDeltas.length > 0,
    answerDeltaCount: answerDeltas.length,
    answerStreamingObserved: answerDeltas.length > 0,
    durableEventCount: durableEvents.length,
    ptcCalls: answer.run.counts.ptcCalls,
    httpCalls: answer.run.counts.httpCalls,
  }));
  console.log(answer.messageMarkdown);
}

if (import.meta.main) await runChatAgentLiveV1();
