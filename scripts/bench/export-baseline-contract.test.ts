import { describe, expect, it } from "bun:test";
import { generateLargeExportCorpus } from "@atlcli/export-fixtures";
import {
  EXPORT_BASELINE_DEFAULT_SEED,
  logicalCorpusBytes,
  parseExportBaselineArgs,
} from "./export-baseline-contract.js";

describe("pre-queue export baseline contract", () => {
  it("defaults to both committed corpus sizes and formats", () => {
    expect(parseExportBaselineArgs([])).toEqual({
      pages: [50, 500],
      formats: ["docx", "pdf"],
      repeat: 3,
      seed: EXPORT_BASELINE_DEFAULT_SEED,
    });
  });

  it("accepts a bounded reproducible slice", () => {
    expect(
      parseExportBaselineArgs([
        "--pages",
        "50",
        "--formats",
        "pdf",
        "--repeat",
        "1",
        "--seed",
        "123",
        "--out",
        "result.json",
      ]),
    ).toEqual({ pages: [50], formats: ["pdf"], repeat: 1, seed: 123, out: "result.json" });
  });

  it("rejects uncommitted sizes, formats and invalid repeats", () => {
    expect(() => parseExportBaselineArgs(["--pages", "51"])).toThrow("--pages");
    expect(() => parseExportBaselineArgs(["--formats", "python"])).toThrow("--formats");
    expect(() => parseExportBaselineArgs(["--repeat", "0"])).toThrow("--repeat");
  });

  it("counts structural UTF-8 and every asset byte", () => {
    const corpus = generateLargeExportCorpus({ pages: 50, seed: 123 });
    expect(logicalCorpusBytes(corpus)).toBe(
      new TextEncoder().encode(JSON.stringify(corpus.nodes)).byteLength + corpus.counts.assetBytes,
    );
  });
});

