import { describe, expect, it } from "bun:test";
import { storageToBlocks, type ExportBlock, type InlineNode } from "@atlcli/confluence/browser";
import { serializeBlocks, serializeInline } from "../../utils/docx/serialize.js";
import { parseStyleNames } from "../../utils/docx/ooxml.js";
import { headingStyle, stylesXml } from "./fixtures.js";

const noStyles = new Map<string, string>();

describe("serializeInline", () => {
  it("emits marks and colors as run properties", () => {
    const xml = serializeInline([
      { type: "text", text: "bold", marks: ["bold"] },
      { type: "text", text: "red", color: "#ff0000" },
      { type: "lineBreak" },
    ]);
    expect(xml).toContain("<w:b/>");
    expect(xml).toContain('<w:color w:val="FF0000"/>');
    expect(xml).toContain("<w:br/>");
  });

  it("renders an external link as a HYPERLINK field", () => {
    const xml = serializeInline([
      { type: "link", target: { kind: "external", href: "https://x.com" }, content: [{ type: "text", text: "site" }] },
    ]);
    expect(xml).toContain("HYPERLINK");
    expect(xml).toContain("https://x.com");
  });

  it("renders a mention with @ and no literal accountId leak when named", () => {
    const xml = serializeInline([{ type: "mention", accountId: "u1", displayName: "Jo" }]);
    expect(xml).toContain("@Jo");
  });

  it("round-trips named HTML entities from storage into real UTF-8 <w:t> text", () => {
    // Regression: DOCX export previously showed literal `drei &uuml;berlappende`
    // because the storage walker only decoded a dozen hand-listed entities.
    const { blocks } = storageToBlocks(
      "<h2>Gr&ouml;&szlig;e</h2><p>drei &uuml;berlappende &auml;pfel &mdash; caf&eacute;</p>"
    );
    const xml = serializeInline((blocks[1] as { content: InlineNode[] }).content);
    expect(xml).toContain("drei überlappende äpfel — café");
    // No surviving named-entity literals leak into the OOXML text run.
    expect(xml).not.toMatch(/&[a-zA-Z][a-zA-Z0-9]*;/);
  });
});

describe("serializeBlocks — heading style mapping", () => {
  // Heading-level PROMOTION (match Scroll Office): the shallowest heading in the
  // document maps to Heading 1. This lone-H2 document has minLevel 2, so the H2
  // is promoted to EFFECTIVE level 1 — the style resolves against "… Heading 1".
  const heading: ExportBlock[] = [{ type: "heading", level: 2, content: [{ type: "text", text: "H2" }] }];

  it("uses Scroll Heading N when present", async () => {
    const styles = parseStyleNames(stylesXml(headingStyle("ScrollHeading1Id", "Scroll Heading 1")));
    const { xml } = await serializeBlocks(heading, { styleNames: styles });
    expect(xml).toContain('<w:pStyle w:val="ScrollHeading1Id"/>');
  });

  it("falls back to Heading N", async () => {
    const styles = parseStyleNames(stylesXml(headingStyle("Heading1", "Heading 1")));
    const { xml } = await serializeBlocks(heading, { styleNames: styles });
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
  });

  it("falls back to the builtin HeadingN id when the template has neither", async () => {
    const { xml } = await serializeBlocks(heading, { styleNames: noStyles });
    // Promoted: lone H2 → builtin Heading1 (not Heading2).
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
  });
});

