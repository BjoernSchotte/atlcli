#!/usr/bin/env bun
/**
 * Release script for atlcli.
 *
 * Usage:
 *   bun scripts/release.ts patch          # 0.16.0 → 0.16.1
 *   bun scripts/release.ts minor          # 0.16.0 → 0.17.0
 *   bun scripts/release.ts major          # 0.16.0 → 1.0.0
 *   bun scripts/release.ts minor --dry-run   # Print the release plan (no changes)
 *   bun scripts/release.ts minor --preview   # Render the changelog entry (no changes)
 *   bun scripts/release.ts --skip-tests   # Skip test step
 */

import { $ } from "bun";
import { readFile, writeFile } from "node:fs/promises";

const REPO_OWNER = "BjoernSchotte";
const REPO_NAME = "atlcli";
const HOMEBREW_TAP = "bjoernschotte/homebrew-tap";
const TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-x64"];

function assetNameFor(target: string): string {
  const ext = target.startsWith("windows-") ? "zip" : "tar.gz";
  return `atlcli-${target}.${ext}`;
}

interface Args {
  type: "patch" | "minor" | "major";
  dryRun: boolean;
  skipTests: boolean;
  preview: boolean;
}

interface ContributorInfo {
  login: string;
  name: string;
  prNumber: number;
  prTitle: string;
}

/** A contributor or reporter to credit in the changelog's "Thanks" section. */
interface Acknowledgment {
  login: string;
  /** PR numbers authored, or issue numbers reported. */
  numbers: number[];
}

interface ReleaseAcknowledgments {
  prContributors: Acknowledgment[];
  issueReporters: Acknowledgment[];
}

