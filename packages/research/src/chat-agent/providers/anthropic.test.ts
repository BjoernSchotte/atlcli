import { describe, expect, it } from "bun:test";
import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "@langchain/core/tools";
import { createDeepAgent } from "deepagents/node";
import { providerStrategy, toolStrategy } from "langchain";
import { z } from "zod/v4";
import { chatQualityPolicyV1 } from "../../quality-policy.js";
import {
  anthropicOutputTokensForPreferenceV1,
  anthropicRootOutputTokensV1,
  createAnthropicChatModelBindingV1,
} from "./anthropic.js";

function syntheticAnthropicStream(): Response {
  const frames: unknown[] = [
    {
      type: "message_start",
      message: {
        id: "msg_synthetic_summary",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Checking the " },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "available evidence." },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "opaque-signature" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "redacted_thinking", data: "opaque-redacted-payload" },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "content_block_start",
      index: 2,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 2,
      delta: { type: "text_delta", text: "The answer is grounded." },
    },
    { type: "content_block_stop", index: 2 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 18 },
    },
    { type: "message_stop" },
  ];
  const body = frames.map((frame) => {
    const type = (frame as { type: string }).type;
    return `event: ${type}\ndata: ${JSON.stringify(frame)}\n\n`;
  }).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("Anthropic Chat model binding", () => {
  it("bounds child output by role without exceeding the root token contract", () => {
    expect(anthropicOutputTokensForPreferenceV1("fast", 8_000)).toBe(2_048);
    expect(anthropicOutputTokensForPreferenceV1("balanced", 8_000)).toBe(4_096);
    expect(anthropicOutputTokensForPreferenceV1("thorough", 8_000)).toBe(8_000);
    expect(anthropicOutputTokensForPreferenceV1("thorough", 1_024)).toBe(1_024);
    expect(anthropicRootOutputTokensV1("quick", 8_000)).toBe(4_096);
    expect(anthropicRootOutputTokensV1("auto", 8_000)).toBe(4_096);
    expect(anthropicRootOutputTokensV1("deep", 8_000)).toBe(8_000);
  });

  it("keeps Quick root synthesis larger than fast child packets", () => {
    const quick = createAnthropicChatModelBindingV1({
      credential: "synthetic-key",
      maxOutputTokens: 8_000,
      qualityPolicy: chatQualityPolicyV1("quick"),
    });
    expect(quick.model).toMatchObject({ maxTokens: 4_096 });
    expect(quick.modelForPreference?.("fast")).toMatchObject({ maxTokens: 2_048 });
  });

  it("maps a provider-neutral named tool choice to Anthropic's tool selector", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const model = new ChatAnthropic({
      model: "claude-sonnet-4-6",
      apiKey: "synthetic-key",
      maxTokens: 1_024,
      maxRetries: 0,
      streaming: false,
      clientOptions: {
        fetch: async (_url, init) => {
          requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({
            id: "msg_named_tool_choice",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{
              type: "tool_use",
              id: "tool_eval_1",
              name: "eval",
              input: { code: "return true" },
            }],
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: { input_tokens: 12, output_tokens: 8 },
          }), { headers: { "content-type": "application/json" } });
        },
      },
    });
    const evalTool = tool(
      async ({ code }) => code,
      {
        name: "eval",
        description: "Evaluate one admitted synthetic expression.",
        schema: z.object({ code: z.string() }).strict(),
      },
    );

    await model.bindTools([evalTool], { tool_choice: "eval" }).invoke([
      { role: "user", content: "Use the synthetic evaluator." },
    ]);

    expect(requestBody?.tool_choice).toEqual({ type: "tool", name: "eval" });
  });

  it("uses streaming models, provider-enforced structured output, and documented summarized reasoning", () => {
    const quick = createAnthropicChatModelBindingV1({
      credential: "synthetic-key",
      maxOutputTokens: 1_024,
      qualityPolicy: chatQualityPolicyV1("quick"),
    });
    const deep = createAnthropicChatModelBindingV1({
      credential: "synthetic-key",
      maxOutputTokens: 1_024,
      qualityPolicy: chatQualityPolicyV1("deep"),
    });

    expect(quick.model).toMatchObject({
      streaming: true,
      caller: { maxRetries: 1 },
      thinking: { type: "disabled" },
    });
    expect(quick.reasoningPresentation).toBeUndefined();
    expect(quick.structuredOutput).toBe("native");
    expect(quick.promptCache).toEqual({ ttl: "5m" });
    expect(deep.model).toMatchObject({
      streaming: true,
      thinking: { type: "adaptive", display: "summarized" },
    });
    expect(deep.reasoningPresentation).toBe("summary");
    expect(deep.structuredOutput).toBe("native");
    expect(deep.modelForPreference?.("fast")).toMatchObject({
      streaming: true,
      caller: { maxRetries: 1 },
      thinking: { type: "disabled" },
      outputConfig: { effort: "low" },
    });
    expect(deep.modelForPreference?.("balanced")).toMatchObject({
      streaming: true,
      thinking: { type: "adaptive", display: "summarized" },
      outputConfig: { effort: "medium" },
    });
    expect(deep.modelForPreference?.("thorough")).toBe(deep.model);
    expect(deep.modelForFinalization?.()).toMatchObject({
      maxTokens: 1_024,
      streaming: true,
      thinking: { type: "disabled" },
      outputConfig: { effort: "low" },
    });
    expect(deep.modelForRoute?.({
      role: "critique",
      preference: "balanced",
    })).toMatchObject({
      effectiveModelId: "claude-sonnet-4-6",
      requestedPreference: "balanced",
      effectivePreference: "balanced",
      thinkingMode: "adaptive-summary",
      finalizationCorridor: "standard",
    });
    expect(deep.modelForRoute?.({
      role: "synthesis",
      preference: "thorough",
    })).toMatchObject({
      effectiveModelId: "claude-sonnet-4-6",
      requestedPreference: "thorough",
      effectivePreference: "fast",
      thinkingMode: "disabled",
      finalizationCorridor: "finalize-only",
    });
    expect(deep.projectResponseSchema?.({
      type: "object",
      properties: {
        values: { type: "array", maxItems: 2, items: { type: "string" } },
      },
    })).toEqual({
      type: "object",
      properties: {
        values: { type: "array", items: { type: "string" } },
      },
    });
  });

  it("gives finalize-only synthesis a bounded non-thinking output corridor", () => {
    const binding = createAnthropicChatModelBindingV1({
      credential: "synthetic-key",
      maxOutputTokens: 8_000,
      qualityPolicy: chatQualityPolicyV1("auto"),
    });

    expect(binding.modelForFinalization?.()).toMatchObject({
      maxTokens: 5_000,
      thinking: { type: "disabled" },
      outputConfig: { effort: "low" },
    });
    expect(binding.modelForFinalization?.()).toBe(binding.modelForFinalization?.());
  });

  it("projects provider summaries through DeepAgents v3 reasoning without mixing answer or opaque blocks", async () => {
    const model = new ChatAnthropic({
      model: "claude-sonnet-4-6",
      apiKey: "synthetic-key",
      maxTokens: 1_024,
      maxRetries: 0,
      streaming: true,
      thinking: { type: "adaptive", display: "summarized" },
      clientOptions: { fetch: async () => syntheticAnthropicStream() },
    });
    const agent = createDeepAgent({
      name: "synthetic-stream-proof",
      model,
      systemPrompt: "Return one concise synthetic answer without tools.",
    });
    const run = await agent.streamEvents(
      { messages: [{ role: "user", content: "Use only synthetic evidence." }] },
      { version: "v3" },
    );
    let reasoning = "";
    let answerText = "";
    const consume = (async () => {
      for await (const message of run.messages) {
        const [messageReasoning, messageText] = await Promise.all([
          message.reasoning,
          message.text,
        ]);
        reasoning += messageReasoning;
        answerText += messageText;
      }
    })();
    await Promise.all([run.output, consume]);

    expect(reasoning).toBe("Checking the available evidence.");
    expect(answerText).toBe("The answer is grounded.");
    expect(reasoning).not.toContain("opaque-signature");
    expect(reasoning).not.toContain("opaque-redacted-payload");
    expect(reasoning).not.toContain(answerText);
  });

  it("streams quoted Markdown through ToolStrategy while the final output remains host-parseable", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const structuredAnswer = {
      messageMarkdown: 'The page calls this "Top 3" and remains grounded.',
      citationSourceIds: [] as string[],
      gaps: [] as Array<{ code: string; message: string; sourceIds: string[] }>,
    };
    const structuredJson = JSON.stringify(structuredAnswer);
    const model = new ChatAnthropic({
      model: "claude-sonnet-4-6",
      apiKey: "synthetic-key",
      maxTokens: 1_024,
      maxRetries: 0,
      streaming: true,
      thinking: { type: "adaptive", display: "summarized" },
      clientOptions: {
        fetch: async (_url, init) => {
          requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          const splitAt = structuredJson.indexOf("Top 3");
          const frames: unknown[] = [
            {
              type: "message_start",
              message: {
                id: "msg_tool_structured_summary",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-4-6",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 12, output_tokens: 0 },
              },
            },
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: "", signature: "" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: "Matching the answer to the evidence." },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "content_block_start",
              index: 1,
              content_block: {
                type: "tool_use",
                id: "tool_answer_1",
                name: "SyntheticChatAnswerV1",
                input: {},
              },
            },
            {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: structuredJson.slice(0, splitAt) },
            },
            {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: structuredJson.slice(splitAt) },
            },
            { type: "content_block_stop", index: 1 },
            {
              type: "message_delta",
              delta: { stop_reason: "tool_use", stop_sequence: null },
              usage: { output_tokens: 24 },
            },
            { type: "message_stop" },
          ];
          return new Response(frames.map((frame) => {
            const type = (frame as { type: string }).type;
            return `event: ${type}\ndata: ${JSON.stringify(frame)}\n\n`;
          }).join(""), { headers: { "content-type": "text/event-stream" } });
        },
      },
    });
    const answerSchema = z.object({
      messageMarkdown: z.string(),
      citationSourceIds: z.array(z.string()),
      gaps: z.array(z.object({
        code: z.string(),
        message: z.string(),
        sourceIds: z.array(z.string()),
      })),
    }).strict().meta({ title: "SyntheticChatAnswerV1" });
    const agent = createDeepAgent({
      name: "synthetic-tool-structured-stream-proof",
      model,
      tools: [],
      subagents: [],
      systemPrompt: "Return one concise synthetic structured answer without tools.",
      responseFormat: toolStrategy(answerSchema),
    });
    const run = await agent.streamEvents(
      { messages: [{ role: "user", content: "Use only synthetic evidence." }] },
      { version: "v3" },
    );
    let reasoning = "";
    const argumentSnapshots: string[] = [];
    const consume = (async () => {
      for await (const message of run.messages) {
        const [messageReasoning] = await Promise.all([
          message.reasoning,
          (async () => {
            for await (const event of message) {
              if (event.event !== "content-block-delta" ||
                event.delta.type !== "block-delta" ||
                event.delta.fields.type !== "tool_call_chunk" ||
                typeof event.delta.fields.args !== "string") continue;
              argumentSnapshots.push(event.delta.fields.args);
            }
          })(),
        ]);
        reasoning += messageReasoning;
      }
    })();
    const [result] = await Promise.all([run.output, consume]);

    expect(requestBody?.tool_choice).toEqual({ type: "any" });
    expect(requestBody?.output_config).toBeUndefined();
    expect(reasoning).toBe("Matching the answer to the evidence.");
    expect(argumentSnapshots.at(-1)).toBe(structuredJson);
    expect(result.structuredResponse).toEqual(structuredAnswer);
  });

  it("combines ordinary tools with Anthropic native structured output", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const structuredAnswer = {
      messageMarkdown: "The native answer remains grounded.",
      citationSourceIds: [] as string[],
      gaps: [] as Array<{ code: string; message: string; sourceIds: string[] }>,
    };
    const structuredJson = JSON.stringify(structuredAnswer);
    const model = new ChatAnthropic({
      model: "claude-sonnet-4-6",
      apiKey: "synthetic-key",
      maxTokens: 1_024,
      maxRetries: 0,
      streaming: true,
      clientOptions: {
        fetch: async (_url, init) => {
          requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          const frames: unknown[] = [
            {
              type: "message_start",
              message: {
                id: "msg_native_structured",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-4-6",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 12, output_tokens: 0 },
              },
            },
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: structuredJson },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 24 },
            },
            { type: "message_stop" },
          ];
          return new Response(frames.map((frame) => {
            const type = (frame as { type: string }).type;
            return `event: ${type}\ndata: ${JSON.stringify(frame)}\n\n`;
          }).join(""), { headers: { "content-type": "text/event-stream" } });
        },
      },
    });
    const answerSchema = z.object({
      messageMarkdown: z.string(),
      citationSourceIds: z.array(z.string()),
      gaps: z.array(z.object({
        code: z.string(),
        message: z.string(),
        sourceIds: z.array(z.string()),
      })),
    }).strict().meta({ title: "SyntheticNativeChatAnswerV1" });
    const agent = createDeepAgent({
      name: "synthetic-native-structured-proof",
      model,
      tools: [],
      subagents: [],
      systemPrompt: "Return the synthetic structured answer.",
      responseFormat: providerStrategy(answerSchema),
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "Use only synthetic evidence." }],
    });

    expect(requestBody?.tool_choice).toBeUndefined();
    expect(requestBody?.output_config).toEqual({
      format: expect.objectContaining({
        type: "json_schema",
        schema: expect.objectContaining({ title: "SyntheticNativeChatAnswerV1" }),
      }),
    });
    expect(result.structuredResponse).toEqual(structuredAnswer);
  });
});
