import { canonicalJsonV1 } from "../canonical-json.js";
import type {
  CanonicalJsonObject,
  CanonicalJsonValue,
  ChangeDiagnosticV1,
  SemanticPathV1,
} from "../types.js";
import type {
  CanonicalMarkV1,
  CanonicalSourceNodeV1,
  IdentityHintV1,
  SemanticDocumentNodeV1,
  SemanticTreeShardVisitResultV1,
  SemanticTreeShardVisitorV1,
} from "../semantic-tree.js";
import { isSupportedAdfNodeType } from "./schema-inventory.js";
import { isTrustedValidatedAdf } from "./trust.js";
import { DEFAULT_ADF_PARSE_BUDGET } from "./types.js";
import type {
  AdfDiagnostic,
  AdfJsonValue,
  AdfMark,
  AdfNode,
  AdfParseBudget,
  ValidatedAdfDocument,
} from "./types.js";
import { AdfValidationError } from "./types.js";
import { validateAdf } from "./validate.js";

export type AdfAttributePolicyClassV1 =
  | "semantic"
  | "identity-only"
  | "noise"
  | "opaque";

/** Reviewed policy. Unclassified validated attributes remain semantic. */
export const ADF_ATTRIBUTE_POLICY_V1 = Object.freeze({
  schema: "atlcli.adf-attribute-policy/1",
  defaults: Object.freeze({ validated: "semantic", unknown: "opaque" }),
  nodeIdentityOnly: Object.freeze({
    "*": Object.freeze(["localId"]),
    codeBlock: Object.freeze(["uniqueId"]),
  }),
  markIdentityOnly: Object.freeze({
    annotation: Object.freeze(["id"]),
    fragment: Object.freeze(["localId"]),
    link: Object.freeze(["collection", "id", "occurrenceKey"]),
  }),
  noise: Object.freeze({
    attributes: Object.freeze([] as string[]),
    structural: Object.freeze(["object-key-order", "mark-order", "adjacent-equivalent-text"]),
  }),
} as const);

export function classifyAdfAttributeV1(input: {
  scope: "node" | "mark";
  type: string;
  attribute: string;
  unknown?: boolean;
}): AdfAttributePolicyClassV1 {
  if (input.unknown) return "opaque";
  if (input.scope === "node") {
    if (input.attribute === "localId") return "identity-only";
    if (input.type === "codeBlock" && input.attribute === "uniqueId") {
      return "identity-only";
    }
  } else {
    const identity = ADF_ATTRIBUTE_POLICY_V1.markIdentityOnly[
      input.type as keyof typeof ADF_ATTRIBUTE_POLICY_V1.markIdentityOnly
    ] as readonly string[] | undefined;
    if (identity?.includes(input.attribute)) return "identity-only";
  }
  return "semantic";
}

export interface AdfCanonicalizationResultV1 {
  sourceTree: CanonicalSourceNodeV1;
  semanticTree: SemanticDocumentNodeV1;
  diagnostics: readonly ChangeDiagnosticV1[];
}

export interface AdfStreamingShardOptionsV1 {
  budget?: Partial<AdfParseBudget>;
  /** Number of top-level nodes validated together; bounded independently of input size. */
  batchNodes?: number;
}

