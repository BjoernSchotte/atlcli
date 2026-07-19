/**
 * CI seam for the hardcoding-ledger lint stub (spec 007 T2.5).
 *
 * `bun test` runs every `*.test.ts` in the repo, so this wrapper is what makes
 * `check-hardcoding-ledger.ts` actually run in CI without hooking the
 * tsc-focused root `typecheck`. The lint MUST pass on the current
 * `template.ts` + ledger; it must also catch a newly introduced, unledgered
 * hardcoded value.
 *
 * See `012-pdf-template-migration/PLAN.md` — it inherits this guard.
 */
import { describe, expect, it } from "bun:test";
import {
  checkHardcodingLedger,
  parseLedgerRecordedSet,
  scanTemplate,
} from "./check-hardcoding-ledger.js";

describe("check-hardcoding-ledger", () => {
  it("passes on the current template.ts against the ledger", () => {
    const result = checkHardcodingLedger();
    if (result.violations.length > 0) {
      // Surface the offenders in the failure message for a fast fix.
      const detail = result.violations
        .map((v) => `${v.class} ${v.token} @ ${v.line}:${v.column}`)
        .join("\n");
      throw new Error(`Unledgered hardcoded values found:\n${detail}`);
    }
    expect(result.violations).toEqual([]);
    expect(result.recordedCount).toBeGreaterThan(0);
  });

  it("detects a new unledgered hex color, length, and font family", () => {
    const recorded = parseLedgerRecordedSet("`#4B57A3` `Source Sans 3` `10pt`");
    const injected = [
      `rgb("#ABCDEF")`, // unledgered hex
      `size: 42pt`, // unledgered length
      `set text(font: "Comic Sans")`, // unledgered font
    ].join("\n");
    const violations = scanTemplate(injected, recorded);
    const classes = violations.map((v) => v.class).sort();
    expect(classes).toEqual(["font-family", "hex-color", "length"]);
    expect(violations.every((v) => v.line > 0 && v.column > 0)).toBe(true);
  });

  it("does not flag values recorded in the ledger or on the structural allowlist", () => {
    const recorded = parseLedgerRecordedSet("`#4B57A3` `10pt` `Source Sans 3`");
    const source = [
      `rgb("#4B57A3")`, // recorded
      `size: 10pt`, // recorded
      `font: "Source Sans 3"`, // recorded
      `default: 96) * 1pt`, // engine-structural allowlist
    ].join("\n");
    expect(scanTemplate(source, recorded)).toEqual([]);
  });
});
