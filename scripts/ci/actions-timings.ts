#!/usr/bin/env bun
import { readFileSync } from "node:fs";

export interface ActionsStep {
  name: string;
  status?: string;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface ActionsJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  created_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  steps?: ActionsStep[];
}

export interface JobTiming {
  id: number;
  name: string;
  conclusion: string | null;
  queueSeconds: number | null;
  runnerSeconds: number | null;
  phases: Array<{
    name: string;
    conclusion: string | null | undefined;
    durationSeconds: number | null;
  }>;
}

export interface ActionsTimingSummary {
  schema: 1;
  sampleClass: "green" | "failed" | "cancelled";
  eligibleForGreenPercentiles: boolean;
  workflowWallSeconds: number | null;
  criticalPathSeconds: number | null;
  criticalPathJobs: string[];
  totalRunnerMinutes: number;
  jobs: JobTiming[];
}

function timestamp(value: string | null | undefined, field: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid ${field} timestamp: ${value}`);
  return parsed;
}

function elapsedSeconds(
  start: string | null | undefined,
  end: string | null | undefined,
  label: string,
): number | null {
  const started = timestamp(start, `${label} start`);
  const completed = timestamp(end, `${label} completion`);
  if (started === null || completed === null) return null;
  if (completed < started) throw new Error(`${label} completion precedes start`);
  return (completed - started) / 1_000;
}

function sampleClass(jobs: readonly ActionsJob[]): ActionsTimingSummary["sampleClass"] {
  if (jobs.some((job) => job.conclusion === "cancelled")) return "cancelled";
  if (
    jobs.some(
      (job) =>
        job.conclusion !== null &&
        job.conclusion !== "success" &&
        job.conclusion !== "skipped",
    )
  ) {
    return "failed";
  }
  return "green";
}

function criticalPath(
  jobs: readonly ActionsJob[],
  dependencies: Readonly<Record<string, readonly string[]>>,
  workflowStart: number | null,
): { seconds: number | null; jobs: string[] } {
  if (workflowStart === null) return { seconds: null, jobs: [] };
  const byName = new Map(jobs.map((job) => [job.name, job]));
  const completed = jobs
    .map((job) => ({ job, completed: timestamp(job.completed_at, `${job.name} completion`) }))
    .filter(
      (entry): entry is { job: ActionsJob; completed: number } =>
        entry.completed !== null,
    )
    .sort((left, right) => right.completed - left.completed);
  const terminal = completed[0];
  if (!terminal) return { seconds: null, jobs: [] };

  const path = [terminal.job.name];
  const seen = new Set(path);
  let current = terminal.job.name;
  while (true) {
    const parents = (dependencies[current] ?? [])
      .map((name) => byName.get(name))
      .filter((job): job is ActionsJob => Boolean(job))
      .map((job) => ({
        job,
        completed: timestamp(job.completed_at, `${job.name} completion`),
      }))
      .filter(
        (entry): entry is { job: ActionsJob; completed: number } =>
          entry.completed !== null,
      )
      .sort((left, right) => right.completed - left.completed);
    const parent = parents[0]?.job;
    if (!parent || seen.has(parent.name)) break;
    path.unshift(parent.name);
    seen.add(parent.name);
    current = parent.name;
  }

  return {
    seconds: (terminal.completed - workflowStart) / 1_000,
    jobs: path,
  };
}

export function summarizeActionsJobs(
  jobs: readonly ActionsJob[],
  dependencies: Readonly<Record<string, readonly string[]>> = {},
): ActionsTimingSummary {
  const createdTimes = jobs
    .map((job) => timestamp(job.created_at, `${job.name} creation`))
    .filter((value): value is number => value !== null);
  const completedTimes = jobs
    .map((job) => timestamp(job.completed_at, `${job.name} completion`))
    .filter((value): value is number => value !== null);
  const workflowStart = createdTimes.length > 0 ? Math.min(...createdTimes) : null;
  const workflowEnd = completedTimes.length > 0 ? Math.max(...completedTimes) : null;
  if (workflowStart !== null && workflowEnd !== null && workflowEnd < workflowStart) {
    throw new Error("workflow completion precedes creation");
  }

  const timings = jobs.map((job): JobTiming => {
    const runnerSeconds = elapsedSeconds(job.started_at, job.completed_at, job.name);
    const queueSeconds = elapsedSeconds(job.created_at, job.started_at, `${job.name} queue`);
    return {
      id: job.id,
      name: job.name,
      conclusion: job.conclusion,
      queueSeconds,
      runnerSeconds,
      phases: (job.steps ?? []).map((step) => ({
        name: step.name,
        conclusion: step.conclusion,
        durationSeconds: elapsedSeconds(
          step.started_at,
          step.completed_at,
          `${job.name} / ${step.name}`,
        ),
      })),
    };
  });
  const classification = sampleClass(jobs);
  const critical = criticalPath(jobs, dependencies, workflowStart);

  return {
    schema: 1,
    sampleClass: classification,
    eligibleForGreenPercentiles: classification === "green",
    workflowWallSeconds:
      workflowStart === null || workflowEnd === null
        ? null
        : (workflowEnd - workflowStart) / 1_000,
    criticalPathSeconds: critical.seconds,
    criticalPathJobs: critical.jobs,
    totalRunnerMinutes:
      timings.reduce((total, job) => total + (job.runnerSeconds ?? 0), 0) / 60,
    jobs: timings,
  };
}

async function main(): Promise<void> {
  const [path] = process.argv.slice(2);
  if (!path) throw new Error("usage: bun scripts/ci/actions-timings.ts <jobs-api.json>");
  const payload = JSON.parse(readFileSync(path, "utf8")) as {
    jobs?: ActionsJob[];
    dependencies?: Record<string, string[]>;
  };
  if (!Array.isArray(payload.jobs)) throw new Error("jobs API payload is missing jobs");
  process.stdout.write(
    `${JSON.stringify(summarizeActionsJobs(payload.jobs, payload.dependencies), null, 2)}\n`,
  );
}

if (import.meta.main) await main();
