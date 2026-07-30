import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertDisjointLaneOwnership,
  createTimingSnapshot,
  parseBunJUnit,
} from "./test-timings.js";

function junit(testcases: string): string {
  return `<?xml version="1.0"?><testsuites><testsuite name="outer">${testcases}</testsuite></testsuites>`;
}

describe("Bun JUnit timings", () => {
  test("parses the sanitized Bun 1.3.14 nesting and leaf outcomes", () => {
    const xml = readFileSync(join(import.meta.dir, "fixtures/bun-1.3.14-junit.xml"), "utf8");
    const artifact = parseBunJUnit(xml, { namespace: "legacy", lane: "test-1" });

    expect(artifact.files).toEqual([
      {
        file: "packages/example/src/example.test.ts",
        durationSeconds: 0.03,
        tests: 2,
        passed: 1,
        failed: 0,
        skipped: 1,
      },
    ]);
    expect(artifact.testcases.map(({ outcome }) => outcome)).toEqual(["passed", "skipped"]);
  });

  test("retains failure counts and decodes XML attributes", () => {
    const artifact = parseBunJUnit(
      junit(
        '<testcase name="a &amp; b" classname="suite" time="1.25" file="pkg/a.test.ts"><failure /></testcase>',
      ),
      { namespace: "candidate", lane: "general-1" },
    );
    expect(artifact.testcases[0]?.name).toBe("a & b");
    expect(artifact.files[0]?.failed).toBe(1);
  });

  test("rejects duplicate leaf identities but ignores repeated suite file attributes", () => {
    const testcase =
      '<testcase name="same" classname="suite" time="0.1" file="pkg/a.test.ts" />';
    expect(() =>
      parseBunJUnit(junit(`${testcase}${testcase}`), {
        namespace: "legacy",
        lane: "test-1",
      }),
    ).toThrow("duplicate testcase identity");

    expect(() =>
      parseBunJUnit(
        '<testsuites><testsuite file="pkg/a.test.ts"><testsuite file="pkg/a.test.ts">' +
          testcase +
          "</testsuite></testsuite></testsuites>",
        { namespace: "legacy", lane: "test-1" },
      ),
    ).not.toThrow();
  });

  test("rejects malformed, invalid, negative, absolute, and escaping inputs", () => {
    expect(() =>
      parseBunJUnit("<testsuites><testcase", { namespace: "n", lane: "l" }),
    ).toThrow("testsuites envelope");
    for (const time of ["NaN", "Infinity", "-0.1"]) {
      expect(() =>
        parseBunJUnit(
          junit(`<testcase name="bad" time="${time}" file="pkg/a.test.ts" />`),
          { namespace: "n", lane: "l" },
        ),
      ).toThrow("invalid testcase duration");
    }
    for (const file of ["/tmp/a.test.ts", "../a.test.ts"]) {
      expect(() =>
        parseBunJUnit(junit(`<testcase name="bad" time="1" file="${file}" />`), {
          namespace: "n",
          lane: "l",
        }),
      ).toThrow();
    }
  });

  test("rejects duplicate file ownership within one topology namespace", () => {
    const xml = junit('<testcase name="a" time="1" file="pkg/a.test.ts" />');
    const legacyA = parseBunJUnit(xml, { namespace: "legacy", lane: "test-1" });
    const legacyB = parseBunJUnit(xml, { namespace: "legacy", lane: "test-2" });
    const candidate = parseBunJUnit(xml, { namespace: "candidate", lane: "test-1" });

    expect(() => assertDisjointLaneOwnership([legacyA, legacyB])).toThrow(
      "duplicate file ownership",
    );
    expect(() => assertDisjointLaneOwnership([legacyA, candidate])).not.toThrow();
  });

  test("creates a versioned snapshot only from disjoint artifacts", () => {
    const artifact = parseBunJUnit(
      junit('<testcase name="a" time="1" file="pkg/a.test.ts" />'),
      { namespace: "legacy", lane: "test-1" },
    );
    expect(
      createTimingSnapshot({
        baselineSha: "a".repeat(40),
        sourceRun: "https://github.com/example/repo/actions/runs/1",
        artifacts: [artifact],
      }),
    ).toMatchObject({ schema: 1, baselineSha: "a".repeat(40), samples: 1 });
    expect(() =>
      createTimingSnapshot({
        baselineSha: "not-a-sha",
        sourceRun: "run",
        artifacts: [artifact],
      }),
    ).toThrow("baseline SHA");
  });
});
