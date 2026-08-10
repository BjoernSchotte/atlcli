import { describe, expect, test } from "bun:test";
import { canonicalizeAdfV1 } from "./adf/index.js";
import { canonicalJsonV1 } from "./canonical-json.js";
import { diffSemanticTreesV1 } from "./matcher.js";
import type { SemanticTreeSnapshotV1 } from "./semantic-tree.js";

const subject = { provider: "confluence", kind: "page", id: "page-1" } as const;

function snapshot(adf: unknown, revision: string): SemanticTreeSnapshotV1 {
  const canonical = canonicalizeAdfV1(adf);
  return {
    ref: {
      revision,
      representation: "atlas_doc_format",
      acquisition: "synthetic-fixture",
    },
    ...canonical,
  };
}

function doc(content: unknown[]): unknown {
  return { type: "doc", version: 1, content };
}

function paragraph(text: string, localId?: string): unknown {
  return {
    type: "paragraph",
    ...(localId ? { attrs: { localId } } : {}),
    content: [{ type: "text", text }],
  };
}

async function diff(before: unknown, after: unknown, limits?: {
  maxNodes?: number;
  maxCandidateComparisons?: number;
  maxOperations?: number;
  maxDiagnostics?: number;
}) {
  return diffSemanticTreesV1({
    subject,
    baseline: snapshot(before, "1"),
    target: snapshot(after, "2"),
    limits,
  });
}

