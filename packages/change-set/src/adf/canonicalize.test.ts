import { describe, expect, test } from "bun:test";
import { canonicalJsonV1 } from "../canonical-json.js";
import { digestSnapshotV1 } from "../digest.js";
import {
  canonicalizeAdfV1,
  classifyAdfAttributeV1,
  visitAdfSemanticJsonShardsV1,
  visitAdfSemanticShardsV1,
} from "./index.js";

describe("canonicalizeAdfV1", () => {
  test("matches the reviewed semantic-tree golden", async () => {
    const result = canonicalizeAdfV1({
      type: "doc",
      version: 1,
      content: [{
        type: "heading",
        attrs: { localId: "heading-1", level: 2 },
        content: [{
          type: "text",
          text: "Hello",
          marks: [
            { type: "strong" },
            { type: "link", attrs: { id: "link-1", href: "https://example.com" } },
          ],
        }],
      }],
    });
    const golden = await Bun.file(new URL(
      "../../test-fixtures/adf/basic/expected.semantic-tree.json",
      import.meta.url,
    )).json();
    expect(result.semanticTree).toEqual(golden);
  });

  test("canonicalizes object keys, mark order, and adjacent equal text", () => {
    const split = canonicalizeAdfV1({
      version: 1,
      type: "doc",
      content: [{
        type: "paragraph",
        content: [
          { text: "Hel", type: "text", marks: [{ type: "strong" }, { type: "em" }] },
          { type: "text", text: "lo", marks: [{ type: "em" }, { type: "strong" }] },
        ],
      }],
    });
    const joined = canonicalizeAdfV1({
      type: "doc",
      version: 1,
      content: [{
        content: [{ text: "Hello", marks: [{ type: "em" }, { type: "strong" }], type: "text" }],
        type: "paragraph",
      }],
    });
    expect(canonicalJsonV1(split.sourceTree)).toBe(canonicalJsonV1(joined.sourceTree));
    expect(canonicalJsonV1(split.semanticTree)).toBe(canonicalJsonV1(joined.semanticTree));
    expect(split.diagnostics.some((diagnostic) => diagnostic.code === "policy-noise")).toBe(true);

    const bounded = canonicalizeAdfV1({
      type: "doc",
      version: 1,
      content: [{
        type: "paragraph",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
          { type: "text", text: "c" },
        ],
      }],
    }, { budget: { maxDiagnostics: 1 } });
    expect(bounded.diagnostics).toHaveLength(1);
  });

  test("keeps mark identities exact but removes them from semantic attributes", () => {
    const result = canonicalizeAdfV1({
      type: "doc",
      version: 1,
      content: [{
        type: "paragraph",
        content: [{
          type: "text",
          text: "linked",
          marks: [{
            type: "link",
            attrs: {
              href: "https://example.com",
              title: "Example",
              id: "link-id",
              collection: "links",
              occurrenceKey: "occurrence",
            },
          }],
        }],
      }],
    });
    const sourceMark = result.sourceTree.children[0]!.children[0]!.marks![0]!;
    expect(sourceMark.attributes).toEqual({
      collection: "links",
      href: "https://example.com",
      id: "link-id",
      occurrenceKey: "occurrence",
      title: "Example",
    });
    expect(sourceMark.semanticAttributes).toEqual({
      href: "https://example.com",
      title: "Example",
    });
    expect(classifyAdfAttributeV1({ scope: "mark", type: "annotation", attribute: "id" }))
      .toBe("identity-only");
    expect(classifyAdfAttributeV1({ scope: "mark", type: "link", attribute: "href" }))
      .toBe("semantic");
  });

  test("preserves unknown attributes and projects them as opaque", () => {
    const result = canonicalizeAdfV1({
      type: "doc",
      version: 1,
      content: [{ type: "futureBlock", attrs: { feature: { enabled: true } } }],
    });
    expect(result.sourceTree.children[0]!.attributes).toEqual({
      $opaqueAttributes: { feature: { enabled: true } },
    });
    expect(result.semanticTree.children[0]!.coverage).toBe("opaque");
  });

  test("visits bounded top-level shards with reconstructable canonical output", async () => {
    const input = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "heading",
          attrs: { localId: "heading-1", level: 2 },
          content: [{ type: "text", text: "Heading" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "A" },
            { type: "text", text: "B" },
          ],
        },
      ],
    };
    const sourceChildren: Array<ReturnType<typeof canonicalizeAdfV1>["sourceTree"]> = [];
    const semanticChildren: Array<ReturnType<typeof canonicalizeAdfV1>["semanticTree"]> = [];
    const shardIndexes: number[] = [];
    const visited = visitAdfSemanticShardsV1(input, (shard) => {
      shardIndexes.push(shard.index);
      sourceChildren.push(shard.sourceTree);
      semanticChildren.push(...shard.semanticNodes);
    });
    const canonical = canonicalizeAdfV1(input);

    expect(visited.sourceRoot.children).toEqual([]);
    expect(visited.semanticRoot.children).toEqual([]);
    expect(visited.shardCount).toBe(2);
    expect(shardIndexes).toEqual([0, 1]);
    expect(sourceChildren.map((node) => node.sourcePath)).toEqual([
      ["content", 0],
      ["content", 1],
    ]);
    const reconstructedSource = { ...visited.sourceRoot, children: sourceChildren };
    expect(canonicalJsonV1(reconstructedSource))
      .toBe(canonicalJsonV1(canonical.sourceTree));
    expect(canonicalJsonV1({ ...visited.semanticRoot, children: semanticChildren }))
      .toBe(canonicalJsonV1(canonical.semanticTree));
    expect(visited.diagnostics).toEqual(canonical.diagnostics);
    expect(await digestSnapshotV1("atlas_doc_format", reconstructedSource))
      .toBe(await digestSnapshotV1("atlas_doc_format", canonical.sourceTree));
  });

  test("streams JSON top-level batches without changing canonical paths or bytes", async () => {
    const input = JSON.stringify({
      content: [
        { type: "paragraph", attrs: { localId: "one" }, content: [{ type: "text", text: "A" }] },
        { type: "futureBlock", attrs: { vendor: { enabled: true } } },
        { type: "paragraph", attrs: { localId: "three" }, content: [{ type: "text", text: "C" }] },
      ],
      version: 1,
      type: "doc",
    });
    const sourceChildren: ReturnType<typeof canonicalizeAdfV1>["sourceTree"][] = [];
    const semanticChildren: ReturnType<typeof canonicalizeAdfV1>["semanticTree"][] = [];
    const streamed = visitAdfSemanticJsonShardsV1(input, (shard) => {
      sourceChildren.push(shard.sourceTree);
      semanticChildren.push(...shard.semanticNodes);
    }, { batchNodes: 1 });
    const reference = canonicalizeAdfV1(input);
    const sourceTree = { ...streamed.sourceRoot, children: sourceChildren };
    expect(canonicalJsonV1(sourceTree)).toBe(canonicalJsonV1(reference.sourceTree));
    expect(canonicalJsonV1({ ...streamed.semanticRoot, children: semanticChildren }))
      .toBe(canonicalJsonV1(reference.semanticTree));
    expect(await digestSnapshotV1("atlas_doc_format", sourceTree))
      .toBe(await digestSnapshotV1("atlas_doc_format", reference.sourceTree));
  });
});
