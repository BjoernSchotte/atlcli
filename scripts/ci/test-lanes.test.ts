import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildTestLaneCommand,
  executionPhases,
  mergeJunitDocuments,
} from "./run-test-lane.js";
import {
  detectDirectSetupRequirements,
  loadTestLaneMetadata,
  mergeTestDurationSnapshot,
  planTestLanes,
  testLaneMatrix,
  validateDirectSetupOwnership,
  type TestExecutionGroup,
  type TestLaneMetadata,
  type TestLaneMetadataEntry,
  type TestTopology,
} from "./test-lanes.js";
import { discoverTestFiles } from "./test-inventory.js";

const SHA = "a".repeat(40);

function metadata(
  files: TestLaneMetadataEntry[] = [],
  conservativeDefaultSeconds = 5,
): TestLaneMetadata {
  return {
    schema: 1,
    baselineSha: SHA,
    conservativeDefaultSeconds,
    files,
  };
}

function plan(
  inventory: string[],
  files: TestLaneMetadataEntry[],
  topology: TestTopology = "general-2x1",
) {
  return planTestLanes(inventory, metadata(files), topology);
}

function assignment(planResult: ReturnType<typeof plan>): Map<string, string> {
  return new Map(
    planResult.groups.flatMap((group) =>
      group.files.map((file): [string, string] => [file, group.job]),
    ),
  );
}

function group(
  overrides: Partial<TestExecutionGroup> = {},
): TestExecutionGroup {
  return {
    id: "general-1",
    job: "general-1",
    lane: "general",
    mode: "serial",
    workers: 1,
    files: ["pkg/a.test.ts"],
    requirements: [],
    atomicGroups: [],
    estimatedSeconds: 1,
    ...overrides,
  };
}

