#!/usr/bin/env bun
/**
 * Tenant-neutral semantic-diff dependency bake-off (WP8).
 *
 * `jsondiffpatch` is deliberately benchmark-only. The owned matcher remains
 * the runtime implementation regardless of this script's verdict.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { create as createJsonDiffPatch, type Delta } from "jsondiffpatch";
import {
  canonicalJsonV1,
  diffSemanticTreesV1,
  digestCanonicalJsonV1,
  digestSnapshotV1,
  sha256HexV1,
  type SemanticTreeSnapshotV1,
} from "../../packages/change-set/src/index.js";
import { canonicalizeAdfV1 } from "../../packages/change-set/src/adf/index.js";
import {
  canonicalizeStorageV1,
  storageSemanticTreeSnapshotV1,
} from "../../packages/confluence/src/storage-change-tree.js";

type Candidate = "owned" | "jsondiffpatch";
type FixtureFormat = "adf" | "storage";

interface CorrectnessExpectation {
  change: boolean;
  allowMoves: boolean;
  approvedNoise?: boolean;
  unknownPreservation?: boolean;
}

interface FixtureDefinition {
  id: string;
  format: FixtureFormat;
  category: "correctness" | "stress";
  expectation: CorrectnessExpectation;
  stressNodes?: 10_000 | 100_000;
}

interface PreparedFixture {
  baseline: SemanticTreeSnapshotV1;
  target: SemanticTreeSnapshotV1;
  inputBytesPerSide: { baseline: number; target: number };
  canonicalNodesPerSide: { baseline: number; target: number };
  preparationMs: number;
}

interface CandidateObservation {
  schema: "atlcli.semantic-diff-candidate-observation/1";
  candidate: Candidate;
  fixture: string;
  format: FixtureFormat;
  category: FixtureDefinition["category"];
  expectedChange: boolean;
  approvedNoise: boolean;
  detectedChange: boolean;
  changedSemanticPaths: string[];
  changedPathsTruncated: boolean;
  moveClaims: number;
  falsePositiveMoves: number;
  unknownPreserved: boolean | null;
  sourceCompleteness: boolean | null;
  diagnostics: string[];
  candidateComparisons: number | null;
  wallTimeMs: { samples: number[]; p50: number; p95: number };
  peakRssBytes: number;
  additionalPeakRssBytes: number;
  inputBytesPerSide: PreparedFixture["inputBytesPerSide"];
  canonicalNodesPerSide: PreparedFixture["canonicalNodesPerSide"];
  preparationMs: number;
  deterministic: boolean;
  outputDigest: string;
  correctnessPass: boolean;
}

interface BundleMeasurement {
  rawBytes: number;
  gzipBytes: number;
  digest: string;
  deterministic: boolean;
}

interface BakeoffEvidence {
  schema: "atlcli.semantic-diff-bakeoff-evidence/1";
  generatedAt: string;
  environment: {
    platform: string;
    release: string;
    arch: string;
    cpuModel: string;
    logicalCpus: number;
    totalMemoryBytes: number;
    bun: string;
    node: string;
  };
  dependency: {
    name: "jsondiffpatch";
    version: "0.7.6";
    scope: "packages/change-set devDependency only";
  };
  observations: CandidateObservation[];
  determinism: {
    bunRepeatedOutputs: boolean;
    nodeCompatibleRuntime: boolean;
    bunDigest: string;
    nodeDigest: string;
  };
  bundles: {
    config: string;
    gzipLevel: 9;
    owned: BundleMeasurement;
    promotedCandidate: BundleMeasurement;
    signedDelta: { rawBytes: number; gzipBytes: number };
    under50KiBGzipGate: boolean;
  };
  retainedTreeReference100kProfile: {
    fixture: "adf-stress-100k";
    preparationMs: number;
    baselineDigestMs: number;
    targetDigestMs: number;
    completeDiffMs: number;
    retainedRssAfterPreparationBytes: number;
    retainedRssAfterDigestsBytes: number;
    peakRssBytes: number;
    candidateComparisons: number;
    sourceNodesPerSide: number;
    inputBytesPerSide: number;
  };
  gates: {
    ownedMeaningChangesDetected: boolean;
    ownedApprovedNoiseNoOp: boolean;
    ownedFalsePositiveMovesZero: boolean;
    ownedSourceCompleteness: boolean;
    ownedCandidateBudgetRespected: boolean;
    repeatedBytesIdentical: boolean;
    stress10kUnder250ms: boolean;
    stress100kUnder2s: boolean;
    stress100kAdditionalRssUnder256MiB: boolean;
    correctnessBlockingPass: boolean;
  };
  verdict: "keep-owned";
  verdictReasons: string[];
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(dirname(SCRIPT_PATH)));
const EVIDENCE_PATH = join(
  REPO_ROOT,
  "specs/semantic-change-diff-spike/evidence/semantic-diff-bakeoff.json",
);
const encoder = new TextEncoder();
const MAX_REPORTED_PATHS = 100;
const WORKER_TIMEOUT_MS = 45_000;
const BENCHMARK_JSON_BUDGET = {
  maxDepth: 256,
  maxNodes: 10_000_000,
  maxStringBytes: 128 * 1024 * 1024,
  maxOutputBytes: 256 * 1024 * 1024,
} as const;
const JSONDIFFPATCH_DIAGNOSTICS = [
  "candidate-comparisons-unavailable",
  "source-completeness-not-native",
];

const fixtures: FixtureDefinition[] = [
  { id: "adf-identical", format: "adf", category: "correctness", expectation: { change: false, allowMoves: false } },
  { id: "adf-approved-structural-noise", format: "adf", category: "correctness", expectation: { change: false, allowMoves: false, approvedNoise: true } },
  { id: "adf-identity-only-change", format: "adf", category: "correctness", expectation: { change: false, allowMoves: false, approvedNoise: true } },
  { id: "adf-text-change", format: "adf", category: "correctness", expectation: { change: true, allowMoves: false } },
  { id: "adf-mark-change", format: "adf", category: "correctness", expectation: { change: true, allowMoves: false } },
  { id: "adf-link-target-change", format: "adf", category: "correctness", expectation: { change: true, allowMoves: false } },
  { id: "adf-stable-block-move", format: "adf", category: "correctness", expectation: { change: true, allowMoves: true } },
  { id: "adf-ambiguous-duplicates", format: "adf", category: "correctness", expectation: { change: true, allowMoves: false } },
  { id: "adf-unknown-attribute", format: "adf", category: "correctness", expectation: { change: true, allowMoves: false, unknownPreservation: true } },
  { id: "storage-approved-noise", format: "storage", category: "correctness", expectation: { change: false, allowMoves: false, approvedNoise: true } },
  { id: "storage-text-change", format: "storage", category: "correctness", expectation: { change: true, allowMoves: false } },
  { id: "storage-unknown-element", format: "storage", category: "correctness", expectation: { change: true, allowMoves: false, unknownPreservation: true } },
  { id: "adf-stress-10k", format: "adf", category: "stress", stressNodes: 10_000, expectation: { change: true, allowMoves: false } },
  { id: "storage-stress-10k", format: "storage", category: "stress", stressNodes: 10_000, expectation: { change: true, allowMoves: false } },
  { id: "adf-stress-100k", format: "adf", category: "stress", stressNodes: 100_000, expectation: { change: true, allowMoves: false } },
  { id: "storage-stress-100k", format: "storage", category: "stress", stressNodes: 100_000, expectation: { change: true, allowMoves: false } },
];

function paragraph(text: string, localId?: string, marks?: unknown[]): unknown {
  return {
    type: "paragraph",
    ...(localId ? { attrs: { localId } } : {}),
    content: [{ type: "text", text, ...(marks ? { marks } : {}) }],
  };
}

function adfDocument(content: unknown[]): unknown {
  return { type: "doc", version: 1, content };
}

function smallAdfPair(id: string): { before: unknown; after: unknown } {
  switch (id) {
    case "adf-identical": {
      const value = adfDocument([paragraph("same", "same-id")]);
      return { before: value, after: structuredClone(value) };
    }
    case "adf-approved-structural-noise":
      return {
        before: adfDocument([{
          type: "paragraph",
          content: [
            { type: "text", text: "Hel", marks: [{ type: "strong" }, { type: "em" }] },
            { type: "text", text: "lo", marks: [{ type: "em" }, { type: "strong" }] },
          ],
        }]),
        after: adfDocument([paragraph("Hello", undefined, [{ type: "em" }, { type: "strong" }])]),
      };
    case "adf-identity-only-change": {
      const linked = (paragraphId: string, linkId: string) => adfDocument([{
        type: "paragraph",
        attrs: { localId: paragraphId },
        content: [{
          type: "text",
          text: "link",
          marks: [{
            type: "link",
            attrs: {
              href: "https://example.invalid/neutral",
              id: linkId,
              collection: "synthetic",
              occurrenceKey: linkId,
            },
          }],
        }],
      }]);
      return { before: linked("paragraph-a", "link-a"), after: linked("paragraph-b", "link-b") };
    }
    case "adf-text-change":
      return {
        before: adfDocument([paragraph("before", "paragraph-1")]),
        after: adfDocument([paragraph("after", "paragraph-1")]),
      };
    case "adf-mark-change":
      return {
        before: adfDocument([paragraph("marked", "paragraph-1", [{ type: "strong" }])]),
        after: adfDocument([paragraph("marked", "paragraph-1", [{ type: "em" }])]),
      };
    case "adf-link-target-change": {
      const linked = (href: string) => adfDocument([paragraph("link", "paragraph-1", [{
        type: "link",
        attrs: { href, title: "Synthetic" },
      }])]);
      return {
        before: linked("https://before.example.invalid/"),
        after: linked("https://after.example.invalid/"),
      };
    }
    case "adf-stable-block-move":
      return {
        before: adfDocument([paragraph("A", "a"), paragraph("B", "b"), paragraph("C", "c")]),
        after: adfDocument([paragraph("B", "b"), paragraph("A", "a"), paragraph("C", "c")]),
      };
    case "adf-ambiguous-duplicates":
      return {
        before: adfDocument([paragraph("same"), paragraph("same"), paragraph("other")]),
        after: adfDocument([paragraph("same"), paragraph("other"), paragraph("same")]),
      };
    case "adf-unknown-attribute":
      return {
        before: adfDocument([{ type: "futureBlock", attrs: { vendorMode: "before" } }]),
        after: adfDocument([{ type: "futureBlock", attrs: { vendorMode: "after" } }]),
      };
    default:
      throw new Error(`Unknown ADF fixture ${id}`);
  }
}

function smallStoragePair(id: string): { before: string; after: string } {
  switch (id) {
    case "storage-approved-noise":
      return {
        before: '<?xml version="1.0"?><!DOCTYPE p><?review ignore?><p z="2" a="1"><!--ignore-->A &amp; B</p>',
        after: '<p a="1" z="2">A &#38; B</p>',
      };
    case "storage-text-change":
      return {
        before: '<p local-id="paragraph-1">before</p>',
        after: '<p local-id="paragraph-1">after</p>',
      };
    case "storage-unknown-element":
      return {
        before: '<vendor:widget vendor:mode="before">Visible</vendor:widget>',
        after: '<vendor:widget vendor:mode="after">Visible</vendor:widget>',
      };
    default:
      throw new Error(`Unknown Storage fixture ${id}`);
  }
}

function padIndex(index: number): string {
  return String(index).padStart(6, "0");
}

/** Exactly `totalNodes` ADF nodes, including doc and one rule sentinel. */
export function generateAdfStressPair(totalNodes: 10_000 | 100_000): {
  before: string;
  after: string;
} {
  const blocks = (totalNodes - 2) / 2;
  if (!Number.isInteger(blocks)) throw new Error("ADF stress node count must be even.");
  const padding = totalNodes === 100_000 ? "x".repeat(56) : "x".repeat(8);
  // Generate transport bytes directly. Building and cloning 100k temporary
  // JS node objects would measure the fixture generator rather than the diff
  // pipeline and would dominate maxRSS before the candidate starts.
  const rows = Array.from({ length: blocks }, (_, index) => JSON.stringify(paragraph(
    `row-${padIndex(index)}-${padding}`,
    `paragraph-${padIndex(index)}`,
  )));
  const changedIndex = Math.floor(blocks / 2);
  const targetRows = [...rows];
  targetRows[changedIndex] = targetRows[changedIndex]!.replace('"text":"row-', '"text":"ROW-');
  const prefix = '{"type":"doc","version":1,"content":[';
  const suffix = ',{"type":"rule"}]}';
  return {
    before: `${prefix}${rows.join(",")}${suffix}`,
    after: `${prefix}${targetRows.join(",")}${suffix}`,
  };
}

