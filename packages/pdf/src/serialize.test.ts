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
    expect(bundle.template).toContain('let indigo = rgb("#4B57A3")');
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
    expect(bundle.main.split("\n")[paragraph!.startLine - 1]).toContain('#par[#text("Nested")]');
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
