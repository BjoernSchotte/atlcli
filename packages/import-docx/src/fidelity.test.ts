import { describe, expect, it } from "bun:test";
import PizZip from "pizzip";
import { parseDocx } from "./parse.js";
import { documentToAdf } from "./adf.js";
import { DEFAULT_STYLES, buildDocxFixture, p, r } from "./test-support.js";

const STYLES_WITH_QUOTE_AND_CODE = DEFAULT_STYLES.replace(
  "</w:styles>",
  `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/></w:style>
   <w:style w:type="paragraph" w:styleId="Zitat"><w:name w:val="Zitat"/></w:style>
   <w:style w:type="paragraph" w:styleId="SourceCode"><w:name w:val="Source Code"/></w:style>
</w:styles>`,
);

function withFootnotes(bytes: Uint8Array, footnotesXml: string): Uint8Array {
  const zip = new PizZip(bytes);
  zip.file("word/footnotes.xml", footnotesXml);
  return zip.generate({ type: "uint8array" }) as Uint8Array;
}

describe("blockquotes and code blocks", () => {
  it("groups consecutive quote paragraphs (incl. localized style) into one blockquote", () => {
    const doc = parseDocx(
      buildDocxFixture({
        body:
          p(r("before")) +
          p(r("first quoted line"), { style: "Quote" }) +
          p(r("second quoted line"), { style: "Zitat" }) +
          p(r("after")),
        styles: STYLES_WITH_QUOTE_AND_CODE,
      }),
    );
    expect(doc.blocks.map((b) => b.type)).toEqual(["paragraph", "blockquote", "paragraph"]);
    const quote = doc.blocks[1];
    if (quote.type !== "blockquote") throw new Error("expected blockquote");
    expect(quote.blocks).toHaveLength(2);

    const adf = documentToAdf(doc);
    expect(adf.content[1].type).toBe("blockquote");
    expect(adf.content[1].content?.[0].type).toBe("paragraph");
  });

  it("merges consecutive code paragraphs into one codeBlock with line breaks", () => {
    const doc = parseDocx(
      buildDocxFixture({
        body:
          p(r("const a = 1;"), { style: "SourceCode" }) +
          p(r("const b = 2;"), { style: "SourceCode" }) +
          p(r("prose")),
        styles: STYLES_WITH_QUOTE_AND_CODE,
      }),
    );
    expect(doc.blocks.map((b) => b.type)).toEqual(["code", "paragraph"]);
    const code = doc.blocks[0];
    if (code.type !== "code") throw new Error("expected code");
    expect(code.text).toBe("const a = 1;\nconst b = 2;");

    const adf = documentToAdf(doc);
    expect(adf.content[0]).toEqual({
      type: "codeBlock",
      attrs: {},
      content: [{ type: "text", text: "const a = 1;\nconst b = 2;" }],
    });
  });
});

describe("footnotes", () => {
  const FOOTNOTES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:type="separator" w:id="-1"><w:p/></w:footnote>
  <w:footnote w:id="2"><w:p><w:r><w:t>Second note.</w:t></w:r></w:p></w:footnote>
  <w:footnote w:id="1"><w:p><w:r><w:t>First note.</w:t></w:r></w:p></w:footnote>
</w:footnotes>`;

  it("numbers footnotes in reference order and appends their content", () => {
    const bytes = withFootnotes(
      buildDocxFixture({
        body:
          p(r("Claim A") + `<w:r><w:footnoteReference w:id="2"/></w:r>`) +
          p(r("Claim B") + `<w:r><w:footnoteReference w:id="1"/></w:r>`),
      }),
      FOOTNOTES,
    );
    const doc = parseDocx(bytes);
    const json = JSON.stringify(doc.blocks);
    // Inline markers by reference order: id=2 was referenced first → [1].
    expect(json).toContain('"Claim A"');
    expect(doc.blocks).toHaveLength(4); // 2 body + 2 footnote paragraphs
    const flat = (i: number) =>
      (doc.blocks[i] as { runs: { kind: string; text?: string }[] }).runs
        .map((run) => run.text ?? "\n")
        .join("");
    expect(flat(0)).toBe("Claim A[1]");
    expect(flat(1)).toBe("Claim B[2]");
    expect(flat(2)).toBe("[1] Second note.");
    expect(flat(3)).toBe("[2] First note.");
    expect(doc.issues.some((i) => i.code === "docx-import/footnotes-appended")).toBe(true);
  });

  it("reports references to missing footnote definitions", () => {
    const doc = parseDocx(
      buildDocxFixture({ body: p(`<w:r><w:footnoteReference w:id="99"/></w:r>` + r("x")) }),
    );
    expect(doc.issues.some((i) => i.code === "docx-import/footnote-missing")).toBe(true);
  });

  it("ignores unreferenced footnote definitions", () => {
    const bytes = withFootnotes(buildDocxFixture({ body: p(r("no refs here")) }), FOOTNOTES);
    const doc = parseDocx(bytes);
    expect(doc.blocks).toHaveLength(1);
    expect(doc.issues).toHaveLength(0);
  });
});
