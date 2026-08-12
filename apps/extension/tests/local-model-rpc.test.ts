import { describe, expect, it } from "bun:test";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { z } from "zod";
import {
  LOCAL_GEMMA_ANSWER_TOOL_PREFILL_V1,
  LOCAL_GEMMA_FIRST_ANSWER_PREVIEW_TOKEN_V1,
  isCompleteGemmaToolCallV1,
  localGemmaAnswerToolPrefillV1,
  nextLocalGemmaAnswerPreviewTokenV1,
  parseGemma4ResponseV1,
  projectPartialGemmaAnswerMarkdownV1,
} from "../utils/local-model/gemma-response.js";
import {
  createLocalGemmaChatModelBindingV1,
  normalizeLocalGemmaAgenticEvalToolCallV1,
  normalizeLocalGemmaToolCallV1,
  toLocalModelMessagesV1,
} from "../utils/local-model/langchain-proxy.js";
import {
  LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
  assertLocalModelGenerateRequestV1,
  type LocalModelPortRequestV1,
} from "../utils/local-model/protocol.js";
import { LocalModelWorkerHostV1 } from "../utils/local-model/worker-host.js";

describe("pinned Gemma 4 response grammar", () => {
  it("polls every generated token until the first preview and then amortizes decoding", () => {
    expect(LOCAL_GEMMA_FIRST_ANSWER_PREVIEW_TOKEN_V1).toBe(1);
    expect(nextLocalGemmaAnswerPreviewTokenV1(1, false)).toBe(2);
    expect(nextLocalGemmaAnswerPreviewTokenV1(19, false)).toBe(20);
    expect(nextLocalGemmaAnswerPreviewTokenV1(20, true)).toBe(28);
  });

  it("prefills only forced streamed answer syntax so Markdown can start immediately", () => {
    expect(localGemmaAnswerToolPrefillV1({
      requiredToolName: "ChatAnswerDraftV2",
      streamAnswerPreview: true,
    })).toBe(LOCAL_GEMMA_ANSWER_TOOL_PREFILL_V1);
    expect(localGemmaAnswerToolPrefillV1({
      requiredToolName: "ChatAnswerDraftV2",
      streamAnswerPreview: false,
    })).toBe("");
    expect(localGemmaAnswerToolPrefillV1({
      requiredToolName: "ChatAnalysisPacketV1",
      streamAnswerPreview: true,
    })).toBe("");
    expect(projectPartialGemmaAnswerMarkdownV1(
      `${LOCAL_GEMMA_ANSWER_TOOL_PREFILL_V1}Purpose`,
      "ChatAnswerDraftV2",
    )).toBe("Purpose");
  });

  it("parses text and the native delimited tool-call arguments", () => {
    expect(parseGemma4ResponseV1({
      requestId: "r1",
      raw: '<|channel>thought\nprivate<channel|><|tool_call>call:eval{code:<|"|>return 42<|"|>,flags:[true,false],nested:{n:2}}<tool_call|><turn|>',
      allowedToolNames: new Set(["eval"]),
    })).toEqual({
      text: "",
      thought: "private",
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

  it("accepts a complete forced tool object before the optional close marker", () => {
    expect(parseGemma4ResponseV1({
      requestId: "markerless",
      raw: '<|tool_call>call:ChatAnswerDraftV2{blocks:[{markdown:<|"|>Budget<|"|>,sourceRefs:[],assertion:<|"|>none<|"|>,scope:<|"|>none<|"|>}],gaps:[]}',
      allowedToolNames: new Set(["ChatAnswerDraftV2"]),
    }).toolCalls).toEqual([{
      id: "local-markerless-0",
      name: "ChatAnswerDraftV2",
      arguments: {
        blocks: [{
          markdown: "Budget",
          sourceRefs: [],
          assertion: "none",
          scope: "none",
        }],
        gaps: [],
      },
    }]);
  });

  it("accepts only schema-declared bare string enum values", () => {
    const raw = '<|tool_call>call:ChatProvisionalAnswerDraftV1{blocks:[{assertion:none,markdown:<|"|>Supported.<|"|>,sourceRefs:[<|"|>source-1#section:one<|"|>],scope:none}]}';
    expect(parseGemma4ResponseV1({
      requestId: "declared-enum",
      raw,
      allowedToolNames: new Set(["ChatProvisionalAnswerDraftV1"]),
      bareStringEnumValues: new Set([
        "positive",
        "absence",
        "none",
        "source",
        "selected-sources",
        "bound-scope",
      ]),
    }).toolCalls[0]?.arguments).toEqual({
      blocks: [{
        assertion: "none",
        markdown: "Supported.",
        sourceRefs: ["source-1#section:one"],
        scope: "none",
      }],
    });
    expect(() => parseGemma4ResponseV1({
      requestId: "undeclared-enum",
      raw: raw.replace("assertion:none", "assertion:invented"),
      allowedToolNames: new Set(["ChatProvisionalAnswerDraftV1"]),
      bareStringEnumValues: new Set(["none"]),
    })).toThrow("Invalid Gemma tool argument");
    expect(() => parseGemma4ResponseV1({
      requestId: "no-enum-contract",
      raw,
      allowedToolNames: new Set(["ChatProvisionalAnswerDraftV1"]),
    })).toThrow("Invalid Gemma tool argument");
  });

  it("repairs omitted object separators only for the terminal answer", () => {
    const raw = '<|tool_call>call:ChatAnswerDraftV2{blocks:[{markdown:<|"|>Budget<|"|>sourceRefs:[] assertion:<|"|>positive<|"|>,scope:<|"|>none<|"|>}]gaps:[]}';
    expect(parseGemma4ResponseV1({
      requestId: "one-separator",
      raw,
      allowedToolNames: new Set(["ChatAnswerDraftV2"]),
    }).toolCalls[0]?.arguments).toEqual({
      blocks: [{
        markdown: "Budget",
        sourceRefs: [],
        assertion: "positive",
        scope: "none",
      }],
      gaps: [],
    });
    expect(isCompleteGemmaToolCallV1(raw, "ChatAnswerDraftV2")).toBe(true);

    expect(() => parseGemma4ResponseV1({
      requestId: "strict-eval",
      raw: '<|tool_call>call:eval{code:<|"|>return 42<|"|>flags:[]}',
      allowedToolNames: new Set(["eval"]),
    })).toThrow("missing ','");
  });

  it("repairs omitted separators only when the agentic proposal projection opts in", () => {
    const raw = '<|tool_call>call:eval{tasks:[{taskId:<|"|>reader<|"|>profileId:<|"|>exact-context-reader<|"|>objective:<|"|>Read the bound page.<|"|>dependencyTaskIds:[]}]maxConcurrency:1}';
    expect(() => parseGemma4ResponseV1({
      requestId: "strict-agentic-eval",
      raw,
      allowedToolNames: new Set(["eval"]),
    })).toThrow("missing ','");
    expect(parseGemma4ResponseV1({
      requestId: "projected-agentic-eval",
      raw,
      allowedToolNames: new Set(["eval"]),
      maximumImplicitObjectSeparators: 16,
    }).toolCalls[0]?.arguments).toEqual({
      tasks: [{
        taskId: "reader",
        profileId: "exact-context-reader",
        objective: "Read the bound page.",
        dependencyTaskIds: [],
      }],
      maxConcurrency: 1,
    });
  });

  it("ignores only a duplicated terminal boundary for an opted-in agentic proposal", () => {
    const raw = '<|tool_call>call:eval{tasks:[{taskId:<|"|>reader<|"|>,profileId:<|"|>exact-context-reader<|"|>,objective:<|"|>Read.<|"|>,dependencyTaskIds:[]}]}]}';
    expect(() => parseGemma4ResponseV1({
      requestId: "strict-agentic-boundary",
      raw,
      allowedToolNames: new Set(["eval"]),
    })).toThrow("complete object");
    expect(parseGemma4ResponseV1({
      requestId: "projected-agentic-boundary",
      raw,
      allowedToolNames: new Set(["eval"]),
      maximumTrailingStructuralClosers: 2,
    }).toolCalls[0]?.arguments).toEqual({
      tasks: [{
        taskId: "reader",
        profileId: "exact-context-reader",
        objective: "Read.",
        dependencyTaskIds: [],
      }],
    });
    expect(isCompleteGemmaToolCallV1(raw, "eval", 0, 2)).toBe(true);
  });

  it("closes only the omitted terminal root boundary", () => {
    const markerless = '<|tool_call>call:ChatAnswerDraftV2{blocks:[{markdown:<|"|>Complete<|"|>,sourceRefs:[]}]}';
    const raw = `${markerless}<tool_call|>`;
    expect(isCompleteGemmaToolCallV1(markerless, "ChatAnswerDraftV2")).toBe(true);
    expect(parseGemma4ResponseV1({
      requestId: "root-boundary",
      raw,
      allowedToolNames: new Set(["ChatAnswerDraftV2"]),
    }).toolCalls[0]?.arguments).toEqual({
      blocks: [{ markdown: "Complete", sourceRefs: [] }],
    });
    expect(() => parseGemma4ResponseV1({
      requestId: "nested-truncation",
      raw: '<|tool_call>call:ChatAnswerDraftV2{blocks:[{markdown:<|"|>Incomplete<|"|>,sourceRefs:[]]<tool_call|>',
      allowedToolNames: new Set(["ChatAnswerDraftV2"]),
    })).toThrow();
  });

  it("projects visible answer blocks from an incomplete native tool call", () => {
    expect(projectPartialGemmaAnswerMarkdownV1(
      '<|channel>thought\nprivate markdown:<|"|>hidden<|"|><channel|><|tool_call>call:ChatAnswerDraftV2{blocks:[{markdown:<|"|>Budget: 60,000–85,000 EUR<|"|>,sourceRefs:[<|"|>source-1<|"|>],assertion:<|"|>positive<|"|>,scope:<|"|>none<|"|>},{markdown:<|"|>Base fee: 30,000',
      "ChatAnswerDraftV2",
    )).toBe("Budget: 60,000–85,000 EUR\n\nBase fee: 30,000");
  });

  it("hides unresolved host-private source IDs from the streamed preview", () => {
    expect(projectPartialGemmaAnswerMarkdownV1(
      '<|tool_call>call:ChatAnswerDraftV2{blocks:[{markdown:<|"|>Budget: 60,000 EUR [wiki:1001#section:004:budget]<|"|>},{markdown:<|"|>Base fee: 30,000 EUR [jira:DEMO-1<|"|>',
      "ChatAnswerDraftV2",
    )).toBe("Budget: 60,000 EUR\n\nBase fee: 30,000 EUR");
  });

  it("does not project thought or non-answer tool fields", () => {
    expect(projectPartialGemmaAnswerMarkdownV1(
      '<|channel>thought\nmarkdown:<|"|>secret<|"|><channel|><|tool_call>call:eval{code:<|"|>return { markdown: \'not an answer\' }<|"|>}',
      "ChatAnswerDraftV2",
    )).toBe("");
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

  it("rejects a QuickJS namespace call instead of changing its semantics", () => {
    expect(() => parseGemma4ResponseV1({
      requestId: "namespace",
      raw: '<|tool_call>call:tools.atlassianBoundRead{anchorRef:<|"|>research-anchor:page-1<|"|>}<tool_call|><turn|>',
      allowedToolNames: new Set(["eval", "ChatAnswerDraftV2"]),
    })).toThrow("unknown tool: tools.atlassianBoundRead");
  });

  it("rejects unknown QuickJS namespaces and never bypasses a missing eval tool", () => {
    expect(() => parseGemma4ResponseV1({
      requestId: "unknown-namespace",
      raw: "<|tool_call>call:tools.fetch{url:<|\"|>https://example.test<|\"|>}<tool_call|>",
      allowedToolNames: new Set(["eval"]),
    })).toThrow("unknown tool: tools.fetch");
    expect(() => parseGemma4ResponseV1({
      requestId: "missing-eval",
      raw: "<|tool_call>call:tools.atlassianBoundRead{anchorRef:<|\"|>research-anchor:page-1<|\"|>}<tool_call|>",
      allowedToolNames: new Set(["ChatAnswerDraftV2"]),
    })).toThrow("unknown tool: tools.atlassianBoundRead");
  });
});

describe("local model RPC boundary", () => {
  it("compiles a provider-local agentic proposal into the canonical eval program", () => {
    const normalized = normalizeLocalGemmaAgenticEvalToolCallV1({
      id: "agentic-proposal",
      name: "eval",
      arguments: {
        tasks: [{
          taskId: "reader",
          profileId: "exact-context-reader",
          objective: "Read the bound page.",
          dependencyTaskIds: [],
        }],
        maxConcurrency: 1,
        description: "provider-only prose must not reach QuickJS",
        retrievalPlan: {
          relationshipTraversals: [{
            traversalId: "cross-reference",
            kind: "confluence-to-jira-reference",
            maxDepth: 0,
            externalId: "must-not-cross-the-adapter",
          }],
          relatedAnchors: [{ externalId: "must-not-cross-the-adapter" }],
        },
      },
    });

    expect(normalized.name).toBe("eval");
    expect(normalized.arguments).toEqual({
      code: expect.stringContaining("await tools.chatWorkflowPropose(proposal);"),
    });
    expect(String(normalized.arguments.code)).toContain(
      "await tools.chatWorkflowRun({})",
    );
    expect(String(normalized.arguments.code)).toContain(
      '\"profileId\":\"exact-context-reader\"',
    );
    expect(String(normalized.arguments.code)).toContain(
      '\"maxDepth\":1',
    );
    expect(String(normalized.arguments.code)).not.toContain("description");
    expect(String(normalized.arguments.code)).not.toContain("externalId");
  });

  it("supplies the singleton local concurrency without selecting model tasks", () => {
    const normalized = normalizeLocalGemmaAgenticEvalToolCallV1({
      id: "agentic-proposal-without-concurrency",
      name: "eval",
      arguments: {
        tasks: [{
          taskId: "reader",
          profileId: "exact-context-reader",
          objective: "Read the bound page.",
          dependencyTaskIds: [],
        }],
      },
    });

    expect(String(normalized.arguments.code)).toContain('"maxConcurrency":1');
    expect(String(normalized.arguments.code)).toContain(
      '"profileId":"exact-context-reader"',
    );
  });

  it("normalizes the pinned Gemma empty-gap and omitted block metadata shortcuts", () => {
    expect(normalizeLocalGemmaToolCallV1({
      id: "answer-1",
      name: "ChatAnswerDraftV2",
      arguments: {
        blocks: [{
          markdown: "1. A source-bound answer.",
          sourceRefs: ["wiki:1172799499"],
        }, {
          markdown: "A short heading",
          sourceRefs: [],
        }],
        gaps: 0,
      },
    })).toEqual({
      id: "answer-1",
      name: "ChatAnswerDraftV2",
      arguments: {
        blocks: [{
          markdown: "1. A source-bound answer.",
          sourceRefs: ["wiki:1172799499"],
          assertion: "positive",
          scope: "none",
        }, {
          markdown: "A short heading",
          sourceRefs: [],
          assertion: "none",
          scope: "none",
        }],
        gaps: [],
      },
    });

    expect(normalizeLocalGemmaToolCallV1({
      id: "answer-without-gaps",
      name: "ChatAnswerDraftV2",
      arguments: { blocks: [] },
    }).arguments.gaps).toEqual([]);
  });

  it("normalizes omitted block metadata for every local Gemma answer-draft tool", () => {
    for (const name of [
      "ChatProvisionalAnswerDraftV1",
      "ChatRepairedAnswerDraftV1",
      "ChatAnswerDraftV2",
    ]) {
      expect(normalizeLocalGemmaToolCallV1({
        id: `draft-${name}`,
        name,
        arguments: {
          blocks: [{
            markdown: "A supported statement.",
            sourceRefs: ["source-1#section:one"],
            assertion: "positive",
          }, {
            markdown: "Nothing relevant was found in the selected source.",
            sourceRefs: ["source-1#section:two"],
            assertion: "absence",
          }, {
            markdown: "Summary",
          }],
        },
      }).arguments).toEqual({
        blocks: [{
          markdown: "A supported statement.",
          sourceRefs: ["source-1#section:one"],
          assertion: "positive",
          scope: "none",
        }, {
          markdown: "Nothing relevant was found in the selected source.",
          sourceRefs: ["source-1#section:two"],
          assertion: "absence",
          scope: "source",
        }, {
          markdown: "Summary",
          assertion: "none",
          scope: "none",
        }],
        gaps: [],
      });
    }
  });

  it("does not normalize explicit unknown answer metadata", () => {
    expect(normalizeLocalGemmaToolCallV1({
      id: "answer-invalid",
      name: "ChatAnswerDraftV2",
      arguments: {
        blocks: [{
          markdown: "Invalid metadata stays invalid.",
          sourceRefs: [],
          assertion: "maybe",
          scope: "everywhere",
        }],
        gaps: 1,
      },
    }).arguments).toEqual({
      blocks: [{
        markdown: "Invalid metadata stays invalid.",
        sourceRefs: [],
        assertion: "maybe",
        scope: "everywhere",
      }],
      gaps: 1,
    });
  });

  it("retains private Gemma thought only inside the active tool-calling turn", () => {
    const messages = toLocalModelMessagesV1([
      new AIMessage({
        content: "",
        additional_kwargs: { localGemmaThought: "inspect declared tools" },
        tool_calls: [{
          id: "call-1",
          name: "eval",
          args: { code: "return 1" },
          type: "tool_call",
        }],
      }),
    ]);

    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: "<|channel>thought\ninspect declared tools<channel|>",
    });
  });

  it("recovers a nameless DeepAgents tool result from its preceding call id", () => {
    const messages = toLocalModelMessagesV1([
      new AIMessage({
        content: "",
        tool_calls: [{
          id: "local-eval-1",
          name: "eval",
          args: { code: "return 1" },
          type: "tool_call",
        }],
      }),
      new ToolMessage({
        content: "bounded evidence",
        tool_call_id: "local-eval-1",
      }),
    ]);

    expect(messages[1]).toMatchObject({
      role: "tool",
      name: "eval",
      tool_call_id: "local-eval-1",
    });
  });

  it("drops prior private thought once the host selects the exact next tool", () => {
    const messages = toLocalModelMessagesV1([
      new AIMessage({
        content: "",
        additional_kwargs: { localGemmaThought: "long private acquisition reasoning" },
        tool_calls: [{
          id: "local-eval-1",
          name: "eval",
          args: { code: "return 1" },
          type: "tool_call",
        }],
      }),
      new ToolMessage({
        content: "bounded evidence",
        tool_call_id: "local-eval-1",
      }),
    ], { retainPrivateThought: false });

    expect(messages[0]).toMatchObject({ role: "assistant", content: "" });
    expect(messages[1]).toMatchObject({ role: "tool", name: "eval" });
    expect(JSON.stringify(messages)).not.toContain("private acquisition reasoning");
  });

  it("keeps the complete human message when no host projection replaces it", () => {
    const messages = toLocalModelMessagesV1([
      new HumanMessage([
        'User question: "What is the budget?"',
        "Address the user's substantive request by meaning, using natural wording.",
        "Use supported evidence or state a precise material gap.",
        "Attached host-bound entities (opaque refs only): a large routing envelope.",
        `Durable conversation context: ${"x".repeat(8_000)}`,
      ].join("\n")),
    ]);

    expect(messages).toEqual([{ role: "user", content: [
      'User question: "What is the budget?"',
      "Address the user's substantive request by meaning, using natural wording.",
      "Use supported evidence or state a precise material gap.",
      "Attached host-bound entities (opaque refs only): a large routing envelope.",
      `Durable conversation context: ${"x".repeat(8_000)}`,
    ].join("\n") }]);
  });

  it("rejects a nameless tool result without a matching preceding call", () => {
    expect(() => toLocalModelMessagesV1([
      new ToolMessage({ content: "orphan", tool_call_id: "missing" }),
    ])).toThrow("could not be matched to its call id: missing");
  });

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
    const result = await runnable.invoke([
      new SystemMessage("Stable agent contract."),
      new HumanMessage("Use eval"),
    ]);
    expect(observed).toMatchObject({
      schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
      kind: "generate",
      messages: [
        { role: "system" },
        { role: "user", content: "Use eval" },
      ],
      tools: [{ type: "function", function: { name: "eval" } }],
      maxOutputTokens: 128,
      thinkingMode: "disabled",
    });
    if (observed?.kind !== "generate") throw new Error("Expected a generation request.");
    const system = observed.messages.find((message) => message.role === "system");
    if (!system) throw new Error("Expected the projected system message.");
    expect(system.content.includes("Stable agent contract.")).toBe(true);
    expect(system.content.includes("complete list of functions you may call directly is: `eval`")).toBe(true);
    expect(system.content.includes("`tools` is a JavaScript namespace")).toBe(true);
    expect(system.content.includes("Never emit a tool call whose function name is `tools`")).toBe(true);
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

  it("adds a local-only tool boundary without mutating tool-free chat", async () => {
    const channel = new MessageChannel();
    const requests: LocalModelPortRequestV1[] = [];
    channel.port2.onmessage = (event: MessageEvent<LocalModelPortRequestV1>) => {
      requests.push(event.data);
      if (event.data.kind !== "generate") return;
      channel.port2.postMessage({
        schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
        kind: "complete",
        requestId: event.data.requestId,
        text: "Local answer.",
        toolCalls: [],
        inputTokens: 4,
        outputTokens: 2,
      });
    };
    channel.port2.start();
    const binding = createLocalGemmaChatModelBindingV1({
      port: channel.port1,
      modelId: "fixture/model",
      maxOutputTokens: 32,
    });

    await binding.model.invoke([new HumanMessage("Hello")]);
    expect(requests[0]).toMatchObject({
      kind: "generate",
      messages: [{ role: "user", content: "Hello" }],
      tools: [],
    });
    channel.port1.close();
    channel.port2.close();
  });

  it("publishes one metadata-only performance sample for a completed call", async () => {
    const channel = new MessageChannel();
    channel.port2.onmessage = (event: MessageEvent<LocalModelPortRequestV1>) => {
      if (event.data.kind !== "generate") return;
      channel.port2.postMessage({
        schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
        kind: "complete",
        requestId: event.data.requestId,
        text: "Measured answer.",
        toolCalls: [],
        inputTokens: 40,
        outputTokens: 5,
        performance: {
          runtimeState: "warm",
          queuedMs: 1,
          runtimeLoadMs: 0,
          tokenizeMs: 2,
          firstTokenMs: 12,
          generationMs: 20,
          totalMs: 24,
        },
      });
    };
    channel.port2.start();
    const samples: unknown[] = [];
    const binding = createLocalGemmaChatModelBindingV1({
      port: channel.port1,
      modelId: "fixture/model",
      maxOutputTokens: 32,
      onPerformanceSample: (sample) => samples.push(sample),
    });

    await binding.model.invoke([new HumanMessage("Hello")]);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      inputTokens: 40,
      outputTokens: 5,
      timing: { runtimeState: "warm", totalMs: 24 },
    });
    expect(JSON.stringify(samples[0])).not.toContain("Measured answer");
    channel.port1.close();
    channel.port2.close();
  });

  it("projects a named LangChain tool choice into one required Gemma tool", async () => {
    const channel = new MessageChannel();
    let observed: LocalModelPortRequestV1 | undefined;
    channel.port2.onmessage = (event: MessageEvent<LocalModelPortRequestV1>) => {
      observed = event.data;
      if (event.data.kind !== "generate") return;
      channel.port2.postMessage({
        schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
        kind: "complete",
        requestId: event.data.requestId,
        text: "",
        toolCalls: [{
          id: "required-answer",
          name: "ChatAnswerDraftV2",
          arguments: { blocks: [], gaps: [] },
        }],
        inputTokens: 4,
        outputTokens: 2,
      });
    };
    channel.port2.start();
    const binding = createLocalGemmaChatModelBindingV1({
      port: channel.port1,
      modelId: "fixture/model",
      maxOutputTokens: 1_024,
    });
    const runnable = binding.model.bindTools!([
      { name: "eval", description: "Evaluate", schema: z.object({ code: z.string() }) },
      {
        name: "ChatAnswerDraftV2",
        description: "Answer",
        schema: z.object({ blocks: z.array(z.unknown()), gaps: z.array(z.unknown()) }),
      },
    ], { tool_choice: "ChatAnswerDraftV2" });

    await runnable.invoke([new HumanMessage("Finish")]);
    expect(observed).toMatchObject({
      kind: "generate",
      requiredToolName: "ChatAnswerDraftV2",
      maxOutputTokens: 896,
      tools: [{ function: { name: "ChatAnswerDraftV2" } }],
    });
    if (observed?.kind !== "generate") throw new Error("Expected generation request.");
    expect(JSON.stringify(observed.tools[0])).toContain('"maxItems":8');
    expect(JSON.stringify(observed.tools[0])).not.toContain("continuation");
    expect(JSON.stringify(observed.tools[0]).length).toBeLessThan(850);
    expect(observed.tools[0]!.function.parameters).toMatchObject({
      properties: {
        blocks: {
          items: {
            required: ["markdown", "sourceRefs"],
            properties: {
              assertion: { type: "string" },
              scope: { type: "string" },
            },
          },
        },
      },
    });
    expect(observed.messages[0]!.content).toContain(
      "Return only `<|tool_call>call:ChatAnswerDraftV2`",
    );
    channel.port1.close();
    channel.port2.close();
  });

  it("binds a sole DeepAgents structured packet without provider thought", async () => {
    const channel = new MessageChannel();
    let observed: LocalModelPortRequestV1 | undefined;
    channel.port2.onmessage = (event: MessageEvent<LocalModelPortRequestV1>) => {
      observed = event.data;
      if (event.data.kind !== "generate") return;
      channel.port2.postMessage({
        schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
        kind: "complete",
        requestId: event.data.requestId,
        text: "",
        toolCalls: [{
          id: "structured-packet",
          name: "ChatAnalysisPacketV1",
          arguments: { claimRefs: [], relationshipRefs: [], contradictions: [], gaps: [] },
        }],
        inputTokens: 32,
        outputTokens: 12,
      });
    };
    channel.port2.start();
    const binding = createLocalGemmaChatModelBindingV1({
      port: channel.port1,
      modelId: "fixture/model",
      maxOutputTokens: 1_024,
    });
    const runnable = binding.model.bindTools!([{
      name: "ChatAnalysisPacketV1",
      description: "Return the analysis packet.",
      schema: z.object({
        claimRefs: z.array(z.unknown()),
        relationshipRefs: z.array(z.unknown()),
        contradictions: z.array(z.unknown()),
        gaps: z.array(z.unknown()),
      }),
    }]);

    await runnable.invoke([new HumanMessage("Analyze the supplied evidence.")]);

    expect(observed).toMatchObject({
      kind: "generate",
      requiredToolName: "ChatAnalysisPacketV1",
      thinkingMode: "disabled",
      tools: [{ function: { name: "ChatAnalysisPacketV1" } }],
    });
    channel.port1.close();
    channel.port2.close();
  });

  it("adds enum-implied types required by the Gemma tool template", async () => {
    const channel = new MessageChannel();
    let observed: LocalModelPortRequestV1 | undefined;
    channel.port2.onmessage = (event: MessageEvent<LocalModelPortRequestV1>) => {
      observed = event.data;
      if (event.data.kind !== "generate") return;
      channel.port2.postMessage({
        schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
        kind: "complete",
        requestId: event.data.requestId,
        text: "",
        toolCalls: [{
          id: "provisional-answer",
          name: "ChatProvisionalAnswerDraftV1",
          arguments: {
            blocks: [{
              markdown: "Supported statement.",
              sourceRefs: ["source-1#section:one"],
              assertion: "positive",
              scope: "none",
            }],
          },
        }],
        inputTokens: 32,
        outputTokens: 24,
      });
    };
    channel.port2.start();
    const binding = createLocalGemmaChatModelBindingV1({
      port: channel.port1,
      modelId: "fixture/model",
      maxOutputTokens: 1_024,
    });
    const runnable = binding.model.bindTools!([{
      type: "function",
      function: {
        name: "ChatProvisionalAnswerDraftV1",
        description: "Return a provisional answer.",
        parameters: {
          type: "object",
          required: ["blocks"],
          properties: {
            blocks: {
              type: "array",
              items: {
                type: "object",
                required: ["markdown", "sourceRefs", "assertion", "scope"],
                properties: {
                  markdown: { type: "string" },
                  sourceRefs: { type: "array", items: { type: "string" } },
                  assertion: { enum: ["positive", "absence", "none"] },
                  scope: { enum: ["none", "source", "selected-sources", "bound-scope"] },
                },
              },
            },
          },
        },
      },
    }], { tool_choice: "ChatProvisionalAnswerDraftV1" });

    await runnable.invoke([new HumanMessage("Draft the answer.")]);

    expect(observed).toMatchObject({
      kind: "generate",
      requiredToolName: "ChatProvisionalAnswerDraftV1",
      tools: [{
        function: {
          parameters: {
            properties: {
              blocks: {
                items: {
                  properties: {
                    assertion: { type: "string" },
                    scope: { type: "string" },
                  },
                },
              },
            },
          },
        },
      }],
    });
    channel.port1.close();
    channel.port2.close();
  });

  it("binds the sole reader packet only after its host read result", async () => {
    const channel = new MessageChannel();
    const observed: LocalModelPortRequestV1[] = [];
    channel.port2.onmessage = (event: MessageEvent<LocalModelPortRequestV1>) => {
      observed.push(event.data);
      if (event.data.kind !== "generate") return;
      channel.port2.postMessage({
        schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
        kind: "complete",
        requestId: event.data.requestId,
        text: "",
        toolCalls: [{
          id: "reader-packet",
          name: "ChatEvidencePacketV1",
          arguments: { claims: [], relationships: [], gaps: [] },
        }],
        inputTokens: 32,
        outputTokens: 12,
      });
    };
    channel.port2.start();
    const binding = createLocalGemmaChatModelBindingV1({
      port: channel.port1,
      modelId: "fixture/model",
      maxOutputTokens: 1_024,
    });
    const runnable = binding.model.bindTools!([{
      name: "chat_exact_context_acquire",
      description: "Read the exact context.",
      schema: z.object({}),
    }, {
      name: "ChatEvidencePacketV1",
      description: "Return the evidence packet.",
      schema: z.object({
        claims: z.array(z.unknown()),
        relationships: z.array(z.unknown()),
        gaps: z.array(z.unknown()),
      }),
    }]);

    await runnable.invoke([new HumanMessage("Read first.")]);
    await runnable.invoke([
      new HumanMessage("Read first."),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "read-1", name: "chat_exact_context_acquire", args: {} }],
      }),
      new ToolMessage({
        content: "Bound evidence.",
        tool_call_id: "read-1",
        name: "chat_exact_context_acquire",
      }),
    ]);

    expect(observed[0]).toMatchObject({
      kind: "generate",
      tools: [
        { function: { name: "chat_exact_context_acquire" } },
        { function: { name: "ChatEvidencePacketV1" } },
      ],
    });
    expect(observed[0] && "requiredToolName" in observed[0]).toBe(false);
    expect(observed[1]).toMatchObject({
      kind: "generate",
      requiredToolName: "ChatEvidencePacketV1",
      tools: [{ function: { name: "ChatEvidencePacketV1" } }],
    });
    channel.port1.close();
    channel.port2.close();
  });

  it("restores forced structured envelope constants without repairing evidence", async () => {
    const channel = new MessageChannel();
    let observed: LocalModelPortRequestV1 | undefined;
    channel.port2.onmessage = (event: MessageEvent<LocalModelPortRequestV1>) => {
      observed = event.data;
      if (event.data.kind !== "generate") return;
      channel.port2.postMessage({
        schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
        kind: "complete",
        requestId: event.data.requestId,
        text: "",
        toolCalls: [{
          id: "evidence-packet",
          name: "ChatEvidencePacketV1",
          arguments: {
            schema: "atlcli.agentic-task-dispatch/v1",
            claims: [{
              text: "A supported claim.",
              sourceIds: ["wiki:source-1"],
              sourceRefs: ["wiki:source-1#section:one"],
            }],
          },
        }],
        inputTokens: 32,
        outputTokens: 64,
      });
    };
    channel.port2.start();
    const binding = createLocalGemmaChatModelBindingV1({
      port: channel.port1,
      modelId: "fixture/model",
      maxOutputTokens: 1_024,
    });
    const runnable = binding.model.bindTools!([{
      name: "ChatEvidencePacketV1",
      description: "Return the evidence packet.",
      schema: z.object({
        schema: z.literal("atlcli.chat-evidence-packet/v1"),
        sourceIds: z.array(z.string()),
        claims: z.array(z.unknown()),
        relationships: z.array(z.unknown()),
        gaps: z.array(z.string()),
      }),
    }]);

    const result = await runnable.invoke([new HumanMessage("Return the packet.")]);

    expect(observed).toMatchObject({
      kind: "generate",
      requiredToolName: "ChatEvidencePacketV1",
    });
    if (!observed || observed.kind !== "generate") throw new Error("Missing request.");
    const parameters = observed.tools[0]!.function.parameters;
    expect((parameters.properties as Record<string, unknown>).schema).toBeUndefined();
    expect(parameters.required).not.toContain("schema");
    expect(result.tool_calls?.[0]?.args).toEqual({
      schema: "atlcli.chat-evidence-packet/v1",
      sourceIds: ["wiki:source-1"],
      claims: [{
        text: "A supported claim.",
        sourceIds: ["wiki:source-1"],
        sourceRefs: ["wiki:source-1#section:one"],
      }],
      relationships: [],
      gaps: [],
    });
    channel.port1.close();
    channel.port2.close();
  });

  it("publishes local answer previews without changing the canonical tool call", async () => {
    const channel = new MessageChannel();
    let observed: LocalModelPortRequestV1 | undefined;
    channel.port2.onmessage = (event: MessageEvent<LocalModelPortRequestV1>) => {
      observed = event.data;
      if (event.data.kind !== "generate") return;
      channel.port2.postMessage({
        schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
        kind: "answer-preview",
        requestId: event.data.requestId,
        markdown: "Budget: 60,000–85,000 EUR",
      });
      channel.port2.postMessage({
        schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
        kind: "complete",
        requestId: event.data.requestId,
        text: "",
        toolCalls: [{
          id: "required-answer",
          name: "ChatAnswerDraftV2",
          arguments: {
            blocks: [{
              markdown: "Budget: 60,000–85,000 EUR",
              sourceRefs: ["source-1"],
              assertion: "positive",
              scope: "none",
            }],
            gaps: [],
          },
        }],
        inputTokens: 20,
        outputTokens: 40,
      });
    };
    channel.port2.start();
    const binding = createLocalGemmaChatModelBindingV1({
      port: channel.port1,
      modelId: "fixture/model",
      maxOutputTokens: 512,
    });
    const previews: unknown[] = [];
    const unsubscribe = binding.subscribeStructuredAnswerPreview?.((preview) => {
      previews.push(preview);
    });
    const routedRootModel = binding.modelForRoute?.({
      role: "root-planning",
      preference: "fast",
    }).model;
    if (!routedRootModel) throw new Error("Expected the local root model route.");
    const runnable = routedRootModel.bindTools!([{
      name: "ChatAnswerDraftV2",
      description: "Answer",
      schema: z.object({ blocks: z.array(z.unknown()), gaps: z.array(z.unknown()) }),
    }], { tool_choice: "ChatAnswerDraftV2" });

    const result = await runnable.invoke([new HumanMessage("Finish")]);

    expect(observed).toMatchObject({
      kind: "generate",
      requiredToolName: "ChatAnswerDraftV2",
      streamAnswerPreview: true,
    });
    expect(previews).toEqual([
      {
        generationId: expect.any(String),
        status: "snapshot",
        markdown: "Budget: 60,000–85,000 EUR",
      },
      {
        generationId: expect.any(String),
        status: "completed",
        markdown: "Budget: 60,000–85,000 EUR",
      },
    ]);
    expect(result.tool_calls?.[0]).toMatchObject({
      name: "ChatAnswerDraftV2",
      args: { blocks: [{ scope: "none" }], gaps: [] },
    });
    unsubscribe?.();
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
      thinkingMode: "disabled",
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
      thinkingMode: "disabled",
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

  it("preserves a typed, actionable local runtime failure", async () => {
    const channel = new MessageChannel();
    channel.port2.onmessage = (event: MessageEvent<LocalModelPortRequestV1>) => {
      if (event.data.kind !== "generate") return;
      channel.port2.postMessage({
        schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
        kind: "error",
        requestId: event.data.requestId,
        code: "model-error",
        error: "Synthetic local runtime failed before generation.",
      });
    };
    channel.port2.start();
    const binding = createLocalGemmaChatModelBindingV1({
      port: channel.port1,
      modelId: "fixture/model",
      maxOutputTokens: 32,
    });

    await expect(binding.model.invoke([new HumanMessage("Diagnose")]))
      .rejects.toMatchObject({
        name: "ResearchContractError",
        code: "provider-error",
        message: "Synthetic local runtime failed before generation.",
      });
    channel.port1.close();
    channel.port2.close();
  });

  it("exposes a real LangChain model profile and routes Gemma thinking by preference", () => {
    const channel = new MessageChannel();
    const binding = createLocalGemmaChatModelBindingV1({
      port: channel.port1,
      modelId: "fixture/model",
      maxOutputTokens: 99_999,
    });

    expect(binding.model.profile).toMatchObject({
      maxOutputTokens: 2_048,
      toolCalling: true,
    });
    expect(binding.harnessProfile?.key).toBe("atlcli-local:gemma-4-e4b");
    expect(binding.runtimeLimits?.maxInputTokens).toBe(3_072);
    expect(binding.runtimeLimits?.interpreterResultChars).toBe(4_000);
    expect(binding.modelForRoute?.({ role: "analysis", preference: "balanced" }))
      .toMatchObject({
        thinkingMode: "adaptive-summary",
        model: { profile: { maxOutputTokens: 1_024 } },
      });
    expect(binding.modelForRoute?.({ role: "analysis", preference: "thorough" }))
      .toMatchObject({ thinkingMode: "adaptive-summary" });
    expect(binding.modelForRoute?.({ role: "synthesis", preference: "thorough" }))
      .toMatchObject({
        thinkingMode: "disabled",
        finalizationCorridor: "finalize-only",
        model: { profile: { maxOutputTokens: 1_024 } },
      });
    expect(binding.modelForRoute?.({
      role: "analysis",
      preference: "thorough",
      profileId: "relationship-tracer",
    })).toMatchObject({
      effectivePreference: "fast",
      thinkingMode: "disabled",
      model: { profile: { maxOutputTokens: 1_024 } },
    });
    expect(binding.modelForRoute?.({ role: "extraction", preference: "fast" }))
      .toMatchObject({ model: { profile: { maxOutputTokens: 1_024 } } });
    channel.port1.close();
    channel.port2.close();
  });

  it("maps a local context envelope failure to LangChain ContextOverflowError", async () => {
    const channel = new MessageChannel();
    channel.port2.onmessage = (event: MessageEvent<LocalModelPortRequestV1>) => {
      if (event.data.kind !== "generate") return;
      channel.port2.postMessage({
        schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
        kind: "error",
        requestId: event.data.requestId,
        code: "context-overflow",
        error: "Synthetic local context overflow.",
      });
    };
    channel.port2.start();
    const binding = createLocalGemmaChatModelBindingV1({
      port: channel.port1,
      modelId: "fixture/model",
      maxOutputTokens: 32,
    });

    await expect(binding.model.invoke([new HumanMessage("Too large")]))
      .rejects.toMatchObject({
        name: "ContextOverflowError",
        message: "Synthetic local context overflow.",
      });
    channel.port1.close();
    channel.port2.close();
  });
});
