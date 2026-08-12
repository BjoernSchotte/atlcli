import type { LocalModelToolCallV1 } from "./protocol.js";

const TOOL_OPEN = "<|tool_call>";
const TOOL_CLOSE = "<tool_call|>";
const STRING_DELIMITER = '<|"|>';

export const LOCAL_GEMMA_FIRST_ANSWER_PREVIEW_TOKEN_V1 = 1;
export const LOCAL_GEMMA_ANSWER_TOOL_PREFILL_V1 =
  '<|tool_call>call:ChatAnswerDraftV2{blocks:[{markdown:<|"|>';

/**
 * Prefill only the host-forced terminal answer syntax. The model still owns
 * every visible character and the remainder of the schema-valid tool object.
 */
export function localGemmaAnswerToolPrefillV1(input: {
  requiredToolName?: string;
  streamAnswerPreview?: boolean;
}): string {
  return input.streamAnswerPreview === true &&
      input.requiredToolName === "ChatAnswerDraftV2"
    ? LOCAL_GEMMA_ANSWER_TOOL_PREFILL_V1
    : "";
}

/** Poll every token until Markdown becomes visible, then amortize decoding. */
export function nextLocalGemmaAnswerPreviewTokenV1(
  outputTokens: number,
  hasVisiblePreview: boolean,
): number {
  return outputTokens + (hasVisiblePreview ? 8 : 1);
}

function hideUnvalidatedSourceRefsV1(markdown: string): string {
  return markdown
    // Gemma sometimes writes host-private source IDs into its prose even
    // though sourceRefs is a separate structured field. The final answer
    // renderer receives host-resolved citations; a speculative preview must
    // never expose these unresolved IDs while the tool object is incomplete.
    .replace(/[ \t]*\[(?:wiki|jira):[^\]\r\n]{1,512}\]/giu, "")
    .replace(/[ \t]*\[(?:wiki|jira):[^\]\r\n]{0,512}$/giu, "")
    .trim();
}

function partialJsonStringV1(source: string): string {
  let value = "";
  let cursor = 1;
  while (cursor < source.length) {
    const character = source[cursor]!;
    if (character === '"') return value;
    if (character !== "\\") {
      value += character;
      cursor += 1;
      continue;
    }
    if (cursor + 1 >= source.length) return value;
    const escaped = source[cursor + 1]!;
    const simpleEscapes: Record<string, string> = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    if (escaped in simpleEscapes) {
      value += simpleEscapes[escaped];
      cursor += 2;
      continue;
    }
    if (escaped !== "u" || cursor + 6 > source.length) return value;
    const unit = source.slice(cursor + 2, cursor + 6);
    if (!/^[0-9a-f]{4}$/iu.test(unit)) return value;
    value += String.fromCharCode(Number.parseInt(unit, 16));
    cursor += 6;
  }
  return value;
}

/**
 * Conservatively project only visible Markdown strings from Gemma's partial
 * native tool grammar. This never participates in tool execution or schema
 * acceptance; the complete response is still parsed and validated normally.
 */
export function projectPartialGemmaAnswerMarkdownV1(
  raw: string,
  requiredToolName: string,
): string {
  const header = `${TOOL_OPEN}call:${requiredToolName}`;
  const headerIndex = raw.lastIndexOf(header);
  if (headerIndex < 0) return "";
  const argumentsSource = raw.slice(headerIndex + header.length);
  const field = /(?:^|[,{])\s*(?:markdown|"markdown")\s*:\s*/gu;
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < argumentsSource.length) {
    field.lastIndex = cursor;
    const match = field.exec(argumentsSource);
    if (!match) break;
    const valueStart = field.lastIndex;
    const remaining = argumentsSource.slice(valueStart);
    let value: string | undefined;
    if (remaining.startsWith(STRING_DELIMITER)) {
      const content = remaining.slice(STRING_DELIMITER.length);
      const end = content.indexOf(STRING_DELIMITER);
      value = end < 0 ? content : content.slice(0, end);
      cursor = end < 0
        ? argumentsSource.length
        : valueStart + STRING_DELIMITER.length + end + STRING_DELIMITER.length;
    } else if (remaining.startsWith('"')) {
      value = partialJsonStringV1(remaining);
      cursor = valueStart + Math.max(1, remaining.indexOf('"', 1) + 1);
    } else {
      cursor = valueStart + 1;
    }
    const normalized = value?.trim();
    if (normalized) blocks.push(normalized);
  }
  return hideUnvalidatedSourceRefsV1(blocks.join("\n\n"));
}

