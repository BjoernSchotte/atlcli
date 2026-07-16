import { describe, expect, it } from "bun:test";
import {
  collectDrawingTexts,
  collectParagraphTexts,
  paragraphText,
  rewriteDrawingText,
  rewriteParagraphText,
  rewriteScrollText,
  splitParagraphs,
} from "./ooxml-text.js";
import {
  chartTitlePart,
  complexFieldResult,
  crossBoundarySplitPara,
  fldSimpleResult,
  smartArtTitlePara,
} from "./fixtures.js";

/** A tiny placeholder transform for the tests. */
const values = new Map<string, string>([
  ["$scroll.title", "My Title"],
  ["$scroll.version", "7"],
]);
const replace = (text: string): string =>
  text.replace(/\$scroll\.[A-Za-z]+/g, (m) => values.get(m) ?? "");

describe("rewriteParagraphText — run boundaries (#8)", () => {
  it("merges a placeholder split across same-format runs but preserves breaks and per-run formatting", () => {
    // Run 1 (normal): "Title: $scr" | "oll.title"  — split across two runs.
    // Then a hard <w:br/>, then run 3 (italic): "Version: $scroll.version".
    const para =
      `<w:p>` +
      `<w:r><w:t xml:space="preserve">Title: $scr</w:t></w:r>` +
      `<w:r><w:t xml:space="preserve">oll.title</w:t></w:r>` +
      `<w:r><w:br/></w:r>` +
      `<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">Version: $scroll.version</w:t></w:r>` +
      `</w:p>`;

    const out = rewriteParagraphText(para, replace);

    // Correct replacement of BOTH placeholders (the split one was merged).
    expect(out).toContain("Title: My Title");
    expect(out).toContain("Version: 7");
    // No cross-break fusion: `$scroll.titleVersion` never formed.
    expect(out).not.toContain("$scroll.");
    expect(out).not.toContain("MyTitleVersion");
    // The break survives.
    expect(out).toContain("<w:br/>");
    // The italic run's formatting survives (still wraps the Version text run).
    expect(out).toContain("<w:rPr><w:i/></w:rPr>");
    expect(out.indexOf("<w:i/>")).toBeLessThan(out.indexOf("Version: 7"));
  });

  it("does not fuse text across a hard break for detection either", () => {
    const para =
      `<w:p><w:r><w:t>a $scroll.title</w:t></w:r><w:r><w:br/></w:r>` +
      `<w:r><w:t>Version b</w:t></w:r></w:p>`;
    expect(paragraphText(para)).toBe("a $scroll.title\nVersion b");
  });

  it("leaves a paragraph with no placeholder untouched", () => {
    const para = `<w:p><w:r><w:t>plain text</w:t></w:r></w:p>`;
    expect(rewriteParagraphText(para, replace)).toBe(para);
  });
});

describe("splitParagraphs — nested (text-box) paragraphs", () => {
  it("returns the OUTER paragraph whole when it nests a text-box paragraph", () => {
    // The non-greedy regex used to stop at the inner </w:p>, cutting the outer
    // paragraph (and the trailing run) off.
    const xml =
      `<w:p><w:r><w:drawing><wps:txbx><w:txbxContent>` +
      `<w:p><w:r><w:t>inner</w:t></w:r></w:p>` +
      `</w:txbxContent></wps:txbx></w:drawing></w:r>` +
      `<w:r><w:t>$scroll.title</w:t></w:r></w:p>`;
    const paras = splitParagraphs(xml);
    expect(paras).toHaveLength(1);
    expect(paras[0]).toBe(xml);
    // The trailing run survives inside the single captured paragraph.
    expect(paras[0]).toContain("$scroll.title");
  });
});

