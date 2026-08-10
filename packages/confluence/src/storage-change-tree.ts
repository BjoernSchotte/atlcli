import type {
  CanonicalJsonObject,
  CanonicalJsonValue,
  CanonicalSourceNodeV1,
  ChangeDiagnosticV1,
  IdentityHintV1,
  SemanticDocumentNodeV1,
  SemanticPathV1,
  SemanticTreeSnapshotV1,
  SemanticTreeShardVisitResultV1,
  SemanticTreeShardVisitorV1,
  SnapshotRefV1,
} from "@atlcli/change-set";
import {
  visitXmlTopLevel,
  type StorageParseBudget,
  type XmlElement,
  type XmlNode,
} from "./export-blocks.js";

export interface StorageChangeTreeBudgetV1 extends StorageParseBudget {
  /** Maximum UTF-8 bytes accepted before XML materialization. */
  maxInputBytes: number;
}

/**
 * Deliberately tighter than the export parser's two-million-node default.
 * Diff matching adds a second tree plus indexes, so its parse boundary must
 * leave headroom for those later bounded phases.
 */
export const DEFAULT_STORAGE_CHANGE_TREE_BUDGET_V1:
Readonly<StorageChangeTreeBudgetV1> = Object.freeze({
  maxInputBytes: 8 * 1024 * 1024,
  maxNodes: 200_000,
  maxDepth: 128,
  maxTextLength: 6 * 1024 * 1024,
});

export class StorageChangeTreeInputErrorV1 extends Error {
  constructor(
    public readonly kind: "input-too-large",
    message: string,
  ) {
    super(message);
    this.name = "StorageChangeTreeInputErrorV1";
  }
}

export interface StorageChangeTreeResultV1 {
  sourceTree: CanonicalSourceNodeV1;
  semanticTree: SemanticDocumentNodeV1;
  diagnostics: readonly ChangeDiagnosticV1[];
}

export interface CanonicalizeStorageOptionsV1 {
  budget?: Partial<StorageChangeTreeBudgetV1>;
}

const encoder = new TextEncoder();
const RAW_ILLEGAL_XML_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/gu;
const NUMERIC_ENTITY = /&#(?:x([0-9a-f]+)|([0-9]+));/giu;

const FORMAT_WHITESPACE_CONTAINERS = new Set([
  "#root",
  "ac:layout",
  "ac:layout-section",
  "ac:structured-macro",
  "ac:rich-text-body",
  "ac:task-list",
  "table",
  "tbody",
  "thead",
  "tfoot",
  "tr",
  "ul",
  "ol",
]);

const TRANSPARENT_ELEMENTS = new Set([
  "ac:layout",
  "ac:rich-text-body",
  "tbody",
  "thead",
  "tfoot",
]);

const MARK_ELEMENTS: Readonly<Record<string, string>> = Object.freeze({
  strong: "strong",
  b: "strong",
  em: "em",
  i: "em",
  code: "code",
  s: "strike",
  del: "strike",
  u: "underline",
  sub: "subsup:sub",
  sup: "subsup:sup",
});

const KNOWN_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  h1: new Set(["local-id"]),
  h2: new Set(["local-id"]),
  h3: new Set(["local-id"]),
  h4: new Set(["local-id"]),
  h5: new Set(["local-id"]),
  h6: new Set(["local-id"]),
  p: new Set(["local-id"]),
  ol: new Set(["start"]),
  li: new Set(["local-id"]),
  "ac:emoticon": new Set(["ac:name", "ac:emoji-fallback"]),
  "ac:layout-section": new Set(["ac:type"]),
  "ac:layout-cell": new Set([]),
  table: new Set([]),
  tr: new Set([]),
  th: new Set(["bgcolor", "colspan", "rowspan"]),
  td: new Set(["bgcolor", "colspan", "rowspan"]),
  "ac:structured-macro": new Set(["ac:name", "ac:macro-id"]),
  "ac:parameter": new Set(["ac:name"]),
  "ac:task-list": new Set(["ac:local-id"]),
  "ac:task": new Set([]),
  "ac:task-id": new Set([]),
  "ac:task-status": new Set([]),
  "ac:task-body": new Set([]),
  time: new Set(["datetime"]),
});

