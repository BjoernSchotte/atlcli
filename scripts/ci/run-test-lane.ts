#!/usr/bin/env bun
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
  const group = plan.groups.find((candidate) => candidate.id === groupId);
  if (!group) throw new Error(`unknown execution group for ${topology}: ${groupId}`);

  const child = Bun.spawn(buildTestLaneCommand(group, junitFile), {
    cwd: resolve(import.meta.dir, "../.."),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exit(exitCode);
}

if (import.meta.main) await main();
