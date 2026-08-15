#!/usr/bin/env bun

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SOURCE_ELIGIBILITY_SCHEMA_ID,
  canonicalJson,
  validateSourceSha,
} from "../release-artifacts.js";

export const RELEASE_ELIGIBILITY_POLICY = "atlcli.dev-release-eligibility/v1";
export const REQUIRED_JOB_NAME = "required";
export const ADVISORY_JOB_NAMES = new Set([
  "Non-required CI timing telemetry",
  "Non-required system Chrome compatibility",
  "Product quality / Astro Windows compatibility canary (Astro 7.1.6, Node 24)",
  "Product quality / Astro platform canary (latest Astro 7, Node 24)",
]);

type RunStatus = "queued" | "in_progress" | "completed";
type JobStatus = "queued" | "in_progress" | "completed";

export interface WorkflowRun {
  id: number;
  run_number: number;
  run_attempt: number;
  event: string;
  head_branch: string | null;
  head_sha: string;
  path: string;
  status: RunStatus;
  conclusion: string | null;
  html_url: string;
  updated_at: string;
}

export interface WorkflowJob {
  id: number;
  name: string;
  status: JobStatus;
  conclusion: string | null;
  html_url: string;
}

export interface EligibilityClient {
  listCanonicalRuns(sourceSha: string): Promise<WorkflowRun[]>;
  listAttemptJobs(runId: number, runAttempt: number): Promise<WorkflowJob[]>;
}

interface ReceiptWorkflow {
  path: ".github/workflows/ci.yml";
  event: "push";
  branch: "main";
  runId: number | null;
  runAttempt: number | null;
  status: RunStatus | "missing";
  conclusion: string | null;
  url: string | null;
}

interface ReceiptJob {
  name: "required";
  status: JobStatus | "missing";
  conclusion: string | null;
  url: string | null;
}

export interface SourceEligibilityReceipt {
  schema: typeof SOURCE_ELIGIBILITY_SCHEMA_ID;
  decision: "eligible" | "blocked";
  reason: string;
  degraded: boolean;
  sourceSha: string;
  policyVersion: typeof RELEASE_ELIGIBILITY_POLICY;
  workflow: ReceiptWorkflow;
  requiredJob: ReceiptJob;
  advisory: { name: string; conclusion: string }[];
}

export type EligibilityEvaluation =
  | { state: "pending"; reason: "missing-run" | "run-pending" | "required-job-pending" }
  | { state: "terminal"; receipt: SourceEligibilityReceipt };

const emptyWorkflow = (): ReceiptWorkflow => ({
  path: ".github/workflows/ci.yml",
  event: "push",
  branch: "main",
  runId: null,
  runAttempt: null,
  status: "missing",
  conclusion: null,
  url: null,
});

const emptyJob = (): ReceiptJob => ({
  name: REQUIRED_JOB_NAME,
  status: "missing",
  conclusion: null,
  url: null,
});

function receipt(input: {
  sourceSha: string;
  decision: "eligible" | "blocked";
  reason: string;
  workflow?: ReceiptWorkflow;
  requiredJob?: ReceiptJob;
  advisory?: { name: string; conclusion: string }[];
}): SourceEligibilityReceipt {
  const advisory = [...(input.advisory ?? [])].sort((left, right) => left.name.localeCompare(right.name));
  return {
    schema: SOURCE_ELIGIBILITY_SCHEMA_ID,
    decision: input.decision,
    reason: input.reason,
    degraded: input.decision === "eligible" && advisory.length > 0,
    sourceSha: input.sourceSha,
    policyVersion: RELEASE_ELIGIBILITY_POLICY,
    workflow: input.workflow ?? emptyWorkflow(),
    requiredJob: input.requiredJob ?? emptyJob(),
    advisory,
  };
}

