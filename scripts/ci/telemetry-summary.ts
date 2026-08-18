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
  createTimingSnapshot,
  parseBunJUnit,
  type FileTiming,
  type TimingSnapshot,
} from "./test-timings.js";
import {
  aggregateTurboTelemetry,
  readSanitizedTurboArtifacts,
  type AggregatedTurboTelemetry,
  type SanitizedTurboTelemetry,
} from "./turbo-run-summary.js";

export interface CiTelemetrySummary {
  schema: 2;
  commitSha: string;
  sourceRun: string;
  proofMode: string;
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
  timingSnapshot: TimingSnapshot;
  actions: ActionsTimingSummary;
  turbo: AggregatedTurboTelemetry;
}

const ROUTE_ENVIRONMENT: ReadonlyArray<readonly [string, string]> = [
  ["code", "CI_ROUTE_CODE"],
  ["consumer", "CI_ROUTE_CONSUMER"],
  ["staticQuality", "CI_ROUTE_STATIC_QUALITY"],
  ["unitTests", "CI_ROUTE_UNIT_TESTS"],
  ["packageContracts", "CI_ROUTE_PACKAGE_CONTRACTS"],
  ["astroPublishing", "CI_ROUTE_ASTRO_PUBLISHING"],
  ["astroPlatform", "CI_ROUTE_ASTRO_PLATFORM"],
  ["pdfPlatform", "CI_ROUTE_PDF_PLATFORM"],
  ["browserHarness", "CI_ROUTE_BROWSER_HARNESS"],
  ["docs", "CI_ROUTE_DOCS"],
  ["readmeMedia", "CI_ROUTE_README_MEDIA"],
  ["researchPrivacy", "CI_ROUTE_RESEARCH_PRIVACY"],
];

export function routesFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, boolean> {
  return Object.fromEntries(
    ROUTE_ENVIRONMENT.map(([route, variable]) => [route, environment[variable] === "true"]),
  );
}

export function buildCiTelemetrySummary(options: {
  commitSha: string;
  sourceRun: string;
  proofMode: string;
  topology: string;
  routes: Record<string, boolean>;
  junit: Array<{ lane: string; xml: string }>;
  jobs: ActionsJob[];
  dependencies?: Record<string, string[]>;
  turbo?: SanitizedTurboTelemetry[];
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
    schema: 2,
    commitSha: options.commitSha.toLowerCase(),
    sourceRun: options.sourceRun,
    proofMode: options.proofMode,
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
    timingSnapshot: createTimingSnapshot({
      baselineSha: options.commitSha,
      sourceRun: options.sourceRun,
      artifacts,
    }),
    actions: summarizeActionsJobs(options.jobs, options.dependencies),
    turbo: aggregateTurboTelemetry(options.turbo ?? []),
  };
}

export function telemetryMarkdown(summary: CiTelemetrySummary): string {
  const lines = [
    "## CI timing telemetry",
    "",
    `- Proof mode: \`${summary.proofMode}\``,
    `- Topology: \`${summary.topology}\``,
    `- Test files / cases: ${summary.files} / ${summary.testcases}`,
    `- Workflow wall time: ${summary.actions.workflowWallSeconds ?? "unavailable"}s`,
    `- Runner time: ${summary.actions.totalRunnerMinutes.toFixed(2)} min`,
    `- Sample class: \`${summary.actions.sampleClass}\``,
    `- Turbo cache: ${summary.turbo.cacheHits} hit / ${summary.turbo.cacheMisses} miss / ${summary.turbo.cacheSkipped} other across ${summary.turbo.tasks} tasks`,
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

function optionalOption(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const junitDirectory = option(args, "--junit");
  const jobsPath = option(args, "--jobs");
  const outPath = option(args, "--out");
  const turboDirectory = optionalOption(args, "--turbo");
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
    proofMode: process.env.CI_PROOF_MODE ?? "unknown",
    topology: process.env.CI_TEST_TOPOLOGY ?? "legacy-4-shard",
    routes: routesFromEnvironment(process.env),
    junit,
    jobs: jobsPayload.jobs,
    dependencies: jobsPayload.dependencies,
    turbo: turboDirectory ? readSanitizedTurboArtifacts(turboDirectory) : [],
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