/** Exactly `totalNodes` canonical Storage nodes, including synthetic root. */
export function generateStorageStressPair(totalNodes: 10_000 | 100_000): {
  before: string;
  after: string;
} {
  const blocks = (totalNodes - 2) / 2;
  if (!Number.isInteger(blocks)) throw new Error("Storage stress node count must be even.");
  const padding = totalNodes === 100_000 ? "x".repeat(112) : "x".repeat(8);
  const rows = Array.from({ length: blocks }, (_, index) =>
    `<p local-id="paragraph-${padIndex(index)}">row-${padIndex(index)}-${padding}</p>`
  );
  const target = [...rows];
  const middle = Math.floor(blocks / 2);
  target[middle] = target[middle]!.replace(">row-", ">ROW-");
  return { before: `${rows.join("")}<hr/>`, after: `${target.join("")}<hr/>` };
}

function snapshotFromAdf(value: string | unknown, revision: string): SemanticTreeSnapshotV1 {
  const result = canonicalizeAdfV1(value);
  return {
    ref: { revision, representation: "atlas_doc_format", acquisition: "synthetic-fixture" },
    ...result,
  };
}

function countTree(root: { children: readonly unknown[] }): number {
  const stack: Array<{ children: readonly unknown[] }> = [root];
  let count = 0;
  while (stack.length > 0) {
    const node = stack.pop()!;
    count += 1;
    for (const child of node.children) stack.push(child as { children: readonly unknown[] });
  }
  return count;
}