function mergeBudget(
  override: Partial<StorageChangeTreeBudgetV1> | undefined,
): StorageChangeTreeBudgetV1 {
  const budget = { ...DEFAULT_STORAGE_CHANGE_TREE_BUDGET_V1, ...override };
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`Storage change-tree ${name} must be a positive safe integer.`);
    }
  }
  return budget;
}

function isIllegalXmlCodePoint(codePoint: number): boolean {
  return codePoint <= 0x08 ||
    codePoint === 0x0b ||
    codePoint === 0x0c ||
    (codePoint >= 0x0e && codePoint <= 0x1f) ||
    codePoint === 0x7f ||
    codePoint === 0xfffe ||
    codePoint === 0xffff;
}

function countStrippedIllegalControls(storage: string): number {
  let count = storage.match(RAW_ILLEGAL_XML_CHARACTERS)?.length ?? 0;
  for (const match of storage.matchAll(NUMERIC_ENTITY)) {
    const codePoint = Number.parseInt(match[1] ?? match[2] ?? "", match[1] ? 16 : 10);
    if (Number.isFinite(codePoint) && isIllegalXmlCodePoint(codePoint)) count += 1;
  }
  return count;
}

function canonicalAttributes(attributes: Readonly<Record<string, string>>): CanonicalJsonObject {
  const out: Record<string, CanonicalJsonValue> = {};
  for (const key of Object.keys(attributes).sort()) out[key] = attributes[key]!;
  return out;
}

function identityHints(attributes: Readonly<Record<string, string>>): IdentityHintV1[] {
  const hints: IdentityHintV1[] = [];
  for (const attribute of ["local-id", "ac:local-id", "ac:macro-id", "data-node-id"]) {
    const value = attributes[attribute];
    if (!value) continue;
    hints.push({
      kind: attribute === "ac:macro-id" || attribute === "data-node-id" ? "node-id" : "local-id",
      value,
      stability: attribute === "data-node-id" ? "context" : "stable",
      attribute,
      semantic: false,
    });
  }
  return hints;
}

function taskIdentityHint(element: XmlElement): IdentityHintV1[] {
  const taskId = element.children.find((child): child is XmlElement =>
    child.type === "element" && child.name === "ac:task-id"
  );
  const value = taskId ? textContent(taskId).trim() : "";
  return value
    ? [{ kind: "local-id", value, stability: "stable", attribute: "ac:task-id", semantic: false }]
    : [];
}

function canonicalNode(node: XmlNode, path: SemanticPathV1): CanonicalSourceNodeV1 {
  if (node.type === "text") {
    return {
      kind: "text",
      attributes: {},
      text: node.text,
      children: [],
      sourcePath: path,
      identityHints: [],
    };
  }
  const children = meaningfulChildren(node).map((child, index) =>
    canonicalNode(child, [...path, "children", index])
  );
  return {
    kind: node.name,
    attributes: canonicalAttributes(node.attrs),
    children,
    sourcePath: path,
    identityHints: identityHints(node.attrs),
  };
}

function meaningfulChildren(parent: XmlElement): XmlNode[] {
  if (!FORMAT_WHITESPACE_CONTAINERS.has(parent.name)) return parent.children;
  return parent.children.filter((child) => child.type !== "text" || child.text.trim() !== "");
}

function semanticNode(
  kind: string,
  path: SemanticPathV1,
  options: {
    attributes?: CanonicalJsonObject;
    text?: string;
    children?: readonly SemanticDocumentNodeV1[];
    identityHints?: readonly IdentityHintV1[];
    coverage?: SemanticDocumentNodeV1["coverage"];
    label?: string;
  } = {},
): SemanticDocumentNodeV1 {
  return {
    kind,
    attributes: options.attributes ?? {},
    ...(options.text !== undefined ? { text: options.text } : {}),
    children: options.children ?? [],
    sourcePaths: [path],
    identityHints: options.identityHints ?? [],
    coverage: options.coverage ?? "exact",
    ...(options.label !== undefined ? { label: options.label } : {}),
  };
}

function hasUnknownAttributes(element: XmlElement): boolean {
  const allowed = KNOWN_ATTRIBUTES[element.name];
  if (!allowed) return Object.keys(element.attrs).length > 0;
  return Object.keys(element.attrs).some((key) => !allowed.has(key));
}

