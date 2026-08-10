import {
  PINNED_ADF_MARK_TYPES,
  PINNED_ADF_NODE_TYPES,
  PINNED_ADF_STAGE0_NODE_TYPES,
  type PinnedAdfMarkType,
  type PinnedAdfNodeType,
  type PinnedAdfStage0NodeType,
} from "@atlcli/change-set/adf";

export {
  PINNED_ADF_SCHEMA_PACKAGE,
  PINNED_ADF_SCHEMA_VERSION,
  PINNED_ADF_MARK_TYPES,
  PINNED_ADF_NODE_TYPES,
  PINNED_ADF_STAGE0_NODE_TYPES,
  isPinnedAdfMarkType,
  isPinnedAdfNodeType,
  isPinnedAdfStage0NodeType,
  isSupportedAdfNodeType,
  type PinnedAdfMarkType,
  type PinnedAdfNodeType,
  type PinnedAdfStage0NodeType,
  type SupportedAdfNodeType,
} from "@atlcli/change-set/adf";
export type AdfCoverageProvenance =
  | "schema-only"
  | "observed-cloud"
  | "legacy-observed";
export type AdfCoverageLevel = "native" | "partial" | "fallback" | "missing";
export type AdfDecoderMode = "native" | "approximation" | "visible-fallback";

export interface AdfCoverageRow {
  kind: "node" | "mark";
  type: string;
  parser: "validated";
  decoder: AdfCoverageLevel;
  docx: AdfCoverageLevel | "not-applicable";
  pdf: AdfCoverageLevel | "not-applicable";
  provenance: readonly AdfCoverageProvenance[];
}

/** Exhaustive implementation classification consumed by the ADF decoder. */
export const ADF_NODE_DECODE_MODES = Object.freeze({
  blockCard: "native",
  blockTaskItem: "native",
  blockquote: "native",
  bodiedExtension: "approximation",
  bodiedSyncBlock: "approximation",
  bulletList: "native",
  caption: "native",
  codeBlock: "native",
  date: "native",
  decisionItem: "native",
  decisionList: "native",
  doc: "native",
  embedCard: "native",
  emoji: "approximation",
  expand: "approximation",
  extension: "approximation",
  hardBreak: "native",
  heading: "native",
  inlineCard: "native",
  inlineExtension: "approximation",
  layoutColumn: "native",
  layoutSection: "native",
  listItem: "native",
  media: "native",
  mediaGroup: "native",
  mediaInline: "approximation",
  mediaSingle: "native",
  mention: "native",
  nestedExpand: "approximation",
  orderedList: "native",
  panel: "approximation",
  paragraph: "native",
  placeholder: "native",
  rule: "native",
  status: "native",
  syncBlock: "approximation",
  table: "approximation",
  tableCell: "approximation",
  tableHeader: "approximation",
  tableRow: "native",
  taskItem: "native",
  taskList: "native",
  text: "native",
} as const satisfies Record<PinnedAdfNodeType, AdfDecoderMode>);

/** Exhaustive implementation classification for the separately pinned Stage-0 slice. */
export const ADF_STAGE0_NODE_DECODE_MODES = Object.freeze({
  extensionFrame: "approximation",
  multiBodiedExtension: "approximation",
} as const satisfies Record<PinnedAdfStage0NodeType, AdfDecoderMode>);

/** Exhaustive implementation classification consumed by the mark normalizer. */
export const ADF_MARK_DECODE_MODES = Object.freeze({
  alignment: "native",
  annotation: "approximation",
  backgroundColor: "native",
  border: "native",
  breakout: "approximation",
  code: "native",
  dataConsumer: "approximation",
  em: "native",
  fontSize: "native",
  fragment: "approximation",
  indentation: "native",
  link: "native",
  strike: "native",
  strong: "native",
  subsup: "native",
  textColor: "native",
  underline: "native",
} as const satisfies Record<PinnedAdfMarkType, AdfDecoderMode>);

function coverageLevel(mode: AdfDecoderMode): AdfCoverageLevel {
  if (mode === "native") return "native";
  if (mode === "approximation") return "partial";
  return "fallback";
}

export const ADF_COVERAGE: readonly AdfCoverageRow[] = Object.freeze([
  ...PINNED_ADF_NODE_TYPES.map((type): AdfCoverageRow => ({
    kind: "node",
    type,
    parser: "validated",
    decoder: coverageLevel(ADF_NODE_DECODE_MODES[type]),
    docx: type === "doc" ? "not-applicable" : coverageLevel(ADF_NODE_DECODE_MODES[type]),
    pdf: type === "doc" ? "not-applicable" : coverageLevel(ADF_NODE_DECODE_MODES[type]),
    provenance: ["schema-only"],
  })),
  ...PINNED_ADF_STAGE0_NODE_TYPES.map((type): AdfCoverageRow => ({
    kind: "node",
    type,
    parser: "validated",
    decoder: coverageLevel(ADF_STAGE0_NODE_DECODE_MODES[type]),
    docx: coverageLevel(ADF_STAGE0_NODE_DECODE_MODES[type]),
    pdf: coverageLevel(ADF_STAGE0_NODE_DECODE_MODES[type]),
    provenance: ["schema-only"],
  })),
  ...PINNED_ADF_MARK_TYPES.map((type): AdfCoverageRow => ({
    kind: "mark",
    type,
    parser: "validated",
    decoder: coverageLevel(ADF_MARK_DECODE_MODES[type]),
    docx: coverageLevel(ADF_MARK_DECODE_MODES[type]),
    pdf: coverageLevel(ADF_MARK_DECODE_MODES[type]),
    provenance: ["schema-only"],
  })),
]);
