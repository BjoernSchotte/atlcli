/**
 * Git utilities for plugin-git.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

/** File change from git status */
export interface FileChange {
  path: string;
  status: "M" | "A" | "D" | "?" | "R" | "C" | "U";
}

/**
 * Execute a git command in a directory.
 */
export async function gitExec(
  dir: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  const displayCommand = ["git", ...args].map((arg) => JSON.stringify(arg)).join(" ");
  try {
    const result = await execFileAsync("git", args, {
      cwd: dir,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `Git command failed: ${displayCommand}\n${error.stderr || error.message}`
    );
  }
}

interface PorcelainEntry {
  indexStatus: string;
  workTreeStatus: string;
  path: string;
}

/** Parse NUL-delimited porcelain output without relying on shell quoting. */
function parsePorcelain(output: string): PorcelainEntry[] {
  const records = output.split("\0");
  const entries: PorcelainEntry[] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record || record.length < 4) continue;

    const indexStatus = record.charAt(0);
    const workTreeStatus = record.charAt(1);
    entries.push({
      indexStatus,
      workTreeStatus,
      path: record.substring(3),
    });

    // Rename/copy records contain a second NUL-delimited source path.
    if (indexStatus === "R" || indexStatus === "C" || workTreeStatus === "R" || workTreeStatus === "C") {
      i += 1;
    }
  }

  return entries;
}

/**
 * Check if a directory is a git repository.
 */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const gitDir = join(dir, ".git");
    const stats = await stat(gitDir);
    // `.git` is a file (gitdir pointer) in linked worktrees and submodules.
    return stats.isDirectory() || stats.isFile();
  } catch {
    // Also check if we're inside a git repo (not at root)
    try {
      await gitExec(dir, ["rev-parse", "--git-dir"]);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Get the git repository root directory.
 */
export async function getGitRoot(dir: string): Promise<string> {
  const { stdout } = await gitExec(dir, ["rev-parse", "--show-toplevel"]);
  return stdout.trim();
}

/**
 * Get list of all uncommitted changes (staged + unstaged).
 */
export async function getAllGitChanges(dir: string): Promise<FileChange[]> {
  const { stdout } = await gitExec(dir, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    ".",
  ]);

  if (!stdout.trim()) {
    return [];
  }

  const changes: FileChange[] = [];
  for (const { indexStatus, workTreeStatus, path } of parsePorcelain(stdout)) {
    // Include any file that has changes (staged or unstaged)
    if (indexStatus !== " " || workTreeStatus !== " ") {
      // Determine the most relevant status
      let status: FileChange["status"] = "M";
      if (indexStatus === "?" || workTreeStatus === "?") {
        status = "?";
      } else if (indexStatus === "A" || workTreeStatus === "A") {
        status = "A";
      } else if (indexStatus === "D" || workTreeStatus === "D") {
        status = "D";
      }

      changes.push({ path, status });
    }
  }

  return changes;
}

/**
 * Stage all changes.
 */
export async function gitAddAll(dir: string, pathspec = "."): Promise<void> {
  await gitExec(dir, ["add", "-A", "--", pathspec]);
}

/**
 * Create a git commit.
 */
export async function gitCommit(
  dir: string,
  message: string,
  pathspecs: string[] = [],
): Promise<string> {
  const args = ["commit", "-m", message];
  if (pathspecs.length > 0) {
    args.push("--only", "--", ...pathspecs);
  }
  const { stdout } = await gitExec(dir, args);
  return stdout;
}
