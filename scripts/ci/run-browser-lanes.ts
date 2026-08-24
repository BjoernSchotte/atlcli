#!/usr/bin/env bun
import { resolve } from "node:path";
import { BROWSER_LANES, type BrowserLane } from "./run-browser-lane.js";

export const PARALLEL_BROWSER_LANES = Object.freeze(
  Object.keys(BROWSER_LANES) as BrowserLane[],
);

export function parallelBrowserLaneCommands(): string[][] {
  return PARALLEL_BROWSER_LANES.map((lane) => [
    "bun",
    "scripts/ci/run-browser-lane.ts",
    lane,
  ]);
}

async function main(): Promise<void> {
  if (!process.env.ATLCLI_BROWSER_EVIDENCE_ROOT?.trim()) {
    throw new Error("ATLCLI_BROWSER_EVIDENCE_ROOT is required");
  }
  const children = parallelBrowserLaneCommands().map((command) => Bun.spawn(command, {
    cwd: resolve(import.meta.dir, "../.."),
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }));
  const exitCodes = await Promise.all(children.map((child) => child.exited));
  for (const [index, exitCode] of exitCodes.entries()) {
    if (exitCode !== 0) {
      console.error(`::error::Browser lane ${PARALLEL_BROWSER_LANES[index]} exited with code ${exitCode}`);
    }
  }
  process.exitCode = exitCodes.some((exitCode) => exitCode !== 0) ? 1 : 0;
}

if (import.meta.main) await main();
