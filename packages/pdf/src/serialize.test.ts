import { describe, expect, it } from "bun:test";
import type { ExportBlock, ExportNode, ExportNote } from "@atlcli/confluence";
import { composeChapters } from "@atlcli/confluence";
import { BUILTIN_PDF_TEMPLATE_MANIFEST } from "./builtin-template.js";
import { preparePdfDocument } from "./prepare.js";
import { mapPdfDiagnostics, serializePdfDocument } from "./serialize.js";
import type { PreparedPdfBlock } from "./types.js";

const metadata = {
  title: "PDF # Guide",
  space: "DOCSY",
  version: 7,
  author: "Ada",
  exporter: "Grace",
  language: "en",
  region: "US",
  exportedAt: new Date("2026-07-16T12:00:00Z"),
};

function pngBytes(): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0, 1, 0, 0, 0, 1,
  ]);
}

describe("PDF preparation and serialization", () => {
  it("renders correlated ADF annotations as numbered ranges and a static comment appendix", async () => {
    const annotation = {
      id: "opaque-marker-not-rendered",
      annotationType: "inlineComment" as const,
      comment: {
        bodyText: "Please verify this value",
        status: "resolved" as const,
        replies: [{ bodyText: "Verified" }],
      },
    };
    const blocks: ExportBlock[] = [{
      type: "paragraph",
      content: [
        { type: "text", text: "First", annotations: [annotation] },
        { type: "text", text: " and second", annotations: [annotation] },
      ],
    }];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => {
        throw new Error("unused");
      },
    });
    const bundle = serializePdfDocument(prepared, { metadata });

    expect(bundle.main.split('#super[#text("[1]")]')).toHaveLength(2);
    expect(bundle.main).toContain("Comments");
    expect(bundle.main).toContain("Resolved — Please verify this value");
    expect(bundle.main).toContain("Reply:");
    expect(bundle.main).toContain("Verified");
    expect(bundle.main).not.toContain("opaque-marker-not-rendered");
  });

  it("promotes headings and serializes every common semantic block", async () => {
    const blocks: ExportBlock[] = [
      { type: "heading", level: 2, content: [{ type: "text", text: "Overview" }] },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Hello ", marks: ["bold"] },
          { type: "status", text: "DONE", color: "#00875A" },
          { type: "lineBreak" },
          { type: "mention", accountId: "a1", displayName: "Ada" },
        ],
      },
      { type: "callout", kind: "info", title: "Note", content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }] },
      { type: "list", ordered: false, items: [{ checked: true, content: [{ type: "paragraph", content: [{ type: "text", text: "Task" }] }] }] },
      {
        type: "list",
        ordered: false,
        listKind: "decision",
        items: [
          { kind: "decision", state: "DECIDED", content: [{ type: "paragraph", content: [{ type: "text", text: "Ship" }] }] },
          { kind: "decision", state: "PENDING", content: [{ type: "paragraph", content: [{ type: "text", text: "Review" }] }] },
        ],
      },
      { type: "table", rows: [{ cells: [{ header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Header" }] }] }] }] },
      { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "Quoted" }] }] },
      { type: "divider" },
    ];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => {
        throw new Error("unused");
      },
    });
    const bundle = serializePdfDocument(prepared, { metadata });

    expect(bundle.main).toContain('#atlcli-outline-title.update("Overview")#heading(level: 1');
    expect(bundle.main).toContain('#status-badge("DONE"');
    expect(bundle.main).toContain('#callout(kind: "info"');
    expect(bundle.main).toContain("#list(");
    expect(bundle.main).toContain("#list(marker: none, body-indent: 0pt,");
    expect(bundle.main).toContain("#task-item(true)[");
    expect(bundle.main).toContain('#text("Task")');
    expect(bundle.main).toContain('"◆"');
    expect(bundle.main).toContain('"◇"');
    expect(bundle.main).toContain('#text("[PENDING] ")');
    expect(bundle.main).toContain('#text("Ship")');
    expect(bundle.main).toContain('#text("Review")');
    expect(bundle.main).not.toContain("\\[x\\]");
    expect(bundle.main).toContain("table.header(");
    expect(bundle.main).toContain("#block(width: 100%)[\n#table(columns: (1fr,)");
    expect(bundle.main).toContain("#quote(block: true)");
    expect(bundle.main).toContain("#line(length: 100%");
    expect(bundle.sourceMap.length).toBeGreaterThanOrEqual(blocks.length);
    expect(bundle.template).toContain('font: ("Source Serif 4", "Noto Sans Symbols2")');
    expect(bundle.template).toContain('font: ("Source Sans 3", "Noto Sans Symbols2")');
    expect(bundle.template).toContain('font: ("Source Code Pro", "Noto Sans Symbols2")');
    expect(bundle.template).toContain(`[${String.fromCodePoint(0x2013)}]`);
    expect(bundle.template).toContain(`[${String.fromCodePoint(0x2022)}]`);
    expect(bundle.template).toContain(`[${String.fromCodePoint(0x25e6)}]`);
    expect(bundle.template).toContain(`"${String.fromCodePoint(0x2713)}"`);
    expect(bundle.template).toContain(`"${String.fromCodePoint(0x25a1)}"`);
    expect(bundle.template).not.toMatch(/\\u(?:2013|2022|25E6|2713|25A1)/i);
    expect(bundle.template).toContain("spacing: 8pt");
    expect(bundle.template).toContain('pattern = if values.len() == 1 { "1." }');
    expect(bundle.template).toContain("leading: 0.74em");
    expect(bundle.template).toContain("above: 28pt, below: 14pt");
    expect(bundle.template).toContain("above: 24pt, below: 12pt");
    expect(bundle.template).toContain("above: 18pt, below: 8pt");
    expect(bundle.template).toContain("sticky: true");
    expect(bundle.template).toContain("hyphenate: true");
    expect(bundle.template).toContain('linebreaks: "optimized"');
    expect(bundle.main).toContain('region: "US"');
    expect(bundle.main).toContain("inset: (x: 6pt, y: 7pt)");
    expect(bundle.template).toContain('let indigo = rgb(brand.at("accent", default: "#4B57A3"))');
    expect(bundle.template).toContain('let cover-paper = rgb("#FCFBF8")');
    expect(bundle.template).toContain('text(font: ("Source Serif 4", "Noto Sans Symbols2"), size: 31pt');
    expect(bundle.template).toContain("current-page > 1 and current-page < final-page");
    // Labels are now resolved at runtime; this en export threads the English
    // end-label through settings.labels (asserted on bundle.main below).
    expect(bundle.template).toContain("[#end-label]");
    expect(bundle.main).toContain('endOfDocument: "END OF DOCUMENT"');
    expect(bundle.template).toContain('link("https://atlcli.sh/")');
    expect(bundle.template).toContain("counter(page).final().first()");
    expect(bundle.main).toContain('exported-label: "July 16, 2026"');
  });

  it("renders localized date and semantic status chips while hiding template placeholders", async () => {
    const prepared = await preparePdfDocument([{
      type: "paragraph",
      content: [
        { type: "date", timestamp: "1709510400000", localId: "date-1" },
        { type: "status", text: "Ready", color: "purple" },
        { type: "status", text: "Keep Case", color: "neutral", style: "mixedCase" },
        { type: "placeholder", text: "editor-only", localId: "placeholder-1" },
      ],
    }], {
      resolve: async () => {
        throw new Error("unused");
      },
    });
    const bundle = serializePdfDocument(prepared, {
      metadata: { ...metadata, language: "de", region: "DE" },
    });

    expect(bundle.main).toContain('#text("4. März 2024")');
    expect(bundle.main).toContain('fill: rgb("#F4F5F7")');
    expect(bundle.main).toContain('#status-badge("READY", color: "#403294")');
    expect(bundle.main).toContain('#status-badge("Keep Case", color: "#42526E")');
    expect(bundle.main).not.toContain("editor-only");
    expect(bundle.main).not.toContain("1709510400000");
  });

  it("keeps neutral and purple statuses compatible with older template-v1 palettes", async () => {
    const legacyManifest = structuredClone(BUILTIN_PDF_TEMPLATE_MANIFEST);
    delete legacyManifest.design!.semanticPalettes.statuses.neutral;
    delete legacyManifest.design!.semanticPalettes.statuses.purple;
    const prepared = await preparePdfDocument([{
      type: "paragraph",
      content: [
        { type: "status", text: "Ready", color: "purple" },
        { type: "status", text: "Queued", color: "neutral" },
      ],
    }], {
      resolve: async () => {
        throw new Error("unused");
      },
    });

    const bundle = serializePdfDocument(prepared, {
      metadata,
      templateManifest: legacyManifest,
    });

    expect(bundle.main).toContain('#status-badge("READY", color: "#403294")');
    expect(bundle.main).toContain('#status-badge("QUEUED", color: "#42526E")');
  });

  it("preserves success and error callout kinds for the Typst semantic palette", async () => {
    const { main } = await toMain([
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
    ]);
    expect(main).toContain('#callout(kind: "success"');
    expect(main).toContain('#callout(kind: "error"');
  });

  it("renders portable custom-panel color and preferred icon text", async () => {
    const { main } = await toMain([{
      type: "callout",
      kind: "panel",
      localId: "panel-local",
      panelColor: "#123456",
      panelIcon: ":star:",
      panelIconId: "icon-id",
      panelIconText: "★",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Custom body" }] }],
    }]);

    expect(main).toContain(
      '#callout(kind: "panel", title: none, custom_color: rgb("#123456"), icon: [#text("★")])',
    );
    expect(main).not.toContain(":star:");
  });

  it("renders expand and nested-expand bodies open with a visible disclosure title", async () => {
    const { main } = await toMain([{
      type: "expand",
      nested: false,
      title: "Outer details",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Outer body" }] },
        {
          type: "expand",
          nested: true,
          title: "",
          content: [{
            type: "paragraph",
            content: [{ type: "text", text: "Nested body" }],
          }],
        },
      ],
    }]);

    expect(main.match(/#callout\(kind: "panel"/g)).toHaveLength(2);
    expect(main).toContain("[-] Outer details");
    expect(main).toContain("Outer body");
    expect(main).toContain("Nested body");
    expect(main).toContain("#block(inset: (left:");
  });

  it("preserves independent ordered-list starts at every nesting level", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "list",
        ordered: true,
        start: 3,
        items: [{
          content: [
            { type: "paragraph", content: [{ type: "text", text: "outer" }] },
            {
              type: "list",
              ordered: true,
              start: 8,
              items: [{ content: [{ type: "paragraph", content: [{ type: "text", text: "inner" }] }] }],
            },
          ],
        }],
      },
      {
        type: "list",
        ordered: true,
        start: 0,
        items: [{ content: [{ type: "paragraph", content: [{ type: "text", text: "zero" }] }] }],
      },
    ];
    const bundle = serializePdfDocument(
      await preparePdfDocument(blocks, {
        resolve: async () => {
          throw new Error("unused");
        },
      }),
      { metadata },
    );
    expect(bundle.main).toContain("#enum(start: 3,");
    expect(bundle.main).toContain("#enum(start: 8,");
    expect(bundle.main).toContain("#enum(start: 0,");
  });

  it("serializes nested bullet and task lists as child list blocks", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "list",
        ordered: false,
        items: [{
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Bullet parent" }] },
            {
              type: "list",
              ordered: false,
              items: [{
                content: [{ type: "paragraph", content: [{ type: "text", text: "Bullet child" }] }],
              }],
            },
          ],
        }],
      },
      {
        type: "list",
        ordered: false,
        listKind: "task",
        items: [{
          kind: "task",
          state: "TODO",
          checked: false,
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Task parent" }] },
            {
              type: "list",
              ordered: false,
              listKind: "task",
              items: [{
                kind: "task",
                state: "DONE",
                checked: true,
                content: [{ type: "paragraph", content: [{ type: "text", text: "Task child" }] }],
              }],
            },
          ],
        }],
      },
    ];
    const bundle = serializePdfDocument(
      await preparePdfDocument(blocks, {
        resolve: async () => {
          throw new Error("unused");
        },
      }),
      { metadata },
    );

    expect(bundle.main).toContain('#text("Bullet parent")');
    expect(bundle.main).toContain('#text("Bullet child")');
    expect(bundle.main).toContain("#task-item(false)[");
    expect(bundle.main).toContain('#text("Task parent")');
    expect(bundle.main).toContain("#task-item(true)[");
    expect(bundle.main).toContain('#text("Task child")');
    expect(bundle.sourceMap.map((entry) => entry.blockPath)).toEqual(expect.arrayContaining([
      "blocks[0].items[0].content[1]",
      "blocks[1].items[0].content[1]",
    ]));
  });

  it("renders logical alignment and bounded indentation on paragraphs and headings", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "paragraph",
        presentation: { alignment: "center", indentation: 2, fontSize: "small" },
        content: [{ type: "text", text: "Centered" }],
      },
      {
        type: "heading",
        level: 2,
        presentation: { alignment: "end", indentation: 6 },
        content: [{ type: "text", text: "Logical end" }],
      },
    ];
    const bundle = serializePdfDocument(
      await preparePdfDocument(blocks, {
        resolve: async () => {
          throw new Error("unused");
        },
      }),
      { metadata },
    );

    expect(bundle.main).toContain(
      '#block(inset: (left: 1.5em * 2))[#text(size: 9pt)[#align(center)[#par[#text("Centered")]]]]',
    );
    expect(bundle.main).toContain(
      "#block(inset: (left: 1.5em * 6))[#align(end)[#atlcli-outline-title.update",
    );
  });

  it("localizes the editorial cover and integrity-page export date", () => {
    const bundle = serializePdfDocument(
      { blocks: [], assets: [], notes: [] },
      {
        metadata: {
          ...metadata,
          language: "de",
          region: "DE",
        },
      }
    );

    expect(bundle.main).toContain('language: "de"');
    expect(bundle.main).toContain('region: "DE"');
    expect(bundle.main).toContain('exported-label: "16. Juli 2026"');
    // Document-facing labels resolve to the German locale bundle (spec 012).
    expect(bundle.main).toContain('contents: "Inhalt"');
    expect(bundle.main).toContain('endOfDocument: "DOKUMENTENDE"');
  });

  it("uses retained table proportions and equal-width fallback tracks", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "table",
        columnWidths: [100, 300],
        rows: [
          {
            cells: [
              { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
              { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] },
            ],
          },
        ],
      },
      {
        type: "table",
        rows: [
          {
            cells: [
              { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
              { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] },
            ],
          },
        ],
      },
    ];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => { throw new Error("unused"); },
    });
    const bundle = serializePdfDocument(prepared, { metadata });
    expect(bundle.main).toContain("columns: (0.25fr, 0.75fr,)");
    expect(bundle.main).toContain("columns: (1fr, 1fr,)");
  });

  it("renders ADF table width, alignment, numbered rows, and vertical cell alignment", async () => {
    const blocks: ExportBlock[] = [{
      type: "table",
      presentation: {
        width: 480,
        layout: "align-end",
        displayMode: "fixed",
        numberedColumn: true,
      },
      columnWidths: [200, 280],
      rows: [
        {
          cells: [
            {
              header: true,
              colspan: 1,
              rowspan: 1,
              verticalAlignment: "middle",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Name" }] }],
            },
            {
              header: true,
              colspan: 1,
              rowspan: 1,
              verticalAlignment: "bottom",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Value" }] }],
            },
          ],
        },
        {
          cells: [
            {
              header: false,
              colspan: 1,
              rowspan: 1,
              content: [{ type: "paragraph", content: [{ type: "text", text: "Ada" }] }],
            },
            {
              header: false,
              colspan: 1,
              rowspan: 1,
              content: [{ type: "paragraph", content: [{ type: "text", text: "42" }] }],
            },
          ],
        },
      ],
    }];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => { throw new Error("unused"); },
    });
    const table = prepared.blocks[0] as Extract<PreparedPdfBlock, { type: "table" }>;
    expect(table.rows.map((row) => row.cells[0].content)).toEqual([
      [{ type: "paragraph", content: [{ type: "text", text: "1" }] }],
      [{ type: "paragraph", content: [{ type: "text", text: "2" }] }],
    ]);

    const bundle = serializePdfDocument(prepared, { metadata });
    expect(bundle.main).toContain("columns: (0.090909fr, 0.378788fr, 0.530303fr,)");
    expect(bundle.main).toContain("align: horizon");
    expect(bundle.main).toContain("align: bottom");
    expect(bundle.main).toContain("align(end, block(width: 360pt)");
    expect(bundle.main).toContain('#text("1")');
    expect(bundle.main).toContain('#text("2")');
  });

  it("renders page layouts as semantic-free grids with authored proportions and vertical alignment", async () => {
    const blocks: ExportBlock[] = [{
      type: "layout",
      breakout: { mode: "full-width", width: 1800 },
      columns: [
        {
          width: 20,
          verticalAlignment: "middle",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Sidebar" }] }],
        },
        {
          width: 80,
          verticalAlignment: "bottom",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Main" }] }],
        },
      ],
    }];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => { throw new Error("unused"); },
    });
    expect(prepared.blocks[0]).toMatchObject({
      type: "layout",
      breakout: { mode: "full-width", width: 1800 },
      columns: [
        { width: 20, verticalAlignment: "middle" },
        { width: 80, verticalAlignment: "bottom" },
      ],
    });

    const bundle = serializePdfDocument(prepared, { metadata });
    expect(bundle.main).toContain("#grid(");
    expect(bundle.main).toContain("columns: (20fr, 80fr)");
    expect(bundle.main).toContain("column-gutter: 12pt");
    expect(bundle.main).toContain("inset: (left: 0pt, right: 0pt)");
    expect(bundle.main).toContain("grid.cell(align: horizon)");
    expect(bundle.main).toContain("grid.cell(align: bottom)");
    expect(bundle.main).toContain("Sidebar");
    expect(bundle.main).toContain("Main");
  });

  it("keeps a schema-valid zero-width layout column visible without emitting 0fr", async () => {
    const prepared = await preparePdfDocument([{
      type: "layout",
      columns: [
        {
          width: 100,
          content: [{ type: "paragraph", content: [{ type: "text", text: "Main" }] }],
        },
        {
          width: 0,
          content: [{ type: "paragraph", content: [{ type: "text", text: "Minimum" }] }],
        },
      ],
    }], {
      resolve: async () => { throw new Error("unused"); },
    });
    const bundle = serializePdfDocument(prepared, { metadata });
    expect(bundle.main).toContain("columns: (100fr, 0.1fr)");
    expect(bundle.main).not.toContain("columns: (100fr, 0fr)");
    expect(bundle.main).toContain("Minimum");
  });

  it("lays out merged cells on an explicit grid and keeps body section rows out of the repeated header", async () => {
    const paragraph = (text: string): ExportBlock[] => [{
      type: "paragraph",
      content: [{ type: "text", text }],
    }];
    const cell = (text: string, options: { header?: boolean; colspan?: number; rowspan?: number } = {}) => ({
      header: options.header ?? false,
      colspan: options.colspan ?? 1,
      rowspan: options.rowspan ?? 1,
      content: paragraph(text),
    });
    const prepared = await preparePdfDocument([{
      type: "table",
      rows: [
        { cells: [cell("One", { header: true }), cell("Two", { header: true }), cell("Three", { header: true }), cell("Four", { header: true })] },
        { cells: [cell("Vertical", { rowspan: 2 }), cell("Upper", { colspan: 2 }), cell("Tail")] },
        { cells: [cell("Lower", { colspan: 3 })] },
        {
          cells: [{
            ...cell("Synthetic section", { header: true, colspan: 4 }),
            backgroundColor: "#8994A9",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Synthetic section", marks: ["bold"], color: "#172B4D" },
                  { type: "text", text: " " },
                  { type: "mention", accountId: "synthetic", displayName: "Example User" },
                ],
              },
              {
                type: "heading",
                level: 3,
                content: [{ type: "text", text: "Nested heading", color: "#172B4D" }],
              },
            ],
          }],
        },
      ],
    }], {
      resolve: async () => { throw new Error("unused"); },
    });
    const bundle = serializePdfDocument(prepared, { metadata });

    expect(bundle.main).toContain("columns: (1fr, 1fr, 1fr, 1fr,)");
    expect(bundle.main).toContain("table.cell(x: 0, y: 1, rowspan: 2");
    expect(bundle.main).toContain("table.cell(x: 1, y: 2, colspan: 3");
    expect(bundle.main).toContain('table.cell(x: 0, y: 3, colspan: 4, fill: rgb("#8994A9")');
    expect(bundle.main).toContain('#set text(fill: rgb("#FCFBF8"))');
    expect(bundle.main).toContain('#text(fill: rgb("#FCFBF8"))[#strong[');
    expect(bundle.main).toContain('#text(fill: rgb("#FCFBF8"))[#text("@');
    expect(bundle.main).toContain('#atlcli-outline-title.update("Nested heading")#heading(level: 1, outlined: true)[#dense-token(available-width, [#text(fill: rgb("#FCFBF8"))');
    expect(bundle.main).not.toContain('#text(fill: rgb("#172B4D"))[#strong[');
    expect(bundle.notes).toContainEqual(expect.objectContaining({ code: "pdf-table-cell-contrast-low" }));
    expect(bundle.main.match(/table\.header\(/g)).toHaveLength(1);
  });

  it("configures table contrast colors through the Typst theme", async () => {
    const prepared = await preparePdfDocument([{
      type: "table",
      rows: [{
        cells: [{
          header: true,
          colspan: 1,
          rowspan: 1,
          backgroundColor: "#334455",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Section" }] }],
        }],
      }],
    }], {
      resolve: async () => { throw new Error("unused"); },
    });
    const bundle = serializePdfDocument(prepared, {
      metadata,
      theme: {
        colors: { paper: "#FFFDF5", ink: "#102040" },
        table: { coloredCellText: { onDark: "#FFF4D6", minimumContrast: 3 } },
      },
    });

    expect(bundle.template).toContain('let cover-paper = rgb("#FFFDF5")');
    expect(bundle.template).toContain('fill: rgb("#102040")');
    expect(bundle.main).toContain('#set text(fill: rgb("#FFF4D6"))');
    expect(bundle.notes).not.toContainEqual(expect.objectContaining({ code: "pdf-table-cell-contrast-low" }));
  });

  it("widens a dominant narrative column when source tracks are only equal defaults", async () => {
    const paragraph = (text: string): ExportBlock => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    });
    const cell = (text: string) => ({
      header: false,
      colspan: 1,
      rowspan: 1,
      content: [paragraph(text)],
    });
    const blocks: ExportBlock[] = [
      {
        type: "table",
        columnWidths: [100, 100, 100, 100],
        rows: [
          { cells: [cell("Architecture and platform readiness"), cell("R"), cell("A"), cell("C")] },
          { cells: [cell("Installation, configuration, and rollout"), cell("R"), cell("C"), cell("I")] },
        ],
      },
    ];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => { throw new Error("unused"); },
    });
    const bundle = serializePdfDocument(prepared, { metadata });

    expect(bundle.main).toContain("columns: (0.4fr, 0.2fr, 0.2fr, 0.2fr,)");
  });

  it("keeps balanced prose tables equal when no useful source widths exist", async () => {
    const cell = (text: string) => ({
      header: false,
      colspan: 1,
      rowspan: 1,
      content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }],
    });
    const blocks: ExportBlock[] = [
      {
        type: "table",
        rows: [
          { cells: [cell("Alpha description"), cell("Beta description"), cell("Gamma description")] },
          { cells: [cell("Alpha details"), cell("Beta details"), cell("Gamma details")] },
        ],
      },
    ];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => { throw new Error("unused"); },
    });
    const bundle = serializePdfDocument(prepared, { metadata });

    expect(bundle.main).toContain("columns: (1fr, 1fr, 1fr,)");
  });

  it("keeps normal insets below nine columns while making table inline layout width-aware", async () => {
    const cells = Array.from({ length: 8 }, (_, index) => ({
      header: false,
      colspan: 1,
      rowspan: 1,
      content: [
        {
          type: "paragraph" as const,
          content: index === 0
            ? [{ type: "status" as const, text: "IN REVIEW", color: "#FF8B00" }]
            : index === 1
              ? [{
                  type: "link" as const,
                  target: { kind: "external" as const, href: "https://example.com/releases/2026/details" },
                  content: [{ type: "text" as const, text: "https://example.com/releases/2026/details" }],
                }]
              : [{ type: "text" as const, text: `Column ${index + 1}` }],
        },
      ],
    }));
    const prepared = await preparePdfDocument([{ type: "table", rows: [{ cells }] }], {
      resolve: async () => { throw new Error("unused"); },
    });
    const bundle = serializePdfDocument(prepared, { metadata });

    expect(bundle.main).toContain('#dense-status-badge(available-width, "IN REVIEW", "IN RE\u200BVI\u200BEW"');
    expect(bundle.main).toContain('#dense-link(available-width, "https://example.com/releases/2026/details"');
    expect(bundle.main.match(/#table-par\(available-width =>/g)).toHaveLength(8);
    expect(bundle.main).toContain("inset: (x: 6pt, y: 7pt)");
  });

  it("uses width-aware status badges and raw URL labels from nine effective columns", async () => {
    const cells = Array.from({ length: 8 }, (_, index) => ({
      header: false,
      colspan: index === 0 ? 2 : 1,
      rowspan: 1,
      content: [
        {
          type: "paragraph" as const,
          content: index === 0
            ? [{ type: "status" as const, text: "DEPLOYMENT PENDING", color: "#FF8B00" }]
            : index === 1
              ? [{
                  type: "link" as const,
                  target: { kind: "external" as const, href: "https://example.com/releases/2026/details?view=full" },
                  content: [{ type: "text" as const, text: "https://example.com/releases/2026/details?view=full" }],
                }]
              : index === 2
                ? [{
                    type: "link" as const,
                    target: { kind: "external" as const, href: "https://example.com/reference" },
                    content: [{ type: "text" as const, text: "Release notes" }],
                  }]
                : [{ type: "text" as const, text: `Column ${index + 1}` }],
        },
      ],
    }));
    const prepared = await preparePdfDocument([{ type: "table", rows: [{ cells }] }], {
      resolve: async () => { throw new Error("unused"); },
    });
    const bundle = serializePdfDocument(prepared, { metadata });

    expect(bundle.main).toContain(
      '#dense-status-badge(available-width, "DEPLOYMENT PENDING", "DE\u200BPL\u200BOY\u200BME\u200BNT PE\u200BND\u200BIN\u200BG", color: "#FF8B00")'
    );
    expect(bundle.main).toContain(
      '#dense-link(available-width, "https://example.com/releases/2026/details?view=full", "https://example.com/releases/2026/details?view=full", "example.com/…", "exam\u200Bple.\u200Bcom")'
    );
    expect(bundle.main).toContain('#link("https://example.com/reference")[#dense-token(available-width, [#text("Release")]');
    expect(bundle.main.match(/#table-par\(available-width =>/g)).toHaveLength(8);
    expect(bundle.main).toContain("inset: (x: 2pt, y: 7pt)");
  });

  it("recalculates density for nested tables instead of inheriting the outer table mode", async () => {
    const nested: ExportBlock = {
      type: "table",
      rows: [{
        cells: [
          {
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [{ type: "paragraph", content: [{ type: "status", text: "NESTED", color: "#00875A" }] }],
          },
          {
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: "Two" }] }],
          },
        ],
      }],
    };
    const cells = Array.from({ length: 9 }, (_, index) => ({
      header: false,
      colspan: 1,
      rowspan: 1,
      content: index === 0
        ? [nested]
        : [{
            type: "paragraph" as const,
            content: index === 1
              ? [{ type: "status" as const, text: "OUTER", color: "#0052CC" }]
              : [{ type: "text" as const, text: `Column ${index + 1}` }],
          }],
    }));
    const prepared = await preparePdfDocument([{ type: "table", rows: [{ cells }] }], {
      resolve: async () => { throw new Error("unused"); },
    });
    const bundle = serializePdfDocument(prepared, { metadata });

    expect(bundle.main).toContain('#dense-status-badge(available-width, "NESTED", "NE\u200BST\u200BED", color: "#00875A")');
    expect(bundle.main).toContain('#dense-status-badge(available-width, "OUTER", "OU\u200BTE\u200BR", color: "#0052CC")');
    expect(bundle.main).toContain("columns: (1fr, 1fr,), inset: (x: 6pt, y: 7pt)");
    expect(bundle.main).toContain("columns: (1fr, 1fr, 1fr, 1fr, 1fr, 1fr, 1fr, 1fr, 1fr,), inset: (x: 2pt, y: 7pt)");
  });

  it("bounds mention labels without leaking account IDs or changing table prose", async () => {
    const paragraph = (content: ExportBlock & { type: "paragraph" }): ExportBlock => content;
    const cell = (content: Extract<ExportBlock, { type: "paragraph" }> ["content"]) => ({
      header: false,
      colspan: 1,
      rowspan: 1,
      content: [paragraph({ type: "paragraph", content })],
    });
    const technicalId = "team.alpha-beta_user?role=reader&scope:wiki/path";
    const unicodeId = "مرحبا:δοκιμή_用户";
    const longDisplayName = "Alexanderson Exampleton";
    const ordinaryProse = "Ordinary prose remains untouched.";
    const normalCells = Array.from({ length: 8 }, (_, index) =>
      index === 0
        ? cell([{ type: "mention", accountId: technicalId }])
        : cell([{ type: "text", text: `Normal ${index + 1}` }])
    );
    const denseCells = Array.from({ length: 9 }, (_, index) => {
      if (index === 0) return cell([{ type: "mention", accountId: technicalId }]);
      if (index === 1) return cell([{ type: "mention", accountId: unicodeId }]);
      if (index === 2) {
        return cell([{
          type: "mention",
          accountId: technicalId,
          displayName: longDisplayName,
        }]);
      }
      if (index === 3) return cell([{ type: "text", text: ordinaryProse }]);
      return cell([{ type: "text", text: `Dense ${index + 1}` }]);
    });
    const prepared = await preparePdfDocument([
      {
        type: "paragraph",
        content: [
          { type: "mention", accountId: technicalId },
          { type: "mention", accountId: "private-app-id", userType: "APP" },
        ],
      },
      { type: "table", rows: [{ cells: normalCells }] },
      { type: "table", rows: [{ cells: denseCells }] },
    ], {
      resolve: async () => { throw new Error("unused"); },
    });
    const bundle = serializePdfDocument(prepared, { metadata });
    const breakOpportunity = "\u200B";

    expect(bundle.main).not.toContain(technicalId);
    expect(bundle.main).not.toContain(unicodeId);
    expect(bundle.main).not.toContain("private-app-id");
    expect(bundle.main).toContain("Unknown user");
    expect(bundle.main).toContain("Unknown app");
    expect(bundle.main).toContain(`#dense-token(available-width, [#text("Alexanderson")], [#text("Alex${breakOpportunity}ande${breakOpportunity}rson")])`);
    expect(bundle.main).toContain(`#dense-token(available-width, [#text("Exampleton")], [#text("Exam${breakOpportunity}plet${breakOpportunity}on")])`);
    expect(bundle.main).toContain('#dense-token(available-width, [#text("Ordinary")], [#text("Ordi\u200Bnary")])');
    expect(bundle.main).toContain('[#text("untouched.")], [#text("unto\u200Buche\u200Bd.\u200B")]');
  });

  it("adds measured table fallbacks to dates, identifiers, domains, and single-token statuses", async () => {
    const cell = (content: Extract<ExportBlock, { type: "paragraph" }> ["content"]) => ({
      header: false,
      colspan: 1,
      rowspan: 1,
      content: [{ type: "paragraph" as const, content }],
    });
    const cells = Array.from({ length: 9 }, (_, index) => {
      if (index === 0) return cell([{ type: "text", text: "2031-12-31 23:59" }]);
      if (index === 1) return cell([{ type: "text", text: "portal.example.invalid" }]);
      if (index === 2) return cell([{ type: "text", text: "REF-1234567890" }]);
      if (index === 3) return cell([{ type: "status", text: "SYNCHRONIZED", color: "#0052CC" }]);
      return cell([{ type: "text", text: `Cell ${index + 1}` }]);
    });
    const prepared = await preparePdfDocument([{ type: "table", rows: [{ cells }] }], {
      resolve: async () => { throw new Error("unused"); },
    });
    const bundle = serializePdfDocument(prepared, { metadata });

    expect(bundle.main).toContain('[#text("2031-12-31")], [#text("2031-\u200B12-\u200B31")]');
    expect(bundle.main).toContain('[#text("23:59")], [#text("23:\u200B59")]');
    expect(bundle.main).toContain('[#text("portal.example.invalid")], [#text("port\u200Bal.\u200Bexam\u200Bple.\u200Binva\u200Blid")]');
    expect(bundle.main).toContain('[#text("REF-1234567890")], [#text("REF-\u200B1234\u200B5678\u200B90")]');
    expect(bundle.main).toContain('"SYNCHRONIZED", "SY\u200BNC\u200BHR\u200BON\u200BIZ\u200BED"');
  });

  it("maps semantic status colors and keeps the narrow badge fallback inside its track", async () => {
    const cell = (content: Extract<ExportBlock, { type: "paragraph" }> ["content"], header = false) => ({
      header,
      colspan: 1,
      rowspan: 1,
      content: [{ type: "paragraph" as const, content }],
    });
    const prepared = await preparePdfDocument([
      { type: "paragraph", content: [{ type: "status", text: "ALERT", color: "red" }] },
      {
        type: "table",
        columnWidths: [1.2, 0.45, 2.1, 3.5, 1.2, 0.7],
        rows: [
          { cells: ["Recorded", "State", "Summary", "Notes", "Owner", "Length"].map((text) => cell([{ type: "text", text }], true)) },
          {
            cells: [
              cell([{ type: "text", text: "2032-02-29" }]),
              cell([{ type: "status", text: "PASS", color: "green" }]),
              cell([{ type: "text", text: "Synthetic review" }]),
              cell([{ type: "text", text: "Width-aware badge regression" }]),
              cell([{ type: "text", text: "Team" }]),
              cell([{ type: "text", text: "4 min" }]),
            ],
          },
        ],
      },
    ], {
      resolve: async () => { throw new Error("unused"); },
    });
    const bundle = serializePdfDocument(prepared, { metadata });

    expect(bundle.main).toContain('#status-badge("ALERT", color: "#DE350B")');
    expect(bundle.main).toContain('#dense-status-badge(available-width, "PASS", "PA\u200BSS", color: "#00875A")');
    expect(bundle.template).toContain("width: available-width - 2pt");
    expect(bundle.template).toContain("#breakable-label");
  });

  it("deduplicates image bytes and reports missing alt text", async () => {
    const blocks: ExportBlock[] = [
      { type: "image", source: { kind: "attachment", filename: "same.png" } },
      { type: "image", source: { kind: "attachment", filename: "same.png" } },
    ];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => ({
        bytes: pngBytes(),
        mediaType: "image/png",
        filename: "same.png",
      }),
    });
    const bundle = serializePdfDocument(prepared, { metadata });
    expect(bundle.assets).toHaveLength(1);
    expect(bundle.notes.filter((note) => note.code === "pdf-image-alt-fallback")).toHaveLength(2);
  });

  it("keeps images and diagrams in document flow instead of floating past headings", () => {
    const bundle = serializePdfDocument(
      {
        blocks: [
          { type: "heading", level: 2, content: [{ type: "text", text: "Diagram" }] },
          {
            type: "diagram",
            assetPath: "assets/diagram.svg",
            alt: "A flowchart",
            source: "flowchart LR\nA --> B",
          },
          {
            type: "image",
            assetPath: "assets/image.png",
            alt: "A screenshot",
            fallbackLabel: "image.png",
          },
        ],
        assets: [],
        notes: [],
      },
      { metadata }
    );

    expect(bundle.main).not.toContain("placement: auto");
    expect(bundle.main.indexOf("#heading(")).toBeLessThan(
      bundle.main.indexOf('image("assets/diagram.svg"')
    );
    expect(bundle.main.indexOf('image("assets/diagram.svg"')).toBeLessThan(
      bundle.main.indexOf('image("assets/image.png"')
    );
  });

  it("renders unsafe links as text and reports them", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "paragraph",
        content: [{ type: "link", target: { kind: "external", href: "javascript:alert(1)" }, content: [{ type: "text", text: "Nope" }] }],
      },
    ];
    const prepared = await preparePdfDocument(blocks, { resolve: async () => { throw new Error("unused"); } });
    const bundle = serializePdfDocument(prepared, { metadata });
    expect(bundle.main).toContain("Nope");
    expect(bundle.main).not.toContain("javascript:");
    // spec 011: a BLOCKED scheme is a security decision, so it reports the
    // specific `unsafe-link-skipped` warning rather than the generic
    // informational "could not be represented in PDF" note.
    expect(bundle.notes.some((note) => note.code === "unsafe-link-skipped")).toBe(true);
    expect(bundle.notes.find((note) => note.code === "unsafe-link-skipped")?.level).toBe("warning");
  });

  it("styles external links with the document accent and underline without changing internal links", async () => {
    const blocks: ExportBlock[] = [
      { type: "anchor", name: "chapter" },
      {
        type: "paragraph",
        content: [
          {
            type: "link",
            target: { kind: "external", href: "https://example.com/docs" },
            content: [{ type: "text", text: "External" }],
          },
          { type: "text", text: " / " },
          {
            type: "link",
            target: { kind: "anchor", anchor: "chapter" },
            content: [{ type: "text", text: "Internal" }],
          },
        ],
      },
    ];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => {
        throw new Error("unused");
      },
    });
    const bundle = serializePdfDocument(prepared, {
      metadata,
      settings: { accentColor: "#0052CC" },
    });

    expect(bundle.main).toContain(
      '#text(fill: rgb("#0052CC"))[#underline[#link("https://example.com/docs")[#text("External")]]]'
    );
    expect(bundle.main).toContain('#link(<chapter>)[#text("Internal")]');
    expect(bundle.main).not.toContain("#underline[#link(<chapter>)");
  });

  it("uses exact safe ADF href fallbacks for page and attachment links", async () => {
    const blocks: ExportBlock[] = [{
      type: "paragraph",
      content: [
        {
          type: "link",
          target: {
            kind: "page",
            contentTitle: "Remote page",
            contentId: "123",
            href: "https://example.invalid/wiki/pages/123/Remote",
          },
          content: [{ type: "text", text: "page" }],
        },
        { type: "text", text: " / " },
        {
          type: "link",
          target: {
            kind: "attachment",
            filename: "guide.pdf",
            href: "https://example.invalid/wiki/download/attachments/123/guide.pdf",
          },
          content: [{ type: "text", text: "file" }],
        },
      ],
    }];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => {
        throw new Error("unused");
      },
    });
    const bundle = serializePdfDocument(prepared, { metadata });

    expect(bundle.main).toContain(
      '#link("https://example.invalid/wiki/pages/123/Remote")[#text("page")]',
    );
    expect(bundle.main).toContain(
      '#link("https://example.invalid/wiki/download/attachments/123/guide.pdf")[#text("file")]',
    );
    expect(bundle.notes.some((note) => note.code === "pdf-link-unresolved")).toBe(false);
  });

  it("renders inline, block, and embed Smart Cards as clickable static projections", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "paragraph",
        content: [{
          type: "smartCard",
          card: {
            appearance: "inline",
            source: "data",
            url: "https://example.invalid/inline",
            target: { kind: "external", href: "https://example.invalid/inline" },
            title: "Inline card",
            data: { name: "Inline card", provider: { name: "Example" } },
          },
        }],
      },
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
          appearance: "embed",
          source: "url",
          url: "https://example.invalid/embed",
          target: { kind: "external", href: "https://example.invalid/embed" },
          layout: "full-width",
          width: 80,
          originalHeight: 720,
          originalWidth: 1280,
        },
      },
    ];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => {
        throw new Error("unused");
      },
    });
    const bundle = serializePdfDocument(prepared, { metadata });

    expect(bundle.main).toContain(
      '#link("https://example.invalid/inline")[#box(fill: rgb("#E9F2FF")',
    );
    expect(bundle.main).toContain(
      '#link("https://example.invalid/block")[#text("https://example.invalid/block")]',
    );
    expect(bundle.main).toContain(
      'Embedded content: ',
    );
    expect(bundle.main).toContain(
      '#link("https://example.invalid/embed")[#text("https://example.invalid/embed")]',
    );
    expect(bundle.main.match(/stroke: rgb\\?\("#B3BAC5"/gu)).toHaveLength(2);
  });

  it("preserves arbitrary inline background colors as breakable Typst highlights", async () => {
    const prepared = await preparePdfDocument(
      [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Green highlight", backgroundColor: "#BAF3DB" },
            { type: "text", text: " " },
            {
              type: "text",
              text: "Purple highlight",
              marks: ["bold"],
              color: "#403294",
              backgroundColor: "#EED7FC",
            },
          ],
        },
      ],
      {
        resolve: async () => {
          throw new Error("unused");
        },
      }
    );
    const bundle = serializePdfDocument(prepared, { metadata });
    expect(bundle.main).toContain(
      '#highlight(fill: rgb("#BAF3DB"))[#text("Green highlight")]'
    );
    expect(bundle.main).toContain(
      '#highlight(fill: rgb("#EED7FC"))[#text(fill: rgb("#403294"))[#strong[#text("Purple highlight")]]]'
    );
  });

  it("renders exact inline-code tokens through the themed non-block raw chip", async () => {
    const prepared = await preparePdfDocument(
      [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "before " },
            { type: "text", text: "CONFIG_TOKEN_A", marks: ["code"] },
            { type: "text", text: " after" },
          ],
        },
      ],
      {
        resolve: async () => {
          throw new Error("unused");
        },
      }
    );
    const bundle = serializePdfDocument(prepared, { metadata });
    expect(bundle.main).toContain('#raw("CONFIG_TOKEN_A")');
    expect(bundle.main).not.toContain("CONFIG TOKEN A");
    expect(bundle.template).toContain("show raw.where(block: false): it => box(");
    expect(bundle.template).toContain('fill: rgb("#F4F5F7")');
    expect(bundle.template).toContain("inset: (x: 0.2em, y: 0.06em)");
  });

  it("maps generated main.typ lines to the most specific nested block", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "callout",
        kind: "info",
        content: [
          {
            type: "table",
            rows: [
              {
                cells: [
                  {
                    header: false,
                    colspan: 1,
                    rowspan: 1,
                    content: [
                      { type: "paragraph", content: [{ type: "text", text: "Nested" }] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => {
        throw new Error("unused");
      },
    });
    const bundle = serializePdfDocument(prepared, { metadata });
    const paragraph = bundle.sourceMap.find(
      (entry) => entry.blockPath === "blocks[0].content[0].rows[0].cells[0].content[0]"
    );
    expect(paragraph).toBeDefined();
    expect(bundle.main.split("\n")[paragraph!.startLine - 1]).toContain('#table-par(available-width => [#par[#dense-token(available-width, [#text("Nested")]');
    expect(
      mapPdfDiagnostics(
        [{ severity: "error", message: "fixture", path: "main.typ", line: paragraph!.startLine }],
        bundle.sourceMap
      )[0]?.blockPath
    ).toBe(paragraph!.blockPath);
  });

  it("maps same-line diagnostics to the containing table cell by column", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "table",
        rows: [
          {
            cells: [
              {
                header: true,
                colspan: 1,
                rowspan: 1,
                content: [{ type: "paragraph", content: [{ type: "text", text: "First" }] }],
              },
              {
                header: true,
                colspan: 1,
                rowspan: 1,
                content: [{ type: "paragraph", content: [{ type: "text", text: "Second" }] }],
              },
            ],
          },
        ],
      },
    ];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => {
        throw new Error("unused");
      },
    });
    const bundle = serializePdfDocument(prepared, { metadata });
    const second = bundle.sourceMap.find(
      (entry) => entry.blockPath === "blocks[0].rows[0].cells[1].content[0]"
    );
    expect(second).toBeDefined();

    expect(
      mapPdfDiagnostics(
        [
          {
            severity: "error",
            message: "fixture",
            path: "main.typ",
            line: second!.startLine,
            column: second!.startColumn + 1,
          },
        ],
        bundle.sourceMap
      )[0]?.blockPath
    ).toBe(second!.blockPath);
  });
});

