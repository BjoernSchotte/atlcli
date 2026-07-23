import { describe, expect, it } from "bun:test";
import { composeChapters, storageToBlocks, type ExportBlock, type ExportNode, type InlineNode } from "@atlcli/confluence";
import {
  columnWidthsDxa,
  serializeBlocks,
  serializeInline,
  type CodeBlock,
  type DiagramEmbedOutcome,
  type DiagramEmbedSeam,
} from "./serialize.js";
import { renderDiagram } from "@atlcli/diagram";
import { dataTable, parseStyleNames, resolveCaptionLang } from "./ooxml.js";
import { headingStyle, stylesXml } from "./fixtures.js";

const noStyles = new Map<string, string>();

/** A diagram seam over an inline embed function (test double for the wiring). */
function diagramSeamOver(
  embed: (block: CodeBlock) => Promise<DiagramEmbedOutcome>
): DiagramEmbedSeam {
  return { embed };
}

describe("serializeInline", () => {
  it("emits marks, foreground colors, and arbitrary background colors as run properties", () => {
    const xml = serializeInline([
      { type: "text", text: "bold", marks: ["bold"] },
      { type: "text", text: "red", color: "#ff0000" },
      { type: "text", text: "highlighted", backgroundColor: "#BAF3DB" },
      { type: "lineBreak" },
    ]);
    expect(xml).toContain("<w:b/>");
    expect(xml).toContain('<w:color w:val="FF0000"/>');
    expect(xml).toContain(
      '<w:shd w:val="clear" w:color="auto" w:fill="BAF3DB"/>'
    );
    expect(xml).toContain("<w:br/>");
  });

  it("renders inline code as an exact monospace token with default shading", () => {
    const xml = serializeInline([
      { type: "text", text: "before " },
      { type: "text", text: "CONFIG_TOKEN_A", marks: ["code"] },
      { type: "text", text: " after" },
    ]);
    expect(xml).toContain(
      '<w:rFonts w:ascii="JetBrains Mono" w:hAnsi="JetBrains Mono" w:cs="JetBrains Mono"/>'
    );
    expect(xml).toContain(
      '<w:shd w:val="clear" w:color="auto" w:fill="F4F5F7"/>'
    );
    expect(xml).toContain(">CONFIG_TOKEN_A</w:t>");
    expect(xml).not.toContain("CONFIG TOKEN A");
  });

  it("lets an explicit source highlight override the inline-code default", () => {
    const xml = serializeInline([
      {
        type: "text",
        text: "code",
        marks: ["code"],
        backgroundColor: "#BAF3DB",
      },
    ]);
    expect(xml).toContain('w:fill="BAF3DB"');
    expect(xml).not.toContain('w:fill="F4F5F7"');
  });

  it("renders an external link as a HYPERLINK field", () => {
    const xml = serializeInline([
      { type: "link", target: { kind: "external", href: "https://x.com" }, content: [{ type: "text", text: "site" }] },
    ]);
    expect(xml).toContain("HYPERLINK");
    expect(xml).toContain("https://x.com");
  });

  it("renders an inline Smart Card as a safe clickable chip", () => {
    const xml = serializeInline([{
      type: "smartCard",
      card: {
        appearance: "inline",
        source: "data",
        url: "https://example.invalid/card",
        target: { kind: "external", href: "https://example.invalid/card" },
        title: "Visible card",
        data: { name: "Visible card", provider: { name: "Example" } },
      },
    }]);
    expect(xml).toContain('HYPERLINK "https://example.invalid/card"');
    expect(xml).toContain(">Visible card</w:t>");
    expect(xml).toContain('w:fill="E9F2FF"');
  });

  it("renders resolved and unresolved mentions without leaking account IDs", () => {
    const xml = serializeInline([
      { type: "mention", accountId: "private-user-id", displayName: "Jo" },
      { type: "mention", accountId: "private-unresolved-id" },
      { type: "mention", accountId: "private-app-id", userType: "APP" },
    ]);
    expect(xml).toContain("@Jo");
    expect(xml).toContain("@Unknown user");
    expect(xml).toContain("@Unknown app");
    expect(xml).not.toContain("private-user-id");
    expect(xml).not.toContain("private-unresolved-id");
    expect(xml).not.toContain("private-app-id");
  });

  it("renders localized date and semantic status chips while hiding template placeholders", () => {
    const xml = serializeInline([
      { type: "date", timestamp: "1709510400000", localId: "date-1" },
      { type: "status", text: "Ready", color: "purple" },
      { type: "status", text: "Keep Case", color: "neutral", style: "mixedCase" },
      { type: "placeholder", text: "editor-only", localId: "placeholder-1" },
    ], undefined, undefined, "de-DE");

    expect(xml).toContain("> 4. März 2024 </w:t>");
    expect(xml).toContain('w:fill="DFE1E6"');
    expect(xml).toContain("> READY </w:t>");
    expect(xml).toContain('w:fill="EAE6FF"');
    expect(xml).toContain("> Keep Case </w:t>");
    expect(xml).not.toContain("editor-only");
    expect(xml).not.toContain("1709510400000");
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

describe("serializeBlocks — Smart Cards", () => {
  it("renders block and embed cards as bordered clickable static projections", async () => {
    const { xml } = await serializeBlocks([
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
    ], { styleNames: noStyles });

    expect(xml).toContain('HYPERLINK "https://example.invalid/block"');
    expect(xml).toContain('HYPERLINK "https://example.invalid/embed"');
    expect(xml).toContain(">Embedded content: </w:t>");
    expect(xml.match(/<w:pBdr>/gu)).toHaveLength(2);
    expect(xml.match(/w:fill="F4F5F7"/gu)).toHaveLength(2);
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

describe("serializeBlocks — ADF block presentation", () => {
  it("renders logical alignment and bounded indentation on paragraphs and headings", async () => {
    const { xml } = await serializeBlocks([
      {
        type: "paragraph",
        presentation: { alignment: "center", indentation: 2, fontSize: "small" },
        content: [
          { type: "text", text: "Centered" },
          { type: "text", text: "TOKEN", marks: ["code"] },
          { type: "mention", accountId: "account-1", displayName: "Jo" },
          { type: "status", text: "Ready", color: "green" },
          {
            type: "link",
            target: { kind: "external", href: "https://example.invalid/docs" },
            content: [{ type: "text", text: "Docs" }],
          },
        ],
      },
      {
        type: "heading",
        level: 2,
        presentation: { alignment: "end", indentation: 6 },
        content: [{ type: "text", text: "Logical end" }],
      },
    ], { styleNames: noStyles });

    expect(xml).toContain(
      '<w:pPr><w:ind w:start="1440"/><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>',
    );
    expect(xml).toContain(
      '<w:rFonts w:ascii="JetBrains Mono" w:hAnsi="JetBrains Mono" w:cs="JetBrains Mono"/><w:sz w:val="18"/><w:szCs w:val="18"/>',
    );
    expect(xml).toContain(
      '<w:color w:val="0747A6"/><w:sz w:val="18"/><w:szCs w:val="18"/>',
    );
    expect(xml).toContain(
      '<w:b/><w:sz w:val="18"/><w:szCs w:val="18"/><w:shd',
    );
    expect(xml).toContain(
      '<w:u w:val="single"/><w:color w:val="0563C1"/><w:sz w:val="18"/><w:szCs w:val="18"/>',
    );
    expect(xml).toContain(
      '<w:pStyle w:val="Heading1"/><w:ind w:start="4320"/><w:jc w:val="end"/><w:outlineLvl w:val="0"/>',
    );
  });

  it("bounds explicit run sizes and never emits non-finite OOXML values", () => {
    expect(serializeInline([{ type: "text", text: "small" }], undefined, 18.4)).toContain(
      '<w:sz w:val="18"/><w:szCs w:val="18"/>',
    );
    expect(serializeInline([{ type: "text", text: "bounded" }], undefined, 99_999)).toContain(
      '<w:sz w:val="3276"/><w:szCs w:val="3276"/>',
    );
    expect(serializeInline([{ type: "text", text: "finite" }], undefined, Number.NaN))
      .not.toContain("<w:sz");
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

  it("a composed multi-page document yields promotion offset 0 (chapter levels preserved)", async () => {
    // A composed document always starts at chapter level 1, so the shared
    // computeHeadingOffset yields 0: the level-1 root chapter and the level-2
    // child chapter keep their levels (a nonzero offset would collapse them).
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
        blocks: [{ type: "heading", level: 3, content: [{ type: "text", text: "Body" }] }],
        notes: [],
        meta: { labels: [], spaceKey: "DOC" },
      },
    ];
    const { blocks } = composeChapters(nodes);
    const styles = parseStyleNames(
      stylesXml(headingStyle("Heading1", "Heading 1") + headingStyle("Heading2", "Heading 2"))
    );
    const { xml } = await serializeBlocks(blocks, { styleNames: styles });
    // Root chapter → level 1; Child chapter → level 2 (offset 0, no promotion).
    expect(xml).toContain('<w:outlineLvl w:val="0"/>');
    expect(xml).toContain('<w:outlineLvl w:val="1"/>');
    // The lone level-2 chapter is NOT promoted back to a top-level Heading 1.
    expect(xml).toContain('<w:pStyle w:val="Heading2"/>');
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

  it("renders success and error callouts with distinct semantic palettes", async () => {
    const blocks: ExportBlock[] = [
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
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });
    expect(xml).toContain('w:fill="E3FCEF"');
    expect(xml).toContain('w:color="36B37E"');
    expect(xml).toContain('w:fill="FFEBE6"');
    expect(xml).toContain('w:color="DE350B"');
    expect(xml).toContain("Passed");
    expect(xml).toContain("Failed");
  });

  it("renders portable custom-panel color and icon text while retaining target-safe contrast", async () => {
    const { xml } = await serializeBlocks([{
      type: "callout",
      kind: "panel",
      localId: "panel-local",
      panelColor: "#123456",
      panelIcon: ":star:",
      panelIconId: "icon-id",
      panelIconText: "★",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Custom body" }] }],
    }], { styleNames: noStyles });

    expect(xml).toContain('w:fill="DBE1E6"');
    expect(xml).toContain('w:color="123456"');
    expect(xml).toContain("★");
    expect(xml).not.toContain(":star:");
    expect(xml).toContain("Custom body");
  });

  it("renders expand and nested-expand bodies open with a visible disclosure title", async () => {
    const blocks: ExportBlock[] = [{
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
    }];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });

    expect(xml.match(/<w:tbl>/g)).toHaveLength(2);
    expect(xml).toContain("[-] Outer details");
    expect(xml).toContain("[-] ");
    expect(xml).toContain("Outer body");
    expect(xml).toContain("Nested body");
    expect(xml.indexOf("Outer body")).toBeLessThan(xml.indexOf("Nested body"));
  });

  it("colors code via Shiki (multiple colored runs)", async () => {
    const blocks: ExportBlock[] = [
      { type: "codeBlock", language: "ts", code: 'const x: number = 1;\nconsole.log(x);' },
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });
    expect(xml).toContain('<w:pStyle w:val="AtlcliCode"/>');
    expect(xml).toContain("JetBrains Mono");
    // At least one syntax color was applied.
    expect(/<w:color w:val="[0-9A-F]{6}"\/>/.test(xml)).toBe(true);
  });

  it("renders authored code line numbers and reports the bounded no-wrap policy", async () => {
    const blocks: ExportBlock[] = [{
      type: "codeBlock",
      code: "first\nsecond\n",
      hideLineNumbers: false,
      firstLineNumber: 7,
      wrap: false,
      localId: "code-local",
      uniqueId: "code-unique",
    }];
    const { xml, notes } = await serializeBlocks(blocks, { styleNames: noStyles });

    expect(xml).toContain('<w:color w:val="6B778C"/>');
    expect(xml).toContain('<w:t xml:space="preserve">7</w:t>');
    expect(xml).toContain('<w:t xml:space="preserve">8</w:t>');
    expect(xml).toContain('<w:t xml:space="preserve">9</w:t>');
    expect(xml).toContain('<w:tab w:val="left" w:pos="480"/>');
    expect(xml).toContain('<w:ind w:start="480" w:hanging="480"/>');
    expect(xml).toContain("first");
    expect(xml).toContain("second");
    expect(notes.map((note) => note.code)).toContain("code-nowrap-page-bounded");
  });

  it("keeps internal and Storage-default code blocks free of an invented gutter", async () => {
    const { xml } = await serializeBlocks(
      [{ type: "codeBlock", code: "plain", hideLineNumbers: true }],
      { styleNames: noStyles },
    );

    expect(xml).toContain("plain");
    expect(xml).not.toContain('<w:color w:val="6B778C"/>');
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

  it("renders ADF table width, alignment, fixed mode, numbered rows, and vertical cell alignment", async () => {
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

    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });
    expect(xml).toContain('<w:tblW w:w="7200" w:type="dxa"/>');
    expect(xml).toContain('<w:jc w:val="end"/>');
    expect(xml).toContain('<w:tblLayout w:type="fixed"/>');
    expect(xml).toContain('<w:gridCol w:w="655"/>');
    expect(xml).toContain('<w:vAlign w:val="center"/>');
    expect(xml).toContain('<w:vAlign w:val="bottom"/>');
    expect(xml).toContain(">1</w:t>");
    expect(xml).toContain(">2</w:t>");
  });

  it("renders page layouts as borderless fixed columns with authored proportions and vertical alignment", async () => {
    const blocks: ExportBlock[] = [{
      type: "layout",
      localId: "layout-1",
      breakout: { mode: "wide", width: 960 },
      columns: [
        {
          width: 30,
          verticalAlignment: "middle",
          localId: "left",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Sidebar" }] }],
        },
        {
          width: 70,
          verticalAlignment: "bottom",
          localId: "right",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Main" }] }],
        },
      ],
    }];

    const { xml, notes } = await serializeBlocks(blocks, { styleNames: noStyles });
    expect(xml).toContain('<w:tblW w:w="9000" w:type="dxa"/>');
    expect(xml).toContain('<w:gridCol w:w="2700"/>');
    expect(xml).toContain('<w:gridCol w:w="6300"/>');
    expect(xml).toContain('<w:tblLayout w:type="fixed"/>');
    expect(xml).toContain('<w:vAlign w:val="center"/>');
    expect(xml).toContain('<w:vAlign w:val="bottom"/>');
    expect(xml).toContain("Sidebar");
    expect(xml).toContain("Main");
    expect(xml).not.toContain('<w:tblStyle w:val="TableGrid"/>');
    expect(xml).not.toContain("<w:tblBorders>");
    expect(notes).toEqual([]);
  });

  it("keeps a schema-valid zero-width layout column visible with an exact table width", async () => {
    const { xml } = await serializeBlocks([{
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
    }], { styleNames: noStyles });
    expect(xml).toContain('<w:tblW w:w="9000" w:type="dxa"/>');
    expect(xml).toContain('<w:gridCol w:w="8999"/>');
    expect(xml).toContain('<w:gridCol w:w="1"/>');
    expect(xml).toContain("Minimum");
  });

  it("preserves source cell backgrounds, readable text, and shading across rowspans", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "table",
        rows: [
          {
            cells: [
              {
                header: true,
                colspan: 1,
                rowspan: 2,
                backgroundColor: "#334455",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Dark section" }] }],
              },
              {
                header: true,
                colspan: 1,
                rowspan: 1,
                backgroundColor: "#E9F2FF",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Light section" }] }],
              },
            ],
          },
          {
            cells: [
              {
                header: false,
                colspan: 1,
                rowspan: 1,
                content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
              },
            ],
          },
        ],
      },
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });

    expect(xml.match(/w:fill="334455"/g)).toHaveLength(2);
    expect(xml).toContain('<w:color w:val="FFFFFF"/>');
    expect(xml).toContain('<w:shd w:val="clear" w:color="auto" w:fill="E9F2FF"/>');
    expect(xml).toContain('<w:color w:val="172B4D"/>');
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

  it("keeps ADF page and attachment href fallbacks clickable with a safe title tooltip", () => {
    const xml = serializeInline([
      {
        type: "link",
        target: {
          kind: "page",
          contentTitle: "Remote page",
          contentId: "123",
          href: "https://example.invalid/wiki/pages/123/Remote",
        },
        adfAttributes: { title: 'Open "Remote"' },
        content: [{ type: "text", text: "page" }],
      },
      {
        type: "link",
        target: {
          kind: "attachment",
          filename: "guide.pdf",
          href: "https://example.invalid/wiki/download/attachments/123/guide.pdf",
        },
        content: [{ type: "text", text: "file" }],
      },
    ]);

    expect(xml).toContain('HYPERLINK "https://example.invalid/wiki/pages/123/Remote"');
    expect(xml).toContain(' \\o "Open \\"Remote\\"" ');
    expect(xml).toContain(
      'HYPERLINK "https://example.invalid/wiki/download/attachments/123/guide.pdf"',
    );
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
    // Promoted: the lone H2 (in a list item) → Heading1, and the heading keeps
    // its own style while gaining native list numbering (no literal marker).
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(xml).not.toContain("•");
    // Exactly one numPr at ilvl 0 — no extra marker-only paragraph.
    expect((xml.match(/<w:numPr>/g) ?? []).length).toBe(1);
    expect(xml).toContain('<w:ilvl w:val="0"/>');
  });

  it("reports a note when an unknown language degrades to plain text (#14)", async () => {
    const blocks: ExportBlock[] = [{ type: "codeBlock", language: "brainfuck", code: "+[-]" }];
    const { xml, notes } = await serializeBlocks(blocks, { styleNames: noStyles });
    expect(xml).toContain("+[-]");
    const note = notes.find((n) => n.code === "code-highlight-skipped");
    expect(note).toBeDefined();
    expect(note!.message).toContain("brainfuck");
  });

  // The spec-004 F2 pin, retargeted per spec 005a Task 5: supported mermaid types
  // now RENDER, so the "never a broken image" invariant is guarded through an
  // UNSUPPORTED diagram type (Gantt) — it must degrade to a readable code block
  // with no image plumbing whatsoever, and the report must name the type.
  it("renders an unsupported diagram type as a code block, never a broken image (004 pin)", async () => {
    const blocks: ExportBlock[] = [
      { type: "codeBlock", language: "mermaid", code: "gantt\n  title T\n  section S\n  A :a1, 2026-01-01, 3d" },
    ];
    const seam = diagramSeamOver(async (block) => {
      const rendered = await renderDiagram(block.code);
      if (rendered.kind === "unsupported") return { ok: false, route: "unsupported", diagramType: rendered.diagramType };
      throw new Error("gantt must be unsupported");
    });
    const { xml, notes } = await serializeBlocks(blocks, { styleNames: noStyles, diagrams: seam });
    // Readable code block carrying the diagram source...
    expect(xml).toContain('<w:pStyle w:val="AtlcliCode"/>');
    expect(xml).toContain("gantt");
    // ...and no image plumbing whatsoever (no dangling relationship).
    expect(xml).not.toContain("<w:drawing");
    expect(xml).not.toContain("blip");
    expect(xml).not.toContain("r:embed");
    // The report names the diagram type (spec 005a Task 2).
    const note = notes.find((n) => n.code === "diagram-unsupported");
    expect(note).toBeDefined();
    expect(note!.message).toContain("Gantt");
  });

  // Hosts without a rasterizer (no diagram seam) keep the 004 behavior: source
  // as a code block, plus a note saying diagram rendering was unavailable.
  it("renders mermaid as a code block when no diagram seam is wired", async () => {
    const blocks: ExportBlock[] = [
      { type: "codeBlock", language: "mermaid", code: "graph TD;\n  A-->B;" },
    ];
    const { xml, notes } = await serializeBlocks(blocks, { styleNames: noStyles });
    expect(xml).toContain('<w:pStyle w:val="AtlcliCode"/>');
    expect(xml).toContain("graph TD;");
    expect(xml).toContain("A--&gt;B;");
    expect(xml).not.toContain("<w:drawing");
    expect(xml).not.toContain("r:embed");
    const note = notes.find((n) => n.code === "diagram-skipped");
    expect(note).toBeDefined();
  });

  it("routes a supported mermaid block through the diagram seam (spec 005a)", async () => {
    const blocks: ExportBlock[] = [
      { type: "codeBlock", language: "MERMAID", code: "graph TD\n  A --> B" },
    ];
    const seen: string[] = [];
    const seam = diagramSeamOver(async (block) => {
      seen.push(block.code);
      return { ok: true, xml: "<w:p><w:r><w:drawing>DIAGRAM</w:drawing></w:r></w:p>" };
    });
    const { xml, notes } = await serializeBlocks(blocks, { styleNames: noStyles, diagrams: seam });
    expect(seen).toEqual(["graph TD\n  A --> B"]);
    expect(xml).toContain("DIAGRAM");
    // The rendered route emits no note — the report counts it instead.
    expect(notes).toEqual([]);
    // Non-mermaid code blocks never touch the seam.
    await serializeBlocks([{ type: "codeBlock", language: "ts", code: "1;" }], { styleNames: noStyles, diagrams: seam });
    expect(seen).toHaveLength(1);
  });

  it("degrades to the code block with a warning when the diagram path fails", async () => {
    const blocks: ExportBlock[] = [
      { type: "codeBlock", language: "mermaid", code: "graph TD\n  A --> B" },
    ];
    const seam = diagramSeamOver(async () => ({ ok: false, route: "failed", reason: "raster exploded" }));
    const { xml, notes } = await serializeBlocks(blocks, { styleNames: noStyles, diagrams: seam });
    expect(xml).toContain('<w:pStyle w:val="AtlcliCode"/>');
    expect(xml).toContain("graph TD");
    expect(xml).not.toContain("<w:drawing");
    const note = notes.find((n) => n.code === "diagram-render-failed");
    expect(note).toBeDefined();
    expect(note!.level).toBe("warning");
    expect(note!.message).toContain("raster exploded");
  });

  it("renders nested lists with native numbering (distinct numId per node)", async () => {
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
    // Every list node owns one self-contained level-0 definition. Nesting is
    // encoded in that definition's indent, so renderers do not have to resolve
    // a sparse multilevel definition inherited from an unrelated parent list.
    const numIds = [...xml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]);
    expect(numIds).toHaveLength(2);
    expect(new Set(numIds).size).toBe(2);
    expect(xml.match(/<w:ilvl w:val="0"\/>/g)).toHaveLength(2);
    expect(xml).not.toContain('<w:ilvl w:val="1"/>');
    expect(xml).not.toContain("•");
  });
});

describe("serializeBlocks — new ExportBlock variants (spec 002 real renderings)", () => {
  it("renders pageBreak as a page break, anchor as a zero-width bookmark, orientation bare", async () => {
    const withNew: ExportBlock[] = [
      { type: "paragraph", content: [{ type: "text", text: "before" }] },
      { type: "pageBreak" },
      { type: "anchor", name: "sec" },
      {
        type: "orientation",
        landscape: true,
        content: [{ type: "paragraph", content: [{ type: "text", text: "inside region" }] }],
      },
      { type: "paragraph", content: [{ type: "text", text: "after" }] },
    ];
    const { xml, notes } = await serializeBlocks(withNew, { styleNames: noStyles });

    // pageBreak → a real page break paragraph.
    expect(xml).toContain('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    // anchor → a zero-width bookmark (start immediately followed by end).
    expect(xml).toContain('<w:bookmarkStart w:id="1" w:name="sec"/><w:bookmarkEnd w:id="1"/>');
    // orientation still renders its child transparently.
    expect(xml).toContain('<w:p><w:r><w:t xml:space="preserve">inside region</w:t></w:r></w:p>');
    expect(notes).toEqual([]);
  });

  it("promotes headings nested inside an orientation region (computeHeadingOffset)", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "orientation",
        landscape: true,
        content: [{ type: "heading", level: 2, content: [{ type: "text", text: "Wide section" }] }],
      },
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });
    // The lone H2 (inside the region) is the shallowest heading → promoted to
    // Heading 1. Without the orientation recursion in minHeadingLevel it would
    // stay Heading2.
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(xml).toContain("Wide section");
  });

  it("prefetches an image and a mermaid diagram nested inside an orientation region", async () => {
    const imagePrefetched: string[] = [];
    const diagramPrefetched: string[] = [];
    const blocks: ExportBlock[] = [
      {
        type: "orientation",
        landscape: false,
        content: [
          { type: "image", source: { kind: "attachment", filename: "nested.png" }, alt: "n" },
          { type: "codeBlock", language: "mermaid", code: "graph TD\n A-->B" },
        ],
      },
    ];
    await serializeBlocks(blocks, {
      styleNames: noStyles,
      images: {
        embed: async () => ({ ok: false, reason: "unused" }),
        prefetch: (block) =>
          imagePrefetched.push(block.source.kind === "attachment" ? block.source.filename : block.source.url),
      },
      diagrams: {
        embed: async () => ({ ok: false, route: "failed", reason: "unused" }),
        prefetch: (block) => diagramPrefetched.push(block.code),
      },
    });
    // Both nested-block prefetch hooks fired — the prefetchBlocks walk descended
    // into the orientation region.
    expect(imagePrefetched).toEqual(["nested.png"]);
    expect(diagramPrefetched).toEqual(["graph TD\n A-->B"]);
  });

  it("prefetches assets nested inside page-layout columns", async () => {
    const imagePrefetched: string[] = [];
    const diagramPrefetched: string[] = [];
    const blocks: ExportBlock[] = [{
      type: "layout",
      columns: [{
        width: 100,
        content: [
          { type: "image", source: { kind: "attachment", filename: "column.png" }, alt: "n" },
          { type: "codeBlock", language: "mermaid", code: "graph TD\n L-->R" },
        ],
      }],
    }];
    await serializeBlocks(blocks, {
      styleNames: noStyles,
      images: {
        embed: async () => ({ ok: false, reason: "unused" }),
        prefetch: (block) =>
          imagePrefetched.push(block.source.kind === "attachment" ? block.source.filename : block.source.url),
      },
      diagrams: {
        embed: async () => ({ ok: false, route: "failed", reason: "unused" }),
        prefetch: (block) => diagramPrefetched.push(block.code),
      },
    });
    expect(imagePrefetched).toEqual(["column.png"]);
    expect(diagramPrefetched).toEqual(["graph TD\n L-->R"]);
  });

  it("prefetches real assets through expands but never treats unresolved media as fetchable", async () => {
    const imagePrefetched: string[] = [];
    const blocks: ExportBlock[] = [{
      type: "expand",
      nested: false,
      content: [
        {
          type: "image",
          source: { kind: "attachment", filename: "expand.png" },
          alt: "Embedded",
        },
        {
          type: "mediaFallback",
          label: "unresolved-media",
          media: { mediaType: "file", id: "media-1" },
          caption: {
            kind: "figure",
            content: [{ type: "text", text: "Unavailable" }],
          },
        },
      ],
    }];

    await serializeBlocks(blocks, {
      styleNames: noStyles,
      images: {
        embed: async () => ({ ok: false, reason: "unused" }),
        prefetch: (block) =>
          imagePrefetched.push(
            block.source.kind === "attachment" ? block.source.filename : block.source.url,
          ),
      },
    });

    expect(imagePrefetched).toEqual(["expand.png"]);
  });

  it("renders ADF media links around embedded drawings and visible fallbacks", async () => {
    const link = {
      target: { kind: "external" as const, href: "https://example.invalid/media" },
      adfAttributes: { title: "Open media" },
    };
    const { xml } = await serializeBlocks([
      {
        type: "image",
        source: { kind: "attachment", filename: "linked.png" },
        alt: "Linked image",
        link,
      },
      {
        type: "mediaFallback",
        label: "unresolved",
        media: { mediaType: "file", id: "media-1" },
        link,
      },
    ], {
      styleNames: noStyles,
      images: {
        prefetch: () => {},
        embed: async () => ({
          ok: true,
          xml: "<w:p><w:r><w:drawing/></w:r></w:p>",
        }),
      },
    });

    expect(xml.match(/HYPERLINK "https:\/\/example\.invalid\/media"/gu)).toHaveLength(2);
    expect(xml).toContain("<w:drawing/>");
    expect(xml).toContain("[Media unavailable: unresolved]");
    expect(xml).toContain(' \\o "Open media" ');
  });
});

