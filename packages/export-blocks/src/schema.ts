import {
  EXPORT_NOTE_CODES,
  type ExportBlock,
  type ExportNote,
  type InlineNode,
} from "./index.js";

export const EXPORT_BLOCK_MODEL_SCHEMA_V1 = "atlcli.export-blocks/1" as const;

export interface ExportBlockDocumentV1 {
  schema: typeof EXPORT_BLOCK_MODEL_SCHEMA_V1;
  blocks: readonly ExportBlock[];
  notes: readonly ExportNote[];
}

export interface ExportBlockValidationBudgetV1 {
  maxDepth: number;
  maxNodes: number;
  maxStringBytes: number;
}

export const DEFAULT_EXPORT_BLOCK_VALIDATION_BUDGET_V1:
Readonly<ExportBlockValidationBudgetV1> = Object.freeze({
  maxDepth: 128,
  maxNodes: 200_000,
  maxStringBytes: 8 * 1024 * 1024,
});

export class ExportBlockValidationErrorV1 extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "ExportBlockValidationErrorV1";
  }
}

type JsonRecord = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new ExportBlockValidationErrorV1(path, message);
}

function record(value: unknown, path: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(path, "expected an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(path, "expected a plain object");
  }
  return value as JsonRecord;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) return fail(path, "expected an array");
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") return fail(path, "expected a string");
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return fail(path, "expected a boolean");
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fail(path, "expected a finite number");
  }
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  const number = finiteNumber(value, path);
  if (!Number.isSafeInteger(number) || number < 1) {
    return fail(path, "expected a positive safe integer");
  }
  return number;
}

function optional(
  object: JsonRecord,
  key: string,
  path: string,
  validate: (value: unknown, path: string) => unknown,
): void {
  if (object[key] !== undefined) validate(object[key], `${path}.${key}`);
}

function keys(object: JsonRecord, path: string, allowed: readonly string[]): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(object)) {
    if (!allow.has(key)) fail(`${path}.${key}`, "unknown field");
  }
}

function oneOf<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  const candidate = string(value, path);
  if (!(allowed as readonly string[]).includes(candidate)) {
    return fail(path, `expected one of ${allowed.join(", ")}`);
  }
  return candidate as T;
}