describe("PDF serialize — new ExportBlock variants (T0 no-op renderings)", () => {
  const strip = (main: string): string =>
    main.replace(/\/\* atlcli:(?:start|end):[^*]+ \*\//g, "");

  // "Semantic" = the non-empty content lines are identical. Byte-identity is
  // unreachable by design: writeMapped wraps EVERY block (including the empty
  // pageBreak/anchor) in path-bearing comment markers, and array-index shifts
  // change sibling paths even when content is unchanged (see the Engines note).
  const contentLines = (main: string): string =>
    strip(main)
      .split("\n")
      .filter((line) => line.trim() !== "")
      .join("\n");

  it("renders pageBreak as a weak pagebreak, anchor as a label, orientation bare", async () => {
    const withNew: ExportBlock[] = [
      { type: "heading", level: 2, content: [{ type: "text", text: "Section" }] },
      { type: "paragraph", content: [{ type: "text", text: "before" }] },
      { type: "pageBreak" },
      { type: "anchor", name: "bm" },
      {
        type: "orientation",
        landscape: true,
        content: [{ type: "paragraph", content: [{ type: "text", text: "inside" }] }],
      },
      { type: "paragraph", content: [{ type: "text", text: "after" }] },
    ];
    const resolver = { resolve: async () => { throw new Error("unused"); } };
    const newBundle = serializePdfDocument(await preparePdfDocument(withNew, resolver), { metadata });

    // Real renderings (spec 002).
    expect(newBundle.main).toContain("#pagebreak(weak: true)");
    expect(newBundle.main).toContain("#box[]<bm>");
    // orientation still serializes its child transparently.
    expect(newBundle.main).toContain('#text("inside")');
    // No spurious notes from the new blocks.
    expect(newBundle.notes).toEqual([]);
    void contentLines; // retained helper for other cases
  });

  it("gives pageBreak and anchor their own sourceMap entries", async () => {
    const blocks: ExportBlock[] = [
      { type: "paragraph", content: [{ type: "text", text: "x" }] },
      { type: "pageBreak" },
      { type: "anchor", name: "bm" },
    ];
    const bundle = serializePdfDocument(
      await preparePdfDocument(blocks, { resolve: async () => { throw new Error("unused"); } }),
      { metadata }
    );
    for (const blockType of ["pageBreak", "anchor"] as const) {
      const entry = bundle.sourceMap.find((e) => e.blockType === blockType);
      expect(entry).toBeDefined();
    }
  });

  it("sanitizes raw anchor names into legal Typst labels and resolves links to them", async () => {
    // Regression: a Confluence anchor macro named "Table of Contents" must not
    // reach the Typst source as `<Table of Contents>` — the real compiler
    // rejects that as an unclosed label, failing the whole export.
    const blocks: ExportBlock[] = [
      { type: "anchor", name: "Table of Contents" },
      { type: "paragraph", content: [{ type: "text", text: "body" }] },
      {
        type: "paragraph",
        content: [
          {
            type: "link",
            target: { kind: "anchor", anchor: "Table of Contents" },
            content: [{ type: "text", text: "jump" }],
          },
        ],
      },
    ];
    const bundle = serializePdfDocument(
      await preparePdfDocument(blocks, { resolve: async () => { throw new Error("unused"); } }),
      { metadata }
    );
    // Sanitized label emitted; the raw (illegal) form never appears.
    expect(bundle.main).toContain("#box[]<table-of-contents>");
    expect(bundle.main).not.toContain("<Table of Contents>");
    // The link resolves to the SAME sanitized label — not degraded to text.
    expect(bundle.main).toContain("#link(<table-of-contents>)");
    expect(bundle.notes.some((n) => n.code === "pdf-link-unresolved")).toBe(false);
  });

  it("dedupes distinct anchor names that sanitize identically (duplicate labels are a compile error)", async () => {
    const blocks: ExportBlock[] = [
      { type: "anchor", name: "A B" },
      { type: "anchor", name: "A_B" },
      // A heading whose text slug ALSO collides with the anchors' sanitized
      // form — its slug label must stay untouched and the anchors must dodge it.
      { type: "heading", level: 2, content: [{ type: "text", text: "A b" }] },
    ];
    const bundle = serializePdfDocument(
      await preparePdfDocument(blocks, { resolve: async () => { throw new Error("unused"); } }),
      { metadata }
    );
    const labels = [...bundle.main.matchAll(/<([a-z0-9-]+)>/g)].map((m) => m[1]);
    // Every emitted label is unique — Typst rejects duplicate labels.
    expect(new Set(labels).size).toBe(labels.length);
    // The heading keeps its plain slug; both anchors got suffixed variants.
    expect(labels).toContain("a-b");
    const anchorLabels = [...bundle.main.matchAll(/#box\[\]<([a-z0-9-]+)>/g)].map((m) => m[1]);
    expect(anchorLabels).toHaveLength(2);
    for (const label of anchorLabels) {
      expect(label).toMatch(/^a-b-[0-9a-z]+$/);
    }
    expect(anchorLabels[0]).not.toBe(anchorLabels[1]);
  });

  it("sees a heading nested inside an orientation region (promotion + label link)", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "orientation",
        landscape: true,
        content: [{ type: "heading", level: 2, content: [{ type: "text", text: "Wide Section" }] }],
      },
      {
        type: "paragraph",
        content: [
          { type: "link", target: { kind: "anchor", anchor: "Wide Section" }, content: [{ type: "text", text: "jump" }] },
        ],
      },
    ];
    const bundle = serializePdfDocument(
      await preparePdfDocument(blocks, { resolve: async () => { throw new Error("unused"); } }),
      { metadata }
    );
    // minHeadingLevel recursed into the region → the lone H2 promotes to level 1.
    expect(bundle.main).toContain('#atlcli-outline-title.update("Wide Section")#heading(level: 1, outlined: true)');
    // collectHeadingLabels recursed into the region → the internal link resolves
    // to the heading's <wide-section> label instead of degrading to plain text.
    expect(bundle.main).toContain("<wide-section>");
    expect(bundle.main).toContain("#link(<wide-section>)");
    expect(bundle.notes.some((n) => n.code === "pdf-link-unresolved")).toBe(false);
  });

  it("a composed multi-page document serializes with promotion offset 0 (chapter levels preserved)", async () => {
    // Root (effectiveDepth 0 → chapter level 1) + child (effectiveDepth 1 →
    // chapter level 2). Since the composed document already starts at level 1,
    // the shared computeHeadingOffset yields 0 and the level-2 chapter is NOT
    // wrongly promoted back to level 1.
    const nodes: ExportNode[] = [
      {
        kind: "page",
        pageId: "1",
        title: "Root",
        depth: 0,
        effectiveDepth: 0,
        parentId: null,
        position: 0,
        blocks: [],
        notes: [],
        meta: { labels: [], spaceKey: "DOC" },
      },
      {
        kind: "page",
        pageId: "2",
        title: "Child",
        depth: 1,
        effectiveDepth: 1,
        parentId: "1",
        position: 0,
        // Body starts at H3 — per-page promotion happens during composition, not
        // in the engine, so the engine sees a document already normalized to L1.
        blocks: [{ type: "heading", level: 3, content: [{ type: "text", text: "Body" }] }],
        notes: [],
        meta: { labels: [], spaceKey: "DOC" },
      },
    ];
    const { blocks } = composeChapters(nodes, { chapterBreak: "none" });
    const bundle = serializePdfDocument(
      await preparePdfDocument(blocks, { resolve: async () => { throw new Error("unused"); } }),
      { metadata }
    );
    // Offset 0: the level-1 Root chapter stays level 1, the level-2 Child chapter
    // stays level 2 (a nonzero offset would collapse them).
    expect(bundle.main).toContain('#atlcli-outline-title.update("Root")#heading(level: 1, outlined: true)[#text("Root")]');
    expect(bundle.main).toContain('#atlcli-outline-title.update("Child")#heading(level: 2, outlined: true)[#text("Child")]');
  });

  it("emits chapter labels, a resolved cross-page #link, and a chapter #pagebreak (T1.3 engine golden)", async () => {
    // The PDF half of the T1.3 engine golden — the same fixture shape the DOCX
    // engine golden uses, rendering into the SAME sanitized `page-<id>` ids.
    const nodes: ExportNode[] = [
      {
        kind: "page",
        pageId: "100",
        title: "Alpha",
        depth: 0,
        effectiveDepth: 0,
        parentId: null,
        position: 0,
        blocks: [
          { type: "heading", level: 2, content: [{ type: "text", text: "Overview" }] },
          {
            type: "paragraph",
            content: [
              {
                type: "link",
                target: { kind: "page", contentId: "300", contentTitle: "Gamma" },
                content: [{ type: "text", text: "see Gamma" }],
              },
            ],
          },
        ],
        notes: [],
        meta: { labels: [], spaceKey: "DOC" },
      },
      {
        kind: "page",
        pageId: "300",
        title: "Gamma",
        depth: 1,
        effectiveDepth: 1,
        parentId: "100",
        position: 0,
        blocks: [{ type: "heading", level: 2, content: [{ type: "text", text: "Gamma detail" }] }],
        notes: [],
        meta: { labels: [], spaceKey: "DOC" },
      },
    ];
    const { blocks } = composeChapters(nodes);
    const resolver = { resolve: async () => { throw new Error("unused"); } };
    const bundle = serializePdfDocument(await preparePdfDocument(blocks, resolver), { metadata });

    // Chapter-start labels for both pages.
    expect(bundle.main).toContain("<page-100>");
    expect(bundle.main).toContain("<page-300>");
    // The cross-page link resolves to Gamma's chapter label (#link(<page-300>)),
    // NOT degraded to plain text.
    expect(bundle.main).toContain("#link(<page-300>)");
    expect(bundle.notes.some((n) => n.code === "pdf-link-unresolved")).toBe(false);
    // A weak page break separates the two chapters.
    expect(bundle.main).toContain("#pagebreak(weak: true)");

    // Determinism: a second run is byte-equal.
    const again = serializePdfDocument(await preparePdfDocument(composeChapters(nodes).blocks, resolver), { metadata });
    expect(again.main).toBe(bundle.main);
  });
});

