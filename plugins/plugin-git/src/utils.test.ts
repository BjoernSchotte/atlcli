import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isGitRepo,
  getGitRoot,
  getGitChanges,
  getAllGitChanges,
  gitAdd,
  gitAddAll,
  gitCommit,
  gitExec,
  hasStagedChanges,
  getCurrentBranch,
  getHeadHash,
} from "./utils.js";

describe("git utils", () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create temp directory
    tempDir = await mkdtemp(join(tmpdir(), "plugin-git-test-"));
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

  describe("getGitChanges", () => {
    beforeEach(async () => {
      await gitExec(tempDir, ["init"]);
      await gitExec(tempDir, ["config", "user.email", "test@test.com"]);
      await gitExec(tempDir, ["config", "user.name", "Test"]);
    });

    test("returns empty array for clean repo", async () => {
      await writeFile(join(tempDir, "file.txt"), "content");
      await gitExec(tempDir, ["add", "."]);
      await gitExec(tempDir, ["commit", "-m", "initial"]);

      const changes = await getGitChanges(tempDir);
      expect(changes).toEqual([]);
    });

    test("detects untracked files", async () => {
      await writeFile(join(tempDir, "file.txt"), "content");
      await gitExec(tempDir, ["add", "."]);
      await gitExec(tempDir, ["commit", "-m", "initial"]);

      // Add new untracked file
      await writeFile(join(tempDir, "new.txt"), "new content");

      const changes = await getGitChanges(tempDir);
      expect(changes.length).toBe(1);
      expect(changes[0].path).toBe("new.txt");
      expect(changes[0].status).toBe("?");
    });

    test("detects modified files", async () => {
      await writeFile(join(tempDir, "file.txt"), "content");
      await gitExec(tempDir, ["add", "."]);
      await gitExec(tempDir, ["commit", "-m", "initial"]);

      // Modify file
      await writeFile(join(tempDir, "file.txt"), "modified content");

      const changes = await getGitChanges(tempDir);
      expect(changes.length).toBe(1);
      expect(changes[0].path).toBe("file.txt");
      expect(changes[0].status).toBe("M");
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
  });

  describe("gitAdd", () => {
    beforeEach(async () => {
      await gitExec(tempDir, ["init"]);
    });

    test("stages specified files", async () => {
      await writeFile(join(tempDir, "file1.txt"), "content1");
      await writeFile(join(tempDir, "file2.txt"), "content2");

      await gitAdd(tempDir, ["file1.txt"]);

      const { stdout } = await gitExec(tempDir, ["diff", "--cached", "--name-only"]);
      expect(stdout.trim()).toBe("file1.txt");
    });

    test("handles FileChange objects", async () => {
      await writeFile(join(tempDir, "file.txt"), "content");

      await gitAdd(tempDir, [{ path: "file.txt", status: "?" }]);

      const { stdout } = await gitExec(tempDir, ["diff", "--cached", "--name-only"]);
      expect(stdout.trim()).toBe("file.txt");
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
  });

  describe("hasStagedChanges", () => {
    beforeEach(async () => {
      await gitExec(tempDir, ["init"]);
    });

    test("returns false when nothing staged", async () => {
      await writeFile(join(tempDir, "file.txt"), "content");

      const result = await hasStagedChanges(tempDir);
      expect(result).toBe(false);
    });

    test("returns true when files staged", async () => {
      await writeFile(join(tempDir, "file.txt"), "content");
      await gitExec(tempDir, ["add", "."]);

      const result = await hasStagedChanges(tempDir);
      expect(result).toBe(true);
    });
  });

  describe("getCurrentBranch", () => {
    beforeEach(async () => {
      await gitExec(tempDir, ["init"]);
      await gitExec(tempDir, ["config", "user.email", "test@test.com"]);
      await gitExec(tempDir, ["config", "user.name", "Test"]);
      await writeFile(join(tempDir, "file.txt"), "content");
      await gitExec(tempDir, ["add", "."]);
      await gitExec(tempDir, ["commit", "-m", "initial"]);
    });

    test("returns current branch name", async () => {
      const branch = await getCurrentBranch(tempDir);
      // Modern git uses main or master
      expect(["main", "master"]).toContain(branch);
    });
  });

  describe("getHeadHash", () => {
    beforeEach(async () => {
      await gitExec(tempDir, ["init"]);
      await gitExec(tempDir, ["config", "user.email", "test@test.com"]);
      await gitExec(tempDir, ["config", "user.name", "Test"]);
      await writeFile(join(tempDir, "file.txt"), "content");
      await gitExec(tempDir, ["add", "."]);
      await gitExec(tempDir, ["commit", "-m", "initial"]);
    });

    test("returns short hash of HEAD", async () => {
      const hash = await getHeadHash(tempDir);
      expect(hash).toMatch(/^[a-f0-9]{7,}$/);
    });
  });
});
