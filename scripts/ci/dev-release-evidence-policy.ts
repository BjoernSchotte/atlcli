import type { ErrorObject } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const DEFAULT_EVIDENCE_ROOT = join(REPO_ROOT, "specs", "dev-release-channel");

const SENSITIVE_VALUE_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["private key material", /-----BEGIN [A-Z ]*PRIVATE KEY-----/i],
  [
    "GitHub token",
    new RegExp(String.raw`\b(?:gh[oprsu]_[A-Za-z0-9_]{20,}|github` + String.raw`_pat_[A-Za-z0-9_]{20,})\b`),
  ],
  ["authorization value", /\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)\s+\S+/i],
  ["bearer credential", /\bbearer\s+[A-Za-z0-9._~+\/-]{20,}={0,2}\b/i],
  ["macOS home path", /(?:^|[\s"'(])\/Users\/[A-Za-z0-9._-]+\//m],
  ["Linux home path", /(?:^|[\s"'(])\/home\/[A-Za-z0-9._-]+\//m],
  ["Windows home path", /\b[A-Za-z]:\\Users\\[^\\\s"']+\\/i],
  ["tenant host", /\b[A-Za-z0-9-]+\.atlassian\.net\b/i],
];

const FORBIDDEN_KEYS = new Set([
  "token",
  "accesstoken",
  "refreshtoken",
  "privatekey",
  "password",
  "secret",
  "authorization",
  "rawlog",
  "rawlogs",
  "stdout",
  "stderr",
  "sourcebody",
  "tenantid",
  "customerid",
  "email",
]);

export interface EvidencePolicyIssue {
  file: string;
  reason: string;
  location?: string;
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    }),
  );
  return nested.flat().sort();
}

function normalizedKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function scanJsonKeys(value: unknown, path = "$"): Array<{ key: string; path: string }> {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => scanJsonKeys(entry, `${path}[${index}]`));
  }
  if (value === null || typeof value !== "object") return [];

  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = `${path}.${key}`;
    const own = FORBIDDEN_KEYS.has(normalizedKey(key)) ? [{ key, path: childPath }] : [];
    return [...own, ...scanJsonKeys(child, childPath)];
  });
}

function ajvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || "$"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

export async function evaluateEvidencePolicy(root = DEFAULT_EVIDENCE_ROOT): Promise<EvidencePolicyIssue[]> {
  const allFiles = (await listFiles(root)).filter((path) => /\.(?:json|md)$/.test(path));
  const schemaPath = join(root, "evidence", "schemas", "task-proof.schema.json");
  const liveSchemaPath = join(root, "evidence", "schemas", "live-release-proof.schema.json");
  const schema = JSON.parse(await readFile(schemaPath, "utf8")) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validateTaskProof = ajv.compile(schema);
  const validateLiveProof = ajv.compile(JSON.parse(await readFile(liveSchemaPath, "utf8")) as object);
  const issues: EvidencePolicyIssue[] = [];

  for (const path of allFiles) {
    const file = relative(REPO_ROOT, path);
    const source = await readFile(path, "utf8");
    for (const [reason, pattern] of SENSITIVE_VALUE_PATTERNS) {
      if (pattern.test(source)) issues.push({ file, reason });
    }

    if (!path.endsWith(".json")) continue;
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch (error) {
      issues.push({ file, reason: `invalid JSON: ${String(error)}` });
      continue;
    }

    const isSchema = path.includes(`${join("evidence", "schemas")}/`);
    if (!isSchema) {
      for (const forbidden of scanJsonKeys(value)) {
        issues.push({
          file,
          reason: `forbidden evidence key '${forbidden.key}'`,
          location: forbidden.path,
        });
      }
    }

    if (/^DR-[0-9]{2}-.+\.json$/.test(basename(path)) && !validateTaskProof(value)) {
      issues.push({ file, reason: `task receipt schema: ${ajvErrors(validateTaskProof.errors)}` });
    }
    if (basename(path) === "live-release-proof.json" && !validateLiveProof(value)) {
      issues.push({ file, reason: `live receipt schema: ${ajvErrors(validateLiveProof.errors)}` });
    }
  }

  return issues;
}

async function main(): Promise<void> {
  const root = process.argv[2] ? join(process.cwd(), process.argv[2]!) : DEFAULT_EVIDENCE_ROOT;
  const issues = await evaluateEvidencePolicy(root);
  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(`${issue.file}${issue.location ? ` ${issue.location}` : ""}: ${issue.reason}`);
    }
    process.exit(1);
  }
  console.log(`Dev-release evidence policy passed: ${relative(REPO_ROOT, root) || "."}`);
}

if (import.meta.main) await main();