describe("diffSemanticTreesV1", () => {
  test("emits deterministic operations and covers every meaningful source change", async () => {
    const before = doc([paragraph("before", "paragraph-1")]);
    const after = doc([paragraph("after", "paragraph-1")]);
    const first = await diff(before, after);
    const second = await diff(before, after);
    expect(canonicalJsonV1(first.changeSet)).toBe(canonicalJsonV1(second.changeSet));
    expect(first.changeSet.summary).toMatchObject({ modifies: 1, noOp: false });
    const covered = new Set(first.changeSet.operations.flatMap((operation) =>
      operation.coveredSourceChangeIds));
    const meaningful = first.sourceChanges
      .filter((change) => change.classification === "meaningful")
      .map((change) => change.id);
    expect(meaningful.length).toBeGreaterThan(0);
    expect(meaningful.every((id) => covered.has(id))).toBe(true);
  });

  test("classifies node and mark identity changes as policy noise while href remains semantic", async () => {
    const linked = (localId: string, linkId: string, href: string) => doc([{
      type: "paragraph",
      attrs: { localId },
      content: [{
        type: "text",
        text: "link",
        marks: [{ type: "link", attrs: { href, id: linkId, collection: "c", occurrenceKey: "o" } }],
      }],
    }]);
    const noise = await diff(
      linked("paragraph-a", "link-a", "https://example.com"),
      linked("paragraph-b", "link-b", "https://example.com"),
    );
    expect(noise.changeSet.summary.noOp).toBe(true);
    expect(noise.sourceChanges.length).toBeGreaterThan(0);
    expect(noise.sourceChanges.every((change) => change.classification === "policy-noise")).toBe(true);
    expect(noise.changeSet.completeness.diagnostics.some((diagnostic) =>
      diagnostic.code === "policy-noise")).toBe(true);

    const annotationNoise = await diff(
      doc([{
        type: "paragraph",
        content: [{
          type: "text",
          text: "annotated",
          marks: [
            { type: "annotation", attrs: { annotationType: "inlineComment", id: "comment-a" } },
            { type: "fragment", attrs: { localId: "fragment-a", name: "section" } },
          ],
        }],
      }]),
      doc([{
        type: "paragraph",
        content: [{
          type: "text",
          text: "annotated",
          marks: [
            { type: "fragment", attrs: { localId: "fragment-b", name: "section" } },
            { type: "annotation", attrs: { annotationType: "inlineComment", id: "comment-b" } },
          ],
        }],
      }]),
    );
    expect(annotationNoise.changeSet.summary.noOp).toBe(true);
    expect(annotationNoise.sourceChanges.every((change) =>
      change.classification === "policy-noise")).toBe(true);

    const semantic = await diff(
      linked("paragraph-a", "link-a", "https://before.example"),
      linked("paragraph-b", "link-b", "https://after.example"),
    );
    expect(semantic.changeSet.summary.modifies).toBeGreaterThan(0);
  });

  test("claims moves only from unique stable identities or unique exact subtrees", async () => {
    const stable = await diff(
      doc([paragraph("A", "a"), paragraph("B", "b"), paragraph("C", "c")]),
      doc([paragraph("B", "b"), paragraph("A", "a"), paragraph("C", "c")]),
    );
    expect(stable.changeSet.operations.some((operation) =>
      operation.kind === "move" && operation.matchBasis === "stable-id")).toBe(true);
    expect(stable.changeSet.operations
      .filter((operation) => operation.kind === "move")
      .every((operation) => canonicalJsonV1(operation.fromPath) !== canonicalJsonV1(operation.path)))
      .toBe(true);

    const exact = await diff(
      doc([paragraph("unique A"), paragraph("unique B")]),
      doc([paragraph("unique B"), paragraph("unique A")]),
    );
    expect(exact.changeSet.operations.some((operation) =>
      operation.kind === "move" && operation.matchBasis === "exact-subtree")).toBe(true);
    expect(exact.changeSet.operations
      .filter((operation) => operation.kind === "move")
      .some((operation) => JSON.stringify(operation.value).includes("unique"))).toBe(true);

    const inserted = await diff(
      doc([paragraph("A", "a"), paragraph("B", "b")]),
      doc([paragraph("new", "new"), paragraph("A", "a"), paragraph("B", "b")]),
    );
    expect(inserted.changeSet.summary.inserts).toBe(1);
    expect(inserted.changeSet.summary.moves).toBe(0);
  });

  test("keeps changed text and mark targets visible in conservative subtree replacements", async () => {
    const linked = (text: string, href: string) => ({
      type: "paragraph",
      content: [{
        type: "text",
        text,
        marks: [{ type: "link", attrs: { href } }],
      }],
    });
    const result = await diff(
      doc([linked("before", "https://before.example"), paragraph("alpha"), paragraph("beta")]),
      doc([linked("after", "https://after.example"), paragraph("beta"), paragraph("inserted"), paragraph("alpha")]),
    );
    const rendered = JSON.stringify(result.changeSet.operations);
    expect(rendered).toContain("before");
    expect(rendered).toContain("after");
    expect(rendered).toContain("https://before.example");
    expect(rendered).toContain("https://after.example");
    expect(rendered).toContain("inserted");
  });

  test("never claims a move when duplicate candidates make reordering ambiguous", async () => {
    const result = await diff(
      doc([paragraph("same"), paragraph("same"), paragraph("other")]),
      doc([paragraph("same"), paragraph("other"), paragraph("same")]),
    );
    expect(result.changeSet.operations.some((operation) => operation.kind === "move")).toBe(false);
    expect(result.changeSet.summary.deletes).toBeGreaterThan(0);
    expect(result.changeSet.summary.inserts).toBeGreaterThan(0);
    expect(result.changeSet.completeness.diagnostics.some((diagnostic) =>
      diagnostic.code === "ambiguous-match")).toBe(true);
  });

  test("represents inline reordering as delete and insert instead of a move", async () => {
    const result = await diff(
      doc([{
        type: "paragraph",
        content: [
          { type: "text", text: "A", marks: [{ type: "strong" }] },
          { type: "text", text: "B", marks: [{ type: "em" }] },
        ],
      }]),
      doc([{
        type: "paragraph",
        content: [
          { type: "text", text: "B", marks: [{ type: "em" }] },
          { type: "text", text: "A", marks: [{ type: "strong" }] },
        ],
      }]),
    );
    expect(result.changeSet.summary.moves).toBe(0);
    expect(result.changeSet.summary.deletes).toBeGreaterThan(0);
    expect(result.changeSet.summary.inserts).toBeGreaterThan(0);
  });

  test("uses opaque fallback for unknown source coverage", async () => {
    const result = await diff(
      doc([{ type: "futureBlock", attrs: { mode: "before" } }]),
      doc([{ type: "futureBlock", attrs: { mode: "after" } }]),
    );
    expect(result.changeSet.summary.opaque).toBeGreaterThan(0);
    expect(result.changeSet.completeness.status).toBe("degraded");
    expect(result.changeSet.completeness.diagnostics.some((diagnostic) =>
      diagnostic.code === "opaque-source-change")).toBe(true);

    const descendant = await diff(
      doc([{ type: "futureBlock", content: [paragraph("before")] }]),
      doc([{ type: "futureBlock", content: [paragraph("after")] }]),
    );
    expect(descendant.changeSet.operations.every((operation) =>
      operation.kind === "opaque-change")).toBe(true);
  });

  test("fails closed with deterministic limit diagnostics", async () => {
    const result = await diff(
      doc([paragraph("A"), paragraph("B")]),
      doc([paragraph("B"), paragraph("A")]),
      { maxCandidateComparisons: 1, maxDiagnostics: 1 },
    );
    expect(result.changeSet.limits).toEqual({
      truncated: true,
      emittedOperations: 0,
      totalOperations: 1,
    });
    expect(result.changeSet.completeness.status).toBe("degraded");
    expect(result.changeSet.completeness.diagnostics).toHaveLength(1);
    expect(result.changeSet.completeness.diagnostics[0]!.code).toBe("limit-exceeded");

    const nodeLimited = await diff(
      doc([paragraph("A")]),
      doc([paragraph("A")]),
      { maxNodes: 1 },
    );
    expect(nodeLimited.changeSet.limits.truncated).toBe(true);
    expect(nodeLimited.changeSet.completeness.diagnostics.some((diagnostic) =>
      diagnostic.message.includes("node limit exceeded"))).toBe(true);

    const operationLimited = await diff(
      doc([]),
      doc([paragraph("A"), paragraph("B")]),
      { maxOperations: 1 },
    );
    expect(operationLimited.changeSet.limits.truncated).toBe(true);
    expect(operationLimited.changeSet.completeness.diagnostics.some((diagnostic) =>
      diagnostic.message.includes("operation limit exceeded"))).toBe(true);
  });
});
