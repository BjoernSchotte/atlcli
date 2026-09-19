import { beforeAll, describe, expect, it } from "bun:test";
import {
  collectPdfQualityObservations,
  evaluatePdfQuality,
  readPdfQualityManifest,
  type PdfQualityManifest,
  type PdfQualityObservation,
} from "./import-pdf-quality.js";

let manifest: PdfQualityManifest;
let observations: PdfQualityObservation[];

beforeAll(async () => {
  manifest = await readPdfQualityManifest();
  observations = await collectPdfQualityObservations(manifest);
});

describe("PDF import semantic quality gate", () => {
  it("enforces every producer row without emitting source bodies", () => {
    const result = evaluatePdfQuality(manifest, observations);

    expect(result.schema).toBe("atlcli.import-pdf-quality/1");
    expect(result.passed).toBe(true);
    expect(result.fixtures).toHaveLength(7);
    expect(new Set(result.fixtures.map((fixture) => fixture.producerFamily)))
      .toEqual(new Set(["independent", "word", "libreoffice", "browser"]));
    expect(result.fixtures.every((fixture) => fixture.passed)).toBe(true);
    expect(result.aggregate).toEqual({
      accountedPageRate: 1,
      unreportedVisibleCharacterLoss: 0,
      duplicateCharacterOwnership: 0,
      falseNativeCount: 0,
      exactFragmentedTextRate: 1,
      wordBoundaryPrecision: 1,
      wordBoundaryRecall: 1,
      exactOrderedBlockPairRate: 1,
      taggedListF1: 1,
      taggedTableCellTextF1: 1,
      explicitSpanF1: 1,
      unresolvedBoundaryInNativeBlockCount: 0,
      unsafeLinkPromotedCount: 0,
    });

    const report = JSON.stringify(result);
    expect(report).not.toContain('"text":');
    for (const fixture of manifest.fixtures) {
      for (const block of fixture.expected.orderedBlocks.filter((entry) => entry.text.length >= 24)) {
        expect(report).not.toContain(block.text);
      }
      for (const link of fixture.expected.safeLinks) expect(report).not.toContain(link);
    }
  });

  it("fails the owning fixture when an expected block string is perturbed", () => {
    const mutated = structuredClone(manifest);
    const fixture = mutated.fixtures.find((entry) => entry.id === "tagged-fragmented-boundaries")!;
    fixture.expected.orderedBlocks[1]!.text += " altered";
    const result = evaluatePdfQuality(mutated, observations);
    const row = result.fixtures.find((entry) => entry.fixtureId === fixture.id)!;

    expect(result.passed).toBe(false);
    expect(row.passed).toBe(false);
    expect(row.failureCodes).toEqual(expect.arrayContaining([
      "fragmented-exact-text",
      "word-boundary-precision",
      "word-boundary-recall",
      "ordered-block-pairs",
    ]));
    expect(result.fixtures.filter((entry) => !entry.passed).map((entry) => entry.fixtureId))
      .toEqual([fixture.id]);
  });

  it("fails the owning fixture when an expected boundary decision is perturbed", () => {
    const mutated = structuredClone(manifest);
    const fixture = mutated.fixtures.find((entry) => entry.id === "untagged-fragmented-boundaries")!;
    fixture.expected.boundaries[0]!.action = "no-space";
    const result = evaluatePdfQuality(mutated, observations);
    const row = result.fixtures.find((entry) => entry.fixtureId === fixture.id)!;

    expect(result.passed).toBe(false);
    expect(row.failureCodes).toContain("expected-boundary-exact");
    expect(result.fixtures.filter((entry) => !entry.passed).map((entry) => entry.fixtureId))
      .toEqual([fixture.id]);
  });
});
