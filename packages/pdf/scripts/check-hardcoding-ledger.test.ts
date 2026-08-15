/**
 * CI seam for the hardcoding-ledger lint (spec 007 T2.5 → spec 012 T6.3,
 * CI-enforced).
 *
 * `bun test` runs every `*.test.ts` in the repo, so this wrapper is what makes
 * `check-hardcoding-ledger.ts` actually run in CI. Post-migration the lint MUST
 * find ZERO bare presentation literals in both templates/`serialize.ts` (all now
 * interpolated from the manifest design), and it must still catch a newly
 * introduced bare hex, length, or font family.
 */
import { describe, expect, it } from "bun:test";
import {
  blankInterpolations,
  checkHardcodingLedger,
  scanSource,
} from "./check-hardcoding-ledger.js";

describe("check-hardcoding-ledger (CI-enforced)", () => {
  it("finds zero bare presentation literals in the migrated hot files", () => {
    const result = checkHardcodingLedger();
    if (result.violations.length > 0) {
      const detail = result.violations
        .map((v) => `${v.file}:${v.line}:${v.column} ${v.class} ${v.token}`)
        .join("\n");
      throw new Error(`Bare presentation literals leaked back into engine code:\n${detail}`);
    }
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toEqual([
      "template.ts",
      "template-v4.ts",
      "serialize.ts",
    ]);
  });

  it("detects a new bare hex color, length, and font family", () => {
    const injected = [
      `rgb("#ABCDEF")`, // bare hex
      `size: 42pt`, // bare length
      `set text(font: "Comic Sans")`, // bare font family
    ].join("\n");
    const classes = scanSource(injected, "template.ts").map((v) => v.class).sort();
    expect(classes).toEqual(["font-family", "hex-color", "length"]);
  });

  it("ignores values interpolated from the design (interpolation spans)", () => {
    // Plain strings (not template literals) so the `${…}` are literal text the
    // lint must blank before scanning.
    const source = [
      'fill: rgb("${C("ink")}")',
      "size: ${rsize(\"h1\")}",
      'font: "${F("heading")}"',
    ].join("\n");
    expect(scanSource(source, "template.ts")).toEqual([]);
  });

  it("allows the engine-invariant unit multiplier but nothing else structural", () => {
    expect(scanSource("size: wm.size * 1pt", "template.ts")).toEqual([]);
    expect(scanSource("radius: 3pt", "template.ts").map((v) => v.token)).toEqual(["3pt"]);
  });

  it("blankInterpolations preserves length so columns stay stable", () => {
    const line = "a ${design.x} b";
    expect(blankInterpolations(line)).toHaveLength(line.length);
    expect(blankInterpolations(line)).not.toContain("${");
  });
});
