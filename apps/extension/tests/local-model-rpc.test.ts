import { describe, expect, it } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { parseGemma4ResponseV1 } from "../utils/local-model/gemma-response.js";
import { createLocalGemmaChatModelBindingV1 } from "../utils/local-model/langchain-proxy.js";
import {
  LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
  assertLocalModelGenerateRequestV1,
  type LocalModelPortRequestV1,
} from "../utils/local-model/protocol.js";
import { LocalModelWorkerHostV1 } from "../utils/local-model/worker-host.js";

describe("pinned Gemma 4 response grammar", () => {
  it("parses text and the native delimited tool-call arguments", () => {
    expect(parseGemma4ResponseV1({
      requestId: "r1",
      raw: '<|channel>thought\nprivate<channel|><|tool_call>call:eval{code:<|"|>return 42<|"|>,flags:[true,false],nested:{n:2}}<tool_call|><turn|>',
      allowedToolNames: new Set(["eval"]),
    })).toEqual({
      text: "",
      toolCalls: [{
        id: "local-r1-0",
        name: "eval",
        arguments: {
          code: "return 42",
          flags: [true, false],
          nested: { n: 2 },
        },
      }],
    });
    expect(parseGemma4ResponseV1({
      requestId: "r2",
      raw: "A local answer.<turn|>",
      allowedToolNames: new Set(),
    })).toEqual({ text: "A local answer.", toolCalls: [] });
  });

  it("rejects unknown, malformed, and empty responses", () => {
    expect(() => parseGemma4ResponseV1({
      requestId: "r",
      raw: "<|tool_call>call:unknown{}<tool_call|>",
      allowedToolNames: new Set(["eval"]),
    })).toThrow("unknown tool");
    expect(() => parseGemma4ResponseV1({
      requestId: "r",
      raw: "<|tool_call>call:eval{broken}<tool_call|>",
      allowedToolNames: new Set(["eval"]),
    })).toThrow();
    expect(() => parseGemma4ResponseV1({
      requestId: "r",
      raw: "<turn|>",
      allowedToolNames: new Set(),
    })).toThrow("neither text nor a tool call");
  });
});

describe("local model RPC boundary", () => {
  it("transfers one fresh port from the offscreen-owned worker host", () => {
    const sent: Array<{ message: unknown; transfer: Transferable[] }> = [];
    const host = new LocalModelWorkerHostV1("fixture/model", {
      postMessage(message, transfer) { sent.push({ message, transfer }); },
      terminate() {},
    });
    const binding = host.connect();
    expect(binding.kind).toBe("local-gemma");
    expect(binding.modelId).toBe("fixture/model");
    expect(binding.port).toBeInstanceOf(MessagePort);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.transfer).toEqual([
      (sent[0]!.message as { port: MessagePort }).port,
    ]);
    binding.port.close();
    (sent[0]!.message as { port: MessagePort }).port.close();
  });

  it("adapts LangChain messages/tools and returns a canonical AI tool call", async () => {
    const channel = new MessageChannel();
    let observed: LocalModelPortRequestV1 | undefined;
    channel.port2.onmessage = (event: MessageEvent<LocalModelPortRequestV1>) => {
      observed = event.data;
      if (observed.kind !== "generate") return;
      channel.port2.postMessage({
        schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
        kind: "complete",
        requestId: observed.requestId,
        text: "",
        toolCalls: [{ id: "call-1", name: "eval", arguments: { code: "return 1" } }],
        inputTokens: 12,
        outputTokens: 8,
      });
    };
    channel.port2.start();
    const binding = createLocalGemmaChatModelBindingV1({
      port: channel.port1,
      modelId: "fixture/model",
      maxOutputTokens: 128,
    });
    const runnable = binding.model.bindTools!([{
      type: "function",
      function: {
        name: "eval",
        description: "Evaluate bounded code",
        parameters: { type: "object", properties: { code: { type: "string" } } },
      },
    }]);
    const result = await runnable.invoke([new HumanMessage("Use eval")]);
    expect(observed).toMatchObject({
      schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
      kind: "generate",
      messages: [{ role: "user", content: "Use eval" }],
      tools: [{ type: "function", function: { name: "eval" } }],
      maxOutputTokens: 128,
    });
    expect(result.tool_calls).toEqual([
      { id: "call-1", name: "eval", args: { code: "return 1" }, type: "tool_call" },
    ]);
    expect(result.usage_metadata).toEqual({
      input_tokens: 12,
      output_tokens: 8,
      total_tokens: 20,
    });
    channel.port1.close();
    channel.port2.close();
  });

  it("rejects oversized envelopes before model execution", () => {
    const request = {
      schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
      kind: "generate",
      requestId: "r",
      messages: [{ role: "user", content: "x".repeat(300_000) }],
      tools: [],
      maxOutputTokens: 1,
    } as LocalModelPortRequestV1;
    expect(() => assertLocalModelGenerateRequestV1(request)).toThrow("byte limit");
  });

  it("rejects malformed envelopes without dereferencing attacker-controlled fields", () => {
    expect(() => assertLocalModelGenerateRequestV1(null)).toThrow("envelope");
    expect(() => assertLocalModelGenerateRequestV1({
      schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
      kind: "generate",
      requestId: "r",
      messages: "not-an-array",
      tools: [],
      maxOutputTokens: 1,
    })).toThrow("must be arrays");
  });

  it("propagates AbortSignal cancellation over the generation port", async () => {
    const channel = new MessageChannel();
    const observed: LocalModelPortRequestV1[] = [];
    channel.port2.onmessage = (event: MessageEvent<LocalModelPortRequestV1>) => {
      observed.push(event.data);
      if (event.data.kind === "cancel") {
        channel.port2.postMessage({
          schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
          kind: "error",
          requestId: event.data.requestId,
          code: "cancelled",
          error: "cancelled",
        });
      }
    };
    channel.port2.start();
    const binding = createLocalGemmaChatModelBindingV1({
      port: channel.port1,
      modelId: "fixture/model",
      maxOutputTokens: 32,
    });
    const controller = new AbortController();
    const invoked = binding.model.invoke([new HumanMessage("Stop")], {
      signal: controller.signal,
    });
    controller.abort();
    await expect(invoked).rejects.toThrow("cancelled");
    expect(observed.map((request) => request.kind)).toEqual(["generate", "cancel"]);
    channel.port1.close();
    channel.port2.close();
  });
});
