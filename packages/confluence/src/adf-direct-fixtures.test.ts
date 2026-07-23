import { describe, expect, it } from "bun:test";
import {
  ADF_MARK_DECODE_MODES,
  ADF_NODE_DECODE_MODES,
  PINNED_ADF_MARK_TYPES,
  PINNED_ADF_NODE_TYPES,
  type PinnedAdfMarkType,
  type PinnedAdfNodeType,
} from "./adf-coverage.js";
import { adfToBlocks } from "./adf-to-blocks.js";

type AdfValue = Record<string, unknown>;

const text = (value: string, marks?: unknown[]): AdfValue => ({
  type: "text",
  text: value,
  ...(marks ? { marks } : {}),
});
const paragraph = (value: string | AdfValue[]): AdfValue => ({
  type: "paragraph",
  content: typeof value === "string" ? [text(value)] : value,
});
const document = (content: AdfValue[]): string => JSON.stringify({ version: 1, type: "doc", content });
const block = (node: AdfValue): string => document([node]);
const inline = (node: AdfValue): string => document([paragraph([text("before "), node, text(" after")])]);
const listItem = (value: string): AdfValue => ({ type: "listItem", content: [paragraph(value)] });
const taskItem = (value: string): AdfValue => ({
  type: "taskItem",
  attrs: { state: "TODO", localId: `task-${value}` },
  content: [paragraph(value)],
});
const media = (value: string): AdfValue => ({
  type: "media",
  attrs: { type: "file", id: `media-${value}`, alt: value },
});
const tableCell = (type: "tableCell" | "tableHeader", value: string): AdfValue => ({
  type,
  attrs: { colspan: 1, rowspan: 1 },
  content: [paragraph(value)],
});
const table = (cells: AdfValue[]): AdfValue => ({
  type: "table",
  content: [{ type: "tableRow", content: cells }],
});

/**
 * One direct decoder fixture per pinned node. Child-only nodes are exercised in
 * their smallest meaningful parent context; the key still names the exact row
 * whose presence is under test. `satisfies Record<...>` makes schema drift fail
 * compilation until a new fixture is added deliberately.
 */
const NODE_FIXTURES = {
  blockCard: block({ type: "blockCard", attrs: { url: "https://example.invalid/node-blockCard" } }),
  blockTaskItem: block({ type: "blockTaskItem", attrs: { state: "TODO" }, content: [paragraph("node-blockTaskItem")] }),
  blockquote: block({ type: "blockquote", content: [paragraph("node-blockquote")] }),
  bodiedExtension: block({
    type: "bodiedExtension",
    attrs: { extensionType: "synthetic", extensionKey: "node-bodiedExtension", parameters: {} },
    content: [paragraph("node-bodiedExtension")],
  }),
  bodiedSyncBlock: block({ type: "bodiedSyncBlock", attrs: { localId: "sync-1" }, content: [paragraph("node-bodiedSyncBlock")] }),
  bulletList: block({ type: "bulletList", content: [listItem("node-bulletList")] }),
  caption: block({
    type: "mediaSingle",
    content: [media("node-caption-media"), { type: "caption", content: [paragraph("node-caption")] }],
  }),
  codeBlock: block({ type: "codeBlock", attrs: { language: "text" }, content: [text("node-codeBlock")] }),
  date: inline({ type: "date", attrs: { timestamp: "1704067200000" } }),
  decisionItem: block({
    type: "decisionList",
    content: [{ type: "decisionItem", attrs: { state: "DECIDED" }, content: [paragraph("node-decisionItem")] }],
  }),
  decisionList: block({
    type: "decisionList",
    content: [{ type: "decisionItem", attrs: { state: "DECIDED" }, content: [paragraph("node-decisionList")] }],
  }),
  doc: document([paragraph("node-doc")]),
  embedCard: block({ type: "embedCard", attrs: { url: "https://example.invalid/node-embedCard" } }),
  emoji: inline({ type: "emoji", attrs: { shortName: ":warning:", text: "⚠️" } }),
  expand: block({ type: "expand", attrs: { title: "node-expand" }, content: [paragraph("node-expand-body")] }),
  extension: block({ type: "extension", attrs: { extensionType: "synthetic", extensionKey: "node-extension", parameters: {} } }),
  hardBreak: block(paragraph([text("node-hardBreak-a"), { type: "hardBreak" }, text("node-hardBreak-b")])),
  heading: block({ type: "heading", attrs: { level: 2 }, content: [text("node-heading")] }),
  inlineCard: inline({ type: "inlineCard", attrs: { url: "https://example.invalid/node-inlineCard" } }),
  inlineExtension: inline({ type: "inlineExtension", attrs: { extensionType: "synthetic", extensionKey: "node-inlineExtension", text: "node-inlineExtension" } }),
  layoutColumn: block({
    type: "layoutSection",
    content: [{ type: "layoutColumn", content: [paragraph("node-layoutColumn")] }],
  }),
  layoutSection: block({
    type: "layoutSection",
    content: [{ type: "layoutColumn", content: [paragraph("node-layoutSection")] }],
  }),
  listItem: block({ type: "bulletList", content: [listItem("node-listItem")] }),
  media: block(media("node-media")),
  mediaGroup: block({ type: "mediaGroup", content: [media("node-mediaGroup")] }),
  mediaInline: inline({ type: "mediaInline", attrs: { type: "file", id: "media-inline", alt: "node-mediaInline" } }),
  mediaSingle: block({ type: "mediaSingle", content: [media("node-mediaSingle")] }),
  mention: inline({ type: "mention", attrs: { id: "account-1", text: "@node-mention" } }),
  nestedExpand: block({ type: "nestedExpand", attrs: { title: "node-nestedExpand" }, content: [paragraph("node-nestedExpand-body")] }),
  orderedList: block({ type: "orderedList", attrs: { order: 2 }, content: [listItem("node-orderedList")] }),
  panel: block({ type: "panel", attrs: { panelType: "info" }, content: [paragraph("node-panel")] }),
  paragraph: block(paragraph("node-paragraph")),
  placeholder: block({ type: "placeholder", attrs: { text: "node-placeholder" } }),
  rule: block({ type: "rule" }),
  status: inline({ type: "status", attrs: { text: "node-status", color: "green" } }),
  syncBlock: block({ type: "syncBlock", attrs: { localId: "sync-2" }, content: [paragraph("node-syncBlock")] }),
  table: block(table([tableCell("tableCell", "node-table")])),
  tableCell: block(table([tableCell("tableCell", "node-tableCell")])),
  tableHeader: block(table([tableCell("tableHeader", "node-tableHeader")])),
  tableRow: block(table([tableCell("tableCell", "node-tableRow")])),
  taskItem: block({ type: "taskList", content: [taskItem("node-taskItem")] }),
  taskList: block({ type: "taskList", content: [taskItem("node-taskList")] }),
  text: block(paragraph([text("node-text")])),
} satisfies Record<PinnedAdfNodeType, string>;

