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

const confidentialProject = ["GR", "OW"].join("");
const confidentialSpace = ["R", "CM"].join("");
const privateTenantHost = ["mayflower", "gmbh", ".atlassian.net"].join("");
const privateAccountId = [
  "70121:666cbd78",
  "-32fa-4764-90a1-",
  "d3368305f07b",
].join("");
const privateCloudId = [
  "ca7c5cc9-632e-",
  "4985-b88e-",
  "fb2a96c0b9ca",
].join("");

const textRules: readonly { rule: string; pattern: RegExp }[] = [
  {
    rule: "confidential-atlassian-scope",
    pattern: new RegExp(`\\b(?:${confidentialProject}|${confidentialSpace})\\b`, "u"),
  },
  {
    rule: "private-atlassian-tenant",
    pattern: new RegExp(privateTenantHost.replaceAll(".", "\\."), "iu"),
  },
  {
    rule: "private-atlassian-account-id",
    pattern: new RegExp(privateAccountId, "u"),
  },
  {
    rule: "private-atlassian-cloud-id",
    pattern: new RegExp(privateCloudId, "iu"),
  },
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
): ResearchPrivacyViolation[] {
  const violations: ResearchPrivacyViolation[] = [];
  for (const file of files) {
    const unsafePath = pathRule(file.path);
    if (unsafePath) violations.push({ path: file.path, rule: unsafePath });
    if (file.binary) continue;
    for (const { rule, pattern } of textRules) {
      if (pattern.test(file.content)) violations.push({ path: file.path, rule });
    }
  }
  return violations.sort((left, right) =>
    left.path.localeCompare(right.path) || left.rule.localeCompare(right.rule)
  );
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
  const violations = findResearchPrivacyViolations(await trackedFiles(repoRoot));
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
