import { describe, expect, it } from "bun:test";
import type { ChangeSetV1 } from "@atlcli/change-set";
import { renderSemanticDiff } from "./render-semantic-diff.js";

const DIGEST = "a".repeat(64);

function fixture(): ChangeSetV1 {
  return {
    schema: "atlcli.change-set/1",
    subject: {
      provider: "confluence",
      kind: "page",
      id: "fixture-page",
      label: "API Reference",
    },
    baseline: {
      revision: "3",
      digest: DIGEST,
      representation: "atlas_doc_format",
      deployment: "cloud",
      acquisition: "synthetic-fixture",
    },
    target: {
      revision: "7",
      digest: "b".repeat(64),
      representation: "atlas_doc_format",
      deployment: "cloud",
      acquisition: "synthetic-fixture",
    },
    completeness: {
      status: "degraded",
      diagnostics: [{
        code: "opaque-source-change",
        severity: "warning",
        message: "Unknown macro attribute changed.",
        path: ["content", 8],
      }],
    },
    summary: {
      inserts: 1,
      deletes: 0,
      modifies: 1,
      moves: 1,
      opaque: 1,
      noOp: false,
    },
    operations: [
      {
        id: "1".repeat(64),
        kind: "modify",
        path: ["content", 0, "text"],
        before: "Use API tokens.",
        after: "Use scoped API tokens.",
        matchBasis: "position",
        confidence: "conservative",
        riskTags: ["content-change"],
        source: { baseline: "atlas_doc_format", target: "atlas_doc_format" },
        coveredSourceChangeIds: ["source-1"],
      },
      {
        id: "2".repeat(64),
        kind: "insert",
        path: ["content", 1],
        after: { kind: "panel", label: "Migration warning" },
        matchBasis: "position",
        confidence: "conservative",
        riskTags: ["structure-change"],
        source: { baseline: "atlas_doc_format", target: "atlas_doc_format" },
        coveredSourceChangeIds: ["source-2"],
      },
      {
        id: "3".repeat(64),
        kind: "move",
        path: ["content", 2],
        fromPath: ["content", 4],
        value: { kind: "tableRow" },
        matchBasis: "exact-subtree",
        confidence: "exact",
        riskTags: ["structure-change"],
        source: { baseline: "atlas_doc_format", target: "atlas_doc_format" },
        coveredSourceChangeIds: ["source-3"],
      },
      {
        id: "4".repeat(64),
        kind: "opaque-change",
        path: ["content", 8],
        reason: "opaque macro attribute changed",
        matchBasis: "opaque",
        confidence: "ambiguous",
        riskTags: ["opaque"],
        source: { baseline: "atlas_doc_format", target: "atlas_doc_format" },
        coveredSourceChangeIds: ["source-4"],
      },
    ],
    limits: { truncated: false, emittedOperations: 4 },
  };
}

