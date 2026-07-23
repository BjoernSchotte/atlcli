import { describe, expect, it } from "bun:test";
import {
  adfToBlocks,
  createAdfMediaAttachmentResolver,
} from "./adf-to-blocks.js";
import {
  ADF_MARK_DECODE_MODES,
  ADF_NODE_DECODE_MODES,
  PINNED_ADF_MARK_TYPES,
  PINNED_ADF_NODE_TYPES,
} from "./adf-coverage.js";
import type { ExportBlock } from "./export-blocks.js";

function doc(content: unknown[]): string {
  return JSON.stringify({ version: 1, type: "doc", content });
}

describe("adfToBlocks", () => {
  it("decodes the pinned schema-valid feature fixture", async () => {
    const raw = await Bun.file(new URL("../test-fixtures/adf/schema-feature-zoo.json", import.meta.url)).text();
    const result = adfToBlocks(raw);
    expect(result.blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "callout"]);
    expect(result.blocks[1]).toMatchObject({
      type: "paragraph",
      content: [
        { type: "text", text: "Inline code", marks: ["code"] },
        { type: "text", text: " and emphasis", marks: ["italic"] },
        { type: "text", text: "⚠️" },
      ],
    });
  });

  it("preserves headings, nested marks, literal shorthand, code identifiers, and final newlines", () => {
    const result = adfToBlocks(doc([
      {
        type: "heading",
        attrs: { level: 2, localId: "heading-1" },
        content: [{ type: "text", text: "Heading" }],
      },
      {
        type: "paragraph",
        attrs: { localId: "" },
        content: [
          { type: "text", text: ":warning: CONFIG_TOKEN_A `literal` ", marks: [
            { type: "em" },
            { type: "code" },
            { type: "strong" },
          ] },
          { type: "text", text: "colored", marks: [
            { type: "backgroundColor", attrs: { color: "#abc" } },
            { type: "textColor", attrs: { color: "#123456" } },
            { type: "subsup", attrs: { type: "sup" } },
          ] },
        ],
      },
      {
        type: "codeBlock",
        attrs: {
          language: "",
          wrap: false,
          hideLineNumbers: false,
          localId: "",
          uniqueId: "code-unique",
        },
        content: [{ type: "text", text: "line 1\nline 2\n" }],
      },
    ]));

    expect(result.representation).toBe("atlas_doc_format");
    expect(result.degraded).toBeUndefined();
    expect(result.blocks).toEqual([
      {
        type: "heading",
        level: 2,
        localId: "heading-1",
        content: [{ type: "text", text: "Heading" }],
      },
      { type: "paragraph", localId: "", content: [
        { type: "text", text: ":warning: CONFIG_TOKEN_A `literal` ", marks: ["bold", "code", "italic"] },
        { type: "text", text: "colored", marks: ["superscript"], color: "#123456", backgroundColor: "#AABBCC" },
      ] },
      {
        type: "codeBlock",
        language: "",
        code: "line 1\nline 2\n",
        wrap: false,
        hideLineNumbers: false,
        localId: "",
        uniqueId: "code-unique",
      },
    ]);
    expect(result.notes).toEqual([]);
  });

  it("materializes the official ADF line-number default without inventing a wrap preference", () => {
    const result = adfToBlocks(doc([{
      type: "codeBlock",
      content: [{ type: "text", text: "const value = 1;" }],
    }]));

    expect(result.blocks).toEqual([{
      type: "codeBlock",
      code: "const value = 1;",
      hideLineNumbers: false,
    }]);
  });

  it("maps mixed lists, authored starts, and task state without degradation", () => {
    const result = adfToBlocks(doc([
      {
        type: "orderedList",
        attrs: { order: 3 },
        content: [{
          type: "listItem",
          attrs: { localId: "ordinary-item-1" },
          content: [
            { type: "paragraph", content: [{ type: "text", text: "first" }] },
            { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "nested" }] }] }] },
          ],
        }],
      },
      {
        type: "taskList",
        attrs: { localId: "tasks-root" },
        content: [
          { type: "taskItem", attrs: { localId: "task-open", state: "TODO" }, content: [{ type: "text", text: "open" }] },
          {
            type: "blockTaskItem",
            attrs: { localId: "task-done", state: "DONE" },
            content: [{ type: "paragraph", content: [{ type: "text", text: "done" }] }],
          },
          {
            type: "taskList",
            attrs: { localId: "tasks-nested" },
            content: [{
              type: "taskItem",
              attrs: { localId: "task-nested", state: "TODO" },
              content: [{ type: "text", text: "nested task" }],
            }],
          },
        ],
      },
      {
        type: "decisionList",
        attrs: { localId: "decisions-root" },
        content: [{
          type: "decisionItem",
          attrs: { localId: "decision-1", state: "DECIDED" },
          content: [{ type: "text", text: "ship it" }],
        }],
      },
    ]));

    expect(result.blocks[0]).toMatchObject({
      type: "list",
      ordered: true,
      start: 3,
      items: [{ localId: "ordinary-item-1", content: [
        { type: "paragraph", content: [{ type: "text", text: "first" }] },
        { type: "list", ordered: false },
      ] }],
    });
    expect(result.blocks[1]).toEqual({
      type: "list",
      ordered: false,
      listKind: "task",
      localId: "tasks-root",
      items: [
        {
          kind: "task",
          state: "TODO",
          localId: "task-open",
          checked: false,
          content: [{ type: "paragraph", content: [{ type: "text", text: "open" }] }],
        },
        {
          kind: "task",
          state: "DONE",
          localId: "task-done",
          block: true,
          checked: true,
          content: [
            { type: "paragraph", content: [{ type: "text", text: "done" }] },
            {
              type: "list",
              ordered: false,
              listKind: "task",
              localId: "tasks-nested",
              items: [{
                kind: "task",
                state: "TODO",
                localId: "task-nested",
                checked: false,
                content: [{ type: "paragraph", content: [{ type: "text", text: "nested task" }] }],
              }],
            },
          ],
        },
      ],
    });
    expect(result.blocks[2]).toEqual({
      type: "list",
      ordered: false,
      listKind: "decision",
      localId: "decisions-root",
      items: [{
        kind: "decision",
        state: "DECIDED",
        localId: "decision-1",
        content: [{ type: "paragraph", content: [{ type: "text", text: "ship it" }] }],
      }],
    });
    expect(result.notes.map((note) => note.code)).not.toContain("adf-node-degraded");
  });

  it("retains expand boundaries, identities, titles, and nested disclosure context", () => {
    const result = adfToBlocks(doc([{
      type: "expand",
      attrs: { title: "", localId: "expand-root" },
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Outer body" }] },
        {
          type: "nestedExpand",
          attrs: { title: "Nested details", localId: "" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Nested body" }] }],
        },
      ],
    }]), { pageContext: { id: "page-1", version: 4 } });

    expect(result.blocks).toEqual([{
      type: "expand",
      nested: false,
      title: "",
      localId: "expand-root",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Outer body" }] },
        {
          type: "expand",
          nested: true,
          title: "Nested details",
          localId: "",
          content: [{
            type: "paragraph",
            content: [{ type: "text", text: "Nested body" }],
          }],
        },
      ],
    }]);
    expect(result.notes).toEqual([
      expect.objectContaining({
        level: "info",
        code: "expand-static",
        source: expect.objectContaining({
          pageId: "page-1",
          blockPath: "blocks[0]",
        }),
      }),
      expect.objectContaining({
        level: "info",
        code: "expand-static",
        source: expect.objectContaining({
          pageId: "page-1",
          blockPath: "blocks[0].content[1]",
        }),
      }),
    ]);
  });

  it("preserves a zero start and bounds starts above the portable target maximum", () => {
    const result = adfToBlocks(doc([
      { type: "orderedList", attrs: { order: 0 }, content: [] },
      { type: "orderedList", attrs: { order: 2_147_483_648 }, content: [] },
    ]));
    expect(result.blocks).toEqual([
      { type: "list", ordered: true, start: 0, items: [] },
      { type: "list", ordered: true, start: 2_147_483_647, items: [] },
    ]);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toMatchObject({ code: "adf-node-degraded" });
  });

  it("maps every authored heading level H1 through H6", () => {
    const result = adfToBlocks(doc(Array.from({ length: 6 }, (_, index) => ({
      type: "heading",
      attrs: { level: index + 1 },
      content: [{ type: "text", text: `H${index + 1}` }],
    }))));
    expect(result.blocks.map((block) => block.type === "heading" ? block.level : 0)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("preserves logical alignment and bounded indentation on paragraphs and headings", () => {
    const result = adfToBlocks(doc([
      {
        type: "paragraph",
        marks: [
          { type: "alignment", attrs: { align: "center" } },
          { type: "indentation", attrs: { level: 2 } },
          { type: "fontSize", attrs: { fontSize: "small" } },
        ],
        content: [{ type: "text", text: "Centered and indented" }],
      },
      {
        type: "heading",
        attrs: { level: 2 },
        marks: [
          { type: "alignment", attrs: { align: "end" } },
          { type: "indentation", attrs: { level: 6 } },
        ],
        content: [{ type: "text", text: "Logical end" }],
      },
    ]));

    expect(result.blocks).toEqual([
      {
        type: "paragraph",
        content: [{ type: "text", text: "Centered and indented" }],
        presentation: { alignment: "center", indentation: 2, fontSize: "small" },
      },
      {
        type: "heading",
        level: 2,
        content: [{ type: "text", text: "Logical end" }],
        presentation: { alignment: "end", indentation: 6 },
      },
    ]);
    expect(result.notes).toEqual([]);
  });

  it("preserves success and error panel semantics while custom panels use the generic fallback", () => {
    const result = adfToBlocks(doc([
      {
        type: "panel",
        attrs: { panelType: "success" },
        content: [{ type: "paragraph", content: [{ type: "text", text: "Passed" }] }],
      },
      {
        type: "panel",
        attrs: { panelType: "error" },
        content: [{ type: "paragraph", content: [{ type: "text", text: "Failed" }] }],
      },
      {
        type: "panel",
        attrs: { panelType: "custom", panelColor: "#123456", panelIconText: "★" },
        content: [{ type: "paragraph", content: [{ type: "text", text: "Custom" }] }],
      },
    ]));

    expect(result.blocks).toEqual([
      {
        type: "callout",
        kind: "success",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Passed" }] }],
      },
      {
        type: "callout",
        kind: "error",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Failed" }] }],
      },
      {
        type: "callout",
        kind: "panel",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Custom" }] }],
      },
    ]);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toMatchObject({
      code: "adf-node-degraded",
      source: { blockPath: "blocks[2]" },
    });
  });

  it("preserves complete pinned table presentation, cell geometry, and identities", () => {
    const result = adfToBlocks(doc([{
      type: "table",
      attrs: {
        layout: "align-end",
        width: 480,
        displayMode: "fixed",
        isNumberColumnEnabled: true,
        localId: "table-local",
      },
      content: [{
        type: "tableRow",
        attrs: { localId: "" },
        content: [
          {
            type: "tableHeader",
            attrs: {
              colspan: 2,
              rowspan: 1,
              background: "#abc",
              colwidth: [200, 0],
              valign: "middle",
              localId: "",
            },
            content: [{ type: "paragraph", content: [{ type: "text", text: "Header" }] }],
          },
          {
            type: "tableCell",
            attrs: { colspan: 1, rowspan: 2, colwidth: [400], valign: "bottom", localId: "cell-local" },
            content: [{ type: "paragraph", content: [{ type: "text", text: "Cell" }] }],
          },
        ],
      }],
    }]));

    expect(result.blocks).toEqual([{
      type: "table",
      presentation: {
        layout: "align-end",
        width: 480,
        displayMode: "fixed",
        numberedColumn: true,
        localId: "table-local",
      },
      rows: [{ cells: [
        {
          header: true,
          colspan: 2,
          rowspan: 1,
          backgroundColor: "#AABBCC",
          columnWidths: [200, 0],
          verticalAlignment: "middle",
          localId: "",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Header" }] }],
        },
        {
          header: false,
          colspan: 1,
          rowspan: 2,
          columnWidths: [400],
          verticalAlignment: "bottom",
          localId: "cell-local",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Cell" }] }],
        },
      ], localId: "" }],
    }]);
    expect(result.notes.filter((note) => note.code === "adf-node-degraded")).toHaveLength(0);

    const emptyVector = adfToBlocks(doc([{
      type: "table",
      content: [{
        type: "tableRow",
        content: [{
          type: "tableCell",
          attrs: { colwidth: [] },
          content: [{ type: "paragraph", content: [] }],
        }],
      }],
    }]));
    expect((emptyVector.blocks[0] as Extract<ExportBlock, { type: "table" }>)
      .rows[0].cells[0].columnWidths).toEqual([]);

    const nonPositiveWidth = adfToBlocks(doc([{
      type: "table",
      attrs: { width: 0 },
      content: [],
    }]));
    expect(nonPositiveWidth.blocks[0]).toMatchObject({
      type: "table",
      presentation: { width: 0 },
    });
    expect(nonPositiveWidth.notes).toContainEqual(expect.objectContaining({
      code: "adf-node-degraded",
      message: expect.stringContaining("non-positive width"),
      source: expect.objectContaining({ blockPath: "blocks[0]" }),
    }));
  });

  it("preserves multi-column layout geometry, identity, vertical alignment, and breakout intent", () => {
    const result = adfToBlocks(doc([{
      type: "layoutSection",
      attrs: { localId: "" },
      marks: [{ type: "breakout", attrs: { mode: "wide", width: 960 } }],
      content: [
        {
          type: "layoutColumn",
          attrs: { width: 30, valign: "middle", localId: "" },
          content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Left" }] }],
        },
        {
          type: "layoutColumn",
          attrs: { width: 70, valign: "bottom", localId: "right-column" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Right" }] }],
        },
      ],
    }]));

    expect(result.blocks).toEqual([{
      type: "layout",
      localId: "",
      breakout: { mode: "wide", width: 960 },
      columns: [
        {
          width: 30,
          verticalAlignment: "middle",
          localId: "",
          content: [{ type: "heading", level: 2, content: [{ type: "text", text: "Left" }] }],
        },
        {
          width: 70,
          verticalAlignment: "bottom",
          localId: "right-column",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Right" }] }],
        },
      ],
    }]);
    expect(result.notes).toContainEqual(expect.objectContaining({
      code: "adf-mark-degraded",
      message: expect.stringContaining("retains wide intent"),
      source: expect.objectContaining({ blockPath: "blocks[0]" }),
    }));
    expect(result.notes.map((note) => note.message)).not.toContain(
      expect.stringContaining("layout was flattened"),
    );
  });

  it("classifies safe external, anchor, page, attachment, and unsafe links centrally", () => {
    const marked = (text: string, href: string) => ({ type: "text", text, marks: [{ type: "link", attrs: { href } }] });
    const result = adfToBlocks(doc([{
      type: "paragraph",
      content: [
        marked("external", "https://example.invalid/path"),
        marked("anchor", "#Section%201"),
        marked("page", "/wiki/spaces/TEST/pages/12345/Page+Title"),
        marked("attachment", "/wiki/download/attachments/12345/file%20name.pdf"),
        marked("unsafe", "java\tscript:alert(1)"),
      ],
    }]));

    expect((result.blocks[0] as { content: unknown[] }).content).toEqual([
      { type: "link", target: { kind: "external", href: "https://example.invalid/path" }, content: [{ type: "text", text: "external" }] },
      { type: "link", target: { kind: "anchor", anchor: "Section 1" }, content: [{ type: "text", text: "anchor" }] },
      { type: "link", target: { kind: "page", contentId: "12345", contentTitle: "Page Title" }, content: [{ type: "text", text: "page" }] },
      { type: "link", target: { kind: "attachment", filename: "file name.pdf" }, content: [{ type: "text", text: "attachment" }] },
      { type: "text", text: "unsafe" },
    ]);
    expect(result.notes.map((note) => note.code)).toContain("unsafe-link-skipped");
  });

  it("maps emoji, dates, mentions, status, and cards without interpreting literal colon text", () => {
    const result = adfToBlocks(doc([
      {
        type: "paragraph",
        content: [
          { type: "text", text: ":warning:" },
          { type: "emoji", attrs: { shortName: ":warning:", text: "⚠️" } },
          { type: "emoji", attrs: { id: "custom", shortName: ":custom:" } },
          { type: "emoji", attrs: { id: "atlassian-empty", shortName: ":empty:", text: "" } },
          { type: "date", attrs: { timestamp: "1704067200000" } },
          { type: "mention", attrs: { id: "user-1", text: "@Ada" } },
          { type: "mention", attrs: { id: "team-1", userType: "TEAM" } },
          {
            type: "status",
            attrs: { text: "Ready", color: "green", localId: "", style: "mixedCase" },
          },
          { type: "placeholder", attrs: { text: "editor-only", localId: "" } },
          { type: "inlineCard", attrs: { url: "https://example.invalid/card" } },
          { type: "inlineCard", attrs: { data: { url: "https://example.invalid/data-card", name: "Visible card title" } } },
        ],
      },
      { type: "blockCard", attrs: { url: "https://example.invalid/block" } },
    ]));

    expect(result.blocks[0]).toMatchObject({ type: "paragraph", content: [
      { type: "text", text: ":warning:" },
      {
        type: "text",
        text: "⚠️",
        emoji: {
          shortName: ":warning:",
          text: "⚠️",
          renderedFrom: "text",
        },
      },
      {
        type: "text",
        text: ":custom:",
        emoji: {
          shortName: ":custom:",
          id: "custom",
          renderedFrom: "short-name",
        },
      },
      {
        type: "text",
        text: ":empty:",
        emoji: {
          shortName: ":empty:",
          id: "atlassian-empty",
          text: "",
          renderedFrom: "short-name",
        },
      },
      { type: "date", timestamp: "1704067200000" },
      { type: "mention", accountId: "user-1", displayName: "Ada" },
      { type: "mention", accountId: "team-1" },
      { type: "status", text: "Ready", color: "green", localId: "", style: "mixedCase" },
      { type: "placeholder", text: "editor-only", localId: "" },
      { type: "link", target: { kind: "external", href: "https://example.invalid/card" } },
      {
        type: "link",
        target: { kind: "external", href: "https://example.invalid/data-card" },
        content: [{ type: "text", text: "Visible card title" }],
      },
    ] });
    expect(result.blocks[1]).toMatchObject({ type: "paragraph", content: [{ type: "link" }] });
    expect(result.notes.filter((note) => note.code === "emoji-text-fallback")).toHaveLength(2);
    expect(result.notes.every((note) => note.source?.blockPath)).toBe(true);
  });

  it("routes extensions through the neutral macro contract and keeps media visible until correlation exists", () => {
    const result = adfToBlocks(doc([
      {
        type: "bodiedExtension",
        attrs: {
          extensionType: "com.atlassian.confluence.macro.core",
          extensionKey: "synthetic-macro",
          localId: "not-a-storage-macro-id",
          parameters: { zeta: 2, alpha: "one" },
        },
        content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: "user-2" } }] }],
      },
      {
        type: "mediaSingle",
        content: [
          { type: "media", attrs: { type: "file", id: "media-1", collection: "contentId-1", alt: "diagram.png" } },
          { type: "caption", attrs: { localId: "" }, content: [{ type: "text", text: "Caption" }] },
        ],
      },
    ]), { pageContext: { id: "page-1", version: 7, spaceKey: "TEST" } });

    expect(result.blocks[0]).toEqual({
      type: "unknown",
      macroName: "synthetic-macro",
      adfExtension: {
        extensionType: "com.atlassian.confluence.macro.core",
        extensionKey: "synthetic-macro",
        localId: "not-a-storage-macro-id",
      },
      params: [{ name: "alpha", text: "one" }, { name: "zeta", text: "2" }],
      body: [{ type: "paragraph", content: [{ type: "mention", accountId: "user-2" }] }],
      sourcePage: { id: "page-1", version: 7, spaceKey: "TEST" },
    });
    expect(result.blocks[0]).not.toHaveProperty("macroId");
    expect(result.blocks.slice(1)).toEqual([{
      type: "mediaFallback",
      label: "diagram.png",
      media: { mediaType: "file", id: "media-1", collection: "contentId-1" },
      alt: "diagram.png",
      caption: {
        kind: "figure",
        content: [{ type: "text", text: "Caption" }],
        localId: "",
      },
    }]);
    expect(result.notes.map((note) => note.code)).toContain("adf-media-unresolved");
    expect(result.notes.every((note) => note.source?.pageId === "page-1")).toBe(true);
  });

  it("retains invalid semantic date source text with a typed warning", () => {
    const result = adfToBlocks(doc([{
      type: "paragraph",
      content: [{ type: "date", attrs: { timestamp: "not-a-timestamp", localId: "date-1" } }],
    }]), { pageContext: { id: "page-1" } });

    expect(result.blocks).toEqual([{
      type: "paragraph",
      content: [{ type: "date", timestamp: "not-a-timestamp", localId: "date-1" }],
    }]);
    expect(result.notes).toEqual([expect.objectContaining({
      level: "warning",
      code: "date-invalid",
      source: expect.objectContaining({ pageId: "page-1", blockPath: "blocks[0].content[0]" }),
    })]);
    expect(result.degraded).toBe(true);
  });

  it("maps only explicitly correlated media IDs to attachment images", () => {
    const seen: unknown[] = [];
    const result = adfToBlocks(doc([{
      type: "mediaSingle",
      content: [
        { type: "media", attrs: {
          type: "file",
          id: "media-1",
          collection: "collection-1",
          occurrenceKey: "occurrence-1",
          alt: "Architecture",
          width: 640,
          height: 480,
        } },
        { type: "caption", attrs: { localId: "caption-1" }, content: [{ type: "text", text: "Figure caption" }] },
      ],
    }]), {
      pageContext: { id: "page-2" },
      resolveMediaAttachment: (reference) => {
        seen.push(reference);
        return { filename: "architecture.png" };
      },
    });

    expect(seen).toEqual([{ id: "media-1", collection: "collection-1", occurrenceKey: "occurrence-1" }]);
    expect(result.blocks).toEqual([{
      type: "image",
      source: { kind: "attachment", filename: "architecture.png", pageId: "page-2" },
      alt: "Architecture",
      width: 640,
      height: 480,
      caption: {
        kind: "figure",
        content: [{ type: "text", text: "Figure caption" }],
        localId: "caption-1",
      },
    }]);
    expect(result.notes).toEqual([]);
  });

  it("preserves annotation and fragment identities without inventing target semantics", () => {
    const annotation = (id: string) => ({
      type: "annotation",
      attrs: { id, annotationType: "inlineComment" },
    });
    const fragment = (localId: string, name?: string) => ({
      type: "fragment",
      attrs: { localId, ...(name !== undefined ? { name } : {}) },
    });
    const result = adfToBlocks(doc([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "commented", marks: [annotation("")] },
          {
            type: "inlineExtension",
            attrs: { extensionType: "x", extensionKey: "inline", text: "fragmented" },
            marks: [fragment("inline-fragment", "")],
          },
        ],
      },
      {
        type: "extension",
        attrs: { extensionType: "x", extensionKey: "block" },
        marks: [fragment("block-fragment", "named")],
      },
      {
        type: "table",
        marks: [fragment("table-fragment")],
        content: [{
          type: "tableRow",
          content: [{
            type: "tableCell",
            attrs: { colspan: 1, rowspan: 1 },
            content: [{ type: "paragraph", content: [{ type: "text", text: "cell" }] }],
          }],
        }],
      },
      {
        type: "media",
        attrs: { type: "file", id: "resolved-media", alt: "resolved" },
        marks: [annotation("media-comment")],
      },
      {
        type: "media",
        attrs: { type: "file", id: "unresolved-media", alt: "unresolved" },
        marks: [annotation("fallback-comment")],
      },
    ]), {
      resolveMediaAttachment: (reference) =>
        reference.id === "resolved-media" ? { filename: "resolved.png" } : undefined,
    });

    expect(result.blocks).toEqual([
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "commented",
            annotations: [{ id: "", annotationType: "inlineComment" }],
          },
          {
            type: "text",
            text: "fragmented",
            adfExtension: { extensionType: "x", extensionKey: "inline" },
            fragments: [{ localId: "inline-fragment", name: "" }],
          },
        ],
      },
      {
        type: "unknown",
        macroName: "block",
        adfExtension: { extensionType: "x", extensionKey: "block" },
        fragments: [{ localId: "block-fragment", name: "named" }],
      },
      {
        type: "table",
        rows: [{
          cells: [{
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: "cell" }] }],
          }],
        }],
        fragments: [{ localId: "table-fragment" }],
      },
      {
        type: "image",
        source: { kind: "attachment", filename: "resolved.png" },
        alt: "resolved",
        annotations: [{ id: "media-comment", annotationType: "inlineComment" }],
      },
      {
        type: "mediaFallback",
        label: "unresolved",
        media: { mediaType: "file", id: "unresolved-media" },
        alt: "unresolved",
        annotations: [{ id: "fallback-comment", annotationType: "inlineComment" }],
      },
    ]);
    expect(result.notes.filter((note) => note.code === "adf-mark-degraded")).toEqual([]);
    expect(result.notes.map((note) => note.code)).toEqual([
      "adf-node-degraded",
      "adf-node-degraded",
      "adf-media-unresolved",
    ]);
  });

  it("builds an exact fileId resolver without guessing from filename or content id", () => {
    const resolve = createAdfMediaAttachmentResolver([
      { fileId: "media-file-id", filename: "diagram.png", pageId: "page-2" },
      { fileId: "", filename: "ignored.png", pageId: "page-2" },
    ]);
    expect(resolve?.({ id: "media-file-id" })).toEqual({ filename: "diagram.png", pageId: "page-2" });
    expect(resolve?.({ id: "diagram.png" })).toBeUndefined();
    expect(resolve?.({ id: "content-id" })).toBeUndefined();
  });

  it("keeps block, bodied, and inline extensions visible without claiming a Storage macro id", () => {
    const result = adfToBlocks(doc([
      { type: "extension", attrs: { extensionType: "x", extensionKey: "block-extension", parameters: {} } },
      {
        type: "paragraph",
        content: [{
          type: "inlineExtension",
          attrs: {
            extensionType: "x",
            extensionKey: "inline-extension",
            localId: "inline-local",
            text: "Inline extension",
            parameters: { mode: "compact" },
          },
        }],
      },
    ]), { pageContext: { id: "page-1", version: 3, spaceKey: "S" } });
    expect(result.blocks[0]).toEqual({
      type: "unknown",
      macroName: "block-extension",
      adfExtension: { extensionType: "x", extensionKey: "block-extension" },
      sourcePage: { id: "page-1", version: 3, spaceKey: "S" },
    });
    expect(result.blocks[0]).not.toHaveProperty("macroId");
    expect(result.blocks[1]).toEqual({
      type: "paragraph",
      content: [{
        type: "text",
        text: "Inline extension",
        adfExtension: {
          extensionType: "x",
          extensionKey: "inline-extension",
          localId: "inline-local",
        },
        extensionParams: [{ name: "mode", text: "compact" }],
        sourcePage: { id: "page-1", version: 3, spaceKey: "S" },
      }],
    });
    expect(result.notes.map((note) => note.code)).toEqual(["adf-node-degraded", "adf-node-degraded"]);
  });

  it("keeps unresolved extension-body diagnostics on the block until fallback rendering", () => {
    const result = adfToBlocks(doc([{
      type: "bodiedExtension",
      attrs: { extensionType: "x", extensionKey: "body-notes" },
      content: [{ type: "media", attrs: { type: "file", id: "unresolved" } }],
    }]));
    expect(result.notes.map((note) => note.code)).toEqual(["adf-node-degraded"]);
    expect(result.blocks[0]).toMatchObject({
      type: "unknown",
      macroName: "body-notes",
      bodyNotes: [{ code: "adf-media-unresolved" }],
    });
  });

  it("preserves Storage export-control semantics for recognized ADF extensions", () => {
    const control = (extensionKey: string, text: string) => ({
      type: "bodiedExtension",
      attrs: {
        extensionType: "com.atlassian.confluence.macro.core",
        extensionKey,
        parameters: { macroParams: { exporter: { value: "word" } } },
      },
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    });
    const source = doc([
      control("scroll-only", "word only"),
      control("scroll-ignore", "ignored by word"),
      { type: "paragraph", content: [{
        type: "inlineExtension",
        attrs: {
          extensionType: "com.atlassian.confluence.macro.core",
          extensionKey: "scroll-only-inline",
          text: "inline word",
          parameters: { macroParams: { exporter: { value: "word" } } },
        },
      }] },
    ]);

    const pdf = adfToBlocks(source, { exporter: "pdf" });
    expect(pdf.blocks).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "ignored by word" }] },
    ]);
    expect(pdf.notes.map((note) => note.code)).toEqual([
      "scroll-only-skipped-other-exporter",
      "scroll-ignore-skipped-other-exporter",
      "scroll-only-skipped-other-exporter",
    ]);

    const word = adfToBlocks(source, { exporter: "word" });
    expect(word.blocks).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "word only" }] },
      { type: "paragraph", content: [{ type: "text", text: "inline word" }] },
    ]);
    expect(word.notes.map((note) => note.code)).toEqual([
      "scroll-only-applied",
      "scroll-ignore-applied",
      "scroll-only-applied",
    ]);

    const passthrough = adfToBlocks(source, { exporter: "word", exportControls: "passthrough" });
    expect(passthrough.blocks).toHaveLength(3);
    expect(passthrough.notes.map((note) => note.code)).toEqual([
      "export-controls-passthrough",
      "export-controls-passthrough",
      "export-controls-passthrough",
    ]);
  });

  it("retains inline export-control fragments and reports the block-wrapper residual", () => {
    const fragment = () => ({
      type: "fragment",
      attrs: { localId: "control-fragment", name: "controlled" },
    });
    const result = adfToBlocks(doc([
      {
        type: "bodiedExtension",
        attrs: {
          extensionType: "x",
          extensionKey: "scroll-only",
          parameters: { exporter: "word" },
        },
        marks: [fragment()],
        content: [{ type: "paragraph", content: [{ type: "text", text: "block" }] }],
      },
      {
        type: "paragraph",
        content: [{
          type: "inlineExtension",
          attrs: {
            extensionType: "x",
            extensionKey: "scroll-only-inline",
            parameters: { exporter: "word" },
            text: "inline",
          },
          marks: [fragment()],
        }],
      },
    ]), { exporter: "word" });

    expect(result.blocks).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "block" }] },
      {
        type: "paragraph",
        content: [{
          type: "text",
          text: "inline",
          fragments: [{ localId: "control-fragment", name: "controlled" }],
        }],
      },
    ]);
    expect(result.notes.map((note) => note.code)).toEqual([
      "scroll-only-applied",
      "adf-mark-degraded",
      "scroll-only-applied",
    ]);
  });

  it("preserves unknown content, reports unknown marks and attributes, and caps diagnostics", () => {
    const result = adfToBlocks(doc([
      {
        type: "futureBlock",
        attrs: { future: true },
        content: [{
          type: "paragraph",
          attrs: { futureParagraphAttribute: "x" },
          content: [
            { type: "text", text: "Visible", marks: [{ type: "futureMark", attrs: { mode: "x" } }] },
            { type: "futureInline", content: [{ type: "text", text: " inline" }] },
          ],
        }],
      },
      { type: "futureEmpty" },
    ]), { parseBudget: { maxDiagnostics: 3 } });

    expect(result.blocks).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "Visible" }, { type: "text", text: " inline" }] },
      { type: "paragraph", content: [{ type: "text", text: "[Unsupported Confluence futureEmpty]" }] },
    ]);
    expect(result.degraded).toBe(true);
    expect(result.notes).toHaveLength(3);
    expect(result.notes[2]?.message).toContain("suppressed");
  });

  it("keeps deterministic output independent of object-key and mark-array order", () => {
    const one = doc([{
      type: "paragraph",
      content: [{ type: "text", text: "same", marks: [
        { type: "strong" },
        { type: "link", attrs: { title: "title", href: "https://example.invalid" } },
        { type: "em" },
      ] }],
    }]);
    const two = doc([{
      content: [{ marks: [
        { attrs: { href: "https://example.invalid", title: "title" }, type: "link" },
        { type: "em" },
        { type: "strong" },
      ], text: "same", type: "text" }],
      type: "paragraph",
    }]);
    expect(adfToBlocks(one)).toEqual(adfToBlocks(two));
  });

  it("classifies every pinned node and mark exactly once", () => {
    expect(Object.keys(ADF_NODE_DECODE_MODES).sort()).toEqual([...PINNED_ADF_NODE_TYPES].sort());
    expect(Object.keys(ADF_MARK_DECODE_MODES).sort()).toEqual([...PINNED_ADF_MARK_TYPES].sort());
    expect(Object.values(ADF_NODE_DECODE_MODES).every((mode) => ["native", "approximation", "visible-fallback"].includes(mode))).toBe(true);
    expect(Object.values(ADF_MARK_DECODE_MODES).every((mode) => ["native", "approximation", "visible-fallback"].includes(mode))).toBe(true);
  });

  it("records degradation even when the note budget is zero", () => {
    const result = adfToBlocks(doc([{
      type: "futureNode",
      content: [{ type: "paragraph", content: [{ type: "text", text: "visible" }] }],
    }]), {
      parseBudget: { maxDiagnostics: 0 },
    });
    expect(result.blocks).toEqual([{ type: "paragraph", content: [{ type: "text", text: "visible" }] }]);
    expect(result.notes).toEqual([]);
    expect(result.degraded).toBe(true);
  });
});