interface DiagnosticIndex {
  unknownNodes: ReadonlySet<string>;
  unknownMarks: ReadonlySet<string>;
  unknownAttributes: ReadonlyMap<string, ReadonlySet<string>>;
  truncated: boolean;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function adfPath(path: SemanticPathV1): string {
  let out = "$";
  for (let index = 0; index < path.length; index += 2) {
    out += `.${String(path[index])}[${String(path[index + 1])}]`;
  }
  return out;
}

function diagnosticIndex(diagnostics: readonly AdfDiagnostic[]): DiagnosticIndex {
  const unknownNodes = new Set<string>();
  const unknownMarks = new Set<string>();
  const attributes = new Map<string, Set<string>>();
  let truncated = false;
  for (const diagnostic of diagnostics) {
    if (diagnostic.kind === "diagnostics-truncated") {
      truncated = true;
      continue;
    }
    if (diagnostic.kind === "unknown-node") unknownNodes.add(diagnostic.path);
    if (diagnostic.kind === "unknown-mark") unknownMarks.add(diagnostic.path);
    if (diagnostic.kind === "unknown-attribute" && diagnostic.attribute) {
      const atPath = attributes.get(diagnostic.path) ?? new Set<string>();
      atPath.add(diagnostic.attribute);
      attributes.set(diagnostic.path, atPath);
    }
  }
  return { unknownNodes, unknownMarks, unknownAttributes: attributes, truncated };
}

function canonicalValue(value: unknown): CanonicalJsonValue {
  // validateAdf() has already enforced the bounded JSON-only contract. Keep
  // the original value here; canonicalJsonV1 sorts keys at every comparison
  // and digest edge, so cloning every attribute only adds retained heap.
  return value as CanonicalJsonValue;
}

function canonicalObject(value: Record<string, unknown>): CanonicalJsonObject {
  return value as CanonicalJsonObject;
}

function identityHints(
  type: string,
  attrs: Record<string, AdfJsonValue>,
  unknownAttrs: ReadonlySet<string>,
): IdentityHintV1[] {
  const hints: IdentityHintV1[] = [];
  const add = (
    kind: IdentityHintV1["kind"],
    attribute: string,
    stability: IdentityHintV1["stability"],
    semantic = true,
  ): void => {
    if (unknownAttrs.has(attribute)) return;
    const value = attrs[attribute];
    if (typeof value !== "string" || value.length === 0) return;
    hints.push({ kind, value, stability, attribute, semantic });
  };
  add("local-id", "localId", "stable", false);
  if (type === "codeBlock") add("unique-id", "uniqueId", "stable", false);
  if (type === "bodiedSyncBlock" || type === "syncBlock") {
    add("resource-id", "resourceId", "stable");
  }
  if (type === "media" || type === "mediaInline") add("media-id", "id", "stable");
  if (type === "mention") add("node-id", "id", "context");
  return hints.sort((left, right) => compareText(
    `${left.kind}\u0000${left.value}`,
    `${right.kind}\u0000${right.value}`,
  ));
}

function canonicalMarks(
  marks: readonly AdfMark[] | undefined,
  nodePath: string,
  index: DiagnosticIndex,
  note: (diagnostic: ChangeDiagnosticV1) => void,
  semanticPath: SemanticPathV1,
): CanonicalMarkV1[] | undefined {
  if (!marks || marks.length === 0) return undefined;
  const canonical = marks.map((mark, markIndex): CanonicalMarkV1 => {
    const path = `${nodePath}.marks[${markIndex}]`;
    const unknownAttrs = index.unknownAttributes.get(path) ?? new Set<string>();
    const attributes: Record<string, CanonicalJsonValue> = {};
    const semanticAttributes: Record<string, CanonicalJsonValue> = {};
    const opaqueAttributes: Record<string, CanonicalJsonValue> = {};
    for (const [key, value] of Object.entries(mark.attrs ?? {}).sort(([left], [right]) => compareText(left, right))) {
      const canonical = canonicalValue(value);
      if (unknownAttrs.has(key)) opaqueAttributes[key] = canonical;
      else {
        attributes[key] = canonical;
        if (classifyAdfAttributeV1({
          scope: "mark",
          type: mark.type,
          attribute: key,
        }) === "semantic") {
          semanticAttributes[key] = canonical;
        }
      }
    }
    if (Object.keys(opaqueAttributes).length > 0) {
      attributes.$opaqueAttributes = opaqueAttributes;
      semanticAttributes.$opaqueAttributes = opaqueAttributes;
    }
    return {
      type: mark.type,
      attributes: canonicalObject(attributes),
      semanticAttributes: canonicalObject(semanticAttributes),
      opaque: index.truncated || index.unknownMarks.has(path) || Object.keys(opaqueAttributes).length > 0,
    };
  });
  const original = canonical.map((mark) => canonicalJsonV1(mark));
  canonical.sort((left, right) => compareText(canonicalJsonV1(left), canonicalJsonV1(right)));
  if (original.some((signature, markIndex) => signature !== canonicalJsonV1(canonical[markIndex]))) {
    note({
      code: "policy-noise",
      severity: "info",
      message: "ADF mark order was canonicalized because marks are an unordered set.",
      path: semanticPath,
    });
  }
  return canonical;
}

function canonicalNode(
  node: AdfNode,
  path: SemanticPathV1,
  index: DiagnosticIndex,
  note: (diagnostic: ChangeDiagnosticV1) => void,
  childrenOverride?: readonly CanonicalSourceNodeV1[],
): CanonicalSourceNodeV1 {
  const sourcePath = adfPath(path);
  const runtime = node as unknown as Record<string, unknown>;
  const unknownAttrs = index.unknownAttributes.get(sourcePath) ?? new Set<string>();
  const attributes: Record<string, CanonicalJsonValue> = {};
  const opaqueAttributes: Record<string, CanonicalJsonValue> = {};
  for (const [key, value] of Object.entries(node.attrs ?? {}).sort(([left], [right]) => compareText(left, right))) {
    const canonical = canonicalValue(value);
    if (unknownAttrs.has(key)) opaqueAttributes[key] = canonical;
    else attributes[key] = canonical;
  }
  if (node.type === "doc") attributes.version = 1;
  if (Object.keys(opaqueAttributes).length > 0) {
    attributes.$opaqueAttributes = opaqueAttributes;
  }
  const envelope: Record<string, CanonicalJsonValue> = {};
  for (const key of Object.keys(runtime).sort()) {
    if (["type", "attrs", "content", "marks", "text", "version"].includes(key)) continue;
    envelope[key] = canonicalValue(runtime[key]);
  }
  if (Object.keys(envelope).length > 0) attributes.$opaqueEnvelope = envelope;

  const marks = canonicalMarks(node.marks, sourcePath, index, note, path);
  const children = childrenOverride ?? (node.content ?? []).map((child, childIndex) =>
    canonicalNode(child, [...path, "content", childIndex], index, note));
  const merged: CanonicalSourceNodeV1[] = [];
  for (const child of children) {
    const previous = merged.at(-1);
    if (
      previous?.kind === "text" && child.kind === "text" &&
      previous.identityHints.length === 0 && child.identityHints.length === 0 &&
      canonicalJsonV1(previous.attributes) === canonicalJsonV1(child.attributes) &&
      canonicalJsonV1(previous.marks ?? []) === canonicalJsonV1(child.marks ?? [])
    ) {
      merged[merged.length - 1] = {
        ...previous,
        text: `${previous.text ?? ""}${child.text ?? ""}`,
      };
      note({
        code: "policy-noise",
        severity: "info",
        message: "Adjacent ADF text nodes with equal marks were merged canonically.",
        path: previous.sourcePath,
      });
    } else {
      merged.push(child);
    }
  }
  return {
    kind: node.type,
    attributes: canonicalObject(attributes),
    ...(node.text !== undefined ? { text: node.text } : {}),
    ...(marks ? { marks } : {}),
    children: merged,
    sourcePath: path,
    identityHints: identityHints(node.type, node.attrs ?? {}, unknownAttrs),
  };
}

function mergeAdjacentTextNode(
  previous: CanonicalSourceNodeV1,
  child: CanonicalSourceNodeV1,
): CanonicalSourceNodeV1 | undefined {
  if (
    previous.kind !== "text" || child.kind !== "text" ||
    previous.identityHints.length > 0 || child.identityHints.length > 0 ||
    canonicalJsonV1(previous.attributes) !== canonicalJsonV1(child.attributes) ||
    canonicalJsonV1(previous.marks ?? []) !== canonicalJsonV1(child.marks ?? [])
  ) {
    return undefined;
  }
  return {
    ...previous,
    text: `${previous.text ?? ""}${child.text ?? ""}`,
  };
}

const projectedTypes = new Set([
  "bodiedExtension",
  "bodiedSyncBlock",
  "extension",
  "extensionFrame",
  "inlineExtension",
  "multiBodiedExtension",
  "syncBlock",
]);

function semanticKind(type: string): string {
  if (["bulletList", "orderedList", "taskList", "decisionList"].includes(type)) return "list";
  if (["listItem", "taskItem", "blockTaskItem", "decisionItem"].includes(type)) return "list-item";
  if (["tableCell", "tableHeader"].includes(type)) return "table-cell";
  if (["blockCard", "embedCard", "inlineCard"].includes(type)) return "card";
  if (["extension", "bodiedExtension", "inlineExtension", "multiBodiedExtension"].includes(type)) return "extension";
  if (type === "hardBreak") return "line-break";
  if (type === "doc") return "document";
  return type;
}

function semanticAttributes(node: CanonicalSourceNodeV1): {
  attributes: CanonicalJsonObject;
  opaque: boolean;
} {
  const output: Record<string, CanonicalJsonValue> = {};
  let opaque = false;
  for (const [key, value] of Object.entries(node.attributes)) {
    if (key === "$opaqueAttributes" || key === "$opaqueEnvelope") {
      output[key] = value;
      opaque = true;
      continue;
    }
    const hint = node.identityHints.find((candidate) => candidate.attribute === key && candidate.semantic === false);
    if (hint) continue;
    output[key] = value;
  }
  if (node.marks) {
    const semanticMarks = node.marks.map((mark) => ({
      type: mark.type,
      attributes: mark.semanticAttributes ?? mark.attributes,
    }));
    semanticMarks.sort((left, right) => compareText(canonicalJsonV1(left), canonicalJsonV1(right)));
    output.marks = canonicalValue(semanticMarks);
    if (node.marks.some((mark) => mark.opaque)) opaque = true;
  }
  if (node.kind === "orderedList") output.ordered = true;
  if (node.kind === "bulletList") output.ordered = false;
  if (node.kind === "taskList") output.listKind = "task";
  if (node.kind === "decisionList") output.listKind = "decision";
  if (node.kind === "tableHeader") output.header = true;
  if (node.kind === "tableCell") output.header = false;
  if (["blockCard", "embedCard", "inlineCard"].includes(node.kind)) output.cardKind = node.kind;
  return { attributes: canonicalObject(output), opaque };
}

function visibleText(node: CanonicalSourceNodeV1): string {
  if (node.text) return node.text;
  return node.children.map(visibleText).join("");
}

function semanticNode(
  node: CanonicalSourceNodeV1,
  index: DiagnosticIndex,
): SemanticDocumentNodeV1 {
  const projected = semanticAttributes(node);
  const unknown = index.truncated || !isSupportedAdfNodeType(node.kind);
  const coverage = unknown || projected.opaque
    ? "opaque"
    : projectedTypes.has(node.kind)
      ? "projected"
      : "exact";
  const labelSource =
    node.kind === "heading" || node.kind === "status" || node.kind === "codeBlock"
      ? visibleText(node)
      : typeof node.attributes.extensionKey === "string"
        ? node.attributes.extensionKey
        : undefined;
  return {
    kind: semanticKind(node.kind),
    ...(labelSource ? { label: labelSource.slice(0, 120) } : {}),
    attributes: projected.attributes,
    ...(node.text !== undefined ? { text: node.text } : {}),
    children: node.children.map((child) => semanticNode(child, index)),
    sourcePaths: [node.sourcePath],
    identityHints: node.identityHints,
    coverage,
  };
}

/** Validate, canonicalize, and project one ADF document without host coupling. */
export function canonicalizeAdfV1(
  input: string | unknown | ValidatedAdfDocument,
  options: { budget?: Partial<AdfParseBudget> } = {},
): AdfCanonicalizationResultV1 {
  const sourceChildren: CanonicalSourceNodeV1[] = [];
  const semanticChildren: SemanticDocumentNodeV1[] = [];
  const visited = visitAdfSemanticShardsV1(input, (shard) => {
    sourceChildren.push(shard.sourceTree);
    semanticChildren.push(...shard.semanticNodes);
  }, options);
  return {
    sourceTree: { ...visited.sourceRoot, children: sourceChildren },
    semanticTree: { ...visited.semanticRoot, children: semanticChildren },
    diagnostics: visited.diagnostics,
  };
}

/**
 * Validate once, then project one canonical top-level ADF shard at a time.
 * The visitor is deliberately synchronous: adapters must not accumulate
 * unbounded in-flight shards behind this browser-neutral API.
 */
export function visitAdfSemanticShardsV1(
  input: string | unknown | ValidatedAdfDocument,
  visitor: SemanticTreeShardVisitorV1,
  options: { budget?: Partial<AdfParseBudget> } = {},
): SemanticTreeShardVisitResultV1 {
  const validated = isTrustedValidatedAdf(input)
    ? input
    : validateAdf(input, { budget: options.budget });
  const index = diagnosticIndex(validated.diagnostics);
  const diagnostics: ChangeDiagnosticV1[] = [];
  const maxDiagnostics = options.budget?.maxDiagnostics ?? DEFAULT_ADF_PARSE_BUDGET.maxDiagnostics;
  const note = (diagnostic: ChangeDiagnosticV1): void => {
    if (diagnostics.length < maxDiagnostics) diagnostics.push(diagnostic);
  };
  if (index.truncated) {
    note({
      code: "source-incomplete",
      severity: "warning",
      message: "ADF drift diagnostics were truncated; semantic coverage is opaque.",
      path: [],
    });
  }
  // Build only root metadata here. Top-level subtrees are projected and handed
  // to the synchronous visitor one at a time below; retaining them on the root
  // would defeat the spill lane's one-version-at-a-time memory boundary.
  const sourceRoot = canonicalNode(
    { ...validated.document, content: [] },
    [],
    index,
    note,
    [],
  );
  const semanticRoot = semanticNode(sourceRoot, index);
  let pending: CanonicalSourceNodeV1 | undefined;
  let shardCount = 0;
  const emit = (sourceTree: CanonicalSourceNodeV1): void => {
    visitor({
      index: shardCount,
      sourceTree,
      semanticNodes: [semanticNode(sourceTree, index)],
    });
    shardCount += 1;
  };
  for (const [childIndex, child] of (validated.document.content ?? []).entries()) {
    const canonical = canonicalNode(child, ["content", childIndex], index, note);
    if (pending) {
      const merged = mergeAdjacentTextNode(pending, canonical);
      if (merged) {
        pending = merged;
        note({
          code: "policy-noise",
          severity: "info",
          message: "Adjacent ADF text nodes with equal marks were merged canonically.",
          path: pending.sourcePath,
        });
        continue;
      }
      emit(pending);
    }
    pending = canonical;
  }
  if (pending) emit(pending);
  return {
    sourceRoot,
    semanticRoot,
    shardCount,
    diagnostics,
  };
}

function skipWhitespace(input: string, start: number): number {
  let index = start;
  while (index < input.length && /\s/u.test(input[index]!)) index += 1;
  return index;
}

function stringEnd(input: string, start: number): number {
  if (input[start] !== '"') throw new AdfValidationError("invalid-json", "Expected a JSON string.");
  let index = start + 1;
  while (index < input.length) {
    const char = input[index]!;
    if (char === '"') return index + 1;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char.charCodeAt(0) < 0x20) {
      throw new AdfValidationError("invalid-json", "JSON string contains a control character.");
    }
    index += 1;
  }
  throw new AdfValidationError("invalid-json", "Unterminated JSON string.");
}

