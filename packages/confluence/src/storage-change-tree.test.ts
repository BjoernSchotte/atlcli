import { describe, expect, it } from "bun:test";
import {
  canonicalJsonV1,
  digestSnapshotV1,
  diffSemanticTreesV1,
  type IdentityHintV1,
  type SemanticDocumentNodeV1,
} from "@atlcli/change-set";
import { canonicalizeAdfV1 } from "@atlcli/change-set/adf";
import { StorageParseError, type StorageParseErrorKind } from "./export-blocks.js";
import {
  canonicalizeStorageV1,
  storageSemanticTreeSnapshotV1,
  StorageChangeTreeInputErrorV1,
  visitStorageSemanticShardsV1,
} from "./storage-change-tree.js";

const PAIRS = new URL("../test-fixtures/adf-pairs/", import.meta.url);
const STORAGE_GOLDENS = new URL("../test-fixtures/semantic-diff/storage/", import.meta.url);

async function pair(name: string): Promise<{ adf: unknown; storage: string }> {
  const [adf, storage] = await Promise.all([
    Bun.file(new URL(`${name}.adf.json`, PAIRS)).json(),
    Bun.file(new URL(`${name}.storage.xml`, PAIRS)).text(),
  ]);
  return { adf, storage };
}

function semanticMeaning(node: SemanticDocumentNodeV1): unknown {
  const hints = node.identityHints.map(({ attribute: _attribute, ...hint }: IdentityHintV1) => hint);
  return {
    kind: node.kind,
    ...(node.label !== undefined ? { label: node.label } : {}),
    attributes: node.attributes,
    ...(node.text !== undefined ? { text: node.text } : {}),
    children: node.children.map(semanticMeaning),
    identityHints: hints,
    coverage: node.coverage,
  };
}

