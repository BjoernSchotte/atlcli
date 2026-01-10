/**
 * Auto-commit logic for plugin-git.
 *
 * Automatically commits changes to git after pulling from Confluence.
 */

import { resolve } from "node:path";
import type { CommandContext } from "./types.js";
import {
  isGitRepo,
  getAllGitChanges,
  gitAddAll,
  gitCommit,
  FileChange,
} from "./utils.js";

/**
 * Build a commit message for Confluence sync.
 */
function buildCommitMessage(changes: FileChange[], direction: "pull" | "push"): string {
  const count = changes.length;
  const files = changes.map((c) => c.path);

  // Truncate file list if too long
  const maxFiles = 10;
  let fileList: string;
  if (files.length <= maxFiles) {
    fileList = files.join(", ");
  } else {
    fileList = files.slice(0, maxFiles).join(", ") + `, ... and ${files.length - maxFiles} more`;
  }

  const verb = direction === "pull" ? "pull" : "push";
  const preposition = direction === "pull" ? "from" : "to";

  return `sync(confluence): ${verb} ${count} page(s) ${preposition} Confluence\n\nUpdated: ${fileList}`;
}

/**
 * Auto-commit changes after a docs pull or sync command.
 *
 * This is called as an afterCommand hook.
 */
export async function autoCommitAfterPull(ctx: CommandContext): Promise<void> {
  // 1. Check if this is a docs pull or docs sync command
  const [cmd, subcmd] = ctx.command;

  // Only trigger for docs pull and docs sync
  if (cmd !== "docs") {
    return;
  }

  if (subcmd !== "pull" && subcmd !== "sync") {
    return;
  }

  // For sync command, we only auto-commit after it stops (not while running)
  // The sync daemon handles its own commits differently
  // For now, skip sync to avoid complications with the running daemon
  if (subcmd === "sync") {
    // Sync daemon runs continuously, so we don't auto-commit here
    // Instead, the sync engine should handle commits during operation
    return;
  }

  // 2. Get the directory from args
  // ctx.command = ["docs", "pull", dir] or ["docs", "pull"]
  // ctx.args = ["pull", dir] or ["pull"]
  // So the directory is at ctx.args[1] or ctx.command[2]
  const dir = ctx.args[1] ? resolve(ctx.args[1]) : process.cwd();

  // 3. Check if directory is a git repo
  if (!(await isGitRepo(dir))) {
    // Not a git repo, skip silently
    return;
  }

  // 4. Check for changes
  const changes = await getAllGitChanges(dir);
  if (changes.length === 0) {
    // No changes to commit
    return;
  }

  // 5. Stage all changes and commit
  try {
    await gitAddAll(dir);
    const message = buildCommitMessage(changes, "pull");
    await gitCommit(dir, message);

    // Output success message (unless --quiet flag is set)
    if (!ctx.flags.quiet) {
      console.log(`[plugin-git] Auto-committed ${changes.length} file(s) from Confluence pull`);
    }
  } catch (err) {
    // Log error but don't fail the command
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[plugin-git] Auto-commit failed: ${message}`);
  }
}
