import { describe, expect, it } from "bun:test";
import { documentToAdf } from "./adf.js";
import { buildImportPreview, renderImportPreview } from "./preview.js";
import { parseDocx } from "./parse.js";
import { buildDocxFixture, hyperlinkRel, p, r } from "./test-support.js";

describe("documentToAdf", () => {
  it("encodes the full slice roundtrip fixture deterministically", () => {
    const bytes = buildDocxFixture({
      body:
        p(r("Doc Title"), { style: "Heading1" }) +
        p(r("bold", { bold: true }) + `<w:hyperlink r:id="rId9">${r("link")}</w:hyperlink>`) +
        p(r("item"), { numId: "1" }) +
        `<w:tbl><w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc>${p(r("H"))}</w:tc></w:tr><w:tr><w:tc>${p(r("C"))}</w:tc></w:tr></w:tbl>`,
      documentRels: hyperlinkRel("rId9", "https://example.com/"),
    });
    const doc = parseDocx(bytes);
    const adf = documentToAdf(doc);

    expect(adf.version).toBe(1);
    expect(adf.content.map((n) => n.type)).toEqual(["heading", "paragraph", "bulletList", "table"]);
    expect(adf.content[0].attrs).toEqual({ level: 1 });
    expect(adf.content[1].content?.[0].marks).toEqual([{ type: "strong" }]);
    expect(adf.content[1].content?.[1].marks).toEqual([
      { type: "link", attrs: { href: "https://example.com/" } },
    ]);
    expect(adf.content[3].content?.[0].content?.[0].type).toBe("tableHeader");
    expect(adf.content[3].content?.[1].content?.[0].type).toBe("tableCell");

    // Deterministic: same bytes → same ADF JSON.
    expect(JSON.stringify(documentToAdf(parseDocx(bytes)))).toBe(JSON.stringify(adf));
  });

  it("gives empty list items and cells a paragraph child (ADF minimums)", () => {
    const bytes = buildDocxFixture({
      body:
        p("", { numId: "1", ilvl: 1 }) +
        `<w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>`,
    });
    const adf = documentToAdf(parseDocx(bytes));
    const list = adf.content[0];
    const table = adf.content[1];
    for (const item of list.content ?? []) {
      expect(item.type).toBe("listItem");
      expect(item.content?.length ?? 0).toBeGreaterThan(0);
    }
    for (const row of table.content ?? []) {
      for (const cell of row.content ?? []) {
        expect(cell.content?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});

describe("preview", () => {
  it("builds a digest-bound preview and renders issues and outline", async () => {
    const bytes = buildDocxFixture({
      body:
        p(r("Title"), { style: "Heading1" }) +
        p(r("Sub"), { style: "Heading2" }) +
        p(`<w:r><w:drawing/></w:r>`),
    });
    const doc = parseDocx(bytes);
    const preview = await buildImportPreview(doc, { spaceKey: "DOCSY", title: "Title" });

    expect(preview.adfDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.outline).toEqual([
      { level: 1, text: "Title" },
      { level: 2, text: "Sub" },
    ]);

    const text = renderImportPreview(preview);
    expect(text).toContain("Space:  DOCSY");
    expect(text).toContain("H1 Title");
    expect(text).toContain("docx-import/image-not-supported");

    // Digest is stable for identical input.
    const again = await buildImportPreview(parseDocx(bytes), { spaceKey: "DOCSY", title: "Title" });
    expect(again.adfDigest).toBe(preview.adfDigest);
  });
});
