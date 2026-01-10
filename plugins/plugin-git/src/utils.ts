/**
 * Git utilities for plugin-git.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { join } from "node:path";

const execAsync = promisify(exec);

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
  const command = `git ${args.join(" ")}`;
  try {
    const result = await execAsync(command, { cwd: dir, maxBuffer: 10 * 1024 * 1024 });
    return result;
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `Git command failed: ${command}\n${error.stderr || error.message}`
    );
  }
}

/**
 * Check if a directory is a git repository.
 */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const gitDir = join(dir, ".git");
    const stats = await stat(gitDir);
    return stats.isDirectory();
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
 * Get list of changed files from git status.
 * Returns only untracked and modified files (not staged).
 */
export async function getGitChanges(dir: string): Promise<FileChange[]> {
  const { stdout } = await gitExec(dir, ["status", "--porcelain"]);

  if (!stdout.trim()) {
    return [];
  }

  const changes: FileChange[] = [];
  const lines = stdout.trim().split("\n");

  for (const line of lines) {
    if (!line) continue;

    // Git status --porcelain format: XY filename
    // X = index status, Y = work tree status
    const indexStatus = line[0];
    const workTreeStatus = line[1];
    const path = line.slice(3); // Skip "XY "

    // We care about work tree changes (untracked, modified)
    // ? = untracked, M = modified, A = added, D = deleted
    if (workTreeStatus === "?" || workTreeStatus === "M" || workTreeStatus === "D") {
      changes.push({
        path,
        status: workTreeStatus as FileChange["status"],
      });
    } else if (indexStatus === "?" && workTreeStatus === "?") {
      // Untracked file
      changes.push({
        path,
        status: "?",
      });
    }
  }

  return changes;
}

/**
 * Get list of all uncommitted changes (staged + unstaged).
 */
export async function getAllGitChanges(dir: string): Promise<FileChange[]> {
  const { stdout } = await gitExec(dir, ["status", "--porcelain"]);

  if (!stdout.trim()) {
    return [];
  }

  const changes: FileChange[] = [];
  const lines = stdout.trim().split("\n");

  for (const line of lines) {
    if (!line) continue;

    const indexStatus = line[0];
    const workTreeStatus = line[1];
    const path = line.slice(3);

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
 * Stage files for commit.
 */
export async function gitAdd(dir: string, files: string[] | FileChange[]): Promise<void> {
  const paths = files.map((f) => (typeof f === "string" ? f : f.path));
  if (paths.length === 0) return;

  // Add files in batches to avoid command line length limits
  const batchSize = 50;
  for (let i = 0; i < paths.length; i += batchSize) {
    const batch = paths.slice(i, i + batchSize);
    await gitExec(dir, ["add", "--", ...batch]);
  }
}

/**
 * Stage all changes.
 */
export async function gitAddAll(dir: string): Promise<void> {
  await gitExec(dir, ["add", "-A"]);
}

/**
 * Create a git commit.
 */
export async function gitCommit(dir: string, message: string): Promise<string> {
  // Quote the message to handle special characters like parentheses
  const quotedMessage = `"${message.replace(/"/g, '\\"')}"`;
  const { stdout } = await gitExec(dir, ["commit", "-m", quotedMessage]);
  return stdout;
}

/**
 * Check if there are staged changes ready to commit.
 */
export async function hasStagedChanges(dir: string): Promise<boolean> {
  const { stdout } = await gitExec(dir, ["diff", "--cached", "--name-only"]);
  return stdout.trim().length > 0;
}

/**
 * Get the current branch name.
 */
export async function getCurrentBranch(dir: string): Promise<string> {
  const { stdout } = await gitExec(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return stdout.trim();
}

/**
 * Get the short hash of HEAD.
 */
export async function getHeadHash(dir: string): Promise<string> {
  const { stdout } = await gitExec(dir, ["rev-parse", "--short", "HEAD"]);
  return stdout.trim();
}
