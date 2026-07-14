import { describe, expect, it } from "bun:test";
import {
  collectParagraphTexts,
  paragraphText,
  rewriteParagraphText,
  rewriteScrollText,
  splitParagraphs,
} from "../../utils/docx/ooxml-text.js";

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
