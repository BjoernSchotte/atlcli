/**
 * spec 004 defense-in-depth: DOCX's HYPERLINK field builder re-checks the URL
 * scheme itself (control chars stripped before detection), so a bypassed or
 * future converter can never emit a live javascript:/file: field. Unsafe URLs
 * degrade to the plain inner runs — text survives, target does not.
 */
import { describe, expect, it, test } from "bun:test";
import type { ExportBlock } from "@atlcli/confluence";
import { hyperlinkField, isSafeHyperlinkUrl } from "./ooxml.js";
import { serializeBlocks } from "./serialize.js";

describe("isSafeHyperlinkUrl", () => {
  test("allows http/https/mailto/relative", () => {
    expect(isSafeHyperlinkUrl("https://x.com")).toBe(true);
    expect(isSafeHyperlinkUrl("http://x.com")).toBe(true);
    expect(isSafeHyperlinkUrl("mailto:a@b.com")).toBe(true);
    expect(isSafeHyperlinkUrl("/wiki/My Page")).toBe(true);
  });

  test("rejects javascript:/file: including control-char-embedded forms", () => {
    expect(isSafeHyperlinkUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHyperlinkUrl("java\tscript:alert(1)")).toBe(false);
    expect(isSafeHyperlinkUrl("java\nscript:alert(1)")).toBe(false);
    expect(isSafeHyperlinkUrl("java\rscript:alert(1)")).toBe(false);
    expect(isSafeHyperlinkUrl(" javascript:alert(1)")).toBe(false);
    expect(isSafeHyperlinkUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeHyperlinkUrl("fi\tle:///x")).toBe(false);
    expect(isSafeHyperlinkUrl("")).toBe(false);
  });
});

describe("hyperlinkField", () => {
  test("unsafe URL degrades to the inner runs (no field code)", () => {
    const runs = `<w:r><w:t>click</w:t></w:r>`;
    const out = hyperlinkField("java\tscript:alert(1)", runs);
    expect(out).toBe(runs);
    expect(out).not.toContain("HYPERLINK");
  });

  test("safe URL still produces a field", () => {
    const out = hyperlinkField("https://example.com", `<w:r><w:t>ok</w:t></w:r>`);
    expect(out).toContain("HYPERLINK");
    expect(out).toContain("https://example.com");
  });
});

describe("DOCX serializer — external link with a smuggled scheme", () => {
  it("keeps the link text but emits no HYPERLINK field", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "paragraph",
        content: [
          {
            type: "link",
            target: { kind: "external", href: "java\tscript:alert(1)" },
            content: [{ type: "text", text: "evil-link" }],
          },
          {
            type: "link",
            target: { kind: "external", href: "https://good.example.com" },
            content: [{ type: "text", text: "good-link" }],
          },
        ],
      },
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: new Map() });
    expect(xml).toContain("evil-link");
    expect(xml).not.toContain("script:alert");
    expect(xml).toContain("good-link");
    expect(xml).toContain("https://good.example.com");
  });
});
