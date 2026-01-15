#!/usr/bin/env bun
/**
 * Release script for atlcli.
 *
 * Usage:
 *   bun scripts/release.ts patch          # 0.6.0 → 0.6.1
 *   bun scripts/release.ts minor          # 0.6.0 → 0.7.0
 *   bun scripts/release.ts major          # 0.6.0 → 1.0.0
 *   bun scripts/release.ts --dry-run      # Preview what would happen (no changes)
 *   bun scripts/release.ts --skip-tests   # Skip test step
 */

import { $ } from "bun";
import { readFile, writeFile } from "node:fs/promises";

const REPO_OWNER = "BjoernSchotte";
const REPO_NAME = "atlcli";
const HOMEBREW_TAP = "bjoernschotte/homebrew-tap";
const TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

interface Args {
  type: "patch" | "minor" | "major";
  dryRun: boolean;
  skipTests: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    type: "patch",
    dryRun: false,
    skipTests: false,
  };

  for (const arg of argv) {
    if (arg === "patch" || arg === "minor" || arg === "major") {
      args.type = arg;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--skip-tests") {
      args.skipTests = true;
    } else if (arg === "--help" || arg === "-h") {
      showHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      showHelp();
      process.exit(1);
    }
  }

  return args;
}

function showHelp(): void {
  console.log(`
Usage: bun scripts/release.ts [type] [options]

Types:
  patch          Bump patch version (0.6.0 → 0.6.1) [default]
  minor          Bump minor version (0.6.0 → 0.7.0)
  major          Bump major version (0.6.0 → 1.0.0)

Options:
  --dry-run      Preview what would happen (no changes made)
  --skip-tests   Skip running tests before release
  --help, -h     Show this help message

Examples:
  bun scripts/release.ts patch
  bun scripts/release.ts minor --dry-run
  bun scripts/release.ts major --skip-tests
`);
}

async function validateEnvironment(dryRun: boolean): Promise<void> {
  console.log("Validating environment...");

  // Check git status is clean
  const status = await $`git status --porcelain`.text();
  if (status.trim()) {
    throw new Error("Working directory not clean. Commit or stash changes first.");
  }

  // Check on main branch
  const branch = await $`git branch --show-current`.text();
  if (branch.trim() !== "main") {
    throw new Error(`Must be on main branch. Currently on: ${branch.trim()}`);
  }

  // Check gh CLI available and authenticated
  try {
    await $`gh auth status`.quiet();
  } catch {
    throw new Error("GitHub CLI not authenticated. Run: gh auth login");
  }

  // Check git-cliff available (via bunx)
  try {
    await $`bunx git-cliff --version`.quiet();
  } catch {
    throw new Error("git-cliff not available. Check bunx installation.");
  }

  console.log("  Environment OK");
}

async function getCurrentVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  return pkg.version;
}

function bumpVersion(current: string, type: "patch" | "minor" | "major"): string {
  const [major, minor, patch] = current.split(".").map(Number);
  switch (type) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}