describe("PDF settings threading into main.typ", () => {
  const emptyDoc = { blocks: [], assets: [], notes: [] };

  it("emits a defaulted settings dictionary when no settings are supplied", () => {
    const bundle = serializePdfDocument(emptyDoc, { metadata });
    expect(bundle.main).toContain("), settings: (");
    expect(bundle.main).toContain('accent: "#4B57A3"');
    expect(bundle.main).toContain('size: "a4"');
    expect(bundle.main).toContain('orientation: "portrait"');
    expect(bundle.main).toContain("cover: (enabled: true)");
    expect(bundle.main).toContain("outline: (enabled: true, depth: 3)");
    expect(bundle.main).not.toContain("header-text");
    expect(bundle.main).not.toContain("watermark:");
  });

  it("emits Letter + landscape and organization name", () => {
    const bundle = serializePdfDocument(emptyDoc, {
      metadata,
      settings: { page: "letter", orientation: "landscape", organizationName: "Acme" },
    });
    expect(bundle.main).toContain('size: "letter"');
    expect(bundle.main).toContain('orientation: "landscape"');
    expect(bundle.main).toContain('organization-name: "Acme"');
  });

  it("typstString-escapes every free-text setting so injection stays literal", () => {
    const bundle = serializePdfDocument(emptyDoc, {
      metadata,
      settings: {
        headerText: 'H" #{x}',
        footerText: "line\\end",
        organizationName: 'Acme" #{sys.exit()}',
        logo: { bytes: pngBytes(), mediaType: "image/png", alt: 'alt" #{evil}' },
      },
    });
    expect(bundle.main).toContain('header-text: "H\\" #{x}"');
    expect(bundle.main).toContain('footer-text: "line\\\\end"');
    expect(bundle.main).toContain('organization-name: "Acme\\" #{sys.exit()}"');
    expect(bundle.main).toContain('logo-alt: "alt\\" #{evil}"');
  });

  it("threads a validated logo as a virtual asset and emits its escaped path", () => {
    const bundle = serializePdfDocument(emptyDoc, {
      metadata,
      settings: { logo: { bytes: pngBytes(), mediaType: "image/png", alt: 'Acme "Corp"' } },
    });
    expect(bundle.main).toContain('logo: "assets/atlcli-logo.png"');
    expect(bundle.main).toContain('logo-alt: "Acme \\"Corp\\""');
    const asset = bundle.assets.find((entry) => entry.path === "assets/atlcli-logo.png");
    expect(asset?.mediaType).toBe("image/png");
    expect(asset?.bytes).toEqual(pngBytes());
  });

  it("serializes a watermark with defaults filled", () => {
    const bundle = serializePdfDocument(emptyDoc, {
      metadata,
      settings: { watermark: { text: "DRAFT" } },
    });
    expect(bundle.main).toContain("watermark: (");
    expect(bundle.main).toContain('text: "DRAFT"');
    expect(bundle.main).toContain('color: "#DE350B"');
    expect(bundle.main).toContain("opacity: 0.08");
    expect(bundle.main).toContain("angle: -54");
    expect(bundle.main).toContain("size: 96");
  });
});

