import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { RunnableBinding, type Runnable } from "@langchain/core/runnables";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import type { BaseLanguageModelInput, ToolDefinition } from "@langchain/core/language_models/base";
import type { ModelProfile } from "@langchain/core/language_models/profile";
import { ContextOverflowError } from "@langchain/core/errors";
import { ResearchContractError } from "@atlcli/research/contracts";
import {
  CAPABILITY_FREE_QUALITY_ADAPTER_V1,
  type ChatModelBindingV1,
  type ChatStructuredAnswerPreviewV1,
} from "@atlcli/research/browser/agent";
import {
  LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
  LOCAL_MODEL_RPC_LIMITS_V1,
  type LocalModelChatMessageV1,
  type LocalModelPortRequestV1,
  type LocalModelPortResponseV1,
  type LocalModelToolCallV1,
  type LocalModelToolV1,
} from "./protocol.js";
import { projectLocalGemmaToolProtocolV1 } from "./tool-protocol.js";
import { projectLocalGemmaToolResultV1 } from "./tool-result.js";
import {
  LOCAL_GEMMA_HARNESS_PROFILE_V1,
  LOCAL_GEMMA_OPERATIONAL_PROFILE_V1,
  localGemmaRouteOutputTokensV1,
  localGemmaThinkingModeV1,
  type LocalGemmaThinkingModeV1,
} from "./model-profile.js";

interface LocalGemmaCallOptionsV1 extends BaseChatModelCallOptions {
  tools?: ToolDefinition[];
  tool_choice?: string | { type?: string; name?: string; function?: { name?: string } };
}

function requiredToolNameV1(
  toolChoice: LocalGemmaCallOptionsV1["tool_choice"],
): string | undefined {
  if (typeof toolChoice === "string") {
    return toolChoice === "auto" || toolChoice === "any" || toolChoice === "none"
      ? undefined
      : toolChoice;
  }
  return toolChoice?.name ?? toolChoice?.function?.name;
}

function textContentV1(message: BaseMessage): string {
  if (typeof message.content === "string") return message.content;
  const text = message.content.map((block) => {
    if (typeof block === "string") return block;
    if (block && typeof block === "object" && block.type === "text" &&
        typeof (block as { text?: unknown }).text === "string") {
      return (block as { text: string }).text;
    }
    if (block && typeof block === "object" && block.type === "tool_call" &&
        AIMessage.isInstance(message)) {
      return "";
    }
    const type = block && typeof block === "object" && "type" in block
      ? String(block.type)
      : typeof block;
    throw new Error(
      `Local Gemma accepts text-only LangChain message content; received ${type}.`,
    );
  }).join("");
  return text;
}

export function toLocalModelMessagesV1(
  messages: BaseMessage[],
  options: {
    retainPrivateThought?: boolean;
  } = {},
): LocalModelChatMessageV1[] {
  const relevanceText = [...messages].reverse().find((message) =>
    message.getType() === "human"
  );
  const relevance = relevanceText ? textContentV1(relevanceText) : "";
  return messages.map((message, messageIndex): LocalModelChatMessageV1 => {
    const type = message.getType();
    const content = textContentV1(message);
    if (type === "system") return { role: "system", content };
    if (type === "human") {
      return { role: "user", content };
    }
    if (type === "ai") {
      const retainedThought = options.retainPrivateThought !== false &&
          AIMessage.isInstance(message) &&
          typeof message.additional_kwargs.localGemmaThought === "string"
        ? message.additional_kwargs.localGemmaThought
        : "";
      const toolCalls = AIMessage.isInstance(message)
        ? message.tool_calls?.map((call) => ({
            id: call.id ?? `prior-${call.name}`,
            type: "function" as const,
            function: { name: call.name, arguments: call.args },
          }))
        : undefined;
      return {
        role: "assistant",
        content: retainedThought
          ? `<|channel>thought\n${retainedThought}<channel|>${content}`
          : content,
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      };
    }
    if (type === "tool" && ToolMessage.isInstance(message)) {
      const toolName = message.name ?? [...messages.slice(0, messageIndex)]
        .reverse()
        .filter(AIMessage.isInstance)
        .flatMap((candidate) => candidate.tool_calls ?? [])
        .find((call) => call.id === message.tool_call_id)?.name;
      if (!toolName) {
        throw new Error(
          `A local Gemma tool result could not be matched to its call id: ${message.tool_call_id}.`,
        );
      }
      return {
        role: "tool",
        content: projectLocalGemmaToolResultV1(content, relevance),
        name: toolName,
        tool_call_id: message.tool_call_id,
      };
    }
    throw new Error(`Unsupported local Gemma message type: ${type}.`);
  });
}

