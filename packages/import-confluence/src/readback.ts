import { sha256Hex } from "@atlcli/core";
import { canonicalJson, type AdfDocument, type AdfNode } from "@atlcli/import-core";
import { SaxesParser, type SaxesTagPlain } from "./vendor/saxes-runtime.js";

export const CONFLUENCE_SEMANTIC_READBACK_SCHEMA_V1 =
  "atlcli.confluence-semantic-readback/1" as const;

const MAX_READBACK_NODES = 100_000;
const MAX_READBACK_DEPTH = 100;
const MAX_READBACK_TEXT_CODE_POINTS = 5_000_000;

type SemanticToken =
  | { kind: "open"; type: string; attrs?: Record<string, string | number> }
  | { kind: "text"; text: string; marks?: string[] }
  | { kind: "close"; type: string };

export interface ConfluenceSemanticFingerprintV1 {
  schema: typeof CONFLUENCE_SEMANTIC_READBACK_SCHEMA_V1;
  representation: "adf" | "storage";
  digest: string;
  tokenCount: number;
  textCodePoints: number;
  headingCount: number;
  listCount: number;
  tableCount: number;
  tableCellCount: number;
  mediaCount: number;
}

export interface ConfluenceSemanticReadbackV1 {
  expected: ConfluenceSemanticFingerprintV1;
  actual: ConfluenceSemanticFingerprintV1;
}

export class ConfluenceSemanticReadbackError extends Error {
  readonly expected: ConfluenceSemanticFingerprintV1;
  readonly actual: ConfluenceSemanticFingerprintV1;
  readonly mismatchIndex: number;
  readonly expectedKind: string;
  readonly actualKind: string;