export interface ReleaseState {
  startingHead: string;
  filesMutated: boolean;
  commitCreated: boolean;
  releaseCommit: string | null;
  tagCreated: boolean;
  mainPushed: boolean;
  tagPushed: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    type: "patch",
    dryRun: false,
    skipTests: false,
    preview: false,
  };

  for (const arg of argv) {
    if (arg === "patch" || arg === "minor" || arg === "major") {
      args.type = arg;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--preview") {
      args.preview = true;
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
  patch          Bump patch version (0.16.0 → 0.16.1) [default]
  minor          Bump minor version (0.16.0 → 0.17.0)
  major          Bump major version (0.16.0 → 1.0.0)

Options:
  --dry-run      Print the release plan and exit (no changes made)
  --preview      Render the changelog entry (incl. Thanks section) and exit
  --skip-tests   Skip running tests before release
  --help, -h     Show this help message

Examples:
  bun scripts/release.ts patch
  bun scripts/release.ts minor --dry-run
  bun scripts/release.ts minor --preview
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

async function generateChangelog(
  newVersion: string,
  changelogPath = "CHANGELOG.md",
): Promise<void> {
  console.log("Generating changelog...");
  await $`bunx git-cliff --tag v${newVersion} -o ${changelogPath}`;
  console.log(`  ${changelogPath} updated`);
}

async function getPreviousTag(): Promise<string> {
  const tag = await $`git describe --tags --abbrev=0 HEAD`.text();
  return tag.trim();
}

/**
 * Extracts the numbers of PRs merged since `previousTag`. Catches both squashed
 * commits (`... (#12)`) and merge commits (`Merge pull request #12`).
 */
async function getMergedPrNumbers(previousTag: string): Promise<number[]> {
  const log = await $`git log ${previousTag}..HEAD --oneline`.text();
  const numbers = new Set<number>();
  for (const m of log.matchAll(/\(#(\d+)\)/g)) numbers.add(Number(m[1]));
  for (const m of log.matchAll(/Merge pull request #(\d+)/g)) numbers.add(Number(m[1]));
  return [...numbers].sort((a, b) => a - b);
}

async function findNewContributors(previousTag: string): Promise<ContributorInfo[]> {
  const prNumbers = await getMergedPrNumbers(previousTag);
  if (prNumbers.length === 0) return [];

  // A contributor is "new" if every merged PR they have authored falls within
  // this release. Checking PR membership (rather than comparing merge dates to
  // the tag date) avoids same-day boundary errors where a prior PR merged on
  // the exact day of the previous tag would be missed.
  const releasePrs = new Set(prNumbers);
  const seen = new Set<string>();
  const contributors: ContributorInfo[] = [];

  for (const prNumber of prNumbers) {
    try {
      const prData = await $`gh pr view ${prNumber} --json author,title`.json();
      const pr = prData as { author: { login: string; name?: string }; title: string };
      const login = pr.author.login;

      if (login === REPO_OWNER || seen.has(login)) continue;
      seen.add(login);

      const allMergedRaw =
        await $`gh pr list --state merged --author ${login} --limit 100 --json number`.json();
      const allMerged = (allMergedRaw as { number: number }[]).map((p) => p.number);
      const hasPriorPR = allMerged.some((n) => !releasePrs.has(n));

      if (!hasPriorPR) {
        contributors.push({
          login,
          name: pr.author.name || login,
          prNumber,
          prTitle: pr.title,
        });
      }
    } catch {
      // Skip PRs that can't be fetched (e.g., from forks that were deleted)
      console.log(`  Warning: Could not fetch PR #${prNumber}, skipping`);
    }
  }

  return contributors;
}

/**
 * Inserts a section before `heading`, normalizing whitespace to exactly one
 * blank line on each side so repeated insertions (New Contributors, then
 * Thanks) do not accumulate blank lines. Returns null if the heading is absent.
 */
function insertBeforeHeading(
  changelog: string,
  heading: string,
  sectionLines: string[],
): string | null {
  const idx = changelog.indexOf(heading);
  if (idx === -1) return null;

  const before = changelog.slice(0, idx).replace(/\n+$/, "\n");
  const section = sectionLines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  return `${before}\n${section}\n\n${changelog.slice(idx)}`;
}

async function injectNewContributors(
  newVersion: string,
  changelogPath = "CHANGELOG.md",
): Promise<void> {
  let previousTag: string;
  try {
    previousTag = await getPreviousTag();
  } catch {
    console.log("  No previous tag found, skipping contributor detection");
    return;
  }

  const contributors = await findNewContributors(previousTag);

  if (contributors.length === 0) {
    console.log("  No new contributors found");
    return;
  }

  console.log(`  Found ${contributors.length} new contributor(s)`);

  const lines = [
    "",
    "### New Contributors",
    "",
    ...contributors.map(
      (c) =>
        `- [@${c.login}](https://github.com/${c.login})${c.name !== c.login ? ` (${c.name})` : ""} - ${c.prTitle} (#${c.prNumber})`,
    ),
  ];

  const changelog = await readFile(changelogPath, "utf8");
  const heading = `## [${previousTag.replace(/^v/, "")}]`;
  const updated = insertBeforeHeading(changelog, heading, lines);

  if (updated === null) {
    console.log(`  Warning: Could not find "${heading}" in ${changelogPath}, skipping injection`);
    return;
  }

  await writeFile(changelogPath, updated);
  console.log("  New Contributors section added");
}

/** Regex matching GitHub issue-closing keywords (fixes #4, closes #12, …). */
const CLOSING_KEYWORD_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;

/**
 * Collects everyone worth thanking for a release: authors of PRs merged since
 * `previousTag`, and reporters of the issues those PRs closed. The repo owner
 * is excluded from both lists (you don't thank yourself), but issues the owner's
 * own PRs closed are still credited to whoever reported them.
 */
async function findReleaseAcknowledgments(previousTag: string): Promise<ReleaseAcknowledgments> {
  const prNumbers = await getMergedPrNumbers(previousTag);

  const prByLogin = new Map<string, Set<number>>();
  const issueByLogin = new Map<string, Set<number>>();
  const seenIssues = new Set<number>();

  for (const prNumber of prNumbers) {
    let pr: { author: { login: string }; body: string | null };
    try {
      pr = await $`gh pr view ${prNumber} --json author,body`.json();
    } catch {
      console.log(`  Warning: Could not fetch PR #${prNumber}, skipping`);
      continue;
    }

    const login = pr.author?.login;
    if (login && login !== REPO_OWNER) {
      const set = prByLogin.get(login) ?? new Set<number>();
      set.add(prNumber);
      prByLogin.set(login, set);
    }

    // Credit reporters of the issues this PR closed.
    for (const m of (pr.body ?? "").matchAll(CLOSING_KEYWORD_RE)) {
      const issueNumber = Number(m[1]);
      if (issueNumber === prNumber || seenIssues.has(issueNumber)) continue;
      seenIssues.add(issueNumber);
      try {
        const issue = (await $`gh issue view ${issueNumber} --json author`.json()) as {
          author: { login: string };
        };
        const reporter = issue.author?.login;
        if (reporter && reporter !== REPO_OWNER) {
          const set = issueByLogin.get(reporter) ?? new Set<number>();
          set.add(issueNumber);
          issueByLogin.set(reporter, set);
        }
      } catch {
        console.log(`  Warning: Could not fetch issue #${issueNumber}, skipping`);
      }
    }
  }

  const toSortedList = (map: Map<string, Set<number>>): Acknowledgment[] =>
    [...map.entries()]
      .map(([login, nums]) => ({ login, numbers: [...nums].sort((a, b) => a - b) }))
      .sort((a, b) => a.login.localeCompare(b.login));

  return {
    prContributors: toSortedList(prByLogin),
    issueReporters: toSortedList(issueByLogin),
  };
}

/**
 * Adds a "Thanks" section to the new release's changelog entry, crediting PR
 * contributors and issue reporters. Inserted directly before the previous
 * version's heading, so it lands under the new version.
 */
async function injectThanks(_newVersion: string, changelogPath = "CHANGELOG.md"): Promise<void> {
  let previousTag: string;
  try {
    previousTag = await getPreviousTag();
  } catch {
    console.log("  No previous tag found, skipping thanks section");
    return;
  }

  const { prContributors, issueReporters } = await findReleaseAcknowledgments(previousTag);

  if (prContributors.length === 0 && issueReporters.length === 0) {
    console.log("  No external contributors or reporters to thank");
    return;
  }

  const refs = (nums: number[]) => nums.map((n) => `#${n}`).join(", ");
  const entries = [
    ...prContributors.map(
      (c) =>
        `- [@${c.login}](https://github.com/${c.login}) — ${c.numbers.length > 1 ? "PRs" : "PR"} ${refs(c.numbers)}`,
    ),
    ...issueReporters.map(
      (r) =>
        `- [@${r.login}](https://github.com/${r.login}) — reported ${r.numbers.length > 1 ? "issues" : "issue"} ${refs(r.numbers)}`,
    ),
  ];

  const lines = [
    "",
    "### Thanks",
    "",
    "A big thank you to everyone who helped shape this release 🙏",
    "",
    ...entries,
  ];

  const changelog = await readFile(changelogPath, "utf8");
  const heading = `## [${previousTag.replace(/^v/, "")}]`;
  const updated = insertBeforeHeading(changelog, heading, lines);

  if (updated === null) {
    console.log(`  Warning: Could not find "${heading}" in ${changelogPath}, skipping injection`);
    return;
  }

  await writeFile(changelogPath, updated);
  console.log(
    `  Thanks section added (${prContributors.length} contributor(s), ${issueReporters.length} reporter(s))`,
  );
}

/**
 * Renders the changelog entry for `newVersion` to a temp file — including the
 * New Contributors and Thanks sections — and prints just that entry. Touches
 * neither CHANGELOG.md nor git, so it is safe to run anytime.
 */
async function previewChangelog(newVersion: string): Promise<void> {
  const previewPath = `${(await $`mktemp`.text()).trim()}`;
  try {
    console.log(`\nRendering changelog entry for v${newVersion}...\n`);
    await generateChangelog(newVersion, previewPath);
    await injectNewContributors(newVersion, previewPath);
    await injectThanks(newVersion, previewPath);

    const full = await readFile(previewPath, "utf8");
    const start = full.indexOf(`## [${newVersion}]`);
    let previousTag = "";
    try {
      previousTag = await getPreviousTag();
    } catch {
      /* no previous tag — print to end */
    }
    const end = previousTag
      ? full.indexOf(`## [${previousTag.replace(/^v/, "")}]`)
      : full.length;

    const entry =
      start === -1 ? full : full.slice(start, end > start ? end : full.length).trimEnd();
    const rule = "─".repeat(70);
    console.log(`\n${rule}\n${entry}\n${rule}`);
    console.log("\nPREVIEW ONLY — CHANGELOG.md and git are untouched.");
  } finally {
    await $`rm -f ${previewPath}`.quiet();
  }
}

async function commitRelease(newVersion: string): Promise<string> {
  console.log("Creating release commit...");
  await $`git add package.json CHANGELOG.md`;
  await $`git commit -m ${"chore(release): v" + newVersion}`;
  console.log("  Commit created");
  return (await $`git rev-parse HEAD`.text()).trim();
}

async function createTag(newVersion: string): Promise<void> {
  console.log(`Creating tag v${newVersion}...`);
  await $`git tag -a v${newVersion} -m ${"Release v" + newVersion}`;
  console.log("  Tag created");
}

async function pushRelease(newVersion: string, state: ReleaseState): Promise<void> {
  console.log("Pushing to origin...");
  await $`git push origin main`;
  state.mainPushed = true;
  await $`git push origin ${`v${newVersion}`}`;
  state.tagPushed = true;
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
      const expected = TARGETS.map(assetNameFor);

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
  await $`gh workflow run update-formula.yml --repo ${HOMEBREW_TAP} -f formula=atlcli -f tag=v${newVersion} -f repository=${REPO_OWNER}/${REPO_NAME}`;
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
  4. Add "New Contributors" + "Thanks" sections to CHANGELOG.md (via GitHub API)
  5. Commit: git commit -m "chore(release): v${newVersion}"
  6. Tag: git tag v${newVersion}
  7. Push: git push origin main && git push origin v${newVersion}
  8. Wait for GitHub Actions to build release artifacts
  9. Update Homebrew: gh workflow run update-formula.yml --repo ${HOMEBREW_TAP} \\
       -f formula=atlcli -f tag=v${newVersion} -f repository=${REPO_OWNER}/${REPO_NAME}

To execute this release, run without --dry-run:
  bun scripts/release.ts ${newVersion.endsWith(".0.0") ? "major" : newVersion.endsWith(".0") ? "minor" : "patch"}
`);
}

export async function rollback(
  newVersion: string,
  state: ReleaseState,
  cwd = process.cwd(),
): Promise<void> {
  if (!state.filesMutated && !state.commitCreated && !state.tagCreated) {
    console.log("No local release changes to roll back");
    return;
  }

  if (state.mainPushed || state.tagPushed) {
    console.log(
      "Release changes were pushed; automatic rollback skipped to avoid diverging from origin.",
    );
    console.log(`Inspect origin/main and tag v${newVersion} before recovering manually.`);
    return;
  }

  console.log("Rolling back...");

  if (state.tagCreated) {
    await $`git -C ${cwd} tag -d ${`v${newVersion}`}`.quiet();
  }

  if (state.commitCreated) {
    const currentHead = (await $`git -C ${cwd} rev-parse HEAD`.text()).trim();
    if (!state.releaseCommit || currentHead !== state.releaseCommit) {
      throw new Error(
        "Refusing rollback because HEAD no longer points to the release commit.",
      );
    }
    await $`git -C ${cwd} reset --mixed ${state.startingHead}`.quiet();
  }

  if (state.filesMutated) {
    await $`git -C ${cwd} restore --source ${state.startingHead} --staged --worktree -- package.json CHANGELOG.md`.quiet();
  }

  console.log("Rollback complete");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let newVersion = "";
  const state: ReleaseState = {
    startingHead: "",
    filesMutated: false,
    commitCreated: false,
    releaseCommit: null,
    tagCreated: false,
    mainPushed: false,
    tagPushed: false,
  };

  try {
    // 1. Validate environment
    await validateEnvironment(args.dryRun);
    state.startingHead = (await $`git rev-parse HEAD`.text()).trim();

    // 2. Calculate new version
    const currentVersion = await getCurrentVersion();
    newVersion = bumpVersion(currentVersion, args.type);

    // DRY RUN: Just show the plan and exit
    if (args.dryRun) {
      showDryRunPlan(currentVersion, newVersion, args.skipTests);
      return;
    }

    // PREVIEW: Render the changelog entry (incl. Thanks section) and exit
    if (args.preview) {
      await previewChangelog(newVersion);
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
    state.filesMutated = true;
    await updateVersion(newVersion);

    // 5. Generate changelog
    await generateChangelog(newVersion);

    // 5b. Detect and inject new contributors
    console.log("Checking for new contributors...");
    await injectNewContributors(newVersion);

    // 5c. Thank PR contributors and issue reporters
    console.log("Collecting contributors to thank...");
    await injectThanks(newVersion);

    // 6. Commit changes
    state.releaseCommit = await commitRelease(newVersion);
    state.commitCreated = true;

    // 7. Create tag
    await createTag(newVersion);
    state.tagCreated = true;

    // 8. Push to origin
    await pushRelease(newVersion, state);

    // 9. Wait for GitHub release artifacts
    await waitForRelease(newVersion);

    // 10. Update Homebrew tap
    await updateHomebrew(newVersion);

    console.log(`\nRelease v${newVersion} complete!`);
  } catch (error) {
    console.error(`\nError: ${error instanceof Error ? error.message : error}`);

    // Roll back only mutations made locally and never rewrite published state.
    if (newVersion && state.filesMutated) {
      console.log("\nAttempting rollback...");
      await rollback(newVersion, state);
    }

    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
