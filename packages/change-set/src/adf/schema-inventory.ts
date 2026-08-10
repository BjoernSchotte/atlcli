/** Pinned schema package used to generate and review the ADF inventory. */
export const PINNED_ADF_SCHEMA_PACKAGE = "@atlaskit/adf-schema";
export const PINNED_ADF_SCHEMA_VERSION = "56.1.15";

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

/**
 * Nodes published by the same pinned Atlassian package in `stage-0.json` and
 * linked from the official ADF structure index, but deliberately omitted from
 * `full.json`.
 */
export const PINNED_ADF_STAGE0_NODE_TYPES = [
  "extensionFrame",
  "multiBodiedExtension",
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
export type PinnedAdfStage0NodeType = (typeof PINNED_ADF_STAGE0_NODE_TYPES)[number];
export type SupportedAdfNodeType = PinnedAdfNodeType | PinnedAdfStage0NodeType;
export type PinnedAdfMarkType = (typeof PINNED_ADF_MARK_TYPES)[number];

const nodeTypeSet: ReadonlySet<string> = new Set(PINNED_ADF_NODE_TYPES);
const stage0NodeTypeSet: ReadonlySet<string> = new Set(PINNED_ADF_STAGE0_NODE_TYPES);
const markTypeSet: ReadonlySet<string> = new Set(PINNED_ADF_MARK_TYPES);

export function isPinnedAdfNodeType(type: string): type is PinnedAdfNodeType {
  return nodeTypeSet.has(type);
}

export function isPinnedAdfStage0NodeType(type: string): type is PinnedAdfStage0NodeType {
  return stage0NodeTypeSet.has(type);
}

export function isSupportedAdfNodeType(type: string): type is SupportedAdfNodeType {
  return nodeTypeSet.has(type) || stage0NodeTypeSet.has(type);
}

export function isPinnedAdfMarkType(type: string): type is PinnedAdfMarkType {
  return markTypeSet.has(type);
}