  constructor(
    expected: ConfluenceSemanticFingerprintV1,
    actual: ConfluenceSemanticFingerprintV1,
    mismatchIndex: number,
    expectedKind: string,
    actualKind: string,
  ) {
    super(
      `semantic readback mismatch at token ${mismatchIndex} `
      + `(expected ${expectedKind}, actual ${actualKind}; `
      + `expected digest ${expected.digest}, actual digest ${actual.digest})`,
    );
    this.name = "ConfluenceSemanticReadbackError";
    this.expected = expected;
    this.actual = actual;
    this.mismatchIndex = mismatchIndex;
    this.expectedKind = expectedKind;
    this.actualKind = actualKind;
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function boundedPush(tokens: SemanticToken[], token: SemanticToken, depth: number, textCounter: { value: number }): void {
  if (depth > MAX_READBACK_DEPTH) throw new Error("Semantic readback exceeds the nesting budget.");
  if (tokens.length >= MAX_READBACK_NODES) throw new Error("Semantic readback exceeds the node budget.");
  if (token.kind === "text") {
    textCounter.value += [...token.text].length;
    if (textCounter.value > MAX_READBACK_TEXT_CODE_POINTS) {
      throw new Error("Semantic readback exceeds the text budget.");
    }
  }
  tokens.push(token);
}

function adfAttrs(node: Record<string, unknown>): Record<string, string | number> | undefined {
  const attrs = node.attrs && typeof node.attrs === "object" && !Array.isArray(node.attrs)
    ? node.attrs as Record<string, unknown>
    : {};
  const result: Record<string, string | number> = {};
  if (node.type === "heading" && typeof attrs.level === "number") result.level = attrs.level;
  if ((node.type === "tableCell" || node.type === "tableHeader")) {
    // Cloud materializes the semantic defaults as explicit `1` values while
    // our target encoder omits them. Only spans greater than one carry
    // information and therefore belong in the fingerprint.
    if (typeof attrs.rowspan === "number" && attrs.rowspan > 1) result.rowspan = attrs.rowspan;
    if (typeof attrs.colspan === "number" && attrs.colspan > 1) result.colspan = attrs.colspan;
  }
  if (node.type === "media") {
    if (typeof attrs.id === "string") result.id = attrs.id;
    if (typeof attrs.collection === "string") result.collection = attrs.collection;
    if (typeof attrs.alt === "string") result.alt = attrs.alt;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function adfMarks(node: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(node.marks)) return undefined;
  const marks = node.marks.map((raw, index) => {
    const mark = asRecord(raw, `ADF mark ${index}`);
    if (typeof mark.type !== "string" || mark.type.length === 0) throw new Error("ADF mark type is invalid.");
    if (mark.type !== "link") return mark.type;
    const attrs = mark.attrs && typeof mark.attrs === "object" && !Array.isArray(mark.attrs)
      ? mark.attrs as Record<string, unknown>
      : {};
    return `link:${typeof attrs.href === "string" ? normalizeConfluencePageHref(attrs.href) : ""}`;
  }).sort();
  return marks.length > 0 ? marks : undefined;
}

/**
 * Cloud canonicalizes an internal page link by dropping its optional,
 * presentation-only title slug on ADF readback. The origin, space, numeric page
 * identity, query and anchor remain semantic and are therefore retained.
 * External links and every non-matching path stay byte-strict.
 */
function normalizeConfluencePageHref(href: string): string {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return href;
  }
  const match = /^(.*\/wiki\/spaces\/[^/]+\/pages\/\d+)(?:\/[^/]*)?$/u.exec(parsed.pathname);
  if (!match) return href;
  parsed.pathname = match[1]!;
  return parsed.toString();
}

function adfTokens(input: unknown): SemanticToken[] {
  const parsed = typeof input === "string" ? JSON.parse(input) : input;
  const document = asRecord(parsed, "ADF document");
  if (document.type !== "doc" || document.version !== 1 || !Array.isArray(document.content)) {
    throw new Error("ADF readback is not a version-1 doc.");
  }
  const tokens: SemanticToken[] = [];
  const textCounter = { value: 0 };
  const visit = (raw: unknown, depth: number): void => {
    const node = asRecord(raw, "ADF node");
    if (typeof node.type !== "string" || node.type.length === 0) throw new Error("ADF node type is invalid.");
    if (node.type === "text") {
      if (typeof node.text !== "string") throw new Error("ADF text node has no string text.");
      boundedPush(tokens, {
        kind: "text",
        text: node.text,
        ...(adfMarks(node) ? { marks: adfMarks(node) } : {}),
      }, depth, textCounter);
      return;
    }
    boundedPush(tokens, {
      kind: "open",
      type: node.type,
      ...(adfAttrs(node) ? { attrs: adfAttrs(node) } : {}),
    }, depth, textCounter);
    if (node.content !== undefined && !Array.isArray(node.content)) throw new Error("ADF node content is invalid.");
    for (const child of (node.content as unknown[] | undefined) ?? []) visit(child, depth + 1);
    boundedPush(tokens, { kind: "close", type: node.type }, depth, textCounter);
  };
  for (const node of document.content) visit(node, 1);
  return tokens;
}

const STORAGE_ELEMENTS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "strong", "em", "code", "a",
  "ul", "ol", "li", "table", "tbody", "tr", "th", "td", "blockquote",
  "ac:image", "ri:attachment", "ac:structured-macro", "ac:plain-text-body",
]);

function plainAttribute(tag: SaxesTagPlain, name: string): string | undefined {
  return tag.attributes[name];
}

