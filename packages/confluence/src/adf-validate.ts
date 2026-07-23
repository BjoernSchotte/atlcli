import {
  isPinnedAdfMarkType,
  isPinnedAdfNodeType,
} from "./adf-coverage.js";
import {
  AdfValidationError,
  DEFAULT_ADF_PARSE_BUDGET,
  type AdfDiagnostic,
  type AdfDocument,
  type AdfJsonValue,
  type AdfParseBudget,
  type AdfValidationStats,
  type ValidatedAdfDocument,
} from "./adf-types.js";

const utf8 = new TextEncoder();
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
const nodeEnvelopeKeys = new Set(["type", "attrs", "content", "marks", "text", "version"]);
const markEnvelopeKeys = new Set(["type", "attrs"]);

const nodeAttributeKeys: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  blockCard: new Set(["localId", "url"]),
  blockTaskItem: new Set(["localId", "state"]),
  blockquote: new Set(["localId"]),
  bodiedExtension: new Set(["extensionKey", "extensionType", "layout", "localId", "parameters", "text"]),
  bodiedSyncBlock: new Set(["localId", "resourceId"]),
  bulletList: new Set(["localId"]),
  caption: new Set(["localId"]),
  codeBlock: new Set(["hideLineNumbers", "language", "localId", "uniqueId", "wrap"]),
  date: new Set(["localId", "timestamp"]),
  decisionItem: new Set(["localId", "state"]),
  decisionList: new Set(["localId"]),
  embedCard: new Set(["layout", "localId", "originalHeight", "originalWidth", "url", "width"]),
  emoji: new Set(["id", "localId", "shortName", "text"]),
  expand: new Set(["localId", "title"]),
  extension: new Set(["extensionKey", "extensionType", "layout", "localId", "parameters", "text"]),
  hardBreak: new Set(["localId", "text"]),
  heading: new Set(["level", "localId"]),
  inlineCard: new Set(["data", "localId", "url"]),
  inlineExtension: new Set(["extensionKey", "extensionType", "localId", "parameters", "text"]),
  layoutColumn: new Set(["localId", "valign", "width"]),
  layoutSection: new Set(["localId"]),
  listItem: new Set(["localId"]),
  media: new Set(["alt", "collection", "height", "id", "localId", "occurrenceKey", "type", "url", "width"]),
  mediaInline: new Set(["alt", "collection", "data", "height", "id", "localId", "occurrenceKey", "type", "width"]),
  mediaSingle: new Set(["layout", "localId", "width", "widthType"]),
  mention: new Set(["accessLevel", "id", "localId", "text", "userType"]),
  nestedExpand: new Set(["localId", "title"]),
  orderedList: new Set(["localId", "order"]),
  panel: new Set(["localId", "panelColor", "panelIcon", "panelIconId", "panelIconText", "panelType"]),
  paragraph: new Set(["localId"]),
  placeholder: new Set(["localId", "text"]),
  rule: new Set(["localId"]),
  status: new Set(["color", "localId", "style", "text"]),
  syncBlock: new Set(["localId", "resourceId"]),
  table: new Set(["displayMode", "isNumberColumnEnabled", "layout", "localId", "width"]),
  tableCell: new Set(["background", "colspan", "colwidth", "localId", "rowspan", "valign"]),
  tableHeader: new Set(["background", "colspan", "colwidth", "localId", "rowspan", "valign"]),
  tableRow: new Set(["localId"]),
  taskItem: new Set(["localId", "state"]),
  taskList: new Set(["localId"]),
});