function jsonSafetyPass(
  value: unknown,
  budget: ExportBlockValidationBudgetV1,
): void {
  if (
    !Number.isSafeInteger(budget.maxDepth) || budget.maxDepth < 1 ||
    !Number.isSafeInteger(budget.maxNodes) || budget.maxNodes < 1 ||
    !Number.isSafeInteger(budget.maxStringBytes) || budget.maxStringBytes < 1
  ) {
    fail("$", "validation budgets must be positive safe integers");
  }

  const active = new WeakSet<object>();
  const encoder = new TextEncoder();
  let nodes = 0;
  let stringBytes = 0;

  const walk = (node: unknown, path: string, depth: number): void => {
    nodes += 1;
    if (nodes > budget.maxNodes) fail(path, "node budget exceeded");
    if (depth > budget.maxDepth) fail(path, "depth budget exceeded");
    if (typeof node === "string") {
      stringBytes += encoder.encode(node).byteLength;
      if (stringBytes > budget.maxStringBytes) fail(path, "string-byte budget exceeded");
      return;
    }
    if (node === null || typeof node === "boolean") return;
    if (typeof node === "number") {
      finiteNumber(node, path);
      return;
    }
    if (typeof node !== "object") fail(path, "expected JSON-compatible data");
    if (active.has(node)) fail(path, "cyclic value");
    active.add(node);
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${path}[${index}]`, depth + 1));
    } else {
      const object = record(node, path);
      for (const [key, entry] of Object.entries(object)) {
        walk(entry, `${path}.${key}`, depth + 1);
      }
    }
    active.delete(node);
  };
  walk(value, "$", 0);
}

function inlineArray(value: unknown, path: string): void {
  array(value, path).forEach((entry, index) => inline(entry, `${path}[${index}]`));
}

function optionalInlineContent(object: JsonRecord, key: string, path: string): void {
  if (object[key] === undefined) return;
  const caption = record(object[key], `${path}.${key}`);
  keys(caption, `${path}.${key}`, ["kind", "content", "localId"]);
  oneOf(caption.kind, `${path}.${key}.kind`, ["figure", "table", "code", "equation"]);
  inlineArray(caption.content, `${path}.${key}.content`);
  optional(caption, "localId", `${path}.${key}`, string);
}

function inline(value: unknown, path: string): void {
  const node = record(value, path);
  const type = string(node.type, `${path}.type`);
  switch (type) {
    case "text":
      keys(node, path, ["type", "text", "marks", "color", "backgroundColor", "emoji", "adfExtension", "extensionParams", "sourcePage", "annotations", "fragments", "unsupportedAdf"]);
      string(node.text, `${path}.text`);
      if (node.marks !== undefined) {
        array(node.marks, `${path}.marks`).forEach((mark, index) => oneOf(mark, `${path}.marks[${index}]`, ["bold", "italic", "code", "strike", "underline", "subscript", "superscript"]));
      }
      optional(node, "color", path, string);
      optional(node, "backgroundColor", path, string);
      return;
    case "link":
      keys(node, path, ["type", "content", "target", "adfAttributes"]);
      inlineArray(node.content, `${path}.content`);
      record(node.target, `${path}.target`);
      return;
    case "mention":
      keys(node, path, ["type", "accountId", "displayName", "sourceText", "localId", "accessLevel", "userType"]);
      string(node.accountId, `${path}.accountId`);
      optional(node, "displayName", path, string);
      optional(node, "sourceText", path, string);
      optional(node, "localId", path, string);
      optional(node, "accessLevel", path, string);
      if (node.userType !== undefined) oneOf(node.userType, `${path}.userType`, ["DEFAULT", "SPECIAL", "APP"]);
      return;
    case "date":
      keys(node, path, ["type", "timestamp", "localId"]);
      string(node.timestamp, `${path}.timestamp`);
      optional(node, "localId", path, string);
      return;
    case "status":
      keys(node, path, ["type", "text", "color", "localId", "style"]);
      string(node.text, `${path}.text`);
      string(node.color, `${path}.color`);
      optional(node, "localId", path, string);
      optional(node, "style", path, string);
      return;
    case "smartCard":
      keys(node, path, ["type", "card"]);
      record(node.card, `${path}.card`);
      return;
    case "media":
      keys(node, path, ["type", "media", "source", "alt", "width", "height", "border", "annotations", "link"]);
      record(node.media, `${path}.media`);
      if (node.source !== undefined) record(node.source, `${path}.source`);
      optional(node, "alt", path, string);
      optional(node, "width", path, finiteNumber);
      optional(node, "height", path, finiteNumber);
      return;
    case "placeholder":
      keys(node, path, ["type", "text", "localId", "placeholderType"]);
      string(node.text, `${path}.text`);
      optional(node, "localId", path, string);
      optional(node, "placeholderType", path, string);
      return;
    case "lineBreak":
      keys(node, path, ["type"]);
      return;
    default:
      fail(`${path}.type`, `unknown inline type ${type}`);
  }
}

function blockArray(value: unknown, path: string): void {
  array(value, path).forEach((entry, index) => block(entry, `${path}[${index}]`));
}

function block(value: unknown, path: string): void {
  const node = record(value, path);
  const type = string(node.type, `${path}.type`);
  switch (type) {
    case "heading":
      keys(node, path, ["type", "level", "content", "explicitAnchor", "presentation", "localId"]);
      if (positiveInteger(node.level, `${path}.level`) > 6) {
        fail(`${path}.level`, "expected an integer from 1 through 6");
      }
      inlineArray(node.content, `${path}.content`);
      optional(node, "explicitAnchor", path, string);
      optional(node, "localId", path, string);
      return;
    case "paragraph":
      keys(node, path, ["type", "content", "presentation", "localId"]);
      inlineArray(node.content, `${path}.content`);
      optional(node, "localId", path, string);
      return;
    case "smartCard":
      keys(node, path, ["type", "card"]);
      record(node.card, `${path}.card`);
      return;
    case "codeBlock":
      keys(node, path, ["type", "language", "code", "title", "initiallyCollapsed", "caption", "wrap", "hideLineNumbers", "firstLineNumber", "localId", "uniqueId", "breakout"]);
      string(node.code, `${path}.code`);
      optional(node, "language", path, string);
      optional(node, "title", path, string);
      optional(node, "initiallyCollapsed", path, boolean);
      optional(node, "wrap", path, boolean);
      optional(node, "hideLineNumbers", path, boolean);
      if (node.firstLineNumber !== undefined) positiveInteger(node.firstLineNumber, `${path}.firstLineNumber`);
      optionalInlineContent(node, "caption", path);
      return;
    case "callout":
      keys(node, path, ["type", "kind", "title", "content", "localId", "panelColor", "panelIcon", "panelIconId", "panelIconText", "panelIconProjection", "suppressDefaultIcon", "syncedContent"]);
      oneOf(node.kind, `${path}.kind`, ["info", "note", "warning", "tip", "success", "error", "panel"]);
      blockArray(node.content, `${path}.content`);
      optional(node, "title", path, string);
      optional(node, "suppressDefaultIcon", path, boolean);
      return;
    case "expand":
      keys(node, path, ["type", "nested", "content", "title", "localId", "macroId", "breakout"]);
      boolean(node.nested, `${path}.nested`);
      blockArray(node.content, `${path}.content`);
      optional(node, "title", path, string);
      return;
    case "list": {
      keys(node, path, ["type", "ordered", "items", "start", "listKind", "localId"]);
      boolean(node.ordered, `${path}.ordered`);
      array(node.items, `${path}.items`).forEach((entry, index) => {
        const itemPath = `${path}.items[${index}]`;
        const item = record(entry, itemPath);
        keys(item, itemPath, ["content", "kind", "state", "localId", "block", "checked"]);
        blockArray(item.content, `${itemPath}.content`);
        if (item.kind !== undefined) oneOf(item.kind, `${itemPath}.kind`, ["task", "decision"]);
        optional(item, "state", itemPath, string);
        optional(item, "block", itemPath, boolean);
        optional(item, "checked", itemPath, boolean);
      });
      if (node.start !== undefined) positiveInteger(node.start, `${path}.start`);
      if (node.listKind !== undefined) oneOf(node.listKind, `${path}.listKind`, ["task", "decision"]);
      return;
    }
    case "layout":
      keys(node, path, ["type", "columns", "localId", "breakout"]);
      array(node.columns, `${path}.columns`).forEach((entry, index) => {
        const columnPath = `${path}.columns[${index}]`;
        const column = record(entry, columnPath);
        keys(column, columnPath, ["width", "verticalAlignment", "localId", "content"]);
        finiteNumber(column.width, `${columnPath}.width`);
        blockArray(column.content, `${columnPath}.content`);
      });
      return;
    case "table":
      keys(node, path, ["type", "rows", "columnWidths", "presentation", "caption", "fragments"]);
      array(node.rows, `${path}.rows`).forEach((entry, rowIndex) => {
        const rowPath = `${path}.rows[${rowIndex}]`;
        const row = record(entry, rowPath);
        keys(row, rowPath, ["cells", "localId"]);
        array(row.cells, `${rowPath}.cells`).forEach((cellEntry, cellIndex) => {
          const cellPath = `${rowPath}.cells[${cellIndex}]`;
          const cell = record(cellEntry, cellPath);
          keys(cell, cellPath, ["header", "colspan", "rowspan", "backgroundColor", "columnWidths", "verticalAlignment", "localId", "content"]);
          boolean(cell.header, `${cellPath}.header`);
          positiveInteger(cell.colspan, `${cellPath}.colspan`);
          positiveInteger(cell.rowspan, `${cellPath}.rowspan`);
          blockArray(cell.content, `${cellPath}.content`);
        });
      });
      optionalInlineContent(node, "caption", path);
      return;
    case "image":
      keys(node, path, ["type", "source", "media", "alt", "width", "height", "mediaPresentation", "mediaGroup", "border", "caption", "annotations", "link"]);
      record(node.source, `${path}.source`);
      optional(node, "alt", path, string);
      optional(node, "width", path, finiteNumber);
      optional(node, "height", path, finiteNumber);
      optionalInlineContent(node, "caption", path);
      return;
    case "mediaFallback":
      keys(node, path, ["type", "label", "media", "caption", "alt", "width", "height", "mediaPresentation", "mediaGroup", "border", "annotations", "link"]);
      string(node.label, `${path}.label`);
      record(node.media, `${path}.media`);
      optionalInlineContent(node, "caption", path);
      return;
    case "blockquote":
      keys(node, path, ["type", "content"]);
      blockArray(node.content, `${path}.content`);
      return;
    case "divider":
    case "pageBreak":
      keys(node, path, ["type"]);
      return;
    case "orientation":
      keys(node, path, ["type", "landscape", "content"]);
      boolean(node.landscape, `${path}.landscape`);
      blockArray(node.content, `${path}.content`);
      return;
    case "anchor":
      keys(node, path, ["type", "name"]);
      string(node.name, `${path}.name`);
      return;
    case "unknown":
      keys(node, path, ["type", "macroName", "params", "body", "plainBody", "macroId", "adfExtension", "extensionFrames", "fragments", "unsupportedAdf", "bodyNotes", "sourcePage"]);
      string(node.macroName, `${path}.macroName`);
      if (node.body !== undefined) blockArray(node.body, `${path}.body`);
      if (node.extensionFrames !== undefined) {
        array(node.extensionFrames, `${path}.extensionFrames`).forEach((entry, index) => {
          const frame = record(entry, `${path}.extensionFrames[${index}]`);
          if (frame.content === undefined) fail(`${path}.extensionFrames[${index}].content`, "missing field");
          blockArray(frame.content, `${path}.extensionFrames[${index}].content`);
        });
      }
      optional(node, "plainBody", path, string);
      return;
    default:
      fail(`${path}.type`, `unknown block type ${type}`);
  }
}

function note(value: unknown, path: string): void {
  const entry = record(value, path);
  keys(entry, path, ["level", "code", "message", "macroName", "source"]);
  oneOf(entry.level, `${path}.level`, ["info", "warning"]);
  const code = string(entry.code, `${path}.code`);
  if (!(EXPORT_NOTE_CODES as readonly string[]).includes(code)) {
    fail(`${path}.code`, `unknown export note code ${code}`);
  }
  string(entry.message, `${path}.message`);
  optional(entry, "macroName", path, string);
  if (entry.source !== undefined) record(entry.source, `${path}.source`);
}

export function parseExportBlocksV1(
  value: unknown,
  budget: ExportBlockValidationBudgetV1 = DEFAULT_EXPORT_BLOCK_VALIDATION_BUDGET_V1,
): readonly ExportBlock[] {
  jsonSafetyPass(value, budget);
  const entries = array(value, "$blocks");
  entries.forEach((entry, index) => block(entry, `$blocks[${index}]`));
  return value as readonly ExportBlock[];
}

export function parseExportNotesV1(
  value: unknown,
  budget: ExportBlockValidationBudgetV1 = DEFAULT_EXPORT_BLOCK_VALIDATION_BUDGET_V1,
): readonly ExportNote[] {
  jsonSafetyPass(value, budget);
  const entries = array(value, "$notes");
  entries.forEach((entry, index) => note(entry, `$notes[${index}]`));
  return value as readonly ExportNote[];
}

export function parseExportBlockDocumentV1(
  value: unknown,
  budget: ExportBlockValidationBudgetV1 = DEFAULT_EXPORT_BLOCK_VALIDATION_BUDGET_V1,
): ExportBlockDocumentV1 {
  jsonSafetyPass(value, budget);
  const document = record(value, "$document");
  keys(document, "$document", ["schema", "blocks", "notes"]);
  if (document.schema !== EXPORT_BLOCK_MODEL_SCHEMA_V1) {
    fail("$document.schema", `expected ${EXPORT_BLOCK_MODEL_SCHEMA_V1}`);
  }
  const blocks = array(document.blocks, "$document.blocks");
  blocks.forEach((entry, index) => block(entry, `$document.blocks[${index}]`));
  const notes = array(document.notes, "$document.notes");
  notes.forEach((entry, index) => note(entry, `$document.notes[${index}]`));
  return value as ExportBlockDocumentV1;
}