function valueEnd(input: string, start: number): number {
  const first = input[start];
  if (first === '"') return stringEnd(input, start);
  if (first === "{" || first === "[") {
    const stack: string[] = [first === "{" ? "}" : "]"];
    let index = start + 1;
    while (index < input.length && stack.length > 0) {
      const char = input[index]!;
      if (char === '"') {
        index = stringEnd(input, index);
        continue;
      }
      if (char === "{") stack.push("}");
      else if (char === "[") stack.push("]");
      else if (char === "}" || char === "]") {
        if (stack.pop() !== char) {
          throw new AdfValidationError("invalid-json", "Mismatched JSON container.");
        }
      }
      index += 1;
    }
    if (stack.length > 0) throw new AdfValidationError("invalid-json", "Unterminated JSON container.");
    return index;
  }
  let index = start;
  while (index < input.length && !/[\s,}\]]/u.test(input[index]!)) index += 1;
  if (index === start) throw new AdfValidationError("invalid-json", "Missing JSON value.");
  return index;
}

function rootContentRange(input: string): { start: number; end: number } {
  let index = skipWhitespace(input, 0);
  if (input[index] !== "{") throw new AdfValidationError("invalid-root", "ADF root must be an object.");
  index += 1;
  const keys = new Set<string>();
  let content: { start: number; end: number } | undefined;
  while (true) {
    index = skipWhitespace(input, index);
    if (input[index] === "}") {
      index = skipWhitespace(input, index + 1);
      if (index !== input.length) throw new AdfValidationError("invalid-json", "Trailing JSON data.");
      break;
    }
    const keyStart = index;
    const keyEnd = stringEnd(input, keyStart);
    let key: string;
    try {
      key = JSON.parse(input.slice(keyStart, keyEnd)) as string;
    } catch {
      throw new AdfValidationError("invalid-json", "Invalid JSON object key.");
    }
    if (keys.has(key)) throw new AdfValidationError("invalid-json", `Duplicate ADF root key ${key}.`);
    keys.add(key);
    index = skipWhitespace(input, keyEnd);
    if (input[index] !== ":") throw new AdfValidationError("invalid-json", "Missing JSON colon.");
    const start = skipWhitespace(input, index + 1);
    const end = valueEnd(input, start);
    if (key === "content") content = { start, end };
    index = skipWhitespace(input, end);
    if (input[index] === ",") {
      index += 1;
      continue;
    }
    if (input[index] !== "}") throw new AdfValidationError("invalid-json", "Missing JSON object separator.");
  }
  if (!content || input[content.start] !== "[") {
    throw new AdfValidationError("invalid-root", "ADF root content must be an array.");
  }
  return content;
}

