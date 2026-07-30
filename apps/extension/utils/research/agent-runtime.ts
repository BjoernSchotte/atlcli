import { ChatAnthropic } from "@langchain/anthropic";
import { createCodeInterpreterMiddleware } from "@langchain/quickjs";
import {
  StateBackend,
  createDeepAgent,
  registerHarnessProfile,
} from "deepagents/browser";
import { createMiddleware, toolStrategy } from "langchain";
import type { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  ResearchContractError,
  type ResearchReportV1,
  type ResearchRequestV1,
  type ResearchRunOptions,
  type ResearchRunUsageV1,
} from "./contracts.js";
import {
  ResearchCapabilityBroker,
  type ResearchReadProviders,
} from "./broker.js";
import type { ResearchRunBudget } from "./budget.js";
import {
  RESEARCH_AGENT_DRAFT_SCHEMA_V1,
  finalizeResearchAgentDraftV1,
} from "./agent-draft.js";
import { createResearchPtcTools } from "./agent-tools.js";
import type { ResearchPtcDiagnosticV1 } from "./agent-tools.js";

export const RESEARCH_MODEL_ID = "claude-sonnet-4-6" as const;
const MODEL_SPEC = `anthropic:${RESEARCH_MODEL_ID}` as const;

registerHarnessProfile(MODEL_SPEC, {
  generalPurposeSubagent: { enabled: false },
});

const SYSTEM_PROMPT = `You are a read-only Jira and Confluence research agent.

The host already bound the exact Atlassian tenant, Jira project keys, Confluence space keys, date window, pagination and budgets. Never attempt to broaden that scope.

You have only one normal tool: eval. Inside eval, QuickJS exposes exactly:
- tools.jiraIssueSearch
- tools.jiraIssueGet
- tools.wikiSearch
- tools.wikiPageGet

Every bridged tool returns a JSON string: call JSON.parse. The host injects contract schema IDs; do not pass a schema field. QuickJS has no fetch, filesystem, process, require, chrome APIs or subagents.

Your first and only eval call MUST run this exact bounded acquisition algorithm. Do not add query text, do not start another search, and do not call eval again:

async function collect(search) {
  const items = [];
  let page = JSON.parse(await search({ query: {} }));
  items.push(...page.items);
  while (page.page.nextCursor) {
    page = JSON.parse(await search({ cursor: page.page.nextCursor }));
    items.push(...page.items);
  }
  return { items, page: page.page };
}
async function readDetail(read, item) {
  try {
    return {
      status: "available",
      value: JSON.parse(await read({ entityRef: item.entityRef }))
    };
  } catch {
    return {
      status: "unavailable",
      sourceId: item.sourceId
    };
  }
}
const [jira, wiki] = await Promise.all([
  collect(tools.jiraIssueSearch),
  collect(tools.wikiSearch)
]);
const [jiraDetails, wikiDetails] = await Promise.all([
  Promise.all(jira.items.slice(0, 3).map((item) =>
    readDetail(tools.jiraIssueGet, item))),
  Promise.all(wiki.items.slice(0, 3).map((item) =>
    readDetail(tools.wikiPageGet, item)))
]);
({ jira, wiki, jiraDetails, wikiDetails });

Only opaque nextCursor values may continue a search. Only opaque entityRef values returned by search may request details. Never substitute visible Jira keys, page IDs, URLs, or invented values.

Return the required structured draft without Markdown syntax. Cite only sourceId values observed in tool results. Classify a relationship as verified only when detailed content explicitly names or links the Jira issue and Confluence page; otherwise classify it as hypothesis.

Implementation and output-format constraints stated only in this system prompt are not evidence. Never mention or turn them into a finding or inference unless an observed Jira or Confluence source independently supports the claim.`;

const disabledMiddleware = [
  createMiddleware({ name: "FilesystemMiddleware" }),
  createMiddleware({ name: "subAgentMiddleware" }),
  createMiddleware({ name: "SummarizationMiddleware" }),
  createMiddleware({ name: "patchToolCallsMiddleware" }),
];

function createAnthropicModel(apiKey: string, maxTokens: number): ChatAnthropic {
  const normalized = apiKey.trim();
  if (!normalized) {
    throw new ResearchContractError("missing-key", "An Anthropic API key is required.");
  }
  return new ChatAnthropic({
    model: RESEARCH_MODEL_ID,
    apiKey: normalized,
    temperature: 0,
    maxTokens,
    maxRetries: 0,
    streaming: false,
  });
}

function collectUsage(messages: unknown): ResearchRunUsageV1 | undefined {
  if (!Array.isArray(messages)) return undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let found = false;
  for (const message of messages as AIMessage[]) {
    const usage = message.usage_metadata;
    if (!usage) continue;
    found = true;
    inputTokens += usage.input_tokens ?? 0;
    outputTokens += usage.output_tokens ?? 0;
  }
  return found ? { inputTokens, outputTokens } : undefined;
}