function integerAttribute(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(value);
  if (!match) return value;
  const hex = match[1]!;
  return `#${(hex.length === 3 ? [...hex].map((part) => part + part).join("") : hex).toUpperCase()}`;
}

function textContent(element: XmlElement): string {
  const parts: string[] = [];
  const stack: XmlNode[] = [...element.children].reverse();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === "text") parts.push(current.text);
    else stack.push(...[...current.children].reverse());
  }
  return parts.join("");
}

function parameter(element: XmlElement, name: string): string | undefined {
  const candidate = element.children.find((child): child is XmlElement =>
    child.type === "element" &&
    child.name === "ac:parameter" &&
    child.attrs["ac:name"]?.toLowerCase() === name.toLowerCase()
  );
  return candidate ? textContent(candidate) : undefined;
}

function projectChildren(
  parent: XmlElement,
  path: SemanticPathV1,
  marks: readonly string[] = [],
): SemanticDocumentNodeV1[] {
  return meaningfulChildren(parent).flatMap((child, index) =>
    projectNode(child, [...path, "children", index], marks)
  );
}

function projectTableCellChildren(
  element: XmlElement,
  path: SemanticPathV1,
): SemanticDocumentNodeV1[] {
  const projected = projectChildren(element, path);
  if (projected.length === 0 || projected.some((child) => child.kind !== "text")) return projected;
  return [semanticNode("paragraph", path, { children: projected })];
}

function taskBody(element: XmlElement): XmlElement | undefined {
  return element.children.find((child): child is XmlElement =>
    child.type === "element" && child.name === "ac:task-body"
  );
}

function projectTaskBody(
  element: XmlElement,
  path: SemanticPathV1,
  marks: readonly string[],
): SemanticDocumentNodeV1[] {
  return meaningfulChildren(element).flatMap((child, index) =>
    child.type === "element" && child.name === "ac:task-list"
      ? []
      : projectNode(child, [...path, "children", index], marks)
  );
}

function nestedTaskLists(
  element: XmlElement,
  path: SemanticPathV1,
  marks: readonly string[],
): SemanticDocumentNodeV1[] {
  return meaningfulChildren(element).flatMap((child, index) =>
    child.type === "element" && child.name === "ac:task-list"
      ? projectNode(child, [...path, "children", index], marks)
      : []
  );
}

function semanticMarks(marks: readonly string[]): CanonicalJsonValue {
  return marks.map((type): CanonicalJsonObject => {
    const [markType, markValue] = type.split(":", 2);
    return markValue === undefined
      ? { type: markType!, attributes: {} }
      : { type: markType!, attributes: { type: markValue } };
  });
}