describe("serializeBlocks — heading outline levels (TOC \\o robustness)", () => {
  // A `TOC \o "1-3"` field collects paragraphs by OUTLINE LEVEL, not style name,
  // so headings must carry <w:outlineLvl> to populate a TOC on ANY template —
  // even one whose only heading style is a custom name (spec 004 E2E finding).
  it("stamps a 0-based outline level (level 1 → 0, level 3 → 2) alongside the style id", async () => {
    const blocks: ExportBlock[] = [
      { type: "heading", level: 1, content: [{ type: "text", text: "H1" }] },
      { type: "heading", level: 3, content: [{ type: "text", text: "H3" }] },
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });
    expect(xml).toContain('<w:outlineLvl w:val="0"/>');
    expect(xml).toContain('<w:outlineLvl w:val="2"/>');
    // Outline level is ADDITIONAL to the mapped style id (visual look preserved).
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(xml).toContain('<w:pStyle w:val="Heading3"/>');
    // Schema order: pStyle must precede outlineLvl inside <w:pPr>.
    expect(xml.indexOf("<w:pStyle")).toBeLessThan(xml.indexOf("<w:outlineLvl"));
  });

  it("clamps outline levels to the OOXML 0–8 range (defensive: an out-of-range level → 8)", async () => {
    // Heading levels are typed 1–6, but the serializer defensively clamps to the
    // OOXML 0–8 outline range; cast an out-of-range level to exercise the guard.
    // An H1 anchor keeps the promotion offset 0 so the effective level stays 12
    // (a lone deep heading would otherwise promote to level 1).
    const h1: ExportBlock = { type: "heading", level: 1, content: [{ type: "text", text: "top" }] };
    const deep = { type: "heading", level: 12, content: [{ type: "text", text: "deep" }] } as unknown as ExportBlock;
    const { xml } = await serializeBlocks([h1, deep], { styleNames: noStyles });
    expect(xml).toContain('<w:outlineLvl w:val="8"/>');
  });

  it("carries outline levels even when the template's only heading style is a custom name", async () => {
    // Template defines `Heading1TOC` (custom) — no `Scroll Heading N`/`Heading N`.
    // The style id falls back to the builtin, but the outline level is what a
    // `TOC \o "1-3"` collects, so the heading still populates the TOC.
    const styles = parseStyleNames(stylesXml(headingStyle("Heading1TOC", "Heading1TOC")));
    const blocks: ExportBlock[] = [
      { type: "heading", level: 1, content: [{ type: "text", text: "Custom" }] },
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: styles });
    expect(xml).toContain('<w:outlineLvl w:val="0"/>');
  });
});

describe("serializeBlocks — heading-level promotion (match Scroll Office)", () => {
  // Scroll promotes the SHALLOWEST heading in the document to Heading 1 (the
  // page title is the implicit H1). offset = minLevel - 1; effective level =
  // block.level - offset. Applied to BOTH the style id and the outline level.

  it("promotes the RFP shape [H2, H3, H2, H3] so H2→level 1, H3→level 2", async () => {
    const blocks: ExportBlock[] = [
      { type: "heading", level: 2, content: [{ type: "text", text: "A" }] },
      { type: "heading", level: 3, content: [{ type: "text", text: "A.1" }] },
      { type: "heading", level: 2, content: [{ type: "text", text: "B" }] },
      { type: "heading", level: 3, content: [{ type: "text", text: "B.1" }] },
    ];
    // Template with named "Heading 1"/"Heading 2" styles (the RFP template's
    // German "Überschrift N" resolve via their builtin ids the same way): the
    // promoted level must select the level-1 style for an H2, not the level-2 one.
    const styles = parseStyleNames(
      stylesXml(headingStyle("Heading1", "Heading 1") + headingStyle("Heading2", "Heading 2"))
    );
    const { xml } = await serializeBlocks(blocks, { styleNames: styles });
    // H2 → effective level 1: Heading 1 style + outlineLvl "0".
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(xml).toContain('<w:outlineLvl w:val="0"/>');
    // H3 → effective level 2: Heading 2 style + outlineLvl "1".
    expect(xml).toContain('<w:pStyle w:val="Heading2"/>');
    expect(xml).toContain('<w:outlineLvl w:val="1"/>');
    // The top TOC level is populated — never the empty-top-level bug.
    expect(xml).not.toContain('<w:outlineLvl w:val="2"/>');
  });

  it("leaves [H1, H2, H3] unchanged (minLevel 1, offset 0)", async () => {
    const blocks: ExportBlock[] = [
      { type: "heading", level: 1, content: [{ type: "text", text: "H1" }] },
      { type: "heading", level: 2, content: [{ type: "text", text: "H2" }] },
      { type: "heading", level: 3, content: [{ type: "text", text: "H3" }] },
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(xml).toContain('<w:outlineLvl w:val="0"/>');
    expect(xml).toContain('<w:pStyle w:val="Heading2"/>');
    expect(xml).toContain('<w:outlineLvl w:val="1"/>');
    expect(xml).toContain('<w:pStyle w:val="Heading3"/>');
    expect(xml).toContain('<w:outlineLvl w:val="2"/>');
  });

  it("promotes [H3, H4] so the shallowest (H3) becomes level 1", async () => {
    const blocks: ExportBlock[] = [
      { type: "heading", level: 3, content: [{ type: "text", text: "H3" }] },
      { type: "heading", level: 4, content: [{ type: "text", text: "H4" }] },
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });
    // H3 → level 1 (outlineLvl 0), H4 → level 2 (outlineLvl 1).
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(xml).toContain('<w:outlineLvl w:val="0"/>');
    expect(xml).toContain('<w:pStyle w:val="Heading2"/>');
    expect(xml).toContain('<w:outlineLvl w:val="1"/>');
  });

  it("is a no-op on a document with no headings", async () => {
    const blocks: ExportBlock[] = [
      { type: "paragraph", content: [{ type: "text", text: "just prose" }] },
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });
    expect(xml).toContain("just prose");
    expect(xml).not.toContain("<w:outlineLvl");
    expect(xml).not.toContain("<w:pStyle");
  });
});