function inputBytes(value: string | unknown): number {
  return encoder.encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;
}

function prepareFixture(fixture: FixtureDefinition): PreparedFixture {
  const started = performance.now();
  let baseline: SemanticTreeSnapshotV1;
  let target: SemanticTreeSnapshotV1;
  let beforeBytes: number;
  let afterBytes: number;
  if (fixture.format === "adf") {
    const pair = fixture.stressNodes
      ? generateAdfStressPair(fixture.stressNodes)
      : smallAdfPair(fixture.id);
    beforeBytes = inputBytes(pair.before);
    afterBytes = inputBytes(pair.after);
    baseline = snapshotFromAdf(pair.before, "1");
    target = snapshotFromAdf(pair.after, "2");
  } else {
    const pair = fixture.stressNodes
      ? generateStorageStressPair(fixture.stressNodes)
      : smallStoragePair(fixture.id);
    beforeBytes = inputBytes(pair.before);
    afterBytes = inputBytes(pair.after);
    baseline = storageSemanticTreeSnapshotV1(pair.before, {
      revision: "1",
      representation: "storage",
      acquisition: "synthetic-fixture",
    });
    target = storageSemanticTreeSnapshotV1(pair.after, {
      revision: "2",
      representation: "storage",
      acquisition: "synthetic-fixture",
    });
  }
  return {
    baseline,
    target,
    inputBytesPerSide: { baseline: beforeBytes, target: afterBytes },
    canonicalNodesPerSide: {
      baseline: countTree(baseline.sourceTree),
      target: countTree(target.sourceTree),
    },
    preparationMs: round(performance.now() - started),
  };
}

function objectHash(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const node = value as {
    kind?: unknown;
    value?: unknown;
    stability?: unknown;
    identityHints?: unknown;
    attributes?: unknown;
    text?: unknown;
    label?: unknown;
    coverage?: unknown;
  };
  if (
    typeof node.kind === "string" && typeof node.value === "string" &&
    typeof node.stability === "string" && !Array.isArray(node.identityHints)
  ) {
    return `hint\u0000${node.kind}\u0000${node.value}\u0000${node.stability}`;
  }
  if (typeof node.kind !== "string" || !Array.isArray(node.identityHints)) return undefined;
  const stable = node.identityHints.find((hint) => {
    if (!hint || typeof hint !== "object") return false;
    return (hint as { stability?: unknown }).stability === "stable";
  }) as { kind?: unknown; value?: unknown } | undefined;
  if (stable && typeof stable.kind === "string" && typeof stable.value === "string") {
    return `${node.kind}\u0000${stable.kind}\u0000${stable.value}`;
  }
  return `shallow\u0000${canonicalJsonV1({
    kind: node.kind,
    attributes: node.attributes ?? {},
    ...(typeof node.text === "string" ? { text: node.text } : {}),
    ...(typeof node.label === "string" ? { label: node.label } : {}),
    ...(typeof node.coverage === "string" ? { coverage: node.coverage } : {}),
  })}`;
}

