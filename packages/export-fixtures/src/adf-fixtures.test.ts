import { describe, expect, it } from "bun:test";
import {
  ADF_EMOJI_CONFORMANCE_CASES,
  ADF_EMOJI_CUSTOM_CONTROL,
  ADF_EMOJI_LITERAL_CONTROL,
  ADF_CONFORMANCE_SOURCE,
  STORAGE_CODE_COMPATIBILITY_SOURCE,
  adfConformanceBlocks,
  storageCodeCompatibilityBlocks,
} from "./index.js";

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
      "unknown",
      "mediaFallback",
      "paragraph",
      "mediaFallback",
      "mediaFallback",
      "paragraph",
      "codeBlock",
      "callout",
      "callout",
      "unknown",
      "unknown",
      "callout",
      "callout",
      "callout",
      "paragraph",
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
      panelIconProjection: {
        canonicalName: "yellow-star",
        text: "Y★",
      },
    });
    expect(pdf.blocks[7]).toMatchObject({
      type: "callout",
      kind: "info",
      content: [
        { type: "paragraph" },
        {
          type: "list",
          ordered: false,
          items: [{ content: [{ type: "paragraph" }] }],
        },
      ],
    });
    expect(pdf.blocks.slice(30, 33)).toMatchObject([
      { type: "callout", kind: "note" },
      { type: "callout", kind: "warning" },
      { type: "callout", kind: "tip" },
    ]);
    expect(pdf.blocks[25]).toMatchObject({
      type: "codeBlock",
      language: "typescript",
      wrap: false,
      hideLineNumbers: false,
      localId: "code-local",
      uniqueId: "code-unique",
      breakout: { mode: "wide", width: 880 },
    });
    expect(pdf.blocks[26]).toMatchObject({
      type: "callout",
      title: "Synced content snapshot",
      syncedContent: {
        resourceId: "synthetic-sync-snapshot-resource",
        localId: "synthetic-sync-snapshot-local",
        projection: "embedded-snapshot",
        breakout: { mode: "wide", width: 840 },
      },
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: "Synced snapshot body" }],
      }],
    });
    expect(pdf.blocks[27]).toMatchObject({
      type: "callout",
      title: "Synced content",
      syncedContent: {
        resourceId: "synthetic-sync-reference-resource",
        localId: "synthetic-sync-reference-local",
        projection: "unresolved-reference",
        breakout: { mode: "full-width" },
      },
    });
    expect(pdf.blocks[28]).toMatchObject({
      type: "unknown",
      macroName: "unsupportedBlock",
      unsupportedAdf: {
        nodeType: "unsupportedBlock",
        sourceRepresentation: "atlas_doc_format",
        attributes: [
          { name: "originalValue", value: { kind: "synthetic-legacy-wrapper" } },
          { name: "opaqueIdentity", value: "unsupported-block-private-provenance" },
        ],
      },
      body: [{
        type: "paragraph",
        content: expect.arrayContaining([{
          type: "text",
          text: "rich inline content",
          marks: ["bold"],
          unsupportedAdf: [{
            nodeType: "unsupportedInline",
            sourceRepresentation: "atlas_doc_format",
            attributes: [
              { name: "originalValue", value: ["synthetic", "inline"] },
              { name: "opaqueIdentity", value: "unsupported-inline-private-provenance" },
            ],
          }],
        }]),
      }],
    });
    expect(pdf.blocks[29]).toEqual({
      type: "unknown",
      macroName: "static-extension",
      adfExtension: {
        extensionType: "com.atlassian.ecosystem",
        extensionKey: "static-extension",
        localId: "static-extension-private-local-id",
      },
      params: [{
        name: "privatemode",
        text: "static-extension-private-parameter",
      }],
      sourcePage: {
        id: "adf-conformance-page",
        version: 1,
        spaceKey: "TEST",
      },
    });
    const emojiMatrix = pdf.blocks[33];
    expect(emojiMatrix).toMatchObject({
      type: "paragraph",
      localId: "emoji-matrix",
    });
    if (emojiMatrix?.type !== "paragraph") {
      throw new Error("ADF emoji matrix did not decode as one paragraph.");
    }
    expect(
      ADF_EMOJI_CONFORMANCE_CASES.filter((emojiCase) => emojiCase.category === "canonical"),
    ).toHaveLength(22);
    expect(
      ADF_EMOJI_CONFORMANCE_CASES.filter((emojiCase) => emojiCase.category === "alias"),
    ).toHaveLength(26);
    ADF_EMOJI_CONFORMANCE_CASES.forEach((emojiCase, index) => {
      expect(emojiMatrix.content[index * 3 + 1]).toMatchObject({
        type: "text",
        text: emojiCase.expectedText,
        emoji: {
          shortName: emojiCase.shortName,
          renderedFrom: "catalog-projection",
          projection: { text: emojiCase.expectedText },
        },
      });
    });
    const emojiMatrixText = emojiMatrix.content
      .map((node) => node.type === "text" ? node.text : "\n")
      .join("");
    expect(emojiMatrixText).toContain(`LITERAL known => ${ADF_EMOJI_LITERAL_CONTROL}`);
    expect(emojiMatrixText).toContain(ADF_EMOJI_CUSTOM_CONTROL);
    expect(emojiMatrixText).toContain("⚠️");
    expect(emojiMatrixText).toContain("👍🏽");
    expect(emojiMatrixText).toContain("👩‍💻");
    expect(emojiMatrixText).toContain("🇩🇪");
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
            comment: {
              bodyText: "Review the inline token",
              status: "resolved",
              created: "2026-07-22T08:00:00.000Z",
              replies: [{
                bodyText: "Reviewed",
                created: "2026-07-22T08:01:00.000Z",
              }],
            },
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
            content: [
              { type: "paragraph" },
              { type: "callout", kind: "warning" },
            ],
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
      breakout: { mode: "full-width", width: 1024 },
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
      type: "unknown",
      macroName: "multi-frame-extension",
      adfExtension: {
        extensionType: "com.example.stage0",
        extensionKey: "multi-frame-extension",
        localId: "multi-frame-local",
      },
      params: [{ name: "mode", text: "portable" }],
      extensionFrames: [
        {
          fragments: [{ localId: "multi-frame-fragment", name: "" }],
          dataConsumers: [{ sources: ["multi-frame-consumer"] }],
          content: [{
            type: "paragraph",
            content: [{ type: "text", text: "Multi frame first body" }],
          }],
        },
        {
          content: [{
            type: "paragraph",
            content: [{ type: "text", text: "Multi frame second body" }],
          }],
        },
      ],
      sourcePage: {
        id: "adf-conformance-page",
        version: 1,
        spaceKey: "TEST",
      },
    });
    expect(pdf.blocks[20]).toMatchObject({
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
    expect(pdf.blocks[21]).toMatchObject({
      type: "paragraph",
      content: [{
        type: "text",
        text: "This paragraph demonstrates bounded text wrapping beside authored media.",
      }],
    });
    expect(pdf.blocks[22]).toMatchObject({
      type: "mediaFallback",
      label: "Grouped attachment one",
      mediaGroup: { index: 0, size: 2 },
    });
    expect(pdf.blocks[23]).toMatchObject({
      type: "mediaFallback",
      label: "Grouped attachment two",
      mediaGroup: { index: 1, size: 2 },
    });
    expect(pdf.blocks[24]).toMatchObject({
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
    expect(pdf.notes.filter((note) => note.code === "emoji-text-fallback")).toHaveLength(2);
    expect(pdf.notes.map((note) => note.code)).toContain("adf-media-unresolved");
    expect(pdf.notes.filter((note) => note.code === "expand-static")).toHaveLength(2);
    expect(pdf.notes.map((note) => note.code)).toContain("adf-node-degraded");
    expect(pdf.notes.map((note) => note.code)).toContain("adf-mark-degraded");
    expect(pdf.notes).toContainEqual(expect.objectContaining({
      code: "macro-not-rendered",
      macroName: "static-extension",
    }));
    expect(pdf.notes).toContainEqual(expect.objectContaining({
      code: "macro-not-rendered",
      macroName: "multi-frame-extension",
    }));
    expect(pdf.notes).toContainEqual(expect.objectContaining({
      code: "adf-node-degraded",
      message: expect.stringContaining("every Stage-0 extensionFrame boundary"),
    }));
    expect(pdf.notes).toContainEqual(expect.objectContaining({
      code: "adf-mark-degraded",
      message: expect.stringContaining("non-visual provenance"),
    }));
    expect(pdf.notes.some((note) => note.message.includes("synthetic-consumer"))).toBe(false);
    expect(pdf.notes.some((note) => note.message.includes("synthetic-sync"))).toBe(false);
    expect(JSON.stringify(pdf.notes)).not.toContain("static-extension-private");
    expect(JSON.stringify(pdf.notes)).not.toContain("multi-frame-fragment");
    expect(JSON.stringify(pdf.notes)).not.toContain("multi-frame-consumer");
  });
});

describe("Storage code compatibility fixture", () => {
  it("decodes legacy title and collapse intent without losing the complete body", () => {
    expect(STORAGE_CODE_COMPATIBILITY_SOURCE).toContain('ac:name="code"');

    const result = storageCodeCompatibilityBlocks();

    expect(result.blocks).toEqual([{
      type: "codeBlock",
      language: "typescript",
      code: "const legacyStorage = true;\nexport { legacyStorage };",
      title: "Legacy Storage code title",
      initiallyCollapsed: true,
      hideLineNumbers: false,
      firstLineNumber: 12,
      localId: "storage-code-local",
    }]);
    expect(result.notes).toEqual([]);
  });
});
