import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSuccessfulExit,
  RELEASE_TEST_COMMAND,
  rollback,
  showDryRunPlan,
  stableReleaseAssetsReady,
  type ReleaseState,
} from "./release";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
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

  test("trusts the process exit code instead of parsing test output", () => {
    expect(() => assertSuccessfulExit("Tests", 0)).not.toThrow();
    expect(() => assertSuccessfulExit("Tests", 1)).toThrow(
      "Tests failed with exit code 1",
    );
  });

  test("runs from a review branch without release mutation preconditions", async () => {
    const proc = Bun.spawn(["bun", "scripts/release.ts", "patch", "--dry-run"], {
      cwd: join(import.meta.dir, ".."),
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
});
