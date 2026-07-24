import { describe, expect, it } from "bun:test";
import {
  adfToBlocks,
  createAdfAnnotationResolver,
  createAdfMediaAttachmentResolver,
} from "./adf-to-blocks.js";
import {
  ADF_MARK_DECODE_MODES,
  ADF_NODE_DECODE_MODES,
  ADF_STAGE0_NODE_DECODE_MODES,
  PINNED_ADF_MARK_TYPES,
  PINNED_ADF_NODE_TYPES,
  PINNED_ADF_STAGE0_NODE_TYPES,
} from "./adf-coverage.js";
import { JIRA_DATASOURCE_ID } from "./datasource.js";
import type { ExportBlock } from "./export-blocks.js";
import {
  CONFLUENCE_LEGACY_EMOJI_ALIASES,
  CONFLUENCE_LEGACY_EMOJI_PROJECTIONS,
} from "./emoji-projection.js";

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

  it("retains root code and expand breakout intent with page-bounded reporting", () => {
    const result = adfToBlocks(doc([
      {
        type: "codeBlock",
        marks: [{ type: "breakout", attrs: { mode: "wide", width: 880 } }],
        content: [{ type: "text", text: "const wide = true;" }],
      },
      {
        type: "expand",
        marks: [{ type: "breakout", attrs: { mode: "full-width", width: 1024 } }],
        content: [{ type: "paragraph", content: [{ type: "text", text: "Wide details" }] }],
      },
    ]));

    expect(result.blocks).toEqual([
      {
        type: "codeBlock",
        code: "const wide = true;",
        hideLineNumbers: false,
        breakout: { mode: "wide", width: 880 },
      },
      {
        type: "expand",
        nested: false,
        breakout: { mode: "full-width", width: 1024 },
        content: [{
          type: "paragraph",
          content: [{ type: "text", text: "Wide details" }],
        }],
      },
    ]);
    expect(result.notes.filter((note) => note.code === "adf-mark-degraded")).toHaveLength(2);
    expect(result.notes.filter((note) => note.code === "expand-static")).toHaveLength(1);
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

  it("preserves standard and complete custom-panel semantics", () => {
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
        attrs: {
          panelType: "custom",
          localId: "",
          panelColor: "#123456",
          panelIcon: ":star:",
          panelIconId: "icon-id",
          panelIconText: "★",
        },
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
        localId: "",
        panelColor: "#123456",
        panelIcon: ":star:",
        panelIconId: "icon-id",
        panelIconText: "★",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Custom" }] }],
      },
    ]);
    expect(result.notes).toEqual([]);
  });

  it("retains custom-panel values and reports only unportable color or ID-only icon fallbacks", () => {
    const result = adfToBlocks(doc([{
      type: "panel",
      attrs: {
        panelType: "custom",
        panelColor: "not-a-portable-color",
        panelIconId: "icon-id",
      },
      content: [{ type: "paragraph", content: [{ type: "text", text: "Custom" }] }],
    }]));

    expect(result.blocks[0]).toMatchObject({
      type: "callout",
      kind: "panel",
      panelColor: "not-a-portable-color",
      panelIconId: "icon-id",
    });
    expect(result.notes).toHaveLength(2);
    expect(result.notes.every((note) => note.code === "adf-node-degraded")).toBe(true);
    expect(result.notes.every((note) => note.source?.blockPath === "blocks[0]")).toBe(true);
  });

  it("normalizes portable short custom-panel colors for every renderer", () => {
    const result = adfToBlocks(doc([{
      type: "panel",
      attrs: {
        panelType: "custom",
        panelColor: "#abc",
      },
      content: [{ type: "paragraph", content: [{ type: "text", text: "Custom" }] }],
    }]));

    expect(result.blocks[0]).toMatchObject({
      type: "callout",
      kind: "panel",
      panelColor: "#AABBCC",
    });
    expect(result.notes).toEqual([]);
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
    const marked = (
      text: string,
      href: string,
      attrs: Record<string, string> = {},
    ) => ({ type: "text", text, marks: [{ type: "link", attrs: { href, ...attrs } }] });
    const result = adfToBlocks(doc([{
      type: "paragraph",
      content: [
        marked("external", "https://example.invalid/path", {
          title: "",
          id: "media-id",
          collection: "contentId-1",
          occurrenceKey: "occurrence-1",
        }),
        marked("anchor", "#Section%201"),
        marked("page", "/wiki/spaces/TEST/pages/12345/Page+Title#Section%202"),
        marked("attachment", "/wiki/download/attachments/12345/file%20name.pdf"),
        marked("unsafe", "java\tscript:alert(1)"),
      ],
    }]));

    expect((result.blocks[0] as { content: unknown[] }).content).toEqual([
      {
        type: "link",
        target: { kind: "external", href: "https://example.invalid/path" },
        content: [{ type: "text", text: "external" }],
        adfAttributes: {
          title: "",
          id: "media-id",
          collection: "contentId-1",
          occurrenceKey: "occurrence-1",
        },
      },
      { type: "link", target: { kind: "anchor", anchor: "Section 1" }, content: [{ type: "text", text: "anchor" }] },
      {
        type: "link",
        target: {
          kind: "page",
          contentId: "12345",
          contentTitle: "Page Title",
          anchor: "Section 2",
          href: "/wiki/spaces/TEST/pages/12345/Page+Title#Section%202",
        },
        content: [{ type: "text", text: "page" }],
      },
      {
        type: "link",
        target: {
          kind: "attachment",
          filename: "file name.pdf",
          href: "/wiki/download/attachments/12345/file%20name.pdf",
        },
        content: [{ type: "text", text: "attachment" }],
      },
      { type: "text", text: "unsafe" },
    ]);
    expect(result.notes.map((note) => note.code)).toContain("unsafe-link-skipped");
  });

  it("retains unsafe Smart Card source semantics without creating a clickable target", () => {
    const result = adfToBlocks(doc([{
      type: "paragraph",
      content: [{
        type: "inlineCard",
        attrs: {
          data: { url: "java\tscript:alert(1)", name: "Unsafe card", opaque: { retained: true } },
          localId: "unsafe-card",
        },
      }],
    }]));

    expect(result.blocks[0]).toEqual({
      type: "paragraph",
      content: [{
        type: "smartCard",
        card: {
          appearance: "inline",
          source: "data",
          url: "java\tscript:alert(1)",
          title: "Unsafe card",
          localId: "unsafe-card",
          data: {
            url: "java\tscript:alert(1)",
            name: "Unsafe card",
            opaque: { retained: true },
          },
        },
      }],
    });
    expect(result.notes.map((note) => note.code)).toContain("unsafe-link-skipped");
  });

  it("routes supported ADF datasource cards through the existing live macro chain", () => {
    const result = adfToBlocks(doc([{
      type: "blockCard",
      attrs: {
        datasource: {
          id: JIRA_DATASOURCE_ID,
          parameters: { cloudId: "cloud-1", jql: "project = EXAMPLE ORDER BY created DESC" },
          views: [{
            type: "table",
            properties: { columns: [{ key: "key" }, { key: "summary" }] },
          }],
        },
        url: "https://example.invalid/issues",
        layout: "wide",
        width: 75,
        localId: "jira-card",
      },
    }]), {
      pageContext: { id: "page-1", version: 2, spaceKey: "EXAMPLE" },
    });

    expect(result.blocks).toEqual([{
      type: "unknown",
      macroName: "jira",
      params: [
        { name: "jqlquery", text: "project = EXAMPLE ORDER BY created DESC" },
        { name: "columns", text: "key,summary" },
        { name: "maximumissues", text: "100" },
        { name: "datasourceid", text: JIRA_DATASOURCE_ID },
        { name: "datasourcecloudid", text: "cloud-1" },
        { name: "datasourceurl", text: "https://example.invalid/issues" },
      ],
      body: [{
        type: "smartCard",
        card: {
          appearance: "block",
          source: "datasource",
          url: "https://example.invalid/issues",
          target: { kind: "external", href: "https://example.invalid/issues" },
          localId: "jira-card",
          datasource: {
            id: JIRA_DATASOURCE_ID,
            parameters: {
              cloudId: "cloud-1",
              jql: "project = EXAMPLE ORDER BY created DESC",
            },
            views: [{
              type: "table",
              properties: { columns: [{ key: "key" }, { key: "summary" }] },
            }],
          },
          layout: "wide",
          width: 75,
        },
      }],
      sourcePage: { id: "page-1", version: 2, spaceKey: "EXAMPLE" },
    }]);
    expect(result.notes).toContainEqual(expect.objectContaining({
      code: "macro-not-rendered",
      macroName: "jira",
      source: expect.objectContaining({ pageId: "page-1", blockPath: "blocks[0]" }),
    }));
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
          {
            type: "mention",
            attrs: {
              id: "user-1",
              text: "@Ada",
              localId: "mention-local",
              accessLevel: "SITE",
              userType: "DEFAULT",
            },
          },
          {
            type: "mention",
            attrs: {
              id: "collection-1",
              text: "",
              localId: "",
              accessLevel: "",
              userType: "SPECIAL",
            },
          },
          {
            type: "status",
            attrs: { text: "Ready", color: "green", localId: "", style: "mixedCase" },
          },
          { type: "placeholder", attrs: { text: "editor-only", localId: "" } },
          { type: "inlineCard", attrs: { url: "https://example.invalid/card", localId: "" } },
          {
            type: "inlineCard",
            attrs: {
              data: {
                url: "https://example.invalid/data-card",
                name: "Visible card title",
                provider: { name: "Example" },
              },
              localId: "inline-data",
            },
          },
        ],
      },
      { type: "blockCard", attrs: { url: "https://example.invalid/block" } },
      {
        type: "blockCard",
        attrs: {
          datasource: {
            id: "provider-id",
            parameters: { query: "type = page" },
            views: [{ type: "table", properties: { columns: ["title"] } }],
          },
          url: "https://example.invalid/datasource",
          layout: "wide",
          width: 72,
          localId: "datasource-card",
        },
      },
      {
        type: "embedCard",
        attrs: {
          url: "https://example.invalid/embed",
          layout: "full-width",
          width: 80,
          originalHeight: 720,
          originalWidth: 1280,
          localId: "embed-card",
        },
      },
    ]));

    expect(result.blocks[0]).toMatchObject({ type: "paragraph", content: [
      { type: "text", text: ":warning:" },
      {
        type: "text",
        text: "⚠️",
        emoji: {
          shortName: ":warning:",
          text: "⚠️",
          renderedFrom: "source-text",
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
      {
        type: "mention",
        accountId: "user-1",
        sourceText: "@Ada",
        displayName: "Ada",
        localId: "mention-local",
        accessLevel: "SITE",
        userType: "DEFAULT",
      },
      {
        type: "mention",
        accountId: "collection-1",
        sourceText: "",
        localId: "",
        accessLevel: "",
        userType: "SPECIAL",
      },
      { type: "status", text: "Ready", color: "green", localId: "", style: "mixedCase" },
      { type: "placeholder", text: "editor-only", localId: "" },
      {
        type: "smartCard",
        card: {
          appearance: "inline",
          source: "url",
          url: "https://example.invalid/card",
          target: { kind: "external", href: "https://example.invalid/card" },
          localId: "",
        },
      },
      {
        type: "smartCard",
        card: {
          appearance: "inline",
          source: "data",
          url: "https://example.invalid/data-card",
          target: { kind: "external", href: "https://example.invalid/data-card" },
          title: "Visible card title",
          localId: "inline-data",
          data: {
            url: "https://example.invalid/data-card",
            name: "Visible card title",
            provider: { name: "Example" },
          },
        },
      },
    ] });
    expect(result.blocks.slice(1)).toEqual([
      {
        type: "smartCard",
        card: {
          appearance: "block",
          source: "url",
          url: "https://example.invalid/block",
          target: { kind: "external", href: "https://example.invalid/block" },
        },
      },
      {
        type: "smartCard",
        card: {
          appearance: "block",
          source: "datasource",
          url: "https://example.invalid/datasource",
          target: { kind: "external", href: "https://example.invalid/datasource" },
          localId: "datasource-card",
          datasource: {
            id: "provider-id",
            parameters: { query: "type = page" },
            views: [{ type: "table", properties: { columns: ["title"] } }],
          },
          layout: "wide",
          width: 72,
        },
      },
      {
        type: "smartCard",
        card: {
          appearance: "embed",
          source: "url",
          url: "https://example.invalid/embed",
          target: { kind: "external", href: "https://example.invalid/embed" },
          localId: "embed-card",
          layout: "full-width",
          width: 80,
          originalHeight: 720,
          originalWidth: 1280,
        },
      },
    ]);
    expect(result.notes.filter((note) => note.code === "emoji-text-fallback")).toHaveLength(2);
    expect(result.notes.filter((note) => note.code === "adf-node-degraded")).toHaveLength(0);
    expect(result.notes.every((note) => note.source?.blockPath)).toBe(true);
  });

  it("projects only typed ADF emoji and materializes every semantic state", () => {
    const warning = CONFLUENCE_LEGACY_EMOJI_PROJECTIONS.warning;
    const result = adfToBlocks(doc([{
      type: "paragraph",
      content: [
        { type: "emoji", attrs: { shortName: ":warning:" } },
        { type: "emoji", attrs: { shortName: ":warning:", text: "" } },
        { type: "emoji", attrs: { shortName: ":warning:", text: ":warning:" } },
        { type: "emoji", attrs: { shortName: ":warning:", text: ":smile:" } },
        { type: "emoji", attrs: { shortName: ":warn:" } },
        { type: "emoji", attrs: { shortName: ":custom:", text: "🦜" } },
      ],
    }]));

    expect(result.blocks[0]).toEqual({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: warning.text,
          emoji: {
            shortName: ":warning:",
            renderedFrom: "catalog-projection",
            projection: warning,
          },
        },
        {
          type: "text",
          text: warning.text,
          emoji: {
            shortName: ":warning:",
            text: "",
            renderedFrom: "catalog-projection",
            projection: warning,
          },
        },
        {
          type: "text",
          text: warning.text,
          emoji: {
            shortName: ":warning:",
            text: ":warning:",
            renderedFrom: "catalog-projection",
            projection: warning,
          },
        },
        {
          type: "text",
          text: warning.text,
          emoji: {
            shortName: ":warning:",
            text: ":smile:",
            renderedFrom: "catalog-projection",
            projection: warning,
          },
        },
        {
          type: "text",
          text: warning.text,
          emoji: {
            shortName: ":warn:",
            renderedFrom: "catalog-projection",
            projection: warning,
          },
        },
        {
          type: "text",
          text: "🦜",
          emoji: {
            shortName: ":custom:",
            text: "🦜",
            renderedFrom: "source-text",
          },
        },
      ],
    });
    expect(result.notes).toEqual([]);
  });

  it("projects all 22 canonical and 26 alias notations through the ADF adapter", () => {
    const canonicalCases = Object.values(CONFLUENCE_LEGACY_EMOJI_PROJECTIONS)
      .map((projection) => ({
        shortName: `:${projection.canonicalName}:`,
        projection,
      }));
    const aliasCases = Object.entries(CONFLUENCE_LEGACY_EMOJI_ALIASES)
      .map(([alias, canonicalName]) => ({
        shortName: `:${alias}:`,
        projection: CONFLUENCE_LEGACY_EMOJI_PROJECTIONS[canonicalName],
      }));
    const cases = [...canonicalCases, ...aliasCases];
    const result = adfToBlocks(doc([{
      type: "paragraph",
      content: [
        ...cases.map(({ shortName }) => ({
          type: "emoji",
          attrs: { shortName },
        })),
        { type: "text", text: ":+1:" },
      ],
    }]));

    expect(canonicalCases).toHaveLength(22);
    expect(aliasCases).toHaveLength(26);
    expect(result.blocks[0]).toEqual({
      type: "paragraph",
      content: [
        ...cases.map(({ shortName, projection }) => ({
          type: "text" as const,
          text: projection.text,
          emoji: {
            shortName,
            renderedFrom: "catalog-projection" as const,
            projection,
          },
        })),
        { type: "text", text: ":+1:" },
      ],
    });
    expect(result.notes).toEqual([]);
  });

  it("keeps a visible diagnosed floor for an invalid empty ADF emoji identity", () => {
    const result = adfToBlocks(doc([{
      type: "paragraph",
      content: [{ type: "emoji", attrs: { shortName: "" } }],
    }]));

    expect(result.blocks[0]).toEqual({
      type: "paragraph",
      content: [{
        type: "text",
        text: "[emoji]",
        emoji: {
          shortName: "[emoji]",
          renderedFrom: "short-name",
        },
      }],
    });
    expect(result.notes).toEqual([
      expect.objectContaining({ code: "emoji-text-fallback" }),
    ]);
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
        marks: [{
          type: "link",
          attrs: {
            href: "https://example.invalid/media",
            title: "Open media",
            id: "link-id",
            collection: "contentId-1",
            occurrenceKey: "link-occurrence",
          },
        }],
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
      mediaPresentation: { layout: "center" },
      link: {
        target: { kind: "external", href: "https://example.invalid/media" },
        adfAttributes: {
          title: "Open media",
          id: "link-id",
          collection: "contentId-1",
          occurrenceKey: "link-occurrence",
        },
      },
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
        {
          type: "media",
          attrs: {
            type: "file",
            id: "media-1",
            collection: "collection-1",
            occurrenceKey: "occurrence-1",
            alt: "Architecture",
            width: 640,
            height: 480,
          },
          marks: [{
            type: "link",
            attrs: { href: "https://example.invalid/architecture", title: "" },
          }],
        },
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
      media: {
        mediaType: "file",
        id: "media-1",
        collection: "collection-1",
        occurrenceKey: "occurrence-1",
        filename: "architecture.png",
      },
      alt: "Architecture",
      width: 640,
      height: 480,
      mediaPresentation: { layout: "center" },
      link: {
        target: { kind: "external", href: "https://example.invalid/architecture" },
        adfAttributes: { title: "" },
      },
      caption: {
        kind: "figure",
        content: [{ type: "text", text: "Figure caption" }],
        localId: "caption-1",
      },
    }]);
    expect(result.notes).toEqual([]);
  });

  it("retains complete media geometry, grouping, inline identity, borders, and attachment types", () => {
    const result = adfToBlocks(doc([
      {
        type: "mediaSingle",
        attrs: {
          layout: "wrap-right",
          width: 42,
          widthType: "percentage",
          localId: "single-1",
        },
        content: [{
          type: "media",
          attrs: {
            type: "file",
            id: "image-1",
            collection: "content-1",
            occurrenceKey: "occurrence-1",
            alt: "Architecture",
            width: 800,
            height: 600,
          },
          marks: [{ type: "border", attrs: { color: "#091e4224", size: 2 } }],
        }],
      },
      {
        type: "mediaGroup",
        content: [
          {
            type: "media",
            attrs: {
              type: "file",
              id: "file-1",
              collection: "content-1",
              alt: "Runbook",
            },
          },
          {
            type: "media",
            attrs: {
              type: "file",
              id: "missing-1",
              collection: "content-1",
              alt: "Missing",
            },
          },
        ],
      },
      {
        type: "mediaSingle",
        attrs: { layout: "center" },
        content: [{
          type: "media",
          attrs: {
            type: "external",
            url: "https://assets.example.invalid/image.png",
            alt: "External",
            width: 320,
            height: 200,
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
            localId: "",
            occurrenceKey: "inline-occurrence",
            alt: "Inline architecture",
            width: 24,
            height: 16,
            data: { zeta: 2, alpha: true },
          },
          marks: [
            { type: "border", attrs: { color: "#0052CC", size: 1 } },
            { type: "annotation", attrs: { id: "inline-comment", annotationType: "inlineComment" } },
          ],
        }],
      },
    ]), {
      pageContext: { id: "page-1" },
      resolveMediaAttachment: (reference) => {
        if (reference.id === "image-1") {
          return {
            filename: "architecture.png",
            pageId: "page-1",
            mediaType: "image/png",
          };
        }
        if (reference.id === "file-1") {
          return {
            filename: "runbook.pdf",
            pageId: "page-1",
            mediaType: "application/pdf",
            webuiLink: "/wiki/attachments/runbook",
            downloadLink: "/download/runbook",
          };
        }
        if (reference.id === "inline-1") {
          return {
            filename: "inline.png",
            pageId: "page-1",
            mediaType: "image/png",
          };
        }
        return undefined;
      },
    });

    expect(result.blocks[0]).toMatchObject({
      type: "image",
      source: { kind: "attachment", filename: "architecture.png", pageId: "page-1" },
      media: {
        mediaType: "file",
        id: "image-1",
        collection: "content-1",
        occurrenceKey: "occurrence-1",
        filename: "architecture.png",
        attachmentMediaType: "image/png",
      },
      mediaPresentation: {
        layout: "wrap-right",
        width: 42,
        widthType: "percentage",
        localId: "single-1",
      },
      border: { color: "#091E4224", size: 2 },
    });
    expect(result.blocks[1]).toMatchObject({
      type: "mediaFallback",
      label: "runbook.pdf",
      media: {
        filename: "runbook.pdf",
        attachmentMediaType: "application/pdf",
        webuiLink: "/wiki/attachments/runbook",
        downloadLink: "/download/runbook",
      },
      mediaGroup: { index: 0, size: 2 },
      link: { target: { kind: "external", href: "/wiki/attachments/runbook" } },
    });
    expect(result.blocks[2]).toMatchObject({
      type: "mediaFallback",
      label: "Missing",
      mediaGroup: { index: 1, size: 2 },
    });
    expect(result.blocks[3]).toMatchObject({
      type: "image",
      source: { kind: "external", url: "https://assets.example.invalid/image.png" },
      media: {
        mediaType: "external",
        url: "https://assets.example.invalid/image.png",
      },
      mediaPresentation: { layout: "center" },
    });
    expect(result.blocks[4]).toEqual({
      type: "paragraph",
      content: [{
        type: "media",
        media: {
          mediaType: "image",
          id: "inline-1",
          collection: "content-1",
          occurrenceKey: "inline-occurrence",
          localId: "",
          dataJson: '{"alpha":true,"zeta":2}',
          filename: "inline.png",
          pageId: "page-1",
          attachmentMediaType: "image/png",
        },
        source: {
          kind: "attachment",
          filename: "inline.png",
          pageId: "page-1",
        },
        alt: "Inline architecture",
        width: 24,
        height: 16,
        annotations: [{ id: "inline-comment", annotationType: "inlineComment" }],
        border: { color: "#0052CC", size: 1 },
      }],
    });
    expect(result.notes.map((note) => note.code)).toEqual([
      "adf-media-unresolved",
      "adf-annotation-unresolved",
    ]);
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
        marks: [
          fragment("block-fragment-z", "last-authored"),
          fragment("block-fragment-a", "first-alphabetically"),
          fragment("block-fragment-z", "duplicate-identity"),
        ],
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
        attrs: { type: "file", id: "resolved-media", collection: "content-1", alt: "resolved" },
        marks: [annotation("media-comment")],
      },
      {
        type: "media",
        attrs: { type: "file", id: "unresolved-media", collection: "content-1", alt: "unresolved" },
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
        fragments: [
          { localId: "block-fragment-z", name: "last-authored" },
          { localId: "block-fragment-a", name: "first-alphabetically" },
          { localId: "block-fragment-z", name: "duplicate-identity" },
        ],
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
        media: {
          mediaType: "file",
          id: "resolved-media",
          collection: "content-1",
          filename: "resolved.png",
        },
        alt: "resolved",
        annotations: [{ id: "media-comment", annotationType: "inlineComment" }],
      },
      {
        type: "mediaFallback",
        label: "unresolved",
        media: { mediaType: "file", id: "unresolved-media", collection: "content-1" },
        alt: "unresolved",
        annotations: [{ id: "fallback-comment", annotationType: "inlineComment" }],
      },
    ]);
    expect(result.notes.filter((note) => note.code === "adf-mark-degraded")).toHaveLength(3);
    expect(result.notes.filter((note) => note.message.includes("ADF mark fragment "))).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("non-visual product provenance"),
        source: expect.objectContaining({ blockPath: "blocks[0].content[1]" }),
      }),
      expect.objectContaining({
        message: expect.stringContaining("non-visual product provenance"),
        source: expect.objectContaining({ blockPath: "blocks[1]" }),
      }),
      expect.objectContaining({
        message: expect.stringContaining("non-visual product provenance"),
        source: expect.objectContaining({ blockPath: "blocks[2]" }),
      }),
    ]);
    expect(result.notes.map((note) => note.code)).toEqual([
      "adf-annotation-unresolved",
      "inline-extension-not-rendered",
      "adf-mark-degraded",
      "macro-not-rendered",
      "adf-mark-degraded",
      "adf-mark-degraded",
      "adf-annotation-unresolved",
      "adf-media-unresolved",
      "adf-annotation-unresolved",
    ]);
  });

  it("retains exact dataConsumer mark boundaries without publishing source ids", () => {
    const consumers = [
      { type: "dataConsumer", attrs: { sources: ["source-a", "", "source-a"] } },
      { type: "dataConsumer", attrs: { sources: ["source-b"] } },
    ];
    const result = adfToBlocks(doc([
      {
        type: "media",
        attrs: {
          type: "file",
          id: "block-media",
          collection: "content-1",
          alt: "Block media",
        },
        marks: consumers,
      },
      {
        type: "paragraph",
        content: [{
          type: "mediaInline",
          attrs: {
            type: "image",
            id: "inline-media",
            collection: "content-1",
            alt: "Inline media",
          },
          marks: consumers,
        }],
      },
    ]), {
      resolveMediaAttachment: (reference) => ({
        filename: `${reference.id}.png`,
        mediaType: "image/png",
      }),
    });

    const expected = [
      { sources: ["source-a", "", "source-a"] },
      { sources: ["source-b"] },
    ];
    expect(result.blocks[0]).toMatchObject({
      type: "image",
      media: { dataConsumers: expected },
    });
    expect(result.blocks[1]).toMatchObject({
      type: "paragraph",
      content: [{ type: "media", media: { dataConsumers: expected } }],
    });
    expect(result.notes).toHaveLength(2);
    expect(result.notes.every((note) =>
      note.code === "adf-mark-degraded" &&
      note.message.includes("non-visual provenance") &&
      !note.message.includes("source-a") &&
      !note.message.includes("source-b")
    )).toBe(true);
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

  it("correlates annotation marker refs to portable comment text, status, and replies", () => {
    const resolveAnnotation = createAdfAnnotationResolver([{
      id: "comment-resource-9",
      author: { displayName: "not exported", accountId: "account-private" },
      created: "2026-01-01T00:00:00.000Z",
      body: "<p>Review <strong>this</strong> value</p>",
      status: "resolved",
      replies: [{
        id: "reply-resource-1",
        author: { displayName: "not exported" },
        created: "2026-01-02T00:00:00.000Z",
        body: "<p>Updated</p>",
        status: "open",
        parentId: "comment-resource-9",
        replies: [],
        textSelection: "",
      }],
      textSelection: "annotated",
      inlineMarkerRef: "marker-9",
    }]);
    const result = adfToBlocks(doc([{
      type: "paragraph",
      content: [{
        type: "text",
        text: "annotated",
        marks: [{
          type: "annotation",
          attrs: { id: "marker-9", annotationType: "inlineComment" },
        }],
      }],
    }]), { resolveAnnotation, annotationCommentsComplete: true });

    expect(result.blocks).toEqual([{
      type: "paragraph",
      content: [{
        type: "text",
        text: "annotated",
        annotations: [{
          id: "marker-9",
          annotationType: "inlineComment",
          comment: {
            bodyText: "Review this value",
            status: "resolved",
            created: "2026-01-01T00:00:00.000Z",
            replies: [{
              bodyText: "Updated",
              created: "2026-01-02T00:00:00.000Z",
            }],
          },
        }],
      }],
    }]);
    expect(result.notes).toEqual([]);
    expect(JSON.stringify(result.blocks)).not.toContain("account-private");
    expect(JSON.stringify(result.blocks)).not.toContain("comment-resource-9");
  });

  it("reports unresolved and truncated annotation resources without dropping the range", () => {
    const result = adfToBlocks(doc([{
      type: "paragraph",
      content: [{
        type: "text",
        text: "annotated",
        marks: [{
          type: "annotation",
          attrs: { id: "missing-marker", annotationType: "inlineComment" },
        }],
      }],
    }]), {
      resolveAnnotation: () => undefined,
      annotationCommentsComplete: false,
    });

    expect(result.blocks[0]).toMatchObject({
      content: [{
        annotations: [{ id: "missing-marker", annotationType: "inlineComment" }],
      }],
    });
    expect(result.notes.map((note) => note.code)).toEqual([
      "adf-annotation-unresolved",
      "adf-annotation-comments-truncated",
    ]);
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
    expect(result.notes.map((note) => note.code)).toEqual([
      "macro-not-rendered",
      "inline-extension-not-rendered",
    ]);
  });

  it("retains every Stage-0 multi-bodied extension frame and its non-visual provenance", () => {
    const result = adfToBlocks(doc([{
      type: "multiBodiedExtension",
      attrs: {
        extensionType: "com.example.stage0",
        extensionKey: "multi-frame",
        localId: "multi-local",
        parameters: { mode: "portable" },
      },
      content: [
        {
          type: "extensionFrame",
          marks: [
            { type: "fragment", attrs: { localId: "frame-fragment", name: "" } },
            { type: "dataConsumer", attrs: { sources: ["source-a", "source-b"] } },
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
    }]), { pageContext: { id: "page-1", version: 3, spaceKey: "S" } });

    expect(result.blocks).toEqual([{
      type: "unknown",
      macroName: "multi-frame",
      adfExtension: {
        extensionType: "com.example.stage0",
        extensionKey: "multi-frame",
        localId: "multi-local",
      },
      params: [{ name: "mode", text: "portable" }],
      extensionFrames: [
        {
          content: [{
            type: "paragraph",
            content: [{ type: "text", text: "Frame one" }],
          }],
          fragments: [{ localId: "frame-fragment", name: "" }],
          dataConsumers: [{ sources: ["source-a", "source-b"] }],
        },
        {
          content: [{
            type: "callout",
            kind: "info",
            content: [{
              type: "paragraph",
              content: [{ type: "text", text: "Frame two" }],
            }],
          }],
        },
      ],
      sourcePage: { id: "page-1", version: 3, spaceKey: "S" },
    }]);
    expect(result.notes.map((note) => note.code)).toEqual([
      "adf-mark-degraded",
      "adf-mark-degraded",
      "macro-not-rendered",
      "adf-node-degraded",
    ]);
  });

  it("keeps unresolved extension-body diagnostics on the block until fallback rendering", () => {
    const result = adfToBlocks(doc([{
      type: "bodiedExtension",
      attrs: { extensionType: "x", extensionKey: "body-notes" },
      content: [{
        type: "media",
        attrs: { type: "file", id: "unresolved", collection: "content-1" },
      }],
    }]));
    expect(result.notes.map((note) => note.code)).toEqual(["macro-not-rendered"]);
    expect(result.blocks[0]).toMatchObject({
      type: "unknown",
      macroName: "body-notes",
      bodyNotes: [{ code: "adf-media-unresolved" }],
    });
  });

  it("retains synced-content identity, embedded snapshots, references, and breakout intent", () => {
    const result = adfToBlocks(doc([
      {
        type: "bodiedSyncBlock",
        attrs: { resourceId: "opaque-resource-snapshot", localId: "" },
        marks: [{ type: "breakout", attrs: { mode: "wide", width: 720 } }],
        content: [{
          type: "paragraph",
          content: [{ type: "text", text: "Embedded synced snapshot" }],
        }],
      },
      {
        type: "syncBlock",
        attrs: {
          resourceId: "opaque-resource-reference",
          localId: "sync-reference-local",
        },
        marks: [{ type: "breakout", attrs: { mode: "full-width" } }],
      },
    ]));

    expect(result.blocks).toEqual([
      {
        type: "callout",
        kind: "panel",
        title: "Synced content snapshot",
        content: [{
          type: "paragraph",
          content: [{ type: "text", text: "Embedded synced snapshot" }],
        }],
        syncedContent: {
          resourceId: "opaque-resource-snapshot",
          localId: "",
          projection: "embedded-snapshot",
          breakout: { mode: "wide", width: 720 },
        },
      },
      {
        type: "callout",
        kind: "panel",
        title: "Synced content",
        content: [{
          type: "paragraph",
          content: [{
            type: "text",
            text: "Synced content is unavailable in this static export.",
          }],
        }],
        syncedContent: {
          resourceId: "opaque-resource-reference",
          localId: "sync-reference-local",
          projection: "unresolved-reference",
          breakout: { mode: "full-width" },
        },
      },
    ]);
    expect(result.notes.filter((note) => note.code === "adf-node-degraded")).toHaveLength(2);
    expect(result.notes.filter((note) => note.code === "adf-mark-degraded")).toHaveLength(2);
    expect(JSON.stringify(result.notes)).not.toContain("opaque-resource");
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
      "adf-mark-degraded",
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
      {
        type: "unknown",
        macroName: "futureBlock",
        unsupportedAdf: {
          nodeType: "futureBlock",
          sourceRepresentation: "atlas_doc_format",
          attributes: [{ name: "future", value: true }],
        },
        body: [{
          type: "paragraph",
          content: [
            { type: "text", text: "Visible" },
            {
              type: "text",
              text: " inline",
              unsupportedAdf: [{
                nodeType: "futureInline",
                sourceRepresentation: "atlas_doc_format",
              }],
            },
          ],
        }],
      },
      {
        type: "unknown",
        macroName: "futureEmpty",
        unsupportedAdf: {
          nodeType: "futureEmpty",
          sourceRepresentation: "atlas_doc_format",
        },
      },
    ]);
    expect(result.degraded).toBe(true);
    expect(result.notes).toHaveLength(3);
    expect(result.notes[2]?.message).toContain("suppressed");
  });

  it("retains exact unsupportedBlock/unsupportedInline provenance and child formatting", () => {
    const result = adfToBlocks(doc([{
      type: "unsupportedBlock",
      attrs: {
        originalValue: { kind: "legacy", version: 2 },
        empty: "",
      },
      marks: [{ type: "futureMark", attrs: { mode: "keep" } }],
      content: [{
        type: "paragraph",
        content: [
          { type: "text", text: "before " },
          {
            type: "unsupportedInline",
            attrs: { originalValue: ["a", "b"] },
            content: [{
              type: "text",
              text: "rich",
              marks: [{ type: "strong" }],
            }],
          },
        ],
      }],
    }]));

    expect(result.blocks).toEqual([{
      type: "unknown",
      macroName: "unsupportedBlock",
      unsupportedAdf: {
        nodeType: "unsupportedBlock",
        sourceRepresentation: "atlas_doc_format",
        attributes: [
          { name: "originalValue", value: { kind: "legacy", version: 2 } },
          { name: "empty", value: "" },
        ],
        marks: [{
          type: "futureMark",
          attributes: [{ name: "mode", value: "keep" }],
        }],
      },
      body: [{
        type: "paragraph",
        content: [
          { type: "text", text: "before " },
          {
            type: "text",
            text: "rich",
            marks: ["bold"],
            unsupportedAdf: [{
              nodeType: "unsupportedInline",
              sourceRepresentation: "atlas_doc_format",
              attributes: [{ name: "originalValue", value: ["a", "b"] }],
            }],
          },
        ],
      }],
    }]);
    expect(result.notes.some((note) =>
      note.code === "adf-node-degraded" &&
      note.source?.blockPath === "blocks[0]"
    )).toBe(true);
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
    expect(Object.keys(ADF_STAGE0_NODE_DECODE_MODES).sort())
      .toEqual([...PINNED_ADF_STAGE0_NODE_TYPES].sort());
    expect(Object.keys(ADF_MARK_DECODE_MODES).sort()).toEqual([...PINNED_ADF_MARK_TYPES].sort());
    expect(Object.values(ADF_NODE_DECODE_MODES).every((mode) => ["native", "approximation", "visible-fallback"].includes(mode))).toBe(true);
    expect(Object.values(ADF_STAGE0_NODE_DECODE_MODES).every((mode) => ["native", "approximation", "visible-fallback"].includes(mode))).toBe(true);
    expect(Object.values(ADF_MARK_DECODE_MODES).every((mode) => ["native", "approximation", "visible-fallback"].includes(mode))).toBe(true);
  });

  it("records degradation even when the note budget is zero", () => {
    const result = adfToBlocks(doc([{
      type: "futureNode",
      content: [{ type: "paragraph", content: [{ type: "text", text: "visible" }] }],
    }]), {
      parseBudget: { maxDiagnostics: 0 },
    });
    expect(result.blocks).toEqual([{
      type: "unknown",
      macroName: "futureNode",
      unsupportedAdf: {
        nodeType: "futureNode",
        sourceRepresentation: "atlas_doc_format",
      },
      body: [{ type: "paragraph", content: [{ type: "text", text: "visible" }] }],
    }]);
    expect(result.notes).toEqual([]);
    expect(result.degraded).toBe(true);
  });
});
