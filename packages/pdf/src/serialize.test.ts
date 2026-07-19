import { describe, expect, it } from "bun:test";
import type { ExportBlock } from "@atlcli/confluence";
import { preparePdfDocument } from "./prepare.js";
import { mapPdfDiagnostics, serializePdfDocument } from "./serialize.js";

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

    expect(bundle.main).toContain("#heading(level: 1");
    expect(bundle.main).toContain('#status-badge("DONE"');
    expect(bundle.main).toContain('#callout(kind: "info"');
    expect(bundle.main).toContain("#list(");
    expect(bundle.main).toContain("#list(marker: none, body-indent: 0pt,");
    expect(bundle.main).toContain("#task-item(true)[");
    expect(bundle.main).toContain('#text("Task")');
    expect(bundle.main).not.toContain("\\[x\\]");
    expect(bundle.main).toContain("table.header(");
    expect(bundle.main).toContain("#block(width: 100%)[\n#table(columns: (1fr,)");
    expect(bundle.main).toContain("#quote(block: true)");
    expect(bundle.main).toContain("#line(length: 100%");
    expect(bundle.sourceMap.length).toBeGreaterThanOrEqual(blocks.length);
    expect(bundle.template).toContain('font: "Source Serif 4"');
    expect(bundle.template).toContain('font: "Source Sans 3"');
    expect(bundle.template).toContain('font: "Source Code Pro"');
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
    expect(bundle.template).toContain('let indigo = rgb(settings.at("accent-color", default: "#4B57A3"))');
    expect(bundle.template).toContain('let cover-paper = rgb("#FCFBF8")');
    expect(bundle.template).toContain('text(font: "Source Serif 4", size: 31pt');
    expect(bundle.template).toContain("current-page > 1 and current-page < final-page");
    expect(bundle.template).toContain("[DOKUMENTENDE]");
    expect(bundle.template).toContain('link("https://atlcli.sh/")');
    expect(bundle.template).toContain("counter(page).final().first()");
    expect(bundle.main).toContain('exported-label: "July 16, 2026"');
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
    expect(bundle.main).toContain('#heading(level: 1, outlined: true)[#dense-token(available-width, [#text(fill: rgb("#FCFBF8"))');
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

  it("bounds resolved display names and accountId-only mentions without changing table prose", async () => {
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
      { type: "paragraph", content: [{ type: "mention", accountId: technicalId }] },
      { type: "table", rows: [{ cells: normalCells }] },
      { type: "table", rows: [{ cells: denseCells }] },
    ], {
      resolve: async () => { throw new Error("unused"); },
    });
    const bundle = serializePdfDocument(prepared, { metadata });
    const breakOpportunity = "\u200B";

    expect(bundle.main).toContain(`#text("@${technicalId}")`);
    expect(bundle.main).toContain(`#text("@${breakOpportunity}")#dense-token(available-width, [#text("team.alpha-beta_user?role=reader&scope:wiki/path")]`);
    expect(bundle.main).toContain(`team.${breakOpportunity}alph${breakOpportunity}a-`);
    expect(bundle.main).toContain(`read${breakOpportunity}er&${breakOpportunity}`);
    expect(bundle.main).toContain(`#text("@${breakOpportunity}")#dense-token(available-width, [#text("مرحبا:δοκιμή_用户")]`);
    expect(bundle.main).toContain(`مرحب${breakOpportunity}ا:${breakOpportunity}`);
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
    expect(bundle.notes.some((note) => note.code === "pdf-link-unresolved")).toBe(true);
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

  it("renders pageBreak/anchor/orientation with no semantic change to main.typ", async () => {
    const reference: ExportBlock[] = [
      { type: "heading", level: 2, content: [{ type: "text", text: "Section" }] },
      { type: "paragraph", content: [{ type: "text", text: "before" }] },
      { type: "paragraph", content: [{ type: "text", text: "inside" }] },
      { type: "paragraph", content: [{ type: "text", text: "after" }] },
    ];
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
    const refBundle = serializePdfDocument(await preparePdfDocument(reference, resolver), { metadata });
    const newBundle = serializePdfDocument(await preparePdfDocument(withNew, resolver), { metadata });

    // Semantic identity: content lines match once the comment markers are gone.
    expect(contentLines(newBundle.main)).toBe(contentLines(refBundle.main));
    // No new notes (no pdf-unknown-block, nothing) from the no-op blocks.
    expect(newBundle.notes).toEqual([]);
  });

  it("gives pageBreak and anchor their own zero-width sourceMap entries", async () => {
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
      // Zero-width: the wrapped value is empty, so start position == end position.
      expect(entry!.startLine).toBe(entry!.endLine);
      expect(entry!.startColumn).toBe(entry!.endColumn);
    }
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
    expect(bundle.main).toContain("#heading(level: 1, outlined: true)");
    // collectHeadingLabels recursed into the region → the internal link resolves
    // to the heading's <wide-section> label instead of degrading to plain text.
    expect(bundle.main).toContain("<wide-section>");
    expect(bundle.main).toContain("#link(<wide-section>)");
    expect(bundle.notes.some((n) => n.code === "pdf-link-unresolved")).toBe(false);
  });
});

describe("PDF settings threading into main.typ", () => {
  const emptyDoc = { blocks: [], assets: [], notes: [] };

  it("emits a defaulted settings dictionary when no settings are supplied", () => {
    const bundle = serializePdfDocument(emptyDoc, { metadata });
    expect(bundle.main).toContain("), settings: (");
    expect(bundle.main).toContain('page: "a4"');
    expect(bundle.main).toContain('orientation: "portrait"');
    expect(bundle.main).toContain("cover: true");
    expect(bundle.main).toContain("outline: true");
    expect(bundle.main).toContain('accent-color: "#4B57A3"');
    expect(bundle.main).not.toContain("header-text");
    expect(bundle.main).not.toContain("watermark:");
  });

  it("emits Letter + landscape and organization name", () => {
    const bundle = serializePdfDocument(emptyDoc, {
      metadata,
      settings: { page: "letter", orientation: "landscape", organizationName: "Acme" },
    });
    expect(bundle.main).toContain('page: "letter"');
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