// ===========================================================================
// spec 003 — page breaks, orientation, captions, table hardening
// ===========================================================================
import { classifyTableLayout } from "./serialize.js";

/** Prepare + serialize a block list to Typst source (no assets fetched). */
async function toMain(blocks: ExportBlock[]): Promise<{ main: string; notes: ExportNote[] }> {
  const prepared = await preparePdfDocument(blocks, {
    resolve: async () => {
      throw new Error("no assets");
    },
  });
  const bundle = serializePdfDocument(prepared, { metadata });
  return { main: bundle.main, notes: bundle.notes };
}

describe("serialize — C5 pageBreak", () => {
  it("emits a weak pagebreak at body level", async () => {
    const { main } = await toMain([{ type: "pageBreak" }]);
    expect(main).toContain("#pagebreak(weak: true)");
  });

  it("suppresses a pagebreak inside a table cell with a note", async () => {
    const { main, notes } = await toMain([
      {
        type: "table",
        rows: [{ cells: [{ header: false, colspan: 1, rowspan: 1, content: [{ type: "pageBreak" }] }] }],
      },
    ]);
    expect(main).not.toContain("#pagebreak");
    expect(notes.map((n) => n.code)).toContain("pagebreak-suppressed-in-container");
  });

  it("suppresses a pagebreak inside a callout with a note", async () => {
    const { main, notes } = await toMain([
      { type: "callout", kind: "info", content: [{ type: "pageBreak" }] },
    ]);
    expect(main).not.toContain("#pagebreak");
    expect(notes.map((n) => n.code)).toContain("pagebreak-suppressed-in-container");
  });
});