const markAttributeKeys: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  alignment: new Set(["align"]),
  annotation: new Set(["annotationType", "id"]),
  backgroundColor: new Set(["color"]),
  border: new Set(["color", "size"]),
  breakout: new Set(["mode", "width"]),
  dataConsumer: new Set(["sources"]),
  fontSize: new Set(["fontSize"]),
  fragment: new Set(["localId", "name"]),
  indentation: new Set(["level"]),
  link: new Set(["collection", "href", "id", "occurrenceKey", "title"]),
  subsup: new Set(["type"]),
  textColor: new Set(["color"]),
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function mergeBudget(overrides?: Partial<AdfParseBudget>): AdfParseBudget {
  const budget = { ...DEFAULT_ADF_PARSE_BUDGET, ...overrides };
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`ADF parse budget ${name} must be a non-negative safe integer.`);
    }
  }
  return budget;
}

function stringBytes(value: string): number {
  return utf8.encode(value).byteLength;
}

function assertStringAttribute(
  attrs: Record<string, unknown> | undefined,
  key: string,
  path: string,
  required = true,
): void {
  const value = attrs?.[key];
  if ((!required && value === undefined) || typeof value === "string") return;
  throw new AdfValidationError(
    "invalid-attributes",
    `ADF attribute ${key} must be a string${required ? "" : " when present"}.`,
    `${path}.attrs.${key}`,
  );
}

function validateKnownNodeShape(
  type: string,
  node: Record<string, unknown>,
  attrs: Record<string, unknown> | undefined,
  path: string,
): void {
  if (type === "text") {
    if (typeof node.text !== "string" || node.content !== undefined) {
      throw new AdfValidationError(
        "invalid-node",
        "ADF text nodes require text and cannot contain child content.",
        path,
      );
    }
  }
  if (type === "heading") {
    const level = attrs?.level;
    if (!Number.isInteger(level) || (level as number) < 1 || (level as number) > 6) {
      throw new AdfValidationError("invalid-attributes", "ADF heading level must be 1..6.", `${path}.attrs.level`);
    }
  }
  if (type === "orderedList" && attrs?.order !== undefined && !nonnegativeInteger(attrs.order)) {
    throw new AdfValidationError("invalid-attributes", "ADF ordered-list order must be non-negative.", `${path}.attrs.order`);
  }
  if (type === "taskItem" || type === "blockTaskItem") {
    if (attrs?.state !== "TODO" && attrs?.state !== "DONE") {
      throw new AdfValidationError("invalid-attributes", "ADF task state must be TODO or DONE.", `${path}.attrs.state`);
    }
  }
  if (
    type === "taskList" ||
    type === "taskItem" ||
    type === "blockTaskItem" ||
    type === "decisionList" ||
    type === "decisionItem"
  ) {
    assertStringAttribute(attrs, "localId", path);
  }
  if (type === "decisionItem") {
    assertStringAttribute(attrs, "state", path);
  }
  if (type === "panel") {
    const panelType = attrs?.panelType;
    if (
      panelType !== "info" &&
      panelType !== "note" &&
      panelType !== "tip" &&
      panelType !== "warning" &&
      panelType !== "error" &&
      panelType !== "success" &&
      panelType !== "custom"
    ) {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF panel type must be info, note, tip, warning, error, success, or custom.",
        `${path}.attrs.panelType`,
      );
    }
  }
  if (type === "date") assertStringAttribute(attrs, "timestamp", path);
  if (type === "emoji") assertStringAttribute(attrs, "shortName", path);
  if (type === "mention") assertStringAttribute(attrs, "id", path);
  if (type === "status") {
    assertStringAttribute(attrs, "text", path);
    assertStringAttribute(attrs, "color", path);
  }
  if (type === "inlineCard" || type === "blockCard" || type === "embedCard") {
    if (attrs?.url === undefined && attrs?.data === undefined) {
      throw new AdfValidationError("invalid-attributes", "ADF card requires url or data.", `${path}.attrs`);
    }
    assertStringAttribute(attrs, "url", path, false);
  }
  if (type === "extension" || type === "inlineExtension" || type === "bodiedExtension") {
    assertStringAttribute(attrs, "extensionType", path);
    assertStringAttribute(attrs, "extensionKey", path);
  }
}

