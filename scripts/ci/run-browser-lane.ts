#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { writeBrowserEvidenceManifest } from "./validate-browser-evidence.js";

export type BrowserSuite =
  | "neutral"
  | "palette"
  | "research"
  | "worker"
  | "rovo"
  | "jobs";

export type BrowserLane = "neutral-palette" | "research-worker-rovo" | "jobs";

export interface BrowserLaneTask {
  id: string;
  suite: BrowserSuite;
  command: readonly string[];
  producesEvidence?: boolean;
  requiresPreviousSuccess?: boolean;
}

export const BROWSER_LANES: Readonly<Record<BrowserLane, readonly BrowserLaneTask[]>> = {
  "neutral-palette": [
    {
      id: "neutral-harness",
      suite: "neutral",
      command: [
        "bun",
        "run",
        "--cwd",
        "apps/browser-export-harness",
        "test:e2e:prebuilt",
      ],
      producesEvidence: true,
    },
    {
      id: "shape-parity",
      suite: "neutral",
      command: [
        "bun",
        "run",
        "--cwd",
        "apps/browser-export-harness",
        "check:parity:prebuilt",
      ],
      requiresPreviousSuccess: true,
    },
    {
      id: "palette",
      suite: "palette",
      command: [
        "bun",
        "run",
        "--cwd",
        "apps/extension",
        "test:palette-extension-browser:prebuilt",
      ],
      producesEvidence: true,
    },
  ],
  "research-worker-rovo": [
    {
      id: "research",
      suite: "research",
      command: [
        "bun",
        "run",
        "--cwd",
        "apps/extension",
        "test:research-extension-browser:prebuilt",
      ],
      producesEvidence: true,
    },
    {
      id: "worker",
      suite: "worker",
      command: [
        "bun",
        "run",
        "--cwd",
        "apps/extension",
        "test:worker-extension-browser:prebuilt",
      ],
      producesEvidence: true,
    },
    {
      id: "rovo",
      suite: "rovo",
      command: [
        "bun",
        "run",
        "--cwd",
        "apps/extension",
        "test:rovo-extension-browser:prebuilt",
      ],
      producesEvidence: true,
    },
  ],
  jobs: [
    {
      id: "jobs",
      suite: "jobs",
      command: [
        "bun",
        "run",
        "--cwd",
        "apps/extension",
        "test:jobs-extension-browser:prebuilt",
      ],
      producesEvidence: true,
    },
  ],
};

export function parseBrowserLane(value: string | undefined): BrowserLane {
  if (value && Object.hasOwn(BROWSER_LANES, value)) return value as BrowserLane;
  throw new Error(
    `unknown browser lane: ${value ?? "<missing>"}; expected ${Object.keys(BROWSER_LANES).join(", ")}`,
  );
}

export function suiteEvidenceDirectory(root: string, suite: BrowserSuite): string {
  if (!root.trim()) throw new Error("ATLCLI_BROWSER_EVIDENCE_ROOT is required");
  return resolve(root, suite);
}

function regularFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new Error("symbolic links are forbidden in Playwright evidence");
    }
    if (stat.isDirectory()) files.push(...regularFiles(path));
    else if (stat.isFile()) files.push(path);
    else throw new Error("unsupported filesystem entry in Playwright evidence");
  }
  return files.sort();
}