describe("serialize — C6 orientation", () => {
  const region = (landscape: boolean): ExportBlock => ({
    type: "orientation",
    landscape,
    content: [{ type: "paragraph", content: [{ type: "text", text: "wide" }] }],
  });

  it("sets flipped: true for a landscape region", async () => {
    const { main } = await toMain([region(true)]);
    expect(main).toContain("#set page(flipped: true)");
    expect(main).toContain("wide");
  });

  it("sets flipped: false for a portrait region (flips back, not only ever landscape)", async () => {
    const { main } = await toMain([region(false)]);
    expect(main).toContain("#set page(flipped: false)");
  });

  it("suppresses the set page inside a table cell with a note (children kept)", async () => {
    const { main, notes } = await toMain([
      {
        type: "table",
        rows: [{ cells: [{ header: false, colspan: 1, rowspan: 1, content: [region(true)] }] }],
      },
    ]);
    expect(main).not.toContain("#set page(flipped");
    expect(main).toContain("wide");
    expect(notes.map((n) => n.code)).toContain("orientation-suppressed-in-container");
  });

  it("suppresses the set page inside a callout with a note", async () => {
    const { main, notes } = await toMain([{ type: "callout", kind: "note", content: [region(true)] }]);
    expect(main).not.toContain("#set page(flipped");
    expect(notes.map((n) => n.code)).toContain("orientation-suppressed-in-container");
  });
});

