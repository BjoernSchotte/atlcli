import type { LocalModelToolCallV1 } from "./protocol.js";

const TOOL_OPEN = "<|tool_call>";
const TOOL_CLOSE = "<tool_call|>";
const STRING_DELIMITER = '<|"|>';

class GemmaArgumentsParserV1 {
  #index = 0;
  constructor(readonly source: string) {}

  parse(): Record<string, unknown> {
    const value = this.#value();
    this.#space();
    if (this.#index !== this.source.length || typeof value !== "object" ||
        value === null || Array.isArray(value)) {
      throw new Error("Gemma tool arguments must be one complete object.");
    }
    return value as Record<string, unknown>;
  }

  #space(): void {
    while (/\s/u.test(this.source[this.#index] ?? "")) this.#index += 1;
  }

  #take(token: string): boolean {
    this.#space();
    if (!this.source.startsWith(token, this.#index)) return false;
    this.#index += token.length;
    return true;
  }

  #value(): unknown {
    this.#space();
    if (this.source.startsWith(STRING_DELIMITER, this.#index)) {
      return this.#string(STRING_DELIMITER);
    }
    if (this.source[this.#index] === '"') return this.#string('"');
    if (this.#take("{")) return this.#object();
    if (this.#take("[")) return this.#array();
    for (const [token, value] of [["true", true], ["false", false], ["null", null]] as const) {
      if (this.#take(token)) return value;
    }
    const number = this.source.slice(this.#index).match(/^-?(?:0|[1-9]\d*)(?:[.]\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (number) {
      this.#index += number.length;
      return Number(number);
    }
    throw new Error(`Invalid Gemma tool argument at byte ${this.#index}.`);
  }

  #string(delimiter: string): string {
    if (delimiter === '"') {
      const start = this.#index;
      this.#index += 1;
      let escaped = false;
      while (this.#index < this.source.length) {
        const character = this.source[this.#index++]!;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (character === "\\") {
          escaped = true;
          continue;
        }
        if (character === '"') {
          return JSON.parse(this.source.slice(start, this.#index)) as string;
        }
      }
      throw new Error("Unterminated Gemma tool argument string.");
    }
    this.#index += delimiter.length;
    let result = "";
    while (this.#index < this.source.length) {
      if (this.source.startsWith(delimiter, this.#index)) {
        this.#index += delimiter.length;
        return result;
      }
      const character = this.source[this.#index++]!;
      result += character;
    }
    throw new Error("Unterminated Gemma tool argument string.");
  }

  #key(): string {
    this.#space();
    if (this.source.startsWith(STRING_DELIMITER, this.#index)) {
      return this.#string(STRING_DELIMITER);
    }
    if (this.source[this.#index] === '"') return this.#string('"');
    const key = this.source.slice(this.#index).match(/^[A-Za-z_][A-Za-z0-9_-]*/u)?.[0];
    if (!key) throw new Error(`Invalid Gemma tool argument key at byte ${this.#index}.`);
    this.#index += key.length;
    return key;
  }

  #object(): Record<string, unknown> {
    const object: Record<string, unknown> = {};
    if (this.#take("}")) return object;
    while (true) {
      const key = this.#key();
      if (!this.#take(":")) throw new Error("Gemma tool argument key is missing ':'.");
      object[key] = this.#value();
      if (this.#take("}")) return object;
      if (!this.#take(",")) throw new Error("Gemma tool argument object is missing ','.");
    }
  }

  #array(): unknown[] {
    const array: unknown[] = [];
    if (this.#take("]")) return array;
    while (true) {
      array.push(this.#value());
      if (this.#take("]")) return array;
      if (!this.#take(",")) throw new Error("Gemma tool argument array is missing ','.");
    }
  }
}

export interface ParsedGemmaResponseV1 {
  text: string;
  toolCalls: LocalModelToolCallV1[];
}

/** Parse only the pinned Gemma 4 response-template grammar. */
export function parseGemma4ResponseV1(input: {
  requestId: string;
  raw: string;
  allowedToolNames: ReadonlySet<string>;
}): ParsedGemmaResponseV1 {
  let remaining = input.raw;
  if (remaining.startsWith("<|channel>thought\n")) {
    const thoughtEnd = remaining.indexOf("<channel|>");
    if (thoughtEnd < 0) throw new Error("Gemma thinking channel is unterminated.");
    remaining = remaining.slice(thoughtEnd + "<channel|>".length);
  }

  const toolCalls: LocalModelToolCallV1[] = [];
  let text = "";
  while (remaining.length > 0) {
    const start = remaining.indexOf(TOOL_OPEN);
    if (start < 0) {
      text += remaining;
      break;
    }
    text += remaining.slice(0, start);
    const end = remaining.indexOf(TOOL_CLOSE, start + TOOL_OPEN.length);
    if (end < 0) throw new Error("Gemma tool call is unterminated.");
    const body = remaining.slice(start + TOOL_OPEN.length, end);
    const match = /^call:([A-Za-z_][A-Za-z0-9_-]*)([\s\S]+)$/u.exec(body);
    if (!match?.[1] || !match[2]) throw new Error("Gemma tool call has an invalid header.");
    if (!input.allowedToolNames.has(match[1])) {
      throw new Error(`Gemma requested an unknown tool: ${match[1]}.`);
    }
    toolCalls.push({
      id: `local-${input.requestId}-${toolCalls.length}`,
      name: match[1],
      arguments: new GemmaArgumentsParserV1(match[2]).parse(),
    });
    remaining = remaining.slice(end + TOOL_CLOSE.length);
  }

  text = text
    .replace(/^(?:<\|turn>model\n|<tool_response\|>)/u, "")
    .replace(/(?:<turn\|>|<\|tool_response>|<eos>)+$/u, "")
    .trim();
  if (!text && toolCalls.length === 0) {
    throw new Error("Gemma returned neither text nor a tool call.");
  }
  return { text, toolCalls };
}