function validateKnownMarkShape(
  type: string,
  attrs: Record<string, unknown> | undefined,
  path: string,
): void {
  if (type === "alignment" && attrs?.align !== "center" && attrs?.align !== "end") {
    throw new AdfValidationError(
      "invalid-attributes",
      "ADF alignment must be center or end.",
      `${path}.attrs.align`,
    );
  }
  if (type === "indentation") {
    const level = attrs?.level;
    if (!Number.isInteger(level) || (level as number) < 1 || (level as number) > 6) {
      throw new AdfValidationError(
        "invalid-attributes",
        "ADF indentation level must be an integer from 1 through 6.",
        `${path}.attrs.level`,
      );
    }
  }
  if (type === "fontSize" && attrs?.fontSize !== "small") {
    throw new AdfValidationError(
      "invalid-attributes",
      'ADF fontSize must be "small".',
      `${path}.attrs.fontSize`,
    );
  }
  if (type === "link") assertStringAttribute(attrs, "href", path);
  if (type === "textColor" || type === "backgroundColor") {
    assertStringAttribute(attrs, "color", path);
  }
  if (type === "subsup" && attrs?.type !== "sub" && attrs?.type !== "sup") {
    throw new AdfValidationError("invalid-attributes", "ADF subsup type must be sub or sup.", `${path}.attrs.type`);
  }
}

/**
 * Parse and structurally validate untrusted ADF without recursive traversal.
 *
 * Unknown node, mark, and attribute names survive as bounded drift
 * diagnostics. Malformed envelopes, hostile object graphs, and exceeded
 * resource budgets fail closed before a decoder can run.
 */