function contentElementRanges(input: string, range: { start: number; end: number }): number[] {
  const output: number[] = [];
  let index = skipWhitespace(input, range.start + 1);
  while (index < range.end - 1) {
    if (input[index] === "]") break;
    const end = valueEnd(input, index);
    output.push(index, end);
    index = skipWhitespace(input, end);
    if (input[index] === ",") {
      index = skipWhitespace(input, index + 1);
      continue;
    }
    if (input[index] !== "]") throw new AdfValidationError("invalid-json", "Missing ADF content separator.");
  }
  return output;
}

function rebasePath(path: SemanticPathV1, offset: number): SemanticPathV1 {
  if (path[0] !== "content" || typeof path[1] !== "number") return path;
  return [path[0], path[1] + offset, ...path.slice(2)];
}

function rebaseSourceTree(node: CanonicalSourceNodeV1, offset: number): CanonicalSourceNodeV1 {
  return {
    ...node,
    sourcePath: rebasePath(node.sourcePath, offset),
    children: node.children.map((child) => rebaseSourceTree(child, offset)),
  };
}

function rebaseSemanticTree(node: SemanticDocumentNodeV1, offset: number): SemanticDocumentNodeV1 {
  return {
    ...node,
    sourcePaths: node.sourcePaths.map((path) => rebasePath(path, offset)),
    children: node.children.map((child) => rebaseSemanticTree(child, offset)),
  };
}