describe("rewriteScrollText — text-box descent (shape a)", () => {
  // Title inside a text box, provided twice via mc:AlternateContent.
  const txbxTitle =
    `<w:p w14:paraId="6C4FCF91"><w:r><mc:AlternateContent>` +
    `<mc:Choice Requires="wps"><w:drawing><wps:txbx><w:txbxContent>` +
    `<w:p><w:pPr><w:pStyle w:val="Heading1TOC"/></w:pPr>` +
    `<w:r w:rsidRPr="00372A13"><w:t>$scroll.title</w:t></w:r></w:p>` +
    `</w:txbxContent></wps:txbx></w:drawing></mc:Choice>` +
    `<mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent>` +
    `<w:p><w:pPr><w:pStyle w:val="Heading1TOC"/></w:pPr>` +
    `<w:r><w:t>$scroll.title</w:t></w:r></w:p>` +
    `</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback>` +
    `</mc:AlternateContent></w:r></w:p>`;

  it("resolves the placeholder in BOTH the Choice and the Fallback copy", () => {
    const out = rewriteScrollText(txbxTitle, replace);
    expect(out).not.toContain("$scroll.title");
    // Both text-box copies show the resolved value (Word renders whichever it
    // supports, so both must be correct).
    expect((out.match(/My Title/g) ?? []).length).toBe(2);
    // Structure preserved: both txbxContent regions restored, styles intact.
    expect((out.match(/<w:txbxContent>/g) ?? []).length).toBe(2);
    expect(out).toContain('<w:pStyle w:val="Heading1TOC"/>');
    // No sentinel leaks (the sentinel body is `txbx0`, `txbx1`, … — distinct
    // from the legitimate `txbxContent` element name).
    expect(out).not.toContain("txbx0");
    expect(out).not.toContain("txbx1");
    expect(out).not.toContain("");
  });

  it("scan-side collectParagraphTexts sees each text-box title independently", () => {
    const texts = collectParagraphTexts(txbxTitle);
    const titleTexts = texts.filter((t) => t.includes("$scroll.title"));
    expect(titleTexts).toHaveLength(2); // Choice + Fallback
    // Not fused with anything else.
    for (const t of titleTexts) expect(t).toBe("$scroll.title");
  });
});

describe("rewriteScrollText — drawing-adjacent clean run (shape b)", () => {
  it("resolves a clean run that trails a picture run in the same paragraph", () => {
    const para =
      `<w:p>` +
      `<w:r><w:pict><v:shape><v:textbox><w:txbxContent>` +
      `<w:p><w:r><w:t>logo</w:t></w:r></w:p>` +
      `</w:txbxContent></v:textbox></v:shape></w:pict></w:r>` +
      `<w:r w:rsidR="003D31B6"><w:t>$scroll.title</w:t></w:r></w:p>`;
    const out = rewriteScrollText(para, replace);
    expect(out).not.toContain("$scroll.title");
    expect(out).toContain("My Title");
    // The picture run (its <w:pict>) is untouched.
    expect(out).toContain("<w:pict>");
    expect(out).toContain("logo");
    expect(out).not.toContain("");
  });

  it("keeps the #8 no-fuse guarantee: a drawing run is a non-mergeable boundary", () => {
    // A placeholder is NOT formed by fusing text across the drawing run.
    const para =
      `<w:p>` +
      `<w:r><w:t>$scroll</w:t></w:r>` +
      `<w:r><w:drawing><wps:txbx><w:txbxContent><w:p><w:r><w:t>x</w:t></w:r></w:p></w:txbxContent></wps:txbx></w:drawing></w:r>` +
      `<w:r><w:t>.title</w:t></w:r></w:p>`;
    const out = rewriteScrollText(para, replace);
    // `$scroll` + `.title` across the drawing did NOT merge into `$scroll.title`.
    expect(out).toContain("$scroll");
    expect(out).toContain(".title");
    expect(out).not.toContain("My Title");
  });
});

