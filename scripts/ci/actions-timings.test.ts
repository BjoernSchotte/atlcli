import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  summarizeActionsJobs,
  type ActionsJob,
} from "./actions-timings.js";

describe("Actions timing summary", () => {
  test("computes queue, runner, phase, wall, critical-path, and runner-minute data", () => {
    const fixture = JSON.parse(
      readFileSync(join(import.meta.dir, "fixtures/actions-jobs.json"), "utf8"),
    ) as { jobs: ActionsJob[]; dependencies: Record<string, string[]> };
    const summary = summarizeActionsJobs(fixture.jobs, fixture.dependencies);

    expect(summary).toMatchObject({
      schema: 1,
      sampleClass: "green",
      eligibleForGreenPercentiles: true,
      workflowWallSeconds: 90,
      criticalPathSeconds: 90,
      criticalPathJobs: ["changes", "quality", "required"],
      totalRunnerMinutes: 1.25,
    });
    expect(summary.jobs[0]).toMatchObject({
      queueSeconds: 5,
      runnerSeconds: 10,
      phases: [{ name: "Classify", durationSeconds: 5 }],
    });
  });

  test("counts a started cancelled job in runner minutes but excludes it from green samples", () => {
    const jobs: ActionsJob[] = [
      {
        id: 1,
        name: "cancelled-test",
        status: "completed",
        conclusion: "cancelled",
        created_at: "2026-07-30T10:00:00Z",
        started_at: "2026-07-30T10:00:10Z",
        completed_at: "2026-07-30T10:01:10Z",
      },
      {
        id: 2,
        name: "never-started",
        status: "completed",
        conclusion: "skipped",
        created_at: "2026-07-30T10:00:00Z",
        started_at: null,
        completed_at: null,
      },
    ];
    const summary = summarizeActionsJobs(jobs);
    expect(summary.sampleClass).toBe("cancelled");
    expect(summary.eligibleForGreenPercentiles).toBe(false);
    expect(summary.totalRunnerMinutes).toBe(1);
    expect(summary.jobs[1]?.runnerSeconds).toBeNull();
  });

  test("ignores GitHub timestamp anomalies for skipped jobs", () => {
    const summary = summarizeActionsJobs([
      {
        id: 1,
        name: "required",
        status: "completed",
        conclusion: "success",
        created_at: "2026-07-30T10:00:00Z",
        started_at: "2026-07-30T10:00:01Z",
        completed_at: "2026-07-30T10:00:05Z",
      },
      {
        id: 2,
        name: "skipped-attestation",
        status: "completed",
        conclusion: "skipped",
        created_at: "2026-07-30T10:00:00Z",
        started_at: "2026-07-30T10:00:10Z",
        completed_at: "2026-07-30T10:00:09Z",
        steps: [
          {
            name: "skipped-step",
            conclusion: "skipped",
            started_at: "2026-07-30T10:00:10Z",
            completed_at: "2026-07-30T10:00:09Z",
          },
        ],
      },
    ]);

    expect(summary).toMatchObject({
      sampleClass: "green",
      eligibleForGreenPercentiles: true,
      workflowWallSeconds: 5,
      criticalPathSeconds: 5,
      criticalPathJobs: ["required"],
    });
    expect(summary.jobs[1]).toMatchObject({
      queueSeconds: null,
      runnerSeconds: null,
      phases: [{ name: "skipped-step", durationSeconds: null }],
    });
  });

  test("labels failures separately from green percentile samples", () => {
    const summary = summarizeActionsJobs([
      {
        id: 1,
        name: "test",
        status: "completed",
        conclusion: "failure",
        created_at: "2026-07-30T10:00:00Z",
        started_at: "2026-07-30T10:00:01Z",
        completed_at: "2026-07-30T10:00:02Z",
      },
    ]);
    expect(summary.sampleClass).toBe("failed");
    expect(summary.eligibleForGreenPercentiles).toBe(false);
  });

  // Regression: on a re-run attempt GitHub carries passed jobs over from the
  // earlier attempt but stamps created_at with the new attempt, so it lands
  // after started_at. The crash turned every re-run's telemetry job red, which
  // marked the canonical main run failed (run 38637454432, attempt 2).
  test("reports no queue time for jobs carried over from an earlier attempt", () => {
    const summary = summarizeActionsJobs([
      {
        id: 1,
        name: "consumer-smoke",
        status: "completed",
        conclusion: "success",
        created_at: "2026-07-30T11:00:00Z",
        started_at: "2026-07-30T10:00:01Z",
        completed_at: "2026-07-30T10:02:01Z",
      },
      {
        id: 2,
        name: "rerun-test",
        status: "completed",
        conclusion: "success",
        created_at: "2026-07-30T11:00:00Z",
        started_at: "2026-07-30T11:00:05Z",
        completed_at: "2026-07-30T11:01:05Z",
      },
    ]);
    expect(summary.jobs[0]).toMatchObject({ queueSeconds: null, runnerSeconds: 120 });
    expect(summary.jobs[1]).toMatchObject({ queueSeconds: 5, runnerSeconds: 60 });
  });

  test("rejects malformed and backwards timestamps", () => {
    const base: ActionsJob = {
      id: 1,
      name: "test",
      status: "completed",
      conclusion: "success",
      created_at: "2026-07-30T10:00:00Z",
      started_at: "2026-07-30T10:00:01Z",
      completed_at: "2026-07-30T10:00:02Z",
    };
    expect(() =>
      summarizeActionsJobs([{ ...base, started_at: "not-a-date" }]),
    ).toThrow("invalid");
    expect(() =>
      summarizeActionsJobs([
        {
          ...base,
          started_at: "2026-07-30T10:00:03Z",
          completed_at: "2026-07-30T10:00:02Z",
        },
      ]),
    ).toThrow("precedes start");
  });
});