describe("serializeBlocks — callouts, code, tables, images", () => {
  it("renders a callout as a shaded 1x1 table with an accent border", async () => {
    const blocks: ExportBlock[] = [
      { type: "callout", kind: "warning", title: "Careful", content: [{ type: "paragraph", content: [{ type: "text", text: "danger" }] }] },
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain('w:fill="FFFAE6"'); // warning fill
    expect(xml).toContain('<w:left w:val="single" w:sz="24" w:color="FFAB00"/>'); // accent
    expect(xml).toContain("Careful");
    expect(xml).toContain("danger");
  });

  it("colors code via Shiki (multiple colored runs)", async () => {
    const blocks: ExportBlock[] = [
      { type: "codeBlock", language: "ts", code: 'const x: number = 1;\nconsole.log(x);' },
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });
    expect(xml).toContain('<w:pStyle w:val="AtlcliCode"/>');
    expect(xml).toContain("Consolas");
    // At least one syntax color was applied.
    expect(/<w:color w:val="[0-9A-F]{6}"\/>/.test(xml)).toBe(true);
  });

  it("falls back to uncolored code for an unknown language", async () => {
    const blocks: ExportBlock[] = [{ type: "codeBlock", language: "not-a-lang", code: "x = 1" }];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });
    expect(xml).toContain('<w:pStyle w:val="AtlcliCode"/>');
    expect(xml).toContain("x = 1");
  });

  it("builds a table with colspan (gridSpan)", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "table",
        rows: [
          { cells: [{ header: true, colspan: 2, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Span" }] }] }] },
          {
            cells: [
              { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
              { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] },
            ],
          },
        ],
      },
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });
    expect(xml).toContain('<w:gridSpan w:val="2"/>');
    expect(xml).toContain("Span");
  });

  it("handles rowspan via vMerge restart + continue", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "table",
        rows: [
          {
            cells: [
              { header: false, colspan: 1, rowspan: 2, content: [{ type: "paragraph", content: [{ type: "text", text: "tall" }] }] },
              { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "r1" }] }] },
            ],
          },
          { cells: [{ header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "r2" }] }] }] },
        ],
      },
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });
    expect(xml).toContain('<w:vMerge w:val="restart"/>');
    expect(xml).toContain('<w:vMerge w:val="continue"/>');
  });

  it("skips images (deferred) with a report note and no drawing", async () => {
    const blocks: ExportBlock[] = [
      { type: "image", source: { kind: "attachment", filename: "diagram.png" }, alt: "d" },
    ];
    const { xml, notes } = await serializeBlocks(blocks, { styleNames: noStyles });
    expect(xml).not.toContain("<w:drawing");
    expect(xml).not.toContain("blip");
    const note = notes.find((n) => n.code === "image-skipped");
    expect(note).toBeDefined();
    expect(note!.message).toContain("diagram.png");
  });

  it("emits every cell of a ragged rowspan table (never drops a carried column)", async () => {
    // Regression (#1): <td rowspan=2>A</td><td>B</td> / <td>C</td><td>D</td>.
    // The grid width must account for the carried rowspan or D is dropped.
    const cell = (text: string, rowspan = 1) => ({
      header: false,
      colspan: 1,
      rowspan,
      content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }],
    });
    const blocks: ExportBlock[] = [
      {
        type: "table",
        rows: [
          { cells: [cell("A", 2), cell("B")] },
          { cells: [cell("C"), cell("D")] },
        ],
      },
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });
    for (const text of ["A", "B", "C", "D"]) expect(xml).toContain(text);
    expect(xml).toContain('<w:vMerge w:val="restart"/>');
    expect(xml).toContain('<w:vMerge w:val="continue"/>');
  });

  it("escapes a hostile hyperlink href so it stays one field argument (#2)", () => {
    const xml = serializeInline([
      {
        type: "link",
        target: { kind: "external", href: 'https://x.com" \\l "Injected' },
        content: [{ type: "text", text: "link" }],
      },
    ]);
    // Exactly one HYPERLINK argument opening — no injected second quoted arg.
    expect(xml.match(/HYPERLINK "/g)?.length).toBe(1);
    // The injected quote is escaped and the switch backslash is doubled.
    expect(xml).toContain('\\"Injected');
    expect(xml).toContain("\\\\l");
    // The raw, un-neutralized switch must not appear.
    expect(xml).not.toContain('" \\l "');
  });

  it("indents a blockquote paragraph that already has a pPr — e.g. a heading (#5)", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "blockquote",
        content: [
          { type: "heading", level: 2, content: [{ type: "text", text: "Quoted heading" }] },
          { type: "paragraph", content: [{ type: "text", text: "Quoted body" }] },
        ],
      },
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });
    // The heading keeps its style AND gains the quote indent + border.
    // Promoted: the H2 (shallowest heading, incl. nested ones) → Heading1.
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    // Both paragraphs are indented/bordered (2 occurrences of the left border).
    expect((xml.match(/<w:pBdr>/g) ?? []).length).toBe(2);
    expect((xml.match(/<w:ind w:left="360"\/>/g) ?? []).length).toBe(2);
  });

  it("attaches the list marker to a heading-first item without a trailing marker paragraph (#6)", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "list",
        ordered: false,
        items: [{ content: [{ type: "heading", level: 2, content: [{ type: "text", text: "Only heading" }] }] }],
      },
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });
    expect(xml).toContain("Only heading");
    // Promoted: the lone H2 (in a list item) → Heading1.
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    // Exactly one marker — no extra marker-only paragraph after the heading.
    expect((xml.match(/•/g) ?? []).length).toBe(1);
    // The marker sits inside the heading paragraph (before its text run).
    expect(xml.indexOf("•")).toBeLessThan(xml.indexOf("Only heading"));
  });

  it("reports a note when an unknown language degrades to plain text (#14)", async () => {
    const blocks: ExportBlock[] = [{ type: "codeBlock", language: "brainfuck", code: "+[-]" }];
    const { xml, notes } = await serializeBlocks(blocks, { styleNames: noStyles });
    expect(xml).toContain("+[-]");
    const note = notes.find((n) => n.code === "code-highlight-skipped");
    expect(note).toBeDefined();
    expect(note!.message).toContain("brainfuck");
  });

  it("renders nested lists with markers", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "list",
        ordered: false,
        items: [
          {
            content: [
              { type: "paragraph", content: [{ type: "text", text: "top" }] },
              { type: "list", ordered: true, items: [{ content: [{ type: "paragraph", content: [{ type: "text", text: "nested" }] }] }] },
            ],
          },
        ],
      },
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });
    expect(xml).toContain("top");
    expect(xml).toContain("nested");
    expect(xml).toContain("1."); // ordered nested marker
  });
});
