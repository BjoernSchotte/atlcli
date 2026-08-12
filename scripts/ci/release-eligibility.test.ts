import { describe, expect, test } from "bun:test";
import {
  ADVISORY_JOB_NAMES,
  GitHubEligibilityClient,
  evaluateEligibilitySnapshot,
  resolveSourceEligibility,
  type EligibilityClient,
  type WorkflowJob,
  type WorkflowRun,
} from "./release-eligibility";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 100,
    run_number: 50,
    run_attempt: 1,
    event: "push",
    head_branch: "main",
    head_sha: SHA,
    path: ".github/workflows/ci.yml",
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/BjoernSchotte/atlcli/actions/runs/100",
    updated_at: "2026-08-12T12:00:00Z",
    ...overrides,
  };
}

function job(overrides: Partial<WorkflowJob> = {}): WorkflowJob {
  return {
    id: 200,
    name: "required",
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/BjoernSchotte/atlcli/actions/runs/100/job/200",
    ...overrides,
  };
}

function terminal(input: { runs: WorkflowRun[]; jobs?: WorkflowJob[] }) {
  const result = evaluateEligibilitySnapshot({ sourceSha: SHA, ...input });
  expect(result.state).toBe("terminal");
  if (result.state !== "terminal") throw new Error("expected terminal result");
  return result.receipt;
}

describe("dev release source eligibility", () => {
  test("accepts only the exact successful canonical main push and required job", () => {
    const result = terminal({ runs: [run()], jobs: [job()] });
    expect(result).toMatchObject({
      decision: "eligible",
      reason: "eligible",
      degraded: false,
      sourceSha: SHA,
      workflow: { runId: 100, runAttempt: 1, status: "completed", conclusion: "success" },
      requiredJob: { name: "required", status: "completed", conclusion: "success" },
      advisory: [],
    });
  });

  test("blocks a red, missing, or ambiguous required aggregate", () => {
    expect(terminal({ runs: [run()], jobs: [job({ conclusion: "failure" })] }).reason).toBe(
      "required-job-failure",
    );
    expect(terminal({ runs: [run()], jobs: [] }).reason).toBe("required-job-missing");
    expect(terminal({ runs: [run()], jobs: [job(), job({ id: 201 })] }).reason).toBe(
      "required-job-ambiguous",
    );
  });

  test("blocks every non-success canonical run conclusion fail-closed", () => {
    for (const conclusion of [
      "failure",
      "cancelled",
      "skipped",
      "neutral",
      "stale",
      "timed_out",
      "startup_failure",
      "action_required",
    ]) {
      const result = terminal({ runs: [run({ conclusion })] });
      expect(result.decision).toBe("blocked");
      expect(result.reason).toBe(`canonical-run-${conclusion}`);
    }
  });

  test("uses the newest run and never substitutes an older green attempt", () => {
    const oldGreen = run({ id: 99, run_number: 49, conclusion: "success" });
    const newRed = run({ id: 100, run_number: 50, conclusion: "failure" });
    const result = terminal({ runs: [oldGreen, newRed], jobs: [job()] });
    expect(result.decision).toBe("blocked");
    expect(result.workflow.runId).toBe(100);
  });

  test("ignores same-SHA pull request and manual runs even when they are green", () => {
    const result = evaluateEligibilitySnapshot({
      sourceSha: SHA,
      runs: [
        run({ event: "pull_request", head_branch: "feature" }),
        run({ id: 101, event: "workflow_dispatch" }),
        run({ id: 102, path: ".github/workflows/other.yml@refs/heads/main" }),
      ],
      jobs: [job()],
    });
    expect(result).toEqual({ state: "pending", reason: "missing-run" });
  });

  test("allows only explicitly classified advisory failures and records degradation", () => {
    const advisoryName = [...ADVISORY_JOB_NAMES][0]!;
    const result = terminal({
      runs: [run()],
      jobs: [job(), job({ id: 201, name: advisoryName, conclusion: "failure" })],
    });
    expect(result.decision).toBe("eligible");
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe("eligible-with-advisory-failures");
    expect(result.advisory).toEqual([{ name: advisoryName, conclusion: "failure" }]);

    const unknown = terminal({
      runs: [run()],
      jobs: [job(), job({ id: 202, name: "Unexpected canary", conclusion: "failure" })],
    });
    expect(unknown.decision).toBe("blocked");
    expect(unknown.reason).toContain("unclassified-failed-job");
  });

  test("polls pending state and emits a blocked timeout receipt without publishing", async () => {
    let clock = 0;
    const client: EligibilityClient = {
      listCanonicalRuns: async () => [],
      listAttemptJobs: async () => {
        throw new Error("jobs must not be queried without a run");
      },
    };
    const result = await resolveSourceEligibility({
      sourceSha: SHA,
      client,
      timeoutMs: 20,
      pollIntervalMs: 10,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
    });
    expect(result).toMatchObject({
      decision: "blocked",
      reason: "timeout-missing-run",
      workflow: { status: "missing", runId: null },
    });
  });

  test("polls the exact latest run attempt and then succeeds", async () => {
    let calls = 0;
    const attempts: [number, number][] = [];
    const client: EligibilityClient = {
      listCanonicalRuns: async () => {
        calls++;
        return [run({ status: calls === 1 ? "in_progress" : "completed", run_attempt: 3 })];
      },
      listAttemptJobs: async (runId, runAttempt) => {
        attempts.push([runId, runAttempt]);
        return [job()];
      },
    };
    const result = await resolveSourceEligibility({
      sourceSha: SHA,
      client,
      timeoutMs: 100,
      pollIntervalMs: 1,
      now: () => calls,
      sleep: async () => {},
    });
    expect(result.decision).toBe("eligible");
    expect(result.workflow.runAttempt).toBe(3);
    expect(attempts).toEqual([[100, 3]]);
  });

  test("constructs GitHub's workflow and attempt-specific jobs endpoints", async () => {
    const urls: string[] = [];
    const request = async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      return new Response(JSON.stringify(
        url.includes("/jobs?")
          ? { total_count: 1, jobs: [job()] }
          : { total_count: 1, workflow_runs: [run()] },
      ), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = new GitHubEligibilityClient(
      "BjoernSchotte/atlcli",
      "fixture-token",
      "https://api.github.test",
      request as typeof fetch,
    );
    await client.listCanonicalRuns(SHA);
    await client.listAttemptJobs(100, 3);
    expect(urls[0]).toContain("/actions/workflows/ci.yml/runs?");
    expect(urls[0]).toContain("branch=main");
    expect(urls[0]).toContain("event=push");
    expect(urls[0]).toContain(`head_sha=${SHA}`);
    expect(urls[1]).toContain("/actions/runs/100/attempts/3/jobs?filter=all&per_page=100");
  });
});