const MARK_ATTRS: Record<PinnedAdfMarkType, Record<string, unknown> | undefined> = {
  alignment: { align: "center" },
  annotation: { id: "annotation-1", annotationType: "inlineComment" },
  backgroundColor: { color: "#AABBCC" },
  border: { color: "#112233", size: 1 },
  breakout: { mode: "wide" },
  code: undefined,
  dataConsumer: { sources: ["source-1"] },
  em: undefined,
  fontSize: { fontSize: "small" },
  fragment: { localId: "fragment-1", name: "node-fragment" },
  indentation: { level: 1 },
  link: { href: "https://example.invalid/mark-link" },
  strike: undefined,
  strong: undefined,
  subsup: { type: "sub" },
  textColor: { color: "#112233" },
  underline: undefined,
};

const MARK_FIXTURES = Object.fromEntries(PINNED_ADF_MARK_TYPES.map((type) => {
  const attrs = MARK_ATTRS[type];
  const mark = { type, ...(attrs ? { attrs } : {}) };
  return [
    type,
    type === "alignment" || type === "indentation" || type === "fontSize"
      ? block({ ...paragraph(`mark-${type}`), marks: [mark] })
      : block(paragraph([text(`mark-${type}`, [mark])])),
  ];
})) as Record<PinnedAdfMarkType, string>;

describe("direct ADF decoder fixtures", () => {
  it("covers every pinned node and mark exactly once", () => {
    expect(Object.keys(NODE_FIXTURES).sort()).toEqual([...PINNED_ADF_NODE_TYPES].sort());
    expect(Object.keys(MARK_FIXTURES).sort()).toEqual([...PINNED_ADF_MARK_TYPES].sort());
  });

  for (const type of PINNED_ADF_NODE_TYPES) {
    it(`decodes direct node fixture: ${type}`, () => {
      const result = adfToBlocks(NODE_FIXTURES[type], {
        pageContext: { id: "fixture-page", title: "Direct decoder fixture" },
      });
      expect(result.blocks.length, `${type} disappeared`).toBeGreaterThan(0);
      if (ADF_NODE_DECODE_MODES[type] === "visible-fallback") {
        expect(result.notes.length, `${type} fallback was silent`).toBeGreaterThan(0);
      }
      expect(result.notes.every((note) => note.source?.pageId === "fixture-page")).toBe(true);
    });
  }

  for (const type of PINNED_ADF_MARK_TYPES) {
    it(`decodes direct mark fixture: ${type}`, () => {
      const result = adfToBlocks(MARK_FIXTURES[type], {
        pageContext: { id: "fixture-page", title: "Direct decoder fixture" },
      });
      expect(JSON.stringify(result.blocks)).toContain(`mark-${type}`);
      if (ADF_MARK_DECODE_MODES[type] === "visible-fallback") {
        expect(result.notes.some((note) => note.code === "adf-mark-degraded"), `${type} fallback was silent`).toBe(true);
      }
      expect(result.notes.every((note) => note.source?.pageId === "fixture-page")).toBe(true);
    });
  }
});
