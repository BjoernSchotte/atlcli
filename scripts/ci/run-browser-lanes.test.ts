import { describe, expect, test } from "bun:test";
import {
  PARALLEL_BROWSER_LANES,
  parallelBrowserLaneCommands,
} from "./run-browser-lanes.js";

describe("parallel browser lane orchestration", () => {
  test("starts every fixed lane exactly once", () => {
    expect(PARALLEL_BROWSER_LANES).toEqual([
      "neutral-palette",
      "research-worker-rovo",
      "jobs",
    ]);
    expect(parallelBrowserLaneCommands()).toEqual([
      ["bun", "scripts/ci/run-browser-lane.ts", "neutral-palette"],
      ["bun", "scripts/ci/run-browser-lane.ts", "research-worker-rovo"],
      ["bun", "scripts/ci/run-browser-lane.ts", "jobs"],
    ]);
  });
});
