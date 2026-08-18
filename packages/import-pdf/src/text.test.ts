import { describe, expect, it } from "bun:test";
import { normalizePdfText, normalizePdfTextFragment } from "./text.js";

describe("PDF text normalization", () => {
  it("removes non-rendering control codes before ADF publication", () => {
    expect(normalizePdfTextFragment("Alpha\u0002Beta\u0000\u007fGamma")).toBe("AlphaBetaGamma");
  });

  it("retains visible Unicode while canonicalizing source whitespace", () => {
    expect(normalizePdfText("  Grüße\r\nImport\tTeam  ")).toBe("Grüße Import Team");
  });
});