export function normalizePlaywrightFailureEvidence(suiteDirectory: string): void {
  const rawRoot = join(suiteDirectory, ".playwright");
  const counters = new Map<string, number>();
  for (const source of regularFiles(rawRoot)) {
    if (relative(rawRoot, source) === ".last-run.json") {
      rmSync(source, { force: true });
      continue;
    }
    const extension = extname(source).toLowerCase();
    const kind = extension === ".zip" ? "trace"
      : extension === ".png" ? "screenshot"
      : extension === ".webm" ? "video"
      : extension === ".md" || extension === ".txt" ? "details"
      : undefined;
    if (!kind) throw new Error(`unsupported Playwright evidence type: ${extension || "<none>"}`);
    const sourceParent = relative(rawRoot, dirname(source)) || "root";
    const opaqueId = createHash("sha256").update(sourceParent).digest("hex").slice(0, 20);
    const key = `${opaqueId}:${kind}`;
    const index = (counters.get(key) ?? 0) + 1;
    counters.set(key, index);
    const targetDirectory = join(suiteDirectory, "failures", opaqueId);
    mkdirSync(targetDirectory, { recursive: true });
    const targetExtension = kind === "trace" ? ".zip"
      : kind === "screenshot" ? ".png"
      : kind === "video" ? ".webm"
      : ".txt";
    renameSync(source, join(targetDirectory, `${kind}-${index}${targetExtension}`));
  }
  rmSync(rawRoot, { recursive: true, force: true });
}

export function discardPassedBrowserFailureEvidence(suiteDirectory: string): void {
  rmSync(join(suiteDirectory, "failures"), { recursive: true, force: true });
}

async function runLane(lane: BrowserLane, evidenceRoot: string): Promise<number> {
  let failed = false;
  for (const task of BROWSER_LANES[lane]) {
    if (task.requiresPreviousSuccess && failed) {
      console.error(`::notice::Skipping ${task.id} because its prerequisite failed`);
      continue;
    }
    const suiteDirectory = suiteEvidenceDirectory(evidenceRoot, task.suite);
    if (task.producesEvidence) rmSync(suiteDirectory, { recursive: true, force: true });
    console.log(`::notice::Starting browser suite ${task.id}`);
    const child = Bun.spawn([...task.command], {
      cwd: resolve(import.meta.dir, "../.."),
      env: {
        ...process.env,
        ATLCLI_BROWSER_EVIDENCE_DIR: suiteDirectory,
        ATLCLI_BROWSER_EVIDENCE_SUITE: task.suite,
      },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    console.log(`::notice::Browser suite ${task.id} exited with code ${exitCode}`);
    if (exitCode !== 0) {
      failed = true;
      console.error(`::error::Browser suite ${task.id} exited with code ${exitCode}`);
    }
    if (task.producesEvidence) {
      try {
        if (task.suite === "neutral") normalizePlaywrightFailureEvidence(suiteDirectory);
        if (exitCode === 0) discardPassedBrowserFailureEvidence(suiteDirectory);
        mkdirSync(suiteDirectory, { recursive: true });
        writeFileSync(
          resolve(suiteDirectory, "summary.json"),
          `${JSON.stringify({
            schema: "atlcli.browser-evidence-summary/v1",
            suite: task.suite,
            status: exitCode === 0 ? "passed" : "failed",
            exitCode,
          }, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        await writeBrowserEvidenceManifest(suiteDirectory, {
          evidenceClass: "synthetic",
          suite: task.suite,
          sha: await evidenceSha(),
          run: evidenceRun(),
          status: exitCode === 0 ? "passed" : "failed",
        });
      } catch (error) {
        failed = true;
        console.error(
          `::error::Browser evidence finalization failed for ${task.suite}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
  return failed ? 1 : 0;
}

async function evidenceSha(): Promise<string> {
  const configured = process.env.GITHUB_SHA?.trim();
  if (configured) return configured;
  const child = Bun.spawn(["git", "rev-parse", "HEAD"], {
    cwd: resolve(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`could not resolve local Git SHA: ${error.trim()}`);
  return output.trim();
}

function evidenceRun(): { id: string; attempt: number } {
  const id = process.env.GITHUB_RUN_ID?.trim() || "1";
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT ?? "1");
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("GITHUB_RUN_ATTEMPT must be a positive integer");
  }
  return { id, attempt };
}

async function main(): Promise<void> {
  const lane = parseBrowserLane(process.argv[2]);
  const evidenceRoot = process.env.ATLCLI_BROWSER_EVIDENCE_ROOT;
  if (!evidenceRoot) throw new Error("ATLCLI_BROWSER_EVIDENCE_ROOT is required");
  process.exitCode = await runLane(lane, evidenceRoot);
}

if (import.meta.main) await main();