const LOCAL_GEMMA_FINAL_ANSWER_SCHEMA_V1 = {
  type: "object",
  additionalProperties: false,
  required: ["blocks"],
  properties: {
    blocks: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["markdown", "sourceRefs", "assertion", "scope"],
        properties: {
          markdown: { type: "string", maxLength: 1_600 },
          sourceRefs: { type: "array", maxItems: 6, items: { type: "string" } },
          assertion: {
            type: "string",
            enum: ["positive", "absence", "none"],
          },
          scope: {
            type: "string",
            enum: ["none", "source", "selected-sources", "bound-scope"],
          },
        },
      },
    },
    gaps: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "message", "sourceIds"],
        properties: {
          code: { type: "string", maxLength: 80 },
          message: { type: "string", maxLength: 500 },
          sourceIds: { type: "array", maxItems: 6, items: { type: "string" } },
        },
      },
    },
  },
} as const;

function toLocalToolsV1(
  tools: ToolDefinition[] | undefined,
  requiredToolName?: string,
): LocalModelToolV1[] {
  return (tools ?? []).map((tool) => {
    if (tool.type !== "function" || !tool.function?.name || !tool.function.parameters) {
      throw new Error("Local Gemma accepts only named function tools with JSON Schema parameters.");
    }
    return {
      type: "function",
      function: {
        name: tool.function.name,
        ...(requiredToolName === "ChatAnswerDraftV2"
          ? { parameters: LOCAL_GEMMA_FINAL_ANSWER_SCHEMA_V1 }
          : {
              ...(tool.function.description
                ? { description: tool.function.description }
                : {}),
              parameters: tool.function.parameters,
            }),
      },
    };
  });
}

const LOCAL_GEMMA_ANSWER_ASSERTIONS_V1 = new Set([
  "positive",
  "absence",
  "none",
]);
const LOCAL_GEMMA_ANSWER_SCOPES_V1 = new Set([
  "none",
  "source",
  "selected-sources",
  "bound-scope",
]);

/**
 * Repair only the small set of schema-equivalent shortcuts observed from the
 * pinned local Gemma model. DeepAgents still receives the canonical tool call
 * and performs its normal schema/evidence validation. Explicit but unknown
 * values remain untouched so this adapter cannot turn arbitrary malformed
 * output into an accepted answer.
 */
export function normalizeLocalGemmaToolCallV1(
  call: LocalModelToolCallV1,
): LocalModelToolCallV1 {
  if (call.name !== "ChatAnswerDraftV2") return call;
  const blocks = Array.isArray(call.arguments.blocks)
    ? call.arguments.blocks.map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return value;
        }
        const block = value as Record<string, unknown>;
        const sourceRefs = Array.isArray(block.sourceRefs)
          ? block.sourceRefs.filter((sourceRef) =>
              typeof sourceRef === "string" && sourceRef.trim().length > 0
            )
          : [];
        const assertion = typeof block.assertion === "string" &&
            LOCAL_GEMMA_ANSWER_ASSERTIONS_V1.has(block.assertion)
          ? block.assertion
          : block.assertion === undefined
            ? sourceRefs.length > 0 ? "positive" : "none"
            : block.assertion;
        const scope = typeof block.scope === "string" &&
            LOCAL_GEMMA_ANSWER_SCOPES_V1.has(block.scope)
          ? block.scope
          : block.scope === undefined
            ? assertion === "absence" ? "source" : "none"
            : block.scope;
        return { ...block, assertion, scope };
      })
    : call.arguments.blocks;
  return {
    ...call,
    arguments: {
      ...call.arguments,
      ...(blocks === undefined ? {} : { blocks }),
      // Gemma 4 E4B occasionally uses numeric zero as an empty collection.
      // This is unambiguous only for zero; every other non-array value remains
      // invalid and is rejected by the canonical structured-output schema.
      ...(call.arguments.gaps === 0 ? { gaps: [] } : {}),
    },
  };
}

function normalizeLocalGemmaToolCallsV1(
  calls: LocalModelToolCallV1[],
): LocalModelToolCallV1[] {
  return calls.map(normalizeLocalGemmaToolCallV1);
}