describe("serializeBlocks — multi-page composed document (T1.3 engine golden)", () => {
  // A real composeChapters output (fixture tree) through the DOCX serializer:
  // chapter bookmarks + a working cross-page w:hyperlink jump + a chapter page
  // break. This is the DOCX half of the T1.3 engine golden (the PDF half lives
  // in packages/pdf/src/serialize.test.ts; both render into the SAME sanitized
  // destination ids composeChapters assigns).
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

  it("emits chapter bookmarks, a cross-page w:hyperlink jump, and a chapter page break", async () => {
    const { blocks } = composeChapters(nodes);
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });

    // Chapter-start bookmarks for both pages (sanitized `page-<id>` ids).
    expect(xml).toContain('<w:bookmarkStart w:id="1" w:name="page-100"/>');
    expect(xml).toContain('w:name="page-300"');
    // Each bookmarkStart is matched by a bookmarkEnd with the same id.
    expect(xml).toContain('<w:bookmarkEnd w:id="1"/>');
    // The cross-page link from Alpha resolves to a REAL in-document jump to
    // Gamma's chapter bookmark (previously internal links were only styled).
    expect(xml).toContain('<w:hyperlink w:anchor="page-300" w:history="1">');
    expect(xml).toContain("see Gamma");
    // A hard page break separates the two chapters.
    expect(xml).toContain('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
  });

  it("is deterministic across two composeChapters runs", async () => {
    const first = await serializeBlocks(composeChapters(nodes).blocks, { styleNames: noStyles });
    const second = await serializeBlocks(composeChapters(nodes).blocks, { styleNames: noStyles });
    expect(first.xml).toBe(second.xml);
  });

  it("dedupes single-page anchor names that sanitize identically (no duplicate bookmark names)", async () => {
    // Single-page export: no compose-time registry, so the serializer itself
    // must keep bookmark names unique. "A B" and "A_B" both sanitize to "a-b".
    const blocks: ExportBlock[] = [
      { type: "anchor", name: "A B" },
      { type: "paragraph", content: [{ type: "text", text: "between" }] },
      { type: "anchor", name: "A_B" },
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });
    const names = [...xml.matchAll(/<w:bookmarkStart w:id="\d+" w:name="([^"]+)"\/>/g)].map(
      (m) => m[1]
    );
    expect(names).toHaveLength(2);
    // First occurrence keeps the plain sanitized name (links resolve to it);
    // the second gets the shared short-hash-suffix scheme.
    expect(names[0]).toBe("a-b");
    expect(names[1]).toMatch(/^a-b-[0-9a-z]+$/);
    expect(new Set(names).size).toBe(2);
  });
});

