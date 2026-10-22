import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSuccessfulExit,
  ciProvedCommit,
  createTag,
  RELEASE_TEST_COMMAND,
  parseArgs,
  pushRelease,
  rollback,
  showDryRunPlan,
  stableReleaseAssetsReady,
  stableReleasePublicationReady,
  type ReleaseState,
} from "./release";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // Isolate from host git config: options like tag.forceSignAnnotated or
      // commit.gpgSign would otherwise change plain `git tag`/`git commit`
      // behavior inside the fixture repo.
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(stderr.trim());
  return stdout.trim();
}

describe("release rollback", () => {
  let cwd: string;
  let startingHead: string;

  beforeEach(async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), "atlcli-release-test-")));
    await git(cwd, "init");
    await git(cwd, "branch", "-M", "main");
    await git(cwd, "config", "user.email", "release-test@example.com");
    await git(cwd, "config", "user.name", "Release Test");
    await writeFile(join(cwd, "package.json"), '{"version":"0.17.0"}\n');
    await writeFile(join(cwd, "CHANGELOG.md"), "# Changelog\n");
    await git(cwd, "add", "package.json", "CHANGELOG.md");
    await git(cwd, "commit", "-m", "initial");
    startingHead = await git(cwd, "rev-parse", "HEAD");
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function state(overrides: Partial<ReleaseState> = {}): ReleaseState {
    return {
      startingHead,
      filesMutated: false,
      commitCreated: false,
      releaseCommit: null,
      tagCreated: false,
      mainPushed: false,
      tagPushed: false,
      pushAttempted: false,
      ...overrides,
    };
  }

  test("does nothing when a failure happens before local mutations", async () => {
    await rollback("0.17.1", state(), cwd);

    expect(await git(cwd, "rev-parse", "HEAD")).toBe(startingHead);
    expect(await git(cwd, "status", "--porcelain")).toBe("");
  });

  test("restores staged release files without moving HEAD", async () => {
    await writeFile(join(cwd, "package.json"), '{"version":"0.17.1"}\n');
    await writeFile(join(cwd, "CHANGELOG.md"), "# Changelog\n\nrelease\n");
    await git(cwd, "add", "package.json", "CHANGELOG.md");

    await rollback("0.17.1", state({ filesMutated: true }), cwd);

    expect(await git(cwd, "rev-parse", "HEAD")).toBe(startingHead);
    expect(await git(cwd, "status", "--porcelain")).toBe("");
    expect(await readFile(join(cwd, "package.json"), "utf8")).toContain("0.17.0");
  });

  test("removes an unpushed release commit and tag", async () => {
    await writeFile(join(cwd, "package.json"), '{"version":"0.17.1"}\n');
    await git(cwd, "add", "package.json");
    await git(cwd, "commit", "-m", "chore(release): v0.17.1");
    const releaseCommit = await git(cwd, "rev-parse", "HEAD");
    await git(cwd, "tag", "v0.17.1");

    await rollback(
      "0.17.1",
      state({ filesMutated: true, commitCreated: true, releaseCommit, tagCreated: true }),
      cwd,
    );

    expect(await git(cwd, "rev-parse", "HEAD")).toBe(startingHead);
    expect(await git(cwd, "status", "--porcelain")).toBe("");
    expect(await git(cwd, "tag", "-l", "v0.17.1")).toBe("");
  });

  test("leaves published state untouched", async () => {
    await writeFile(join(cwd, "package.json"), '{"version":"0.17.1"}\n');
    await git(cwd, "add", "package.json");
    await git(cwd, "commit", "-m", "chore(release): v0.17.1");
    const releaseCommit = await git(cwd, "rev-parse", "HEAD");
    await git(cwd, "tag", "v0.17.1");

    await rollback(
      "0.17.1",
      state({
        filesMutated: true,
        commitCreated: true,
        releaseCommit,
        tagCreated: true,
        mainPushed: true,
      }),
      cwd,
    );

    expect(await git(cwd, "rev-parse", "HEAD")).toBe(releaseCommit);
    expect(await git(cwd, "tag", "-l", "v0.17.1")).toBe("v0.17.1");
  });

  test("pushes only the release tag after protected main has been merged", async () => {
    const remote = join(cwd, "remote.git");
    await git(cwd, "init", "--bare", remote);
    await git(cwd, "remote", "add", "origin", remote);
    await git(cwd, "push", "origin", "main");
    await git(cwd, "tag", "v2026.10.1");
    const releaseState = state({ releaseCommit: startingHead, mainPushed: true });
    await pushRelease("2026.10.1", releaseState, cwd);
    expect(await git(cwd, "--git-dir", remote, "rev-parse", "refs/heads/main")).toBe(startingHead);
    expect(await git(cwd, "--git-dir", remote, "rev-parse", "refs/tags/v2026.10.1")).toBe(startingHead);
    expect(releaseState.mainPushed && releaseState.tagPushed && releaseState.pushAttempted).toBe(true);
  });

  test("tags and pushes the proved commit even if HEAD moves during proof", async () => {
    const remote = join(cwd, "remote.git");
    await git(cwd, "init", "--bare", remote);
    await git(cwd, "remote", "add", "origin", remote);
    await git(cwd, "push", "origin", "main");
    await git(cwd, "checkout", "-b", "other");
    await git(cwd, "commit", "--allow-empty", "-m", "unproved change");
    await createTag("2026.10.1", startingHead, cwd);
    await pushRelease("2026.10.1", state({ releaseCommit: startingHead }), cwd);
    expect(await git(cwd, "--git-dir", remote, "rev-parse", "refs/heads/main")).toBe(startingHead);
    expect(await git(cwd, "--git-dir", remote, "rev-parse", "refs/tags/v2026.10.1^{commit}")).toBe(startingHead);
  });

  test("rejects a tag that differs from the proved commit before pushing", async () => {
    await git(cwd, "commit", "--allow-empty", "-m", "unproved change");
    await git(cwd, "tag", "v2026.10.1");
    const releaseState = state({ releaseCommit: startingHead });
    await expect(pushRelease("2026.10.1", releaseState, cwd)).rejects.toThrow("Release tag does not match");
    expect(releaseState.pushAttempted).toBe(false);
  });

  test("a reserved tag is never moved and rollback preserves uncertain state", async () => {
    const remote = join(cwd, "remote.git");
    await git(cwd, "init", "--bare", remote);
    await git(cwd, "remote", "add", "origin", remote);
    await git(cwd, "push", "origin", "main");
    await git(cwd, "--git-dir", remote, "tag", "v2026.10.1", startingHead);
    await writeFile(join(cwd, "package.json"), '{"version":"2026.10.1"}\n');
    await git(cwd, "add", "package.json");
    await git(cwd, "commit", "-m", "chore(release): v2026.10.1");
    const releaseCommit = await git(cwd, "rev-parse", "HEAD");
    await git(cwd, "tag", "v2026.10.1");
    const releaseState = state({ filesMutated: true, commitCreated: true, releaseCommit, tagCreated: true });
    await expect(pushRelease("2026.10.1", releaseState, cwd)).rejects.toThrow();
    expect(await git(cwd, "--git-dir", remote, "rev-parse", "refs/heads/main")).toBe(startingHead);
    expect(releaseState.pushAttempted).toBe(true);
    await rollback("2026.10.1", releaseState, cwd);
    expect(await git(cwd, "rev-parse", "HEAD")).toBe(releaseCommit);
    expect(await git(cwd, "tag", "-l", "v2026.10.1")).toBe("v2026.10.1");
  });
});

