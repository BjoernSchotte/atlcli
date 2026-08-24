#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import JSZip from "jszip";
import { inspectZipCentralDirectory } from "../verify-release-artifacts.js";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SUITE_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const FAILURE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;

export const BROWSER_EVIDENCE_SCHEMA = "atlcli.browser-evidence/v1" as const;

export const SYNTHETIC_ATLASSIAN_HOST_ALLOWLIST: readonly string[] = Object.freeze([
  "fixture.atlassian.net",
  "foreign.atlassian.net",
  "packed-research.atlassian.net",
  "site.atlassian.net",
  "whiteboard-site.atlassian.net",
]);

const SYNTHETIC_ATLASSIAN_HOSTS = new Set(SYNTHETIC_ATLASSIAN_HOST_ALLOWLIST);
const ATLASSIAN_HOST_PATTERN = /\b(?:[a-z0-9-]+\.)*(?:atlassian\.net|jira\.com)\b/giu;

export const BROWSER_EVIDENCE_KINDS = [
  "junit",
  "json",
  "html",
  "text",
  "trace",
  "screenshot",
  "video",
] as const;

export type BrowserEvidenceKind = typeof BROWSER_EVIDENCE_KINDS[number];
export type BrowserEvidenceClass = "synthetic" | "live";
export type BrowserEvidenceStatus = "passed" | "failed";

export interface BrowserEvidenceFile {
  path: string;
  kind: BrowserEvidenceKind;
  size: number;
  sha256: string;
}

export interface BrowserEvidenceManifest {
  schema: typeof BROWSER_EVIDENCE_SCHEMA;
  evidenceClass: BrowserEvidenceClass;
  suite: string;
  sha: string;
  run: { id: string; attempt: number };
  status: BrowserEvidenceStatus;
  files: BrowserEvidenceFile[];
}

export interface BrowserEvidenceLimits {
  maxSuites: number;
  maxFilesPerSuite: number;
  maxTotalBytes: number;
  maxManifestBytes: number;
  maxTextScanBytes: number;
  maxTraceEntries: number;
  maxTraceEntryBytes: number;
  maxTraceTotalBytes: number;
  maxTraceCompressionRatio: number;
  maxFileBytes: Readonly<Record<BrowserEvidenceKind, number>>;
}

export const DEFAULT_BROWSER_EVIDENCE_LIMITS: BrowserEvidenceLimits = Object.freeze({
  maxSuites: 16,
  maxFilesPerSuite: 256,
  maxTotalBytes: 256 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxTextScanBytes: 8 * 1024 * 1024,
  maxTraceEntries: 20_000,
  maxTraceEntryBytes: 16 * 1024 * 1024,
  maxTraceTotalBytes: 128 * 1024 * 1024,
  maxTraceCompressionRatio: 1_000,
  maxFileBytes: Object.freeze({
    junit: 8 * 1024 * 1024,
    json: 4 * 1024 * 1024,
    html: 4 * 1024 * 1024,
    text: 2 * 1024 * 1024,
    trace: 64 * 1024 * 1024,
    screenshot: 10 * 1024 * 1024,
    video: 100 * 1024 * 1024,
  }),
});

export interface BrowserEvidenceMetadata {
  evidenceClass: BrowserEvidenceClass;
  suite: string;
  sha: string;
  run: { id: string; attempt: number };
  status: BrowserEvidenceStatus;
}

export interface BrowserEvidenceValidationOptions {
  expectedSha?: string;
  expectedRun?: { id: string; attempt: number };
  allowedWorkspacePath?: string;
  limits?: Partial<Omit<BrowserEvidenceLimits, "maxFileBytes">> & {
    maxFileBytes?: Partial<Record<BrowserEvidenceKind, number>>;
  };
}

export interface BrowserEvidenceValidationReceipt {
  schema: "atlcli.browser-evidence-validation/v1";
  sha: string;
  run: { id: string; attempt: number };
  suites: { suite: string; status: BrowserEvidenceStatus; files: number; bytes: number }[];
  files: number;
  bytes: number;
}

interface SensitiveRule {
  name: string;
  pattern: RegExp;
}