describe("serialize — C3 captions", () => {
  it("wraps a captioned image in a numbered figure with the normalized kind", async () => {
    const { main } = await toMain([
      {
        type: "image",
        source: { kind: "external", url: "https://x.test/a.png" },
        caption: { kind: "figure", content: [{ type: "text", text: "Arch" }] },
      },
    ]);
    // External image is not fetched here → asset-failure fallback figure.
    expect(main).toContain("#figure(");
    expect(main).toContain("caption: [");
    expect(main).toContain("kind: image");
    expect(main).toContain("Arch");
  });

  it("a captioned image whose asset is missing still emits a numbered figure fallback", async () => {
    const { main, notes } = await toMain([
      {
        type: "image",
        source: { kind: "external", url: "https://x.test/broken.png" },
        caption: { kind: "figure", content: [{ type: "text", text: "Broken" }] },
      },
    ]);
    expect(main).toContain("#figure(emph[");
    expect(main).not.toContain("#figure(#");
    expect(main).toContain("Image unavailable");
    expect(main).toContain("caption: [");
    expect(notes.map((n) => n.code)).toContain("image-embed-failed");
  });

  it("keeps an unresolved ADF media caption attached to its visible placeholder", async () => {
    const { main, notes } = await toMain([{
      type: "mediaFallback",
      label: "media-1",
      media: { mediaType: "file", id: "media-1" },
      alt: "Architecture",
      caption: {
        kind: "figure",
        localId: "",
        content: [{ type: "text", text: "System overview" }],
      },
    }]);

    expect(main).toContain("#figure(emph[");
    expect(main).toContain("Media unavailable");
    expect(main).toContain("System overview");
    expect(main).toContain("kind: image");
    expect(notes).toEqual([]);
  });

  it("renders ADF media geometry, borders, groups, inline chips, and typed files", async () => {
    const prepared = await preparePdfDocument([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "before" },
          {
            type: "media",
            media: {
              mediaType: "image",
              id: "inline-1",
              filename: "inline.png",
            },
            source: { kind: "attachment", filename: "inline.png" },
            alt: "Inline architecture",
            width: 40,
            height: 20,
            border: { color: "#0052CC", size: 1 },
            link: { target: { kind: "external", href: "https://example.invalid/inline" } },
          },
          { type: "text", text: "after" },
        ],
      },
      {
        type: "image",
        source: { kind: "attachment", filename: "architecture.png" },
        alt: "Architecture",
        mediaPresentation: {
          layout: "wrap-right",
          width: 40,
          widthType: "percentage",
        },
        mediaGroup: { index: 0, size: 2 },
        border: { color: "#091E4224", size: 2 },
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "Text wrapped beside the authored media." }],
      },
      {
        type: "mediaFallback",
        label: "runbook.pdf",
        media: {
          mediaType: "file",
          filename: "runbook.pdf",
          attachmentMediaType: "application/pdf",
        },
        mediaGroup: { index: 1, size: 2 },
      },
    ], {
      resolve: async () => ({
        bytes: pngBytes(),
        mediaType: "image/png",
        filename: "architecture.png",
      }),
    });
    const bundle = serializePdfDocument(prepared, { metadata });

    const before = bundle.main.indexOf("#text(\"before\")");
    const inline = bundle.main.indexOf("#box(baseline: 0pt");
    const after = bundle.main.indexOf("#text(\"after\")");
    expect(before).toBeLessThan(inline);
    expect(inline).toBeLessThan(after);
    expect(bundle.main).toContain("#image(\"assets/inline-image-");
    expect(bundle.main).toContain("width: 30pt, height: 15pt");
    expect(bundle.main).not.toContain("[Inline architecture]");
    expect(bundle.main).toContain('#link("https://example.invalid/inline")');
    expect(bundle.main).toContain('stroke: 1pt + rgb("#0052CC")');
    expect(bundle.main).toContain("width: 100%");
    expect(bundle.main).toContain(
      '#grid(columns: (1fr, 40%), column-gutter: 8pt, [/* atlcli:start:blocks[2] */',
    );
    expect(bundle.main).not.toContain("float: true");
    expect(bundle.main).toContain('stroke: 2pt + rgb("#091E42")');
    expect(bundle.main).toContain('fill: rgb("#F7F8F9")');
    expect(bundle.main).toContain("[Attachment: runbook.pdf (application/pdf)]");
    expect(bundle.notes).toEqual([]);
  });

  it("preserves dataConsumer provenance through preparation without publishing source ids", async () => {
    const base: ExportBlock = {
      type: "mediaFallback",
      label: "runbook.pdf",
      media: { mediaType: "file", filename: "runbook.pdf" },
    };
    const withProvenance: ExportBlock = {
      ...base,
      media: {
        ...base.media,
        dataConsumers: [
          { sources: ["consumer-source-a", ""] },
          { sources: ["consumer-source-b"] },
        ],
      },
    };
    const plain = await preparePdfDocument([base], {
      resolve: async () => { throw new Error("unused"); },
    });
    const retained = await preparePdfDocument([withProvenance], {
      resolve: async () => { throw new Error("unused"); },
    });
    expect(retained.blocks[0]).toMatchObject({
      type: "mediaFallback",
      media: {
        dataConsumers: [
          { sources: ["consumer-source-a", ""] },
          { sources: ["consumer-source-b"] },
        ],
      },
    });

    const plainBundle = serializePdfDocument(plain, { metadata });
    const retainedBundle = serializePdfDocument(retained, { metadata });
    expect(retainedBundle.main).toBe(plainBundle.main);
    expect(retainedBundle.main).not.toContain("consumer-source");
    expect(retainedBundle.notes).toEqual([]);
  });

  it("preserves fragment provenance without publishing ids or inventing anchors", async () => {
    const baseExtension: Extract<ExportBlock, { type: "unknown" }> = {
      type: "unknown",
      macroName: "fragmented-extension",
      body: [{
        type: "paragraph",
        content: [{ type: "text", text: "Visible extension body" }],
      }],
    };
    const baseTable: Extract<ExportBlock, { type: "table" }> = {
      type: "table",
      rows: [{
        cells: [{
          header: false,
          colspan: 1,
          rowspan: 1,
          content: [{
            type: "paragraph",
            content: [{ type: "text", text: "Visible table cell" }],
          }],
        }],
      }],
    };
    const plain = await preparePdfDocument([baseExtension, baseTable], {
      resolve: async () => { throw new Error("unused"); },
    });
    const retained = await preparePdfDocument([
      {
        ...baseExtension,
        fragments: [{ localId: "opaque-extension-fragment", name: "extension-fragment" }],
      },
      {
        ...baseTable,
        fragments: [{ localId: "opaque-table-fragment", name: "" }],
      },
    ], {
      resolve: async () => { throw new Error("unused"); },
    });
    expect(retained.blocks).toMatchObject([
      {
        type: "unknown",
        fragments: [{ localId: "opaque-extension-fragment", name: "extension-fragment" }],
      },
      {
        type: "table",
        fragments: [{ localId: "opaque-table-fragment", name: "" }],
      },
    ]);

    const plainBundle = serializePdfDocument(plain, { metadata });
    const retainedBundle = serializePdfDocument(retained, { metadata });
    expect(retainedBundle.main).toBe(plainBundle.main);
    expect(retainedBundle.main).toContain("Visible extension body");
    expect(retainedBundle.main).toContain('#text("Visible")');
    expect(retainedBundle.main).toContain('#text("cell")');
    expect(retainedBundle.main).not.toContain("opaque-");
    expect(retainedBundle.main).not.toContain("extension-fragment");
    expect(retainedBundle.notes).toEqual(plainBundle.notes);
  });

  it("prepares and renders typed unsupported ADF fallback without publishing attributes", async () => {
    const prepared = await preparePdfDocument([{
      type: "unknown",
      macroName: "unsupportedBlock",
      unsupportedAdf: {
        nodeType: "unsupportedBlock",
        sourceRepresentation: "storage",
        attributes: [{ name: "originalValue", value: "opaque-source-value" }],
      },
      body: [{
        type: "paragraph",
        content: [{
          type: "text",
          text: "Visible unsupported body",
          unsupportedAdf: [{
            nodeType: "unsupportedInline",
            sourceRepresentation: "storage",
            attributes: [{ name: "identity", value: "opaque-inline-value" }],
          }],
        }],
      }],
    }], {
      resolve: async () => { throw new Error("unused"); },
    });
    expect(prepared.blocks[0]).toMatchObject({
      type: "unknown",
      unsupportedAdf: {
        nodeType: "unsupportedBlock",
        sourceRepresentation: "storage",
      },
    });

    const bundle = serializePdfDocument(prepared, { metadata });
    expect(bundle.main).toContain("Unsupported ADF block: unsupportedBlock");
    expect(bundle.main).toContain("Visible unsupported body");
    expect(bundle.main).not.toContain("opaque-source-value");
    expect(bundle.main).not.toContain("opaque-inline-value");
    expect(bundle.notes).toEqual([]);
  });

  it("renders a bounded ADF extension fallback with its rich body", async () => {
    const prepared = await preparePdfDocument([{
      type: "unknown",
      macroName: "forge-widget",
      adfExtension: {
        extensionType: "com.atlassian.ecosystem",
        extensionKey: "forge-widget",
        localId: "opaque-forge-local-id",
      },
      params: [{ name: "private-mode", text: "opaque-parameter-value" }],
      body: [{
        type: "paragraph",
        content: [{ type: "text", text: "Visible extension body" }],
      }],
    }], {
      resolve: async () => { throw new Error("unused"); },
    });

    const bundle = serializePdfDocument(prepared, { metadata });
    expect(bundle.main).toContain("Extension: forge-widget");
    expect(bundle.main).toContain("Visible extension body");
    expect(bundle.main).not.toContain("opaque-forge-local-id");
    expect(bundle.main).not.toContain("opaque-parameter-value");
    expect(bundle.main).not.toContain("macro not rendered");
    expect(bundle.notes).toEqual([]);
  });

  it("renders ordered Stage-0 extension frames without publishing opaque provenance", async () => {
    const prepared = await preparePdfDocument([{
      type: "unknown",
      macroName: "multi-frame",
      adfExtension: {
        extensionType: "com.example.stage0",
        extensionKey: "multi-frame",
        localId: "opaque-multi-local",
      },
      extensionFrames: [
        {
          fragments: [{ localId: "opaque-fragment", name: "opaque-name" }],
          dataConsumers: [{ sources: ["opaque-consumer"] }],
          content: [{
            type: "paragraph",
            content: [{ type: "text", text: "Visible frame one" }],
          }],
        },
        {
          content: [{
            type: "paragraph",
            content: [{ type: "text", text: "Visible frame two" }],
          }],
        },
      ],
    }], {
      resolve: async () => { throw new Error("unused"); },
    });

    const bundle = serializePdfDocument(prepared, { metadata });
    expect(bundle.main).toContain("Extension: multi-frame");
    expect(bundle.main).toContain("Frame 1");
    expect(bundle.main).toContain("Visible frame one");
    expect(bundle.main).toContain("Frame 2");
    expect(bundle.main).toContain("Visible frame two");
    expect(bundle.main).not.toContain("opaque-multi-local");
    expect(bundle.main).not.toContain("opaque-fragment");
    expect(bundle.main).not.toContain("opaque-consumer");
    expect(bundle.notes).toEqual([]);
  });

  it("preserves synced-content provenance without publishing opaque identity", async () => {
    const snapshot: ExportBlock = {
      type: "callout",
      kind: "panel",
      title: "Synced content snapshot",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: "Embedded synced snapshot" }],
      }],
      syncedContent: {
        resourceId: "opaque-snapshot-resource",
        localId: "opaque-snapshot-local",
        projection: "embedded-snapshot",
        breakout: { mode: "wide", width: 720 },
      },
    };
    const reference: ExportBlock = {
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
        resourceId: "opaque-reference-resource",
        localId: "opaque-reference-local",
        projection: "unresolved-reference",
        breakout: { mode: "full-width" },
      },
    };
    const withoutProvenance = [snapshot, reference].map((block) => {
      const { syncedContent: _syncedContent, ...plain } = block;
      return plain;
    });
    const plain = await preparePdfDocument(withoutProvenance, {
      resolve: async () => { throw new Error("unused"); },
    });
    const retained = await preparePdfDocument([snapshot, reference], {
      resolve: async () => { throw new Error("unused"); },
    });
    expect(retained.blocks).toMatchObject([snapshot, reference]);

    const plainBundle = serializePdfDocument(plain, { metadata });
    const retainedBundle = serializePdfDocument(retained, { metadata });
    expect(retainedBundle.main).toBe(plainBundle.main);
    expect(retainedBundle.main).toContain("Synced content snapshot");
    expect(retainedBundle.main).toContain("Embedded synced snapshot");
    expect(retainedBundle.main).toContain("Synced content is unavailable in this static export.");
    expect(retainedBundle.main).not.toContain("opaque-");
    expect(retainedBundle.notes).toEqual([]);
  });

  it("preserves root code and expand breakout intent without changing page-bounded output", async () => {
    const baseCode: Extract<ExportBlock, { type: "codeBlock" }> = {
      type: "codeBlock",
      code: "const wide = true;",
      hideLineNumbers: false,
    };
    const baseExpand: Extract<ExportBlock, { type: "expand" }> = {
      type: "expand",
      nested: false,
      title: "Wide details",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: "Expanded body" }],
      }],
    };
    const base: ExportBlock[] = [baseCode, baseExpand];
    const withBreakout: ExportBlock[] = [
      { ...baseCode, breakout: { mode: "wide", width: 880 } },
      { ...baseExpand, breakout: { mode: "full-width", width: 1024 } },
    ];
    const plain = await preparePdfDocument(base, {
      resolve: async () => { throw new Error("unused"); },
    });
    const retained = await preparePdfDocument(withBreakout, {
      resolve: async () => { throw new Error("unused"); },
    });
    expect(retained.blocks).toMatchObject(withBreakout);

    const plainBundle = serializePdfDocument(plain, { metadata });
    const retainedBundle = serializePdfDocument(retained, { metadata });
    expect(retainedBundle.main).toBe(plainBundle.main);
    expect(retainedBundle.main).toContain("const wide = true;");
    expect(retainedBundle.main).toContain("Wide details");
    expect(retainedBundle.main).toContain("Expanded body");
    expect(retainedBundle.main).not.toContain("1024");
    expect(retainedBundle.notes).toEqual([]);
  });

  it("wraps ADF media output in its exact safe link", async () => {
    const { main, notes } = await toMain([{
      type: "mediaFallback",
      label: "media-1",
      media: { mediaType: "file", id: "media-1" },
      link: {
        target: { kind: "external", href: "https://example.invalid/media" },
        adfAttributes: {
          title: "Open media",
          id: "link-id",
          collection: "content-id",
          occurrenceKey: "occurrence-1",
        },
      },
    }]);

    expect(main).toContain(
      '#link("https://example.invalid/media")[#par[#emph[',
    );
    expect(notes).toEqual([]);
  });

  it("wraps a captioned table in a figure with kind table (declared kind wins)", async () => {
    const { main } = await toMain([
      {
        type: "table",
        rows: [{ cells: [{ header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }] }] }],
        caption: { kind: "table", content: [{ type: "text", text: "Matrix" }] },
      },
    ]);
    expect(main).toContain("#figure(block(width: 100%)[");
    expect(main).not.toContain("#figure(#");
    expect(main).toContain("kind: table");
    expect(main).toContain("Matrix");
  });

  it("only captioned code becomes a figure; caption-less code stays a raw block", async () => {
    const withCaption = await toMain([
      { type: "codeBlock", language: "ts", code: "const x = 1", caption: { kind: "code", content: [{ type: "text", text: "L1" }] } },
    ]);
    expect(withCaption.main).toContain("#figure({ show raw.line:");
    expect(withCaption.main).not.toContain("#figure(#");
    expect(withCaption.main).toContain("kind: raw");

    const plain = await toMain([{ type: "codeBlock", language: "ts", code: "const x = 1" }]);
    expect(plain.main).not.toContain("#figure({ show raw.line:");
    expect(plain.main).toContain("#{ show raw.line:");
  });

  it("renders code line numbers from the authored ordinal and reports bounded no-wrap", async () => {
    const { main, notes } = await toMain([{
      type: "codeBlock",
      language: "text",
      code: "first\nsecond",
      hideLineNumbers: false,
      firstLineNumber: 7,
      wrap: false,
      localId: "code-local",
      uniqueId: "code-unique",
    }]);

    expect(main).toContain("columns: (auto, 1fr)");
    expect(main).toContain("box(width: 100%)[#line.body]");
    expect(main).toContain("line.number + 6");
    expect(main).toContain('fill: rgb("#6B778C")');
    expect(main).toContain('raw("first\\nsecond", lang: "text", block: true)');
    expect(notes).toContainEqual(expect.objectContaining({
      code: "code-nowrap-page-bounded",
      source: { blockPath: "blocks[0]" },
    }));
  });

  it("renders a legacy code title above the complete body and reports static expansion", async () => {
    const { main, notes } = await toMain([{
      type: "codeBlock",
      language: "text",
      code: "deploy();",
      title: "Deployment [safe]",
      initiallyCollapsed: true,
      hideLineNumbers: true,
    }]);

    expect(main).toContain('fill: rgb("#F4F5F7")');
    expect(main).toContain('#strong[#text("Deployment [safe]")]');
    expect(main).toContain('raw("deploy();", lang: "text", block: true)');
    expect(main.indexOf("Deployment")).toBeLessThan(main.indexOf("deploy();"));
    expect(notes).toContainEqual(expect.objectContaining({
      level: "info",
      code: "code-collapse-static",
      source: { blockPath: "blocks[0]" },
    }));
  });
});