describe("release arguments", () => {
  test("uses automatic CalVer and rejects old SemVer bump commands", () => {
    expect(parseArgs([])).toEqual({ dryRun: false, skipTests: false, preview: false });
    expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
    for (const type of ["patch", "minor", "major"]) {
      expect(() => parseArgs([type])).toThrow("CalVer");
    }
    expect(() => parseArgs(["--unknown"])).toThrow("Unknown argument");
    expect(() => parseArgs(["--dry-run", "--preview"])).toThrow("together");
  });
});

describe("release dry-run pre-release checklist (spec 011)", () => {
  /** Capture what `showDryRunPlan` writes to stdout. */
  function planOutput(): string {
    const original = console.log;
    let out = "";
    console.log = (...parts: unknown[]) => {
      out += parts.join(" ") + "\n";
    };
    try {
      showDryRunPlan("0.17.0", "0.18.0", false);
    } finally {
      console.log = original;
    }
    return out;
  }

  test("reminds the releaser to complete a security review", () => {
    // The gate is advisory, so its ONLY force is being printed. If this line
    // ever disappears, the release runbook silently loses its security step.
    const out = planOutput();
    expect(out).toContain("Security review completed for this release");
    expect(out).toContain("/security-review");
  });

  test("names the untrusted-input surfaces the review must cover", () => {
    const out = planOutput();
    for (const surface of [".docx", ".wiki-pdf-template", "SVG", "storage", "link-target", "font"]) {
      expect(out).toContain(surface);
    }
  });

  test("still prints the release plan itself", () => {
    const out = planOutput();
    expect(out).toContain("0.17.0 \u2192 0.18.0");
    expect(out).toContain("--dry-run");
  });

  test("shows the CalVer invocation, protected merge and tag push", () => {
    const out = planOutput();
    expect(out).toContain("UTC");
    expect(out).toContain("local tag snapshot");
    expect(out).toContain("open a release PR and merge after required CI success");
    expect(out).toContain("git push origin refs/tags/v0.18.0");
    expect(out).not.toContain("release.ts patch");
    expect(out).not.toContain("release.ts minor");
  });

  test("keeps the stable Homebrew dispatch isolated from the dev formula", () => {
    const out = planOutput();
    expect(out).toContain("-f formula=atlcli -f tag=v0.18.0");
    expect(out).not.toContain("formula=atlcli-dev");
  });

  test("uses the canonical root test command", () => {
    const out = planOutput();
    expect([...RELEASE_TEST_COMMAND]).toEqual(["bun", "run", "test"]);
    expect(out).toContain("bun run typecheck && bun run test");
    expect(out).not.toContain("&& bun test");
  });

  test("skips local tests only when CI fully proved the commit", () => {
    const green = [
      { name: "Product quality / Linux typecheck, browser checks, build, and package contracts", status: "completed", conclusion: "success" },
      { name: "Product quality / Linux Bun tests (general-1)", status: "completed", conclusion: "success" },
      { name: "Documentation", status: "completed", conclusion: "skipped" },
    ];
    expect(ciProvedCommit(green)).toBe(true);
    expect(ciProvedCommit([])).toBe(false);
    expect(ciProvedCommit([...green, { name: "NFS helper", status: "in_progress", conclusion: null }])).toBe(false);
    expect(ciProvedCommit([...green, { name: "pdf-cli-macos", status: "completed", conclusion: "failure" }])).toBe(false);
    expect(ciProvedCommit(green.filter((run) => !run.name.includes("Bun tests")))).toBe(false);
    expect(ciProvedCommit(green.filter((run) => !run.name.includes("typecheck")))).toBe(false);
  });

  test("trusts the process exit code instead of parsing test output", () => {
    expect(() => assertSuccessfulExit("Tests", 0)).not.toThrow();
    expect(() => assertSuccessfulExit("Tests", 1)).toThrow(
      "Tests failed with exit code 1",
    );
  });

  test("runs from a review branch without release mutation preconditions", async () => {
    // CI checkouts may have a prepared CalVer version with no published tag yet.
    // Keep this CLI contract independent of the host's version/tag inventory.
    const fixture = await realpath(await mkdtemp(join(tmpdir(), "atlcli-release-dry-run-")));
    try {
      await git(fixture, "init");
      await git(fixture, "config", "user.email", "release-test@example.com");
      await git(fixture, "config", "user.name", "Release Test");
      await writeFile(join(fixture, "package.json"), '{"version":"0.17.2"}\n');
      await git(fixture, "add", "package.json");
      await git(fixture, "commit", "-m", "initial");
      await writeFile(join(fixture, "review-note.txt"), "dirty review fixture\n");
      const statusBefore = await git(fixture, "status", "--porcelain");
      const tagsBefore = await git(fixture, "tag", "--list");
      const proc = Bun.spawn(["bun", join(import.meta.dir, "release.ts"), "--dry-run"], {
        cwd: fixture,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("DRY RUN - No changes will be made.");
      expect(stdout).toContain("Dry run: mutation preconditions are not required");
      expect(await git(fixture, "status", "--porcelain")).toBe(statusBefore);
      expect(await git(fixture, "tag", "--list")).toBe(tagsBefore);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

describe("stable release completion", () => {
  const complete = [
    "atlcli-darwin-arm64.tar.gz",
    "atlcli-darwin-x64.tar.gz",
    "atlcli-extension-chrome-mv3-v0.17.2.zip",
    "atlcli-linux-arm64.tar.gz",
    "atlcli-linux-x64.tar.gz",
    "atlcli-windows-x64.zip",
    "build-metadata.json",
    "checksums.txt",
    "security-attestation.json",
  ];

  test("waits for the shared CLI, extension, metadata, and security contract", () => {
    expect(stableReleaseAssetsReady("0.17.2", complete)).toBe(true);
    for (const required of complete) {
      expect(
        stableReleaseAssetsReady("0.17.2", complete.filter((name) => name !== required)),
        `missing ${required} must keep the release incomplete`,
      ).toBe(false);
    }
  });

  test("does not dispatch Homebrew for a draft or unfinished publication workflow", () => {
    const sourceSha = "a".repeat(40);
    const release = { draft: false, prerelease: false, assets: complete.map((name) => ({ name })) };
    const run = { headSha: sourceSha, headBranch: "v0.17.2", status: "completed", conclusion: "success" };
    expect(stableReleasePublicationReady("0.17.2", release, run, sourceSha)).toBe(true);
    for (const partial of [{ draft: true }, { prerelease: true }, { assets: [] }]) {
      expect(stableReleasePublicationReady("0.17.2", { ...release, ...partial }, run, sourceSha)).toBe(false);
    }
    for (const partial of [{ status: "in_progress" }, { conclusion: "failure" },
      { headSha: "b".repeat(40) }, { headBranch: "main" }]) {
      expect(stableReleasePublicationReady("0.17.2", release, { ...run, ...partial }, sourceSha)).toBe(false);
    }
    expect(stableReleasePublicationReady("0.17.2", release, undefined, sourceSha)).toBe(false);
  });
});
