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
import type { LocalGemmaPerformanceSampleV1 } from "./performance.js";

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

function implicitStructuredToolNameV1(
  tools: readonly LocalModelToolV1[],
  messages: readonly BaseMessage[],
): string | undefined {
  const structuredNames = tools
    .map((tool) => tool.function.name)
    .filter((name) => /^Chat[A-Za-z0-9]+V[0-9]+$/u.test(name));
  if (structuredNames.length !== 1) return undefined;
  const name = structuredNames[0];
  // DeepAgentsJS structured specialist packets are exposed as one versioned
  // Chat* tool. A pure packet call can bind immediately. A reader must first
  // retain its acquisition tools, then binds the sole packet only after their
  // ToolMessage exists. This mirrors provider-native structured output without
  // skipping real host reads.
  return tools.length === 1 || messages.some((message) => ToolMessage.isInstance(message))
    ? name
    : undefined;
}

const LOCAL_SPECIALIST_EVAL_LIMIT_CODE_V1 = "EVAL_LIMIT_REACHED.";
const KITEWEAVE_ROOT_PROMPT_MARKER_V1 =
  "You are Kiteweave Chat, a conversational read-only Jira and Confluence assistant.";

function localSpecialistInitialEvalToolV1(
  tools: readonly LocalModelToolV1[],
  messages: readonly BaseMessage[],
): string | undefined {
  if (
    messages.some(ToolMessage.isInstance) ||
    messages.some((message) =>
      message.getType() === "system" &&
      textContentV1(message).includes(KITEWEAVE_ROOT_PROMPT_MARKER_V1)
    )
  ) return undefined;
  const names = tools.map((tool) => tool.function.name);
  const packetNames = names.filter(isVersionedChatStructuredToolV1);
  return names.includes("eval") && packetNames.length === 1 ? "eval" : undefined;
}

function localSpecialistTerminalPacketToolV1(
  tools: readonly LocalModelToolV1[],
  messages: readonly BaseMessage[],
): string | undefined {
  const reachedHostLimit = messages.some((message) =>
    ToolMessage.isInstance(message) &&
    textContentV1(message).trimStart().startsWith(LOCAL_SPECIALIST_EVAL_LIMIT_CODE_V1)
  );
  if (!reachedHostLimit) return undefined;
  const packetNames = tools
    .map((tool) => tool.function.name)
    .filter(isVersionedChatStructuredToolV1);
  return packetNames.length === 1 ? packetNames[0] : undefined;
}

function projectLocalSpecialistTerminalMessagesV1(
  messages: readonly BaseMessage[],
  packetToolName: string | undefined,
): BaseMessage[] {
  if (!packetToolName) return [...messages];
  const firstLimitResult = messages.findIndex((message) =>
    ToolMessage.isInstance(message) &&
    textContentV1(message).trimStart().startsWith(LOCAL_SPECIALIST_EVAL_LIMIT_CODE_V1)
  );
  if (firstLimitResult < 0) return [...messages];
  // The host has made the terminal state authoritative. A smaller model may
  // nevertheless repeat the now-rejected eval call, producing identical
  // assistant/tool pairs until its context overflows. Keep the first typed
  // stop result (and all useful results before it), but hide only later
  // rejected repetitions from this provider invocation. Canonical DeepAgents
  // state remains unchanged.
  return messages.slice(0, firstLimitResult + 1);
}