function projectNode(
  node: XmlNode,
  path: SemanticPathV1,
  marks: readonly string[] = [],
): SemanticDocumentNodeV1[] {
  if (node.type === "text") {
    const attributes: CanonicalJsonObject = marks.length > 0
      ? { marks: semanticMarks(marks) }
      : {};
    return [semanticNode("text", path, { attributes, text: node.text })];
  }

  const mark = MARK_ELEMENTS[node.name];
  if (mark) return projectChildren(node, path, [...marks, mark].sort());
  if (TRANSPARENT_ELEMENTS.has(node.name)) return projectChildren(node, path, marks);

  const hints = identityHints(node.attrs);
  const unknownAttributes = hasUnknownAttributes(node);
  const coverage: SemanticDocumentNodeV1["coverage"] = unknownAttributes ? "opaque" : "exact";
  const children = (): SemanticDocumentNodeV1[] => projectChildren(node, path, marks);

  if (/^h[1-6]$/u.test(node.name)) {
    return [semanticNode("heading", path, {
      label: textContent(node).slice(0, 120),
      attributes: { level: Number(node.name.slice(1)) },
      children: children(),
      identityHints: hints,
      coverage,
    })];
  }

  switch (node.name) {
    case "p":
      return [semanticNode("paragraph", path, { children: children(), identityHints: hints, coverage })];
    case "br":
      return [semanticNode("line-break", path)];
    case "hr":
      return [semanticNode("rule", path)];
    case "blockquote":
      return [semanticNode("blockquote", path, { children: children(), coverage })];
    case "ul":
      return [semanticNode("list", path, {
        attributes: { ordered: false },
        children: children(),
        coverage,
      })];
    case "ol":
      return [semanticNode("list", path, {
        attributes: { order: integerAttribute(node.attrs.start, 1), ordered: true },
        children: children(),
        coverage,
      })];
    case "li":
      return [semanticNode("list-item", path, { children: children(), identityHints: hints, coverage })];
    case "ac:task-list":
      return [semanticNode("list", path, {
        attributes: { listKind: "task" },
        children: meaningfulChildren(node).flatMap((child, index) => {
          if (child.type !== "element" || child.name !== "ac:task") {
            return projectNode(child, [...path, "children", index], marks);
          }
          const projectedTask = projectNode(child, [...path, "children", index], marks);
          const body = taskBody(child);
          return body
            ? [...projectedTask, ...nestedTaskLists(body, [...path, "children", index], marks)]
            : projectedTask;
        }),
        identityHints: hints,
        coverage,
      })];
    case "ac:task": {
      const status = node.children.find((child): child is XmlElement =>
        child.type === "element" && child.name === "ac:task-status"
      );
      const body = taskBody(node);
      return [semanticNode("list-item", path, {
        attributes: { state: status && textContent(status).trim().toLowerCase() === "complete" ? "DONE" : "TODO" },
        children: body ? projectTaskBody(body, path, marks) : [],
        identityHints: taskIdentityHint(node),
        coverage,
      })];
    }
    case "ac:task-id":
    case "ac:task-status":
      return [];
    case "ac:task-body":
      return projectChildren(node, path, marks);
    case "table":
      return [semanticNode("table", path, { children: children(), coverage })];
    case "tr":
      return [semanticNode("tableRow", path, { children: children(), coverage })];
    case "th":
    case "td": {
      const background = normalizeColor(node.attrs.bgcolor);
      return [semanticNode("table-cell", path, {
        attributes: {
          header: node.name === "th",
          colspan: integerAttribute(node.attrs.colspan, 1),
          rowspan: integerAttribute(node.attrs.rowspan, 1),
          ...(background ? { background } : {}),
        },
        children: projectTableCellChildren(node, path),
        coverage,
      })];
    }
    case "ac:emoticon":
      return [semanticNode("emoji", path, {
        attributes: {
          shortName: node.attrs["ac:name"] ?? "",
          ...(node.attrs["ac:emoji-fallback"] ? { text: node.attrs["ac:emoji-fallback"] } : {}),
        },
        coverage,
      })];
    case "time": {
      const datetime = node.attrs.datetime ?? "";
      const parsed = Date.parse(`${datetime}T00:00:00.000Z`);
      return [semanticNode("date", path, {
        attributes: { timestamp: Number.isNaN(parsed) ? datetime : String(parsed) },
        coverage,
      })];
    }
    case "ac:placeholder":
      return [semanticNode("placeholder", path, {
        attributes: { text: textContent(node) },
        coverage,
      })];
    case "ac:layout-section": {
      const cells = meaningfulChildren(node).filter((child): child is XmlElement =>
        child.type === "element" && child.name === "ac:layout-cell"
      );
      const type = node.attrs["ac:type"];
      const widths = type === "two_left_sidebar" ? [30, 70] : cells.map(() => Math.floor(100 / Math.max(cells.length, 1)));
      const columns = cells.map((cell, index) => semanticNode("layoutColumn", [...path, "children", index], {
        attributes: { width: widths[index] ?? widths[widths.length - 1] ?? 100 },
        children: projectChildren(cell, [...path, "children", index]),
        coverage: hasUnknownAttributes(cell) ? "opaque" : "exact",
      }));
      return [semanticNode("layoutSection", path, { children: columns, coverage })];
    }
    case "ac:layout-cell":
      return [semanticNode("layoutColumn", path, { children: children(), coverage })];
    case "ac:structured-macro": {
      const macroName = node.attrs["ac:name"]?.toLowerCase() ?? "";
      if (["info", "note", "tip", "warning"].includes(macroName)) {
        return [semanticNode("panel", path, {
          attributes: { panelType: macroName },
          children: node.children.flatMap((child, index) =>
            child.type === "element" && child.name === "ac:rich-text-body"
              ? projectChildren(child, [...path, "children", index])
              : []
          ),
          identityHints: hints,
          coverage,
        })];
      }
      if (macroName === "status") {
        return [semanticNode("status", path, {
          attributes: {
            text: parameter(node, "title") ?? "",
            color: (parameter(node, "colour") ?? "neutral").toLowerCase(),
          },
          identityHints: hints,
          coverage,
        })];
      }
      return [opaqueNode(node, path)];
    }
    default:
      return [opaqueNode(node, path)];
  }
}