// ===========================================================================
// spec 003 — page breaks, orientation regions, captions (C5/C6/C3)
// ===========================================================================

// The repo's own template body sectPr is Letter (12240 x 15840). Orientation
// tests assert against these SOURCE values, never a hard-coded A4 constant.
const LETTER_SECTPR =
  '<w:sectPr><w:headerReference w:type="default" r:id="rIdH1"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>';

describe("serializeBlocks — C5 pageBreak", () => {
  it("emits a page-break paragraph at body level", async () => {
    const { xml } = await serializeBlocks([{ type: "pageBreak" }], { styleNames: noStyles });
    expect(xml).toContain('<w:br w:type="page"/>');
  });

  it("suppresses a page break inside a table cell with a note (children kept)", async () => {
    const blocks: ExportBlock[] = [
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
                  { type: "paragraph", content: [{ type: "text", text: "keep" }] },
                  { type: "pageBreak" },
                ],
              },
            ],
          },
        ],
      },
    ];
    const { xml, notes } = await serializeBlocks(blocks, { styleNames: noStyles });
    expect(xml).not.toContain('<w:br w:type="page"/>');
    expect(xml).toContain("keep");
    expect(notes.map((n) => n.code)).toContain("pagebreak-suppressed-in-container");
  });

  it("suppresses a page break inside a callout with a note", async () => {
    const blocks: ExportBlock[] = [
      { type: "callout", kind: "info", content: [{ type: "pageBreak" }] },
    ];
    const { xml, notes } = await serializeBlocks(blocks, { styleNames: noStyles });
    expect(xml).not.toContain('<w:br w:type="page"/>');
    expect(notes.map((n) => n.code)).toContain("pagebreak-suppressed-in-container");
  });
});