function jsonDiffPatcher() {
  return createJsonDiffPatch({
    objectHash,
    arrays: { detectMove: true, includeValueOnMove: false },
    propertyFilter: (name) => name !== "sourcePaths",
  });
}

function pointer(path: readonly (string | number)[]): string {
  if (path.length === 0) return "/";
  return `/${path.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function inspectDelta(delta: Delta | undefined): { paths: string[]; moves: number; truncated: boolean } {
  const paths: string[] = [];
  let moves = 0;
  const visit = (value: unknown, path: Array<string | number>): void => {
    if (Array.isArray(value)) {
      paths.push(pointer(path));
      if (value.length === 3 && value[2] === 3) moves += 1;
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const arrayDelta = record._t === "a";
    for (const key of Object.keys(record).sort()) {
      if (key === "_t") continue;
      const segment = arrayDelta
        ? Number.parseInt(key.startsWith("_") ? key.slice(1) : key, 10)
        : key;
      visit(record[key], [...path, Number.isNaN(segment as number) ? key : segment]);
    }
  };
  if (delta !== undefined) visit(delta, []);
  const unique = [...new Set(paths)].sort();
  return {
    paths: unique.slice(0, MAX_REPORTED_PATHS),
    moves,
    truncated: unique.length > MAX_REPORTED_PATHS,
  };
}

function hasOpaqueEvidence(value: unknown): boolean {
  const stack: unknown[] = [value];
  let visited = 0;
  while (stack.length > 0 && visited < 2_000_000) {
    const current = stack.pop();
    visited += 1;
    if (typeof current === "string") {
      if (current.includes("$opaque") || current.includes("futureBlock") ||
        current.includes("vendor:widget")) return true;
      continue;
    }
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [key, item] of Object.entries(current)) {
      if (key.includes("$opaque") || key.includes("futureBlock") || key.includes("vendor:widget")) {
        return true;
      }
      stack.push(item);
    }
  }
  return false;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function peakRssBytes(): number {
  // libuv exposes bytes on Darwin and KiB on Linux/other supported Unix hosts.
  const raw = process.resourceUsage().maxRSS;
  return process.platform === "darwin" ? raw : raw * 1024;
}

async function runOwned(prepared: PreparedFixture): Promise<{
  output: unknown;
  detected: boolean;
  paths: string[];
  moves: number;
  unknown: boolean;
  completeness: boolean;
  diagnostics: string[];
  comparisons: number;
}> {
  const result = await diffSemanticTreesV1({
    subject: { provider: "confluence", kind: "page", id: "synthetic-bakeoff" },
    baseline: prepared.baseline,
    target: prepared.target,
  });
  const accounted = new Set(result.changeSet.operations.flatMap((operation) =>
    operation.coveredSourceChangeIds));
  for (const change of result.sourceChanges) {
    if (change.classification === "policy-noise") accounted.add(change.id);
  }
  return {
    output: result.changeSet,
    detected: !result.changeSet.summary.noOp,
    paths: result.changeSet.operations.map((operation) => pointer(operation.path)).sort(),
    moves: result.changeSet.summary.moves,
    unknown: hasOpaqueEvidence({ changes: result.sourceChanges, operations: result.changeSet.operations }),
    completeness: result.sourceChanges.every((change) => accounted.has(change.id)),
    diagnostics: result.changeSet.completeness.diagnostics.map((diagnostic) => diagnostic.code).sort(),
    comparisons: result.instrumentation.candidateComparisons,
  };
}

function runJsonDiffPatch(prepared: PreparedFixture): {
  output: unknown;
  detected: boolean;
  paths: string[];
  moves: number;
  unknown: boolean;
  diagnostics: string[];
  pathsTruncated: boolean;
} {
  const delta = jsonDiffPatcher().diff(
    prepared.baseline.semanticTree,
    prepared.target.semanticTree,
  );
  const inspected = inspectDelta(delta);
  return {
    output: delta ?? null,
    detected: delta !== undefined,
    paths: inspected.paths,
    moves: inspected.moves,
    unknown: hasOpaqueEvidence(delta ?? null),
    pathsTruncated: inspected.truncated,
    diagnostics: [
      ...JSONDIFFPATCH_DIAGNOSTICS,
      ...(inspected.truncated ? ["changed-paths-truncated"] : []),
    ],
  };
}

async function executeCandidate(
  candidate: Candidate,
  fixture: FixtureDefinition,
  repeats: number,
): Promise<CandidateObservation> {
  if (candidate === "owned" && fixture.category === "stress") {
    return executeOwnedSpillCandidate(fixture, repeats);
  }
  const rssBefore = peakRssBytes();
  const prepared = prepareFixture(fixture);
  const times: number[] = [];
  const bytes: string[] = [];
  let last:
    | Awaited<ReturnType<typeof runOwned>>
    | ReturnType<typeof runJsonDiffPatch>
    | undefined;
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const started = performance.now();
    last = candidate === "owned" ? await runOwned(prepared) : runJsonDiffPatch(prepared);
    times.push(round(performance.now() - started));
    bytes.push(canonicalJsonV1(last.output, BENCHMARK_JSON_BUDGET));
  }
  if (!last) throw new Error("Candidate did not execute.");
  const digest = await sha256HexV1(encoder.encode(bytes[0]!));
  const unknown = fixture.expectation.unknownPreservation ? last.unknown : null;
  const sourceCompleteness = candidate === "owned" ? ("completeness" in last && last.completeness) : null;
  const falseMoves = fixture.expectation.allowMoves ? 0 : last.moves;
  const correctnessPass =
    last.detected === fixture.expectation.change &&
    falseMoves === 0 &&
    (unknown === null || unknown) &&
    (sourceCompleteness === null || sourceCompleteness);
  const peak = peakRssBytes();
  return {
    schema: "atlcli.semantic-diff-candidate-observation/1",
    candidate,
    fixture: fixture.id,
    format: fixture.format,
    category: fixture.category,
    expectedChange: fixture.expectation.change,
    approvedNoise: fixture.expectation.approvedNoise ?? false,
    detectedChange: last.detected,
    changedSemanticPaths: last.paths.slice(0, MAX_REPORTED_PATHS),
    changedPathsTruncated: "pathsTruncated" in last
      ? last.pathsTruncated
      : last.paths.length > MAX_REPORTED_PATHS,
    moveClaims: last.moves,
    falsePositiveMoves: falseMoves,
    unknownPreserved: unknown,
    sourceCompleteness,
    diagnostics: last.diagnostics,
    candidateComparisons: candidate === "owned" && "comparisons" in last ? last.comparisons : null,
    wallTimeMs: {
      samples: times,
      p50: round(percentile(times, 0.5)),
      p95: round(percentile(times, 0.95)),
    },
    peakRssBytes: peak,
    additionalPeakRssBytes: Math.max(0, peak - rssBefore),
    inputBytesPerSide: prepared.inputBytesPerSide,
    canonicalNodesPerSide: prepared.canonicalNodesPerSide,
    preparationMs: prepared.preparationMs,
    deterministic: bytes.every((value) => value === bytes[0]),
    outputDigest: digest,
    correctnessPass,
  };
}

async function executeOwnedSpillCandidate(
  fixture: FixtureDefinition,
  repeats: number,
): Promise<CandidateObservation> {
  const preparationStarted = performance.now();
  const pair = fixture.format === "adf"
    ? generateAdfStressPair(fixture.stressNodes!)
    : generateStorageStressPair(fixture.stressNodes!);
  const representation = fixture.format === "adf" ? "atlas_doc_format" : "storage";
  const deployment = fixture.format === "adf" ? "cloud" : "data-center";
  const source = (version: number, value: string) => ({
    id: "synthetic-bakeoff",
    title: "Synthetic bakeoff",
    version,
    deployment,
    body: { representation, value },
    ...(deployment === "data-center" ? { fallbackReason: "data-center" as const } : {}),
  });
  const pagePair = {
    from: source(1, pair.before),
    to: source(2, pair.after),
    representation,
  } as import("../../packages/confluence/src/page-diff-source.js").PageDiffPairV1;
  const preparationMs = round(performance.now() - preparationStarted);
  Bun.gc(true);
  // Measure additional working-set growth above the already acquired source
  // bytes. Fixture construction is not part of the diff pipeline and can have
  // a higher transient maxRSS than a streamed HTTP/file acquisition.
  const rssBefore = process.memoryUsage().rss;
  // Keep the Node-compatible correctness probe free of Bun-only host imports.
  // This expression is intentionally non-static so only Bun stress workers
  // resolve the CLI spill adapter.
  const spillModulePath = ["../../apps/cli/src/semantic-diff-", "spill.js"].join("");
  const spill = await import(spillModulePath) as typeof import("../../apps/cli/src/semantic-diff-spill.js");
  // One unmeasured same-size warm-up removes JIT/SQLite/filesystem cold-start
  // variance. Measured calls still include complete parsing, spill creation,
  // indexing, digest, matching, and cleanup.
  await spill.buildPageDiffChangeSetWithSpillV1(pagePair);
  Bun.gc(true);
  const times: number[] = [];
  const bytes: string[] = [];
  let last: Awaited<ReturnType<typeof spill.buildPageDiffChangeSetWithSpillV1>> | undefined;
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    Bun.gc(true);
    const started = performance.now();
    last = await spill.buildPageDiffChangeSetWithSpillV1(pagePair);
    times.push(round(performance.now() - started));
    bytes.push(canonicalJsonV1(last.changeSet, BENCHMARK_JSON_BUDGET));
  }
  if (!last) throw new Error("Owned spill candidate did not execute.");
  const accounted = new Set(last.changeSet.operations.flatMap((operation) =>
    operation.coveredSourceChangeIds));
  for (const change of last.sourceChanges) {
    if (change.classification === "policy-noise") accounted.add(change.id);
  }
  const outputDigest = await sha256HexV1(encoder.encode(bytes[0]!));
  const peak = peakRssBytes();
  return {
    schema: "atlcli.semantic-diff-candidate-observation/1",
    candidate: "owned",
    fixture: fixture.id,
    format: fixture.format,
    category: fixture.category,
    expectedChange: fixture.expectation.change,
    approvedNoise: false,
    detectedChange: !last.changeSet.summary.noOp,
    changedSemanticPaths: last.changeSet.operations
      .map((operation) => pointer(operation.path))
      .sort()
      .slice(0, MAX_REPORTED_PATHS),
    changedPathsTruncated: last.changeSet.operations.length > MAX_REPORTED_PATHS,
    moveClaims: last.changeSet.summary.moves,
    falsePositiveMoves: last.changeSet.summary.moves,
    unknownPreserved: null,
    sourceCompleteness: last.sourceChanges.every((change) => accounted.has(change.id)),
    diagnostics: last.changeSet.completeness.diagnostics.map((diagnostic) => diagnostic.code).sort(),
    candidateComparisons: last.instrumentation.candidateComparisons,
    wallTimeMs: {
      samples: times,
      p50: round(percentile(times, 0.5)),
      p95: round(percentile(times, 0.95)),
    },
    peakRssBytes: peak,
    additionalPeakRssBytes: Math.max(0, peak - rssBefore),
    inputBytesPerSide: {
      baseline: inputBytes(pair.before),
      target: inputBytes(pair.after),
    },
    canonicalNodesPerSide: {
      baseline: fixture.stressNodes!,
      target: fixture.stressNodes!,
    },
    preparationMs,
    deterministic: bytes.every((value) => value === bytes[0]),
    outputDigest,
    correctnessPass:
      !last.changeSet.summary.noOp &&
      last.changeSet.summary.moves === 0 &&
      last.sourceChanges.every((change) => accounted.has(change.id)),
  };
}

async function workerMain(): Promise<void> {
  const candidate = process.argv[process.argv.indexOf("--worker") + 1] as Candidate | undefined;
  const fixtureId = process.argv[process.argv.indexOf("--worker") + 2];
  const repeats = Number(process.argv[process.argv.indexOf("--worker") + 3] ?? "2");
  if ((candidate !== "owned" && candidate !== "jsondiffpatch") || !fixtureId) {
    throw new Error("Worker requires candidate and fixture id.");
  }
  const fixture = fixtures.find((candidateFixture) => candidateFixture.id === fixtureId);
  if (!fixture) throw new Error(`Unknown fixture ${fixtureId}`);
  const observation = await executeCandidate(candidate, fixture, repeats);
  process.stdout.write(`${canonicalJsonV1(observation)}\n`);
}

async function ownedProfileMain(): Promise<void> {
  const fixture = fixtures.find((candidateFixture) => candidateFixture.id === "adf-stress-100k")!;
  Bun.gc(true);
  const prepared = prepareFixture(fixture);
  Bun.gc(true);
  const retainedRssAfterPreparationBytes = process.memoryUsage().rss;
  let started = performance.now();
  await digestSnapshotV1(prepared.baseline.ref.representation, prepared.baseline.sourceTree);
  const baselineDigestMs = round(performance.now() - started);
  started = performance.now();
  await digestSnapshotV1(prepared.target.ref.representation, prepared.target.sourceTree);
  const targetDigestMs = round(performance.now() - started);
  Bun.gc(true);
  const retainedRssAfterDigestsBytes = process.memoryUsage().rss;
  started = performance.now();
  const result = await diffSemanticTreesV1({
    subject: { provider: "confluence", kind: "page", id: "synthetic-bakeoff-profile" },
    baseline: prepared.baseline,
    target: prepared.target,
  });
  const completeDiffMs = round(performance.now() - started);
  process.stdout.write(`${canonicalJsonV1({
    fixture: "adf-stress-100k",
    preparationMs: prepared.preparationMs,
    baselineDigestMs,
    targetDigestMs,
    completeDiffMs,
    retainedRssAfterPreparationBytes,
    retainedRssAfterDigestsBytes,
    peakRssBytes: peakRssBytes(),
    candidateComparisons: result.instrumentation.candidateComparisons,
    sourceNodesPerSide: prepared.canonicalNodesPerSide.baseline,
    inputBytesPerSide: prepared.inputBytesPerSide.baseline,
  })}\n`);
}

async function spawnOwnedProfile(): Promise<BakeoffEvidence["retainedTreeReference100kProfile"]> {
  const child = Bun.spawn({
    cmd: [process.execPath, "--conditions=development", SCRIPT_PATH, "--profile-owned-100k"],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Owned profile failed: ${stderr.trim()}`);
  return JSON.parse(stdout) as BakeoffEvidence["retainedTreeReference100kProfile"];
}

