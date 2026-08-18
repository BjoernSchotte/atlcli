import { describe, expect, it } from "bun:test";
import { documentToStorage, storageTagSequence } from "@atlcli/import-core";
import { parseDocx } from "./parse.js";
import {
  DEFAULT_STYLES,
  TINY_PNG,
  buildDocxFixture,
  drawing,
  hyperlinkRel,
  imageRel,
  p,
  r,
} from "./test-support.js";

describe("documentToStorage", () => {
  it("encodes the full feature set as valid Storage XHTML", () => {
    const styles = DEFAULT_STYLES.replace(
      "</w:styles>",
      `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/></w:style>
       <w:style w:type="paragraph" w:styleId="SourceCode"><w:name w:val="Source Code"/></w:style></w:styles>`,
    );
    const doc = parseDocx(
      buildDocxFixture({
        body:
          p(r("Title &lt;with&gt; &amp; chars"), { style: "Heading1" }) +
          p(r("bold", { bold: true }) + `<w:hyperlink r:id="rId9">${r("a link")}</w:hyperlink>`) +
          p(r("item"), { numId: "2" }) +
          `<w:tbl><w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc>${p(r("H"))}</w:tc></w:tr><w:tr><w:tc>${p(r("C"))}</w:tc></w:tr></w:tbl>` +
          p(drawing("rId7", { descr: "dot", cx: 952500 })) +
          p(r("quoted"), { style: "Quote" }) +
          p(r("const x = ]]&gt; tricky;"), { style: "SourceCode" }),
        styles,
        documentRels: hyperlinkRel("rId9", "https://example.com/"),
        parts: { "word/media/image1.png": TINY_PNG },
      }).slice(),
    );
    // Re-add image rel: build again with imageRel included.
    const doc2 = parseDocx(
      buildDocxFixture({
        body: p(drawing("rId7", { descr: "dot", cx: 952500 })),
        documentRels: imageRel("rId7", "media/image1.png"),
        parts: { "word/media/image1.png": TINY_PNG },
      }),
    );

    const storage = documentToStorage(doc);
    expect(storage).toContain("<h1>Title &lt;with&gt; &amp; chars</h1>");
    expect(storage).toContain("<strong>bold</strong>");
    expect(storage).toContain('<a href="https://example.com/">a link</a>');
    expect(storage).toContain("<ol><li><p>item</p></li></ol>");
    expect(storage).toContain("<table><tbody><tr><th><p>H</p></th></tr><tr><td><p>C</p></td></tr></tbody></table>");
    expect(storage).toContain("<blockquote><p>quoted</p></blockquote>");
    expect(storage).toContain('<ac:structured-macro ac:name="code">');
    expect(storage).toContain("]]]]><![CDATA[>"); // CDATA-safe escaping

    const imageStorage = documentToStorage(doc2);
    expect(imageStorage).toBe(
      '<ac:image ac:alt="dot" ac:width="100"><ri:attachment ri:filename="image1.png"/></ac:image>',
    );
  });

  it("numbered heading labels become literal heading text", () => {
    const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="5"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1"/></w:lvl></w:abstractNum>
  <w:num w:numId="10"><w:abstractNumId w:val="5"/></w:num>
</w:numbering>`;
    const doc = parseDocx(
      buildDocxFixture({
        body: p(r("Einleitung"), { style: "Heading1", numId: "10" }) + p(r("text")),
        numbering,
      }),
    );
    expect(documentToStorage(doc)).toContain("<h1>1 Einleitung</h1>");
  });

  it("storageTagSequence fingerprints the structural tag order", () => {
    const seq = storageTagSequence(
      '<h1>t</h1><p>x</p><ul><li><p>i</p></li></ul><ac:image ac:alt="a"><ri:attachment ri:filename="f.png"/></ac:image>',
    );
    expect(seq).toEqual(["h1", "p", "ul", "p", "ac:image"]);
  });
});
