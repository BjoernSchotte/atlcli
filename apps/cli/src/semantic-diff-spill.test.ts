import { describe, expect, test } from "bun:test";
import { canonicalJsonV1 } from "@atlcli/change-set";
import {
  buildPageDiffChangeSetV1,
  type PageDiffPairV1,
} from "@atlcli/confluence/internal";
import {
  buildPageDiffChangeSetWithSpillV1,
  countSemanticDiffSpillDirectoriesForTestV1,
  shouldUseSemanticDiffSpillV1,
} from "./semantic-diff-spill.js";

function adfPair(count: number): PageDiffPairV1 {
  const content = Array.from({ length: count }, (_, index) => ({
    type: "paragraph",
    attrs: { localId: `paragraph-${String(index).padStart(6, "0")}` },
    content: [{ type: "text", text: `row-${index}` }],
  }));
  const target = structuredClone(content);
  target[Math.floor(count / 2)]!.content[0]!.text = "changed";
  const source = (version: number, value: unknown): PageDiffPairV1["from"] => ({
    id: "synthetic-page",
    title: "Synthetic",
    version,
    deployment: "cloud",
    body: { representation: "atlas_doc_format", value: JSON.stringify({ type: "doc", version: 1, content: value }) },
  });
  return {
    from: source(1, content),
    to: source(2, target),
    representation: "atlas_doc_format",
  };
}

function storagePair(count: number): PageDiffPairV1 {
  const rows = Array.from({ length: count }, (_, index) =>
    `<p local-id="paragraph-${String(index).padStart(6, "0")}">row-${index}</p>`);
  const target = [...rows];
  target[Math.floor(count / 2)] = target[Math.floor(count / 2)]!.replace(">row-", ">changed-");
  const source = (version: number, value: string): PageDiffPairV1["from"] => ({
    id: "synthetic-page",
    title: "Synthetic",
    version,
    deployment: "data-center",
    body: { representation: "storage", value },
    fallbackReason: "data-center",
  });
  return {
    from: source(1, rows.join("")),
    to: source(2, target.join("")),
    representation: "storage",
  };
}

describe("semantic diff spill", () => {
  test("selects spill deterministically by total source bytes", () => {
    const pair = adfPair(1);
    expect(shouldUseSemanticDiffSpillV1(pair, 0)).toBe(true);
    expect(shouldUseSemanticDiffSpillV1(pair, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(() => shouldUseSemanticDiffSpillV1(pair, -1)).toThrow("non-negative");
  });

  test("large indexed lane is byte-identical to the reference matcher", async () => {
    const pair = adfPair(2_001);
    const before = countSemanticDiffSpillDirectoriesForTestV1();
    const [reference, spilled] = await Promise.all([
      buildPageDiffChangeSetV1(pair),
      buildPageDiffChangeSetWithSpillV1(pair),
    ]);
    expect(canonicalJsonV1(spilled.changeSet)).toBe(canonicalJsonV1(reference.changeSet));
    expect(spilled.sourceChanges).toEqual(reference.sourceChanges);
    expect(countSemanticDiffSpillDirectoriesForTestV1()).toBe(before);
  }, 20_000);

  test("large Storage lane is byte-identical to the reference matcher", async () => {
    const pair = storagePair(2_001);
    const reference = await buildPageDiffChangeSetV1(pair);
    const spilled = await buildPageDiffChangeSetWithSpillV1(pair);
    expect(canonicalJsonV1(spilled.changeSet)).toBe(canonicalJsonV1(reference.changeSet));
    expect(spilled.sourceChanges).toEqual(reference.sourceChanges);
  }, 20_000);

  test("validation failure removes the owned temporary store", async () => {
    const pair = adfPair(1);
    pair.to.body.value = "{not-json";
    const before = countSemanticDiffSpillDirectoriesForTestV1();
    await expect(buildPageDiffChangeSetWithSpillV1(pair)).rejects.toThrow();
    expect(countSemanticDiffSpillDirectoriesForTestV1()).toBe(before);
  });
});