function canonicalRuns(runs: WorkflowRun[], sourceSha: string): WorkflowRun[] {
  return runs
    .filter((run) =>
      run.event === "push" &&
      run.head_branch === "main" &&
      run.head_sha === sourceSha &&
      (run.path === ".github/workflows/ci.yml" || run.path.startsWith(".github/workflows/ci.yml@"))
    )
    .sort((left, right) =>
      right.run_number - left.run_number ||
      right.run_attempt - left.run_attempt ||
      Date.parse(right.updated_at) - Date.parse(left.updated_at) ||
      right.id - left.id
    );
}

function workflowReceipt(run: WorkflowRun): ReceiptWorkflow {
  return {
    path: ".github/workflows/ci.yml",
    event: "push",
    branch: "main",
    runId: run.id,
    runAttempt: run.run_attempt,
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url,
  };
}

function jobReceipt(job: WorkflowJob): ReceiptJob {
  return {
    name: REQUIRED_JOB_NAME,
    status: job.status,
    conclusion: job.conclusion,
    url: job.html_url,
  };
}

export function evaluateEligibilitySnapshot(input: {
  sourceSha: string;
  runs: WorkflowRun[];
  jobs?: WorkflowJob[];
}): EligibilityEvaluation {
  const sourceSha = validateSourceSha(input.sourceSha, true);
  const run = canonicalRuns(input.runs, sourceSha)[0];
  if (!run) return { state: "pending", reason: "missing-run" };
  const workflow = workflowReceipt(run);
  if (run.status !== "completed") return { state: "pending", reason: "run-pending" };
  if (!input.jobs && run.conclusion !== "success") {
    return {
      state: "terminal",
      receipt: receipt({
        sourceSha,
        decision: "blocked",
        reason: `canonical-run-${run.conclusion ?? "missing-conclusion"}`,
        workflow,
      }),
    };
  }
  if (!input.jobs) return { state: "pending", reason: "required-job-pending" };
  const requiredJobs = input.jobs.filter(({ name }) => name === REQUIRED_JOB_NAME);
  if (requiredJobs.length !== 1) {
    return {
      state: "terminal",
      receipt: receipt({
        sourceSha,
        decision: "blocked",
        reason: requiredJobs.length === 0 ? "required-job-missing" : "required-job-ambiguous",
        workflow,
      }),
    };
  }
  const required = requiredJobs[0]!;
  if (required.status !== "completed") return { state: "pending", reason: "required-job-pending" };
  if (required.conclusion !== "success") {
    return {
      state: "terminal",
      receipt: receipt({
        sourceSha,
        decision: "blocked",
        reason: `required-job-${required.conclusion ?? "missing-conclusion"}`,
        workflow,
        requiredJob: jobReceipt(required),
      }),
    };
  }

  const failedJobs = input.jobs.filter((job) =>
    job.status === "completed" &&
    job.conclusion !== null &&
    !["success", "skipped"].includes(job.conclusion)
  );
  const unknownFailures = failedJobs.filter((job) => !ADVISORY_JOB_NAMES.has(job.name));
  if (unknownFailures.length > 0) {
    return {
      state: "terminal",
      receipt: receipt({
        sourceSha,
        decision: "blocked",
        reason: `unclassified-failed-job:${unknownFailures.map(({ name }) => name).sort().join(",")}`,
        workflow,
        requiredJob: jobReceipt(required),
      }),
    };
  }
  const advisory = failedJobs
    .filter((job) => ADVISORY_JOB_NAMES.has(job.name))
    .map((job) => ({ name: job.name, conclusion: job.conclusion! }));
  if (run.conclusion !== "success" && advisory.length === 0) {
    return {
      state: "terminal",
      receipt: receipt({
        sourceSha,
        decision: "blocked",
        reason: `canonical-run-${run.conclusion ?? "missing-conclusion"}-without-advisory-failure`,
        workflow,
        requiredJob: jobReceipt(required),
      }),
    };
  }
  return {
    state: "terminal",
    receipt: receipt({
      sourceSha,
      decision: "eligible",
      reason: advisory.length > 0 ? "eligible-with-advisory-failures" : "eligible",
      workflow,
      requiredJob: jobReceipt(required),
      advisory,
    }),
  };
}