describe("rewriteDrawingText — DrawingML <a:t> runs (shape ①)", () => {
  it("resolves a placeholder split across adjacent <a:t> runs in one <a:p>", () => {
    // smartArtTitlePara splits `$scroll.title` across two <a:t> runs.
    const dml = smartArtTitlePara("$scroll.title");
    expect((dml.match(/<a:t\b/g) ?? []).length).toBe(2); // sanity: it IS split
    const out = rewriteDrawingText(dml, replace);
    expect(out).toContain("<a:t>My Title</a:t>");
    // Second run emptied, not duplicated.
    expect(out).toContain("<a:t></a:t>");
    expect(out).not.toContain("$scroll");
  });

  it("resolves the title inside a chart <c:tx><c:rich> part, leaving structure intact", () => {
    const out = rewriteScrollText(chartTitlePart("$scroll.title"), replace);
    expect(out).not.toContain("$scroll");
    expect(out).toContain("My Title");
    // Structural chart DrawingML is untouched.
    expect(out).toContain("<c:plotArea>");
    expect(out).toContain("<a:bodyPr/>");
  });

  it("does NOT fuse <a:t> text across an <a:br/> break", () => {
    const dml =
      `<a:p><a:r><a:t>$scroll</a:t></a:r><a:br/><a:r><a:t>.title</a:t></a:r></a:p>`;
    const out = rewriteDrawingText(dml, replace);
    expect(out).toContain("$scroll");
    expect(out).toContain(".title");
    expect(out).not.toContain("My Title");
  });

  it("collectDrawingTexts reads each <a:p> and breaks on <a:br/> so no placeholder spans it", () => {
    const merged = collectDrawingTexts(smartArtTitlePara("$scroll.title"));
    expect(merged).toEqual(["$scroll.title"]);
    const broken = collectDrawingTexts(
      `<a:p><a:r><a:t>$scroll</a:t></a:r><a:br/><a:r><a:t>.title</a:t></a:r></a:p>`
    );
    expect(broken).toEqual(["$scroll\n.title"]);
  });

  it("collectParagraphTexts surfaces chart <a:t> text for the scan", () => {
    const texts = collectParagraphTexts(chartTitlePart("$scroll.title"));
    expect(texts).toContain("$scroll.title");
  });
});

describe("rewriteScrollText — field codes (shape ②)", () => {
  it("resolves the cached RESULT of a <w:fldSimple> but never its w:instr instruction", () => {
    const para = fldSimpleResult(" DOCPROPERTY $scroll.title ", "$scroll.title");
    const out = rewriteScrollText(para, replace);
    // Displayed result resolved.
    expect(out).toContain("<w:t xml:space=\"preserve\">My Title</w:t>");
    // The field INSTRUCTION attribute is left byte-for-byte intact.
    expect(out).toContain('w:instr=" DOCPROPERTY $scroll.title "');
  });

  it("resolves a complex field's cached result (split across runs) but never its <w:instrText>", () => {
    const para = complexFieldResult(" REF $scroll.title ", "$scroll.title");
    const out = rewriteScrollText(para, replace);
    // Cached result (split across two <w:t>) merged + resolved.
    expect(out).toContain("My Title");
    // The instruction is untouched, and the field frame survives.
    expect(out).toContain("<w:instrText xml:space=\"preserve\"> REF $scroll.title </w:instrText>");
    expect(out).toContain('<w:fldChar w:fldCharType="begin"/>');
    expect(out).toContain('<w:fldChar w:fldCharType="separate"/>');
    expect(out).toContain('<w:fldChar w:fldCharType="end"/>');
  });

  it("scan counts only the field RESULT, not the instruction text", () => {
    // paragraphText reads <w:t> bodies only — never w:instr / <w:instrText> — so a
    // placeholder that appears in BOTH is counted once (the displayed result).
    const texts = collectParagraphTexts(fldSimpleResult(" DOCPROPERTY $scroll.title ", "$scroll.title"));
    expect(texts).toEqual(["$scroll.title"]);
  });
});

describe("rewriteScrollText — text-box story boundary is NOT crossed (shape ③)", () => {
  it("never fuses an outer run's $scr with an inner text-box run's oll.title", () => {
    // A text box is a SEPARATE story; a word cannot be half in the main flow and
    // half inside a floating box in real authoring. Merging across that boundary
    // would corrupt output, so the extractor must keep both fragments literal.
    const para = crossBoundarySplitPara("$scr", "oll.title");
    const out = rewriteScrollText(para, replace);
    // Neither fragment resolved; no fused `$scroll.title` ever formed.
    expect(out).toContain(">$scr<");
    expect(out).toContain(">oll.title<");
    expect(out).not.toContain("My Title");

    // Scan side agrees: the two stories are separate texts, never one fused string.
    const texts = collectParagraphTexts(para);
    expect(texts).toContain("$scr");
    expect(texts).toContain("oll.title");
    expect(texts).not.toContain("$scroll.title");
  });
});
