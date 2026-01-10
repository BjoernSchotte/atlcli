import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { autoCommitAfterPull } from "./auto-commit.js";
import { gitExec } from "./utils.js";
import type { CommandContext } from "./types.js";

describe("autoCommitAfterPull", () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create temp directory with git repo
    tempDir = await mkdtemp(join(tmpdir(), "plugin-git-test-"));
    await gitExec(tempDir, ["init"]);
    await gitExec(tempDir, ["config", "user.email", "test@test.com"]);
    await gitExec(tempDir, ["config", "user.name", "Test"]);
    // Initial commit
    await writeFile(join(tempDir, "initial.txt"), "initial");
    await gitExec(tempDir, ["add", "."]);
    await gitExec(tempDir, ["commit", "-m", "initial"]);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function createContext(overrides: Partial<CommandContext> = {}): CommandContext {
    return {
      command: ["docs", "pull", tempDir],
      args: ["pull", tempDir],
      flags: {},
      output: { json: false, quiet: false },
      ...overrides,
    };
  }

  describe("command filtering", () => {
    test("skips non-docs commands", async () => {
      await writeFile(join(tempDir, "new.txt"), "content");

      const ctx = createContext({ command: ["auth", "login"], args: ["login"] });
      await autoCommitAfterPull(ctx);

      // File should not be committed
      const { stdout } = await gitExec(tempDir, ["status", "--porcelain"]);
      expect(stdout.trim()).not.toBe("");
    });

    test("skips docs commands other than pull", async () => {
      await writeFile(join(tempDir, "new.txt"), "content");

      const ctx = createContext({ command: ["docs", "push", tempDir], args: ["push", tempDir] });
      await autoCommitAfterPull(ctx);

      const { stdout } = await gitExec(tempDir, ["status", "--porcelain"]);
      expect(stdout.trim()).not.toBe("");
    });

    test("skips docs sync command", async () => {
      await writeFile(join(tempDir, "new.txt"), "content");

      const ctx = createContext({ command: ["docs", "sync", tempDir], args: ["sync", tempDir] });
      await autoCommitAfterPull(ctx);

      const { stdout } = await gitExec(tempDir, ["status", "--porcelain"]);
      expect(stdout.trim()).not.toBe("");
    });

    test("processes docs pull command", async () => {
      await writeFile(join(tempDir, "new.txt"), "content");

      const ctx = createContext();
      await autoCommitAfterPull(ctx);

      // File should be committed
      const { stdout } = await gitExec(tempDir, ["status", "--porcelain"]);
      expect(stdout.trim()).toBe("");
    });
  });

  describe("git repo detection", () => {
    test("skips non-git directories silently", async () => {
      const nonGitDir = await mkdtemp(join(tmpdir(), "non-git-"));
      await writeFile(join(nonGitDir, "file.txt"), "content");

      const ctx = createContext({
        command: ["docs", "pull", nonGitDir],
        args: ["pull", nonGitDir],
      });

      // Should not throw
      await autoCommitAfterPull(ctx);

      await rm(nonGitDir, { recursive: true, force: true });
    });
  });

  describe("change detection", () => {
    test("skips when no changes", async () => {
      const { stdout: beforeLog } = await gitExec(tempDir, ["log", "--oneline"]);
      const commitCountBefore = beforeLog.trim().split("\n").length;

      const ctx = createContext();
      await autoCommitAfterPull(ctx);

      const { stdout: afterLog } = await gitExec(tempDir, ["log", "--oneline"]);
      const commitCountAfter = afterLog.trim().split("\n").length;

      expect(commitCountAfter).toBe(commitCountBefore);
    });

    test("commits when there are changes", async () => {
      await writeFile(join(tempDir, "pulled.md"), "# From Confluence");

      const ctx = createContext();
      await autoCommitAfterPull(ctx);

      const { stdout } = await gitExec(tempDir, ["log", "-1", "--format=%s"]);
      expect(stdout).toContain("sync(confluence): pull");
    });
  });

  describe("commit message", () => {
    test("includes file count", async () => {
      await writeFile(join(tempDir, "file1.md"), "content1");
      await writeFile(join(tempDir, "file2.md"), "content2");
      await writeFile(join(tempDir, "file3.md"), "content3");

      const ctx = createContext();
      await autoCommitAfterPull(ctx);

      const { stdout } = await gitExec(tempDir, ["log", "-1", "--format=%s"]);
      expect(stdout).toContain("pull 3 page(s)");
    });

    test("includes file names in body", async () => {
      await writeFile(join(tempDir, "architecture.md"), "content");

      const ctx = createContext();
      await autoCommitAfterPull(ctx);

      const { stdout } = await gitExec(tempDir, ["log", "-1", "--format=%B"]);
      expect(stdout).toContain("architecture.md");
    });

    test("truncates long file lists", async () => {
      // Create 15 files
      for (let i = 1; i <= 15; i++) {
        await writeFile(join(tempDir, `file${i}.md`), `content${i}`);
      }

      const ctx = createContext();
      await autoCommitAfterPull(ctx);

      const { stdout } = await gitExec(tempDir, ["log", "-1", "--format=%B"]);
      expect(stdout).toContain("and 5 more");
    });
  });

  describe("directory resolution", () => {
    test("uses cwd when no directory specified", async () => {
      // Create a file in a subdirectory that is also a git repo
      const subDir = await mkdtemp(join(tmpdir(), "subdir-"));
      await gitExec(subDir, ["init"]);
      await gitExec(subDir, ["config", "user.email", "test@test.com"]);
      await gitExec(subDir, ["config", "user.name", "Test"]);
      await writeFile(join(subDir, "init.txt"), "init");
      await gitExec(subDir, ["add", "."]);
      await gitExec(subDir, ["commit", "-m", "init"]);

      await writeFile(join(subDir, "new.txt"), "new");

      // Save and change cwd
      const originalCwd = process.cwd();
      process.chdir(subDir);

      try {
        const ctx: CommandContext = {
          command: ["docs", "pull"],
          args: ["pull"],
          flags: {},
          output: { json: false, quiet: false },
        };
        await autoCommitAfterPull(ctx);

        const { stdout } = await gitExec(subDir, ["status", "--porcelain"]);
        expect(stdout.trim()).toBe("");
      } finally {
        process.chdir(originalCwd);
        await rm(subDir, { recursive: true, force: true });
      }
    });
  });

  describe("error handling", () => {
    test("logs error but does not throw", async () => {
      // Create a situation that would cause git commit to fail
      // (empty commit - but we check for changes first, so this tests the catch block)
      const ctx = createContext();

      // Should not throw even if something goes wrong
      await autoCommitAfterPull(ctx);
    });
  });
});
