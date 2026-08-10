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
import type { Runnable } from "@langchain/core/runnables";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import type { BaseLanguageModelInput, ToolDefinition } from "@langchain/core/language_models/base";
import {
  CAPABILITY_FREE_QUALITY_ADAPTER_V1,
  type ChatModelBindingV1,
} from "@atlcli/research/browser/agent";
import {
  LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
  LOCAL_MODEL_RPC_LIMITS_V1,
  type LocalModelChatMessageV1,
  type LocalModelPortRequestV1,
  type LocalModelPortResponseV1,
  type LocalModelToolV1,
} from "./protocol.js";

interface LocalGemmaCallOptionsV1 extends BaseChatModelCallOptions {
  tools?: ToolDefinition[];
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

export function toLocalModelMessagesV1(messages: BaseMessage[]): LocalModelChatMessageV1[] {
  return messages.map((message): LocalModelChatMessageV1 => {
    const type = message.getType();
    const content = textContentV1(message);
    if (type === "system") return { role: "system", content };
    if (type === "human") return { role: "user", content };
    if (type === "ai") {
      const toolCalls = AIMessage.isInstance(message)
        ? message.tool_calls?.map((call) => ({
            id: call.id ?? `prior-${call.name}`,
            type: "function" as const,
            function: { name: call.name, arguments: call.args },
          }))
        : undefined;
      return {
        role: "assistant",
        content,
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      };
    }
    if (type === "tool" && ToolMessage.isInstance(message)) {
      if (!message.name) throw new Error("A local Gemma tool result requires a tool name.");
      return {
        role: "tool",
        content,
        name: message.name,
        tool_call_id: message.tool_call_id,
      };
    }
    throw new Error(`Unsupported local Gemma message type: ${type}.`);
  });
}

function toLocalToolsV1(tools: ToolDefinition[] | undefined): LocalModelToolV1[] {
  return (tools ?? []).map((tool) => {
    if (tool.type !== "function" || !tool.function?.name || !tool.function.parameters) {
      throw new Error("Local Gemma accepts only named function tools with JSON Schema parameters.");
    }
    return {
      type: "function",
      function: {
        name: tool.function.name,
        ...(tool.function.description ? { description: tool.function.description } : {}),
        parameters: tool.function.parameters,
      },
    };
  });
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
    maxOutputTokens: number;
    signal?: AbortSignal;
  }): AsyncGenerator<LocalModelPortResponseV1> {
    const requestId = `generation-${Date.now()}-${++this.#sequence}`;
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
      maxOutputTokens: input.maxOutputTokens,
    } satisfies LocalModelPortRequestV1);
    input.signal?.addEventListener("abort", cancel, { once: true });
    if (input.signal?.aborted) cancel();
    try {
      while (!pending.done || pending.responses.length > 0) {
        if (pending.responses.length === 0) {
          await new Promise<void>((resolve) => { pending.wake = resolve; });
          continue;
        }
        yield pending.responses.shift()!;
      }
    } finally {
      input.signal?.removeEventListener("abort", cancel);
      this.#pending.delete(requestId);
    }
  }
}

export class LocalGemmaChatModelV1 extends BaseChatModel<LocalGemmaCallOptionsV1> {
  readonly #client: LocalGemmaPortClientV1;
  readonly #maxOutputTokens: number;

  constructor(input: { client: LocalGemmaPortClientV1; maxOutputTokens: number }) {
    super({});
    this.#client = input.client;
    this.#maxOutputTokens = Math.min(
      input.maxOutputTokens,
      LOCAL_MODEL_RPC_LIMITS_V1.maxOutputTokens,
    );
  }

  _llmType(): string { return "atlcli-local-gemma"; }

  bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<LocalGemmaCallOptionsV1>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, LocalGemmaCallOptionsV1> {
    return this.withConfig({
      tools: tools.map((tool) => convertToOpenAITool(tool)),
      ...kwargs,
    });
  }

  async _generate(
    messages: BaseMessage[],
    options: LocalGemmaCallOptionsV1,
  ): Promise<ChatResult> {
    let final: Extract<LocalModelPortResponseV1, { kind: "complete" }> | undefined;
    for await (const response of this.#call(messages, options)) {
      if (response.kind === "error") throw new Error(response.error);
      if (response.kind === "complete") final = response;
    }
    if (!final) throw new Error("Local Gemma ended without a terminal response.");
    return {
      generations: [{
        text: final.text,
        message: new AIMessage({
          content: final.text,
          tool_calls: final.toolCalls.map((call) => ({
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
    for await (const response of this.#call(messages, options)) {
      if (response.kind === "error") throw new Error(response.error);
      if (response.kind === "text-delta") {
        sawTextDelta = true;
        yield new ChatGenerationChunk({
          text: response.text,
          message: new AIMessageChunk({ content: response.text }),
        });
      } else {
        yield new ChatGenerationChunk({
          text: sawTextDelta ? "" : response.text,
          message: new AIMessageChunk({
            content: sawTextDelta ? "" : response.text,
            tool_call_chunks: response.toolCalls.map((call, index) => ({
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
    return this.#client.generate({
      messages: toLocalModelMessagesV1(messages),
      tools: toLocalToolsV1(options.tools),
      maxOutputTokens: this.#maxOutputTokens,
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
  const model = new LocalGemmaChatModelV1({
    client,
    maxOutputTokens: input.maxOutputTokens,
  });
  return {
    model,
    modelId: input.modelId,
    qualityAdapter: {
      ...CAPABILITY_FREE_QUALITY_ADAPTER_V1,
      providerId: "local-gemma",
    },
    structuredOutput: "tool",
    modelForRoute: (request) => ({
      model,
      effectiveModelId: input.modelId,
      requestedPreference: request.preference,
      effectivePreference: request.preference,
      thinkingMode: "disabled",
      finalizationCorridor: "standard",
    }),
  };
}
