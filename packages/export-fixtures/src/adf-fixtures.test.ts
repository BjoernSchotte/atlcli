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
      "paragraph",
      "paragraph",
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
    ]);
    expect(pdf.blocks[7]).toMatchObject({
      type: "list",
      ordered: true,
      start: 3,
      items: [{ content: [
        { type: "paragraph" },
        { type: "list", ordered: true, start: 8 },
      ] }],
    });
    expect(pdf.blocks[8]).toMatchObject({
      type: "list",
      ordered: false,
      items: [{
        content: [
          { type: "paragraph" },
          { type: "list", ordered: false },
        ],
      }],
    });
    expect(pdf.blocks[9]).toMatchObject({
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
    expect(pdf.blocks[10]).toMatchObject({
      type: "list",
      ordered: false,
      listKind: "decision",
      localId: "decisions-root",
      items: [{ kind: "decision", state: "DECIDED", localId: "decision-ship" }],
    });
    expect(pdf.blocks[2]).toMatchObject({
      type: "paragraph",
      presentation: { alignment: "center", fontSize: "small" },
    });
    expect(pdf.blocks[3]).toMatchObject({
      type: "paragraph",
      presentation: { indentation: 2 },
    });
    expect(pdf.blocks[5]).toMatchObject({ type: "callout", kind: "success" });
    expect(pdf.blocks[6]).toMatchObject({ type: "callout", kind: "error" });
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
      ]),
    });
    expect(pdf.blocks[11]).toMatchObject({
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
    expect(pdf.blocks[12]).toMatchObject({
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
    expect(pdf.blocks[13]).toEqual({
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
    expect(pdf.blocks[15]).toMatchObject({
      type: "mediaFallback",
      label: "Visible media fallback",
      media: { mediaType: "file", id: "unresolved-media" },
      caption: {
        kind: "figure",
        localId: "media-caption-local",
        content: [{ type: "text", text: "Media caption" }],
      },
    });
    expect(pdf.notes.map((note) => note.code)).toContain("emoji-text-fallback");
    expect(pdf.notes.map((note) => note.code)).toContain("adf-media-unresolved");
    expect(pdf.notes.filter((note) => note.code === "expand-static")).toHaveLength(2);
    expect(pdf.notes.map((note) => note.code)).toContain("adf-node-degraded");
    expect(pdf.notes.map((note) => note.code)).toContain("adf-mark-degraded");
  });
});
