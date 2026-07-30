import { describe, expect, test } from "bun:test";
import {
  buildCiTelemetrySummary,
  telemetryMarkdown,
} from "./telemetry-summary.js";

function junit(file: string, seconds: number): string {
  return (
    "<testsuites><testsuite>" +
    `<testcase name="works" classname="suite" time="${seconds}" file="${file}" />` +
    "</testsuite></testsuites>"
  );
}

describe("CI telemetry summary", () => {
  test("combines disjoint lane JUnit with Actions timing data", () => {
    const summary = buildCiTelemetrySummary({
      commitSha: "a".repeat(40),
      sourceRun: "run-1",
      topology: "legacy-4-shard",
      routes: { code: true },
      junit: [
        { lane: "shard-1", xml: junit("pkg/slow.test.ts", 2) },
        { lane: "shard-2", xml: junit("pkg/fast.test.ts", 1) },
      ],
      jobs: [
        {
          id: 1,
          name: "tests",
          status: "completed",
          conclusion: "success",
          created_at: "2026-07-30T10:00:00Z",
          started_at: "2026-07-30T10:00:01Z",
          completed_at: "2026-07-30T10:00:04Z",
        },
      ],
    });
    expect(summary).toMatchObject({
      schema: 1,
      files: 2,
      testcases: 2,
    });
    expect(summary.slowestFiles[0]).toMatchObject({
      file: "pkg/slow.test.ts",
      durationSeconds: 2,
    });
    expect(telemetryMarkdown(summary)).toContain("legacy-4-shard");
  });

  test("fails closed when two lane artifacts own the same file", () => {
    expect(() =>
      buildCiTelemetrySummary({
        commitSha: "a".repeat(40),
        sourceRun: "run-1",
        topology: "candidate",
        routes: {},
        junit: [
          { lane: "one", xml: junit("pkg/a.test.ts", 1) },
          { lane: "two", xml: junit("pkg/a.test.ts", 1) },
        ],
        jobs: [],
      }),
    ).toThrow("duplicate file ownership");
  });
});
