export const PINNED_ADF_SCHEMA_PACKAGE = "@atlaskit/adf-schema";
export const PINNED_ADF_SCHEMA_VERSION = "56.1.13";

export const PINNED_ADF_NODE_TYPES = [
  "blockCard",
  "blockTaskItem",
  "blockquote",
  "bodiedExtension",
  "bodiedSyncBlock",
  "bulletList",
  "caption",
  "codeBlock",
  "date",
  "decisionItem",
  "decisionList",
  "doc",
  "embedCard",
  "emoji",
  "expand",
  "extension",
  "hardBreak",
  "heading",
  "inlineCard",
  "inlineExtension",
  "layoutColumn",
  "layoutSection",
  "listItem",
  "media",
  "mediaGroup",
  "mediaInline",
  "mediaSingle",
  "mention",
  "nestedExpand",
  "orderedList",
  "panel",
  "paragraph",
  "placeholder",
  "rule",
  "status",
  "syncBlock",
  "table",
  "tableCell",
  "tableHeader",
  "tableRow",
  "taskItem",
  "taskList",
  "text",
] as const;

export const PINNED_ADF_MARK_TYPES = [
  "alignment",
  "annotation",
  "backgroundColor",
  "border",
  "breakout",
  "code",
  "dataConsumer",
  "em",
  "fontSize",
  "fragment",
  "indentation",
  "link",
  "strike",
  "strong",
  "subsup",
  "textColor",
  "underline",
] as const;

export type PinnedAdfNodeType = (typeof PINNED_ADF_NODE_TYPES)[number];
export type PinnedAdfMarkType = (typeof PINNED_ADF_MARK_TYPES)[number];
export type AdfCoverageProvenance =
  | "schema-only"
  | "observed-cloud"
  | "legacy-observed";
export type AdfCoverageLevel = "native" | "partial" | "fallback" | "missing";

export interface AdfCoverageRow {
  kind: "node" | "mark";
  type: string;
  parser: "validated";
  decoder: AdfCoverageLevel;
  docx: AdfCoverageLevel | "not-applicable";
  pdf: AdfCoverageLevel | "not-applicable";
  provenance: readonly AdfCoverageProvenance[];
}

const nativeNodes = new Set<string>([
  "blockquote", "bulletList", "doc", "hardBreak", "heading", "listItem",
  "paragraph", "rule", "tableHeader", "tableRow", "text",
]);
const partialNodes = new Set<string>([
  "blockCard", "bodiedExtension", "caption", "codeBlock", "date", "emoji",
  "expand", "extension", "inlineCard", "layoutColumn", "layoutSection",
  "media", "mediaSingle", "mention", "orderedList", "panel", "status",
  "table", "tableCell", "taskItem", "taskList",
]);
const fallbackNodes = new Set<string>([
  "bodiedSyncBlock", "decisionItem", "decisionList", "embedCard",
  "inlineExtension", "mediaGroup", "nestedExpand", "placeholder",
]);

const nativeMarks = new Set<string>([
  "backgroundColor", "em", "strike", "strong", "subsup", "textColor", "underline",
]);
const partialMarks = new Set<string>(["code", "link"]);

function nodeLevel(type: string): AdfCoverageLevel {
  if (nativeNodes.has(type)) return "native";
  if (partialNodes.has(type)) return "partial";
  if (fallbackNodes.has(type)) return "fallback";
  return "missing";
}

function markLevel(type: string): AdfCoverageLevel {
  if (nativeMarks.has(type)) return "native";
  if (partialMarks.has(type)) return "partial";
  return "missing";
}

export const ADF_COVERAGE: readonly AdfCoverageRow[] = Object.freeze([
  ...PINNED_ADF_NODE_TYPES.map((type): AdfCoverageRow => ({
    kind: "node",
    type,
    parser: "validated",
    decoder: nodeLevel(type),
    docx: type === "doc" ? "not-applicable" : nodeLevel(type),
    pdf: type === "doc" ? "not-applicable" : nodeLevel(type),
    provenance: ["schema-only"],
  })),
  ...PINNED_ADF_MARK_TYPES.map((type): AdfCoverageRow => ({
    kind: "mark",
    type,
    parser: "validated",
    decoder: markLevel(type),
    docx: markLevel(type),
    pdf: markLevel(type),
    provenance: ["schema-only"],
  })),
]);

const nodeTypeSet: ReadonlySet<string> = new Set(PINNED_ADF_NODE_TYPES);
const markTypeSet: ReadonlySet<string> = new Set(PINNED_ADF_MARK_TYPES);

export function isPinnedAdfNodeType(type: string): type is PinnedAdfNodeType {
  return nodeTypeSet.has(type);
}

export function isPinnedAdfMarkType(type: string): type is PinnedAdfMarkType {
  return markTypeSet.has(type);
}
