#!/usr/bin/env bun
import { resolve } from "node:path";
import type { BrowserLane } from "./run-browser-lane.js";

export const PARALLEL_BROWSER_LANES = Object.freeze(
  ["research-worker-rovo", "jobs"] satisfies BrowserLane[],
);

export const ISOLATED_BROWSER_LANES = Object.freeze(
  ["neutral-palette"] satisfies BrowserLane[],
);

export function parallelBrowserLaneCommands(): string[][] {
  return PARALLEL_BROWSER_LANES.map((lane) => [
    "bun",
    "scripts/ci/run-browser-lane.ts",
    lane,
  ]);
}

export function isolatedBrowserLaneCommands(): string[][] {
  return ISOLATED_BROWSER_LANES.map((lane) => [
    "bun",
    "scripts/ci/run-browser-lane.ts",
    lane,
  ]);
}

async function runCommands(commands: readonly string[][]): Promise<number[]> {
  const children = commands.map((command) => Bun.spawn(command, {
    cwd: resolve(import.meta.dir, "../.."),
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }));
  return Promise.all(children.map((child) => child.exited));
}

async function main(): Promise<void> {
  if (!process.env.ATLCLI_BROWSER_EVIDENCE_ROOT?.trim()) {
    throw new Error("ATLCLI_BROWSER_EVIDENCE_ROOT is required");
  }
  const isolatedExitCodes = await runCommands(isolatedBrowserLaneCommands());
  for (const [index, exitCode] of isolatedExitCodes.entries()) {
    if (exitCode !== 0) {
      console.error(`::error::Browser lane ${ISOLATED_BROWSER_LANES[index]} exited with code ${exitCode}`);
    }
  }
  const parallelExitCodes = await runCommands(parallelBrowserLaneCommands());
  for (const [index, exitCode] of parallelExitCodes.entries()) {
    if (exitCode !== 0) {
      console.error(`::error::Browser lane ${PARALLEL_BROWSER_LANES[index]} exited with code ${exitCode}`);
    }
  }
  process.exitCode = [...parallelExitCodes, ...isolatedExitCodes]
    .some((exitCode) => exitCode !== 0) ? 1 : 0;
}

if (import.meta.main) await main();