function projectLocalStructuredRepairMessagesV1(
  messages: readonly BaseMessage[],
  packetToolName: string | undefined,
): BaseMessage[] {
  if (!packetToolName || !isVersionedChatStructuredToolV1(packetToolName)) {
    return [...messages];
  }
  const attempts: Array<readonly [number, number]> = [];
  for (let toolIndex = 0; toolIndex < messages.length; toolIndex += 1) {
    const result = messages[toolIndex];
    if (!result || !ToolMessage.isInstance(result)) continue;
    const callIndex = messages.findLastIndex((candidate, candidateIndex) =>
      candidateIndex < toolIndex && AIMessage.isInstance(candidate) &&
      candidate.tool_calls?.length === 1 &&
      candidate.tool_calls[0]?.id === result.tool_call_id &&
      candidate.tool_calls[0]?.name === packetToolName
    );
    if (callIndex >= 0) attempts.push([callIndex, toolIndex]);
  }
  if (attempts.length === 0) return [...messages];
  const discarded = new Set<number>();
  // A ToolMessage after a forced structured packet is host validation
  // feedback: a successful packet would already have terminated the child.
  // Retain the newest failed packet plus its language-independent validator
  // feedback, but hide older duplicate repair pairs from this local provider
  // invocation. DeepAgents keeps the complete canonical history, and remote
  // providers never pass through this projection.
  for (const [callIndex, toolIndex] of attempts.slice(0, -1)) {
    discarded.add(callIndex);
    discarded.add(toolIndex);
  }
  const newestCallIndex = attempts.at(-1)?.[0];
  return messages.flatMap((message, index) => {
    if (discarded.has(index)) return [];
    if (index !== newestCallIndex || !AIMessage.isInstance(message)) {
      return [message];
    }
    const failedCall = message.tool_calls?.[0];
    if (!failedCall) return [message];
    // The paired ToolMessage is the authoritative host rejection. Its
    // language-independent schema feedback plus the currently declared tool
    // schema are sufficient for repair; replaying the rejected packet body is
    // not evidence and can consume the local browser envelope. Preserve only
    // the tool identity needed to correlate that feedback. This projection is
    // local-provider-only and never mutates canonical DeepAgents state.
    return [new AIMessage({
      content: "",
      tool_calls: [{ ...failedCall, args: {} }],
    })];
  });
}

function isVersionedChatStructuredToolV1(name: string): boolean {
  return /^Chat[A-Za-z0-9]+V[0-9]+$/u.test(name);
}

function rootConstPropertiesV1(
  parameters: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  if (parameters.type !== "object" || !parameters.properties ||
      typeof parameters.properties !== "object" ||
      Array.isArray(parameters.properties)) return {};
  const constants: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(
    parameters.properties as Record<string, unknown>,
  )) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        !("const" in value)) continue;
    constants[name] = (value as { const: unknown }).const;
  }
  return constants;
}

/**
 * A JSON-Schema `const` is host-owned envelope data, not a model decision.
 * Hide those root fields from forced local packet calls so the small model
 * cannot accidentally copy a different schema id from retained context.
 * The original schema remains available below for lossless restoration.
 */
function projectStructuredRootConstsV1(
  toolName: string,
  parameters: Record<string, unknown>,
  requiredToolName?: string,
): Record<string, unknown> {
  if (requiredToolName !== toolName || !isVersionedChatStructuredToolV1(toolName)) {
    return parameters;
  }
  const constants = rootConstPropertiesV1(parameters);
  const names = new Set(Object.keys(constants));
  if (names.size === 0) return parameters;
  const properties = parameters.properties as Record<string, unknown>;
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((name) => typeof name !== "string" || !names.has(name))
    : parameters.required;
  return {
    ...parameters,
    properties: Object.fromEntries(
      Object.entries(properties).filter(([name]) => !names.has(name)),
    ),
    ...(required === undefined ? {} : { required }),
  };
}

function enumPrimitiveTypeV1(values: readonly unknown[]): string | undefined {
  if (values.length === 0) return undefined;
  if (values.every((value) => typeof value === "string")) return "string";
  if (values.every((value) => typeof value === "boolean")) return "boolean";
  if (values.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return values.every((value) => Number.isInteger(value)) ? "integer" : "number";
  }
  return undefined;
}

/**
 * Gemma's pinned Transformers.js chat template renders every property type via
 * Jinja's `upper` filter. JSON Schema permits an enum to omit `type`, but that
 * template does not: it throws before tokenization. Add only the primitive
 * type already implied by a homogeneous enum. The canonical host schema and
 * every non-local provider binding remain untouched.
 */
function projectLocalGemmaJsonSchemaV1(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectLocalGemmaJsonSchemaV1);
  if (!value || typeof value !== "object") return value;
  const schema = value as Record<string, unknown>;
  const projected = Object.fromEntries(
    Object.entries(schema).map(([key, nested]) => [
      key,
      projectLocalGemmaJsonSchemaV1(nested),
    ]),
  );
  if (projected.type !== undefined || !Array.isArray(projected.enum)) {
    return projected;
  }
  const type = enumPrimitiveTypeV1(projected.enum);
  return type === undefined ? projected : { ...projected, type };
}