export function validateAdf(
  input: string | unknown,
  options: { budget?: Partial<AdfParseBudget> } = {},
): ValidatedAdfDocument {
  const budget = mergeBudget(options.budget);
  let value: unknown = input;
  let inputBytes: number | undefined;
  if (typeof input === "string") {
    inputBytes = stringBytes(input);
    if (inputBytes > budget.maxInputBytes) {
      throw new AdfValidationError("input-too-large", "ADF input exceeds its UTF-8 byte budget.");
    }
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      throw new AdfValidationError("invalid-json", "ADF body is not valid JSON.");
    }
  }

  if (!isPlainObject(value) || value.type !== "doc" || !Array.isArray(value.content)) {
    throw new AdfValidationError("invalid-root", "ADF root must be a doc object with content.");
  }
  if (value.version !== 1) {
    throw new AdfValidationError("unsupported-version", "Only ADF document version 1 is supported.", "$.version");
  }

  const stats: AdfValidationStats = {
    inputBytes,
    nodes: 0,
    marks: 0,
    maxDepth: 0,
    textBytes: 0,
    attributeBytes: 0,
    attributeValues: 0,
  };
  const diagnostics: AdfDiagnostic[] = [];
  let droppedDiagnostics = 0;
  const seen = new WeakSet<object>();
  const claim = (candidate: object, path: string, code: "invalid-node" | "invalid-mark" | "invalid-attributes"): void => {
    if (seen.has(candidate)) {
      throw new AdfValidationError(code, "ADF object graph contains a cycle or shared object.", path);
    }
    seen.add(candidate);
  };
  const addDiagnostic = (diagnostic: AdfDiagnostic): void => {
    if (diagnostics.length < budget.maxDiagnostics) diagnostics.push(diagnostic);
    else droppedDiagnostics += 1;
  };

  claim(value, "$", "invalid-node");
  const stack: Array<{ node: Record<string, unknown>; path: string; depth: number; claimed: boolean }> = [
    { node: value, path: "$", depth: 0, claimed: true },
  ];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const { node, path, depth } = current;
    if (!current.claimed) claim(node, path, "invalid-node");
    stats.nodes += 1;
    if (stats.nodes > budget.maxNodes) {
      throw new AdfValidationError("node-budget-exceeded", "ADF node budget exceeded.", path);
    }
    if (depth > budget.maxDepth) {
      throw new AdfValidationError("depth-budget-exceeded", "ADF depth budget exceeded.", path);
    }
    stats.maxDepth = Math.max(stats.maxDepth, depth);

    const type = node.type;
    if (typeof type !== "string" || type.length === 0 || type.length > 256) {
      throw new AdfValidationError("invalid-node", "ADF node type must be a bounded non-empty string.", `${path}.type`);
    }
    for (const key of Object.keys(node)) {
      if (forbiddenKeys.has(key)) {
        throw new AdfValidationError("invalid-node", `Forbidden ADF object key ${key}.`, `${path}.${key}`);
      }
      if (!nodeEnvelopeKeys.has(key)) {
        addDiagnostic({ kind: "unknown-attribute", path, type, attribute: key });
      }
    }
    if (!isPinnedAdfNodeType(type)) addDiagnostic({ kind: "unknown-node", path, type });

    if (node.text !== undefined) {
      if (typeof node.text !== "string") {
        throw new AdfValidationError("invalid-node", "ADF node text must be a string.", `${path}.text`);
      }
      stats.textBytes += stringBytes(node.text);
      if (stats.textBytes > budget.maxTextBytes) {
        throw new AdfValidationError("text-budget-exceeded", "ADF text budget exceeded.", `${path}.text`);
      }
    }

    let attrs: Record<string, unknown> | undefined;
    if (node.attrs !== undefined) {
      if (!isPlainObject(node.attrs)) {
        throw new AdfValidationError("invalid-attributes", "ADF node attrs must be a plain object.", `${path}.attrs`);
      }
      attrs = node.attrs;
      const allowed = nodeAttributeKeys[type] ?? new Set<string>();
      for (const key of Object.keys(attrs)) {
        if (!allowed.has(key)) addDiagnostic({ kind: "unknown-attribute", path, type, attribute: key });
      }
      validateAttributeGraph(attrs, `${path}.attrs`, budget, stats, claim);
    }
    if (isPinnedAdfNodeType(type)) validateKnownNodeShape(type, node, attrs, path);

    if (node.marks !== undefined) {
      if (!Array.isArray(node.marks)) {
        throw new AdfValidationError("invalid-node", "ADF marks must be an array.", `${path}.marks`);
      }
      claim(node.marks, `${path}.marks`, "invalid-mark");
      for (let index = 0; index < node.marks.length; index += 1) {
        const markPath = `${path}.marks[${index}]`;
        const mark = node.marks[index];
        if (!isPlainObject(mark)) {
          throw new AdfValidationError("invalid-mark", "ADF mark must be a plain object.", markPath);
        }
        claim(mark, markPath, "invalid-mark");
        stats.marks += 1;
        if (stats.marks > budget.maxMarks) {
          throw new AdfValidationError("mark-budget-exceeded", "ADF mark budget exceeded.", markPath);
        }
        if (typeof mark.type !== "string" || mark.type.length === 0 || mark.type.length > 256) {
          throw new AdfValidationError("invalid-mark", "ADF mark type must be a bounded non-empty string.", `${markPath}.type`);
        }
        for (const key of Object.keys(mark)) {
          if (forbiddenKeys.has(key)) {
            throw new AdfValidationError("invalid-mark", `Forbidden ADF object key ${key}.`, `${markPath}.${key}`);
          }
          if (!markEnvelopeKeys.has(key)) {
            addDiagnostic({ kind: "unknown-attribute", path: markPath, type: mark.type, attribute: key });
          }
        }
        if (!isPinnedAdfMarkType(mark.type)) {
          addDiagnostic({ kind: "unknown-mark", path: markPath, type: mark.type });
        }
        let markAttrs: Record<string, unknown> | undefined;
        if (mark.attrs !== undefined) {
          if (!isPlainObject(mark.attrs)) {
            throw new AdfValidationError("invalid-attributes", "ADF mark attrs must be a plain object.", `${markPath}.attrs`);
          }
          markAttrs = mark.attrs;
          const allowed = markAttributeKeys[mark.type] ?? new Set<string>();
          for (const key of Object.keys(markAttrs)) {
            if (!allowed.has(key)) {
              addDiagnostic({ kind: "unknown-attribute", path: markPath, type: mark.type, attribute: key });
            }
          }
          validateAttributeGraph(markAttrs, `${markPath}.attrs`, budget, stats, claim);
        }
        if (isPinnedAdfMarkType(mark.type)) validateKnownMarkShape(mark.type, markAttrs, markPath);
      }
    }

    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) {
        throw new AdfValidationError("invalid-node", "ADF node content must be an array.", `${path}.content`);
      }
      claim(node.content, `${path}.content`, "invalid-node");
      for (let index = node.content.length - 1; index >= 0; index -= 1) {
        const child = node.content[index];
        const childPath = `${path}.content[${index}]`;
        if (!isPlainObject(child)) {
          throw new AdfValidationError("invalid-node", "ADF child must be a plain object.", childPath);
        }
        stack.push({ node: child, path: childPath, depth: depth + 1, claimed: false });
      }
    }
  }

  if (droppedDiagnostics > 0 && budget.maxDiagnostics > 0) {
    const summary: AdfDiagnostic = {
      kind: "diagnostics-truncated",
      path: "$",
      count: droppedDiagnostics + (diagnostics.length === budget.maxDiagnostics ? 1 : 0),
    };
    if (diagnostics.length === budget.maxDiagnostics) diagnostics[diagnostics.length - 1] = summary;
    else diagnostics.push(summary);
  }

  return { document: value as unknown as AdfDocument, diagnostics, stats };
}

