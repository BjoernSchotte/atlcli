import { describe, expect, test } from "bun:test";
import {
  ISOLATED_BROWSER_LANES,
  PARALLEL_BROWSER_LANES,
  isolatedBrowserLaneCommands,
  parallelBrowserLaneCommands,
} from "./run-browser-lanes.js";

describe("parallel browser lane orchestration", () => {
  test("parallelizes stable lanes and isolates timing-sensitive suites", () => {
    expect(PARALLEL_BROWSER_LANES).toEqual([
      "research-worker-rovo",
      "jobs",
    ]);
    expect(ISOLATED_BROWSER_LANES).toEqual(["neutral-palette"]);
    expect(parallelBrowserLaneCommands()).toEqual([
      ["bun", "scripts/ci/run-browser-lane.ts", "research-worker-rovo"],
      ["bun", "scripts/ci/run-browser-lane.ts", "jobs"],
    ]);
    expect(isolatedBrowserLaneCommands()).toEqual([
      ["bun", "scripts/ci/run-browser-lane.ts", "neutral-palette"],
    ]);
  });
});