describe("serializeBlocks — C6 orientation region", () => {
  const region = (landscape: boolean): ExportBlock => ({
    type: "orientation",
    landscape,
    content: [{ type: "paragraph", content: [{ type: "text", text: "wide" }] }],
  });

  it("emits a section sandwich swapping the SOURCE template's pgSz (Letter, not A4)", async () => {
    const { xml } = await serializeBlocks([region(true)], {
      styleNames: noStyles,
      bodySectPr: LETTER_SECTPR,
    });
    // Two sectPr-carrying paragraphs (before + after the region content).
    const sectPrs = [...xml.matchAll(/<w:pgSz\b[^>]*\/>/g)].map((m) => m[0]);
    expect(sectPrs).toHaveLength(2);
    // First (portrait closer) keeps the source Letter dimensions.
    expect(sectPrs[0]).toContain('w:w="12240"');
    expect(sectPrs[0]).toContain('w:h="15840"');
    // Second (landscape) swaps the SOURCE values — 15840 x 12240, not A4.
    expect(sectPrs[1]).toContain('w:w="15840"');
    expect(sectPrs[1]).toContain('w:h="12240"');
    expect(sectPrs[1]).toContain('w:orient="landscape"');
    expect(xml).not.toContain("11906"); // no A4 constant leaked
    // Region children present.
    expect(xml).toContain("wide");
    // Header reference preserved through both clones.
    expect((xml.match(/<w:headerReference\b/g) ?? []).length).toBe(2);
    // Landscape closer carries a nextPage section type.
    expect(sectPrs[1]).not.toBe(sectPrs[0]);
    expect(xml).toContain('<w:type w:val="nextPage"/>');
  });

  it("a portrait region normalizes back to portrait dimensions", async () => {
    const { xml } = await serializeBlocks([region(false)], {
      styleNames: noStyles,
      bodySectPr: LETTER_SECTPR,
    });
    const sectPrs = [...xml.matchAll(/<w:pgSz\b[^>]*\/>/g)].map((m) => m[0]);
    // Region closer is portrait: width < height, no landscape orient.
    expect(sectPrs[1]).toContain('w:w="12240"');
    expect(sectPrs[1]).toContain('w:h="15840"');
    expect(sectPrs[1]).not.toContain("landscape");
  });

  it("synthesizes an A4 fallback when the template has no body sectPr", async () => {
    const { xml } = await serializeBlocks([region(true)], { styleNames: noStyles });
    // Only here may A4 constants appear (no real template size to preserve).
    expect(xml).toContain('w:w="16838"');
    expect(xml).toContain('w:h="11906"');
    expect(xml).toContain('w:orient="landscape"');
  });

  it("suppresses the section sandwich inside a table cell (children kept + note)", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "table",
        rows: [
          {
            cells: [
              { header: false, colspan: 1, rowspan: 1, content: [region(true)] },
            ],
          },
        ],
      },
    ];
    const { xml, notes } = await serializeBlocks(blocks, { styleNames: noStyles, bodySectPr: LETTER_SECTPR });
    // No section break inside the cell.
    expect(xml).not.toContain('w:orient="landscape"');
    expect(xml).toContain("wide");
    expect(notes.map((n) => n.code)).toContain("orientation-suppressed-in-container");
  });

  it("suppresses the section sandwich inside a callout (children kept + note)", async () => {
    const blocks: ExportBlock[] = [
      { type: "callout", kind: "warning", content: [region(true)] },
    ];
    const { xml, notes } = await serializeBlocks(blocks, { styleNames: noStyles, bodySectPr: LETTER_SECTPR });
    expect(xml).not.toContain('w:orient="landscape"');
    expect(xml).toContain("wide");
    expect(notes.map((n) => n.code)).toContain("orientation-suppressed-in-container");
  });
});