class LocalGemmaPortClientV1 {
  readonly #pending = new Map<string, {
    responses: LocalModelPortResponseV1[];
    wake?: () => void;
    done: boolean;
  }>();
  #sequence = 0;

  constructor(readonly port: MessagePort) {
    port.onmessage = (event: MessageEvent<LocalModelPortResponseV1>) => {
      const response = event.data;
      if (response.schema !== LOCAL_MODEL_PROTOCOL_SCHEMA_V1) return;
      const pending = this.#pending.get(response.requestId);
      if (!pending || pending.done) return;
      pending.responses.push(response);
      if (response.kind === "complete" || response.kind === "error") pending.done = true;
      pending.wake?.();
      pending.wake = undefined;
    };
    port.start();
  }

  async *generate(input: {
    messages: LocalModelChatMessageV1[];
    tools: LocalModelToolV1[];
    requiredToolName?: string;
    streamAnswerPreview?: boolean;
    maxOutputTokens: number;
    thinkingMode: LocalGemmaThinkingModeV1;
    signal?: AbortSignal;
  }): AsyncGenerator<LocalModelPortResponseV1> {
    const requestId = `generation-${Date.now()}-${++this.#sequence}`;
    const startedAt = Date.now();
    const pending = { responses: [], done: false } as {
      responses: LocalModelPortResponseV1[];
      wake?: () => void;
      done: boolean;
    };
    this.#pending.set(requestId, pending);
    const cancel = (): void => this.port.postMessage({
      schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
      kind: "cancel",
      requestId,
    } satisfies LocalModelPortRequestV1);
    this.port.postMessage({
      schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
      kind: "generate",
      requestId,
      messages: input.messages,
      tools: input.tools,
      ...(input.requiredToolName ? { requiredToolName: input.requiredToolName } : {}),
      ...(input.streamAnswerPreview ? { streamAnswerPreview: true } : {}),
      maxOutputTokens: input.maxOutputTokens,
      thinkingMode: input.thinkingMode,
    } satisfies LocalModelPortRequestV1);
    console.info("[local-gemma/proxy] request sent", {
      requestId,
      requiredToolName: input.requiredToolName,
      streamAnswerPreview: input.streamAnswerPreview === true,
      thinkingMode: input.thinkingMode,
      maxOutputTokens: input.maxOutputTokens,
      tools: input.tools.map((tool) => tool.function.name),
      messages: input.messages.map((message, index) => ({
        index,
        role: message.role,
        chars: message.content.length,
        preview: message.content.slice(-240),
      })),
    });
    input.signal?.addEventListener("abort", cancel, { once: true });
    if (input.signal?.aborted) cancel();
    try {
      while (!pending.done || pending.responses.length > 0) {
        if (pending.responses.length === 0) {
          await new Promise<void>((resolve) => { pending.wake = resolve; });
          continue;
        }
        const response = pending.responses.shift()!;
        if (response.kind === "answer-preview") {
          console.debug("[local-gemma/proxy] answer preview received", {
            requestId,
            markdownChars: response.markdown.length,
          });
        } else if (response.kind === "complete") {
          console.info("[local-gemma/proxy] request completed", {
            requestId,
            durationMs: Date.now() - startedAt,
            inputTokens: response.inputTokens,
            outputTokens: response.outputTokens,
            textChars: response.text.length,
            toolCalls: response.toolCalls.map((call) => call.name),
          });
        } else if (response.kind === "error") {
          console.error("[local-gemma/proxy] request failed", {
            requestId,
            durationMs: Date.now() - startedAt,
            code: response.code,
            error: response.error,
          });
        }
        yield response;
      }
    } finally {
      input.signal?.removeEventListener("abort", cancel);
      this.#pending.delete(requestId);
    }
  }
}

function localModelErrorV1(
  response: Extract<LocalModelPortResponseV1, { kind: "error" }>,
): Error {
  if (response.code === "context-overflow") {
    return new ContextOverflowError(response.error);
  }
  return new ResearchContractError(
    response.code === "cancelled"
      ? "cancelled"
      : response.code === "invalid-request"
        ? "invalid-request"
        : "provider-error",
    response.error,
  );
}

export class LocalGemmaChatModelV1 extends BaseChatModel<LocalGemmaCallOptionsV1> {
  readonly modelName = LOCAL_GEMMA_OPERATIONAL_PROFILE_V1.harnessKey;
  readonly #client: LocalGemmaPortClientV1;
  readonly #maxOutputTokens: number;
  readonly #thinkingMode: LocalGemmaThinkingModeV1;
  readonly #streamAnswerPreview: boolean;
  readonly #publishAnswerPreview?: (preview: ChatStructuredAnswerPreviewV1) => void;

