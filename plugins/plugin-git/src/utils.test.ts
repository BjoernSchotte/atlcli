import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isGitRepo,
  getGitRoot,
  getAllGitChanges,
  gitAddAll,
  gitCommit,
  gitExec,
} from "./utils.js";

describe("git utils", () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create temp directory
    tempDir = await realpath(await mkdtemp(join(tmpdir(), "plugin-git-test-")));
  });

  afterEach(async () => {
    // Cleanup temp directory
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("isGitRepo", () => {
    test("returns false for non-git directory", async () => {
      const result = await isGitRepo(tempDir);
      expect(result).toBe(false);
    });

    test("returns true for git directory", async () => {
      await gitExec(tempDir, ["init"]);
      const result = await isGitRepo(tempDir);
      expect(result).toBe(true);
    });

    test("returns true for a linked worktree, where .git is a file", async () => {
      await gitExec(tempDir, ["init"]);
      await gitExec(tempDir, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-m", "init"]);
      const worktree = join(tempDir, "wt");
      await gitExec(tempDir, ["worktree", "add", worktree]);
      expect(await isGitRepo(worktree)).toBe(true);
    });

    test("returns true for subdirectory of git repo", async () => {
      await gitExec(tempDir, ["init"]);
      const subDir = join(tempDir, "subdir");
      await mkdir(subDir);
      const result = await isGitRepo(subDir);
      expect(result).toBe(true);
    });
  });

  describe("getGitRoot", () => {
    test("returns root directory of git repo", async () => {
      await gitExec(tempDir, ["init"]);
      const root = await getGitRoot(tempDir);
      expect(root).toBe(tempDir);
    });

    test("returns root from subdirectory", async () => {
      await gitExec(tempDir, ["init"]);
      const subDir = join(tempDir, "subdir");
      await mkdir(subDir);
      const root = await getGitRoot(subDir);
      expect(root).toBe(tempDir);
    });
  });

  describe("getAllGitChanges", () => {
    beforeEach(async () => {
      await gitExec(tempDir, ["init"]);
      await gitExec(tempDir, ["config", "user.email", "test@test.com"]);
      await gitExec(tempDir, ["config", "user.name", "Test"]);
    });

    test("returns both staged and unstaged changes", async () => {
      await writeFile(join(tempDir, "file.txt"), "content");
      await gitExec(tempDir, ["add", "."]);
      await gitExec(tempDir, ["commit", "-m", "initial"]);

      // Stage one file, leave another unstaged
      await writeFile(join(tempDir, "staged.txt"), "staged");
      await gitExec(tempDir, ["add", "staged.txt"]);
      await writeFile(join(tempDir, "unstaged.txt"), "unstaged");

      const changes = await getAllGitChanges(tempDir);
      expect(changes.length).toBe(2);
      const paths = changes.map((c) => c.path);
      expect(paths).toContain("staged.txt");
      expect(paths).toContain("unstaged.txt");
    });

    test("limits changes to the supplied working directory", async () => {
      const docsDir = join(tempDir, "docs");
      await mkdir(docsDir);
      await writeFile(join(docsDir, "inside.md"), "inside");
      await writeFile(join(tempDir, "outside.md"), "outside");

      const changes = await getAllGitChanges(docsDir);
      expect(changes.map((change) => change.path)).toEqual(["docs/inside.md"]);
    });
  });

  describe("gitAddAll", () => {
    beforeEach(async () => {
      await gitExec(tempDir, ["init"]);
    });

    test("stages all changes", async () => {
      await writeFile(join(tempDir, "file1.txt"), "content1");
      await writeFile(join(tempDir, "file2.txt"), "content2");

      await gitAddAll(tempDir);

      const { stdout } = await gitExec(tempDir, ["diff", "--cached", "--name-only"]);
      const files = stdout.trim().split("\n").sort();
      expect(files).toEqual(["file1.txt", "file2.txt"]);
    });
  });

  describe("gitCommit", () => {
    beforeEach(async () => {
      await gitExec(tempDir, ["init"]);
      await gitExec(tempDir, ["config", "user.email", "test@test.com"]);
      await gitExec(tempDir, ["config", "user.name", "Test"]);
    });

    test("creates commit with message", async () => {
      await writeFile(join(tempDir, "file.txt"), "content");
      await gitExec(tempDir, ["add", "."]);

      await gitCommit(tempDir, "Test commit message");

      const { stdout } = await gitExec(tempDir, ["log", "-1", "--format=%s"]);
      expect(stdout.trim()).toBe("Test commit message");
    });

    test("handles special characters in message", async () => {
      await writeFile(join(tempDir, "file.txt"), "content");
      await gitExec(tempDir, ["add", "."]);

      await gitCommit(tempDir, "sync(confluence): pull 3 page(s)");

      const { stdout } = await gitExec(tempDir, ["log", "-1", "--format=%s"]);
      expect(stdout.trim()).toBe("sync(confluence): pull 3 page(s)");
    });

    test("handles multiline messages", async () => {
      await writeFile(join(tempDir, "file.txt"), "content");
      await gitExec(tempDir, ["add", "."]);

      await gitCommit(tempDir, "Subject line\n\nBody text here");

      const { stdout } = await gitExec(tempDir, ["log", "-1", "--format=%B"]);
      expect(stdout.trim()).toContain("Subject line");
      expect(stdout.trim()).toContain("Body text here");
    });

    test("does not expand environment variables in messages", async () => {
      await writeFile(join(tempDir, "file.txt"), "content");
      await gitExec(tempDir, ["add", "."]);

      await gitCommit(tempDir, "Keep $HOME literal");

      const { stdout } = await gitExec(tempDir, ["log", "-1", "--format=%s"]);
      expect(stdout.trim()).toBe("Keep $HOME literal");
    });
  });
});