/**
 * Every caption SEQ field's SEQUENCE NAME and CACHED RESULT, in document order.
 *
 * The cached result is the number between `fldChar separate` and `fldChar end` —
 * what Word shows before anyone presses F9, and the only number a consumer that
 * reads `<w:t>` without evaluating fields (pandoc, python-docx, a search
 * indexer) ever sees. Asserting on `toContain("SEQ Figure")` (what the caption
 * tests did before) proves the field exists and says nothing about the number in
 * it, which is how three tables came to read "Tabelle 1" three times.
 */
function seqCachedResults(xml: string): [sequence: string, cached: string][] {
  // The gap-crossing guards matter: without them a field whose cached result is
  // formatted differently lets the scan run on into the NEXT field's number and
  // report a pairing that is not in the file.
  const gap = String.raw`(?:(?!fldCharType="end")[\s\S])*?`;
  const re = new RegExp(
    String.raw`SEQ (\w+) \\\* ARABIC${gap}fldCharType="separate"${gap}<w:t[^>]*>(\d+)</w:t>`,
    "g"
  );
  return [...xml.matchAll(re)].map((m) => [m[1], m[2]]);
}

describe("serializeBlocks — C3 captions", () => {
  const captionedImage = (): ExportBlock => ({
    type: "image",
    source: { kind: "attachment", filename: "arch.png" },
    caption: { kind: "figure", content: [{ type: "text", text: "Architecture" }] },
  });

  const captionedTable = (title: string): ExportBlock => ({
    type: "table",
    rows: [{ cells: [{ header: false, colspan: 1, rowspan: 1, content: [] }] }],
    caption: { kind: "table", content: [{ type: "text", text: title }] },
  });

  const captionedCode = (kind: "code" | "equation"): ExportBlock => ({
    type: "codeBlock",
    code: "x = 1",
    caption: { kind, content: [{ type: "text", text: kind }] },
  });

  it("emits a Caption-styled SEQ paragraph for a table (English, above the table)", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "table",
        rows: [{ cells: [{ header: false, colspan: 1, rowspan: 1, content: [] }] }],
        caption: { kind: "table", content: [{ type: "text", text: "Results" }] },
      },
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles, captionLang: "en" });
    expect(xml).toContain('<w:pStyle w:val="Caption"/>');
    expect(xml).toContain("SEQ Table");
    expect(xml).toContain("Table ");
    expect(xml).toContain("Results");
    // Caption paragraph precedes the table (above-table convention).
    expect(xml.indexOf("Caption")).toBeLessThan(xml.indexOf("<w:tbl>"));
  });

  it("localizes the SEQ label to German", async () => {
    const blocks: ExportBlock[] = [captionedImage()];
    const { xml } = await serializeBlocks(blocks, {
      styleNames: noStyles,
      captionLang: "de",
      images: { embed: async () => ({ ok: true, xml: "<w:p>IMG</w:p>" }) },
    });
    expect(xml).toContain("Abbildung ");
    expect(xml).toContain("SEQ Figure"); // sequence identifier stays language-stable
  });

  it("defaults to English when no locale is supplied", async () => {
    const { xml } = await serializeBlocks([captionedImage()], {
      styleNames: noStyles,
      images: { embed: async () => ({ ok: true, xml: "<w:p>IMG</w:p>" }) },
    });
    expect(xml).toContain("Figure ");
  });

  it("uses a template's own Caption style id when present", async () => {
    const styles = new Map<string, string>([["caption", "MyCaption"]]);
    const { xml } = await serializeBlocks([captionedImage()], {
      styleNames: styles,
      images: { embed: async () => ({ ok: true, xml: "<w:p>IMG</w:p>" }) },
    });
    expect(xml).toContain('<w:pStyle w:val="MyCaption"/>');
  });

  it("a captioned image with a failed embed still emits a numbered caption + placeholder", async () => {
    const { xml, notes } = await serializeBlocks([captionedImage()], {
      styleNames: noStyles,
      images: { embed: async () => ({ ok: false, reason: "404" }) },
    });
    // No dangling drawing, but a visible placeholder + the SAME caption so the
    // SEQ number is not skipped.
    expect(xml).toContain("[Image unavailable: arch.png]");
    expect(xml).toContain("SEQ Figure");
    expect(notes.map((n) => n.code)).toContain("image-embed-failed");
  });

  it("a captioned image with no embedder still emits a numbered caption", async () => {
    const { xml, notes } = await serializeBlocks([captionedImage()], { styleNames: noStyles });
    expect(xml).toContain("[Image unavailable: arch.png]");
    expect(xml).toContain("SEQ Figure");
    expect(notes.map((n) => n.code)).toContain("image-skipped");
  });

  it("keeps an unresolved ADF media caption attached to its visible placeholder", async () => {
    const { xml, notes } = await serializeBlocks([{
      type: "mediaFallback",
      label: "media-1",
      media: { mediaType: "file", id: "media-1" },
      alt: "Architecture",
      caption: {
        kind: "figure",
        localId: "",
        content: [{ type: "text", text: "System overview" }],
      },
    }], { styleNames: noStyles, captionLang: "en" });

    expect(xml).toContain("[Media unavailable: Architecture]");
    expect(xml).toContain("System overview");
    expect(seqCachedResults(xml)).toEqual([["Figure", "1"]]);
    expect(notes).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Caption ordinals — the SEQ field's CACHED RESULT
  //
  // Every caption used to cache `1`, so a document with three tables read
  // "Tabelle 1" three times until the reader pressed F9 — and every export with
  // a single caption paid an "update fields?" prompt to fix numbers that were
  // wrong only because we wrote them wrong.
  // -------------------------------------------------------------------------

  it("numbers repeated captions of one sequence 1, 2, 3 — not 1, 1, 1", async () => {
    const { xml } = await serializeBlocks(
      [captionedTable("First"), captionedTable("Second"), captionedTable("Third")],
      { styleNames: noStyles, captionLang: "de" }
    );
    expect(seqCachedResults(xml)).toEqual([
      ["Table", "1"],
      ["Table", "2"],
      ["Table", "3"],
    ]);
    // The FIELD survives: cross-references, a table of figures and a manual F9
    // all still work — only the cached result changed.
    expect(xml).toContain(' SEQ Table \\* ARABIC ');
    expect(xml).toContain('<w:fldChar w:fldCharType="begin"/>');
  });

  it("counts each sequence independently, in document order", async () => {
    const { xml } = await serializeBlocks(
      [captionedImage(), captionedTable("T1"), captionedImage(), captionedTable("T2")],
      {
        styleNames: noStyles,
        images: { embed: async () => ({ ok: true, xml: "<w:p>IMG</w:p>" }) },
      }
    );
    expect(seqCachedResults(xml)).toEqual([
      ["Figure", "1"],
      ["Table", "1"],
      ["Figure", "2"],
      ["Table", "2"],
    ]);
  });

  it("shares ONE counter between code and equation captions (Word's SEQ scoping)", async () => {
    // Both kinds emit `SEQ Listing`, so Word counts them together — the labels
    // differ, the sequence does not. Counting per CaptionKind would cache 1, 1, 2
    // where Word computes 1, 2, 3.
    const { xml } = await serializeBlocks(
      [captionedCode("code"), captionedCode("equation"), captionedCode("code")],
      { styleNames: noStyles }
    );
    expect(seqCachedResults(xml)).toEqual([
      ["Listing", "1"],
      ["Listing", "2"],
      ["Listing", "3"],
    ]);
    expect(xml).toContain("Equation ");
    expect(xml).toContain("Listing ");
  });

  it("restarts at 1 for the next document in the same process", async () => {
    // A module-level counter would pass every test above and then number the
    // SECOND export in a long-lived process from wherever the first stopped —
    // exactly the shape of a tree export following a single-page one.
    const blocks = [captionedTable("First"), captionedTable("Second")];
    const first = await serializeBlocks(blocks, { styleNames: noStyles });
    const second = await serializeBlocks(blocks, { styleNames: noStyles });
    expect(seqCachedResults(first.xml)).toEqual([
      ["Table", "1"],
      ["Table", "2"],
    ]);
    expect(seqCachedResults(second.xml)).toEqual(seqCachedResults(first.xml));
  });

  it("numbers a caption nested in a callout in document order with the rest", async () => {
    // Containers get a DERIVED context (`{ ...ctx, container: … }`), so the
    // counters have to be a shared mutable reference — a plain number field
    // would be copied and the nested caption would restart at 1.
    const { xml } = await serializeBlocks(
      [
        captionedTable("Outer"),
        { type: "callout", kind: "info", content: [captionedTable("Inside a callout")] },
        captionedTable("Last"),
      ],
      { styleNames: noStyles }
    );
    expect(seqCachedResults(xml)).toEqual([
      ["Table", "1"],
      ["Table", "2"],
      ["Table", "3"],
    ]);
  });

  it("a figure that failed to embed still consumes its number", async () => {
    // The degraded path emits the same caption paragraph, so the numbering the
    // reader sees matches the numbering Word would compute on refresh.
    let first = true;
    const { xml } = await serializeBlocks([captionedImage(), captionedImage()], {
      styleNames: noStyles,
      images: {
        embed: async () => {
          const ok = !first;
          first = false;
          return ok ? { ok: true as const, xml: "<w:p>IMG</w:p>" } : { ok: false as const, reason: "404" };
        },
      },
    });
    expect(xml).toContain("[Image unavailable: arch.png]");
    expect(seqCachedResults(xml)).toEqual([
      ["Figure", "1"],
      ["Figure", "2"],
    ]);
  });

  it("continues numbering across the pages of a composed tree document", async () => {
    // A tree/space export is ONE document made of many pages, so its captions
    // are one sequence: page 2's first table is "Table 2", not a second "Table 1".
    const pageNode = (id: string, title: string): ExportNode => ({
      kind: "page",
      pageId: id,
      title,
      depth: 0,
      effectiveDepth: 0,
      parentId: null,
      position: null,
      blocks: [captionedTable(`${title} table`)],
      notes: [],
      meta: { labels: [], spaceKey: "ENG" },
    });
    const composed = composeChapters([pageNode("1", "Alpha"), pageNode("2", "Beta")]);
    const { xml } = await serializeBlocks(composed.blocks, { styleNames: noStyles });
    expect(seqCachedResults(xml)).toEqual([
      ["Table", "1"],
      ["Table", "2"],
    ]);
  });

  it("localizes to German without changing the ordinals", async () => {
    const { xml } = await serializeBlocks([captionedImage(), captionedImage()], {
      styleNames: noStyles,
      captionLang: "de",
      images: { embed: async () => ({ ok: true, xml: "<w:p>IMG</w:p>" }) },
    });
    expect(seqCachedResults(xml)).toEqual([
      ["Figure", "1"],
      ["Figure", "2"],
    ]);
    expect(xml).toContain("Abbildung ");
  });

  it("regression: scroll macros no longer reach the unknown-placeholder path in DOCX", async () => {
    const blocks = storageToBlocks(
      '<ac:structured-macro ac:name="scroll-pagebreak"/>' +
        '<ac:structured-macro ac:name="scroll-landscape"><ac:rich-text-body><p>wide</p></ac:rich-text-body></ac:structured-macro>',
      { exporter: "word" }
    ).blocks;
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles, bodySectPr: LETTER_SECTPR });
    expect(xml).not.toContain("macro not rendered");
  });
});