describe("renderSemanticDiff", () => {
  it("renders deterministic version and representation provenance", () => {
    const rendered = renderSemanticDiff(fixture());
    expect(rendered).toBe(
      "Wiki page \"API Reference\" — version 3 → 7 (Cloud, ADF)\n" +
      "\n" +
      "~ Changed “Use API tokens.” → “Use scoped API tokens.” (block 1)\n" +
      "+ Added Panel “Migration warning” (block 2)\n" +
      "> Moved Table row from block 5 to block 3\n" +
      "! Review required: opaque macro attribute changed (block 9)\n" +
      "\n" +
      "Summary: 1 added, 0 removed, 1 changed, 1 moved, 1 requiring review\n" +
      "Coverage: degraded",
    );
    expect(renderSemanticDiff(fixture())).toBe(rendered);
    expect(rendered).not.toContain("\u001b[");
  });

  it("adds ANSI only when explicitly enabled", () => {
    const rendered = renderSemanticDiff(fixture(), { color: true });
    expect(rendered).toContain("\u001b[36m~ Changed “Use API tokens.”");
    expect(rendered).toContain("\u001b[33m! Review required: opaque macro attribute changed");
  });

  it("bounds presentation values without changing the ChangeSet", () => {
    const changeSet = fixture();
    const before = JSON.stringify(changeSet);
    const first = changeSet.operations[0]!;
    changeSet.operations = [{
      ...first,
      kind: "modify",
      before: "x".repeat(100),
      after: "y".repeat(100),
    }, ...changeSet.operations.slice(1)];
    const snapshot = JSON.stringify(changeSet);
    const rendered = renderSemanticDiff(changeSet, { maxValueCharacters: 16 });
    expect(rendered).toContain("“xxxxxxxxxxxxxxx…” → “yyyyyyyyyyyyyyy…”");
    expect(JSON.stringify(changeSet)).toBe(snapshot);
    expect(before).not.toBe(snapshot);
  });

  it("makes truncation and no-op status visible", () => {
    const changeSet = fixture();
    changeSet.operations = [];
    changeSet.summary = {
      inserts: 0,
      deletes: 0,
      modifies: 0,
      moves: 0,
      opaque: 0,
      noOp: true,
    };
    changeSet.limits = { truncated: true, emittedOperations: 0, totalOperations: 1 };
    const rendered = renderSemanticDiff(changeSet);
    expect(rendered).toContain("No semantic changes.");
    expect(rendered).toContain("Coverage: degraded; truncated");
  });

  it("renders media and diagnostics without AST paths, raw JSON, or private IDs", () => {
    const changeSet = fixture();
    changeSet.operations = [{
      ...changeSet.operations[1]!,
      kind: "insert",
      after: {
        kind: "mediaSingle",
        attributes: { layout: "center", width: 760 },
        coverage: "exact",
        children: [{
          kind: "media",
          attributes: {
            alt: "Architecture overview.png",
            collection: "contentId-synthetic-page",
            id: "synthetic-media-uuid",
          },
          coverage: "exact",
          children: [],
        }],
      },
    }];
    changeSet.summary = {
      inserts: 1,
      deletes: 0,
      modifies: 0,
      moves: 0,
      opaque: 0,
      noOp: false,
    };
    changeSet.completeness = {
      status: "complete",
      diagnostics: [
        {
          code: "ambiguous-match",
          severity: "warning",
          message: "first internal matcher detail",
          path: ["content", 2],
        },
        {
          code: "ambiguous-match",
          severity: "warning",
          message: "second internal matcher detail",
          path: ["content", 8],
        },
      ],
    };

    const rendered = renderSemanticDiff(changeSet);
    expect(rendered).toContain('+ Added Image “Architecture overview.png” (block 2)');
    expect(rendered.match(/Some repeated elements/gu)?.length).toBe(1);
    expect(rendered).not.toContain("content[");
    expect(rendered).not.toContain("attributes");
    expect(rendered).not.toContain("contentId-");
    expect(rendered).not.toContain("synthetic-media-uuid");
  });

  it("groups repeated unlabeled blocks and review operations", () => {
    const changeSet = fixture();
    const insert = changeSet.operations[1]!;
    const opaque = changeSet.operations[3]!;
    if (insert.kind !== "insert" || opaque.kind !== "opaque-change") {
      throw new Error("renderer fixture operation kinds drifted");
    }
    changeSet.operations = [
      { ...insert, id: "5".repeat(64), path: ["content", 1], after: { kind: "paragraph", attributes: {}, coverage: "exact", children: [] } },
      { ...insert, id: "6".repeat(64), path: ["content", 3], after: { kind: "paragraph", attributes: {}, coverage: "exact", children: [] } },
      { ...opaque, id: "7".repeat(64), path: ["content", 5], reason: "An exact source change was not represented by the semantic projection.", after: { kind: "mediaSingle", attributes: {}, coverage: "exact", children: [] } },
      { ...opaque, id: "8".repeat(64), path: ["content", 7], reason: "An exact source change was not represented by the semantic projection.", after: { kind: "mediaSingle", attributes: {}, coverage: "exact", children: [] } },
    ];
    changeSet.summary = {
      inserts: 2,
      deletes: 0,
      modifies: 0,
      moves: 0,
      opaque: 2,
      noOp: false,
    };

    const rendered = renderSemanticDiff(changeSet);
    expect(rendered).toContain("+ Added 2 empty paragraphs");
    expect(rendered).toContain("! 2 images require review: Confluence did not expose enough stable media metadata to match them safely.");
    expect(rendered).not.toContain("opaque-source-change");
  });
});
