import { describe, expect, it } from "bun:test";
import type { PdfAnnotationFact, PdfTextCharacterFactV2 } from "./contracts.js";
import { taggedRunsV2 } from "./links.js";
import { assemblePdfTextV2 } from "./text-assembly.js";

function character(
  value: string,
  index: number,
  x: number,
  options: { generated?: boolean; bbox?: boolean; run?: string | null } = {},
): PdfTextCharacterFactV2 {
  return {
    index,
    unicode: value.codePointAt(0) ?? 0,
    value,
    bbox: options.bbox === false ? null : { x, y: 0.1, width: 0.009, height: 0.02 },
    fontSizePoints: 11,
    fontWeight: 400,
    angleRadians: 0,
    mcid: 0,
    textRunId: options.run === undefined ? "pdf:p0:text-run:0" : options.run,
    generated: options.generated ?? false,
    hyphen: false,
    unicodeMapError: false,
  };
}

function word(value: string, startIndex: number, startX: number, run: string) {
  return [...value].map((part, offset) =>
    character(part, startIndex + offset, startX + offset * 0.01, { run })
  );
}

function annotation(id: string, href: string, x: number, width: number): PdfAnnotationFact {
  return {
    id,
    subtype: 2,
    bbox: { x, y: 0.09, width, height: 0.04 },
    actionType: 3,
    safeExternalTarget: href,
    unsafeTargetReported: false,
  };
}

describe("PDF V2 tagged link projection", () => {
  it("inherits a synthesized separator only between characters owned by the same link", () => {
    const characters = [
      ...word("Harbor", 0, 0.1, "pdf:p0:text-run:0"),
      character("\n", 6, 0, { generated: true, bbox: false, run: null }),
      ...word("signal", 7, 0.2, "pdf:p0:text-run:1"),
    ];
    const links = [annotation("same", "https://example.com/harbor", 0.09, 0.18)];
    const assembly = assemblePdfTextV2({
      sourceId: "same-link",
      characters,
      orderBasis: "structure-order",
    });

    expect(assembly.text).toBe("Harbor signal");
    expect(taggedRunsV2(assembly, characters, links)).toEqual({
      runs: [{
        kind: "text",
        text: "Harbor signal",
        marks: { link: { href: "https://example.com/harbor" } },
      }],
      annotationIds: ["same"],
    });
  });

  it("keeps synthesized text unmarked across different links", () => {
    const characters = [
      ...word("North", 0, 0.1, "pdf:p0:text-run:0"),
      character("\n", 5, 0, { generated: true, bbox: false, run: null }),
      ...word("South", 6, 0.2, "pdf:p0:text-run:1"),
    ];
    const links = [
      annotation("north", "https://example.com/north", 0.09, 0.07),
      annotation("south", "https://example.com/south", 0.19, 0.07),
    ];
    const assembly = assemblePdfTextV2({
      sourceId: "different-links",
      characters,
      orderBasis: "structure-order",
    });

    expect(taggedRunsV2(assembly, characters, links)).toEqual({
      runs: [
        { kind: "text", text: "North", marks: { link: { href: "https://example.com/north" } } },
        { kind: "text", text: " " },
        { kind: "text", text: "South", marks: { link: { href: "https://example.com/south" } } },
      ],
      annotationIds: ["north", "south"],
    });
  });

  it("never transfers a source link onto non-aligning ActualText", () => {
    const characters = word("raw", 0, 0.1, "pdf:p0:text-run:0");
    const links = [annotation("raw", "https://example.com/raw", 0.09, 0.05)];
    const assembly = assemblePdfTextV2({
      sourceId: "actual-text-mismatch",
      characters,
      orderBasis: "structure-order",
      actualText: "author replacement",
      markedCharacterIndexes: [0, 1, 2],
    });

    expect(assembly.issues).toEqual([{
      code: "pdf-import/actual-text-mark-unmapped",
      characterIndexes: [0, 1, 2],
    }]);
    expect(taggedRunsV2(assembly, characters, links)).toEqual({
      runs: [{ kind: "text", text: "author replacement" }],
      annotationIds: [],
    });
  });
});
