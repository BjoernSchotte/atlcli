#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  discoverTestFiles,
  normalizeRepositoryTestPath,
} from "./test-inventory.js";

export type TestLane = "general" | "package-contract" | "pdf-typst";
export type TestTopology =
  | "general-2x1"
  | "general-3x1"
  | "general-2x2-workers";
export type SetupRequirement = "fonts" | "poppler" | "stateful" | "typst-runtime";

export interface TestLaneMetadataEntry {
  path: string;
  durationSeconds?: number;
  lane?: TestLane;
  requirements?: SetupRequirement[];
  atomicGroup?: string;
}

export interface TestLaneMetadata {
  schema: 1;
  baselineSha: string;
  conservativeDefaultSeconds: number;
  files: TestLaneMetadataEntry[];
}

export interface TestExecutionGroup {
  id: string;
  job: string;
  lane: TestLane;
  mode: "parallel" | "serial";
  workers: 1 | 2;
  files: string[];
  requirements: SetupRequirement[];
  atomicGroups: string[];
  estimatedSeconds: number;
}

export interface TestLanePlan {
  schema: 1;
  topology: TestTopology;
  baselineSha: string;
  fallbackSeconds: number;
  inventoryCount: number;
  groups: TestExecutionGroup[];
}

export interface TestLaneMatrixEntry {
  topology: TestTopology;
  group: string;
  lane: TestLane;
  workers: 1 | 2;
  fonts: boolean;
  poppler: boolean;
  executionGroups: string[];
}

const TOPOLOGIES = new Set<TestTopology>([
  "general-2x1",
  "general-3x1",
  "general-2x2-workers",
]);
const LANES = new Set<TestLane>(["general", "package-contract", "pdf-typst"]);
const REQUIREMENTS = new Set<SetupRequirement>([
  "fonts",
  "poppler",
  "stateful",
  "typst-runtime",
]);

