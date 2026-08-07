/**
 * Unit tests for the veraPDF ratchet core (spec 011, PDF/UA). Pure — synthetic
 * veraPDF `--format json` payloads, no binary needed. Proves the ratchet catches
 * a NEW rule failure and a RISING failure count on an already-baselined rule
 * (not rule-id alone), and warns when a baselined rule starts passing.
 */
import { describe, expect, it } from "bun:test";
import {
  baselineKey,
  parseVeraPdfCompliance,
  parseVeraPdfReport,
  ratchet,
  type Baseline,
} from "./ratchet.js";

function reportWith(failedChecks: number, contexts: string[]): unknown {
  return {
    report: {
      jobs: [
        {
          itemDetails: { name: "blocks.pdf" },
          validationResult: [
            {
              profileName: "PDF/UA-1",
              compliant: false,
              details: {
                ruleSummaries: [
                  {
                    ruleStatus: "FAILED",
                    specification: "ISO 14289-1",
                    clause: "7.1",
                    testNumber: "3",
                    failedChecks,
                    checks: contexts.map((context) => ({ status: "FAILED", context })),
                  },
                  {
                    ruleStatus: "PASSED",
                    specification: "ISO 14289-1",
                    clause: "7.2",
                    testNumber: "1",
                    failedChecks: 0,
                    checks: [],
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  };
}

describe("parseVeraPdfReport", () => {
  it("extracts only FAILED rules, with clause-testNumber ids and instance counts", () => {
    const failures = parseVeraPdfReport(reportWith(2, ["root/pages[0]", "root/pages[1]"]), "blocks");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.ruleId).toBe("7.1-3");
    expect(failures[0]!.failureCount).toBe(2);
    expect(failures[0]!.fixture).toBe("blocks");
    expect(failures[0]!.locationsDigest).toHaveLength(16);
  });

  it("returns nothing for an empty/compliant report", () => {
    expect(parseVeraPdfReport({ report: { jobs: [] } }, "canary")).toEqual([]);
  });
});

describe("parseVeraPdfCompliance", () => {
  it("returns a conclusive validator verdict", () => {
    expect(parseVeraPdfCompliance(reportWith(2, ["root/pages[0]"]))).toEqual({
      compliant: false,
      profileNames: ["PDF/UA-1"],
      validationResults: 1,
    });
  });

  it("rejects missing and inconclusive validation output", () => {
    expect(() => parseVeraPdfCompliance({ report: { jobs: [] } })).toThrow(
      "no validation result",
    );
    expect(() =>
      parseVeraPdfCompliance({
        report: { jobs: [{ validationResult: [{ profileName: "PDF/A-2B" }] }] },
      }),
    ).toThrow("inconclusive");
  });
});

describe("ratchet", () => {
  const current = parseVeraPdfReport(reportWith(2, ["a", "b"]), "blocks");

  it("fails on a NEW rule not in the baseline", () => {
    const result = ratchet(current, {});
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("not in the baseline");
  });

  it("passes when the baselined rule has the same failure count", () => {
    const baseline: Baseline = {
      [baselineKey("blocks", "7.1-3")]: { failureCount: 2, locationsDigest: current[0]!.locationsDigest },
    };
    expect(ratchet(current, baseline).failures).toEqual([]);
  });

  it("fails when a baselined rule's failure count RISES (regression without a new rule)", () => {
    const baseline: Baseline = {
      [baselineKey("blocks", "7.1-3")]: { failureCount: 1, locationsDigest: "old" },
    };
    const result = ratchet(current, baseline);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("rose from 1 to 2");
  });

  it("warns when a baselined rule now passes (baseline should shrink)", () => {
    const baseline: Baseline = {
      [baselineKey("blocks", "9.9-9")]: { failureCount: 1, locationsDigest: "x" },
    };
    const result = ratchet(current, baseline);
    // The still-present 7.1-3 is a new failure; the absent 9.9-9 is a shrink warning.
    expect(result.warnings.some((w) => w.includes("9.9-9"))).toBe(true);
  });
});
