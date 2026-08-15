import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertDisjointLaneOwnership,
  compareTopologyTimings,
  createTimingSnapshot,
  parseBunJUnit,
  topologyComparisonMarkdown,
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

  test("compares exact legacy and candidate testcase identities and timings", () => {
    const legacy = parseBunJUnit(
      junit(
        '<testcase name="a" classname="suite" time="2" file="pkg/a.test.ts" />' +
          '<testcase name="b" classname="suite" time="1" file="pkg/b.test.ts"><skipped /></testcase>',
      ),
      { namespace: "legacy-4-shard", lane: "legacy-1" },
    );
    const candidate = parseBunJUnit(
      junit(
        '<testcase name="b" classname="suite" time="0.5" file="pkg/b.test.ts"><skipped /></testcase>' +
          '<testcase name="a" classname="suite" time="1" file="pkg/a.test.ts" />',
      ),
      { namespace: "general-3x1", lane: "candidate-1" },
    );
    const comparison = compareTopologyTimings({ legacy: [legacy], candidate: [candidate] });
    expect(comparison).toMatchObject({
      schema: 1,
      files: 2,
      testcases: 2,
      legacyDurationSeconds: 3,
      candidateDurationSeconds: 1.5,
      deltaSeconds: -1.5,
      ratio: 0.5,
    });
    expect(topologyComparisonMarkdown(comparison)).toContain("Identity proof: 2 files / 2 testcases");
  });

  test("rejects topology coverage and outcome drift before comparing speed", () => {
    const legacy = parseBunJUnit(
      junit('<testcase name="a" time="1" file="pkg/a.test.ts" />'),
      { namespace: "legacy", lane: "one" },
    );
    const missing = parseBunJUnit(
      junit('<testcase name="b" time="1" file="pkg/b.test.ts" />'),
      { namespace: "candidate", lane: "one" },
    );
    expect(() => compareTopologyTimings({ legacy: [legacy], candidate: [missing] })).toThrow(
      "identity mismatch",
    );
    const failed = parseBunJUnit(
      junit('<testcase name="a" time="1" file="pkg/a.test.ts"><failure /></testcase>'),
      { namespace: "candidate", lane: "one" },
    );
    expect(() => compareTopologyTimings({ legacy: [legacy], candidate: [failed] })).toThrow(
      "outcome mismatch",
    );
  });

  test("writes reviewable snapshot and comparison JSON from JUnit directories", () => {
    const directory = mkdtempSync(join(tmpdir(), "atlcli-test-timings-"));
    try {
      const legacy = join(directory, "legacy");
      const candidate = join(directory, "candidate");
      mkdirSync(legacy);
      mkdirSync(candidate);
      writeFileSync(
        join(legacy, "one.xml"),
        junit('<testcase name="a" time="2" file="pkg/a.test.ts" />'),
      );
      writeFileSync(
        join(candidate, "one.xml"),
        junit('<testcase name="a" time="1" file="pkg/a.test.ts" />'),
      );
      const snapshot = join(directory, "snapshot.json");
      const comparison = join(directory, "comparison.json");
      const script = join(import.meta.dir, "test-timings.ts");
      const snapshotRun = Bun.spawnSync([
        "bun",
        script,
        "snapshot",
        "--junit",
        legacy,
        "--namespace",
        "legacy",
        "--baseline-sha",
        "a".repeat(40),
        "--source-run",
        "run-1",
        "--out",
        snapshot,
      ]);
      expect(snapshotRun.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(snapshot, "utf8"))).toMatchObject({ samples: 1 });
      const compareRun = Bun.spawnSync([
        "bun",
        script,
        "compare",
        "--legacy-junit",
        legacy,
        "--legacy-namespace",
        "legacy",
        "--candidate-junit",
        candidate,
        "--candidate-namespace",
        "candidate",
        "--out",
        comparison,
      ]);
      expect(compareRun.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(comparison, "utf8"))).toMatchObject({ ratio: 0.5 });
      expect(compareRun.stdout.toString()).toContain("Identity proof: 1 files / 1 testcases");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
