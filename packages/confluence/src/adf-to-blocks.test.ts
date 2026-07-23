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
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Heading" }] },
      {
        type: "paragraph",
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
      { type: "codeBlock", attrs: { language: "text" }, content: [{ type: "text", text: "line 1\nline 2\n" }] },
    ]));

    expect(result.representation).toBe("atlas_doc_format");
    expect(result.degraded).toBeUndefined();
    expect(result.blocks).toEqual([
      { type: "heading", level: 2, content: [{ type: "text", text: "Heading" }] },
      { type: "paragraph", content: [
        { type: "text", text: ":warning: CONFIG_TOKEN_A `literal` ", marks: ["bold", "code", "italic"] },
        { type: "text", text: "colored", marks: ["superscript"], color: "#123456", backgroundColor: "#AABBCC" },
      ] },
      { type: "codeBlock", language: "text", code: "line 1\nline 2\n" },
    ]);
    expect(result.notes).toEqual([]);
  });

  it("maps mixed lists, authored starts, and task state without degradation", () => {
    const result = adfToBlocks(doc([
      {
        type: "orderedList",
        attrs: { order: 3 },
        content: [{
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "first" }] },
            { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "nested" }] }] }] },
          ],
        }],
      },
      {
        type: "taskList",
        content: [
          { type: "taskItem", attrs: { state: "TODO" }, content: [{ type: "paragraph", content: [{ type: "text", text: "open" }] }] },
          { type: "taskItem", attrs: { state: "DONE" }, content: [{ type: "paragraph", content: [{ type: "text", text: "done" }] }] },
        ],
      },
    ]));

    expect(result.blocks[0]).toMatchObject({
      type: "list",
      ordered: true,
      start: 3,
      items: [{ content: [
        { type: "paragraph", content: [{ type: "text", text: "first" }] },
        { type: "list", ordered: false },
      ] }],
    });
    expect(result.blocks[1]).toEqual({
      type: "list",
      ordered: false,
      items: [
        { checked: false, content: [{ type: "paragraph", content: [{ type: "text", text: "open" }] }] },
        { checked: true, content: [{ type: "paragraph", content: [{ type: "text", text: "done" }] }] },
      ],
    });
    expect(result.notes.map((note) => note.code)).not.toContain("adf-node-degraded");
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
        presentation: { alignment: "center", indentation: 2 },
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

  it("preserves table spans, backgrounds, widths, and reports ADF-only geometry", () => {
    const result = adfToBlocks(doc([{
      type: "table",
      attrs: { layout: "wide", width: 900, displayMode: "fixed" },
      content: [{
        type: "tableRow",
        content: [
          {
            type: "tableHeader",
            attrs: { colspan: 2, rowspan: 1, background: "#abc", colwidth: [200, 300], valign: "middle" },
            content: [{ type: "paragraph", content: [{ type: "text", text: "Header" }] }],
          },
          {
            type: "tableCell",
            attrs: { colspan: 1, rowspan: 2, colwidth: [400] },
            content: [{ type: "paragraph", content: [{ type: "text", text: "Cell" }] }],
          },
        ],
      }],
    }]));

    expect(result.blocks).toEqual([{
      type: "table",
      columnWidths: [200, 300, 400],
      rows: [{ cells: [
        {
          header: true,
          colspan: 2,
          rowspan: 1,
          backgroundColor: "#AABBCC",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Header" }] }],
        },
        {
          header: false,
          colspan: 1,
          rowspan: 2,
          content: [{ type: "paragraph", content: [{ type: "text", text: "Cell" }] }],
        },
      ] }],
    }]);
    expect(result.notes.filter((note) => note.code === "adf-node-degraded")).toHaveLength(2);
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
          { type: "date", attrs: { timestamp: "1704067200000" } },
          { type: "mention", attrs: { id: "user-1", text: "@Ada" } },
          { type: "mention", attrs: { id: "team-1", userType: "TEAM" } },
          { type: "status", attrs: { text: "READY", color: "GREEN" } },
          { type: "inlineCard", attrs: { url: "https://example.invalid/card" } },
          { type: "inlineCard", attrs: { data: { url: "https://example.invalid/data-card", name: "Visible card title" } } },
        ],
      },
      { type: "blockCard", attrs: { url: "https://example.invalid/block" } },
    ]));

    expect(result.blocks[0]).toMatchObject({ type: "paragraph", content: [
      { type: "text", text: ":warning:" },
      { type: "text", text: "⚠️" },
      { type: "text", text: ":custom:" },
      { type: "text", text: "2024-01-01" },
      { type: "mention", accountId: "user-1", displayName: "Ada" },
      { type: "mention", accountId: "team-1" },
      { type: "status", text: "READY", color: "green" },
      { type: "link", target: { kind: "external", href: "https://example.invalid/card" } },
      {
        type: "link",
        target: { kind: "external", href: "https://example.invalid/data-card" },
        content: [{ type: "text", text: "Visible card title" }],
      },
    ] });
    expect(result.blocks[1]).toMatchObject({ type: "paragraph", content: [{ type: "link" }] });
    expect(result.notes.some((note) => note.message.includes("Unicode text"))).toBe(true);
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
          { type: "caption", content: [{ type: "paragraph", content: [{ type: "text", text: "Caption" }] }] },
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
    expect(result.blocks.slice(1)).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "diagram.png" }] },
      { type: "paragraph", content: [{ type: "text", text: "Caption" }] },
    ]);
    expect(result.notes.map((note) => note.code)).toContain("adf-media-unresolved");
    expect(result.notes.every((note) => note.source?.pageId === "page-1")).toBe(true);
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
        { type: "caption", content: [{ type: "paragraph", content: [{ type: "text", text: "Figure caption" }] }] },
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
      caption: { kind: "figure", content: [{ type: "text", text: "Figure caption" }] },
    }]);
    expect(result.notes).toEqual([]);
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
    const result = adfToBlocks(doc([{ type: "placeholder", attrs: { text: "visible" } }]), {
      parseBudget: { maxDiagnostics: 0 },
    });
    expect(result.blocks).toEqual([{ type: "paragraph", content: [{ type: "text", text: "visible" }] }]);
    expect(result.notes).toEqual([]);
    expect(result.degraded).toBe(true);
  });
});