describe("serializeBlocks — C6 adjacent orientation regions (empty-section fix)", () => {
  const regionWith = (landscape: boolean, text: string): ExportBlock => ({
    type: "orientation",
    landscape,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });

  /** Every sectPr-carrying (empty) paragraph in order. */
  function sectPrParas(xml: string): string[] {
    return [...xml.matchAll(/<w:p><w:pPr><w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr><\/w:pPr><\/w:p>/g)].map(
      (m) => m[0]
    );
  }

  /** True if two section-closing paragraphs are directly adjacent (an EMPTY section). */
  function hasEmptySection(xml: string): boolean {
    return /(<w:p><w:pPr><w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr><\/w:pPr><\/w:p>){2}/.test(xml);
  }

  it("two adjacent landscape regions produce no empty section (no blank page)", async () => {
    const { xml } = await serializeBlocks(
      [regionWith(true, "one"), regionWith(true, "two")],
      { styleNames: noStyles, bodySectPr: LETTER_SECTPR }
    );
    expect(hasEmptySection(xml)).toBe(false);
    // Both regions' content still renders, each closed by a landscape sectPr.
    expect(xml).toContain("one");
    expect(xml).toContain("two");
    const paras = sectPrParas(xml);
    // base-closer, region-1 closer, region-2 closer — the redundant second
    // base-restore between the regions was coalesced away.
    expect(paras).toHaveLength(3);
    expect(paras[1]).toContain('w:orient="landscape"');
    expect(paras[2]).toContain('w:orient="landscape"');
  });

  it("a landscape region followed by a portrait region keeps both orientations, no empty section", async () => {
    const { xml } = await serializeBlocks(
      [regionWith(true, "wide"), regionWith(false, "tall")],
      { styleNames: noStyles, bodySectPr: LETTER_SECTPR }
    );
    expect(hasEmptySection(xml)).toBe(false);
    const paras = sectPrParas(xml);
    expect(paras).toHaveLength(3);
    // "wide" closes landscape; "tall" closes portrait.
    expect(paras[1]).toContain('w:orient="landscape"');
    expect(paras[2]).not.toContain("landscape");
    expect(xml.indexOf("wide")).toBeLessThan(xml.indexOf(paras[1]!));
    expect(xml.indexOf("tall")).toBeGreaterThan(xml.indexOf(paras[1]!));
  });

  it("three back-to-back regions coalesce every redundant base closer", async () => {
    const { xml } = await serializeBlocks(
      [regionWith(true, "a"), regionWith(false, "b"), regionWith(true, "c")],
      { styleNames: noStyles, bodySectPr: LETTER_SECTPR }
    );
    expect(hasEmptySection(xml)).toBe(false);
  });
});

