import { describe, expect, it } from "bun:test";
import {
  paragraphText,
  rewriteParagraphText,
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