  constructor(input: {
    client: LocalGemmaPortClientV1;
    maxOutputTokens: number;
    thinkingMode?: LocalGemmaThinkingModeV1;
    streamAnswerPreview?: boolean;
    publishAnswerPreview?: (preview: ChatStructuredAnswerPreviewV1) => void;
  }) {
    super({});
    this.#client = input.client;
    this.#maxOutputTokens = Math.min(
      input.maxOutputTokens,
      LOCAL_MODEL_RPC_LIMITS_V1.maxOutputTokens,
      LOCAL_GEMMA_OPERATIONAL_PROFILE_V1.maxOutputTokens,
    );
    this.#thinkingMode = input.thinkingMode ?? "disabled";
    this.#streamAnswerPreview = input.streamAnswerPreview === true;
    this.#publishAnswerPreview = input.publishAnswerPreview;
  }

  _llmType(): string { return "atlcli-local-gemma"; }

  override get profile(): ModelProfile {
    return {
      maxOutputTokens: this.#maxOutputTokens,
      reasoningOutput: true,
      toolCalling: true,
      toolChoice: true,
    };
  }

  bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<LocalGemmaCallOptionsV1>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, LocalGemmaCallOptionsV1> {
    return new RunnableBinding({
      bound: this,
      config: {},
      kwargs: {
        tools: tools.map((tool) => convertToOpenAITool(tool)),
        ...kwargs,
      },
    });
  }

  async _generate(
    messages: BaseMessage[],
    options: LocalGemmaCallOptionsV1,
  ): Promise<ChatResult> {
    let final: Extract<LocalModelPortResponseV1, { kind: "complete" }> | undefined;
    let previewMarkdown = "";
    for await (const response of this.#call(messages, options)) {
      if (response.kind === "error") throw localModelErrorV1(response);
      if (response.kind === "answer-preview") {
        previewMarkdown = response.markdown;
        console.debug("[local-gemma/proxy] answer preview published", {
          requestId: response.requestId,
          path: "generate",
          markdownChars: response.markdown.length,
        });
        this.#publishAnswerPreview?.({
          generationId: response.requestId,
          status: "snapshot",
          markdown: response.markdown,
        });
      }
      if (response.kind === "complete") final = response;
    }
    if (!final) throw new Error("Local Gemma ended without a terminal response.");
    const toolCalls = normalizeLocalGemmaToolCallsV1(final.toolCalls);
    if (previewMarkdown) {
      this.#publishAnswerPreview?.({
        generationId: final.requestId,
        status: "completed",
        markdown: previewMarkdown,
      });
    }
    return {
      generations: [{
        text: final.text,
        message: new AIMessage({
          content: final.text,
          additional_kwargs: final.thought && toolCalls.length > 0
            ? { localGemmaThought: final.thought }
            : {},
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            args: call.arguments,
            type: "tool_call" as const,
          })),
          usage_metadata: {
            input_tokens: final.inputTokens,
            output_tokens: final.outputTokens,
            total_tokens: final.inputTokens + final.outputTokens,
          },
        }),
      }],
    };
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: LocalGemmaCallOptionsV1,
  ): AsyncGenerator<ChatGenerationChunk> {
    let sawTextDelta = false;
    let previewMarkdown = "";
    for await (const response of this.#call(messages, options)) {
      if (response.kind === "error") throw localModelErrorV1(response);
      if (response.kind === "answer-preview") {
        previewMarkdown = response.markdown;
        console.debug("[local-gemma/proxy] answer preview published", {
          requestId: response.requestId,
          path: "stream",
          markdownChars: response.markdown.length,
        });
        this.#publishAnswerPreview?.({
          generationId: response.requestId,
          status: "snapshot",
          markdown: response.markdown,
        });
      } else if (response.kind === "text-delta") {
        sawTextDelta = true;
        yield new ChatGenerationChunk({
          text: response.text,
          message: new AIMessageChunk({ content: response.text }),
        });
      } else {
        const toolCalls = normalizeLocalGemmaToolCallsV1(response.toolCalls);
        if (previewMarkdown) {
          this.#publishAnswerPreview?.({
            generationId: response.requestId,
            status: "completed",
            markdown: previewMarkdown,
          });
        }
        yield new ChatGenerationChunk({
          text: sawTextDelta ? "" : response.text,
          message: new AIMessageChunk({
            content: sawTextDelta ? "" : response.text,
            additional_kwargs: response.thought && toolCalls.length > 0
              ? { localGemmaThought: response.thought }
              : {},
            tool_call_chunks: toolCalls.map((call, index) => ({
              id: call.id,
              name: call.name,
              args: JSON.stringify(call.arguments),
              index,
              type: "tool_call_chunk" as const,
            })),
            usage_metadata: {
              input_tokens: response.inputTokens,
              output_tokens: response.outputTokens,
              total_tokens: response.inputTokens + response.outputTokens,
            },
          }),
        });
      }
    }
  }

  #call(messages: BaseMessage[], options: LocalGemmaCallOptionsV1) {
    const requiredToolName = requiredToolNameV1(options.tool_choice);
    const declaredTools = toLocalToolsV1(options.tools, requiredToolName);
    const tools = requiredToolName
      ? declaredTools.filter((tool) => tool.function.name === requiredToolName)
      : declaredTools;
    if (requiredToolName && tools.length !== 1) {
      throw new Error(`The required local Gemma tool is not declared: ${requiredToolName}.`);
    }
    return this.#client.generate({
      messages: projectLocalGemmaToolProtocolV1(
        toLocalModelMessagesV1(messages, {
          // Once DeepAgents has selected an exact tool, the previous private
          // thought is neither evidence nor needed for routing. Omitting it
          // keeps the local finalization call inside the browser context
          // envelope without changing the canonical LangChain messages.
          retainPrivateThought: requiredToolName === undefined,
        }),
        tools,
        this.#thinkingMode,
        requiredToolName,
      ),
      tools,
      ...(requiredToolName ? { requiredToolName } : {}),
      ...(this.#streamAnswerPreview && requiredToolName === "ChatAnswerDraftV2"
        ? { streamAnswerPreview: true }
        : {}),
      maxOutputTokens: this.#maxOutputTokens,
      thinkingMode: this.#thinkingMode,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }
}