function opaqueNode(element: XmlElement, path: SemanticPathV1): SemanticDocumentNodeV1 {
  return semanticNode("opaque", path, {
    label: element.name,
    attributes: canonicalAttributes(element.attrs),
    text: textContent(element),
    children: projectChildren(element, path),
    identityHints: identityHints(element.attrs),
    coverage: "opaque",
  });
}

export function canonicalizeStorageV1(
  storage: string,
  options: CanonicalizeStorageOptionsV1 = {},
): StorageChangeTreeResultV1 {
  const sourceChildren: CanonicalSourceNodeV1[] = [];
  const semanticChildren: SemanticDocumentNodeV1[] = [];
  const visited = visitStorageSemanticShardsV1(storage, (shard) => {
    sourceChildren.push(shard.sourceTree);
    semanticChildren.push(...shard.semanticNodes);
  }, options);
  return {
    sourceTree: { ...visited.sourceRoot, children: sourceChildren },
    semanticTree: { ...visited.semanticRoot, children: semanticChildren },
    diagnostics: visited.diagnostics,
  };
}

/** Parse once, then project one canonical top-level Storage shard at a time. */
export function visitStorageSemanticShardsV1(
  storage: string,
  visitor: SemanticTreeShardVisitorV1,
  options: CanonicalizeStorageOptionsV1 = {},
): SemanticTreeShardVisitResultV1 {
  const budget = mergeBudget(options.budget);
  const inputBytes = encoder.encode(storage).byteLength;
  if (inputBytes > budget.maxInputBytes) {
    throw new StorageChangeTreeInputErrorV1(
      "input-too-large",
      `Storage change input exceeds the ${budget.maxInputBytes}-byte limit.`,
    );
  }

  const parseBudget = {
    maxNodes: budget.maxNodes,
    maxDepth: budget.maxDepth,
    maxTextLength: budget.maxTextLength,
  };
  const illegalControls = countStrippedIllegalControls(storage);
  const diagnostics: ChangeDiagnosticV1[] = illegalControls > 0 ? [{
    code: "policy-noise",
    severity: "info",
    message: `${illegalControls} XML-illegal control character(s) were removed by the Storage noise policy.`,
    path: [],
  }] : [];

  const sourceRoot = canonicalNode({ type: "element", name: "#root", attrs: {}, children: [] }, []);
  const semanticRoot = semanticNode("document", [], { attributes: { version: 1 } });
  let shardCount = 0;
  visitXmlTopLevel(storage, parseBudget, (child) => {
    if (child.type === "text" && child.text.trim() === "") return;
    const path: SemanticPathV1 = ["children", shardCount];
    visitor({
      index: shardCount,
      sourceTree: canonicalNode(child, path),
      semanticNodes: projectNode(child, path),
    });
    shardCount += 1;
  });
  return {
    sourceRoot,
    semanticRoot,
    shardCount,
    diagnostics,
  };
}

export function storageSemanticTreeSnapshotV1(
  storage: string,
  ref: Omit<SnapshotRefV1, "digest">,
  options: CanonicalizeStorageOptionsV1 = {},
): SemanticTreeSnapshotV1 {
  if (ref.representation !== "storage") {
    throw new TypeError("A Storage semantic-tree snapshot requires representation=storage.");
  }
  const result = canonicalizeStorageV1(storage, options);
  return {
    ref,
    sourceTree: result.sourceTree,
    semanticTree: result.semanticTree,
    ...(result.diagnostics.length > 0 ? { diagnostics: result.diagnostics } : {}),
  };
}
