import { describe, expect, it } from "bun:test";
import { parseDocx } from "./parse.js";
import { buildDocxFixture, hyperlinkRel, p, r } from "./test-support.js";
import type { ImportBlock, ImportListBlock } from "./model.js";

function heading(block: ImportBlock): asserts block is Extract<ImportBlock, { type: "heading" }> {
  expect(block.type).toBe("heading");
}

describe("parseDocx", () => {
  it("maps heading styles by outline level including localized names", () => {
    const bytes = buildDocxFixture({
      body:
        p(r("Title"), { style: "Heading1" }) +
        p(r("Section"), { style: "Heading2" }) +
        p(r("Unterabschnitt"), { style: "Ueberschrift3" }) +
        p(r("Body text")),
    });
    const doc = parseDocx(bytes);
    expect(doc.blocks.map((b) => b.type)).toEqual(["heading", "heading", "heading", "paragraph"]);
    heading(doc.blocks[0]);
    heading(doc.blocks[1]);
    heading(doc.blocks[2]);
    expect(doc.blocks[0].level).toBe(1);
    expect(doc.blocks[1].level).toBe(2);
    expect(doc.blocks[2].level).toBe(3);
    expect(doc.titleCandidate).toBe("Title");
  });

  it("preserves bold/italic marks and external hyperlinks", () => {
    const bytes = buildDocxFixture({
      body: p(
        r("plain ") +
          r("bold", { bold: true }) +
          `<w:hyperlink r:id="rId9">${r("docs")}</w:hyperlink>`,
      ),
      documentRels: hyperlinkRel("rId9", "https://example.com/docs"),
    });
    const doc = parseDocx(bytes);
    const para = doc.blocks[0];
    expect(para.type).toBe("paragraph");
    if (para.type !== "paragraph") throw new Error("unreachable");
    expect(para.runs).toEqual([
      { kind: "text", text: "plain ", marks: undefined },
      { kind: "text", text: "bold", marks: { bold: true } },
      { kind: "text", text: "docs", marks: { link: { href: "https://example.com/docs" } } },
    ]);
  });

  it("keeps unsafe link schemes as plain text with a reported issue", () => {
    const bytes = buildDocxFixture({
      body: p(`<w:hyperlink r:id="rId9">${r("evil")}</w:hyperlink>`),
      documentRels: hyperlinkRel("rId9", "javascript:alert(1)"),
    });
    const doc = parseDocx(bytes);
    const para = doc.blocks[0];
    if (para.type !== "paragraph") throw new Error("expected paragraph");
    expect(para.runs[0]).toEqual({ kind: "text", text: "evil", marks: undefined });
    expect(doc.issues.some((i) => i.code === "docx-import/unsafe-link-scheme-dropped")).toBe(true);
  });

  it("groups consecutive numbered paragraphs into nested lists with ordered detection", () => {
    const bytes = buildDocxFixture({
      body:
        p(r("first"), { numId: "2", ilvl: 0 }) +
        p(r("nested a"), { numId: "2", ilvl: 1 }) +
        p(r("nested b"), { numId: "2", ilvl: 1 }) +
        p(r("second"), { numId: "2", ilvl: 0 }) +
        p(r("after list")) +
        p(r("bullet"), { numId: "1", ilvl: 0 }),
    });
    const doc = parseDocx(bytes);
    expect(doc.blocks.map((b) => b.type)).toEqual(["list", "paragraph", "list"]);

    const ordered = doc.blocks[0] as ImportListBlock;
    expect(ordered.ordered).toBe(true);
    expect(ordered.items).toHaveLength(2);
    const nested = ordered.items[0].child;
    expect(nested?.ordered).toBe(true);
    expect(nested?.items).toHaveLength(2);

    const bullets = doc.blocks[2] as ImportListBlock;
    expect(bullets.ordered).toBe(false);
  });

  it("parses tables with header rows and flattens nested tables with an issue", () => {
    const cell = (inner: string, header = false) =>
      `<w:tc>${header ? "" : ""}${inner}</w:tc>`;
    const headerRow = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${cell(p(r("H1")))}${cell(p(r("H2")))}</w:tr>`;
    const nestedTbl = `<w:tbl><w:tr>${cell(p(r("inner")))}</w:tr></w:tbl>`;
    const dataRow = `<w:tr>${cell(p(r("A")))}${cell(nestedTbl + p(r("B")))}</w:tr>`;
    const bytes = buildDocxFixture({ body: `<w:tbl>${headerRow}${dataRow}</w:tbl>` });

    const doc = parseDocx(bytes);
    const table = doc.blocks[0];
    if (table.type !== "table") throw new Error("expected table");
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0].cells.every((c) => c.header)).toBe(true);
    expect(table.rows[1].cells.every((c) => !c.header)).toBe(true);
    // Nested table flattened into the outer cell.
    const nestedCellText = JSON.stringify(table.rows[1].cells[1].blocks);
    expect(nestedCellText).toContain("inner");
    expect(doc.issues.some((i) => i.code === "docx-import/nested-table-flattened")).toBe(true);
  });

  it("reports images, comments, and deletions instead of silently dropping them", () => {
    const bytes = buildDocxFixture({
      body:
        p(`<w:r><w:drawing/></w:r>` + r("text")) +
        p(`<w:r><w:commentReference w:id="1"/></w:r>`) +
        p(`<w:del><w:r><w:delText>gone</w:delText></w:r></w:del>` + r("kept")),
    });
    const doc = parseDocx(bytes);
    const codes = doc.issues.map((i) => i.code);
    expect(codes).toContain("docx-import/image-not-supported");
    expect(codes).toContain("docx-import/comment-dropped");
    expect(codes).toContain("docx-import/revision-deletion-dropped");
    // Deleted text must not appear anywhere in the parsed content.
    expect(JSON.stringify(doc.blocks)).not.toContain("gone");
    expect(JSON.stringify(doc.blocks)).toContain("kept");
  });

  it("deduplicates repeated issues into one entry with an occurrence count", () => {
    const bytes = buildDocxFixture({
      body: p(`<w:r><w:drawing/></w:r><w:r><w:drawing/></w:r><w:r><w:drawing/></w:r>`),
    });
    const doc = parseDocx(bytes);
    const imageIssues = doc.issues.filter((i) => i.code === "docx-import/image-not-supported");
    expect(imageIssues).toHaveLength(1);
    expect(imageIssues[0].context?.occurrences).toBe(3);
  });

  it("rejects packages that are not DOCX", () => {
    expect(() => parseDocx(new TextEncoder().encode("not a zip"))).toThrow();
  });

  it("rejects XML with DOCTYPE declarations", () => {
    const bytes = buildDocxFixture({ body: p(r("x")) });
    // Rebuild with a poisoned styles part.
    const PizZip = require("pizzip");
    const zip = new PizZip(bytes);
    zip.file(
      "word/styles.xml",
      `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY x "y">]><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`,
    );
    const poisoned = zip.generate({ type: "uint8array" }) as Uint8Array;
    expect(() => parseDocx(poisoned)).toThrow(/DOCTYPE/);
  });
});
