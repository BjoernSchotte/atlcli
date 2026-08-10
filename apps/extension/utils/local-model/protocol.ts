export const LOCAL_MODEL_PROTOCOL_SCHEMA_V1 =
  "atlcli.browser-local-model-rpc/v1" as const;

export const LOCAL_MODEL_RPC_LIMITS_V1 = {
  maxMessages: 128,
  maxMessageBytes: 256 * 1024,
  maxRequestBytes: 2 * 1024 * 1024,
  maxTools: 64,
  maxToolBytes: 512 * 1024,
  maxOutputTokens: 8_192,
} as const;

export interface LocalModelToolV1 {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export type LocalModelChatMessageV1 =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: Record<string, unknown> };
      }>;
    }
  | {
      role: "tool";
      content: string;
      name: string;
      tool_call_id: string;
    };

export type LocalModelPortRequestV1 =
  | {
      schema: typeof LOCAL_MODEL_PROTOCOL_SCHEMA_V1;
      kind: "generate";
      requestId: string;
      messages: LocalModelChatMessageV1[];
      tools: LocalModelToolV1[];
      maxOutputTokens: number;
    }
  | {
      schema: typeof LOCAL_MODEL_PROTOCOL_SCHEMA_V1;
      kind: "cancel";
      requestId: string;
    };

export interface LocalModelToolCallV1 {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type LocalModelPortResponseV1 =
  | {
      schema: typeof LOCAL_MODEL_PROTOCOL_SCHEMA_V1;
      kind: "text-delta";
      requestId: string;
      text: string;
    }
  | {
      schema: typeof LOCAL_MODEL_PROTOCOL_SCHEMA_V1;
      kind: "complete";
      requestId: string;
      text: string;
      toolCalls: LocalModelToolCallV1[];
      inputTokens: number;
      outputTokens: number;
    }
  | {
      schema: typeof LOCAL_MODEL_PROTOCOL_SCHEMA_V1;
      kind: "error";
      requestId: string;
      code: "cancelled" | "invalid-request" | "model-error";
      error: string;
    };

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
}

function assertMessageV1(value: unknown): asserts value is LocalModelChatMessageV1 {
  if (!isRecord(value)) throw new Error("A local model message must be an object.");
  assertText(value.role, "A local model message role");
  assertText(value.content, "Local model message content");
  if (value.role === "system" || value.role === "user") return;
  if (value.role === "assistant") {
    if (value.tool_calls === undefined) return;
    if (!Array.isArray(value.tool_calls)) {
      throw new Error("Assistant tool calls must be an array.");
    }
    for (const call of value.tool_calls) {
      if (!isRecord(call) || call.type !== "function" || !isRecord(call.function)) {
        throw new Error("An assistant tool call is invalid.");
      }
      assertText(call.id, "An assistant tool call id");
      assertText(call.function.name, "An assistant tool name");
      if (!isRecord(call.function.arguments)) {
        throw new Error("Assistant tool-call arguments must be an object.");
      }
    }
    return;
  }
  if (value.role === "tool") {
    assertText(value.name, "A tool result name");
    assertText(value.tool_call_id, "A tool result call id");
    return;
  }
  throw new Error("The local model message role is unsupported.");
}

function assertToolV1(value: unknown): asserts value is LocalModelToolV1 {
  if (!isRecord(value) || value.type !== "function" || !isRecord(value.function)) {
    throw new Error("A local model tool must be a function definition.");
  }
  assertText(value.function.name, "A local model tool name");
  if (value.function.description !== undefined) {
    assertText(value.function.description, "A local model tool description");
  }
  if (!isRecord(value.function.parameters)) {
    throw new Error("Local model tool parameters must be a JSON Schema object.");
  }
}

export function localModelRequestIdV1(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.requestId !== "string") return undefined;
  return value.requestId.length > 0 && value.requestId.length <= 128
    ? value.requestId
    : undefined;
}

export function assertLocalModelGenerateRequestV1(
  value: unknown,
): asserts value is Extract<LocalModelPortRequestV1, { kind: "generate" }> {
  if (!isRecord(value) || value.kind !== "generate" ||
      value.schema !== LOCAL_MODEL_PROTOCOL_SCHEMA_V1) {
    throw new Error("Invalid local model request envelope.");
  }
  if (!localModelRequestIdV1(value)) {
    throw new Error("Invalid local model request id.");
  }
  if (!Array.isArray(value.messages) || !Array.isArray(value.tools)) {
    throw new Error("Local model messages and tools must be arrays.");
  }
  if (value.messages.length === 0 || value.messages.length > LOCAL_MODEL_RPC_LIMITS_V1.maxMessages) {
    throw new Error("Local model message count exceeds the bounded protocol.");
  }
  for (const message of value.messages) {
    assertMessageV1(message);
    if (utf8Bytes(message) > LOCAL_MODEL_RPC_LIMITS_V1.maxMessageBytes) {
      throw new Error("A local model message exceeds the byte limit.");
    }
  }
  if (utf8Bytes(value.messages) > LOCAL_MODEL_RPC_LIMITS_V1.maxRequestBytes) {
    throw new Error("The local model request exceeds the byte limit.");
  }
  if (value.tools.length > LOCAL_MODEL_RPC_LIMITS_V1.maxTools ||
      utf8Bytes(value.tools) > LOCAL_MODEL_RPC_LIMITS_V1.maxToolBytes) {
    throw new Error("The local model tool inventory exceeds the bounded protocol.");
  }
  for (const tool of value.tools) assertToolV1(tool);
  if (typeof value.maxOutputTokens !== "number" ||
      !Number.isInteger(value.maxOutputTokens) || value.maxOutputTokens < 1 ||
      value.maxOutputTokens > LOCAL_MODEL_RPC_LIMITS_V1.maxOutputTokens) {
    throw new Error("The local model output-token limit is invalid.");
  }
}

export type LocalModelWorkerConnectV1 = {
  kind: "local-model:connect";
  port: MessagePort;
};