/**
 * Stream a JSON ADF document in bounded top-level batches. Only one batch is
 * parsed/validated/projected at a time, so a large document never becomes one
 * retained JS object graph before entering the spill store.
 */
export function visitAdfSemanticJsonShardsV1(
  input: string,
  visitor: SemanticTreeShardVisitorV1,
  options: AdfStreamingShardOptionsV1 = {},
): SemanticTreeShardVisitResultV1 {
  const budget = { ...DEFAULT_ADF_PARSE_BUDGET, ...options.budget };
  const inputBytes = new TextEncoder().encode(input).byteLength;
  if (inputBytes > budget.maxInputBytes) {
    throw new AdfValidationError("input-too-large", `ADF input exceeds the ${budget.maxInputBytes}-byte limit.`);
  }
  const batchNodes = options.batchNodes ?? 4_096;
  if (!Number.isSafeInteger(batchNodes) || batchNodes < 1 || batchNodes > 4_096) {
    throw new RangeError("ADF streaming batchNodes must be between 1 and 4096.");
  }
  const content = rootContentRange(input);
  const elements = contentElementRanges(input, content);
  const rootJson = `${input.slice(0, content.start)}[]${input.slice(content.end)}`;
  const validatedRoot = validateAdf(rootJson, { budget });
  const rootVisit = visitAdfSemanticShardsV1(validatedRoot, () => {}, { budget });
  const diagnostics: ChangeDiagnosticV1[] = [...rootVisit.diagnostics];
  let nodes = validatedRoot.stats.nodes;
  let marks = validatedRoot.stats.marks;
  let textBytes = validatedRoot.stats.textBytes;
  let attributeBytes = validatedRoot.stats.attributeBytes;
  let attributeValues = validatedRoot.stats.attributeValues;
  let maxDepth = validatedRoot.stats.maxDepth;
  let shardCount = 0;

  const elementCount = elements.length / 2;
  for (let offset = 0; offset < elementCount; offset += batchNodes) {
    const batchCount = Math.min(batchNodes, elementCount - offset);
    let parsed: unknown[];
    try {
      parsed = batchCount === 0
        ? []
        : JSON.parse(`[${
            input.slice(elements[offset * 2]!, elements[(offset + batchCount - 1) * 2 + 1]!)
          }]`) as unknown[];
    } catch {
      throw new AdfValidationError("invalid-json", "ADF content contains invalid JSON.");
    }
    const document = {
      ...validatedRoot.document,
      content: parsed,
    };
    const remaining = {
      ...budget,
      maxInputBytes: budget.maxInputBytes,
      maxNodes: Math.max(1, budget.maxNodes - nodes + 1),
      maxMarks: Math.max(1, budget.maxMarks - marks),
      maxTextBytes: Math.max(1, budget.maxTextBytes - textBytes),
      maxAttributeBytes: Math.max(1, budget.maxAttributeBytes - attributeBytes),
      maxAttributeValues: Math.max(1, budget.maxAttributeValues - attributeValues),
      maxDiagnostics: Math.max(1, budget.maxDiagnostics - diagnostics.length),
    };
    const validated = validateAdf(document, { budget: remaining });
    nodes += validated.stats.nodes - 1;
    marks += validated.stats.marks;
    textBytes += validated.stats.textBytes;
    attributeBytes += validated.stats.attributeBytes;
    attributeValues += validated.stats.attributeValues;
    maxDepth = Math.max(maxDepth, validated.stats.maxDepth);
    const visited = visitAdfSemanticShardsV1(validated, (shard) => {
      const sourceTree = rebaseSourceTree(shard.sourceTree, offset);
      visitor({
        index: shardCount,
        sourceTree,
        semanticNodes: shard.semanticNodes.map((node) => rebaseSemanticTree(node, offset)),
      });
      shardCount += 1;
    }, { budget: remaining });
    diagnostics.push(...visited.diagnostics.slice(0, Math.max(0, budget.maxDiagnostics - diagnostics.length)));
  }
  if (
    nodes > budget.maxNodes || marks > budget.maxMarks || textBytes > budget.maxTextBytes ||
    attributeBytes > budget.maxAttributeBytes || attributeValues > budget.maxAttributeValues ||
    maxDepth > budget.maxDepth
  ) {
    throw new AdfValidationError("node-budget-exceeded", "ADF streaming aggregate budget exceeded.");
  }
  return {
    sourceRoot: rootVisit.sourceRoot,
    semanticRoot: rootVisit.semanticRoot,
    shardCount,
    diagnostics,
  };
}
