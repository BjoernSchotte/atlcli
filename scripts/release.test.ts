import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rollback, type ReleaseState } from "./release";

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
