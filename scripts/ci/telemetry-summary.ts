#!/usr/bin/env bun
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  summarizeActionsJobs,
  type ActionsJob,
  type ActionsTimingSummary,
} from "./actions-timings.js";
import {
  assertDisjointLaneOwnership,
  parseBunJUnit,
  type FileTiming,
} from "./test-timings.js";

export interface CiTelemetrySummary {
  schema: 1;
  commitSha: string;
  sourceRun: string;
  topology: string;
  routes: Record<string, boolean>;
  files: number;
  testcases: number;
  lanes: Array<{
    lane: string;
    files: number;
    testcases: number;
    durationSeconds: number;
  }>;
  slowestFiles: FileTiming[];
  actions: ActionsTimingSummary;
}

export function buildCiTelemetrySummary(options: {
  commitSha: string;
  sourceRun: string;
  topology: string;
  routes: Record<string, boolean>;
  junit: Array<{ lane: string; xml: string }>;
  jobs: ActionsJob[];
  dependencies?: Record<string, string[]>;
}): CiTelemetrySummary {
  if (!/^[0-9a-f]{40}$/i.test(options.commitSha)) {
    throw new Error("telemetry commit SHA must contain 40 hexadecimal characters");
  }
  const artifacts = options.junit.map(({ lane, xml }) =>
    parseBunJUnit(xml, { namespace: options.topology, lane }),
  );
  assertDisjointLaneOwnership(artifacts);
  const files = artifacts.flatMap((artifact) => artifact.files);
  return {
    schema: 1,
    commitSha: options.commitSha.toLowerCase(),
    sourceRun: options.sourceRun,
    topology: options.topology,
    routes: options.routes,
    files: files.length,
    testcases: artifacts.reduce(
      (total, artifact) => total + artifact.testcases.length,
      0,
    ),
    lanes: artifacts.map((artifact) => ({
      lane: artifact.lane,
      files: artifact.files.length,
      testcases: artifact.testcases.length,
      durationSeconds: artifact.files.reduce(
        (total, file) => total + file.durationSeconds,
        0,
      ),
    })),
    slowestFiles: [...files]
      .sort(
        (left, right) =>
          right.durationSeconds - left.durationSeconds ||
          left.file.localeCompare(right.file),
      )
      .slice(0, 20),
    actions: summarizeActionsJobs(options.jobs, options.dependencies),
  };
}

export function telemetryMarkdown(summary: CiTelemetrySummary): string {
  const lines = [
    "## CI timing telemetry",
    "",
    `- Topology: \`${summary.topology}\``,
    `- Test files / cases: ${summary.files} / ${summary.testcases}`,
    `- Workflow wall time: ${summary.actions.workflowWallSeconds ?? "unavailable"}s`,
    `- Runner time: ${summary.actions.totalRunnerMinutes.toFixed(2)} min`,
    `- Sample class: \`${summary.actions.sampleClass}\``,
    "",
    "| Lane | Files | Cases | Testcase time |",
    "| --- | ---: | ---: | ---: |",
    ...summary.lanes.map(
      (lane) =>
        `| ${lane.lane} | ${lane.files} | ${lane.testcases} | ${lane.durationSeconds.toFixed(3)}s |`,
    ),
    "",
    "### Slowest files",
    "",
    ...summary.slowestFiles.map(
      (file) => `- \`${file.file}\`: ${file.durationSeconds.toFixed(3)}s`,
    ),
    "",
  ];
  return lines.join("\n");
}

function filesRecursively(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesRecursively(path));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const junitDirectory = option(args, "--junit");
  const jobsPath = option(args, "--jobs");
  const outPath = option(args, "--out");
  const jobsPayload = JSON.parse(readFileSync(jobsPath, "utf8")) as {
    jobs?: ActionsJob[];
    dependencies?: Record<string, string[]>;
  };
  if (!Array.isArray(jobsPayload.jobs)) throw new Error("jobs payload is missing jobs");

  const junit = filesRecursively(junitDirectory)
    .filter((path) => extname(path) === ".xml")
    .map((path) => ({
      lane: basename(path, ".xml"),
      xml: readFileSync(path, "utf8"),
    }));
  const summary = buildCiTelemetrySummary({
    commitSha: process.env.GITHUB_SHA ?? "",
    sourceRun:
      process.env.GITHUB_SERVER_URL &&
      process.env.GITHUB_REPOSITORY &&
      process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : "local",
    topology: process.env.CI_TEST_TOPOLOGY ?? "legacy-4-shard",
    routes: {
      code: process.env.CI_ROUTE_CODE === "true",
      consumer: process.env.CI_ROUTE_CONSUMER === "true",
      docs: process.env.CI_ROUTE_DOCS === "true",
      readmeMedia: process.env.CI_ROUTE_README_MEDIA === "true",
    },
    junit,
    jobs: jobsPayload.jobs,
    dependencies: jobsPayload.dependencies,
  });
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, telemetryMarkdown(summary));
  } else {
    process.stdout.write(telemetryMarkdown(summary));
  }
}

if (import.meta.main) await main();
