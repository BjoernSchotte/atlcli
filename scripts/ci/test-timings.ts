#!/usr/bin/env bun
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { normalizeRepositoryTestPath } from "./test-inventory.js";

export type TestOutcome = "passed" | "failed" | "skipped";

export interface TestcaseTiming {
  identity: string;
  name: string;
  classname: string;
  file: string;
  durationSeconds: number;
  outcome: TestOutcome;
}

export interface FileTiming {
  file: string;
  durationSeconds: number;
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface LaneTimingArtifact {
  schema: 1;
  namespace: string;
  lane: string;
  files: FileTiming[];
  testcases: TestcaseTiming[];
}

export interface TimingSnapshot {
  schema: 1;
  baselineSha: string;
  sourceRun: string;
  samples: number;
  files: FileTiming[];
}

export interface TopologyTimingComparison {
  schema: 1;
  legacyNamespace: string;
  candidateNamespace: string;
  files: number;
  testcases: number;
  legacyDurationSeconds: number;
  candidateDurationSeconds: number;
  deltaSeconds: number;
  ratio: number | null;
  fileDeltas: Array<{
    file: string;
    legacyDurationSeconds: number;
    candidateDurationSeconds: number;
    deltaSeconds: number;
  }>;
}

const ATTRIBUTE_PATTERN =
  /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const TESTCASE_PATTERN =
  /<testcase\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/testcase\s*>)/g;

function decodeXml(value: string): string {
  return value.replace(
    /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g,
    (entity) => {
      if (entity === "&amp;") return "&";
      if (entity === "&lt;") return "<";
      if (entity === "&gt;") return ">";
      if (entity === "&quot;") return '"';
      if (entity === "&apos;") return "'";
      const hexadecimal = entity.startsWith("&#x");
      const digits = entity.slice(hexadecimal ? 3 : 2, -1);
      const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
      if (!Number.isSafeInteger(codePoint)) throw new Error(`invalid XML entity: ${entity}`);
      return String.fromCodePoint(codePoint);
    },
  );
}

function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  ATTRIBUTE_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1]!;
    if (attributes.has(name)) throw new Error(`duplicate XML attribute: ${name}`);
    attributes.set(name, decodeXml(match[2] ?? match[3] ?? ""));
  }
  return attributes;
}

function requiredAttribute(attributes: ReadonlyMap<string, string>, name: string): string {
  const value = attributes.get(name);
  if (value === undefined || value === "") {
    throw new Error(`testcase is missing ${name}`);
  }
  return value;
}

function duration(attributes: ReadonlyMap<string, string>): number {
  const raw = requiredAttribute(attributes, "time");
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`invalid testcase duration: ${raw}`);
  }
  return value;
}

function outcome(body: string): TestOutcome {
  const skipped = /<skipped\b/.test(body);
  const failed = /<(?:failure|error)\b/.test(body);
  if (skipped && failed) throw new Error("testcase cannot be both skipped and failed");
  if (skipped) return "skipped";
  if (failed) return "failed";
  return "passed";
}

function validateXmlEnvelope(xml: string, matchedTestcases: number): void {
  if (!/<testsuites\b/.test(xml) || !/<\/testsuites\s*>/.test(xml)) {
    throw new Error("malformed JUnit XML: missing testsuites envelope");
  }
  const testcaseOpeners = xml.match(/<testcase\b/g)?.length ?? 0;
  if (testcaseOpeners !== matchedTestcases) {
    throw new Error("malformed JUnit XML: unclosed testcase");
  }
}