export async function resolveSourceEligibility(input: {
  sourceSha: string;
  client: EligibilityClient;
  timeoutMs: number;
  pollIntervalMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<SourceEligibilityReceipt> {
  const sourceSha = validateSourceSha(input.sourceSha, true);
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? Bun.sleep;
  const startedAt = now();
  let lastEvaluation: EligibilityEvaluation = { state: "pending", reason: "missing-run" };
  let lastRun: WorkflowRun | undefined;

  while (true) {
    const runs = await input.client.listCanonicalRuns(sourceSha);
    lastRun = canonicalRuns(runs, sourceSha)[0];
    const jobs = lastRun?.status === "completed"
      ? await input.client.listAttemptJobs(lastRun.id, lastRun.run_attempt)
      : undefined;
    lastEvaluation = evaluateEligibilitySnapshot({ sourceSha, runs, jobs });
    if (lastEvaluation.state === "terminal") return lastEvaluation.receipt;
    if (now() - startedAt >= input.timeoutMs) {
      return receipt({
        sourceSha,
        decision: "blocked",
        reason: `timeout-${lastEvaluation.reason}`,
        workflow: lastRun ? workflowReceipt(lastRun) : undefined,
      });
    }
    await sleep(input.pollIntervalMs);
  }
}

export class GitHubEligibilityClient implements EligibilityClient {
  constructor(
    private readonly repository: string,
    private readonly token: string,
    private readonly apiUrl = "https://api.github.com",
    private readonly request: typeof fetch = fetch,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const response = await this.request(`${this.apiUrl}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "atlcli-dev-release-eligibility",
      },
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
    return await response.json() as T;
  }

  async listCanonicalRuns(sourceSha: string): Promise<WorkflowRun[]> {
    const query = new URLSearchParams({
      branch: "main",
      event: "push",
      head_sha: sourceSha,
      per_page: "100",
    });
    const result = await this.get<{ total_count: number; workflow_runs: WorkflowRun[] }>(
      `/repos/${this.repository}/actions/workflows/ci.yml/runs?${query}`,
    );
    if (result.total_count > result.workflow_runs.length) {
      throw new Error("canonical workflow run query exceeded the bounded first page");
    }
    return result.workflow_runs;
  }

  async listAttemptJobs(runId: number, runAttempt: number): Promise<WorkflowJob[]> {
    const result = await this.get<{ total_count: number; jobs: WorkflowJob[] }>(
      `/repos/${this.repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs?filter=all&per_page=100`,
    );
    if (result.total_count > result.jobs.length) {
      throw new Error("workflow job query exceeded the bounded first page");
    }
    return result.jobs;
  }
}

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const sourceSha = value(args, "--source-sha") ?? "";
  const output = value(args, "--out") ?? "source-eligibility.json";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const token = process.env.GITHUB_TOKEN ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be owner/name");
  }
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const timeoutSeconds = Number(value(args, "--timeout-seconds") ?? "900");
  const pollSeconds = Number(value(args, "--poll-seconds") ?? "15");
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) throw new Error("invalid timeout");
  if (!Number.isFinite(pollSeconds) || pollSeconds <= 0) throw new Error("invalid poll interval");
  const result = await resolveSourceEligibility({
    sourceSha,
    client: new GitHubEligibilityClient(repository, token, process.env.GITHUB_API_URL),
    timeoutMs: timeoutSeconds * 1_000,
    pollIntervalMs: pollSeconds * 1_000,
  });
  writeFileSync(resolve(output), canonicalJson(result));
  process.stdout.write(`${result.decision}: ${result.reason}\n`);
  if (result.decision !== "eligible") process.exit(1);
}