describe("resolveCaptionLang", () => {
  it("resolves BCP-47 primary subtags case-insensitively", () => {
    expect(resolveCaptionLang("de")).toEqual({ lang: "de" });
    expect(resolveCaptionLang("de-DE").lang).toBe("de");
    expect(resolveCaptionLang("DE_AT").lang).toBe("de");
    expect(resolveCaptionLang("en-US")).toEqual({ lang: "en" });
  });

  it("absent/empty input defaults to English without a note", () => {
    expect(resolveCaptionLang(undefined)).toEqual({ lang: "en" });
    expect(resolveCaptionLang("  ")).toEqual({ lang: "en" });
  });

  it("unsupported languages fall back to English with a warning note", () => {
    const result = resolveCaptionLang("fr-FR");
    expect(result.lang).toBe("en");
    expect(result.note).toMatchObject({ level: "warning", code: "caption-lang-fallback" });
  });
});

// ---------------------------------------------------------------------------
// G3 — table column widths + G3b table style source (spec 006)
// ---------------------------------------------------------------------------

describe("columnWidthsDxa (spec 006 G3)", () => {
  it("scales ratios [100, 300] to gridCol 2250/6750 (PDF-parity numbers)", () => {
    expect(columnWidthsDxa([100, 300], 2)).toEqual([2250, 6750]);
    expect(columnWidthsDxa([100, 300], 2, 7200)).toEqual([1800, 5400]);
  });

  it("even-splits (undefined) on a length mismatch", () => {
    expect(columnWidthsDxa([100, 300], 3)).toBeUndefined();
    expect(columnWidthsDxa(undefined, 2)).toBeUndefined();
  });

  it("even-splits (undefined) for near-equal widths below the 1.05 spread threshold", () => {
    expect(columnWidthsDxa([226, 226], 2)).toBeUndefined();
    expect(columnWidthsDxa([230, 226], 2)).toBeUndefined(); // spread ~1.018
  });

  it("honors an explicit non-near-equal spread and sums to exactly 9000", () => {
    const dxa = columnWidthsDxa([1, 2, 6], 3)!;
    expect(dxa).toBeDefined();
    expect(dxa.reduce((s, w) => s + w, 0)).toBe(9000);
  });

  it("rejects non-finite / non-positive widths", () => {
    expect(columnWidthsDxa([0, 300], 2)).toBeUndefined();
    expect(columnWidthsDxa([Number.NaN, 300], 2)).toBeUndefined();
  });
});

