#!/usr/bin/env bun
import { readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const TEST_FILE_PATTERN =
  /(?:\.|_)(?:test|spec)\.(?:cjs|js|jsx|mjs|ts|tsx)$/;

const EXCLUDED_DIRECTORY_NAMES = new Set([
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "test-results",
]);

const EXCLUDED_DIRECTORY_PREFIXES = [
  ".turbo/",
  "artifacts/",
  "playwright-report/",
  // Keep explicit-file execution aligned with the canonical root test script.
  "spikes/",
];

function posix(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function normalizeRepositoryTestPath(path: string): string {
  const normalized = posix(path.trim());
  if (!normalized || isAbsolute(normalized)) {
    throw new Error(`test path must be repository-relative: ${path}`);
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`test path escapes or is not normalized: ${path}`);
  }
  return normalized;
}

function isExcludedPath(path: string): boolean {
  const segments = path.split("/");
  return (
    segments.some(
      (segment) =>
        segment.startsWith(".") ||
        EXCLUDED_DIRECTORY_NAMES.has(segment),
    ) ||
    EXCLUDED_DIRECTORY_PREFIXES.some(
      (prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix),
    )
  );
}

export function buildTestInventory(paths: readonly string[]): string[] {
  const inventory = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeRepositoryTestPath(path);
    if (isExcludedPath(normalized) || !TEST_FILE_PATTERN.test(normalized)) continue;
    inventory.add(normalized);
  }
  return [...inventory].sort((left, right) => left.localeCompare(right));
}

export function repositoryRelativePath(root: string, candidate: string): string {
  const resolvedRoot = realpathSync(root);
  const resolvedCandidate = realpathSync(candidate);
  const path = relative(resolvedRoot, resolvedCandidate);
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`path is outside repository root: ${candidate}`);
  }
  return normalizeRepositoryTestPath(path);
}

function walkFiles(root: string, directory: string, output: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;

    const absolute = resolve(directory, entry.name);
    const path = posix(relative(root, absolute));
    if (entry.isDirectory()) {
      if (!isExcludedPath(path)) walkFiles(root, absolute, output);
      continue;
    }
    if (entry.isFile()) output.push(path);
  }
}

export function discoverTestFiles(root = resolve(import.meta.dir, "../..")): string[] {
  const resolvedRoot = realpathSync(root);
  const files: string[] = [];
  walkFiles(resolvedRoot, resolvedRoot, files);
  return buildTestInventory(files);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const inventory = discoverTestFiles();
  if (args.has("--json")) {
    process.stdout.write(`${JSON.stringify({ schema: 1, files: inventory }, null, 2)}\n`);
    return;
  }
  for (const file of inventory) process.stdout.write(`${file}\n`);
}

if (import.meta.main) await main();