const DIRECT_SETUP_PATTERNS: ReadonlyArray<{
  requirement: Extract<SetupRequirement, "fonts" | "poppler">;
  pattern: RegExp;
}> = [
  {
    requirement: "poppler",
    pattern: /\b(?:pdffonts|pdfinfo|pdftoppm|pdftotext)\b/u,
  },
  {
    requirement: "fonts",
    pattern: /(?:ensurePdfFonts|packageBytes\s*\(\s*[`"']@atlcli\/pdf\/fonts\/)/u,
  },
];

interface ValidatedEntry extends TestLaneMetadataEntry {
  path: string;
  lane: TestLane;
  requirements: SetupRequirement[];
}

interface AssignmentUnit {
  key: string;
  files: string[];
  weight: number;
  requirements: SetupRequirement[];
  atomicGroup?: string;
}

export function detectDirectSetupRequirements(source: string): SetupRequirement[] {
  return DIRECT_SETUP_PATTERNS
    .filter(({ pattern }) => pattern.test(source))
    .map(({ requirement }) => requirement);
}

export function validateDirectSetupOwnership(options: {
  inventory: readonly string[];
  metadata: TestLaneMetadata;
  sourceFor: (path: string) => string;
}): void {
  const entries = new Map(
    options.metadata.files.map((entry) => [normalizeRepositoryTestPath(entry.path), entry]),
  );
  const failures: string[] = [];
  for (const path of options.inventory) {
    const detected = detectDirectSetupRequirements(options.sourceFor(path));
    if (detected.length === 0) continue;
    const declared = new Set(entries.get(path)?.requirements ?? []);
    const missing = detected.filter((requirement) => !declared.has(requirement));
    if (missing.length > 0) failures.push(`${path}: ${missing.join(",")}`);
  }
  if (failures.length > 0) {
    throw new Error(`direct test setup ownership is incomplete: ${failures.join("; ")}`);
  }
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function validateMetadata(
  inventory: readonly string[],
  metadata: TestLaneMetadata,
): Map<string, ValidatedEntry> {
  if (metadata.schema !== 1) throw new Error(`unsupported test-lane schema: ${metadata.schema}`);
  if (!/^[0-9a-f]{40}$/i.test(metadata.baselineSha)) {
    throw new Error("test-lane baseline SHA must contain 40 hexadecimal characters");
  }
  if (
    !Number.isFinite(metadata.conservativeDefaultSeconds) ||
    metadata.conservativeDefaultSeconds <= 0
  ) {
    throw new Error("conservativeDefaultSeconds must be positive");
  }

  const inventorySet = new Set(inventory);
  const entries = new Map<string, ValidatedEntry>();
  for (const rawEntry of metadata.files) {
    const path = normalizeRepositoryTestPath(rawEntry.path);
    if (entries.has(path)) throw new Error(`duplicate test-lane metadata: ${path}`);
    if (!inventorySet.has(path)) throw new Error(`stale test-lane metadata: ${path}`);
    const lane = rawEntry.lane ?? "general";
    if (!LANES.has(lane)) throw new Error(`invalid lane for ${path}: ${lane}`);
    if (
      rawEntry.durationSeconds !== undefined &&
      (!Number.isFinite(rawEntry.durationSeconds) || rawEntry.durationSeconds <= 0)
    ) {
      throw new Error(`invalid historical duration for ${path}`);
    }
    const requirements = uniqueSorted(rawEntry.requirements ?? []);
    for (const requirement of requirements) {
      if (!REQUIREMENTS.has(requirement)) {
        throw new Error(`invalid setup requirement for ${path}: ${requirement}`);
      }
    }
    if (rawEntry.atomicGroup !== undefined) {
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(rawEntry.atomicGroup)) {
        throw new Error(`invalid atomic group for ${path}`);
      }
      if (lane !== "general") {
        throw new Error(`atomic groups are supported only in the general lane: ${path}`);
      }
      if (!requirements.includes("stateful")) {
        throw new Error(`atomic group must declare the stateful requirement: ${path}`);
      }
    }
    if (lane === "package-contract" && requirements.includes("typst-runtime")) {
      throw new Error(`conflicting package-contract and typst requirements: ${path}`);
    }
    entries.set(path, { ...rawEntry, path, lane, requirements });
  }
  return entries;
}

function groupGeneralUnits(
  files: readonly string[],
  metadata: ReadonlyMap<string, ValidatedEntry>,
  fallbackSeconds: number,
): AssignmentUnit[] {
  const atomic = new Map<string, AssignmentUnit>();
  const units: AssignmentUnit[] = [];
  for (const file of files) {
    const entry = metadata.get(file);
    const weight = entry?.durationSeconds ?? fallbackSeconds;
    if (!entry?.atomicGroup) {
      units.push({
        key: file,
        files: [file],
        weight,
        requirements: entry?.requirements ?? [],
      });
      continue;
    }
    const previous = atomic.get(entry.atomicGroup) ?? {
      key: `atomic:${entry.atomicGroup}`,
      files: [],
      weight: 0,
      requirements: [],
      atomicGroup: entry.atomicGroup,
    };
    previous.files.push(file);
    previous.weight += weight;
    previous.requirements = uniqueSorted([
      ...previous.requirements,
      ...(entry.requirements ?? []),
    ]);
    atomic.set(entry.atomicGroup, previous);
  }
  units.push(...atomic.values());
  return units.sort(
    (left, right) => right.weight - left.weight || left.key.localeCompare(right.key),
  );
}

interface GeneralBin {
  index: number;
  safe: AssignmentUnit[];
  serial: AssignmentUnit[];
  safeWeight: number;
  serialWeight: number;
}

function assignGeneralBins(
  units: readonly AssignmentUnit[],
  jobCount: number,
  workers: 1 | 2,
): GeneralBin[] {
  const bins: GeneralBin[] = Array.from({ length: jobCount }, (_, index) => ({
    index,
    safe: [],
    serial: [],
    safeWeight: 0,
    serialWeight: 0,
  }));
  for (const unit of units) {
    const serial = Boolean(unit.atomicGroup) || unit.requirements.includes("stateful");
    const bin = [...bins].sort((left, right) => {
      const leftLoad = left.serialWeight + left.safeWeight / workers;
      const rightLoad = right.serialWeight + right.safeWeight / workers;
      return leftLoad - rightLoad || left.index - right.index;
    })[0]!;
    if (serial) {
      bin.serial.push(unit);
      bin.serialWeight += unit.weight;
    } else {
      bin.safe.push(unit);
      bin.safeWeight += unit.weight;
    }
  }
  return bins;
}

function executionGroup(
  id: string,
  job: string,
  lane: TestLane,
  mode: "parallel" | "serial",
  workers: 1 | 2,
  units: readonly AssignmentUnit[],
): TestExecutionGroup | null {
  const files = units.flatMap((unit) => unit.files).sort((left, right) => left.localeCompare(right));
  if (files.length === 0) return null;
  return {
    id,
    job,
    lane,
    mode,
    workers,
    files,
    requirements: uniqueSorted(units.flatMap((unit) => unit.requirements)),
    atomicGroups: uniqueSorted(
      units.flatMap((unit) => (unit.atomicGroup ? [unit.atomicGroup] : [])),
    ),
    estimatedSeconds:
      units.reduce((total, unit) => total + unit.weight, 0) / workers,
  };
}

function assertPlanCoverage(plan: TestLanePlan, inventory: readonly string[]): void {
  const assigned = plan.groups.flatMap((group) => group.files);
  const duplicates = assigned.filter((file, index) => assigned.indexOf(file) !== index);
  if (duplicates.length > 0) {
    throw new Error(`test files assigned more than once: ${uniqueSorted(duplicates).join(", ")}`);
  }
  const expected = [...inventory].sort((left, right) => left.localeCompare(right));
  const actual = [...assigned].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    const assignedSet = new Set(actual);
    const missing = expected.filter((file) => !assignedSet.has(file));
    throw new Error(`test lane plan does not cover inventory: ${missing.join(", ")}`);
  }
  if (plan.groups.some((group) => group.files.length === 0)) {
    throw new Error("test lane plan contains an empty execution group");
  }
}

export function planTestLanes(
  rawInventory: readonly string[],
  metadata: TestLaneMetadata,
  topology: TestTopology,
): TestLanePlan {
  if (!TOPOLOGIES.has(topology)) throw new Error(`unknown test topology: ${topology}`);
  const inventory = uniqueSorted(rawInventory.map(normalizeRepositoryTestPath));
  if (inventory.length !== rawInventory.length) {
    throw new Error("test inventory contains duplicate paths");
  }
  const entries = validateMetadata(inventory, metadata);
  const measured = [...entries.values()].flatMap((entry) =>
    entry.durationSeconds === undefined ? [] : [entry.durationSeconds],
  );
  const fallbackSeconds = Math.max(
    metadata.conservativeDefaultSeconds,
    percentile95(measured),
  );

  const filesByLane: Record<TestLane, string[]> = {
    general: [],
    "package-contract": [],
    "pdf-typst": [],
  };
  for (const file of inventory) {
    filesByLane[entries.get(file)?.lane ?? "general"].push(file);
  }

  const jobCount = topology === "general-3x1" ? 3 : 2;
  const workers: 1 | 2 = topology === "general-2x2-workers" ? 2 : 1;
  const units = groupGeneralUnits(filesByLane.general, entries, fallbackSeconds);
  const bins = assignGeneralBins(units, jobCount, workers);
  const groups: TestExecutionGroup[] = [];
  for (const bin of bins) {
    const job = `general-${bin.index + 1}`;
    const safe = executionGroup(
      workers === 2 ? `${job}-parallel` : job,
      job,
      "general",
      workers === 2 ? "parallel" : "serial",
      workers,
      bin.safe,
    );
    if (safe) groups.push(safe);
    const serial = executionGroup(
      `${job}-serial`,
      job,
      "general",
      "serial",
      1,
      bin.serial,
    );
    if (serial) groups.push(serial);
  }

  for (const lane of ["package-contract", "pdf-typst"] as const) {
    const laneUnits = filesByLane[lane].map((file): AssignmentUnit => {
      const entry = entries.get(file);
      return {
        key: file,
        files: [file],
        weight: entry?.durationSeconds ?? fallbackSeconds,
        requirements: entry?.requirements ?? [],
      };
    });
    const group = executionGroup(lane, lane, lane, "serial", 1, laneUnits);
    if (group) groups.push(group);
  }

  const plan: TestLanePlan = {
    schema: 1,
    topology,
    baselineSha: metadata.baselineSha,
    fallbackSeconds,
    inventoryCount: inventory.length,
    groups,
  };
  assertPlanCoverage(plan, inventory);
  return plan;
}

export function explainTestLanePlan(plan: TestLanePlan): string {
  const lines = [
    `topology=${plan.topology} inventory=${plan.inventoryCount} fallback=${plan.fallbackSeconds.toFixed(3)}s`,
  ];
  for (const group of plan.groups) {
    lines.push(
      `${group.id}: ${group.files.length} files, workers=${group.workers}, estimated=${group.estimatedSeconds.toFixed(3)}s` +
        (group.requirements.length > 0
          ? `, setup=${group.requirements.join("+")}`
          : ""),
    );
  }
  return lines.join("\n");
}

export function testLaneMatrix(plan: TestLanePlan): { include: TestLaneMatrixEntry[] } {
  const byJob = new Map<string, TestExecutionGroup[]>();
  for (const group of plan.groups) {
    const groups = byJob.get(group.job) ?? [];
    groups.push(group);
    byJob.set(group.job, groups);
  }
  return {
    include: [...byJob.entries()].map(([job, groups]) => {
      const requirements = new Set(groups.flatMap((group) => group.requirements));
      const lanes = uniqueSorted(groups.map((group) => group.lane));
      if (lanes.length !== 1) {
        throw new Error(`logical test job spans multiple lanes: ${job}`);
      }
      return {
        topology: plan.topology,
        group: job,
        lane: lanes[0]!,
        workers: Math.max(...groups.map((group) => group.workers)) as 1 | 2,
        fonts: requirements.has("fonts"),
        poppler: requirements.has("poppler"),
        executionGroups: groups.map((group) => group.id),
      };
    }),
  };
}

export function loadTestLaneMetadata(
  path = resolve(import.meta.dir, "test-lanes.json"),
): TestLaneMetadata {
  return JSON.parse(readFileSync(path, "utf8")) as TestLaneMetadata;
}

function topologyFromArgs(args: readonly string[]): TestTopology {
  const index = args.indexOf("--topology");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || !TOPOLOGIES.has(value as TestTopology)) {
    throw new Error(
      `--topology must be one of ${[...TOPOLOGIES].join(", ")}`,
    );
  }
  return value as TestTopology;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inventory = discoverTestFiles();
  const metadata = loadTestLaneMetadata();
  validateDirectSetupOwnership({
    inventory,
    metadata,
    sourceFor: (path) => readFileSync(resolve(import.meta.dir, "../..", path), "utf8"),
  });
  const plan = planTestLanes(
    inventory,
    metadata,
    topologyFromArgs(args),
  );
  if (args.includes("--matrix")) {
    process.stdout.write(`${JSON.stringify(testLaneMatrix(plan))}\n`);
  } else if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } else {
    process.stdout.write(`${explainTestLanePlan(plan)}\n`);
  }
}

if (import.meta.main) await main();