export function parseBunJUnit(
  xml: string,
  options: { namespace: string; lane: string },
): LaneTimingArtifact {
  if (!options.namespace.trim() || !options.lane.trim()) {
    throw new Error("namespace and lane are required");
  }

  const testcases: TestcaseTiming[] = [];
  const identities = new Set<string>();
  TESTCASE_PATTERN.lastIndex = 0;
  for (const match of xml.matchAll(TESTCASE_PATTERN)) {
    const attributes = parseAttributes(match[1] ?? "");
    const file = normalizeRepositoryTestPath(requiredAttribute(attributes, "file"));
    const name = requiredAttribute(attributes, "name");
    const classname = attributes.get("classname") ?? "";
    const identity = `${file}\u0000${classname}\u0000${name}`;
    if (identities.has(identity)) {
      throw new Error(`duplicate testcase identity: ${file} :: ${classname} :: ${name}`);
    }
    identities.add(identity);
    testcases.push({
      identity,
      name,
      classname,
      file,
      durationSeconds: duration(attributes),
      outcome: outcome(match[2] ?? ""),
    });
  }
  validateXmlEnvelope(xml, testcases.length);

  const byFile = new Map<string, FileTiming>();
  for (const testcase of testcases) {
    const aggregate = byFile.get(testcase.file) ?? {
      file: testcase.file,
      durationSeconds: 0,
      tests: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
    };
    aggregate.durationSeconds += testcase.durationSeconds;
    aggregate.tests += 1;
    aggregate[testcase.outcome] += 1;
    byFile.set(testcase.file, aggregate);
  }

  return {
    schema: 1,
    namespace: options.namespace,
    lane: options.lane,
    files: [...byFile.values()].sort((left, right) => left.file.localeCompare(right.file)),
    testcases,
  };
}

export function assertDisjointLaneOwnership(
  artifacts: readonly LaneTimingArtifact[],
): void {
  const owners = new Map<string, string>();
  for (const artifact of artifacts) {
    for (const file of artifact.files) {
      const key = `${artifact.namespace}\u0000${file.file}`;
      const previous = owners.get(key);
      if (previous) {
        throw new Error(
          `duplicate file ownership in ${artifact.namespace}: ${file.file} (${previous}, ${artifact.lane})`,
        );
      }
      owners.set(key, artifact.lane);
    }
  }
}

export function createTimingSnapshot(options: {
  baselineSha: string;
  sourceRun: string;
  artifacts: readonly LaneTimingArtifact[];
}): TimingSnapshot {
  if (!/^[0-9a-f]{40}$/i.test(options.baselineSha)) {
    throw new Error("baseline SHA must contain 40 hexadecimal characters");
  }
  if (!options.sourceRun.trim()) throw new Error("source run is required");
  assertDisjointLaneOwnership(options.artifacts);

  const files = options.artifacts
    .flatMap((artifact) => artifact.files)
    .sort((left, right) => left.file.localeCompare(right.file));
  return {
    schema: 1,
    baselineSha: options.baselineSha.toLowerCase(),
    sourceRun: options.sourceRun,
    samples: options.artifacts.length,
    files,
  };
}

function artifactsByIdentity(artifacts: readonly LaneTimingArtifact[]): Map<string, TestcaseTiming> {
  assertDisjointLaneOwnership(artifacts);
  const result = new Map<string, TestcaseTiming>();
  for (const testcase of artifacts.flatMap((artifact) => artifact.testcases)) {
    if (result.has(testcase.identity)) {
      throw new Error(`duplicate testcase identity across lanes: ${testcase.identity}`);
    }
    result.set(testcase.identity, testcase);
  }
  return result;
}

function singleNamespace(artifacts: readonly LaneTimingArtifact[], label: string): string {
  const namespaces = [...new Set(artifacts.map((artifact) => artifact.namespace))];
  if (namespaces.length !== 1) throw new Error(`${label} must contain exactly one namespace`);
  return namespaces[0]!;
}