function storageAttrs(tag: SaxesTagPlain): Record<string, string | number> | undefined {
  const result: Record<string, string | number> = {};
  const names = ["rowspan", "colspan", "href", "ac:alt", "ac:width", "ac:name", "ri:filename"];
  for (const name of names) {
    const value = plainAttribute(tag, name);
    if (value === undefined) continue;
    if ((name === "rowspan" || name === "colspan") && /^\d+$/.test(value)) result[name] = Number(value);
    else result[name] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function storageTokens(storage: string): SemanticToken[] {
  const tokens: SemanticToken[] = [];
  const textCounter = { value: 0 };
  let depth = 0;
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) => {
    depth += 1;
    if (!STORAGE_ELEMENTS.has(tag.name)) return;
    boundedPush(tokens, {
      kind: "open",
      type: tag.name,
      ...(storageAttrs(tag) ? { attrs: storageAttrs(tag) } : {}),
    }, depth, textCounter);
  });
  const onText = (text: string): void => {
    if (text.length === 0 || /^\s+$/.test(text)) return;
    boundedPush(tokens, { kind: "text", text }, depth, textCounter);
  };
  parser.on("text", onText);
  parser.on("cdata", onText);
  parser.on("closetag", (tag) => {
    if (STORAGE_ELEMENTS.has(tag.name)) boundedPush(tokens, { kind: "close", type: tag.name }, depth, textCounter);
    depth -= 1;
  });
  parser.write(`<atlcli-root>${storage}</atlcli-root>`).close();
  return tokens;
}

function count(tokens: readonly SemanticToken[], predicate: (token: SemanticToken) => boolean): number {
  return tokens.reduce((total, token) => total + (predicate(token) ? 1 : 0), 0);
}

async function fingerprint(
  representation: "adf" | "storage",
  tokens: readonly SemanticToken[],
): Promise<ConfluenceSemanticFingerprintV1> {
  return {
    schema: CONFLUENCE_SEMANTIC_READBACK_SCHEMA_V1,
    representation,
    digest: await sha256Hex(new TextEncoder().encode(canonicalJson(tokens))),
    tokenCount: tokens.length,
    textCodePoints: tokens.reduce((total, token) => total + (token.kind === "text" ? [...token.text].length : 0), 0),
    headingCount: count(tokens, (token) => token.kind === "open" && (/^h[1-6]$/.test(token.type) || token.type === "heading")),
    listCount: count(tokens, (token) => token.kind === "open" && ["ul", "ol", "bulletList", "orderedList"].includes(token.type)),
    tableCount: count(tokens, (token) => token.kind === "open" && token.type === "table"),
    tableCellCount: count(tokens, (token) => token.kind === "open" && ["th", "td", "tableHeader", "tableCell"].includes(token.type)),
    mediaCount: count(tokens, (token) => token.kind === "open" && ["ac:image", "media"].includes(token.type)),
  };
}

function tokenKind(token: SemanticToken | undefined): string {
  return token ? `${token.kind}:${token.kind === "text" ? "text" : token.type}` : "end";
}

async function verify(
  representation: "adf" | "storage",
  expectedTokens: SemanticToken[],
  actualTokens: SemanticToken[],
): Promise<ConfluenceSemanticReadbackV1> {
  const [expected, actual] = await Promise.all([
    fingerprint(representation, expectedTokens),
    fingerprint(representation, actualTokens),
  ]);
  if (expected.digest !== actual.digest) {
    const limit = Math.max(expectedTokens.length, actualTokens.length);
    let mismatchIndex = 0;
    while (mismatchIndex < limit && canonicalJson(expectedTokens[mismatchIndex]) === canonicalJson(actualTokens[mismatchIndex])) {
      mismatchIndex += 1;
    }
    throw new ConfluenceSemanticReadbackError(
      expected,
      actual,
      mismatchIndex,
      tokenKind(expectedTokens[mismatchIndex]),
      tokenKind(actualTokens[mismatchIndex]),
    );
  }
  return { expected, actual };
}

export async function verifyAdfSemanticReadback(
  expected: AdfDocument,
  actual: string | AdfDocument,
): Promise<ConfluenceSemanticReadbackV1> {
  return verify("adf", adfTokens(expected), adfTokens(actual));
}

export async function verifyStorageSemanticReadback(
  expected: string,
  actual: string,
): Promise<ConfluenceSemanticReadbackV1> {
  return verify("storage", storageTokens(expected), storageTokens(actual));
}

export function assertAdfReadbackShape(value: unknown): asserts value is AdfDocument {
  const document = asRecord(value, "ADF document") as unknown as AdfDocument;
  adfTokens(document);
}

export type { AdfNode };
