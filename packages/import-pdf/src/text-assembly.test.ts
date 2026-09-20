import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PdfTextCharacterFactV2 } from "./contracts.js";
import {
  PDF_TEXT_ASSEMBLY_POLICY_REVISION_V2,
  assemblePdfTextV2,
  canonicalizePdfTextSourceFragmentV2,
  digestPdfTextAssemblyV2,
  type PdfTextAssemblyInputV2,
} from "./text-assembly.js";
import { createNodePdfiumFactsAdapterV2 } from "./node.js";

const fixtureRoot = resolve(import.meta.dir, "../../../specs/pdf-import-quality/fixtures");

interface CharacterOptions {
  run?: string | null;
  mcid?: number | null;
  y?: number;
  angle?: number;
  generated?: boolean;
  hyphen?: boolean;
  bbox?: boolean;
}

function character(
  value: string,
  index: number,
  x: number,
  options: CharacterOptions = {},
): PdfTextCharacterFactV2 {
  return {
    index,
    unicode: value.codePointAt(0) ?? 0,
    value,
    bbox: options.bbox === false
      ? null
      : { x, y: options.y ?? 0.1, width: 0.009, height: 0.02 },
    fontSizePoints: 11,
    fontWeight: 400,
    angleRadians: options.angle ?? 0,
    mcid: options.mcid ?? null,
    textRunId: options.run === undefined ? "pdf:p0:text-run:0" : options.run,
    generated: options.generated ?? false,
    hyphen: options.hyphen ?? false,
    unicodeMapError: false,
  };
}

function word(
  value: string,
  startIndex: number,
  startX: number,
  options: CharacterOptions = {},
): PdfTextCharacterFactV2[] {
  return [...value].map((part, offset) =>
    character(part, startIndex + offset, startX + offset * 0.01, options)
  );
}

function input(
  sourceId: string,
  characters: PdfTextCharacterFactV2[],
  overrides: Partial<PdfTextAssemblyInputV2> = {},
): PdfTextAssemblyInputV2 {
  return { sourceId, characters, orderBasis: "geometry", ...overrides };
}

function generatedWhitespace(value: string, index: number): PdfTextCharacterFactV2 {
  return character(value, index, 0, {
    run: null,
    generated: true,
    bbox: false,
  });
}

