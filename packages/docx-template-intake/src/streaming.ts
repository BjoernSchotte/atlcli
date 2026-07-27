import {
  SaxesParser,
  type SaxesAttributeNS,
  type SaxesTagNS,
} from "./vendor/saxes-runtime.js";

export const DOCX_XML_LIMITS_V1 = {
  maxBytes: 2 * 1024 * 1024,
  maxCharacters: 2 * 1024 * 1024,
  maxElements: 40_000,
  maxDepth: 64,
  maxAttributes: 60_000,
  maxAttributeCharacters: 4_096,
  maxNodes: 100_000,
} as const;

export interface DocxXmlLimitsV1 {
  maxBytes: number;
  maxCharacters: number;
  maxElements: number;
  maxDepth: number;
  maxAttributes: number;
  maxAttributeCharacters: number;
  maxNodes: number;
}

export class DocxXmlPartError extends Error {
  constructor(
    readonly kind:
      | "attribute-limit"
      | "byte-limit"
      | "character-limit"
      | "doctype-forbidden"
      | "element-limit"
      | "malformed-xml"
      | "node-limit",
    readonly partRef: string
  ) {
    super(`${kind}:${partRef}`);
    this.name = "DocxXmlPartError";
  }
}

export interface XmlElementEventV1 {
  uri: string;
  local: string;
  depth: number;
  prefixes: Readonly<Record<string, string>>;
  attributes: readonly {
    uri: string;
    local: string;
    prefix: string;
    value: string;
  }[];
}

export interface XmlPartScanV1 {
  characters: number;
  elements: number;
  maxDepth: number;
  attributes: number;
  nodes: number;
}

/**
 * Namespace-aware event parser. It retains counters and caller-selected facts,
 * never a DOM, raw XML, or text nodes.
 */
export function streamXmlPart(
  partRef: string,
  bytes: Uint8Array,
  handlers: {
    open?(event: XmlElementEventV1): void;
    close?(event: { uri: string; local: string; depth: number }): void;
    text?(characters: number): void;
  } = {},
  limits: DocxXmlLimitsV1 = DOCX_XML_LIMITS_V1
): XmlPartScanV1 {
  if (bytes.byteLength > limits.maxBytes) {
    throw new DocxXmlPartError("byte-limit", partRef);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let characters = 0;
  let depth = 0;
  let maxDepth = 0;
  let elements = 0;
  let attributes = 0;
  let nodes = 0;
  let parserFailure: DocxXmlPartError | undefined;
  const prefixStack: Record<string, string>[] = [{}];
  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", () => {
    parserFailure = new DocxXmlPartError("doctype-forbidden", partRef);
    throw parserFailure;
  });
  parser.on("opentag", (tag: SaxesTagNS) => {
    depth += 1;
    elements += 1;
    nodes += 1;
    maxDepth = Math.max(maxDepth, depth);
    const values = Object.values(tag.attributes) as SaxesAttributeNS[];
    attributes += values.length;
    if (
      depth > limits.maxDepth ||
      elements > limits.maxElements ||
      attributes > limits.maxAttributes ||
      values.some(
        ({ value }) =>
          value.length > limits.maxAttributeCharacters
      )
    ) {
      parserFailure = new DocxXmlPartError(
        depth > limits.maxDepth ||
          elements > limits.maxElements
          ? "element-limit"
          : "attribute-limit",
        partRef
      );
      throw parserFailure;
    }
    if (nodes > limits.maxNodes) {
      parserFailure = new DocxXmlPartError("node-limit", partRef);
      throw parserFailure;
    }
    const prefixes = {
      ...(prefixStack[prefixStack.length - 1] ?? {}),
      ...tag.ns,
    };
    prefixStack.push(prefixes);
    handlers.open?.({
      uri: tag.uri,
      local: tag.local,
      depth,
      prefixes,
      attributes: values.map(({ uri, local, prefix, value }) => ({
        uri,
        local,
        prefix,
        value,
      })),
    });
  });
  parser.on("text", (text: string) => {
    nodes += 1;
    if (nodes > limits.maxNodes) {
      parserFailure = new DocxXmlPartError("node-limit", partRef);
      throw parserFailure;
    }
    handlers.text?.(text.length);
  });
  parser.on("closetag", (tag: SaxesTagNS) => {
    handlers.close?.({ uri: tag.uri, local: tag.local, depth });
    prefixStack.pop();
    depth -= 1;
  });
  parser.on("error", () => {
    if (!parserFailure) {
      parserFailure = new DocxXmlPartError("malformed-xml", partRef);
    }
    throw parserFailure;
  });
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += 16_384) {
      const chunk = decoder.decode(
        bytes.subarray(offset, offset + 16_384),
        { stream: true }
      );
      characters += chunk.length;
      if (characters > limits.maxCharacters) {
        throw new DocxXmlPartError("character-limit", partRef);
      }
      parser.write(chunk);
    }
    const finalChunk = decoder.decode();
    characters += finalChunk.length;
    if (characters > limits.maxCharacters) {
      throw new DocxXmlPartError("character-limit", partRef);
    }
    parser.write(finalChunk);
    parser.close();
  } catch (error) {
    if (error instanceof DocxXmlPartError) throw error;
    throw parserFailure ?? new DocxXmlPartError("malformed-xml", partRef);
  }
  return { characters, elements, maxDepth, attributes, nodes };
}