function validateAttributeGraph(
  root: Record<string, unknown>,
  rootPath: string,
  budget: AdfParseBudget,
  stats: AdfValidationStats,
  claim: (candidate: object, path: string, code: "invalid-attributes") => void,
): asserts root is Record<string, AdfJsonValue> {
  claim(root, rootPath, "invalid-attributes");
  const stack: Array<{ value: unknown; path: string; key?: string; claimed?: boolean }> = [
    { value: root, path: rootPath, claimed: true },
  ];
  while (stack.length > 0) {
    const current = stack.pop()!;
    stats.attributeValues += 1;
    if (stats.attributeValues > budget.maxAttributeValues) {
      throw new AdfValidationError("attribute-budget-exceeded", "ADF attribute value budget exceeded.", current.path);
    }
    if (current.key !== undefined) stats.attributeBytes += stringBytes(current.key);
    const candidate = current.value;
    if (candidate === null || typeof candidate === "boolean") {
      stats.attributeBytes += candidate === null ? 4 : candidate ? 4 : 5;
    } else if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new AdfValidationError("invalid-attributes", "ADF attributes cannot contain non-finite numbers.", current.path);
      }
      stats.attributeBytes += String(candidate).length;
    } else if (typeof candidate === "string") {
      stats.attributeBytes += stringBytes(candidate);
    } else if (Array.isArray(candidate)) {
      if (!current.claimed) claim(candidate, current.path, "invalid-attributes");
      for (let index = candidate.length - 1; index >= 0; index -= 1) {
        stack.push({ value: candidate[index], path: `${current.path}[${index}]` });
      }
    } else if (isPlainObject(candidate)) {
      if (!current.claimed) claim(candidate, current.path, "invalid-attributes");
      for (const key of Object.keys(candidate)) {
        if (forbiddenKeys.has(key)) {
          throw new AdfValidationError("invalid-attributes", `Forbidden ADF attribute key ${key}.`, `${current.path}.${key}`);
        }
        stack.push({ value: candidate[key], path: `${current.path}.${key}`, key });
      }
    } else {
      throw new AdfValidationError("invalid-attributes", "ADF attributes must contain only JSON values.", current.path);
    }
    if (stats.attributeBytes > budget.maxAttributeBytes) {
      throw new AdfValidationError("attribute-budget-exceeded", "ADF attribute byte budget exceeded.", current.path);
    }
  }
}
