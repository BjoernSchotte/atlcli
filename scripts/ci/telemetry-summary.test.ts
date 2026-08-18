import { describe, expect, test } from "bun:test";
import {
  buildCiTelemetrySummary,
  routesFromEnvironment,
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
  test("records every granular route without treating missing values as selected", () => {
    expect(
      routesFromEnvironment({
        CI_ROUTE_CODE: "true",
        CI_ROUTE_ASTRO_PLATFORM: "true",
        CI_ROUTE_PDF_PLATFORM: "false",
      }),
    ).toMatchObject({
      code: true,
      astroPlatform: true,
      pdfPlatform: false,
      browserHarness: false,
      researchPrivacy: false,
    });
  });

  test("combines disjoint lane JUnit with Actions timing data", () => {
    const summary = buildCiTelemetrySummary({
      commitSha: "a".repeat(40),
      sourceRun: "run-1",
      proofMode: "required",
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
      turbo: [{
        schema: 1,
        source: "quality",
        runs: [{
          id: "turbo-run-1",
          turboVersion: "2.10.11",
          tasks: [{
            taskId: "@atlcli/core#build",
            task: "build",
            package: "@atlcli/core",
            hash: "abcdef0123456789",
            cacheStatus: "HIT",
            localCache: true,
            remoteCache: false,
            timeSavedMs: 250,
            durationMs: 10,
            exitCode: 0,
          }],
        }],
      }],
    });
    expect(summary).toMatchObject({
      schema: 2,
      proofMode: "required",
      files: 2,
      testcases: 2,
      turbo: {
        runs: 1,
        tasks: 1,
        cacheHits: 1,
      },
    });
    expect(summary.slowestFiles[0]).toMatchObject({
      file: "pkg/slow.test.ts",
      durationSeconds: 2,
    });
    expect(summary.timingSnapshot).toMatchObject({
      schema: 1,
      baselineSha: "a".repeat(40),
      sourceRun: "run-1",
      samples: 2,
    });
    expect(telemetryMarkdown(summary)).toContain("legacy-4-shard");
    expect(telemetryMarkdown(summary)).toContain("Turbo cache: 1 hit / 0 miss");
  });

  test("fails closed when two lane artifacts own the same file", () => {
    expect(() =>
      buildCiTelemetrySummary({
        commitSha: "a".repeat(40),
        sourceRun: "run-1",
        proofMode: "required",
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
