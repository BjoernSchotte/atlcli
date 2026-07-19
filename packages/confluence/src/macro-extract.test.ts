import { describe, expect, test } from "bun:test";
import { extractMacroBody } from "./macro-extract.js";
import { storageToBlocks } from "./export-blocks.js";

const DEFINITION = `<p>Before</p>
<ac:structured-macro ac:name="multiexcerpt-macro" ac:macro-id="m1">
  <ac:parameter ac:name="MultiExcerptName">intro</ac:parameter>
  <ac:rich-text-body><p>Reusable <strong>intro</strong> text</p></ac:rich-text-body>
</ac:structured-macro>
<p>After</p>`;

describe("walker: multiexcerpt definition renders transparently (spec 004 E4)", () => {
  test("definition body surfaces like expand — no unknown block, no placeholder note", () => {
    const { blocks, notes } = storageToBlocks(DEFINITION);
    // Before / body / After — all paragraphs, no unknown block.
    expect(blocks.every((b) => b.type !== "unknown")).toBe(true);
    expect(JSON.stringify(blocks)).toContain("Reusable ");
    expect(notes.some((n) => n.code === "unknown-macro" || n.code === "macro-not-rendered")).toBe(false);
  });

  test("legacy multiexcerpt spelling is transparent too", () => {
    const { blocks } = storageToBlocks(
      `<ac:structured-macro ac:name="multiexcerpt"><ac:parameter ac:name="name">x</ac:parameter><ac:rich-text-body><p>Body</p></ac:rich-text-body></ac:structured-macro>`
    );
    expect(blocks).toEqual([{ type: "paragraph", content: [{ type: "text", text: "Body" }] }]);
  });
});

describe("extractMacroBody (storage-based)", () => {
  test("finds a named multiexcerpt and returns a walkable fragment", () => {
    const fragment = extractMacroBody(DEFINITION, ["multiexcerpt-macro", "multiexcerpt"], "intro");
    expect(fragment).toBeDefined();
    const { blocks } = storageToBlocks(fragment!);
    expect(JSON.stringify(blocks)).toContain("Reusable ");
    // Marks survive the round trip.
    expect(JSON.stringify(blocks)).toContain('"bold"');
  });

  test("name matching is case-insensitive; wrong name → undefined", () => {
    expect(extractMacroBody(DEFINITION, ["multiexcerpt-macro"], "INTRO")).toBeDefined();
    expect(extractMacroBody(DEFINITION, ["multiexcerpt-macro"], "other")).toBeUndefined();
  });

  test("empty name matches the first (unnamed excerpt macro)", () => {
    const storage = `<ac:structured-macro ac:name="excerpt"><ac:rich-text-body><p>E</p></ac:rich-text-body></ac:structured-macro>`;
    const fragment = extractMacroBody(storage, ["excerpt"], "");
    expect(fragment).toBeDefined();
    expect(storageToBlocks(fragment!).blocks[0]).toMatchObject({ type: "paragraph" });
  });

  test("nested macro bodies round-trip (no regex mis-slicing)", () => {
    const storage = `<ac:structured-macro ac:name="multiexcerpt-macro">
      <ac:parameter ac:name="MultiExcerptName">outer</ac:parameter>
      <ac:rich-text-body>
        <ac:structured-macro ac:name="info"><ac:rich-text-body><p>Nested</p></ac:rich-text-body></ac:structured-macro>
      </ac:rich-text-body>
    </ac:structured-macro>`;
    const fragment = extractMacroBody(storage, ["multiexcerpt-macro"], "outer");
    const { blocks } = storageToBlocks(fragment!);
    expect(blocks[0]).toMatchObject({ type: "callout", kind: "info" });
  });

  test("no matching macro / no body → undefined", () => {
    expect(extractMacroBody("<p>x</p>", ["multiexcerpt-macro"], "a")).toBeUndefined();
    expect(
      extractMacroBody(
        `<ac:structured-macro ac:name="multiexcerpt-macro"><ac:parameter ac:name="name">a</ac:parameter></ac:structured-macro>`,
        ["multiexcerpt-macro"],
        "a"
      )
    ).toBeUndefined();
  });
});