describe("duration-aware test lanes", () => {
  test("merges a same-run duration snapshot without treating zero-time files as free", () => {
    const merged = mergeTestDurationSnapshot(
      metadata([
        {
          path: "pkg/owned.test.ts",
          lane: "pdf-typst",
          requirements: ["fonts"],
        },
      ]),
      {
        schema: 1,
        baselineSha: "b".repeat(40),
        sourceRun: "https://github.com/example/repo/actions/runs/1",
        samples: 4,
        files: [
          { file: "pkg/owned.test.ts", durationSeconds: 8 },
          { file: "pkg/general.test.ts", durationSeconds: 3 },
          { file: "pkg/rounded.test.ts", durationSeconds: 0 },
        ],
      },
    );

    expect(merged.baselineSha).toBe("b".repeat(40));
    expect(merged.files).toContainEqual({
      path: "pkg/owned.test.ts",
      lane: "pdf-typst",
      requirements: ["fonts"],
      durationSeconds: 8,
    });
    expect(merged.files).toContainEqual({
      path: "pkg/general.test.ts",
      durationSeconds: 3,
    });
    expect(merged.files.some(({ path }) => path === "pkg/rounded.test.ts")).toBe(false);
  });

  test("rejects malformed and duplicate duration evidence", () => {
    const base = {
      schema: 1 as const,
      baselineSha: SHA,
      sourceRun: "run",
      samples: 1,
    };
    expect(() =>
      mergeTestDurationSnapshot(metadata(), {
        ...base,
        files: [
          { file: "pkg/a.test.ts", durationSeconds: 1 },
          { file: "./pkg/a.test.ts", durationSeconds: 2 },
        ],
      }),
    ).toThrow("duplicate test-duration snapshot");
    expect(() =>
      mergeTestDurationSnapshot(metadata(), {
        ...base,
        files: [{ file: "pkg/a.test.ts", durationSeconds: -1 }],
      }),
    ).toThrow("invalid test-duration snapshot");
  });

  test("uses deterministic LPT balancing independent of inventory order", () => {
    const inventory = ["pkg/a.test.ts", "pkg/b.test.ts", "pkg/c.test.ts", "pkg/d.test.ts"];
    const files = [
      { path: "pkg/a.test.ts", durationSeconds: 8 },
      { path: "pkg/b.test.ts", durationSeconds: 7 },
      { path: "pkg/c.test.ts", durationSeconds: 3 },
      { path: "pkg/d.test.ts", durationSeconds: 2 },
    ];
    const forward = plan(inventory, files);
    const reverse = plan([...inventory].reverse(), [...files].reverse());

    expect(forward).toEqual(reverse);
    const jobs = assignment(forward);
    expect(jobs.get("pkg/a.test.ts")).not.toBe(jobs.get("pkg/b.test.ts"));
    expect(
      forward.groups
        .filter(({ lane }) => lane === "general")
        .map(({ estimatedSeconds }) => estimatedSeconds),
    ).toEqual([10, 10]);
  });

  test("defaults new files to general with the larger historical p95 fallback", () => {
    const result = plan(
      ["pkg/fast.test.ts", "pkg/slow.test.ts", "pkg/new.test.ts"],
      [
        { path: "pkg/fast.test.ts", durationSeconds: 1 },
        { path: "pkg/slow.test.ts", durationSeconds: 9 },
      ],
    );
    expect(result.fallbackSeconds).toBe(9);
    expect(
      result.groups.find((candidate) => candidate.files.includes("pkg/new.test.ts"))?.lane,
    ).toBe("general");
  });

  test("rejects duplicate inventory, duplicate metadata, stale paths, and lane conflicts", () => {
    expect(() =>
      planTestLanes(["pkg/a.test.ts", "pkg/a.test.ts"], metadata(), "general-2x1"),
    ).toThrow("duplicate paths");
    expect(() =>
      plan(
        ["pkg/a.test.ts"],
        [{ path: "pkg/a.test.ts" }, { path: "pkg/a.test.ts" }],
      ),
    ).toThrow("duplicate test-lane metadata");
    expect(() =>
      plan(["pkg/a.test.ts"], [{ path: "pkg/stale.test.ts" }]),
    ).toThrow("stale test-lane metadata");
    expect(() =>
      plan(
        ["pkg/a.test.ts"],
        [
          {
            path: "pkg/a.test.ts",
            lane: "package-contract",
            requirements: ["typst-runtime"],
          },
        ],
      ),
    ).toThrow("conflicting");
  });

  test("preserves combined setup requirements on an explicit PDF/Typst lane", () => {
    const result = plan(
      ["pkg/compiler.test.ts"],
      [
        {
          path: "pkg/compiler.test.ts",
          lane: "pdf-typst",
          requirements: ["poppler", "fonts", "typst-runtime"],
        },
      ],
    );
    expect(result.groups).toEqual([
      expect.objectContaining({
        id: "pdf-typst",
        workers: 1,
        requirements: ["fonts", "poppler", "typst-runtime"],
      }),
    ]);
  });

  test("detects and fail-closes direct Poppler and pinned-font setup ownership", () => {
    const popplerSource = `Bun.spawn(["${"pdf" + "toppm"}"]);`;
    const fontSource = `${"ensure" + "PdfFonts"}();`;
    expect(
      detectDirectSetupRequirements(`${popplerSource} ${fontSource}`),
    ).toEqual(["poppler", "fonts"]);
    expect(() =>
      validateDirectSetupOwnership({
        inventory: ["pkg/proof.test.ts"],
        metadata: metadata([{ path: "pkg/proof.test.ts", requirements: ["poppler"] }]),
        sourceFor: () => `${popplerSource} ${fontSource}`,
      }),
    ).toThrow("fonts");
    expect(() =>
      validateDirectSetupOwnership({
        inventory: ["pkg/proof.test.ts"],
        metadata: metadata([
          { path: "pkg/proof.test.ts", requirements: ["fonts", "poppler"] },
        ]),
        sourceFor: () => `${popplerSource} ${fontSource}`,
      }),
    ).not.toThrow();
  });

  test("keeps every directly detected repository setup in its owning lane", () => {
    const inventory = discoverTestFiles();
    const realMetadata = loadTestLaneMetadata();
    validateDirectSetupOwnership({
      inventory,
      metadata: realMetadata,
      sourceFor: (path) => readFileSync(resolve(import.meta.dir, "../..", path), "utf8"),
    });
    const result = planTestLanes(inventory, realMetadata, "general-3x1");
    expect(realMetadata.baselineSha).toBe("d3a5d82b5587670db666b82f4d19f9716bc42c71");
    expect(
      realMetadata.files.filter(({ durationSeconds }) => durationSeconds !== undefined),
    ).toHaveLength(620);
    expect(
      result.groups
        .filter(({ lane }) => lane === "general")
        .flatMap(({ requirements }) => requirements)
        .filter((requirement) => requirement === "fonts" || requirement === "poppler"),
    ).toEqual([]);
  });

  test("keeps atomic groups indivisible in a separate serial execution group", () => {
    const result = plan(
      ["pkg/a.test.ts", "pkg/b.test.ts", "pkg/safe.test.ts"],
      [
        {
          path: "pkg/a.test.ts",
          durationSeconds: 6,
          atomicGroup: "shared-state",
          requirements: ["stateful"],
        },
        {
          path: "pkg/b.test.ts",
          durationSeconds: 4,
          atomicGroup: "shared-state",
          requirements: ["stateful"],
        },
      ],
      "general-2x2-workers",
    );
    const serial = result.groups.find((candidate) =>
      candidate.atomicGroups.includes("shared-state"),
    );
    expect(serial).toMatchObject({
      mode: "serial",
      workers: 1,
      files: ["pkg/a.test.ts", "pkg/b.test.ts"],
    });
    expect(
      result.groups.find((candidate) => candidate.files.includes("pkg/safe.test.ts")),
    ).toMatchObject({ mode: "parallel", workers: 2 });
  });

  test("omits zero-file lanes and retains an exact pairwise-disjoint union", () => {
    const inventory = ["a/same.test.ts", "b/same.test.ts", "pkg/space name.test.ts"];
    const result = plan(inventory, [], "general-3x1");
    const assigned = result.groups.flatMap(({ files }) => files);
    expect(result.groups.every(({ files }) => files.length > 0)).toBe(true);
    expect([...assigned].sort()).toEqual([...inventory].sort());
    expect(new Set(assigned).size).toBe(inventory.length);
    expect(result.groups.some(({ lane }) => lane === "package-contract")).toBe(false);
  });

  test("emits argv-safe commands with an exact bounded worker flag", () => {
    const command = buildTestLaneCommand(
      group({
        id: "general-1-parallel",
        mode: "parallel",
        workers: 2,
        files: ["pkg/space name.test.ts", "a/same.test.ts", "b/same.test.ts"],
      }),
      "junit/general-1.xml",
    );
    expect(command).toEqual([
      "bun",
      "run",
      "test",
      "--",
      "--parallel=2",
      "./pkg/space name.test.ts",
      "./a/same.test.ts",
      "./b/same.test.ts",
      "--reporter=junit",
      "--reporter-outfile=junit/general-1.xml",
    ]);
    expect(command).not.toContain("--concurrent");

    expect(
      buildTestLaneCommand(group(), "junit/general-1.xml"),
    ).not.toContain("--parallel=2");
  });

  test("keeps safe and serial phases on one logical matrix runner", () => {
    const result = plan(
      ["pkg/safe-a.test.ts", "pkg/safe-b.test.ts", "pkg/stateful.test.ts"],
      [
        {
          path: "pkg/stateful.test.ts",
          durationSeconds: 2,
          atomicGroup: "stateful",
          requirements: ["stateful"],
        },
      ],
      "general-2x2-workers",
    );
    const matrix = testLaneMatrix(result);
    expect(matrix.include).toHaveLength(2);
    expect(matrix.include.find(({ executionGroups }) => executionGroups.length === 2)).toMatchObject({
      group: "general-1",
      workers: 2,
      executionGroups: ["general-1-parallel", "general-1-serial"],
    });
    const shared = result.groups.filter(({ job }) => job === "general-1");
    expect(executionPhases(shared)).toHaveLength(2);

    expect(executionPhases(shared.map((phase) => ({ ...phase, workers: 1 })))).toMatchObject([
      {
        id: "general-1",
        workers: 1,
        files: expect.arrayContaining(["pkg/stateful.test.ts"]),
      },
    ]);
  });

  test("merges bounded JUnit phase documents for one logical runner", () => {
    const merged = mergeJunitDocuments([
      '<?xml version="1.0"?><testsuites><testsuite name="safe" /></testsuites>',
      '<testsuites tests="1"><testsuite name="serial" /></testsuites>',
    ]);
    expect(merged).toContain('<testsuite name="safe" />');
    expect(merged).toContain('<testsuite name="serial" />');
    expect(merged.match(/<testsuites>/g)).toHaveLength(1);
    expect(() => mergeJunitDocuments(["<testsuite />"])).toThrow("testsuites envelope");
  });

  test("rejects empty, duplicate, escaping, implicit, and unsafe parallel groups", () => {
    expect(() => buildTestLaneCommand(group({ files: [] }), "out.xml")).toThrow("empty");
    expect(() =>
      buildTestLaneCommand(group({ files: ["pkg/a.test.ts", "pkg/a.test.ts"] }), "out.xml"),
    ).toThrow("duplicate");
    expect(() =>
      buildTestLaneCommand(group({ files: ["../outside.test.ts"] }), "out.xml"),
    ).toThrow();
    expect(() =>
      buildTestLaneCommand(group({ workers: 0 as 1 }), "out.xml"),
    ).toThrow("exactly 1 or 2");
    for (const unsafe of [
      group({ lane: "package-contract", mode: "parallel", workers: 2 }),
      group({ lane: "pdf-typst", mode: "parallel", workers: 2 }),
      group({
        mode: "parallel",
        workers: 2,
        requirements: ["stateful"],
      }),
      group({
        mode: "parallel",
        workers: 2,
        atomicGroups: ["shared"],
      }),
    ]) {
      expect(() => buildTestLaneCommand(unsafe, "out.xml")).toThrow("not worker-safe");
    }
  });

  test("accepts only the three named candidate topologies", () => {
    expect(() =>
      planTestLanes(["pkg/a.test.ts"], metadata(), "legacy-4-shard" as TestTopology),
    ).toThrow("unknown test topology");
  });

  test("exposes stable group identifiers for a workflow matrix", () => {
    const result = plan(
      ["pkg/a.test.ts", "pkg/contract.test.ts", "pkg/pdf.test.ts"],
      [
        { path: "pkg/contract.test.ts", lane: "package-contract" },
        {
          path: "pkg/pdf.test.ts",
          lane: "pdf-typst",
          requirements: ["fonts", "poppler", "typst-runtime"],
        },
      ],
      "general-2x2-workers",
    );
    expect(result.groups.map(({ id }) => id)).toEqual([
      "general-1-parallel",
      "package-contract",
      "pdf-typst",
    ]);
  });
});