describe("serializeBlocks — table widths + style (spec 006 G3/G3b)", () => {
  const noStyles = new Map<string, string>();
  const cell = (text: string, extra: Partial<{ colspan: number; rowspan: number; header: boolean }> = {}) => ({
    colspan: extra.colspan ?? 1,
    rowspan: extra.rowspan ?? 1,
    header: extra.header ?? false,
    content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }],
  });
  const table = (columnWidths: number[] | undefined, rows: ReturnType<typeof cell>[][]): ExportBlock => ({
    type: "table",
    rows: rows.map((cells) => ({ cells })),
    ...(columnWidths ? { columnWidths } : {}),
  });

  it("emits real gridCol widths + tblLayout fixed for explicit unequal widths", async () => {
    const { xml } = await serializeBlocks([table([100, 300], [[cell("a"), cell("b")]])], {
      styleNames: noStyles,
    });
    expect(xml).toContain('<w:gridCol w:w="2250"/>');
    expect(xml).toContain('<w:gridCol w:w="6750"/>');
    expect(xml).toContain('<w:tblLayout w:type="fixed"/>');
    // Per-cell tcW matches the column widths.
    expect(xml).toContain('<w:tcW w:w="2250" w:type="dxa"/>');
    expect(xml).toContain('<w:tcW w:w="6750" w:type="dxa"/>');
  });

  it("falls back to an even split (no tcW, no fixed layout) for near-equal widths", async () => {
    const { xml } = await serializeBlocks([table([226, 226], [[cell("a"), cell("b")]])], {
      styleNames: noStyles,
    });
    expect(xml).not.toContain("<w:tcW");
    expect(xml).not.toContain('w:type="fixed"');
  });

  it("a colspan cell's tcW equals the sum of its spanned columns", async () => {
    // 3 columns [100,100,300] of total 500 → dxa [1800,1800,5400]. A cell
    // spanning cols 0-1 → tcW 3600; the 3rd column → 5400.
    const { xml } = await serializeBlocks(
      [
        table(
          [100, 100, 300],
          [
            [cell("h1"), cell("h2"), cell("h3")],
            [cell("wide", { colspan: 2 }), cell("tail")],
          ]
        ),
      ],
      { styleNames: noStyles }
    );
    expect(xml).toContain('<w:gridCol w:w="1800"/>');
    expect(xml).toContain('<w:gridCol w:w="5400"/>');
    // The spanning cell sums cols 0+1 = 3600.
    expect(xml).toContain('<w:tcW w:w="3600" w:type="dxa"/>');
    expect(xml).toContain('<w:gridSpan w:val="2"/>');
  });

  it("handles a combined fixture: ragged rows, rowspan carries, colspans, padding", async () => {
    const blocks = [
      table(undefined, [
        [cell("r1c1", { rowspan: 2 }), cell("r1c2", { colspan: 2 })],
        [cell("r2c2"), cell("r2c3")],
        [cell("r3only")],
      ]),
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });
    // vMerge restart + continue for the rowspan.
    expect(xml).toContain('<w:vMerge w:val="restart"/>');
    expect(xml).toContain('<w:vMerge w:val="continue"/>');
    expect(xml).toContain('<w:gridSpan w:val="2"/>');
    // Rectangular: 3 rows each summing to gridCols=3 columns.
    expect((xml.match(/<w:tr>/g) ?? []).length).toBe(3);
  });

  it("clamps a pathological colspan and emits a budget note", async () => {
    const { xml, notes } = await serializeBlocks(
      [table(undefined, [[cell("boom", { colspan: 100000 })]])],
      { styleNames: noStyles }
    );
    expect(notes.some((n) => n.code === "table-geometry-clamped")).toBe(true);
    // Not driven to an oversized grid.
    expect((xml.match(/<w:gridCol/g) ?? []).length).toBeLessThanOrEqual(200);
  });

  it("G3b: source template emits the style ref and omits inline borders/shading", async () => {
    const { xml } = await serializeBlocks(
      [table(undefined, [[cell("h", { header: true })]])],
      { styleNames: noStyles, tableStyle: { source: "template", styleId: "ScrollTableNormal" } }
    );
    expect(xml).toContain('<w:tblStyle w:val="ScrollTableNormal"/>');
    expect(xml).toContain("<w:tblLook");
    expect(xml).not.toContain("<w:tblBorders>");
    // Header shading is suppressed under the template style.
    expect(xml).not.toContain("<w:shd");
  });

  it("G3b: source confluence (default) keeps the built-in grid + borders", async () => {
    const { xml } = await serializeBlocks([table(undefined, [[cell("x")]])], { styleNames: noStyles });
    expect(xml).toContain('<w:tblStyle w:val="TableGrid"/>');
    expect(xml).toContain("<w:tblBorders>");
  });
});

// ---------------------------------------------------------------------------
// dataTable tblPr child order (ECMA-376 §17.4.60 CT_TblPrBase)
// ---------------------------------------------------------------------------

describe("dataTable — tblPr schema child order (spec 006 G3)", () => {
  const row = "<w:tr><w:tc><w:tcPr/><w:p/></w:tc></w:tr>";

  it("confluence branch: tblBorders (seq 11) precedes tblLayout (seq 13) with fixed widths", () => {
    const xml = dataTable(2, row, { widthsDxa: [3000, 6000] });
    expect(xml).toContain('<w:tblLayout w:type="fixed"/>');
    // Relative order, not mere presence — a strict CT_TblPrBase validator rejects
    // tblLayout before tblBorders.
    expect(xml.indexOf("<w:tblBorders>")).toBeGreaterThan(-1);
    expect(xml.indexOf("<w:tblBorders>")).toBeLessThan(xml.indexOf("<w:tblLayout"));
    // tblStyle (seq 1) and tblW (seq 7) still precede tblBorders (seq 11).
    expect(xml.indexOf("<w:tblStyle")).toBeLessThan(xml.indexOf("<w:tblW"));
    expect(xml.indexOf("<w:tblW")).toBeLessThan(xml.indexOf("<w:tblBorders>"));
  });

  it("template branch: tblStyle < tblW < tblLayout < tblLook (ascending seq)", () => {
    const xml = dataTable(2, row, {
      widthsDxa: [3000, 6000],
      tableStyle: { source: "template", styleId: "ScrollTableNormal" },
    });
    const iStyle = xml.indexOf('<w:tblStyle w:val="ScrollTableNormal"/>');
    const iW = xml.indexOf("<w:tblW");
    const iLayout = xml.indexOf("<w:tblLayout");
    const iLook = xml.indexOf("<w:tblLook");
    expect(iStyle).toBeGreaterThan(-1);
    expect(iStyle).toBeLessThan(iW);
    expect(iW).toBeLessThan(iLayout);
    expect(iLayout).toBeLessThan(iLook);
  });

  it("keeps every fallback grid track positive for a schema-valid sub-pixel authored width", () => {
    const xml = dataTable(2, row, { widthDxa: 1 });
    expect(xml).toContain('<w:tblW w:w="1" w:type="dxa"/>');
    expect(xml.match(/<w:gridCol w:w="1"\/>/g)).toHaveLength(2);
    expect(xml).not.toContain('<w:gridCol w:w="0"/>');
  });
});
