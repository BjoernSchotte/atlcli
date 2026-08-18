import { describe, expect, it } from "bun:test";
import {
  buildBaseline,
  digestAdfValue,
  validateBaseline,
} from "./baseline.js";
import { diffAdfBlocks } from "./diff.js";
import { canonicalJson, type AdfNode } from "@atlcli/import-core";

describe("baseline", () => {
  const input = {
    pageId: "123",
    sourceSha256: "a".repeat(64),
    importPlanDigest: "b".repeat(64),
    bodyDigest: "c".repeat(64),
    importedPageVersion: 2,
    assetBindings: [
      { sourceAssetId: "word/media/z.png", remoteFilename: "z.png", sha256: "d".repeat(64) },
      { sourceAssetId: "word/media/a.png", remoteFilename: "a.png", sha256: "e".repeat(64) },
    ],
  };

  it("builds a baseline with sorted bindings and a self-verifying digest", async () => {
    const baseline = await buildBaseline(input);
    expect(baseline.assetBindings[0].sourceAssetId).toBe("word/media/a.png");
    expect(baseline.provenanceDigest).toMatch(/^[0-9a-f]{64}$/);
    const check = await validateBaseline(baseline, "123");
    expect(check.reason).toBeUndefined();
    expect(check.baseline?.importedPageVersion).toBe(2);
  });

  it("rejects tampered, foreign, and malformed baselines", async () => {
    const baseline = await buildBaseline(input);
    expect((await validateBaseline({ ...baseline, bodyDigest: "f".repeat(64) }, "123")).reason).toContain(
      "digest mismatch",
    );
    expect((await validateBaseline(baseline, "999")).reason).toContain("belongs to page 123");
    expect((await validateBaseline(null, "123")).reason).toContain("not an object");
    expect((await validateBaseline({ schema: "other/1" }, "123")).reason).toContain("unknown baseline schema");
  });

  it("digestAdfValue normalizes inline-comment annotations and text segmentation", async () => {
    // Sealed at publish time: one merged text node, no annotations.
    const sealed = JSON.stringify({
      version: 1,
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Revenue grew to 42 million." }] },
      ],
    });
    // After someone adds an inline comment: Confluence splits the text node
    // and adds an annotation mark. That is commenting, not editing.
    const annotated = JSON.stringify({
      version: 1,
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Revenue grew to " },
            {
              type: "text",
              text: "42 million",
              marks: [{ type: "annotation", attrs: { annotationType: "inlineComment", id: "x" } }],
            },
            { type: "text", text: "." },
          ],
        },
      ],
    });
    expect(await digestAdfValue(annotated)).toBe(await digestAdfValue(sealed));

    // A REAL edit still changes the digest.
    const edited = sealed.replace("42 million", "43 million");
    expect(await digestAdfValue(edited)).not.toBe(await digestAdfValue(sealed));
  });

  it("digestAdfValue is stable across key order and whitespace", async () => {
    const a = await digestAdfValue('{"type":"doc","version":1,"content":[]}');
    const b = await digestAdfValue('{\n  "version": 1,\n  "content": [],\n  "type": "doc"\n}');
    expect(a).toBe(b);
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });
});

describe("diffAdfBlocks", () => {
  const para = (text: string): AdfNode => ({ type: "paragraph", content: [{ type: "text", text }] });

  it("reports unchanged, changed, added, removed via LCS alignment", () => {
    const oldBlocks = [para("one"), para("two"), para("three")];
    const newBlocks = [para("one"), para("two CHANGED"), para("three"), para("four")];
    const diff = diffAdfBlocks(oldBlocks, newBlocks);
    expect(diff.unchanged).toBe(2);
    expect(diff.entries).toEqual([
      { op: "changed", index: 1, type: "paragraph", summary: "two CHANGED" },
      { op: "added", index: 3, type: "paragraph", summary: "four" },
    ]);
  });

  it("ignores media identity differences (re-uploaded fileIds)", () => {
    const media = (id: string): AdfNode => ({
      type: "mediaSingle",
      content: [{ type: "media", attrs: { type: "file", id, collection: `contentId-${id}` } }],
    });
    const diff = diffAdfBlocks([media("old-file-id")], [media("new-file-id")]);
    expect(diff.unchanged).toBe(1);
    expect(diff.entries).toEqual([]);
  });
});