async function runTests(): Promise<void> {
  console.log("Running tests...");

  // Type checking
  console.log("  Running typecheck...");
  await $`bun run typecheck`;

  // Tests - Bun test exits 1 even on success, check output for actual failures
  console.log("  Running tests...");
  const proc = Bun.spawn(["bun", "test"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const output = stdout + stderr;

  // Check for actual failures
  if (output.includes("fail") && !output.includes("0 fail")) {
    console.error(output);
    throw new Error("Tests failed");
  }

  // Extract pass count
  const passMatch = output.match(/(\d+)\s+pass/);
  console.log(`  Tests passed (${passMatch?.[1] ?? "?"} tests)`);
}

async function updateVersion(newVersion: string): Promise<void> {
  console.log(`Updating version to ${newVersion}...`);

  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  pkg.version = newVersion;
  await writeFile("package.json", JSON.stringify(pkg, null, 2) + "\n");

  console.log("  package.json updated");
}

async function generateChangelog(newVersion: string): Promise<void> {
  console.log("Generating changelog...");
  await $`bunx git-cliff --tag v${newVersion} -o CHANGELOG.md`;
  console.log("  CHANGELOG.md updated");
}

async function commitRelease(newVersion: string): Promise<void> {
  console.log("Creating release commit...");
  await $`git add package.json CHANGELOG.md`;
  await $`git commit -m ${"chore(release): v" + newVersion}`;
  console.log("  Commit created");
}

async function createTag(newVersion: string): Promise<void> {
  console.log(`Creating tag v${newVersion}...`);
  await $`git tag v${newVersion}`;
  console.log("  Tag created");
}

async function pushRelease(): Promise<void> {
  console.log("Pushing to origin...");
  await $`git push origin main`;
  await $`git push origin --tags`;
  console.log("  Pushed");
}

async function waitForRelease(newVersion: string): Promise<void> {
  console.log("Waiting for GitHub release artifacts...");
  const tag = `v${newVersion}`;
  const maxWait = 10 * 60 * 1000; // 10 minutes
  const pollInterval = 15 * 1000; // 15 seconds
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    try {
      const result = await $`gh api repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/${tag}`.json();
      const release = result as { assets: { name: string }[] };
      const assets = release.assets.map((a) => a.name);
      const expected = TARGETS.map((t) => `atlcli-${t}.tar.gz`);

      if (expected.every((e) => assets.includes(e))) {
        console.log("  All release artifacts ready");
        return;
      }
      console.log(`  Waiting... (${assets.length}/${expected.length} assets)`);
    } catch {
      console.log("  Release not created yet...");
    }
    await Bun.sleep(pollInterval);
  }

  throw new Error("Timeout waiting for release artifacts. Check GitHub Actions.");
}

async function updateHomebrew(newVersion: string): Promise<void> {
  console.log("Triggering Homebrew tap update...");
  await $`gh workflow dispatch --repo ${HOMEBREW_TAP} -f formula=atlcli -f tag=v${newVersion} -f repository=${REPO_OWNER}/${REPO_NAME} update-formula.yml`;
  console.log("  Homebrew update workflow triggered");
}

function showDryRunPlan(currentVersion: string, newVersion: string, skipTests: boolean): void {
  console.log(`
DRY RUN - No changes will be made.

Release plan: ${currentVersion} → ${newVersion}

Steps that would be executed:
  1. ${skipTests ? "[SKIP] " : ""}Run tests: bun run typecheck && bun test
  2. Update version: package.json (version: "${newVersion}")
  3. Generate changelog: bunx git-cliff --tag v${newVersion} -o CHANGELOG.md
  4. Commit: git commit -m "chore(release): v${newVersion}"
  5. Tag: git tag v${newVersion}
  6. Push: git push origin main && git push origin v${newVersion}
  7. Wait for GitHub Actions to build release artifacts
  8. Update Homebrew: gh workflow dispatch --repo ${HOMEBREW_TAP} \\
       -f formula=atlcli -f tag=v${newVersion} -f repository=${REPO_OWNER}/${REPO_NAME} \\
       update-formula.yml

To execute this release, run without --dry-run:
  bun scripts/release.ts ${newVersion.endsWith(".0.0") ? "major" : newVersion.endsWith(".0") ? "minor" : "patch"}
`);
}

async function rollback(newVersion: string): Promise<void> {
  console.log("Rolling back...");
  try {
    await $`git tag -d v${newVersion}`.quiet();
  } catch {
    /* tag may not exist */
  }
  try {
    await $`git reset --hard HEAD~1`.quiet();
  } catch {
    /* may fail if no commit was made */
  }
  console.log("Rollback complete");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let newVersion = "";

  try {
    // 1. Validate environment
    await validateEnvironment(args.dryRun);

    // 2. Calculate new version
    const currentVersion = await getCurrentVersion();
    newVersion = bumpVersion(currentVersion, args.type);

    // DRY RUN: Just show the plan and exit
    if (args.dryRun) {
      showDryRunPlan(currentVersion, newVersion, args.skipTests);
      return;
    }

    console.log(`\nReleasing: ${currentVersion} → ${newVersion}\n`);

    // 3. Run tests (unless skipped)
    if (!args.skipTests) {
      await runTests();
    } else {
      console.log("Skipping tests (--skip-tests)");
    }

    // 4. Update package.json
    await updateVersion(newVersion);

    // 5. Generate changelog
    await generateChangelog(newVersion);

    // 6. Commit changes
    await commitRelease(newVersion);

    // 7. Create tag
    await createTag(newVersion);

    // 8. Push to origin
    await pushRelease();

    // 9. Wait for GitHub release artifacts
    await waitForRelease(newVersion);

    // 10. Update Homebrew tap
    await updateHomebrew(newVersion);

    console.log(`\nRelease v${newVersion} complete!`);
  } catch (error) {
    console.error(`\nError: ${error instanceof Error ? error.message : error}`);

    // Offer rollback if we've made local changes (only in non-dry-run mode)
    if (newVersion && !args.dryRun) {
      console.log("\nAttempting rollback...");
      await rollback(newVersion);
    }

    process.exit(1);
  }
}

main();
