import { describe, expect, test } from "bun:test";
import {
  aggregateTurboTelemetry,
  parseSanitizedTurboTelemetry,
  sanitizeTurboRunDocuments,
} from "./turbo-run-summary.js";

const rawRun = {
  id: "run-1",
  turboVersion: "2.10.11",
  globalCacheInputs: {
    files: { "private/customer-name.txt": "secret" },
    environmentVariables: { values: { PRIVATE_TOKEN: "secret" } },
  },
  tasks: [{
    taskId: "@atlcli/core#build",
    task: "build",
    package: "@atlcli/core",
    hash: "abcdef0123456789",
    inputs: { "private/customer-name.txt": "secret" },
    command: "secret command",
    directory: "/private/worktree/packages/core",
    environmentVariables: { values: { PRIVATE_TOKEN: "secret" } },
    cache: { local: true, remote: false, status: "HIT", timeSaved: 321 },
    execution: { startTime: 1_000, endTime: 1_125, exitCode: 0 },
  }],
};

describe("Turbo run telemetry", () => {
  test("retains cache evidence while excluding paths, commands, inputs, and environment", () => {
    const summary = sanitizeTurboRunDocuments("static-quality", [rawRun]);
    expect(summary).toEqual({
      schema: 1,
      source: "static-quality",
      runs: [{
        id: "run-1",
        turboVersion: "2.10.11",
        tasks: [{
          taskId: "@atlcli/core#build",
          task: "build",
          package: "@atlcli/core",
          hash: "abcdef0123456789",
          cacheStatus: "HIT",
          localCache: true,
          remoteCache: false,
          timeSavedMs: 321,
          durationMs: 125,
          exitCode: 0,
        }],
      }],
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("customer-name");
    expect(serialized).not.toContain("PRIVATE_TOKEN");
    expect(serialized).not.toContain("secret command");
    expect(serialized).not.toContain("/private/worktree");
  });

  test("aggregates local, remote, missed, and skipped executions", () => {
    const local = sanitizeTurboRunDocuments("quality", [rawRun]);
    const remote = sanitizeTurboRunDocuments("browser", [{
      ...rawRun,
      id: "run-2",
      tasks: [
        {
          ...rawRun.tasks[0],
          cache: { local: false, remote: true, status: "HIT", timeSaved: 10 },
        },
        {
          ...rawRun.tasks[0],
          taskId: "@atlcli/extension#build",
          package: "@atlcli/extension",
          cache: { local: false, remote: false, status: "MISS", timeSaved: 0 },
        },
        {
          ...rawRun.tasks[0],
          taskId: "//#typecheck:root",
          package: "//",
          cache: { local: false, remote: false, status: "BYPASS", timeSaved: 0 },
        },
      ],
    }]);

    expect(aggregateTurboTelemetry([local, remote])).toMatchObject({
      runs: 2,
      tasks: 4,
      cacheHits: 2,
      cacheMisses: 1,
      cacheSkipped: 1,
      localHits: 1,
      remoteHits: 1,
      executionDurationMs: 500,
      timeSavedMs: 331,
    });
  });

  test("rejects telemetry sources that could smuggle paths into the artifact", () => {
    expect(() => sanitizeTurboRunDocuments("../../private", [rawRun]))
      .toThrow("short identifier");
  });

  test("revalidates downloaded artifacts before merging them into CI timing evidence", () => {
    const parsed = parseSanitizedTurboTelemetry({
      ...sanitizeTurboRunDocuments("quality", [rawRun]),
      ignoredTopLevelPath: "/private/customer",
      runs: [{
        ...sanitizeTurboRunDocuments("quality", [rawRun]).runs[0],
        tasks: [{
          ...sanitizeTurboRunDocuments("quality", [rawRun]).runs[0]!.tasks[0],
          command: "private command",
          inputs: { "/private/customer": "secret" },
        }],
      }],
    });

    expect(parsed).toBeDefined();
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain("ignoredTopLevelPath");
    expect(serialized).not.toContain("private command");
    expect(serialized).not.toContain("/private/customer");
    expect(parseSanitizedTurboTelemetry({ schema: 1, source: "../../private", runs: [] }))
      .toBeUndefined();
  });
});