const SENSITIVE_RULES: readonly SensitiveRule[] = [
  { name: "authorization-header", pattern: /\bauthorization\s*[:=]\s*["']?(?:basic|bearer)\s+[A-Za-z0-9._~+/=-]{8,}/iu },
  { name: "cookie-header", pattern: /\b(?:set-cookie|cookie)\s*[:=]\s*["']?[A-Za-z0-9_.-]{1,80}=[^\s;"']{6,}/iu },
  { name: "secret-json-field", pattern: /(?:\\?["'])?(?:access[_-]?token|api[_-]?token|api[_-]?key|client[_-]?secret|refresh[_-]?token|password|session[_-]?(?:id|token))(?:\\?["'])?\s*:\s*(?:\\?["'])[^"'\\]{8,}/iu },
  { name: "openai-api-key", pattern: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/u },
  { name: "anthropic-api-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/u },
  { name: "github-token", pattern: /\b(?:gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u },
  { name: "private-home-path", pattern: /(?:\/Users\/[^/\s"']+\/|\/home\/[^/\s"']+\/|[A-Za-z]:\\Users\\[^\\\s"']+\\)/u },
];

const TRACE_TEXT_PATH_PATTERN = /(?:^|\/)(?:[^/]+\.(?:css|html?|js|json|log|md|network|stacks|trace|txt|xml)|trace)$/iu;

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function safeRelativePath(path: string, label: string): string {
  const normalized = path.replaceAll("\\", "/");
  const components = normalized.split("/");
  if (
    normalized !== path ||
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.includes("\0") ||
    components.some((component) => component === "" || component === "." || component === "..")
  ) {
    throw new Error(`${label} is unsafe`);
  }
  return normalized;
}

export function classifyBrowserEvidencePath(path: string): BrowserEvidenceKind {
  const safe = safeRelativePath(path, "evidence path");
  if (safe === "junit.xml") return "junit";
  if (safe === "summary.json" || safe === "report/data.json") return "json";
  if (safe === "report/index.html") return "html";
  const failure = /^failures\/([^/]+)\/(trace|screenshot|video|details)-([1-9][0-9]*)\.(zip|png|webm|txt)$/u.exec(safe);
  if (!failure || !FAILURE_ID_PATTERN.test(failure[1] ?? "")) {
    throw new Error(`evidence path is not allowed: ${safe}`);
  }
  const stem = failure[2];
  const extension = failure[4];
  const expected = stem === "trace" ? "zip"
    : stem === "screenshot" ? "png"
    : stem === "video" ? "webm"
    : "txt";
  if (extension !== expected) throw new Error(`evidence path has mismatched extension: ${safe}`);
  if (stem === "details") return "text";
  return stem as "trace" | "screenshot" | "video";
}

function parseManifest(value: unknown, suiteDirectory: string): BrowserEvidenceManifest {
  const manifest = record(value, "manifest");
  exactKeys(manifest, ["schema", "evidenceClass", "suite", "sha", "run", "status", "files"], "manifest");
  if (manifest.schema !== BROWSER_EVIDENCE_SCHEMA) throw new Error("manifest schema is unsupported");
  if (manifest.evidenceClass !== "synthetic" && manifest.evidenceClass !== "live") {
    throw new Error("manifest evidenceClass is invalid");
  }
  if (manifest.evidenceClass !== "synthetic") {
    throw new Error("live browser evidence is forbidden for GitHub publication");
  }
  if (typeof manifest.suite !== "string" || !SUITE_PATTERN.test(manifest.suite)) {
    throw new Error("manifest suite is invalid");
  }
  if (manifest.suite !== suiteDirectory) throw new Error("manifest suite does not match its directory");
  if (typeof manifest.sha !== "string" || !SHA_PATTERN.test(manifest.sha)) {
    throw new Error("manifest sha is invalid");
  }
  const run = record(manifest.run, "manifest run");
  exactKeys(run, ["id", "attempt"], "manifest run");
  if (typeof run.id !== "string" || !POSITIVE_INTEGER_PATTERN.test(run.id)) {
    throw new Error("manifest run id is invalid");
  }
  if (!Number.isSafeInteger(run.attempt) || (run.attempt as number) < 1) {
    throw new Error("manifest run attempt is invalid");
  }
  if (manifest.status !== "passed" && manifest.status !== "failed") {
    throw new Error("manifest status is invalid");
  }
  if (!Array.isArray(manifest.files)) throw new Error("manifest files must be an array");

  const seen = new Set<string>();
  const portableSeen = new Set<string>();
  const files = manifest.files.map((value, index): BrowserEvidenceFile => {
    const file = record(value, `manifest file ${index}`);
    exactKeys(file, ["path", "kind", "size", "sha256"], `manifest file ${index}`);
    if (typeof file.path !== "string") throw new Error(`manifest file ${index} path is invalid`);
    const path = safeRelativePath(file.path, `manifest file ${index} path`);
    const kind = classifyBrowserEvidencePath(path);
    if (file.kind !== kind) throw new Error(`manifest kind does not match path: ${path}`);
    if (!Number.isSafeInteger(file.size) || (file.size as number) < 0) {
      throw new Error(`manifest size is invalid: ${path}`);
    }
    if (typeof file.sha256 !== "string" || !SHA256_PATTERN.test(file.sha256)) {
      throw new Error(`manifest digest is invalid: ${path}`);
    }
    if (seen.has(path)) throw new Error(`manifest contains duplicate path: ${path}`);
    seen.add(path);
    const portable = path.normalize("NFC").toLocaleLowerCase("en-US");
    if (portableSeen.has(portable)) throw new Error(`manifest contains portable path collision: ${path}`);
    portableSeen.add(portable);
    return { path, kind, size: file.size as number, sha256: file.sha256 };
  });

  if (!seen.has("junit.xml") || !seen.has("summary.json")) {
    throw new Error("manifest must inventory junit.xml and summary.json");
  }
  const failureKinds = new Set(files.filter(({ path }) => path.startsWith("failures/")).map(({ kind }) => kind));
  if (manifest.status === "failed") {
    if (!failureKinds.has("trace")) throw new Error("failed suite is missing trace evidence");
    if (!failureKinds.has("screenshot") && !failureKinds.has("video")) {
      throw new Error("failed suite is missing visual evidence");
    }
  } else if (failureKinds.size > 0) {
    throw new Error("passed suite must not publish failure evidence");
  }

  return {
    schema: BROWSER_EVIDENCE_SCHEMA,
    evidenceClass: manifest.evidenceClass,
    suite: manifest.suite,
    sha: manifest.sha,
    run: { id: run.id as string, attempt: run.attempt as number },
    status: manifest.status,
    files,
  };
}

function limitsWithOverrides(options?: BrowserEvidenceValidationOptions["limits"]): BrowserEvidenceLimits {
  return {
    ...DEFAULT_BROWSER_EVIDENCE_LIMITS,
    ...options,
    maxFileBytes: { ...DEFAULT_BROWSER_EVIDENCE_LIMITS.maxFileBytes, ...options?.maxFileBytes },
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function scanSensitiveText(
  text: string,
  displayPath: string,
  allowedWorkspacePath?: string,
): void {
  const scanned = allowedWorkspacePath
    ? text.replace(
        new RegExp(
          `${escapeRegularExpression(resolve(allowedWorkspacePath))}(?=$|[/\\\\\\s"'])`,
          "gu",
        ),
        "<workspace>",
      )
    : text;
  for (const rule of SENSITIVE_RULES) {
    if (rule.pattern.test(scanned)) {
      throw new Error(`sensitive content rule ${rule.name} matched in ${displayPath}`);
    }
  }
  for (const match of scanned.matchAll(ATLASSIAN_HOST_PATTERN)) {
    if (!SYNTHETIC_ATLASSIAN_HOSTS.has(match[0].toLocaleLowerCase("en-US"))) {
      throw new Error(`sensitive content rule non-synthetic-atlassian-host matched in ${displayPath}`);
    }
  }
}

function decodeText(bytes: Uint8Array, displayPath: string): string {
  if (bytes.includes(0)) throw new Error(`text evidence contains binary bytes: ${displayPath}`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`text evidence is not valid UTF-8: ${displayPath}`);
  }
}

async function scanTrace(
  bytes: Uint8Array,
  displayPath: string,
  limits: BrowserEvidenceLimits,
  allowedWorkspacePath?: string,
): Promise<void> {
  const entries = inspectZipCentralDirectory(bytes, {
    maxEntries: limits.maxTraceEntries,
    maxEntrySize: limits.maxTraceEntryBytes,
    maxTotalSize: limits.maxTraceTotalBytes,
    maxRatio: limits.maxTraceCompressionRatio,
  });
  const archive = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  for (const entry of entries) {
    if (entry.path.endsWith("/")) continue;
    const knownTextEntry = TRACE_TEXT_PATH_PATTERN.test(entry.path);
    if (knownTextEntry && entry.uncompressedSize > limits.maxTextScanBytes) {
      throw new Error(`trace text entry exceeds scan limit: ${displayPath}#${entry.path}`);
    }
    if (!knownTextEntry && entry.uncompressedSize > limits.maxTextScanBytes) continue;
    const file = archive.file(entry.path);
    if (!file) throw new Error(`trace entry cannot be resolved: ${displayPath}#${entry.path}`);
    const content = await file.async("uint8array");
    if (content.byteLength !== entry.uncompressedSize) {
      throw new Error(`trace entry size mismatch: ${displayPath}#${entry.path}`);
    }
    if (knownTextEntry) {
      scanSensitiveText(
        decodeText(content, `${displayPath}#${entry.path}`),
        `${displayPath}#${entry.path}`,
        allowedWorkspacePath,
      );
      continue;
    }
    if (content.includes(0)) continue;
    try {
      scanSensitiveText(
        new TextDecoder("utf-8", { fatal: true }).decode(content),
        `${displayPath}#${entry.path}`,
        allowedWorkspacePath,
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("sensitive content rule ")) throw error;
    }
  }
}

async function regularFiles(directory: string, prefix = ""): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name);
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const info = await lstat(child);
    if (info.isSymbolicLink()) throw new Error(`symbolic link is forbidden: ${path}`);
    if (info.isDirectory()) paths.push(...await regularFiles(child, path));
    else if (info.isFile()) paths.push(path);
    else throw new Error(`non-regular evidence entry is forbidden: ${path}`);
  }
  return paths.sort();
}

function assertDirectoryContained(root: string, child: string): void {
  const rel = relative(resolve(root), resolve(child));
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(child) === resolve(root)) {
    throw new Error("evidence path escapes its suite directory");
  }
}

async function fileInventory(suiteDirectory: string): Promise<BrowserEvidenceFile[]> {
  const paths = (await regularFiles(suiteDirectory)).filter((path) => path !== "manifest.json");
  const files: BrowserEvidenceFile[] = [];
  for (const path of paths) {
    const kind = classifyBrowserEvidencePath(path);
    const absolute = join(suiteDirectory, path);
    assertDirectoryContained(suiteDirectory, absolute);
    const bytes = await readFile(absolute);
    files.push({ path, kind, size: bytes.byteLength, sha256: sha256(bytes) });
  }
  return files;
}

export async function buildBrowserEvidenceManifest(
  suiteDirectory: string,
  metadata: BrowserEvidenceMetadata,
): Promise<BrowserEvidenceManifest> {
  if (basename(resolve(suiteDirectory)) !== metadata.suite) {
    throw new Error("evidence metadata suite does not match its directory");
  }
  return parseManifest({
    schema: BROWSER_EVIDENCE_SCHEMA,
    ...metadata,
    files: await fileInventory(suiteDirectory),
  }, metadata.suite);
}

export async function writeBrowserEvidenceManifest(
  suiteDirectory: string,
  metadata: BrowserEvidenceMetadata,
): Promise<BrowserEvidenceManifest> {
  const manifest = await buildBrowserEvidenceManifest(suiteDirectory, metadata);
  await writeFile(join(suiteDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "w" });
  return manifest;
}

async function readManifest(suiteDirectory: string, limits: BrowserEvidenceLimits): Promise<BrowserEvidenceManifest> {
  const manifestPath = join(suiteDirectory, "manifest.json");
  const info = await lstat(manifestPath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("manifest.json must be a regular file");
  if (info.size > limits.maxManifestBytes) throw new Error("manifest.json exceeds size limit");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("manifest.json is not valid JSON");
  }
  return parseManifest(parsed, basename(suiteDirectory));
}

export async function validateBrowserEvidence(
  rootDirectory: string,
  options: BrowserEvidenceValidationOptions = {},
): Promise<BrowserEvidenceValidationReceipt> {
  if (options.expectedSha && !SHA_PATTERN.test(options.expectedSha)) {
    throw new Error("expected browser evidence sha is invalid");
  }
  if (options.expectedRun && (
    !POSITIVE_INTEGER_PATTERN.test(options.expectedRun.id) ||
    !Number.isSafeInteger(options.expectedRun.attempt) ||
    options.expectedRun.attempt < 1
  )) {
    throw new Error("expected browser evidence run is invalid");
  }
  const root = resolve(rootDirectory);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("browser evidence root must be a real directory");
  }
  const limits = limitsWithOverrides(options.limits);
  const allowedWorkspacePath = options.allowedWorkspacePath
    ? resolve(options.allowedWorkspacePath)
    : undefined;
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length === 0) throw new Error("browser evidence root is empty");
  if (entries.length > limits.maxSuites) throw new Error("browser evidence suite count exceeds limit");

  const suiteNames = entries.map(({ name }) => name).sort();
  for (const entry of entries) {
    const info = await lstat(join(root, entry.name));
    if (info.isSymbolicLink() || !info.isDirectory() || !SUITE_PATTERN.test(entry.name)) {
      throw new Error(`browser evidence root entry is forbidden: ${entry.name}`);
    }
  }

  let expectedSha = options.expectedSha;
  let expectedRun = options.expectedRun;
  let totalBytes = 0;
  let totalFiles = 0;
  const suites: BrowserEvidenceValidationReceipt["suites"] = [];

  for (const suiteName of suiteNames) {
    const suiteDirectory = join(root, suiteName);
    const manifest = await readManifest(suiteDirectory, limits);
    if (expectedSha && manifest.sha !== expectedSha) throw new Error(`manifest sha mismatch in suite ${suiteName}`);
    if (expectedRun && (manifest.run.id !== expectedRun.id || manifest.run.attempt !== expectedRun.attempt)) {
      throw new Error(`manifest run mismatch in suite ${suiteName}`);
    }
    expectedSha ??= manifest.sha;
    expectedRun ??= manifest.run;

    const actualPaths = await regularFiles(suiteDirectory);
    const expectedPaths = ["manifest.json", ...manifest.files.map(({ path }) => path)].sort();
    if (
      actualPaths.length !== expectedPaths.length ||
      actualPaths.some((path, index) => path !== expectedPaths[index])
    ) {
      throw new Error(`manifest inventory does not match suite ${suiteName}`);
    }
    if (manifest.files.length > limits.maxFilesPerSuite) {
      throw new Error(`evidence file count exceeds limit in suite ${suiteName}`);
    }

    let suiteBytes = 0;
    for (const file of manifest.files) {
      if (file.size > limits.maxFileBytes[file.kind]) {
        throw new Error(`evidence file exceeds ${file.kind} size limit: ${suiteName}/${file.path}`);
      }
      const absolute = join(suiteDirectory, file.path);
      assertDirectoryContained(suiteDirectory, absolute);
      const bytes = await readFile(absolute);
      if (bytes.byteLength !== file.size) throw new Error(`evidence size mismatch: ${suiteName}/${file.path}`);
      if (sha256(bytes) !== file.sha256) throw new Error(`evidence digest mismatch: ${suiteName}/${file.path}`);
      suiteBytes += bytes.byteLength;
      totalBytes += bytes.byteLength;
      totalFiles++;
      if (totalBytes > limits.maxTotalBytes) throw new Error("browser evidence total size exceeds limit");

      const displayPath = `${suiteName}/${file.path}`;
      if (file.kind === "junit" || file.kind === "json" || file.kind === "html" || file.kind === "text") {
        if (bytes.byteLength > limits.maxTextScanBytes) throw new Error(`text evidence exceeds scan limit: ${displayPath}`);
        scanSensitiveText(decodeText(bytes, displayPath), displayPath, allowedWorkspacePath);
      } else if (file.kind === "trace") {
        await scanTrace(bytes, displayPath, limits, allowedWorkspacePath);
      }
    }
    suites.push({ suite: suiteName, status: manifest.status, files: manifest.files.length, bytes: suiteBytes });
  }

  if (!expectedSha || !expectedRun) throw new Error("browser evidence identity is missing");
  return {
    schema: "atlcli.browser-evidence-validation/v1",
    sha: expectedSha,
    run: expectedRun,
    suites,
    files: totalFiles,
    bytes: totalBytes,
  };
}

function argument(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const root = Bun.argv[2] && !Bun.argv[2]!.startsWith("--")
    ? Bun.argv[2]!
    : ".artifacts/browser-evidence";
  const sha = argument("--sha") ?? Bun.env.GITHUB_SHA;
  const runId = argument("--run-id") ?? Bun.env.GITHUB_RUN_ID;
  const runAttemptText = argument("--run-attempt") ?? Bun.env.GITHUB_RUN_ATTEMPT;
  if (!sha || !runId || !runAttemptText || !POSITIVE_INTEGER_PATTERN.test(runAttemptText)) {
    throw new Error("--sha, --run-id, and --run-attempt (or their GitHub environment variables) are required");
  }
  const receipt = await validateBrowserEvidence(root, {
    expectedSha: sha,
    expectedRun: { id: runId, attempt: Number(runAttemptText) },
    allowedWorkspacePath: Bun.env.GITHUB_WORKSPACE,
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`Browser evidence validation failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}
