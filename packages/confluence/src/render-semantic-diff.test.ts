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
      "Wiki page \"API Reference\"  v3 -> v7  [cloud / atlas_doc_format]\n" +
      "\n" +
      "~ content[0].text: Use API tokens. -> Use scoped API tokens.\n" +
      "+ content[1]: {\"kind\":\"panel\",\"label\":\"Migration warning\"}\n" +
      "> content[4] -> content[2] [exact-subtree]\n" +
      "! opaque macro attribute changed at content[8]\n" +
      "! opaque-source-change at content[8]: Unknown macro attribute changed.\n" +
      "\n" +
      "Summary: 1 added, 0 deleted, 1 modified, 1 moved, 1 opaque\n" +
      "Completeness: degraded",
    );
    expect(renderSemanticDiff(fixture())).toBe(rendered);
    expect(rendered).not.toContain("\u001b[");
  });

  it("adds ANSI only when explicitly enabled", () => {
    const rendered = renderSemanticDiff(fixture(), { color: true });
    expect(rendered).toContain("\u001b[36m~ content[0].text");
    expect(rendered).toContain("\u001b[33m! opaque-source-change");
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
    expect(rendered).toContain("xxxxxxxxxxxxxxx… -> yyyyyyyyyyyyyyy…");
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
    expect(rendered).toContain("Completeness: degraded; truncated");
  });
});
