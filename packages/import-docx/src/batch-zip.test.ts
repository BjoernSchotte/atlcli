import { describe, expect, it } from "bun:test";
import PizZip from "pizzip";
import { extractDocxEntriesFromZip } from "./batch-zip.js";
import { collectFileLinkRefs } from "./split.js";
import { parseDocx } from "./parse.js";
import { documentToAdf } from "./adf.js";
import { buildDocxFixture, hyperlinkRel, p, r } from "./test-support.js";

function outerZip(entries: Record<string, Uint8Array | string>): Uint8Array {
  const zip = new PizZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  return zip.generate({ type: "uint8array" }) as Uint8Array;
}

describe("extractDocxEntriesFromZip", () => {
  const docx = buildDocxFixture({ body: p(r("hello")) });

  it("extracts sorted .docx entries and ignores other files", () => {
    const entries = extractDocxEntriesFromZip(
      outerZip({
        "z-later.docx": docx,
        "guides/admin.docx": docx,
        "readme.txt": "ignore me",
        "~$temp.docx": docx,
      }),
    );
    expect(entries.map((e) => e.path)).toEqual(["guides/admin.docx", "z-later.docx"]);
    // Extracted bytes still parse through the normal DOCX preflight.
    expect(parseDocx(entries[0].bytes).blocks).toHaveLength(1);
  });

  it("rejects traversal entry names, non-zip bytes, and docx-free archives", () => {
    expect(() => extractDocxEntriesFromZip(outerZip({ "../escape.docx": docx }))).toThrow();
    expect(() => extractDocxEntriesFromZip(new TextEncoder().encode("nope"))).toThrow(/valid ZIP/);
    expect(() => extractDocxEntriesFromZip(outerZip({ "only.txt": "x" }))).toThrow(/no .docx/);
  });
});

describe("cross-file links (plan 010)", () => {
  it("parses relative .docx hyperlinks as fileLink marks and resolves them at encode time", () => {
    const bytes = buildDocxFixture({
      body: p(`<w:hyperlink r:id="rId9">${r("see the admin guide")}</w:hyperlink>`),
      documentRels: hyperlinkRel("rId9", "guides/admin.docx#section_2"),
    });
    const doc = parseDocx(bytes);
    expect(doc.issues).toHaveLength(0);
    const para = doc.blocks[0];
    if (para.type !== "paragraph") throw new Error("expected paragraph");
    expect(para.runs[0]).toMatchObject({
      marks: { fileLink: { path: "guides/admin.docx", anchor: "section_2" } },
    });
    expect([...collectFileLinkRefs(doc.blocks)]).toEqual(["guides/admin.docx"]);

    // Unresolved: plain text. Resolved: a real link.
    const plain = documentToAdf(doc);
    expect(JSON.stringify(plain)).not.toContain('"link"');
    const resolved = documentToAdf(doc, {
      fileLinks: new Map([["guides/admin.docx", "https://example.net/wiki/pages/1"]]),
    });
    expect(JSON.stringify(resolved)).toContain("https://example.net/wiki/pages/1");
  });

  it("still rejects genuinely unsafe schemes", () => {
    const bytes = buildDocxFixture({
      body: p(`<w:hyperlink r:id="rId9">${r("evil")}</w:hyperlink>`),
      documentRels: hyperlinkRel("rId9", "javascript:alert(1)"),
    });
    const doc = parseDocx(bytes);
    expect(doc.issues.some((i) => i.code === "docx-import/unsafe-link-scheme-dropped")).toBe(true);
  });
});
