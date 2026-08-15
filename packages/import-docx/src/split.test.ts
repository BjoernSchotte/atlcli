import { describe, expect, it } from "bun:test";
import { parseDocx } from "./parse.js";
import { SplitTitleConflictError, collectAnchorRefs, countPages, splitDocument } from "./split.js";
import { TINY_PNG, buildDocxFixture, drawing, imageRel, p, r } from "./test-support.js";

const body =
  p(r("Preamble before any section.")) +
  p(r("Intro"), { style: "Heading1" }) +
  p(r("Intro text.")) +
  p(r("Background"), { style: "Heading2" }) +
  p(r("Background text.")) +
  p(drawing("rId7")) +
  p(r("Usage"), { style: "Heading1" }) +
  p(r("Usage text."));

const fixture = () =>
  buildDocxFixture({
    body,
    documentRels: imageRel("rId7", "media/image1.png"),
    parts: { "word/media/image1.png": TINY_PNG },
  });

describe("splitDocument", () => {
  it("splits at level 1: H1 sections become children, preamble stays on root", () => {
    const doc = parseDocx(fixture());
    const { root: tree } = splitDocument(doc, { level: 1, rootTitle: "Handbook" });

    expect(tree.title).toBe("Handbook");
    expect(tree.blocks.map((b) => b.type)).toEqual(["paragraph"]);
    expect(tree.children.map((c) => c.title)).toEqual(["Intro", "Usage"]);
    // The opening H1 is the title, not body content; the H2 stays inline.
    expect(tree.children[0].blocks.map((b) => b.type)).toEqual([
      "paragraph",
      "heading",
      "paragraph",
      "image",
    ]);
    expect(countPages(tree)).toBe(3);
    // Assets follow the blocks that reference them.
    expect(tree.assets).toHaveLength(0);
    expect(tree.children[0].assets.map((a) => a.fileName)).toEqual(["image1.png"]);
    expect(tree.children[1].assets).toHaveLength(0);
  });

  it("splits at level 2 into a nested tree", () => {
    const doc = parseDocx(fixture());
    const { root: tree } = splitDocument(doc, { level: 2, rootTitle: "Handbook" });

    expect(tree.children.map((c) => c.title)).toEqual(["Intro", "Usage"]);
    expect(tree.children[0].children.map((c) => c.title)).toEqual(["Background"]);
    expect(tree.children[0].children[0].blocks.map((b) => b.type)).toEqual([
      "paragraph",
      "image",
    ]);
    expect(countPages(tree)).toBe(4);
  });

  it("includes heading numbering labels in split page titles", () => {
    const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="5">
    <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="10"><w:abstractNumId w:val="5"/></w:num>
</w:numbering>`;
    const doc = parseDocx(
      buildDocxFixture({
        body:
          p(r("Einleitung"), { style: "Heading1", numId: "10" }) +
          p(r("Text 1")) +
          p(r("Anforderungen"), { style: "Heading1", numId: "10" }) +
          p(r("Text 2")),
        numbering,
      }),
    );
    const { root: tree } = splitDocument(doc, { level: 1, rootTitle: "Spec" });
    expect(tree.children.map((c) => c.title)).toEqual(["1 Einleitung", "2 Anforderungen"]);
  });

  it("rejects duplicate resulting titles before any publication", () => {
    const doc = parseDocx(
      buildDocxFixture({
        body:
          p(r("Setup"), { style: "Heading1" }) +
          p(r("text")) +
          p(r("setup"), { style: "Heading1" }) +
          p(r("more text")),
      }),
    );
    expect(() => splitDocument(doc, { level: 1, rootTitle: "Guide" })).toThrow(
      SplitTitleConflictError,
    );
  });

  it("prunes empty sections back into the ancestor body with an issue", () => {
    const doc = parseDocx(
      buildDocxFixture({
        body:
          p(r("Full"), { style: "Heading1" }) +
          p(r("content")) +
          p(r("Empty section"), { style: "Heading1" }),
      }),
    );
    const { root, issues } = splitDocument(doc, { level: 1, rootTitle: "Doc" });
    expect(root.children.map((c) => c.title)).toEqual(["Full"]);
    // The empty section's heading returned to its parent page's body (root).
    expect(JSON.stringify(root.blocks)).toContain("Empty section");
    expect(issues.some((i) => i.code === "docx-import/page-tree-empty-section")).toBe(true);
  });

  it("reports heading level gaps and renames duplicates in rename mode", () => {
    const doc = parseDocx(
      buildDocxFixture({
        body:
          p(r("Top"), { style: "Heading1" }) +
          p(r("x")) +
          p(r("Deep jump"), { style: "Ueberschrift3" }) +
          p(r("y")) +
          p(r("Top"), { style: "Heading1" }) +
          p(r("z")),
      }),
    );
    const { root, issues } = splitDocument(doc, { level: 3, rootTitle: "Doc" }, "rename");
    expect(issues.some((i) => i.code === "docx-import/page-tree-heading-level-gap")).toBe(true);
    expect(issues.some((i) => i.code === "docx-import/page-tree-title-renamed")).toBe(true);
    expect(root.children.map((c) => c.title)).toEqual(["Top", "Top (2)"]);
    expect(root.children[0].children.map((c) => c.title)).toEqual(["Deep jump"]);
  });

  it("maps bookmarks to their owning pages and collects anchor refs", () => {
    const doc = parseDocx(
      buildDocxFixture({
        body:
          p(r("Section A"), { style: "Heading1" }) +
          p(
            `<w:hyperlink w:anchor="target_b">${r("see B")}</w:hyperlink>` +
              `<w:fldSimple w:instr=" REF target_b \\h ">${r("chapter B")}</w:fldSimple>`,
          ) +
          `<w:bookmarkStart w:id="1" w:name="target_b"/>` +
          p(r("Section B"), { style: "Heading1" }) +
          p(r("B body")),
      }),
    );
    const { root, anchorOwners } = splitDocument(doc, { level: 1, rootTitle: "Doc" });
    expect(anchorOwners.get("target_b")?.title).toBe("Section B");
    const refs = collectAnchorRefs(root.children[0].blocks);
    expect([...refs]).toEqual(["target_b"]);
  });

  it("attaches an H2 without an open H1 page to the deepest open page", () => {
    const doc = parseDocx(
      buildDocxFixture({
        body: p(r("Orphan section"), { style: "Heading2" }) + p(r("text")),
      }),
    );
    const { root: tree } = splitDocument(doc, { level: 2, rootTitle: "Doc" });
    expect(tree.children.map((c) => c.title)).toEqual(["Orphan section"]);
    expect(tree.children[0].blocks.map((b) => b.type)).toEqual(["paragraph"]);
  });
});
