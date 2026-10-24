#!/usr/bin/env bun
/**
 * Lets the stable release reuse CI's proof of an earlier commit.
 *
 * A release tag points at the release merge commit, which differs from the
 * main commit CI already proved only by the version field in package.json and
 * the new CHANGELOG entry. Re-running the whole quality suite on it proves the
 * same code a second time. This finds a nearby ancestor whose CI is green and
 * whose tree differs from the tag only in that way; the release workflow then
 * skips the duplicate suite. The exact-SHA security attestation, the artifact
 * builds and the consumer smoke tests still run on the tag itself.
 *
 *   bun scripts/ci/release-proof-reuse.ts --sha <tag sha>
 *
 * Prints `reuse=true|false` and `proven_sha=<sha>` lines (for $GITHUB_OUTPUT)
 * and explains its decision on stderr. Any doubt means `reuse=false`.
 */
import { $ } from "bun";
import { ciProvedCommit, type CheckRun } from "../release.js";

/** Files a release commit may change without new proof. */
const RELEASE_ONLY_FILES = new Set(["package.json", "CHANGELOG.md"]);

/**
 * Whether going from a proven tree to the release tree changes nothing but
 * the release bookkeeping: CHANGELOG.md, and the root package.json `version`.
 */
export function onlyReleaseBookkeeping(
  changedFiles: readonly string[],
  packageBefore: string | undefined,
  packageAfter: string | undefined,
): boolean {
  if (!changedFiles.every((file) => RELEASE_ONLY_FILES.has(file))) return false;
  if (!changedFiles.includes("package.json")) return true;
  if (packageBefore === undefined || packageAfter === undefined) return false;
  try {
    const { version: _before, ...before } = JSON.parse(packageBefore) as Record<string, unknown>;
    const { version: _after, ...after } = JSON.parse(packageAfter) as Record<string, unknown>;
    return JSON.stringify(before) === JSON.stringify(after);
  } catch {
    return false;
  }
}

/** Parents and grandparents: the pre-merge main head, the release PR head, a direct release commit's parent. */
async function candidates(sha: string): Promise<string[]> {
  const parents = async (commit: string) => (await $`git rev-list --parents -n 1 ${commit}`.text()).trim().split(/\s+/).slice(1);
  const first = await parents(sha);
  const second = (await Promise.all(first.map(parents))).flat();
  return [...new Set([...first, ...second])];
}

async function show(commit: string, file: string): Promise<string | undefined> {
  const result = await $`git show ${`${commit}:${file}`}`.quiet().nothrow();
  return result.exitCode === 0 ? result.stdout.toString() : undefined;
}

/**
 * The preflight runs typecheck, build, the Bun test inventory and the Astro
 * platform lane; a reusable proof must cover all of them, green and complete.
 */
export function provesPreflight(runs: readonly CheckRun[]): boolean {
  return ciProvedCommit(runs) && runs.some((run) => run.name.startsWith("Product quality / Astro platform") && run.conclusion === "success");
}

async function checkRuns(repository: string, commit: string): Promise<CheckRun[]> {
  return (await $`gh api ${`repos/${repository}/commits/${commit}/check-runs?per_page=100`} --jq .check_runs`.json()) as CheckRun[];
}

async function main(): Promise<void> {
  const index = process.argv.indexOf("--sha");
  const sha = index > 0 ? process.argv[index + 1] : undefined;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!sha || !/^[0-9a-f]{40}$/.test(sha) || !repository) {
    throw new Error("usage: GITHUB_REPOSITORY=owner/repo release-proof-reuse.ts --sha <40-hex sha>");
  }
  for (const candidate of await candidates(sha)) {
    const changed = (await $`git diff --name-only ${candidate} ${sha}`.text()).split("\n").filter(Boolean);
    if (!onlyReleaseBookkeeping(changed, await show(candidate, "package.json"), await show(sha, "package.json"))) {
      console.error(`${candidate.slice(0, 8)}: differs beyond the release bookkeeping (${changed.join(", ") || "nothing"})`);
      continue;
    }
    if (!provesPreflight(await checkRuns(repository, candidate))) {
      console.error(`${candidate.slice(0, 8)}: CI has not proved it (missing, running, failed or partial checks)`);
      continue;
    }
    const delta = changed.length ? `differs only in ${changed.join(" and ")}` : "has the same tree";
    console.error(`${candidate.slice(0, 8)}: proved by CI and ${delta}; reusing its proof`);
    console.log(`reuse=true\nproven_sha=${candidate}`);
    return;
  }
  console.error("No proved ancestor found; the release runs the full quality suite");
  console.log("reuse=false\nproven_sha=");
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    // Fail open to the full suite, never to a skipped one.
    console.error(`Proof reuse unavailable: ${error instanceof Error ? error.message : String(error)}`);
    console.log("reuse=false\nproven_sha=");
  });
}
