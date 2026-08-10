import { describe, expect, test } from "bun:test";
import {
  ChangeDigestErrorV1,
  canonicalJsonBytesV1,
  createChangeOperationIdV1,
  digestSnapshotV1,
  sha256HexV1,
  type ChangeRiskTagV1,
  type ModifyOperationV1,
} from "./index.js";

const encoder = new TextEncoder();
const BASELINE = "a".repeat(64);
const TARGET = "b".repeat(64);

function modifyDraft(
  riskTags: readonly ChangeRiskTagV1[],
): Omit<ModifyOperationV1, "id"> {
  return {
    kind: "modify",
    path: ["content", 0],
    before: { text: "before", attrs: { b: 2, a: 1 } },
    after: { text: "after" },
    matchBasis: "stable-id",
    confidence: "anchored",
    riskTags,
    source: { baseline: "atlas_doc_format", target: "atlas_doc_format" },
    coveredSourceChangeIds: ["source-1"],
  };
}

describe("portable SHA-256 digests", () => {
  test("matches the published SHA-256 vector for abc", async () => {
    expect(await sha256HexV1(encoder.encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("binds snapshot digests to canonical source schema and representation", async () => {
    const left = await digestSnapshotV1("atlas_doc_format", { b: 2, a: 1 });
    const reordered = await digestSnapshotV1("atlas_doc_format", { a: 1, b: 2 });
    const storage = await digestSnapshotV1("storage", { a: 1, b: 2 });
    expect(left).toBe(reordered);
    expect(left).toMatch(/^[a-f0-9]{64}$/u);
    expect(storage).not.toBe(left);
    expect(left).toBe(await sha256HexV1(canonicalJsonBytesV1({
      representation: "atlas_doc_format",
      schema: "atlcli.canonical-source/1",
      tree: { a: 1, b: 2 },
    })));
  });

  test("hashes a bounded 100k-node source tree beyond the generic JSON budget", async () => {
    const children = Array.from({ length: 100_000 }, (_, index) => ({
      kind: "leaf",
      attributes: { index },
      children: [],
    }));
    const digest = await digestSnapshotV1("atlas_doc_format", {
      kind: "root",
      attributes: {},
      children,
    });
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("binds operation IDs to subject, snapshots, paths, and changed values", async () => {
    const context = {
      subject: { provider: "confluence", kind: "page", id: "123" } as const,
      baselineDigest: BASELINE,
      targetDigest: TARGET,
    };
    const first = await createChangeOperationIdV1(context, modifyDraft(["content-change"]));
    const reviewMetadataChanged = await createChangeOperationIdV1(
      context,
      modifyDraft(["content-change", "structure-change"]),
    );
    const otherBaseline = await createChangeOperationIdV1(
      { ...context, baselineDigest: "c".repeat(64) },
      modifyDraft(["content-change"]),
    );
    const otherPath = await createChangeOperationIdV1(context, {
      ...modifyDraft(["content-change"]),
      path: ["content", 1],
    });
    const otherValue = await createChangeOperationIdV1(context, {
      ...modifyDraft(["content-change"]),
      after: { text: "different" },
    });
    expect(first).toBe(reviewMetadataChanged);
    expect(otherBaseline).not.toBe(first);
    expect(otherPath).not.toBe(first);
    expect(otherValue).not.toBe(first);
  });

  test("fails closed for malformed baseline tokens", async () => {
    await expect(createChangeOperationIdV1({
      subject: { provider: "jira", kind: "issue", id: "ATL-1" },
      baselineDigest: "not-a-digest",
      targetDigest: TARGET,
    }, modifyDraft([]))).rejects.toBeInstanceOf(ChangeDigestErrorV1);
  });
});
