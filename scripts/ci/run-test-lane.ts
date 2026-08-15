#!/usr/bin/env bun
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { discoverTestFiles, normalizeRepositoryTestPath } from "./test-inventory.js";
import {
  loadTestLaneMetadata,
  planTestLanes,
  type TestExecutionGroup,
  type TestTopology,
} from "./test-lanes.js";

export function buildTestLaneCommand(
  group: TestExecutionGroup,
  junitFile: string,
): string[] {
  if (group.workers !== 1 && group.workers !== 2) {
    throw new Error(`worker count must be exactly 1 or 2: ${group.workers}`);
  }
  if (!junitFile.trim()) throw new Error("JUnit output path is required");
  if (group.files.length === 0) throw new Error("test execution group is empty");

  const files = group.files.map(normalizeRepositoryTestPath);
  if (new Set(files).size !== files.length) {
    throw new Error("test execution group contains duplicate paths");
  }
  if (
    group.workers === 2 &&
    (group.lane !== "general" ||
      group.mode !== "parallel" ||
      group.atomicGroups.length > 0 ||
      group.requirements.includes("stateful") ||
      group.requirements.includes("typst-runtime"))
  ) {
    throw new Error(`test execution group is not worker-safe: ${group.id}`);
  }

  const args = ["bun", "run", "test", "--"];
  if (group.workers === 2) args.push("--parallel=2");
  args.push(
    ...files.map((file) => `./${file}`),
    "--reporter=junit",
    `--reporter-outfile=${junitFile}`,
  );
  if (args.some((arg) => arg === "--concurrent")) {
    throw new Error("global --concurrent is forbidden");
  }
  return args;
}

export function executionPhases(groups: readonly TestExecutionGroup[]): TestExecutionGroup[] {
  if (groups.length === 0) throw new Error("logical test job has no execution groups");
  const jobs = new Set(groups.map((group) => group.job));
  if (jobs.size !== 1) throw new Error("execution groups must share one logical job");
  const requiresFreshProcess = groups.some(
    (group) =>
      group.atomicGroups.length > 0 || group.requirements.includes("stateful"),
  );
  if (groups.every((group) => group.workers === 1) && !requiresFreshProcess) {
    return [
      {
        id: groups[0]!.job,
        job: groups[0]!.job,
        lane: groups[0]!.lane,
        mode: "serial",
        workers: 1,
        files: groups.flatMap((group) => group.files),
        requirements: [...new Set(groups.flatMap((group) => group.requirements))].sort(),
        atomicGroups: [...new Set(groups.flatMap((group) => group.atomicGroups))].sort(),
        estimatedSeconds: groups.reduce((total, group) => total + group.estimatedSeconds, 0),
      },
    ];
  }
  return [...groups];
}

export function mergeJunitDocuments(documents: readonly string[]): string {
  if (documents.length === 0) throw new Error("at least one JUnit document is required");
  const bodies = documents.map((document) => {
    const match = document.match(/<testsuites\b[^>]*>([\s\S]*)<\/testsuites\s*>\s*$/u);
    if (!match) throw new Error("malformed JUnit XML: missing testsuites envelope");
    return match[1]!.trim();
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${bodies.join("\n")}\n</testsuites>\n`;
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const topology = option(args, "--topology") as TestTopology;
  const groupId = option(args, "--group");
  const junitFile = option(args, "--junit");
  const plan = planTestLanes(discoverTestFiles(), loadTestLaneMetadata(), topology);
  const selected = plan.groups.filter(
    (candidate) => candidate.job === groupId || candidate.id === groupId,
  );
  if (selected.length === 0) throw new Error(`unknown execution group for ${topology}: ${groupId}`);
  const phases = executionPhases(selected);
  const partFiles = phases.map((_, index) =>
    phases.length === 1 ? junitFile : `${junitFile}.part-${index + 1}.xml`,
  );
  let exitCode = 0;
  for (const [index, phase] of phases.entries()) {
    const child = Bun.spawn(buildTestLaneCommand(phase, partFiles[index]!), {
      cwd: resolve(import.meta.dir, "../.."),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    exitCode = await child.exited;
    if (exitCode !== 0) break;
  }
  const completedParts = partFiles.filter((path) => {
    try {
      readFileSync(path);
      return true;
    } catch {
      return false;
    }
  });
  if (phases.length > 1 && completedParts.length > 0) {
    writeFileSync(
      junitFile,
      mergeJunitDocuments(completedParts.map((path) => readFileSync(path, "utf8"))),
    );
    for (const path of completedParts) rmSync(path);
  }
  if (exitCode !== 0) process.exit(exitCode);
}

if (import.meta.main) await main();
