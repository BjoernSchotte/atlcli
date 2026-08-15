import { describe, expect, it } from "bun:test";
import { parseDocx } from "./parse.js";
import { buildDocxFixture, p, r } from "./test-support.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const COMMENTS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
  <w:comment w:id="1" w:author="Alice Autor" w:date="2026-01-02T10:00:00Z">
    <w:p w14:paraId="AAAA0001"><w:r><w:t>Please check this number.</w:t></w:r></w:p>
  </w:comment>
  <w:comment w:id="2" w:author="Bob Reviewer" w:date="2026-01-03T11:00:00Z">
    <w:p w14:paraId="AAAA0002"><w:r><w:t>Checked, looks right.</w:t></w:r></w:p>
  </w:comment>
  <w:comment w:id="3" w:author="Carol" w:date="2026-01-04T12:00:00Z">
    <w:p><w:r><w:t>General remark</w:t></w:r></w:p>
    <w:p w14:paraId="AAAA0003"><w:r><w:t>with two paragraphs.</w:t></w:r></w:p>
  </w:comment>
</w:comments>`;

const COMMENTS_EXTENDED = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">
  <w15:commentEx w15:paraId="AAAA0001" w15:done="0"/>
  <w15:commentEx w15:paraId="AAAA0002" w15:paraIdParent="AAAA0001" w15:done="0"/>
  <w15:commentEx w15:paraId="AAAA0003" w15:done="1"/>
</w15:commentsEx>`;

function fixture(extended = true): Uint8Array {
  return buildDocxFixture({
    body:
      p(r("Intro paragraph.")) +
      `<w:p>` +
      `<w:commentRangeStart w:id="1"/>` +
      `<w:r><w:t xml:space="preserve">The revenue was </w:t></w:r>` +
      `<w:r><w:t>42 million</w:t></w:r>` +
      `<w:commentRangeEnd w:id="1"/>` +
      `<w:r><w:commentReference w:id="1"/></w:r>` +
      `<w:r><w:t xml:space="preserve"> in total.</w:t></w:r>` +
      `</w:p>` +
      p(`<w:r><w:commentReference w:id="3"/></w:r>` + r("Unanchored remark target.")),
    parts: {
      "word/comments.xml": enc(COMMENTS),
      ...(extended ? { "word/commentsExtended.xml": enc(COMMENTS_EXTENDED) } : {}),
    },
  });
}

describe("comment import", () => {
  it("parses comments with anchors, replies, and resolved state", () => {
    const doc = parseDocx(fixture());
    expect(doc.comments).toHaveLength(2);

    const [first, second] = doc.comments;
    expect(first.author).toBe("Alice Autor");
    expect(first.text).toBe("Please check this number.");
    expect(first.anchorText).toBe("The revenue was 42 million");
    expect(first.resolved).toBe(false);
    expect(first.replies).toHaveLength(1);
    expect(first.replies[0].author).toBe("Bob Reviewer");

    expect(second.author).toBe("Carol");
    expect(second.text).toBe("General remark\nwith two paragraphs.");
    expect(second.resolved).toBe(true);
    expect(second.anchorText).toBeUndefined();

    // Comment markers never leak into page content, and there is no
    // comment-dropped issue anymore.
    const bodyText = JSON.stringify(doc.blocks);
    expect(bodyText).toContain("The revenue was ");
    expect(bodyText).toContain(" in total.");
    expect(doc.issues.some((i) => i.code === "docx-import/comment-dropped")).toBe(false);
  });

  it("imports unthreaded when commentsExtended.xml is missing", () => {
    const doc = parseDocx(fixture(false));
    expect(doc.comments).toHaveLength(3);
    expect(doc.comments.every((c) => c.replies.length === 0 && !c.resolved)).toBe(true);
    expect(doc.issues.some((i) => i.code === "docx-import/comment-threads-unavailable")).toBe(true);
  });

  it("records the owning top-level block for anchored comments (split placement)", () => {
    const doc = parseDocx(fixture());
    const ownerBlock = doc.commentOwners.get("1");
    expect(ownerBlock).toBeDefined();
    // The owner is the paragraph containing the range start — findable by
    // identity in the block list.
    expect(doc.blocks.includes(ownerBlock!)).toBe(true);
    expect(JSON.stringify(ownerBlock)).toContain("The revenue was ");
    // Unanchored comment 3 has no owner block.
    expect(doc.commentOwners.has("3")).toBe(false);
  });

  it("documents without comments have an empty comment list", () => {
    const doc = parseDocx(buildDocxFixture({ body: p(r("plain")) }));
    expect(doc.comments).toEqual([]);
  });
});
