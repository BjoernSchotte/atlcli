import { describe, expect, test } from "bun:test";
import {
  ADF_COVERAGE,
  PINNED_ADF_MARK_TYPES,
  PINNED_ADF_NODE_TYPES,
  PINNED_ADF_STAGE0_NODE_TYPES,
} from "./adf-coverage.js";
import { AdfValidationError } from "./adf-types.js";
import { validateAdf } from "./adf-validate.js";

function doc(content: unknown[] = []): Record<string, unknown> {
  return { version: 1, type: "doc", content };
}

function errorCode(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(AdfValidationError);
    return (error as AdfValidationError).code;
  }
}

describe("validateAdf", () => {
  test("accepts the minimal version-1 document", () => {
    const result = validateAdf('{"version":1,"type":"doc","content":[]}');
    expect(result.document).toEqual({ version: 1, type: "doc", content: [] });
    expect(result.diagnostics).toEqual([]);
    expect(result.stats).toMatchObject({ nodes: 1, marks: 0, maxDepth: 0 });
    expect(result.stats.inputBytes).toBe(39);
  });

  test("rejects invalid JSON, root, version, node, and mark envelopes", () => {
    expect(errorCode(() => validateAdf("{"))).toBe("invalid-json");
    expect(errorCode(() => validateAdf({ type: "paragraph", content: [] }))).toBe("invalid-root");
    expect(errorCode(() => validateAdf({ version: 2, type: "doc", content: [] }))).toBe("unsupported-version");
    expect(errorCode(() => validateAdf(doc([null])))).toBe("invalid-node");
    expect(errorCode(() => validateAdf(doc([{ type: "paragraph", marks: [null] }])))).toBe("invalid-mark");
  });

  test("checks known decoder-facing node and mark shapes", () => {
    expect(errorCode(() => validateAdf(doc([{ type: "text" }])))).toBe("invalid-node");
    expect(errorCode(() => validateAdf(doc([{ type: "heading", attrs: { level: 7 }, content: [] }])))).toBe("invalid-attributes");
    expect(errorCode(() => validateAdf(doc([{ type: "taskItem", attrs: { state: "MAYBE" }, content: [] }])))).toBe("invalid-attributes");
    expect(errorCode(() => validateAdf(doc([{ type: "text", text: "x", marks: [{ type: "link", attrs: {} }] }])))).toBe("invalid-attributes");
    expect(errorCode(() => validateAdf(doc([{ type: "text", text: "x", marks: [{ type: "subsup", attrs: { type: "sideways" } }] }])))).toBe("invalid-attributes");
  });

  test("validates optional paragraph, heading, and ordinary-list-item identities", () => {
    expect(() => validateAdf(doc([
      { type: "heading", attrs: { level: 2, localId: "" }, content: [] },
      { type: "paragraph", attrs: { localId: "paragraph-1" }, content: [] },
      {
        type: "bulletList",
        content: [{
          type: "listItem",
          attrs: { localId: "item-1" },
          content: [{ type: "paragraph", content: [] }],
        }],
      },
    ]))).not.toThrow();

    for (const node of [
      { type: "heading", attrs: { level: 2, localId: 1 }, content: [] },
      { type: "paragraph", attrs: { localId: 1 }, content: [] },
      { type: "listItem", attrs: { localId: 1 }, content: [] },
    ]) {
      expect(errorCode(() => validateAdf(doc([node])))).toBe("invalid-attributes");
    }
  });

  test("validates the complete pinned code-block attribute and child contract", () => {
    expect(() => validateAdf(doc([{
      type: "codeBlock",
      attrs: {
        language: "",
        localId: "",
        uniqueId: "",
        wrap: false,
        hideLineNumbers: true,
      },
      content: [{ type: "text", text: "", marks: [] }],
    }]))).not.toThrow();
    expect(() => validateAdf(doc([{
      type: "codeBlock",
      marks: [{ type: "breakout", attrs: { mode: "wide" } }],
      content: [{ type: "text", text: "root-only" }],
    }]))).not.toThrow();

    for (const attrs of [
      { language: 1 },
      { localId: 1 },
      { uniqueId: 1 },
      { wrap: "true" },
      { hideLineNumbers: 0 },
    ]) {
      expect(errorCode(() => validateAdf(doc([{
        type: "codeBlock",
        attrs,
        content: [],
      }])))).toBe("invalid-attributes");
    }
    for (const invalid of [
      {
        type: "codeBlock",
        marks: [{ type: "strong" }],
        content: [{ type: "text", text: "marked block" }],
      },
      {
        type: "codeBlock",
        content: [{ type: "text", text: "marked text", marks: [{ type: "strong" }] }],
      },
      {
        type: "codeBlock",
        content: [{ type: "hardBreak" }],
      },
    ]) {
      expect(errorCode(() => validateAdf(doc([invalid])))).toBe("invalid-node");
    }
    expect(errorCode(() => validateAdf(doc([{
      type: "blockquote",
      content: [{
        type: "codeBlock",
        marks: [{ type: "breakout", attrs: { mode: "wide" } }],
        content: [{ type: "text", text: "nested" }],
      }],
    }])))).toBe("invalid-node");
  });

  test("validates exact date, status, and placeholder attribute contracts", () => {
    expect(() => validateAdf(doc([{
      type: "paragraph",
      content: [
        { type: "date", attrs: { timestamp: "1704067200000", localId: "" } },
        {
          type: "status",
          attrs: { text: "Ready", color: "purple", localId: "", style: "mixedCase" },
        },
        { type: "placeholder", attrs: { text: "", localId: "" } },
      ],
    }]))).not.toThrow();

    for (const node of [
      { type: "date", attrs: { timestamp: "" } },
      { type: "date", attrs: { timestamp: "1704067200000", localId: 1 } },
      { type: "status", attrs: { text: "", color: "green" } },
      { type: "status", attrs: { text: "Ready", color: "GREEN" } },
      { type: "status", attrs: { text: "Ready", color: "teal" } },
      { type: "status", attrs: { text: "Ready", color: "green", style: 1 } },
      { type: "status", attrs: { text: "Ready", color: "green", localId: 1 } },
      { type: "placeholder", attrs: {} },
      { type: "placeholder", attrs: { text: 1 } },
      { type: "placeholder", attrs: { text: "", localId: 1 } },
    ]) {
      expect(errorCode(() => validateAdf(doc([{
        type: "paragraph",
        content: [node],
      }])))).toBe("invalid-attributes");
    }
  });

  test("validates the complete pinned mention attribute contract", () => {
    expect(() => validateAdf(doc([{
      type: "paragraph",
      content: [{
        type: "mention",
        attrs: {
          id: "collection-1",
          localId: "",
          text: "",
          accessLevel: "SITE",
          userType: "SPECIAL",
        },
      }],
    }]))).not.toThrow();

    for (const attrs of [
      {},
      { id: 1 },
      { id: "user-1", localId: 1 },
      { id: "user-1", text: 1 },
      { id: "user-1", accessLevel: 1 },
      { id: "user-1", userType: "TEAM" },
    ]) {
      expect(errorCode(() => validateAdf(doc([{
        type: "paragraph",
        content: [{ type: "mention", attrs }],
      }])))).toBe("invalid-attributes");
    }
  });

  test("validates pinned caption and disclosure contracts", () => {
    expect(() => validateAdf(doc([{
      type: "mediaSingle",
      content: [
        { type: "media", attrs: { type: "file", id: "media-1", collection: "content-1" } },
        {
          type: "caption",
          attrs: { localId: "" },
          content: [
            { type: "text", text: "Figure ", marks: [{ type: "strong" }] },
            { type: "mention", attrs: { id: "user-1" } },
            { type: "hardBreak" },
            { type: "emoji", attrs: { shortName: ":warning:" } },
          ],
        },
      ],
    }, {
      type: "expand",
      attrs: { title: "", localId: "expand-1" },
      marks: [{ type: "breakout", attrs: { mode: "full-width", width: 1024 } }],
      content: [{
        type: "nestedExpand",
        attrs: { title: "Nested", localId: "" },
        marks: [],
        content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
      }],
    }]))).not.toThrow();

    expect(errorCode(() => validateAdf(doc([{
      type: "caption",
      content: [{ type: "paragraph", content: [] }],
    }])))).toBe("invalid-node");
    expect(errorCode(() => validateAdf(doc([{
      type: "expand",
      attrs: { title: 1 },
      content: [{ type: "paragraph", content: [] }],
    }])))).toBe("invalid-attributes");
    expect(errorCode(() => validateAdf(doc([{
      type: "expand",
      content: [],
    }])))).toBe("invalid-node");
    expect(errorCode(() => validateAdf(doc([{
      type: "expand",
      marks: [{ type: "strong" }],
      content: [{ type: "paragraph", content: [] }],
    }])))).toBe("invalid-node");
    expect(errorCode(() => validateAdf(doc([{
      type: "blockquote",
      content: [{
        type: "expand",
        marks: [{ type: "breakout", attrs: { mode: "wide" } }],
        content: [{ type: "paragraph", content: [] }],
      }],
    }])))).toBe("invalid-node");
    expect(errorCode(() => validateAdf(doc([{
      type: "nestedExpand",
      content: [{ type: "paragraph", content: [] }],
    }])))).toBe("invalid-attributes");
    expect(errorCode(() => validateAdf(doc([{
      type: "nestedExpand",
      attrs: {},
      marks: [{ type: "breakout", attrs: { mode: "wide" } }],
      content: [{ type: "paragraph", content: [] }],
    }])))).toBe("invalid-node");
  });

  test("validates pinned media variants, container geometry, and border marks", () => {
    expect(() => validateAdf(doc([
      {
        type: "mediaSingle",
        attrs: {
          layout: "wrap-left",
          width: 45,
          widthType: "percentage",
          localId: "",
        },
        content: [{
          type: "media",
          attrs: {
            type: "file",
            id: "file-1",
            collection: "content-1",
            occurrenceKey: "occurrence-1",
            alt: "",
            width: 640,
            height: 480,
          },
          marks: [{ type: "border", attrs: { color: "#091e4224", size: 3 } }],
        }],
      },
      {
        type: "mediaSingle",
        attrs: { layout: "center" },
        content: [{
          type: "media",
          attrs: {
            type: "external",
            url: "https://assets.example.invalid/image.png",
          },
        }],
      },
      {
        type: "paragraph",
        content: [{
          type: "mediaInline",
          attrs: {
            type: "image",
            id: "inline-1",
            collection: "content-1",
            data: { opaque: true },
          },
        }],
      },
    ]))).not.toThrow();

    const invalidMediaAttrs = [
      { type: "file", id: "file-1" },
      { type: "file", id: "", collection: "content-1" },
      { type: "external" },
      { type: "video", id: "file-1", collection: "content-1" },
      { type: "file", id: "file-1", collection: "content-1", occurrenceKey: "" },
    ];
    for (const attrs of invalidMediaAttrs) {
      expect(errorCode(() => validateAdf(doc([{
        type: "mediaSingle",
        content: [{ type: "media", attrs }],
      }])))).toBe("invalid-attributes");
    }

    for (const attrs of [
      { layout: "floating" },
      { layout: "center", widthType: "pixel" },
      { layout: "center", width: 101, widthType: "percentage" },
      { layout: "center", widthType: "rem" },
    ]) {
      expect(errorCode(() => validateAdf(doc([{
        type: "mediaSingle",
        attrs,
        content: [{
          type: "media",
          attrs: { type: "file", id: "file-1", collection: "content-1" },
        }],
      }])))).toBe("invalid-attributes");
    }

    for (const attrs of [
      { color: "#0052CC", size: 0 },
      { color: "#GG52CC", size: 1 },
      { color: "#0052CC", size: 4 },
    ]) {
      expect(errorCode(() => validateAdf(doc([{
        type: "mediaSingle",
        content: [{
          type: "media",
          attrs: { type: "file", id: "file-1", collection: "content-1" },
          marks: [{ type: "border", attrs }],
        }],
      }])))).toBe("invalid-attributes");
    }
  });

  test("accepts the schema-defined zero ordered-list start and rejects negative or fractional starts", () => {
    expect(() => validateAdf(doc([{ type: "orderedList", attrs: { order: 0 }, content: [] }]))).not.toThrow();
    expect(errorCode(() => validateAdf(doc([{ type: "orderedList", attrs: { order: -1 }, content: [] }]))))
      .toBe("invalid-attributes");
    expect(errorCode(() => validateAdf(doc([{ type: "orderedList", attrs: { order: 1.5 }, content: [] }]))))
      .toBe("invalid-attributes");
  });

  test("validates every pinned Smart Card variant including datasource and embed geometry", () => {
    expect(() => validateAdf(doc([
      { type: "inlineCard", attrs: { data: { name: "Resolved title" }, localId: "" } },
      { type: "blockCard", attrs: { url: "https://example.invalid/block" } },
      {
        type: "blockCard",
        attrs: {
          datasource: {
            id: "provider",
            parameters: { query: "type = page" },
            views: [{ type: "table", properties: { columns: ["title"] } }],
          },
          url: "https://example.invalid/datasource",
          layout: "wide",
          width: 70,
        },
      },
      {
        type: "embedCard",
        attrs: {
          url: "https://example.invalid/embed",
          layout: "full-width",
          width: 100,
          originalHeight: 720,
          originalWidth: 1280,
        },
      },
    ]))).not.toThrow();

    const invalidCards = [
      { type: "inlineCard", attrs: { url: "https://example.invalid", data: {} } },
      { type: "blockCard", attrs: { data: {}, layout: "wide" } },
      {
        type: "blockCard",
        attrs: {
          datasource: { id: "provider", parameters: {}, views: [] },
        },
      },
      { type: "embedCard", attrs: { url: "https://example.invalid/embed" } },
      {
        type: "embedCard",
        attrs: { url: "https://example.invalid/embed", layout: "center", width: 101 },
      },
    ];
    for (const node of invalidCards) {
      expect(errorCode(() => validateAdf(doc([node])))).toBe("invalid-attributes");
    }
  });

  test("requires task/decision identities and validates their exact state contracts", () => {
    expect(() => validateAdf(doc([{
      type: "taskList",
      attrs: { localId: "tasks" },
      content: [{
        type: "taskItem",
        attrs: { localId: "task-1", state: "TODO" },
        content: [{ type: "text", text: "open" }],
      }],
    }]))).not.toThrow();
    expect(() => validateAdf(doc([{
      type: "decisionList",
      attrs: { localId: "decisions" },
      content: [{
        type: "decisionItem",
        attrs: { localId: "decision-1", state: "PRODUCT_DEFINED" },
        content: [{ type: "text", text: "retain exact state" }],
      }],
    }]))).not.toThrow();
    expect(errorCode(() => validateAdf(doc([{
      type: "taskList",
      attrs: {},
      content: [],
    }])))).toBe("invalid-attributes");
    expect(errorCode(() => validateAdf(doc([{
      type: "decisionItem",
      attrs: { localId: "decision-1" },
      content: [],
    }])))).toBe("invalid-attributes");
    expect(errorCode(() => validateAdf(doc([{
      type: "decisionItem",
      attrs: { localId: "decision-1", state: 1 },
      content: [],
    }])))).toBe("invalid-attributes");
  });

  test("accepts every pinned panel type and rejects unknown panel semantics", () => {
    for (const panelType of ["info", "note", "tip", "warning", "error", "success", "custom"]) {
      expect(() => validateAdf(doc([{
        type: "panel",
        attrs: { panelType },
        content: [{ type: "paragraph", content: [] }],
      }]))).not.toThrow();
    }
    expect(errorCode(() => validateAdf(doc([{
      type: "panel",
      attrs: { panelType: "danger" },
      content: [{ type: "paragraph", content: [] }],
    }])))).toBe("invalid-attributes");
    expect(errorCode(() => validateAdf(doc([{
      type: "panel",
      attrs: {},
      content: [{ type: "paragraph", content: [] }],
    }])))).toBe("invalid-attributes");

    expect(() => validateAdf(doc([{
      type: "panel",
      attrs: {
        panelType: "custom",
        localId: "",
        panelColor: "#123456",
        panelIcon: ":star:",
        panelIconId: "icon-id",
        panelIconText: "★",
      },
      content: [{ type: "paragraph", content: [] }],
    }]))).not.toThrow();
    for (const key of ["localId", "panelColor", "panelIcon", "panelIconId", "panelIconText"]) {
      expect(errorCode(() => validateAdf(doc([{
        type: "panel",
        attrs: { panelType: "custom", [key]: 1 },
        content: [{ type: "paragraph", content: [] }],
      }])))).toBe("invalid-attributes");
    }
  });

  test("accepts schema-defined block presentation marks and rejects invalid values", () => {
    const paragraph = (marks: unknown[]) => doc([{
      type: "paragraph",
      marks,
      content: [{ type: "text", text: "presented" }],
    }]);
    expect(() => validateAdf(paragraph([
      { type: "alignment", attrs: { align: "center" } },
      { type: "indentation", attrs: { level: 6 } },
      { type: "fontSize", attrs: { fontSize: "small" } },
    ]))).not.toThrow();
    expect(errorCode(() => validateAdf(paragraph([
      { type: "alignment", attrs: { align: "justify" } },
    ])))).toBe("invalid-attributes");
    for (const level of [0, 7, 1.5]) {
      expect(errorCode(() => validateAdf(paragraph([
        { type: "indentation", attrs: { level } },
      ])))).toBe("invalid-attributes");
    }
    for (const fontSize of ["large", 12, undefined]) {
      expect(errorCode(() => validateAdf(paragraph([
        { type: "fontSize", attrs: { fontSize } },
      ])))).toBe("invalid-attributes");
    }
  });

  test("validates exact annotation and fragment identity shapes", () => {
    const markedText = (mark: unknown) => doc([{
      type: "paragraph",
      content: [{ type: "text", text: "marked", marks: [mark] }],
    }]);
    expect(() => validateAdf(markedText({
      type: "annotation",
      attrs: { id: "", annotationType: "inlineComment" },
    }))).not.toThrow();
    expect(() => validateAdf(markedText({
      type: "fragment",
      attrs: { localId: "fragment-1", name: "" },
    }))).not.toThrow();

    for (const attrs of [
      { annotationType: "inlineComment" },
      { id: "annotation-1" },
      { id: "annotation-1", annotationType: "unsupported" },
    ]) {
      expect(errorCode(() => validateAdf(markedText({ type: "annotation", attrs }))))
        .toBe("invalid-attributes");
    }
    for (const attrs of [
      {},
      { localId: "" },
      { localId: "fragment-1", name: 1 },
    ]) {
      expect(errorCode(() => validateAdf(markedText({ type: "fragment", attrs }))))
        .toBe("invalid-attributes");
    }
  });

  test("validates the exact non-empty string-array dataConsumer contract", () => {
    const markedInlineMedia = (sources: unknown) => doc([{
      type: "paragraph",
      content: [{
        type: "mediaInline",
        attrs: { type: "image", id: "media-1", collection: "content-1" },
        marks: [{ type: "dataConsumer", attrs: { sources } }],
      }],
    }]);
    expect(() => validateAdf(markedInlineMedia(["source-a", "", "source-a"]))).not.toThrow();
    for (const sources of [undefined, "source-a", [], [1], ["source-a", null]]) {
      expect(errorCode(() => validateAdf(markedInlineMedia(sources))))
        .toBe("invalid-attributes");
    }
  });

  test("validates reference-only and embedded synced-content shapes exactly", () => {
    const attrs = { resourceId: "resource-1", localId: "" };
    expect(() => validateAdf(doc([{
      type: "syncBlock",
      attrs,
      marks: [{ type: "breakout", attrs: { mode: "wide", width: 720 } }],
    }]))).not.toThrow();
    expect(() => validateAdf(doc([{
      type: "bodiedSyncBlock",
      attrs,
      content: [{ type: "paragraph", content: [{ type: "text", text: "snapshot" }] }],
    }]))).not.toThrow();

    for (const node of [
      { type: "syncBlock", attrs: { localId: "local-1" } },
      { type: "syncBlock", attrs: { resourceId: "resource-1" } },
      { type: "syncBlock", attrs, content: [] },
      {
        type: "syncBlock",
        attrs,
        marks: [{ type: "strong" }],
      },
      { type: "bodiedSyncBlock", attrs, content: [] },
      { type: "bodiedSyncBlock", attrs },
      {
        type: "bodiedSyncBlock",
        attrs,
        content: [{ type: "text", text: "inline child" }],
      },
    ]) {
      expect(errorCode(() => validateAdf(doc([node])))).toBeDefined();
    }
  });

  test("validates the pinned table, row, and cell attribute contracts", () => {
    const table = (tableAttrs: Record<string, unknown>, cellAttrs: Record<string, unknown> = {}) =>
      doc([{
        type: "table",
        attrs: tableAttrs,
        content: [{
          type: "tableRow",
          attrs: { localId: "" },
          content: [{
            type: "tableCell",
            attrs: cellAttrs,
            content: [{ type: "paragraph", content: [] }],
          }],
        }],
      }]);

    expect(() => validateAdf(table(
      {
        displayMode: "fixed",
        isNumberColumnEnabled: false,
        layout: "align-end",
        localId: "table-1",
        width: 480.5,
      },
      {
        colspan: 1,
        rowspan: 1,
        colwidth: [120, 0],
        background: "#ffffff",
        localId: "",
        valign: "middle",
      },
    ))).not.toThrow();

    for (const attrs of [
      { displayMode: "responsive" },
      { isNumberColumnEnabled: "true" },
      { layout: "wrap-left" },
      { localId: "" },
      { width: "480" },
    ]) {
      expect(errorCode(() => validateAdf(table(attrs)))).toBe("invalid-attributes");
    }
    for (const attrs of [
      { colspan: "1" },
      { rowspan: true },
      { colwidth: [120, "auto"] },
      { background: 1 },
      { localId: 1 },
      { valign: "center" },
    ]) {
      expect(errorCode(() => validateAdf(table({}, attrs)))).toBe("invalid-attributes");
    }
  });

  test("validates pinned layout-column and breakout contracts", () => {
    const layout = (
      columnAttrs: Record<string, unknown>,
      markAttrs: Record<string, unknown> = { mode: "wide", width: 960 },
    ) => doc([{
      type: "layoutSection",
      attrs: { localId: "" },
      marks: [{ type: "breakout", attrs: markAttrs }],
      content: [{
        type: "layoutColumn",
        attrs: columnAttrs,
        content: [{ type: "paragraph", content: [] }],
      }],
    }]);

    expect(() => validateAdf(layout({
      width: 30.5,
      localId: "",
      valign: "middle",
    }))).not.toThrow();

    for (const attrs of [
      {},
      { width: -1 },
      { width: 101 },
      { width: "30" },
      { width: 30, localId: 1 },
      { width: 30, valign: "center" },
    ]) {
      expect(errorCode(() => validateAdf(layout(attrs)))).toBe("invalid-attributes");
    }
    for (const attrs of [
      {},
      { mode: "center" },
      { mode: "wide", width: "960" },
    ]) {
      expect(errorCode(() => validateAdf(layout({ width: 100 }, attrs))))
        .toBe("invalid-attributes");
    }
  });

  test("checks UTF-8 input bytes before parsing", () => {
    const raw = JSON.stringify(doc([{ type: "text", text: "🙂" }]));
    expect(errorCode(() => validateAdf(raw, { budget: { maxInputBytes: raw.length } })))
      .toBe("input-too-large");
  });

  test("enforces node, depth, text, mark, attribute-byte, attribute-value, and diagnostic budgets", () => {
    const twoParagraphs = doc([
      { type: "paragraph", content: [] },
      { type: "paragraph", content: [] },
    ]);
    expect(errorCode(() => validateAdf(twoParagraphs, { budget: { maxNodes: 2 } })))
      .toBe("node-budget-exceeded");

    const nested = doc([{ type: "paragraph", content: [{ type: "unknown", content: [] }] }]);
    expect(errorCode(() => validateAdf(nested, { budget: { maxDepth: 1 } })))
      .toBe("depth-budget-exceeded");

    const text = doc([{ type: "text", text: "🙂" }]);
    expect(errorCode(() => validateAdf(text, { budget: { maxTextBytes: 3 } })))
      .toBe("text-budget-exceeded");

    const marked = doc([{ type: "text", text: "x", marks: [{ type: "strong" }, { type: "em" }] }]);
    expect(errorCode(() => validateAdf(marked, { budget: { maxMarks: 1 } })))
      .toBe("mark-budget-exceeded");

    const attributes = doc([{ type: "unknown", attrs: { value: "abcdef" } }]);
    expect(errorCode(() => validateAdf(attributes, { budget: { maxAttributeBytes: 5 } })))
      .toBe("attribute-budget-exceeded");
    expect(errorCode(() => validateAdf(attributes, { budget: { maxAttributeValues: 1 } })))
      .toBe("attribute-budget-exceeded");

    const drift = doc([
      { type: "future-a" }, { type: "future-b" }, { type: "future-c" },
    ]);
    const result = validateAdf(drift, { budget: { maxDiagnostics: 2 } });
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics.at(-1)).toMatchObject({ kind: "diagnostics-truncated", count: 2 });
  });

  test("walks deeply nested documents iteratively without overflowing the call stack", () => {
    let child: Record<string, unknown> = { type: "text", text: "end" };
    for (let depth = 0; depth < 5_000; depth += 1) {
      child = { type: "future-container", content: [child] };
    }
    const result = validateAdf(doc([child]), {
      budget: { maxDepth: 5_002, maxNodes: 5_010, maxDiagnostics: 1 },
    });
    expect(result.stats.nodes).toBe(5_002);
    expect(result.stats.maxDepth).toBe(5_001);
  });

  test("preserves unknown node, mark, and attribute names as bounded drift", () => {
    const result = validateAdf(doc([{
      type: "futureNode",
      futureEnvelope: true,
      attrs: { futureAttr: "kept" },
      marks: [{ type: "futureMark", attrs: { futureMarkAttr: 1 } }],
    }]));
    expect(result.document.content[0]).toMatchObject({ type: "futureNode" });
    expect(result.diagnostics.map(({ kind }) => kind)).toEqual([
      "unknown-attribute",
      "unknown-node",
      "unknown-attribute",
      "unknown-mark",
      "unknown-attribute",
    ]);
  });

  test("validates the separately pinned multi-bodied Stage-0 extension contract", () => {
    const valid = validateAdf(doc([{
      type: "multiBodiedExtension",
      attrs: {
        extensionType: "com.example.stage0",
        extensionKey: "multi-frame",
        layout: "wide",
        localId: "multi-local",
        parameters: { mode: "portable" },
        text: "fallback",
      },
      content: [
        {
          type: "extensionFrame",
          marks: [
            { type: "fragment", attrs: { localId: "frame-fragment", name: "" } },
            { type: "dataConsumer", attrs: { sources: ["source-a"] } },
          ],
          content: [{
            type: "paragraph",
            content: [{ type: "text", text: "Frame one" }],
          }],
        },
        {
          type: "extensionFrame",
          content: [{
            type: "panel",
            attrs: { panelType: "info" },
            content: [{
              type: "paragraph",
              content: [{ type: "text", text: "Frame two" }],
            }],
          }],
        },
      ],
    }]));
    expect(valid.diagnostics).toEqual([]);

    expect(errorCode(() => validateAdf(doc([{
      type: "extensionFrame",
      content: [{ type: "paragraph", content: [] }],
    }])))).toBe("invalid-node");
    expect(errorCode(() => validateAdf(doc([{
      type: "multiBodiedExtension",
      attrs: { extensionType: "x", extensionKey: "y" },
      content: [{ type: "paragraph", content: [] }],
    }])))).toBe("invalid-node");
    expect(errorCode(() => validateAdf(doc([{
      type: "multiBodiedExtension",
      attrs: { extensionType: "x", extensionKey: "y", layout: "center" },
      content: [],
    }])))).toBe("invalid-attributes");
    expect(errorCode(() => validateAdf(doc([{
      type: "multiBodiedExtension",
      attrs: { extensionType: "x", extensionKey: "y" },
      content: [{
        type: "extensionFrame",
        marks: [{ type: "strong" }],
        content: [{ type: "paragraph", content: [] }],
      }],
    }])))).toBe("invalid-node");
  });

  test("rejects prototype-polluting keys, non-plain objects, cycles, shared objects, and non-finite numbers", () => {
    const polluted = JSON.parse('{"version":1,"type":"doc","content":[{"type":"future","attrs":{"__proto__":{"x":1}}}]}');
    expect(errorCode(() => validateAdf(polluted))).toBe("invalid-attributes");

    const constructorKey = JSON.parse('{"version":1,"type":"doc","content":[{"type":"future","attrs":{"constructor":1}}]}');
    expect(errorCode(() => validateAdf(constructorKey))).toBe("invalid-attributes");

    expect(errorCode(() => validateAdf(doc([{ type: "future", attrs: new Date() }]))))
      .toBe("invalid-attributes");

    const cyclicAttrs: Record<string, unknown> = {};
    cyclicAttrs.self = cyclicAttrs;
    expect(errorCode(() => validateAdf(doc([{ type: "future", attrs: cyclicAttrs }]))))
      .toBe("invalid-attributes");

    const shared = { type: "paragraph", content: [] };
    expect(errorCode(() => validateAdf(doc([shared, shared])))).toBe("invalid-node");
    expect(errorCode(() => validateAdf(doc([{ type: "future", attrs: { value: Number.NaN } }]))))
      .toBe("invalid-attributes");
  });

  test("classifies every pinned schema node and mark exactly once", () => {
    expect(PINNED_ADF_NODE_TYPES).toHaveLength(43);
    expect(PINNED_ADF_STAGE0_NODE_TYPES).toHaveLength(2);
    expect(PINNED_ADF_MARK_TYPES).toHaveLength(17);
    expect(new Set(PINNED_ADF_NODE_TYPES).size).toBe(43);
    expect(new Set(PINNED_ADF_STAGE0_NODE_TYPES).size).toBe(2);
    expect(new Set(PINNED_ADF_MARK_TYPES).size).toBe(17);
    expect(ADF_COVERAGE.filter(({ kind }) => kind === "node").map(({ type }) => type).sort())
      .toEqual([...PINNED_ADF_NODE_TYPES, ...PINNED_ADF_STAGE0_NODE_TYPES].sort());
    expect(ADF_COVERAGE.filter(({ kind }) => kind === "mark").map(({ type }) => type).sort())
      .toEqual([...PINNED_ADF_MARK_TYPES].sort());
  });
});
