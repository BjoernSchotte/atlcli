import { lstat, readFile, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ResearchPrivacyFile {
  path: string;
  content: string;
  binary?: boolean;
}

export interface ResearchPrivacyViolation {
  path: string;
  rule: string;
}

const textRules: readonly { rule: string; pattern: RegExp }[] = [
  {
    rule: "anthropic-api-key",
    pattern: /\bsk-ant-(?!(?:test-|packed-extension-test-only\b))[A-Za-z0-9_-]{20,}\b/u,
  },
];

const privateArtifactSuffixes = [
  ".research-gold.private.json",
  ".research-run.private.json",
  ".research-report.private.md",
  ".rovo-transcript.private.json",
] as const;

const binaryExtensions = new Set([
  ".docx",
  ".gif",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".wasm",
  ".woff",
  ".woff2",
  ".zip",
]);

function pathRule(path: string): string | undefined {
  const name = path.split("/").at(-1) ?? path;
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) {
    return "tracked-environment-file";
  }
  if (privateArtifactSuffixes.some((suffix) => path.endsWith(suffix))) {
    return "tracked-private-research-artifact";
  }
  return undefined;
}

export function findResearchPrivacyViolations(
  files: readonly ResearchPrivacyFile[],
  privateMarkers: readonly string[] = [],
): ResearchPrivacyViolation[] {
  const violations: ResearchPrivacyViolation[] = [];
  for (const file of files) {
    const unsafePath = pathRule(file.path);
    if (unsafePath) violations.push({ path: file.path, rule: unsafePath });
    if (file.binary) continue;
    for (const { rule, pattern } of textRules) {
      if (pattern.test(file.content)) violations.push({ path: file.path, rule });
    }
    if (privateMarkers.some((marker) => marker.length > 0 && file.content.includes(marker))) {
      violations.push({ path: file.path, rule: "configured-private-marker" });
    }
  }
  return violations.sort((left, right) =>
    left.path.localeCompare(right.path) || left.rule.localeCompare(right.rule)
  );
}

export function parseResearchPrivateMarkers(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((marker) => typeof marker !== "string")) {
    throw new Error("ATLCLI_RESEARCH_PRIVATE_MARKERS must be a JSON array of strings");
  }
  return [...new Set(parsed.map((marker) => marker.trim()).filter(Boolean))];
}

async function trackedFiles(repoRoot: string): Promise<ResearchPrivacyFile[]> {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.toString().trim()}`);
  }
  const files: ResearchPrivacyFile[] = [];
  for (const path of result.stdout.toString().split("\0").filter(Boolean)) {
    const file = await readTrackedResearchPrivacyFile(repoRoot, path);
    if (file) files.push(file);
  }
  return files;
}

export async function readTrackedResearchPrivacyFile(
  repoRoot: string,
  path: string,
): Promise<ResearchPrivacyFile | undefined> {
  const absolute = resolve(repoRoot, path);
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (info.isSymbolicLink()) {
    return { path, content: await readlink(absolute) };
  }
  const bytes = await readFile(absolute);
  const lowercasePath = path.toLocaleLowerCase("en-US");
  const binary =
    [...binaryExtensions].some((extension) => lowercasePath.endsWith(extension)) ||
    bytes.subarray(0, Math.min(bytes.byteLength, 8_192)).includes(0);
  return {
    path,
    content: binary ? "" : new TextDecoder().decode(bytes),
    ...(binary ? { binary: true } : {}),
  };
}

async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const privateMarkers = parseResearchPrivateMarkers(
    Bun.env.ATLCLI_RESEARCH_PRIVATE_MARKERS,
  );
  const violations = findResearchPrivacyViolations(
    await trackedFiles(repoRoot),
    privateMarkers,
  );
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`Research privacy: ${violation.path}: ${violation.rule}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("Research privacy: tracked tree passed");
}

if (import.meta.main) await main();