function isLocalGemmaAgenticRootV1(
  messages: BaseMessage[],
  options: LocalGemmaCallOptionsV1,
): boolean {
  return requiredToolNameV1(options.tool_choice) === undefined &&
    messages.some((message) =>
      message.getType() === "system" && textContentV1(message).includes(
        "The host requires an agentic Chat workflow for this turn.",
      )
    );
}

type LocalGemmaAgenticRootPhaseV1 = "initial" | "continue";

function localGemmaAgenticRootPhaseV1(
  messages: BaseMessage[],
  options: LocalGemmaCallOptionsV1,
): LocalGemmaAgenticRootPhaseV1 | undefined {
  if (!isLocalGemmaAgenticRootV1(messages, options)) return undefined;
  // A retained DeepAgents thread can already contain eval ToolMessages from
  // strategy inspection or an earlier direct evidence step. Those messages do
  // not prove that this turn's agentic workflow was proposed. Continue only
  // after the conversation contains the exact compiled proposal call emitted
  // by this adapter; otherwise Gemma must still select the initial task graph.
  const proposalAlreadyEmitted = messages.some((message) =>
    AIMessage.isInstance(message) && message.tool_calls?.some((toolCall) =>
      toolCall.name === "eval" &&
      typeof toolCall.args?.code === "string" &&
      /\bchatWorkflowPropose\s*\(/u.test(toolCall.args.code)
    )
  );
  return proposalAlreadyEmitted ? "continue" : "initial";
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
  required: ["blocks"],
  properties: {
    blocks: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        required: ["markdown", "sourceRefs"],
        properties: {
          markdown: { type: "string" },
          sourceRefs: { type: "array", items: { type: "string" } },
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
        required: ["code", "message", "sourceIds"],
        properties: {
          code: { type: "string" },
          message: { type: "string" },
          sourceIds: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

const LOCAL_GEMMA_AGENTIC_EVAL_SCHEMA_V1 = {
  type: "object",
  additionalProperties: false,
  required: ["tasks", "maxConcurrency"],
  properties: {
    tasks: {
      type: "array",
      minItems: 4,
      maxItems: 9,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["taskId", "profileId", "objective", "dependencyTaskIds"],
        properties: {
          taskId: { type: "string", minLength: 1, maxLength: 200 },
          profileId: { type: "string", minLength: 1, maxLength: 120 },
          objective: { type: "string", minLength: 1, maxLength: 4_000 },
          dependencyTaskIds: {
            type: "array",
            maxItems: 7,
            items: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    maxConcurrency: { type: "integer", enum: [1] },
    retrievalPlan: {
      type: "object",
      additionalProperties: false,
      properties: {
        searches: {
          type: "array",
          maxItems: 2,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["searchId", "product", "variants", "maxPages"],
            properties: {
              searchId: { type: "string", minLength: 1, maxLength: 120 },
              product: { type: "string", enum: ["jira", "confluence"] },
              variants: {
                type: "array",
                minItems: 1,
                maxItems: 5,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["variantId", "query"],
                  properties: {
                    variantId: { type: "string", minLength: 1, maxLength: 120 },
                    query: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        text: { type: "string", minLength: 1, maxLength: 500 },
                        labels: {
                          type: "array",
                          minItems: 1,
                          maxItems: 8,
                          items: { type: "string", minLength: 1, maxLength: 255 },
                        },
                        ancestorId: { type: "string", minLength: 1, maxLength: 128 },
                        parentId: { type: "string", minLength: 1, maxLength: 128 },
                      },
                    },
                    expectedInformationGain: {
                      type: "string",
                      enum: ["high", "medium", "low"],
                    },
                  },
                },
              },
              maxPages: { type: "integer", minimum: 1, maximum: 100 },
            },
          },
        },
        relationshipTraversals: {
          type: "array",
          maxItems: 2,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["traversalId", "kind", "maxDepth"],
            properties: {
              traversalId: { type: "string", minLength: 1, maxLength: 120 },
              kind: {
                type: "string",
                enum: [
                  "confluence-to-jira-reference",
                  "jira-to-confluence-remote-link",
                ],
              },
              maxDepth: { type: "integer", enum: [1] },
            },
          },
        },
        unresolvedTerms: {
          type: "array",
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 160 },
        },
      },
    },
  },
} as const;

const LOCAL_GEMMA_AGENTIC_CONTINUE_SCHEMA_V1 = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

function toLocalToolsV1(
  tools: ToolDefinition[] | undefined,
  requiredToolName?: string,
  agenticRootPhase?: LocalGemmaAgenticRootPhaseV1,
): LocalModelToolV1[] {
  return (tools ?? []).map((tool) => {
    if (tool.type !== "function" || !tool.function?.name || !tool.function.parameters) {
      throw new Error("Local Gemma accepts only named function tools with JSON Schema parameters.");
    }
    return {
      type: "function",
      function: {
        name: tool.function.name,
        ...(agenticRootPhase && tool.function.name === "eval"
          ? {
              description: agenticRootPhase === "initial"
                ? [
                    "Select the bounded agentic task graph.",
                    "The local provider adapter compiles this object into the canonical eval/QuickJS workflow program.",
                  ].join(" ")
                : "Continue the already admitted bounded agentic workflow.",
              parameters: agenticRootPhase === "initial"
                ? LOCAL_GEMMA_AGENTIC_EVAL_SCHEMA_V1
                : LOCAL_GEMMA_AGENTIC_CONTINUE_SCHEMA_V1,
            }
          : requiredToolName === "ChatAnswerDraftV2"
          ? { parameters: LOCAL_GEMMA_FINAL_ANSWER_SCHEMA_V1 }
          : {
              ...(tool.function.description
                ? { description: tool.function.description }
                : {}),
              parameters: projectLocalGemmaJsonSchemaV1(
                projectStructuredRootConstsV1(
                  tool.function.name,
                  tool.function.parameters,
                  requiredToolName,
                ),
              ) as Record<string, unknown>,
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
const LOCAL_GEMMA_ANSWER_DRAFT_TOOLS_V1 = new Set([
  "ChatProvisionalAnswerDraftV1",
  "ChatRepairedAnswerDraftV1",
  "ChatAnswerDraftV2",
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
  structuredRootConstants: Readonly<Record<string, unknown>> = {},
): LocalModelToolCallV1 {
  const withStructuredEnvelope = Object.keys(structuredRootConstants).length > 0
    ? {
        ...call,
        arguments: {
          ...call.arguments,
          ...structuredRootConstants,
        },
      }
    : call;
  if (call.name === "ChatEvidencePacketV1" &&
      Array.isArray(withStructuredEnvelope.arguments.claims)) {
    const relationships = Array.isArray(withStructuredEnvelope.arguments.relationships)
      ? withStructuredEnvelope.arguments.relationships
      : withStructuredEnvelope.arguments.relationships === undefined
        ? []
        : withStructuredEnvelope.arguments.relationships;
    const gaps = Array.isArray(withStructuredEnvelope.arguments.gaps)
      ? withStructuredEnvelope.arguments.gaps
      : withStructuredEnvelope.arguments.gaps === undefined
        ? []
        : withStructuredEnvelope.arguments.gaps;
    const sourceIds = withStructuredEnvelope.arguments.sourceIds === undefined
      ? [...new Set([
          ...withStructuredEnvelope.arguments.claims.flatMap((value) => {
            if (!value || typeof value !== "object" || Array.isArray(value) ||
                !Array.isArray((value as Record<string, unknown>).sourceIds)) return [];
            return ((value as Record<string, unknown>).sourceIds as unknown[])
              .filter((sourceId): sourceId is string =>
                typeof sourceId === "string" && sourceId.length > 0
              );
          }),
          ...(Array.isArray(relationships)
            ? relationships.flatMap((value) => {
                if (!value || typeof value !== "object" || Array.isArray(value)) return [];
                const relationship = value as Record<string, unknown>;
                return [relationship.fromSourceId, relationship.toSourceId]
                  .filter((sourceId): sourceId is string =>
                    typeof sourceId === "string" && sourceId.length > 0
                  );
              })
            : []),
        ])]
      : withStructuredEnvelope.arguments.sourceIds;
    return {
      ...withStructuredEnvelope,
      arguments: {
        ...withStructuredEnvelope.arguments,
        sourceIds,
        relationships,
        gaps,
      },
    };
  }
  if (call.name === "ChatCritiquePacketV1") {
    // Gemma 4 E4B uses numeric zero for an empty collection in the same way
    // it does for answer gaps. Only that singleton shortcut is unambiguous.
    // An actually empty defect set also has exactly one valid readiness state;
    // do not infer readiness for a non-empty or otherwise malformed critique.
    const defects = withStructuredEnvelope.arguments.defects === 0
      ? []
      : withStructuredEnvelope.arguments.defects;
    const normalizedDefects = Array.isArray(defects)
      ? defects.map((value, index) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return value;
          }
          const defect = value as Record<string, unknown>;
          return {
            ...defect,
            ...(defect.defectId === undefined
              ? { defectId: `chat-defect:local-${index + 1}` }
              : {}),
            ...(defect.sourceIds === undefined ? { sourceIds: [] } : {}),
          };
        })
      : defects;
    const readyForSynthesis = Array.isArray(normalizedDefects) &&
        normalizedDefects.length === 0 &&
        withStructuredEnvelope.arguments.readyForSynthesis === undefined
      ? true
      : withStructuredEnvelope.arguments.readyForSynthesis;
    return {
      ...withStructuredEnvelope,
      arguments: {
        ...withStructuredEnvelope.arguments,
        ...(normalizedDefects === undefined ? {} : { defects: normalizedDefects }),
        ...(readyForSynthesis === undefined ? {} : { readyForSynthesis }),
      },
    };
  }
  if (!LOCAL_GEMMA_ANSWER_DRAFT_TOOLS_V1.has(call.name)) {
    return withStructuredEnvelope;
  }
  const blocks = Array.isArray(withStructuredEnvelope.arguments.blocks)
    ? withStructuredEnvelope.arguments.blocks.map((value) => {
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
    : withStructuredEnvelope.arguments.blocks;
  return {
    ...withStructuredEnvelope,
    arguments: {
      ...withStructuredEnvelope.arguments,
      ...(blocks === undefined ? {} : { blocks }),
      // Gemma 4 E4B occasionally uses numeric zero as an empty collection.
      // This is unambiguous only for zero; every other non-array value remains
      // invalid and is rejected by the canonical structured-output schema.
      ...(withStructuredEnvelope.arguments.gaps === 0 ||
          withStructuredEnvelope.arguments.gaps === undefined
        ? { gaps: [] }
        : {}),
    },
  };
}

/**
 * Gemma is more reliable at producing the workflow proposal as native tool
 * arguments than at double-encoding that same JSON inside a JavaScript string.
 * Keep the canonical DeepAgents tool surface by compiling only this
 * provider-local projection back into the ordinary `eval({ code })` call.
 */
export function normalizeLocalGemmaAgenticEvalToolCallV1(
  call: LocalModelToolCallV1,
  phase: LocalGemmaAgenticRootPhaseV1 = "initial",
): LocalModelToolCallV1 {
  if (call.name !== "eval" || typeof call.arguments.code === "string") return call;
  if (phase === "continue") {
    return {
      ...call,
      arguments: { code: "await tools.chatWorkflowRun({})" },
    };
  }
  const { tasks, maxConcurrency, retrievalPlan } = call.arguments;
  // maxConcurrency has exactly one legal value in the provider projection.
  // Supplying that singleton when Gemma omits it does not choose workflow
  // topology or specialist work on the model's behalf.
  if (!Array.isArray(tasks) ||
      (maxConcurrency !== undefined && maxConcurrency !== 1)) return call;
  const projectedRetrievalPlan = (() => {
    if (!retrievalPlan || typeof retrievalPlan !== "object" ||
        Array.isArray(retrievalPlan)) return retrievalPlan;
    const plan = retrievalPlan as Record<string, unknown>;
    return {
      ...(Array.isArray(plan.searches) ? { searches: plan.searches } : {}),
      ...(Array.isArray(plan.relationshipTraversals)
        ? {
            relationshipTraversals: plan.relationshipTraversals.map((value) => {
              if (!value || typeof value !== "object" || Array.isArray(value)) {
                return value;
              }
              const traversal = value as Record<string, unknown>;
              return {
                traversalId: traversal.traversalId,
                kind: traversal.kind,
                // The provider schema has one legal depth. Repairing this
                // singleton does not choose a traversal on the model's behalf.
                maxDepth: 1,
              };
            }),
          }
        : {}),
      ...(Array.isArray(plan.unresolvedTerms)
        ? { unresolvedTerms: plan.unresolvedTerms }
        : {}),
    };
  })();
  const proposal = {
    tasks,
    maxConcurrency: 1,
    ...(projectedRetrievalPlan === undefined
      ? {}
      : { retrievalPlan: projectedRetrievalPlan }),
  };
  return {
    ...call,
    arguments: {
      code: [
        `const proposal = ${JSON.stringify(proposal)};`,
        "await tools.chatWorkflowPropose(proposal);",
        "await tools.chatWorkflowRun({})",
      ].join("\n"),
    },
  };
}

function normalizeLocalGemmaToolCallsV1(
  calls: LocalModelToolCallV1[],
  agenticRootPhase: LocalGemmaAgenticRootPhaseV1 | undefined = undefined,
  originalTools: readonly ToolDefinition[] = [],
): LocalModelToolCallV1[] {
  return calls.map((call) => {
    const original = originalTools.find((tool) =>
      tool.type === "function" && tool.function?.name === call.name
    );
    const constants = isVersionedChatStructuredToolV1(call.name) &&
        original?.type === "function" && original.function.parameters
      ? rootConstPropertiesV1(original.function.parameters)
      : {};
    return normalizeLocalGemmaToolCallV1(
      agenticRootPhase
        ? normalizeLocalGemmaAgenticEvalToolCallV1(call, agenticRootPhase)
        : call,
      constants,
    );
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
    console.info(`[local-gemma/proxy] request sent ${JSON.stringify({
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
      })),
    })}`);
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
          console.info(`[local-gemma/proxy] request completed ${JSON.stringify({
            requestId,
            durationMs: Date.now() - startedAt,
            inputTokens: response.inputTokens,
            outputTokens: response.outputTokens,
            textChars: response.text.length,
            toolCalls: response.toolCalls.map((call) => call.name),
          })}`);
        } else if (response.kind === "error") {
          console.error(`[local-gemma/proxy] request failed ${JSON.stringify({
            requestId,
            durationMs: Date.now() - startedAt,
            code: response.code,
          })}`);
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
  readonly #publishPerformance?: (sample: LocalGemmaPerformanceSampleV1) => void;

  constructor(input: {
    client: LocalGemmaPortClientV1;
    maxOutputTokens: number;
    thinkingMode?: LocalGemmaThinkingModeV1;
    streamAnswerPreview?: boolean;
    publishAnswerPreview?: (preview: ChatStructuredAnswerPreviewV1) => void;
    publishPerformance?: (sample: LocalGemmaPerformanceSampleV1) => void;
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
    this.#publishPerformance = input.publishPerformance;
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
    if (final.performance) {
      this.#publishPerformance?.({
        requestId: final.requestId,
        recordedAt: new Date().toISOString(),
        inputTokens: final.inputTokens,
        outputTokens: final.outputTokens,
        timing: final.performance,
      });
    }
    const agenticRootPhase = localGemmaAgenticRootPhaseV1(messages, options);
    const toolCalls = normalizeLocalGemmaToolCallsV1(
      final.toolCalls,
      agenticRootPhase,
      options.tools,
    );
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
        if (response.performance) {
          this.#publishPerformance?.({
            requestId: response.requestId,
            recordedAt: new Date().toISOString(),
            inputTokens: response.inputTokens,
            outputTokens: response.outputTokens,
            timing: response.performance,
          });
        }
        const agenticRootPhase = localGemmaAgenticRootPhaseV1(messages, options);
        const toolCalls = normalizeLocalGemmaToolCallsV1(
          response.toolCalls,
          agenticRootPhase,
          options.tools,
        );
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
    const providerTools = toLocalToolsV1(options.tools);
    const terminalPacketToolName = localSpecialistTerminalPacketToolV1(
      providerTools,
      messages,
    );
    const initialEvalToolName = localSpecialistInitialEvalToolV1(
      providerTools,
      messages,
    );
    const requestedToolName = terminalPacketToolName ??
      requiredToolNameV1(options.tool_choice) ?? initialEvalToolName;
    const agenticRootPhase = localGemmaAgenticRootPhaseV1(messages, options);
    const agenticRoot = agenticRootPhase !== undefined;
    const initiallyDeclaredTools = toLocalToolsV1(
      options.tools,
      requestedToolName,
      agenticRootPhase,
    );
    const implicitStructuredToolName = requestedToolName === undefined && !agenticRoot
      ? implicitStructuredToolNameV1(initiallyDeclaredTools, messages)
      : undefined;
    // The local root only serializes the already host-selected topology into
    // one bounded eval call. Triggering Gemma's private thought channel here
    // can consume the whole generation corridor before the JavaScript string
    // closes. Keep provider reasoning for direct Deep turns and specialists;
    // the agentic depth still comes from the admitted child workflow.
    const effectiveThinkingMode = agenticRoot || implicitStructuredToolName
      ? "disabled"
      : this.#thinkingMode;
    // The host has already selected the agentic path, so its only legal root
    // transition is the bounded QuickJS evaluator. Enforce that existing
    // DeepAgents tool instead of asking the local model to spend tokens
    // choosing between eval and a clarification tool before serializing the
    // model-selected task graph. Anthropic and every non-agentic route retain
    // their canonical tool-choice behavior.
    const requiredToolName = agenticRoot
      ? "eval"
      : requestedToolName ?? implicitStructuredToolName;
    const terminalMessages = projectLocalSpecialistTerminalMessagesV1(
      messages,
      terminalPacketToolName,
    );
    const projectedMessages = projectLocalStructuredRepairMessagesV1(
      terminalMessages,
      requiredToolName,
    );
    const localMessages = toLocalModelMessagesV1(projectedMessages, {
      // Once the local provider has selected an exact output tool, previous
      // private thought is neither evidence nor needed for routing.
      retainPrivateThought: requiredToolName === undefined,
    });
    const declaredTools = requiredToolName === requestedToolName
      ? initiallyDeclaredTools
      : toLocalToolsV1(options.tools, requiredToolName, agenticRootPhase);
    const tools = requiredToolName
      ? declaredTools.filter((tool) => tool.function.name === requiredToolName)
      : declaredTools;
    if (requiredToolName && tools.length !== 1) {
      throw new Error(`The required local Gemma tool is not declared: ${requiredToolName}.`);
    }
    return this.#client.generate({
      messages: projectLocalGemmaToolProtocolV1(
        localMessages,
        tools,
        effectiveThinkingMode,
        requiredToolName,
      ),
      tools,
      ...(requiredToolName ? { requiredToolName } : {}),
      ...(this.#streamAnswerPreview && requiredToolName === "ChatAnswerDraftV2"
        ? { streamAnswerPreview: true }
        : {}),
      // A terminal answer is already bounded to a handful of concise blocks.
      // Keep enough tail room to close the tool JSON: 768 produced useful
      // previews but truncated a four-facet answer before its final block.
      maxOutputTokens: requiredToolName === "ChatAnswerDraftV2"
        ? Math.min(this.#maxOutputTokens, 896)
        : this.#maxOutputTokens,
      thinkingMode: effectiveThinkingMode,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }
}

export function createLocalGemmaChatModelBindingV1(input: {
  port: MessagePort;
  modelId: string;
  maxOutputTokens: number;
  onPerformanceSample?: (sample: LocalGemmaPerformanceSampleV1) => void;
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
        publishPerformance: input.onPerformanceSample,
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
      // Agentic children already obtain depth from their admitted specialist
      // roles and dependency graph. On one local WebGPU model, an additional
      // private reasoning pass per child serializes minutes of invisible work
      // before the typed packet. Keep direct Auto/Think-deeper routing intact;
      // this provider-local fast corridor applies only when the host supplies
      // a concrete child profile.
      const localChild = request.profileId !== undefined;
      const localThinkingMode = finalizeOnly || localChild
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
        effectivePreference: finalizeOnly || localChild ? "fast" : request.preference,
        thinkingMode: localThinkingMode === "disabled"
          ? "disabled"
          : "adaptive-summary",
        finalizationCorridor: finalizeOnly ? "finalize-only" : "standard",
      };
    },
  };
}