describe("serialize — T1.6 table header repeat", () => {
  it("emits table.header(repeat: true, …)", async () => {
    const { main } = await toMain([
      {
        type: "table",
        rows: [
          { cells: [{ header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "H" }] }] }] },
          { cells: [{ header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] }] },
        ],
      },
    ]);
    expect(main).toContain("table.header(repeat: true,");
  });
});

describe("classifyTableLayout (standalone)", () => {
  it("normal: short tokens fit comfortably", () => {
    expect(classifyTableLayout({ columnCount: 3, longestAtomicToken: 5, availableWidth: 470 })).toBe("normal");
  });

  it("dense: >= 9 columns crosses the dense boundary", () => {
    expect(classifyTableLayout({ columnCount: 9, longestAtomicToken: 4, availableWidth: 470 })).toBe("dense");
  });

  it("scaled: a token overflows at normal size but fits scaled down", () => {
    // 12 narrow columns, a moderately long unbreakable token.
    const result = classifyTableLayout({ columnCount: 12, longestAtomicToken: 9, availableWidth: 470 });
    expect(result).toBe("scaled");
  });

  it("overflow-warned: a token cannot fit even at the minimum size", () => {
    const result = classifyTableLayout({ columnCount: 20, longestAtomicToken: 40, availableWidth: 470 });
    expect(result).toBe("overflow-warned");
  });

  it("a landscape width de-escalates the same table", () => {
    const portrait = classifyTableLayout({ columnCount: 12, longestAtomicToken: 9, availableWidth: 470 });
    const landscape = classifyTableLayout({ columnCount: 12, longestAtomicToken: 9, availableWidth: 717 });
    expect(portrait).toBe("scaled");
    // The wider landscape area fits the same token without scaling.
    expect(landscape === "normal" || landscape === "dense").toBe(true);
  });

  it("respects explicit unequal column widths (narrowest track drives escalation)", () => {
    // One very narrow track amid wide ones forces escalation despite few columns.
    const result = classifyTableLayout({
      columnCount: 3,
      sourceWidths: [10, 10, 1],
      longestAtomicToken: 12,
      availableWidth: 470,
    });
    expect(result === "scaled" || result === "overflow-warned").toBe(true);
  });

  it("scaled/overflow tiers emit their note codes end to end", async () => {
    const wideRow = (n: number) =>
      Array.from({ length: n }, () => ({
        header: false,
        colspan: 1,
        rowspan: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: "SUPERCALIFRAGILISTIC" }] }] as ExportBlock[],
      }));
    const { notes } = await toMain([
      { type: "table", rows: [{ cells: wideRow(20) }] },
    ]);
    expect(notes.some((n) => n.code === "table-overflow-warned" || n.code === "table-text-scaled")).toBe(true);
  });
});