export function createLocalGemmaChatModelBindingV1(input: {
  port: MessagePort;
  modelId: string;
  maxOutputTokens: number;
}): ChatModelBindingV1 {
  const client = new LocalGemmaPortClientV1(input.port);
  const previewListeners = new Set<(
    preview: ChatStructuredAnswerPreviewV1,
  ) => void>();
  const publishAnswerPreview = (preview: ChatStructuredAnswerPreviewV1): void => {
    for (const listener of previewListeners) listener(preview);
  };
  const models = new Map<string, LocalGemmaChatModelV1>();
  const modelForThinking = (
    thinkingMode: LocalGemmaThinkingModeV1,
    maxOutputTokens = input.maxOutputTokens,
    streamAnswerPreview = false,
  ): LocalGemmaChatModelV1 => {
    const boundedOutputTokens = Math.min(
      maxOutputTokens,
      LOCAL_GEMMA_OPERATIONAL_PROFILE_V1.maxOutputTokens,
    );
    const key = `${thinkingMode}:${boundedOutputTokens}:${streamAnswerPreview}`;
    let model = models.get(key);
    if (!model) {
      model = new LocalGemmaChatModelV1({
        client,
        maxOutputTokens: boundedOutputTokens,
        thinkingMode,
        streamAnswerPreview,
        publishAnswerPreview,
      });
      models.set(key, model);
    }
    return model;
  };
  const model = modelForThinking("disabled", input.maxOutputTokens, true);
  return {
    model,
    modelId: input.modelId,
    qualityAdapter: {
      ...CAPABILITY_FREE_QUALITY_ADAPTER_V1,
      providerId: "local-gemma",
    },
    structuredOutput: "tool",
    subscribeStructuredAnswerPreview: (listener) => {
      previewListeners.add(listener);
      return () => previewListeners.delete(listener);
    },
    harnessProfile: {
      key: LOCAL_GEMMA_OPERATIONAL_PROFILE_V1.harnessKey,
      profile: LOCAL_GEMMA_HARNESS_PROFILE_V1,
    },
    runtimeLimits: {
      maxInputTokens: LOCAL_GEMMA_OPERATIONAL_PROFILE_V1.maxInputTokens,
      interpreterResultChars:
        LOCAL_GEMMA_OPERATIONAL_PROFILE_V1.maxInterpreterResultChars,
    },
    modelForPreference: (preference) =>
      modelForThinking(localGemmaThinkingModeV1(preference)),
    modelForRoute: (request) => {
      const finalizeOnly = ["drafting", "repair", "synthesis"].includes(request.role);
      const localThinkingMode = finalizeOnly
        ? "disabled"
        : localGemmaThinkingModeV1(request.preference);
      const maxOutputTokens = localGemmaRouteOutputTokensV1(
        request.role,
        input.maxOutputTokens,
      );
      return {
        model: modelForThinking(
          localThinkingMode,
          maxOutputTokens,
          request.role === "root-planning" || request.role === "synthesis",
        ),
        effectiveModelId: input.modelId,
        requestedPreference: request.preference,
        effectivePreference: finalizeOnly ? "fast" : request.preference,
        thinkingMode: localThinkingMode === "disabled"
          ? "disabled"
          : "adaptive-summary",
        finalizationCorridor: finalizeOnly ? "finalize-only" : "standard",
      };
    },
  };
}