function expectStorageParseFailure(
  operation: () => unknown,
  kind: StorageParseErrorKind,
): void {
  try {
    operation();
    throw new Error("Expected Storage parsing to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(StorageParseError);
    expect((error as StorageParseError).kind).toBe(kind);
  }
}

describe("Storage semantic change tree", () => {
  it("projects supported ADF and Storage pairs to equivalent semantic meaning", async () => {
    for (const name of ["semantic-minimal", "basic"]) {
      const fixture = await pair(name);
      const adf = canonicalizeAdfV1(fixture.adf);
      const storage = canonicalizeStorageV1(fixture.storage);

      expect(canonicalJsonV1(semanticMeaning(storage.semanticTree))).toBe(
        canonicalJsonV1(semanticMeaning(adf.semanticTree)),
      );
      expect(storage.sourceTree.kind).toBe("#root");
      expect(adf.sourceTree.kind).toBe("doc");
      expect(canonicalJsonV1(storage.sourceTree)).not.toBe(canonicalJsonV1(adf.sourceTree));
    }
  });

  it("uses the shared semantic vocabulary and stable Storage identity hints", async () => {
    const fixture = await pair("basic");
    const tree = canonicalizeStorageV1(fixture.storage).semanticTree;
    const serialized = canonicalJsonV1(semanticMeaning(tree));

    expect(tree.kind).toBe("document");
    expect(serialized).toContain('"kind":"list"');
    expect(serialized).toContain('"kind":"list-item"');
    expect(serialized).toContain('"kind":"line-break"');
    expect(serialized).toContain('"kind":"table-cell"');
    expect(serialized).not.toContain('"kind":"bulletList"');
    expect(tree.children[0]?.identityHints).toContainEqual({
      kind: "local-id",
      value: "paired-heading",
      stability: "stable",
      attribute: "local-id",
      semantic: false,
    });
  });

  it("pins discarded XML syntax and attribute order as Storage policy noise", () => {
    const decorated = canonicalizeStorageV1(
      '<?xml version="1.0"?><!DOCTYPE p><?review ignore?><p z="2" a="1"><!--ignore-->A &amp; B</p>',
    );
    const plain = canonicalizeStorageV1('<p a="1" z="2">A &#38; B</p>');

    expect(canonicalJsonV1(decorated.sourceTree)).toBe(canonicalJsonV1(plain.sourceTree));
    expect(canonicalJsonV1(decorated.semanticTree)).toBe(canonicalJsonV1(plain.semanticTree));
    expect(decorated.diagnostics).toEqual([]);
    expect(plain.diagnostics).toEqual([]);
  });

  it("records stripped illegal controls while keeping the decoded canonical tree", () => {
    const controlled = canonicalizeStorageV1("<p>A\u0001B&#x1;C</p>");
    const clean = canonicalizeStorageV1("<p>ABC</p>");

    expect(canonicalJsonV1(controlled.sourceTree)).toBe(canonicalJsonV1(clean.sourceTree));
    expect(controlled.diagnostics).toEqual([expect.objectContaining({
      code: "policy-noise",
      severity: "info",
      path: [],
    })]);
  });

  it("preserves unclassified attributes in the exact tree and marks their projection opaque", () => {
    const result = canonicalizeStorageV1('<p data-vendor-mode="alpha">Visible</p>');

    expect(result.sourceTree.children[0]?.attributes).toEqual({ "data-vendor-mode": "alpha" });
    expect(result.semanticTree.children[0]).toMatchObject({
      kind: "paragraph",
      coverage: "opaque",
    });
  });

  it("rejects raw UTF-8 input before XML materialization", () => {
    try {
      canonicalizeStorageV1("<p>éééé</p>", { budget: { maxInputBytes: 10 } });
      throw new Error("Expected raw input budget to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(StorageChangeTreeInputErrorV1);
      expect((error as StorageChangeTreeInputErrorV1).kind).toBe("input-too-large");
    }
  });

  it("preserves typed node failures for a generated dense table", () => {
    const denseTable = `<table>${Array.from(
      { length: 20 },
      (_, row) => `<tr>${Array.from({ length: 8 }, (_, cell) => `<td>${row}:${cell}</td>`).join("")}</tr>`,
    ).join("")}</table>`;
    expectStorageParseFailure(
      () => canonicalizeStorageV1(denseTable, { budget: { maxNodes: 50 } }),
      "too-many-nodes",
    );
  });

  it("preserves typed depth failures for generated deep nesting", () => {
    const deep = `${"<blockquote>".repeat(20)}x${"</blockquote>".repeat(20)}`;
    expectStorageParseFailure(
      () => canonicalizeStorageV1(deep, { budget: { maxDepth: 8 } }),
      "too-deep",
    );
  });

  it("preserves typed decoded-text failures for generated text-heavy input", () => {
    const textHeavy = `<p>${"&amp;".repeat(200)}</p>`;
    expectStorageParseFailure(
      () => canonicalizeStorageV1(textHeavy, { budget: { maxTextLength: 100 } }),
      "text-too-long",
    );
  });

  it("retains unknown changes as opaque and degrades completeness visibly", async () => {
    const [before, after] = await Promise.all([
      Bun.file(new URL("unknown-before.storage.xml", STORAGE_GOLDENS)).text(),
      Bun.file(new URL("unknown-after.storage.xml", STORAGE_GOLDENS)).text(),
    ]);
    const beforeTree = canonicalizeStorageV1(before);
    const afterTree = canonicalizeStorageV1(after);
    const beforeOpaque = beforeTree.semanticTree.children.find((node) => node.coverage === "opaque");
    const afterOpaque = afterTree.semanticTree.children.find((node) => node.coverage === "opaque");

    expect(beforeOpaque).toMatchObject({
      kind: "opaque",
      label: "vendor:release-widget",
      attributes: { "vendor:mode": "compact", "vendor:revision": "1" },
      coverage: "opaque",
    });
    expect(afterOpaque).toMatchObject({
      kind: "opaque",
      label: "vendor:release-widget",
      attributes: { "vendor:mode": "expanded", "vendor:revision": "2" },
      coverage: "opaque",
    });

    const result = await diffSemanticTreesV1({
      subject: { provider: "confluence", kind: "page", id: "opaque-storage-fixture" },
      baseline: storageSemanticTreeSnapshotV1(before, {
        revision: "1",
        representation: "storage",
        acquisition: "synthetic-fixture",
      }),
      target: storageSemanticTreeSnapshotV1(after, {
        revision: "2",
        representation: "storage",
        acquisition: "synthetic-fixture",
      }),
    });

    expect(result.changeSet.operations.some((operation) => operation.kind === "opaque-change")).toBe(true);
    expect(result.changeSet.summary.opaque).toBeGreaterThan(0);
    expect(result.changeSet.summary.noOp).toBe(false);
    expect(result.changeSet.completeness.status).toBe("degraded");
    expect(result.changeSet.completeness.diagnostics).toContainEqual(expect.objectContaining({
      code: "opaque-source-change",
    }));
  });

  it("canonicalizes deterministically", async () => {
    const fixture = await pair("basic");
    const first = canonicalJsonV1(canonicalizeStorageV1(fixture.storage));
    const second = canonicalJsonV1(canonicalizeStorageV1(fixture.storage));
    expect(second).toBe(first);
  });

  it("visits top-level Storage shards and preserves transparent 0..n projection", async () => {
    const storage = "<ac:rich-text-body><p>A</p><p>B</p></ac:rich-text-body><p>C</p>";
    const sourceChildren: Array<ReturnType<typeof canonicalizeStorageV1>["sourceTree"]> = [];
    const semanticChildren: SemanticDocumentNodeV1[] = [];
    const semanticCounts: number[] = [];
    const visited = visitStorageSemanticShardsV1(storage, (shard) => {
      sourceChildren.push(shard.sourceTree);
      semanticChildren.push(...shard.semanticNodes);
      semanticCounts.push(shard.semanticNodes.length);
    });
    const canonical = canonicalizeStorageV1(storage);

    expect(visited.sourceRoot.children).toEqual([]);
    expect(visited.semanticRoot.children).toEqual([]);
    expect(visited.shardCount).toBe(2);
    expect(semanticCounts).toEqual([2, 1]);
    expect(sourceChildren.map((node) => node.sourcePath)).toEqual([
      ["children", 0],
      ["children", 1],
    ]);
    const reconstructedSource = { ...visited.sourceRoot, children: sourceChildren };
    expect(canonicalJsonV1(reconstructedSource))
      .toBe(canonicalJsonV1(canonical.sourceTree));
    expect(canonicalJsonV1({ ...visited.semanticRoot, children: semanticChildren }))
      .toBe(canonicalJsonV1(canonical.semanticTree));
    expect(visited.diagnostics).toEqual(canonical.diagnostics);
    expect(await digestSnapshotV1("storage", reconstructedSource))
      .toBe(await digestSnapshotV1("storage", canonical.sourceTree));
  });
});
