import { describe, expect, it } from "bun:test";
import type { ExportBlock } from "@atlcli/confluence/browser";
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
});

describe("serializeBlocks — heading style mapping", () => {
  const heading: ExportBlock[] = [{ type: "heading", level: 2, content: [{ type: "text", text: "H2" }] }];

  it("uses Scroll Heading N when present", async () => {
    const styles = parseStyleNames(stylesXml(headingStyle("ScrollHeading2Id", "Scroll Heading 2")));
    const { xml } = await serializeBlocks(heading, { styleNames: styles });
    expect(xml).toContain('<w:pStyle w:val="ScrollHeading2Id"/>');
  });

  it("falls back to Heading N", async () => {
    const styles = parseStyleNames(stylesXml(headingStyle("Heading2", "Heading 2")));
    const { xml } = await serializeBlocks(heading, { styleNames: styles });
    expect(xml).toContain('<w:pStyle w:val="Heading2"/>');
  });

  it("falls back to the builtin HeadingN id when the template has neither", async () => {
    const { xml } = await serializeBlocks(heading, { styleNames: noStyles });
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
