#!/usr/bin/env bun
import { readFileSync } from "node:fs";
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

async function main(): Promise<void> {
  const [path, namespace = "legacy", lane = "lane"] = process.argv.slice(2);
  if (!path) throw new Error("usage: bun scripts/ci/test-timings.ts <junit.xml> [namespace] [lane]");
  process.stdout.write(
    `${JSON.stringify(parseBunJUnit(readFileSync(path, "utf8"), { namespace, lane }), null, 2)}\n`,
  );
}

if (import.meta.main) await main();