export function compareTopologyTimings(options: {
  legacy: readonly LaneTimingArtifact[];
  candidate: readonly LaneTimingArtifact[];
}): TopologyTimingComparison {
  const legacyNamespace = singleNamespace(options.legacy, "legacy artifacts");
  const candidateNamespace = singleNamespace(options.candidate, "candidate artifacts");
  if (legacyNamespace === candidateNamespace) {
    throw new Error("legacy and candidate namespaces must differ");
  }
  const legacy = artifactsByIdentity(options.legacy);
  const candidate = artifactsByIdentity(options.candidate);
  const legacyIds = [...legacy.keys()].sort((left, right) => left.localeCompare(right));
  const candidateIds = [...candidate.keys()].sort((left, right) => left.localeCompare(right));
  const missing = legacyIds.filter((identity) => !candidate.has(identity));
  const extra = candidateIds.filter((identity) => !legacy.has(identity));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `topology testcase identity mismatch: missing=${missing.length}, extra=${extra.length}`,
    );
  }
  for (const identity of legacyIds) {
    const left = legacy.get(identity)!;
    const right = candidate.get(identity)!;
    if (left.outcome !== right.outcome) {
      throw new Error(`topology testcase outcome mismatch: ${identity}`);
    }
  }

  const aggregate = (testcases: Iterable<TestcaseTiming>): Map<string, number> => {
    const files = new Map<string, number>();
    for (const testcase of testcases) {
      files.set(testcase.file, (files.get(testcase.file) ?? 0) + testcase.durationSeconds);
    }
    return files;
  };
  const legacyFiles = aggregate(legacy.values());
  const candidateFiles = aggregate(candidate.values());
  const fileDeltas = [...legacyFiles.entries()]
    .map(([file, legacyDurationSeconds]) => {
      const candidateDurationSeconds = candidateFiles.get(file);
      if (candidateDurationSeconds === undefined) {
        throw new Error(`topology file identity mismatch: ${file}`);
      }
      return {
        file,
        legacyDurationSeconds,
        candidateDurationSeconds,
        deltaSeconds: candidateDurationSeconds - legacyDurationSeconds,
      };
    })
    .sort(
      (left, right) =>
        right.deltaSeconds - left.deltaSeconds || left.file.localeCompare(right.file),
    );
  const legacyDurationSeconds = fileDeltas.reduce(
    (total, file) => total + file.legacyDurationSeconds,
    0,
  );
  const candidateDurationSeconds = fileDeltas.reduce(
    (total, file) => total + file.candidateDurationSeconds,
    0,
  );
  return {
    schema: 1,
    legacyNamespace,
    candidateNamespace,
    files: fileDeltas.length,
    testcases: legacyIds.length,
    legacyDurationSeconds,
    candidateDurationSeconds,
    deltaSeconds: candidateDurationSeconds - legacyDurationSeconds,
    ratio: legacyDurationSeconds === 0 ? null : candidateDurationSeconds / legacyDurationSeconds,
    fileDeltas,
  };
}

export function topologyComparisonMarkdown(comparison: TopologyTimingComparison): string {
  const ratio = comparison.ratio === null ? "unavailable" : comparison.ratio.toFixed(3);
  return [
    "## Legacy vs candidate test timing",
    "",
    `- Identity proof: ${comparison.files} files / ${comparison.testcases} testcases`,
    `- Legacy testcase time: ${comparison.legacyDurationSeconds.toFixed(3)}s`,
    `- Candidate testcase time: ${comparison.candidateDurationSeconds.toFixed(3)}s`,
    `- Candidate / legacy ratio: ${ratio}`,
    "",
    "### Largest candidate regressions",
    "",
    ...comparison.fileDeltas
      .slice(0, 20)
      .map((file) => `- \`${file.file}\`: ${file.deltaSeconds.toFixed(3)}s`),
    "",
  ].join("\n");
}

function filesRecursively(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesRecursively(path));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function junitArtifacts(directory: string, namespace: string): LaneTimingArtifact[] {
  return filesRecursively(directory)
    .filter((path) => extname(path) === ".xml")
    .map((path) =>
      parseBunJUnit(readFileSync(path, "utf8"), {
        namespace,
        lane: basename(path, ".xml"),
      }),
    );
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function writeJson(path: string, value: unknown): void {
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "snapshot") {
    const artifacts = junitArtifacts(option(args, "--junit"), option(args, "--namespace"));
    writeJson(
      option(args, "--out"),
      createTimingSnapshot({
        baselineSha: option(args, "--baseline-sha"),
        sourceRun: option(args, "--source-run"),
        artifacts,
      }),
    );
    return;
  }
  if (args[0] === "compare") {
    const comparison = compareTopologyTimings({
      legacy: junitArtifacts(
        option(args, "--legacy-junit"),
        option(args, "--legacy-namespace"),
      ),
      candidate: junitArtifacts(
        option(args, "--candidate-junit"),
        option(args, "--candidate-namespace"),
      ),
    });
    writeJson(option(args, "--out"), comparison);
    process.stdout.write(topologyComparisonMarkdown(comparison));
    return;
  }
  const [path, namespace = "legacy", lane = "lane"] = args;
  if (!path) throw new Error("usage: bun scripts/ci/test-timings.ts <junit.xml> [namespace] [lane]");
  process.stdout.write(
    `${JSON.stringify(parseBunJUnit(readFileSync(path, "utf8"), { namespace, lane }), null, 2)}\n`,
  );
}

if (import.meta.main) await main();