async function spawnObservation(
  candidate: Candidate,
  fixture: FixtureDefinition,
): Promise<CandidateObservation> {
  const repeats = fixture.category === "correctness" ? 5 : fixture.stressNodes === 10_000 ? 3 : 2;
  const child = Bun.spawn({
    cmd: [process.execPath, "--conditions=development", SCRIPT_PATH, "--worker", candidate, fixture.id, String(repeats)],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, WORKER_TIMEOUT_MS);
  const exitCode = await child.exited;
  clearTimeout(timer);
  const [output, errors] = await Promise.all([stdout, stderr]);
  if (timedOut) {
    const reason = "worker-timeout-exceeded";
    const failure = { candidate, fixture: fixture.id, reason };
    return {
      schema: "atlcli.semantic-diff-candidate-observation/1",
      candidate,
      fixture: fixture.id,
      format: fixture.format,
      category: fixture.category,
      expectedChange: fixture.expectation.change,
      approvedNoise: fixture.expectation.approvedNoise ?? false,
      detectedChange: false,
      changedSemanticPaths: [],
      changedPathsTruncated: false,
      moveClaims: 0,
      falsePositiveMoves: 0,
      unknownPreserved: fixture.expectation.unknownPreservation ? false : null,
      sourceCompleteness: null,
      diagnostics: [reason],
      candidateComparisons: null,
      wallTimeMs: { samples: [], p50: 0, p95: 0 },
      peakRssBytes: 0,
      additionalPeakRssBytes: 0,
      inputBytesPerSide: { baseline: 0, target: 0 },
      canonicalNodesPerSide: {
        baseline: fixture.stressNodes ?? 0,
        target: fixture.stressNodes ?? 0,
      },
      preparationMs: 0,
      deterministic: false,
      outputDigest: await digestCanonicalJsonV1(failure),
      correctnessPass: false,
    };
  }
  if (timedOut || exitCode !== 0) {
    throw new Error(
      `${candidate}/${fixture.id} ${timedOut ? "timed out" : `exited ${exitCode}`}: ${errors.trim()}`,
    );
  }
  const observation = JSON.parse(output) as CandidateObservation;
  if (
    candidate === "jsondiffpatch" && fixture.stressNodes === 100_000 &&
    observation.additionalPeakRssBytes >= 256 * 1024 * 1024
  ) {
    observation.correctnessPass = false;
    observation.diagnostics = [...observation.diagnostics, "rss-gate-exceeded-postrun"];
  }
  return observation;
}

async function runtimeProbe(): Promise<Array<{ candidate: Candidate; fixture: string; digest: string }>> {
  const rows: Array<{ candidate: Candidate; fixture: string; digest: string }> = [];
  for (const fixture of fixtures.filter((candidateFixture) => candidateFixture.category === "correctness")) {
    const prepared = prepareFixture(fixture);
    for (const candidate of ["owned", "jsondiffpatch"] as const) {
      const result = candidate === "owned" ? await runOwned(prepared) : runJsonDiffPatch(prepared);
      rows.push({
        candidate,
        fixture: fixture.id,
        digest: await digestCanonicalJsonV1(result.output),
      });
    }
  }
  return rows;
}

async function runtimeProbeMain(): Promise<void> {
  process.stdout.write(`${canonicalJsonV1(await runtimeProbe())}\n`);
}

async function buildBytes(entry: string, target: "browser" | "node"): Promise<Uint8Array> {
  const result = await Bun.build({
    entrypoints: [entry],
    target,
    format: "esm",
    conditions: ["development", "browser"],
    packages: "bundle",
    splitting: false,
    minify: target === "browser",
    sourcemap: "none",
    env: "disable",
  });
  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join("\n"));
  }
  const artifact = result.outputs.find((output) => output.kind === "entry-point");
  if (!artifact) throw new Error("Bun.build emitted no entry-point artifact.");
  return new Uint8Array(await artifact.arrayBuffer());
}

