import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, readFile, chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import {
  installHookHandler,
  removeHookHandler,
  statusHookHandler,
} from "./git-hooks.js";
import { gitExec } from "./utils.js";
import type { CommandContext } from "./types.js";

describe("git hooks", () => {
  let tempDir: string;
  let hookPath: string;

  beforeEach(async () => {
    // Create temp directory with git repo and .atlcli
    tempDir = await mkdtemp(join(tmpdir(), "plugin-git-hooks-test-"));
    await gitExec(tempDir, ["init"]);
    await mkdir(join(tempDir, ".atlcli"));
    hookPath = join(tempDir, ".git", "hooks", "post-commit");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function createContext(overrides: Partial<CommandContext> = {}): CommandContext {
    return {
      command: ["git", "hook", "install"],
      args: [tempDir],
      flags: {},
      output: { json: false, quiet: false },
      ...overrides,
    };
  }

  describe("installHookHandler", () => {
    test("installs hook in valid git repo with .atlcli", async () => {
      const ctx = createContext();
      await installHookHandler(ctx);

      expect(existsSync(hookPath)).toBe(true);
      const content = await readFile(hookPath, "utf-8");
      expect(content).toContain("atlcli-plugin-git hook");
    });

    test("makes hook executable", async () => {
      const ctx = createContext();
      await installHookHandler(ctx);

      // Check file has executable permissions
      const stats = await stat(hookPath);
      expect(stats.mode & 0o111).toBeGreaterThan(0); // Has some execute bit
    });

    test("fails on non-git directory", async () => {
      const nonGitDir = await mkdtemp(join(tmpdir(), "non-git-"));

      const ctx = createContext({ args: [nonGitDir] });
      await installHookHandler(ctx);

      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;

      await rm(nonGitDir, { recursive: true, force: true });
    });

    test("fails on git repo without .atlcli", async () => {
      const gitOnlyDir = await mkdtemp(join(tmpdir(), "git-only-"));
      await gitExec(gitOnlyDir, ["init"]);

      const ctx = createContext({ args: [gitOnlyDir] });
      await installHookHandler(ctx);

      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;

      await rm(gitOnlyDir, { recursive: true, force: true });
    });

    test("reports already installed", async () => {
      // Install first time
      await installHookHandler(createContext());

      // Try to install again
      await installHookHandler(createContext());

      // Should not fail, just report
      expect(existsSync(hookPath)).toBe(true);
    });

    test("fails with existing non-atlcli hook", async () => {
      // Create existing hook
      await mkdir(join(tempDir, ".git", "hooks"), { recursive: true });
      await writeFile(hookPath, "#!/bin/sh\necho existing");
      await chmod(hookPath, 0o755);

      const ctx = createContext();
      await installHookHandler(ctx);

      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;

      // Original hook preserved
      const content = await readFile(hookPath, "utf-8");
      expect(content).toContain("existing");
    });

    test("overwrites with --force and creates backup", async () => {
      // Create existing hook
      await mkdir(join(tempDir, ".git", "hooks"), { recursive: true });
      await writeFile(hookPath, "#!/bin/sh\necho existing");
      await chmod(hookPath, 0o755);

      const ctx = createContext({ flags: { force: true } });
      await installHookHandler(ctx);

      // New hook installed
      const content = await readFile(hookPath, "utf-8");
      expect(content).toContain("atlcli-plugin-git hook");

      // Backup created
      const backupPath = hookPath + ".backup";
      expect(existsSync(backupPath)).toBe(true);
      const backupContent = await readFile(backupPath, "utf-8");
      expect(backupContent).toContain("existing");
    });

    test("outputs JSON when requested", async () => {
      const ctx = createContext({ output: { json: true, quiet: false } });

      // Capture console output
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await installHookHandler(ctx);

      console.log = originalLog;

      expect(logs.length).toBeGreaterThan(0);
      const output = JSON.parse(logs[0]);
      expect(output.status).toBe("installed");
      expect(output.path).toBe(hookPath);
    });
  });

  describe("removeHookHandler", () => {
    test("removes installed hook", async () => {
      // Install first
      await installHookHandler(createContext());
      expect(existsSync(hookPath)).toBe(true);

      // Remove
      const ctx = createContext({ command: ["git", "hook", "remove"] });
      await removeHookHandler(ctx);

      expect(existsSync(hookPath)).toBe(false);
    });

    test("reports not installed when no hook", async () => {
      const ctx = createContext({ command: ["git", "hook", "remove"] });
      await removeHookHandler(ctx);

      // Should not fail
      expect(existsSync(hookPath)).toBe(false);
    });

    test("restores backup when present", async () => {
      // Create existing hook
      await mkdir(join(tempDir, ".git", "hooks"), { recursive: true });
      await writeFile(hookPath, "#!/bin/sh\necho original");
      await chmod(hookPath, 0o755);

      // Install with --force (creates backup)
      await installHookHandler(createContext({ flags: { force: true } }));

      // Remove (should restore backup)
      await removeHookHandler(createContext({ command: ["git", "hook", "remove"] }));

      const content = await readFile(hookPath, "utf-8");
      expect(content).toContain("original");

      // Backup should be gone
      expect(existsSync(hookPath + ".backup")).toBe(false);
    });

    test("fails on non-git directory", async () => {
      const nonGitDir = await mkdtemp(join(tmpdir(), "non-git-"));

      const ctx = createContext({ command: ["git", "hook", "remove"], args: [nonGitDir] });
      await removeHookHandler(ctx);

      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;

      await rm(nonGitDir, { recursive: true, force: true });
    });

    test("outputs JSON when requested", async () => {
      // Install first
      await installHookHandler(createContext());

      const ctx = createContext({
        command: ["git", "hook", "remove"],
        output: { json: true, quiet: false },
      });

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await removeHookHandler(ctx);

      console.log = originalLog;

      const output = JSON.parse(logs[0]);
      expect(output.status).toBe("removed");
    });
  });

  describe("statusHookHandler", () => {
    test("reports not installed", async () => {
      const ctx = createContext({
        command: ["git", "hook", "status"],
        output: { json: true, quiet: false },
      });

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await statusHookHandler(ctx);

      console.log = originalLog;

      const output = JSON.parse(logs[0]);
      expect(output.installed).toBe(false);
    });

    test("reports installed", async () => {
      // Install first
      await installHookHandler(createContext());

      const ctx = createContext({
        command: ["git", "hook", "status"],
        output: { json: true, quiet: false },
      });

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await statusHookHandler(ctx);

      console.log = originalLog;

      const output = JSON.parse(logs[0]);
      expect(output.installed).toBe(true);
    });

    test("reports atlcli initialized status", async () => {
      const ctx = createContext({
        command: ["git", "hook", "status"],
        output: { json: true, quiet: false },
      });

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await statusHookHandler(ctx);

      console.log = originalLog;

      const output = JSON.parse(logs[0]);
      expect(output.initialized).toBe(true);
    });

    test("detects sync daemon lockfile", async () => {
      // Create lockfile
      await writeFile(join(tempDir, ".atlcli", ".sync.lock"), '{"pid":12345}');

      const ctx = createContext({
        command: ["git", "hook", "status"],
        output: { json: true, quiet: false },
      });

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await statusHookHandler(ctx);

      console.log = originalLog;

      const output = JSON.parse(logs[0]);
      expect(output.syncRunning).toBe(true);
    });

    test("detects non-atlcli hook", async () => {
      // Create non-atlcli hook
      await mkdir(join(tempDir, ".git", "hooks"), { recursive: true });
      await writeFile(hookPath, "#!/bin/sh\necho other");

      const ctx = createContext({
        command: ["git", "hook", "status"],
        output: { json: true, quiet: false },
      });

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await statusHookHandler(ctx);

      console.log = originalLog;

      const output = JSON.parse(logs[0]);
      expect(output.installed).toBe(false);
      expect(output.hasOtherHook).toBe(true);
    });

    test("reports not git repo", async () => {
      const nonGitDir = await mkdtemp(join(tmpdir(), "non-git-"));

      const ctx = createContext({
        command: ["git", "hook", "status"],
        args: [nonGitDir],
        output: { json: true, quiet: false },
      });

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);

      await statusHookHandler(ctx);

      console.log = originalLog;

      const output = JSON.parse(logs[0]);
      expect(output.status).toBe("not_git_repo");

      await rm(nonGitDir, { recursive: true, force: true });
    });
  });
});