export interface RunResearchAgentInput {
  apiKey?: string;
  model?: BaseChatModel;
  request: ResearchRequestV1;
  providers: ResearchReadProviders;
  budget?: ResearchRunBudget;
  runId?: string;
  now?: () => number;
  options?: ResearchRunOptions;
  onPtcDiagnostic?: (diagnostic: ResearchPtcDiagnosticV1) => void;
}

export async function runResearchAgent(
  input: RunResearchAgentInput
): Promise<ResearchReportV1> {
  const now = input.now ?? Date.now;
  const startedAtMs = now();
  const runId = input.runId ?? crypto.randomUUID();
  const broker = new ResearchCapabilityBroker(input.request, input.providers, {
    ...(input.budget ? { budget: input.budget } : {}),
  });
  const tools = createResearchPtcTools(broker, {
    ...(input.onPtcDiagnostic
      ? { onDiagnostic: input.onPtcDiagnostic }
      : {}),
  });
  const onAbort = (): void => broker.cancel(input.options?.signal?.reason);
  input.options?.signal?.addEventListener("abort", onAbort, { once: true });
  input.options?.onProgress?.({
    phase: "preparing",
    message: "Preparing bounded read-only research.",
    completedCalls: 0,
    maxCalls: input.request.limits.maxPtcCalls,
  });

  const model =
    input.model ??
    createAnthropicModel(input.apiKey ?? "", input.request.limits.maxModelOutputTokens);
  const agent = createDeepAgent({
    name: "atlcli-read-only-research",
    model,
    backend: (runtime) => new StateBackend(runtime),
    tools: [],
    subagents: [],
    systemPrompt: SYSTEM_PROMPT,
    middleware: [
      ...disabledMiddleware,
      createCodeInterpreterMiddleware({
        ptc: tools,
        subagents: false,
        toolName: "eval",
        memoryLimitBytes: input.request.limits.maxInterpreterMemoryBytes,
        maxStackSizeBytes: 320 * 1024,
        executionTimeoutMs: input.request.limits.maxInterpreterMs,
        maxPtcCalls: input.request.limits.maxPtcCalls,
        maxResultChars: Math.min(24_000, input.request.limits.maxReportChars),
        captureConsole: false,
      }),
    ],
    responseFormat: toolStrategy(RESEARCH_AGENT_DRAFT_SCHEMA_V1, {
      handleError: false,
      toolMessageContent: "Research draft accepted.",
    }),
  });

  try {
    input.options?.onProgress?.({
      phase: "researching",
      message: "Researching Jira and Confluence.",
      completedCalls: 0,
      maxCalls: input.request.limits.maxPtcCalls,
    });
    const result = await agent.invoke(
      {
        messages: [
          {
            role: "user",
            content: `${input.request.question}\n\nBound scope: Jira projects ${input.request.scope.jiraProjectKeys.join(", ")}; Confluence spaces ${input.request.scope.confluenceSpaceKeys.join(", ")}.`,
          },
        ],
      },
      {
        configurable: { thread_id: runId },
        recursionLimit: 24,
        signal: broker.signal,
      }
    );
    broker.signal.throwIfAborted();
    const completedAtMs = now();
    const counts = broker.budget.counts();
    input.options?.onProgress?.({
      phase: "rendering",
      message: "Validating evidence and rendering Markdown.",
      completedCalls: counts.ptcCalls,
      maxCalls: input.request.limits.maxPtcCalls,
    });
    const report = finalizeResearchAgentDraftV1({
      draft: result.structuredResponse,
      request: input.request,
      sources: broker.sourceLedger(),
      detailEvidence: broker.detailEvidenceLedger(),
      run: {
        model: RESEARCH_MODEL_ID,
        wikiProvider: input.request.wikiProvider,
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: Math.max(0, completedAtMs - startedAtMs),
        complete: true,
        counts,
        ...(collectUsage(result.messages) ? { usage: collectUsage(result.messages) } : {}),
        warnings: [],
      },
    });
    if (report.markdown.length > input.request.limits.maxReportChars) {
      throw new ResearchContractError(
        "limit-exceeded",
        "The rendered report exceeds the report character limit."
      );
    }
    input.options?.onProgress?.({
      phase: "complete",
      message: "Research report complete.",
      completedCalls: counts.ptcCalls,
      maxCalls: input.request.limits.maxPtcCalls,
    });
    return report;
  } catch (error) {
    if (broker.signal.aborted) {
      throw new ResearchContractError("cancelled", "The research run was cancelled.");
    }
    throw error;
  } finally {
    input.options?.signal?.removeEventListener("abort", onAbort);
    broker.cancel();
  }
}