/**
 * A forced local tool call is complete as soon as its argument object parses.
 * Gemma sometimes delays or omits the optional closing control token after it
 * has already produced the entire object. The browser host can safely stop at
 * that point because it owns tool execution and the following conversation
 * turn.
 */
export function isCompleteGemmaToolCallV1(
  raw: string,
  requiredToolName: string,
  maximumImplicitObjectSeparators = 0,
  maximumTrailingStructuralClosers = 0,
  bareStringEnumValues: ReadonlySet<string> = new Set(),
  allowTrailingCollectionCommas = false,
): boolean {
  const start = raw.lastIndexOf(TOOL_OPEN);
  if (start < 0) return false;
  const body = raw.slice(start + TOOL_OPEN.length);
  const match = /^call:([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)([\s\S]+)$/u.exec(body);
  if (match?.[1] !== requiredToolName || !match[2]) return false;
  try {
    new GemmaArgumentsParserV1(
      terminalAnswerArgumentBoundaryV1(match[2], requiredToolName),
      Math.max(
        requiredToolName === "ChatAnswerDraftV2" ? 32 : 0,
        maximumImplicitObjectSeparators,
      ),
      maximumTrailingStructuralClosers,
      bareStringEnumValues,
      allowTrailingCollectionCommas,
    ).parse();
    return true;
  } catch {
    return false;
  }
}

function terminalAnswerArgumentBoundaryV1(
  source: string,
  toolName: string,
): string {
  const trimmed = source.trimEnd();
  // The pinned Gemma template sometimes closes a complete final `blocks`
  // (or `gaps`) array and immediately emits the tool-close token without the
  // single outer object brace. Append only that root boundary; a truncated
  // nested object/string still fails the parser below.
  if (
    toolName === "ChatAnswerDraftV2" &&
    trimmed.startsWith("{") &&
    trimmed.endsWith("]")
  ) {
    return `${trimmed}}${source.slice(trimmed.length)}`;
  }
  return source;
}

function normalizeToolCallV1(input: {
  name: string;
  arguments: Record<string, unknown>;
  allowedToolNames: ReadonlySet<string>;
}): { name: string; arguments: Record<string, unknown> } {
  if (input.allowedToolNames.has(input.name)) {
    return { name: input.name, arguments: input.arguments };
  }
  const declared = [...input.allowedToolNames].sort().join(", ") || "none";
  throw new Error(
    `Gemma requested an unknown tool: ${input.name}. Declared tools: ${declared}.`,
  );
}

class GemmaArgumentsParserV1 {
  #index = 0;
  #implicitObjectSeparators = 0;
  constructor(
    readonly source: string,
    readonly maximumImplicitObjectSeparators = 0,
    readonly maximumTrailingStructuralClosers = 0,
    readonly bareStringEnumValues: ReadonlySet<string> = new Set(),
    readonly allowTrailingCollectionCommas = false,
  ) {}

  parse(): Record<string, unknown> {
    const value = this.#value();
    this.#space();
    // The pinned Gemma model can emit one duplicated root boundary after a
    // complete provider-projected workflow object. Ignore only closing
    // structure characters at the absolute tail and only when that local
    // projection explicitly opts in. Nested/truncated values still fail.
    let trailingStructuralClosers = 0;
    while (
      trailingStructuralClosers < this.maximumTrailingStructuralClosers &&
      (this.source[this.#index] === "}" || this.source[this.#index] === "]")
    ) {
      this.#index += 1;
      trailingStructuralClosers += 1;
      this.#space();
    }
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
    // The pinned Gemma tool template describes enum fields as STRING but the
    // model can serialize a declared enum member without its string delimiter.
    // Accept only an exact value from the currently bound tool schema. An
    // arbitrary identifier is still malformed and the canonical host schema
    // remains authoritative for the complete object.
    const bareString = this.source.slice(this.#index).match(
      /^[A-Za-z_][A-Za-z0-9_-]*/u,
    )?.[0];
    if (bareString && this.bareStringEnumValues.has(bareString)) {
      this.#index += bareString.length;
      return bareString;
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

  #looksLikeKey(): boolean {
    this.#space();
    return this.source.startsWith(STRING_DELIMITER, this.#index) ||
      this.source[this.#index] === '"' ||
      /^[A-Za-z_][A-Za-z0-9_-]*/u.test(this.source.slice(this.#index));
  }

  #object(): Record<string, unknown> {
    const object: Record<string, unknown> = {};
    if (this.#take("}")) return object;
    while (true) {
      const key = this.#key();
      if (!this.#take(":")) throw new Error("Gemma tool argument key is missing ':'.");
      object[key] = this.#value();
      if (this.#take("}")) return object;
      if (this.#take(",")) {
        if (this.allowTrailingCollectionCommas && this.#take("}")) return object;
        continue;
      }
      // Gemma 4 occasionally omits field separators in an otherwise complete
      // terminal answer object. Tolerate only this answer grammar, with a hard
      // ceiling above the maximum separators in the projected block schema.
      // Arbitrary/eval tool calls retain strict parsing, and host schema plus
      // evidence validation still gates the resulting packet.
      if (
        this.#implicitObjectSeparators < this.maximumImplicitObjectSeparators &&
        this.#looksLikeKey()
      ) {
        this.#implicitObjectSeparators += 1;
        continue;
      }
      throw new Error(
        `Gemma tool argument object is missing ',' at byte ${this.#index}.`,
      );
    }
  }

  #array(): unknown[] {
    const array: unknown[] = [];
    if (this.#take("]")) return array;
    while (true) {
      array.push(this.#value());
      if (this.#take("]")) return array;
      if (!this.#take(",")) throw new Error("Gemma tool argument array is missing ','.");
      if (this.allowTrailingCollectionCommas && this.#take("]")) return array;
    }
  }
}

export interface ParsedGemmaResponseV1 {
  text: string;
  toolCalls: LocalModelToolCallV1[];
  thought?: string;
}

/** Parse only the pinned Gemma 4 response-template grammar. */
export function parseGemma4ResponseV1(input: {
  requestId: string;
  raw: string;
  allowedToolNames: ReadonlySet<string>;
  maximumImplicitObjectSeparators?: number;
  maximumTrailingStructuralClosers?: number;
  bareStringEnumValues?: ReadonlySet<string>;
  allowTrailingCollectionCommas?: boolean;
}): ParsedGemmaResponseV1 {
  let remaining = input.raw;
  let thought: string | undefined;
  if (remaining.startsWith("<|channel>thought\n")) {
    const thoughtEnd = remaining.indexOf("<channel|>");
    if (thoughtEnd < 0) throw new Error("Gemma thinking channel is unterminated.");
    thought = remaining.slice("<|channel>thought\n".length, thoughtEnd);
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
    // A host stopping criterion may terminate a forced tool call immediately
    // after its complete argument object, before Gemma emits TOOL_CLOSE.
    // Parsing still requires the entire remaining body to be one valid object,
    // so truncated or trailing output remains invalid.
    const body = remaining.slice(
      start + TOOL_OPEN.length,
      end < 0 ? remaining.length : end,
    );
    const match = /^call:([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)([\s\S]+)$/u.exec(body);
    if (!match?.[1] || !match[2]) throw new Error("Gemma tool call has an invalid header.");
    const normalized = normalizeToolCallV1({
      name: match[1],
      arguments: new GemmaArgumentsParserV1(
        terminalAnswerArgumentBoundaryV1(match[2], match[1]),
        Math.max(
          match[1] === "ChatAnswerDraftV2" ? 32 : 0,
          input.maximumImplicitObjectSeparators ?? 0,
        ),
        input.maximumTrailingStructuralClosers ?? 0,
        input.bareStringEnumValues,
        input.allowTrailingCollectionCommas ?? false,
      ).parse(),
      allowedToolNames: input.allowedToolNames,
    });
    toolCalls.push({
      id: `local-${input.requestId}-${toolCalls.length}`,
      name: normalized.name,
      arguments: normalized.arguments,
    });
    remaining = end < 0 ? "" : remaining.slice(end + TOOL_CLOSE.length);
  }

  text = text
    .replace(/^(?:<\|turn>model\n|<tool_response\|>)/u, "")
    .replace(/(?:<turn\|>|<\|tool_response>|<eos>)+$/u, "")
    .trim();
  if (!text && toolCalls.length === 0) {
    throw new Error("Gemma returned neither text nor a tool call.");
  }
  return { text, toolCalls, ...(thought ? { thought } : {}) };
}
