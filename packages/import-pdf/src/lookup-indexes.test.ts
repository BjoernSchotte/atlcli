import { describe, expect, it } from "bun:test";
import { digestPdfCanonical, digestPdfFactsV2 } from "./canonical.js";
import type { PdfFactsV2, PdfPageFactsV2, PdfTextCharacterFactV2 } from "./contracts.js";
import { evidenceForBlock, indexEvidenceByRef } from "./evidence-index.js";
import { isPdfImportError } from "./issues.js";
import { charactersForOrderedMcidsV2 } from "./text.js";

function character(index: number, value: string, mcid: number | null, generated = false): PdfTextCharacterFactV2 {
  return {
    index,
    unicode: value.codePointAt(0)!,
    value,
    bbox: { x: 0.1 + index * 0.01, y: 0.1, width: 0.01, height: 0.02 },
    fontSizePoints: 10,
    fontWeight: 400,
    angleRadians: 0,
    mcid,
    textRunId: null,
    generated,
    hyphen: false,
    unicodeMapError: false,
  };
}

describe("facts digest reuse", () => {
  const facts = { schema: "probe", pages: [{ index: 0 }] } as unknown as PdfFactsV2;

  it("matches the canonical digest and still enforces a byte budget after reuse", async () => {
    const expected = await digestPdfCanonical(facts);
    expect(await digestPdfFactsV2(facts)).toBe(expected);
    expect(await digestPdfFactsV2(facts)).toBe(expected);
    const tight = await digestPdfFactsV2(facts, 1).catch((error: unknown) => error);
    expect(isPdfImportError(tight) && tight.code).toBe("pdf/budget-exceeded");
  });

  it("hashes when the first request was over a tighter budget", async () => {
    const other = { ...facts } as PdfFactsV2;
    await expect(digestPdfFactsV2(other, 1)).rejects.toThrow();
    expect(await digestPdfFactsV2(other)).toBe(await digestPdfCanonical(other));
  });

  it("hashes a changed copy afresh", async () => {
    const changed = { ...facts, pageCount: 2 } as PdfFactsV2;
    expect(await digestPdfFactsV2(changed)).not.toBe(await digestPdfFactsV2(facts));
  });
});

describe("evidence index", () => {
  it("finds entries by source id, target id and source refs, each once", () => {
    const evidence = [
      { sourceId: "a", targetNodeId: "block" },
      { sourceId: "block" },
      { sourceId: "ref", targetNodeId: "ref" },
      { sourceId: "other", targetNodeId: "elsewhere" },
    ];
    const index = indexEvidenceByRef(evidence);
    expect(evidenceForBlock(index, { id: "block", sourceRefs: ["ref", "block"] })).toEqual(evidence.slice(0, 3));
    expect(evidenceForBlock(index, { id: "missing" })).toEqual([]);
  });
});

describe("page character index", () => {
  const characters = [
    character(0, "A", 1),
    character(1, " ", null, true),
    character(2, "B", 2),
    character(3, "x", null),
    character(4, "C", 1),
  ];
  const order = (list: PdfTextCharacterFactV2[]) =>
    charactersForOrderedMcidsV2({ characters: list } as unknown as PdfPageFactsV2, [1, 2])
      .map((entry) => entry.index);

  it("keeps MCID order and bridges generated whitespace between owned runs", () => {
    // MCID 1 owns 0 and 4; MCID 2 follows with 2, which is not after 4, so nothing bridges.
    expect(order(characters)).toEqual([0, 4, 2]);
    expect(charactersForOrderedMcidsV2({ characters } as unknown as PdfPageFactsV2, [2, 1])
      .map((entry) => entry.index)).toEqual([2, 0, 4]);
    const bridged = [character(0, "A", 1), character(1, " ", null, true), character(2, "B", 2)];
    expect(order(bridged)).toEqual([0, 1, 2]);
  });

  it("gives the same answer when the characters are not in index order", () => {
    const bridged = [character(2, "B", 2), character(1, " ", null, true), character(0, "A", 1)];
    expect(order(bridged)).toEqual([0, 1, 2]);
  });
});
