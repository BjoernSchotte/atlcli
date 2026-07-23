import { describe, expect, it } from "bun:test";
import { ADF_CONFORMANCE_SOURCE, adfConformanceBlocks } from "./index.js";

describe("ADF browser conformance fixture", () => {
  it("starts from ADF and decodes identically for both target renderers", () => {
    expect(JSON.parse(ADF_CONFORMANCE_SOURCE)).toMatchObject({ version: 1, type: "doc" });
    const pdf = adfConformanceBlocks("pdf");
    const word = adfConformanceBlocks("word");

    expect(pdf.representation).toBe("atlas_doc_format");
    expect(word.representation).toBe("atlas_doc_format");
    expect(pdf.blocks).toEqual(word.blocks);
    expect(pdf.notes).toEqual(word.notes);
    expect(pdf.blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "smartCard",
      "smartCard",
      "smartCard",
      "paragraph",
      "paragraph",
      "callout",
      "callout",
      "callout",
      "callout",
      "list",
      "list",
      "list",
      "list",
      "table",
      "layout",
      "expand",
      "unknown",
      "mediaFallback",
      "paragraph",
      "mediaFallback",
      "mediaFallback",
      "paragraph",
      "codeBlock",
    ]);
    expect(pdf.blocks[0]).toMatchObject({ type: "heading", localId: "heading-local" });
    expect(pdf.blocks[1]).toMatchObject({ type: "paragraph", localId: "paragraph-local" });
    expect(pdf.blocks[11]).toMatchObject({
      type: "list",
      ordered: true,
      start: 3,
      items: [{ localId: "ordered-item-local", content: [
        { type: "paragraph" },
        { type: "list", ordered: true, start: 8 },
      ] }],
    });
    expect(pdf.blocks[12]).toMatchObject({
      type: "list",
      ordered: false,
      items: [{
        localId: "bullet-item-local",
        content: [
          { type: "paragraph" },
          { type: "list", ordered: false },
        ],
      }],
    });
    expect(pdf.blocks[13]).toMatchObject({
      type: "list",
      ordered: false,
      listKind: "task",
      localId: "tasks-root",
      items: [
        { kind: "task", state: "TODO", localId: "task-open", checked: false },
        {
          kind: "task",
          state: "DONE",
          localId: "task-done",
          block: true,
          checked: true,
          content: [
            { type: "paragraph" },
            { type: "list", listKind: "task", localId: "tasks-nested" },
          ],
        },
      ],
    });
    expect(pdf.blocks[14]).toMatchObject({
      type: "list",
      ordered: false,
      listKind: "decision",
      localId: "decisions-root",
      items: [{ kind: "decision", state: "DECIDED", localId: "decision-ship" }],
    });
    expect(pdf.blocks[5]).toMatchObject({
      type: "paragraph",
      presentation: { alignment: "center", fontSize: "small" },
    });
    expect(pdf.blocks[6]).toMatchObject({
      type: "paragraph",
      presentation: { indentation: 2 },
    });
    expect(pdf.blocks[8]).toMatchObject({ type: "callout", kind: "success" });
    expect(pdf.blocks[9]).toMatchObject({ type: "callout", kind: "error" });
    expect(pdf.blocks[10]).toMatchObject({
      type: "callout",
      kind: "panel",
      localId: "custom-panel-local",
      panelColor: "#123456",
      panelIcon: ":star:",
      panelIconId: "custom-panel-icon",
      panelIconText: "★",
    });
    expect(pdf.blocks[24]).toMatchObject({
      type: "codeBlock",
      language: "typescript",
      wrap: false,
      hideLineNumbers: false,
      localId: "code-local",
      uniqueId: "code-unique",
    });
    expect(pdf.blocks[1]).toMatchObject({
      type: "paragraph",
      content: expect.arrayContaining([
        {
          type: "text",
          text: "INLINE_TOKEN",
          marks: ["code"],
          annotations: [{
            id: "annotation-inline-code",
            annotationType: "inlineComment",
          }],
        },
        {
          type: "text",
          text: ":custom_party:",
          emoji: {
            shortName: ":custom_party:",
            id: "custom-emoji",
            text: "",
            renderedFrom: "short-name",
          },
        },
        { type: "date", timestamp: "1709510400000", localId: "date-local" },
        { type: "status", text: "Ready", color: "purple", localId: "status-local" },
        { type: "status", text: "Keep Case", color: "neutral", style: "mixedCase" },
        { type: "placeholder", text: "editor-only-secret", localId: "placeholder-local" },
        {
          type: "mention",
          accountId: "mention-account-1",
          sourceText: "@Example Person",
          displayName: "Example Person",
          localId: "mention-local",
          accessLevel: "SITE",
          userType: "DEFAULT",
        },
      ]),
    });
    expect(pdf.blocks[15]).toMatchObject({
      type: "table",
      presentation: {
        layout: "align-end",
        width: 480,
        displayMode: "fixed",
        numberedColumn: true,
        localId: "table-local",
      },
      rows: [{
        localId: "table-row-local",
        cells: [
          {
            localId: "table-header-local",
            columnWidths: [240],
            verticalAlignment: "middle",
          },
          {
            localId: "table-cell-local",
            columnWidths: [360],
            verticalAlignment: "bottom",
          },
        ],
      }],
      fragments: [{ localId: "table-fragment", name: "semantic-table" }],
    });
    expect(pdf.blocks[16]).toMatchObject({
      type: "layout",
      localId: "layout-local",
      breakout: { mode: "wide", width: 960 },
      columns: [
        {
          width: 30,
          verticalAlignment: "middle",
          localId: "layout-sidebar-local",
        },
        {
          width: 70,
          verticalAlignment: "bottom",
          localId: "layout-main-local",
        },
      ],
    });
    expect(pdf.blocks[17]).toEqual({
      type: "expand",
      nested: false,
      title: "Expanded title",
      localId: "expand-local",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Expanded body" }],
        },
        {
          type: "expand",
          nested: true,
          title: "Nested expanded title",
          localId: "",
          content: [{
            type: "paragraph",
            content: [{ type: "text", text: "Nested expanded body" }],
          }],
        },
      ],
    });
    expect(pdf.blocks[19]).toMatchObject({
      type: "mediaFallback",
      label: "Visible media fallback",
      media: {
        mediaType: "file",
        id: "unresolved-media",
        collection: "contentId-1",
      },
      mediaPresentation: {
        layout: "wrap-left",
        width: 40,
        widthType: "percentage",
        localId: "media-single-local",
      },
      border: { color: "#091E4224", size: 2 },
      caption: {
        kind: "figure",
        localId: "media-caption-local",
        content: [{ type: "text", text: "Media caption" }],
      },
    });
    expect(pdf.blocks[20]).toMatchObject({
      type: "paragraph",
      content: [{
        type: "text",
        text: "This paragraph demonstrates bounded text wrapping beside authored media.",
      }],
    });
    expect(pdf.blocks[21]).toMatchObject({
      type: "mediaFallback",
      label: "Grouped attachment one",
      mediaGroup: { index: 0, size: 2 },
    });
    expect(pdf.blocks[22]).toMatchObject({
      type: "mediaFallback",
      label: "Grouped attachment two",
      mediaGroup: { index: 1, size: 2 },
    });
    expect(pdf.blocks[23]).toMatchObject({
      type: "paragraph",
      content: [{
        type: "text",
        text: "Inline media: ",
      }, {
        type: "media",
        media: {
          mediaType: "image",
          id: "inline-media-1",
          collection: "contentId-1",
          localId: "inline-media-local",
          dataConsumers: [{
            sources: ["synthetic-consumer-primary", "synthetic-consumer-secondary"],
          }],
          dataJson: '{"source":"fixture"}',
        },
        alt: "Inline media chip",
        width: 24,
        height: 16,
        border: { color: "#0052CC", size: 1 },
      }],
    });
    expect(pdf.notes.map((note) => note.code)).toContain("emoji-text-fallback");
    expect(pdf.notes.map((note) => note.code)).toContain("adf-media-unresolved");
    expect(pdf.notes.filter((note) => note.code === "expand-static")).toHaveLength(2);
    expect(pdf.notes.map((note) => note.code)).toContain("adf-node-degraded");
    expect(pdf.notes.map((note) => note.code)).toContain("adf-mark-degraded");
    expect(pdf.notes).toContainEqual(expect.objectContaining({
      code: "adf-mark-degraded",
      message: expect.stringContaining("non-visual provenance"),
    }));
    expect(pdf.notes.some((note) => note.message.includes("synthetic-consumer"))).toBe(false);
  });
});