describe("PDF V2 text assembly", () => {
  it("preserves one authored space with exact provenance", () => {
    const characters = [
      ...word("Alpha", 0, 0.1),
      character(" ", 5, 0.15, { run: null, bbox: false }),
      ...word("Beta", 6, 0.18, { run: "pdf:p0:text-run:1" }),
    ];
    const result = assemblePdfTextV2(input("explicit-space", characters));

    expect(result.text).toBe("Alpha Beta");
    expect(result.boundaries).toEqual([{
      id: "pdf:boundary:explicit-space:0000:4-6:preserve-explicit-space",
      leftCharacterIndex: 4,
      rightCharacterIndex: 6,
      action: "preserve-explicit-space",
      basis: ["literal-whitespace"],
      confidence: 1,
    }]);
    expect(result.segments).toEqual([
      ...[..."Alpha"].map((text, index) => ({
        text,
        characterIndexes: [index],
        synthesized: false,
      })),
      { text: " ", characterIndexes: [5], synthesized: false },
      ...[..."Beta"].map((text, offset) => ({
        text,
        characterIndexes: [offset + 6],
        synthesized: false,
      })),
    ]);
  });

  it("inserts one same-line word space only for a qualified run gap", () => {
    const result = assemblePdfTextV2(input("run-gap", [
      ...word("Alpha", 0, 0.1),
      ...word("Beta", 5, 0.18, { run: "pdf:p0:text-run:1" }),
    ]));

    expect(result.text).toBe("Alpha Beta");
    expect(result.boundaries).toHaveLength(1);
    expect(result.boundaries[0]).toMatchObject({
      leftCharacterIndex: 4,
      rightCharacterIndex: 5,
      action: "insert-space",
      basis: ["text-run", "baseline", "glyph-gap", "script"],
      confidence: 0.9,
    });
    expect(result.segments.find((segment) => segment.text === " ")).toEqual({
      text: " ",
      characterIndexes: [],
      synthesized: true,
    });
  });

  it("does not invent a space for a style or MCID change without a word gap", () => {
    const result = assemblePdfTextV2(input("tight-run", [
      ...word("Alpha", 0, 0.1, { mcid: 1 }),
      ...word("Beta", 5, 0.151, { run: "pdf:p0:text-run:1", mcid: 2 }),
    ], { orderBasis: "structure-order" }));

    expect(result.text).toBe("AlphaBeta");
    expect(result.boundaries).toEqual([{
      id: "pdf:boundary:tight-run:0000:4-5:no-space",
      leftCharacterIndex: 4,
      rightCharacterIndex: 5,
      action: "no-space",
      basis: ["text-run", "structure-order", "baseline", "glyph-gap"],
      confidence: 0.9,
    }]);
  });

  it("joins a qualified physical-line continuation with one synthesized space", () => {
    const result = assemblePdfTextV2(input("line-join", [
      ...word("Wrapped", 0, 0.1),
      generatedWhitespace("\r", 7),
      generatedWhitespace("\n", 8),
      ...word("routes", 9, 0.1, { run: "pdf:p0:text-run:1", y: 0.15 }),
    ]));

    expect(result.text).toBe("Wrapped routes");
    expect(result.boundaries[0]).toMatchObject({
      leftCharacterIndex: 6,
      rightCharacterIndex: 9,
      action: "join-line",
      basis: ["generated-whitespace", "baseline", "script"],
      confidence: 0.95,
    });
    expect(result.segments.find((segment) => segment.synthesized)).toEqual({
      text: " ",
      characterIndexes: [7, 8],
      synthesized: true,
    });
  });

  it("keeps closing punctuation and text after an opening delimiter attached", () => {
    const result = assemblePdfTextV2(input("punctuation", [
      ...word("word", 0, 0.1),
      character(",", 4, 0.2, { run: "pdf:p0:text-run:1" }),
      character("(", 5, 0.23, { run: "pdf:p0:text-run:2" }),
      ...word("next", 6, 0.3, { run: "pdf:p0:text-run:3" }),
    ]));

    expect(result.text).toBe("word,(next");
    expect(result.boundaries.filter((boundary) => boundary.action === "no-space")).toEqual([
      expect.objectContaining({ leftCharacterIndex: 3, rightCharacterIndex: 4, basis: ["text-run", "punctuation", "baseline"] }),
      expect.objectContaining({ leftCharacterIndex: 5, rightCharacterIndex: 6, basis: ["text-run", "punctuation", "baseline"] }),
    ]);
  });

  it("preserves a generated separator after closing punctuation", () => {
    const result = assemblePdfTextV2(input("punctuation-space", [
      ...word("word", 0, 0.1),
      character(",", 4, 0.15, { run: "pdf:p0:text-run:1" }),
      generatedWhitespace(" ", 5),
      ...word("next", 6, 0.18, { run: "pdf:p0:text-run:2" }),
    ]));

    expect(result.text).toBe("word, next");
    expect(result.boundaries).toEqual([
      expect.objectContaining({ leftCharacterIndex: 3, rightCharacterIndex: 4, action: "no-space" }),
      expect.objectContaining({
        leftCharacterIndex: 4,
        rightCharacterIndex: 6,
        action: "insert-space",
        basis: ["generated-whitespace", "punctuation", "baseline", "glyph-gap"],
        confidence: 0.98,
      }),
    ]);
  });

  it("joins a physical line continuation after closing punctuation", () => {
    const result = assemblePdfTextV2(input("punctuation-line-wrap", [
      ...word("clause", 0, 0.1),
      character(",", 6, 0.16, { run: "pdf:p0:text-run:1" }),
      generatedWhitespace("\r", 7),
      generatedWhitespace("\n", 8),
      ...word("continued", 9, 0.1, { run: "pdf:p0:text-run:2", y: 0.15 }),
    ]));

    expect(result.text).toBe("clause, continued");
    expect(result.unresolvedBoundaryCount).toBe(0);
    expect(result.boundaries).toContainEqual(expect.objectContaining({
      leftCharacterIndex: 6,
      rightCharacterIndex: 9,
      action: "join-line",
      basis: ["generated-whitespace", "punctuation", "baseline", "script"],
      confidence: 0.95,
    }));
  });

  it("dehyphenates generated line evidence but retains an authored hard hyphen", () => {
    const generated = assemblePdfTextV2(input("generated-hyphen", [
      ...word("coor", 0, 0.1),
      character("\u0002", 4, 0.14, { hyphen: true }),
      ...word("dination", 5, 0.1, { run: "pdf:p0:text-run:1", y: 0.15 }),
    ], { orderBasis: "structure-order" }));
    const authored = assemblePdfTextV2(input("hard-hyphen", [
      ...word("north", 0, 0.1),
      character("-", 5, 0.15),
      ...word("east", 6, 0.16),
    ]));

    expect(generated.text).toBe("coordination");
    expect(generated.boundaries).toEqual([expect.objectContaining({
      leftCharacterIndex: 3,
      rightCharacterIndex: 5,
      action: "dehyphenate",
      basis: ["hyphen", "structure-order", "baseline", "script"],
      confidence: 0.99,
    })]);
    expect(authored.text).toBe("north-east");
    expect(authored.boundaries).toEqual([expect.objectContaining({
      leftCharacterIndex: 4,
      rightCharacterIndex: 6,
      action: "retain-hyphen",
      basis: ["hyphen", "script"],
      confidence: 1,
    })]);
  });

  it("expands only allowlisted presentation ligatures and keeps NFC stable", () => {
    const ligature = assemblePdfTextV2(input("ligature", word("o\ufb03ce", 0, 0.1)));
    const nfc = assemblePdfTextV2(input("nfc", [
      character("e", 0, 0.1),
      character("\u0301", 1, 0.11),
      character("①", 2, 0.12),
    ]));

    expect(ligature.text).toBe("office");
    expect(ligature.transformations).toEqual([expect.objectContaining({
      action: "expand-presentation-ligature",
      characterIndexes: [1],
      confidence: 1,
    })]);
    expect(nfc.text).toBe("é①");
    expect(nfc.text).not.toContain("1");
    expect(canonicalizePdfTextSourceFragmentV2("A\r\nB\u00ad")).toBe("A\nB\u00ad");
  });

  it("does not infer a CJK space from a run change", () => {
    const result = assemblePdfTextV2(input("cjk", [
      character("港", 0, 0.1),
      generatedWhitespace(" ", 1),
      character("の", 2, 0.2, { run: "pdf:p0:text-run:1" }),
      character("信", 3, 0.21, { run: "pdf:p0:text-run:1" }),
      character("号", 4, 0.22, { run: "pdf:p0:text-run:1" }),
    ]));

    expect(result.text).toBe("港の信号");
    expect(result.boundaries[0]).toMatchObject({
      action: "no-space",
      basis: ["generated-whitespace", "script"],
      confidence: 0.98,
    });
  });

  it("preserves caller-supplied RTL logical order while qualifying its boundary", () => {
    const first = word("مرحبا", 0, 0.4, { run: "pdf:p0:text-run:0" })
      .map((item, offset) => ({ ...item, bbox: { ...item.bbox!, x: 0.4 - offset * 0.01 } }));
    const second = word("بالميناء", 6, 0.3, { run: "pdf:p0:text-run:1" })
      .map((item, offset) => ({ ...item, bbox: { ...item.bbox!, x: 0.3 - offset * 0.01 } }));
    const result = assemblePdfTextV2(input("rtl", [
      ...first,
      generatedWhitespace(" ", 5),
      ...second,
    ]));

    expect(result.text).toBe("مرحبا بالميناء");
    expect(result.direction).toBe("rtl");
    expect(result.characterIndexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it("reports conflicting material geometry instead of guessing", () => {
    const result = assemblePdfTextV2(input("conflict", [
      ...word("Alpha", 0, 0.1),
      ...word("Beta", 5, 0.18, { run: "pdf:p0:text-run:1", angle: 0.4 }),
    ]));

    expect(result.text).toBe("AlphaBeta");
    expect(result.unresolvedBoundaryCount).toBe(1);
    expect(result.boundaries).toEqual([expect.objectContaining({
      action: "unresolved",
      basis: ["text-run", "baseline", "glyph-gap", "script"],
      confidence: 0.25,
    })]);
  });

  it("uses ActualText authoritatively and reports unalignable marked characters without body text", () => {
    const characters = word("LINK", 0, 0.1);
    const result = assemblePdfTextV2(input("actual-text", characters, {
      actualText: "Author value",
      markedCharacterIndexes: characters.map((item) => item.index),
    }));

    expect(result.text).toBe("Author value");
    expect(result.usedActualText).toBe(true);
    expect(result.segments).toEqual([{
      text: "Author value",
      characterIndexes: [],
      synthesized: true,
    }]);
    expect(result.boundaries).toEqual([expect.objectContaining({
      leftCharacterIndex: null,
      rightCharacterIndex: null,
      action: "preserve-explicit-space",
      basis: ["actual-text"],
    })]);
    expect(result.issues).toEqual([{
      code: "pdf-import/actual-text-mark-unmapped",
      characterIndexes: [0, 1, 2, 3],
    }]);
    expect(JSON.stringify(result.issues)).not.toContain("Author value");
  });

  it("uses aligned and empty ActualText authoritatively", () => {
    const conflictCharacters = [
      ...word("Alpha", 0, 0.1),
      ...word("Beta", 5, 0.18, { run: "pdf:p0:text-run:1", angle: 0.4 }),
    ];
    const aligned = assemblePdfTextV2(input("actual-aligned", conflictCharacters, {
      actualText: "AlphaBeta",
    }));
    const empty = assemblePdfTextV2(input("actual-empty", word("hidden", 0, 0.1), {
      actualText: "",
    }));

    expect(aligned.text).toBe("AlphaBeta");
    expect(aligned.unresolvedBoundaryCount).toBe(0);
    expect(aligned.boundaries).toEqual([expect.objectContaining({
      id: "pdf:boundary:actual-aligned:0000:4-5:no-space",
      action: "no-space",
      basis: ["text-run", "baseline", "glyph-gap", "script", "actual-text"],
      confidence: 1,
    })]);
    expect(empty).toMatchObject({
      text: "",
      segments: [],
      usedActualText: true,
    });
  });

  it("produces identical assembly and digest across repeated pure runs", async () => {
    const source = input("deterministic", [
      ...word("Stable", 0, 0.1),
      ...word("result", 6, 0.19, { run: "pdf:p0:text-run:1" }),
    ]);
    const results = Array.from({ length: 3 }, () => assemblePdfTextV2(source));
    const digests = await Promise.all(results.map(digestPdfTextAssemblyV2));

    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(new Set(digests).size).toBe(1);
    expect(digests[0]).toMatch(/^[a-f0-9]{64}$/u);
    expect(results[0]?.policyRevision).toBe(PDF_TEXT_ASSEMBLY_POLICY_REVISION_V2);
  });

  it("calibrates exact boundary evidence against the neutral PDF corpus", async () => {
    const adapter = await createNodePdfiumFactsAdapterV2();
    const tagged = await adapter.analyze(new Uint8Array(await readFile(
      resolve(fixtureRoot, "independent-fragmented-tagged.pdf"),
    )));
    const taggedCharacters = tagged.facts.pages[0]!.characters;
    const paragraph = assemblePdfTextV2(input(
      "neutral-tagged-paragraph",
      taggedCharacters.filter((item) => item.index >= 25 && item.index <= 52),
      { orderBasis: "structure-order" },
    ));
    const hyphenCharacters = taggedCharacters.filter((item) => item.mcid === 4);
    const hyphenStart = Math.min(...hyphenCharacters.map((item) => item.index));
    const hyphenEnd = Math.max(...hyphenCharacters.map((item) => item.index));
    const hyphenated = assemblePdfTextV2(input(
      "neutral-tagged-hyphen",
      taggedCharacters.filter((item) => item.index >= hyphenStart && item.index <= hyphenEnd),
      { orderBasis: "structure-order" },
    ));

    const untagged = await adapter.analyze(new Uint8Array(await readFile(
      resolve(fixtureRoot, "independent-fragmented-untagged.pdf"),
    )));
    const untaggedCharacters = untagged.facts.pages[0]!.characters;
    const wrappedRuns = new Set(["pdf:p0:text-run:4", "pdf:p0:text-run:5"]);
    const wrappedOwned = untaggedCharacters.filter((item) =>
      item.textRunId !== null && wrappedRuns.has(item.textRunId)
    );
    const wrappedStart = Math.min(...wrappedOwned.map((item) => item.index));
    const wrappedEnd = Math.max(...wrappedOwned.map((item) => item.index));
    const wrapped = assemblePdfTextV2(input(
      "neutral-untagged-wrap",
      untaggedCharacters.filter((item) => item.index >= wrappedStart && item.index <= wrappedEnd),
    ));

    expect(paragraph.text).toBe("Harbor signals remain clear.");
    expect(paragraph.boundaries.filter((boundary) =>
      (boundary.leftCharacterIndex === 30 && boundary.rightCharacterIndex === 32) ||
      (boundary.leftCharacterIndex === 38 && boundary.rightCharacterIndex === 40)
    ).map((boundary) => ({
      left: boundary.leftCharacterIndex,
      right: boundary.rightCharacterIndex,
      action: boundary.action,
      basis: boundary.basis,
    }))).toEqual([
      {
        left: 30,
        right: 32,
        action: "insert-space",
        basis: ["generated-whitespace", "text-run", "structure-order", "baseline", "glyph-gap"],
      },
      {
        left: 38,
        right: 40,
        action: "insert-space",
        basis: ["generated-whitespace", "text-run", "structure-order", "baseline", "glyph-gap"],
      },
    ]);
    expect(hyphenated.text).toBe("Seasonal coordination stays stable.");
    expect(hyphenated.boundaries).toContainEqual(expect.objectContaining({
      leftCharacterIndex: 67,
      rightCharacterIndex: 69,
      action: "dehyphenate",
      basis: ["hyphen", "structure-order", "baseline", "script"],
    }));
    expect(wrapped.text).toBe("Wrapped routes continue safely without explicit breaks.");
    expect(wrapped.boundaries).toContainEqual(expect.objectContaining({
      leftCharacterIndex: 79,
      rightCharacterIndex: 82,
      action: "join-line",
      basis: ["generated-whitespace", "baseline", "script"],
    }));
  });
});