async function measureEntry(entry: string): Promise<BundleMeasurement> {
  const first = await buildBytes(entry, "browser");
  const second = await buildBytes(entry, "browser");
  return {
    rawBytes: first.byteLength,
    gzipBytes: gzipSync(first, { level: 9 }).byteLength,
    digest: await digestCanonicalJsonV1([...first]),
    deterministic: first.byteLength === second.byteLength && first.every((byte, index) => byte === second[index]),
  };
}

async function bundleMeasurements(): Promise<BakeoffEvidence["bundles"]> {
  const temporary = mkdtempSync(join(tmpdir(), "atlcli-semantic-diff-bundle-"));
  try {
    const ownedPath = join(temporary, "owned.ts");
    const promotedPath = join(temporary, "promoted.ts");
    const ownedImport = join(REPO_ROOT, "packages/change-set/src/index.ts");
    const jsondiffpatchImport = fileURLToPath(import.meta.resolve("jsondiffpatch"));
    writeFileSync(ownedPath, `export { diffSemanticTreesV1 } from ${JSON.stringify(ownedImport)};\n`);
    writeFileSync(promotedPath, `
      export { diffSemanticTreesV1 } from ${JSON.stringify(ownedImport)};
      import { create } from ${JSON.stringify(jsondiffpatchImport)};
      const candidate = create({
        objectHash(value) {
          if (value?.kind && typeof value?.value === "string" && value?.stability && !Array.isArray(value?.identityHints)) {
            return "hint\\0" + String(value.kind) + "\\0" + String(value.value) + "\\0" + String(value.stability);
          }
          const hint = value?.identityHints?.find?.((entry) => entry?.stability === "stable");
          if (hint) return String(value.kind) + "\\0" + String(hint.kind) + "\\0" + String(hint.value);
          if (!value?.kind || !Array.isArray(value?.identityHints)) return undefined;
          return "shallow\\0" + JSON.stringify({
            kind: value.kind,
            attributes: value.attributes ?? {},
            text: value.text,
            label: value.label,
            coverage: value.coverage,
          });
        },
        arrays: { detectMove: true, includeValueOnMove: false },
        propertyFilter(name) { return name !== "sourcePaths"; },
      });
      export function diffWithPromotedCandidate(left, right) {
        return candidate.diff(left.semanticTree, right.semanticTree);
      }
    `);
    const owned = await measureEntry(ownedPath);
    const promotedCandidate = await measureEntry(promotedPath);
    const signedDelta = {
      rawBytes: promotedCandidate.rawBytes - owned.rawBytes,
      gzipBytes: promotedCandidate.gzipBytes - owned.gzipBytes,
    };
    return {
      config: "Bun.build target=browser format=esm packages=bundle splitting=false minify=true sourcemap=none env=disable; gzip level 9",
      gzipLevel: 9,
      owned,
      promotedCandidate,
      signedDelta,
      under50KiBGzipGate: signedDelta.gzipBytes <= 50 * 1024,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function nodeRuntimeDigest(): Promise<{ bunDigest: string; nodeDigest: string; equal: boolean }> {
  const temporary = mkdtempSync(join(tmpdir(), "atlcli-semantic-diff-node-"));
  try {
    const bundlePath = join(temporary, "semantic-diff-bakeoff.mjs");
    const bytes = await buildBytes(SCRIPT_PATH, "node");
    writeFileSync(bundlePath, bytes);
    const bunRows = await runtimeProbe();
    const child = Bun.spawn({
      cmd: ["node", bundlePath, "--runtime-probe"],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`Node runtime probe failed: ${stderr.trim()}`);
    const nodeRows = JSON.parse(stdout) as unknown;
    const bunDigest = await digestCanonicalJsonV1(bunRows);
    const nodeDigest = await digestCanonicalJsonV1(nodeRows);
    return { bunDigest, nodeDigest, equal: bunDigest === nodeDigest };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function environment(): BakeoffEvidence["environment"] {
  const nodeVersion = Bun.spawnSync({ cmd: ["node", "--version"], stdout: "pipe" });
  return {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpuModel: cpus()[0]?.model ?? "unknown",
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
    bun: Bun.version,
    node: nodeVersion.exitCode === 0
      ? new TextDecoder().decode(nodeVersion.stdout).trim()
      : `unavailable (${process.version} compatibility layer)`,
  };
}

function deriveGates(observations: readonly CandidateObservation[]): BakeoffEvidence["gates"] {
  const ownedCorrectness = observations.filter((row) =>
    row.candidate === "owned" && row.category === "correctness");
  const ownedStress10k = observations.filter((row) =>
    row.candidate === "owned" && row.fixture.endsWith("stress-10k"));
  const ownedStress100k = observations.filter((row) =>
    row.candidate === "owned" && row.fixture.endsWith("stress-100k"));
  const ownedMeaningChangesDetected = ownedCorrectness
    .filter((row) => row.expectedChange)
    .every((row) => row.detectedChange);
  const ownedApprovedNoiseNoOp = ownedCorrectness
    .filter((row) => row.approvedNoise)
    .every((row) => !row.detectedChange);
  const ownedFalsePositiveMovesZero = ownedCorrectness
    .every((row) => row.falsePositiveMoves === 0);
  const ownedSourceCompleteness = ownedCorrectness
    .every((row) => row.sourceCompleteness === true);
  const ownedCandidateBudgetRespected = observations
    .filter((row) => row.candidate === "owned")
    .every((row) => row.candidateComparisons !== null && row.candidateComparisons <= 1_000_000);
  const repeatedBytesIdentical = observations.every((row) => row.deterministic);
  const ownedRepeatedBytesIdentical = observations
    .filter((row) => row.candidate === "owned")
    .every((row) => row.deterministic);
  return {
    ownedMeaningChangesDetected,
    ownedApprovedNoiseNoOp,
    ownedFalsePositiveMovesZero,
    ownedSourceCompleteness,
    ownedCandidateBudgetRespected,
    repeatedBytesIdentical,
    stress10kUnder250ms: ownedStress10k.every((row) => row.wallTimeMs.p95 < 250),
    stress100kUnder2s: ownedStress100k.every((row) => row.wallTimeMs.p95 < 2_000),
    stress100kAdditionalRssUnder256MiB: ownedStress100k.every((row) =>
      row.additionalPeakRssBytes < 256 * 1024 * 1024),
    correctnessBlockingPass:
      ownedMeaningChangesDetected && ownedApprovedNoiseNoOp &&
      ownedFalsePositiveMovesZero && ownedSourceCompleteness &&
      ownedCandidateBudgetRespected && ownedRepeatedBytesIdentical,
  };
}

async function orchestratorMain(): Promise<void> {
  const observations: CandidateObservation[] = [];
  // Run blocking owned stress lanes in fresh workers before the intentionally
  // memory-heavy generic candidate. This prevents the comparison experiment's
  // OS pressure from contaminating absolute runtime/RSS gates.
  for (const fixture of fixtures.filter((item) => item.category === "stress")) {
    process.stderr.write(`semantic-diff-bakeoff: ${fixture.id} / owned\n`);
    observations.push(await spawnObservation("owned", fixture));
  }
  for (const fixture of fixtures.filter((item) => item.category === "correctness")) {
    for (const candidate of ["owned", "jsondiffpatch"] as const) {
      process.stderr.write(`semantic-diff-bakeoff: ${fixture.id} / ${candidate}\n`);
      observations.push(await spawnObservation(candidate, fixture));
    }
  }
  for (const fixture of fixtures.filter((item) => item.category === "stress")) {
    process.stderr.write(`semantic-diff-bakeoff: ${fixture.id} / jsondiffpatch\n`);
    observations.push(await spawnObservation("jsondiffpatch", fixture));
  }
  observations.sort((left, right) =>
    left.fixture.localeCompare(right.fixture) || left.candidate.localeCompare(right.candidate));
  const [bundles, runtime, retainedTreeReference100kProfile] = await Promise.all([
    bundleMeasurements(),
    nodeRuntimeDigest(),
    spawnOwnedProfile(),
  ]);
  const gates = deriveGates(observations);
  gates.repeatedBytesIdentical = gates.repeatedBytesIdentical && runtime.equal &&
    bundles.owned.deterministic && bundles.promotedCandidate.deterministic;
  gates.correctnessBlockingPass = gates.correctnessBlockingPass && runtime.equal;
  const libraryFailures = observations.filter((row) =>
    row.candidate === "jsondiffpatch" && !row.correctnessPass);
  const evidence: BakeoffEvidence = {
    schema: "atlcli.semantic-diff-bakeoff-evidence/1",
    generatedAt: new Date().toISOString(),
    environment: environment(),
    dependency: {
      name: "jsondiffpatch",
      version: "0.7.6",
      scope: "packages/change-set devDependency only",
    },
    observations,
    determinism: {
      bunRepeatedOutputs: observations.every((row) => row.deterministic),
      nodeCompatibleRuntime: runtime.equal,
      bunDigest: runtime.bunDigest,
      nodeDigest: runtime.nodeDigest,
    },
    bundles,
    retainedTreeReference100kProfile,
    gates,
    verdict: "keep-owned",
    verdictReasons: [
      "The owned matcher is the only candidate with bounded candidate-comparison instrumentation and mechanical exact-source coverage.",
      ...(libraryFailures.length > 0
        ? [`jsondiffpatch failed ${libraryFailures.length} candidate observation(s): ${libraryFailures.map((row) => row.fixture).join(", ")}.`]
        : ["jsondiffpatch did not materially improve correctness on the synthetic corpus."]),
      "A generic jsondiffpatch delta is not the owned ChangeSetV1 product contract and would require a separately tested adapter.",
      "The dependency remains benchmark-only even if its isolated bundle delta passes the size gate.",
    ],
  };
  if (!process.argv.includes("--no-write")) {
    mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
    writeFileSync(EVIDENCE_PATH, `${JSON.stringify(JSON.parse(canonicalJsonV1(evidence)), null, 2)}\n`);
  }
  process.stdout.write(`${canonicalJsonV1(evidence)}\n`);
  if (!evidence.gates.correctnessBlockingPass) process.exitCode = 1;
}

if (process.argv.includes("--worker")) {
  await workerMain();
} else if (process.argv.includes("--profile-owned-100k")) {
  await ownedProfileMain();
} else if (process.argv.includes("--runtime-probe")) {
  await runtimeProbeMain();
} else {
  await orchestratorMain();
}
