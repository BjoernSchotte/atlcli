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
  // Hooks receive the complete root command path from the CLI.
  const [rootCommand, namespace, action, commandDir] = ctx.command;

  if (rootCommand !== "wiki" || namespace !== "docs" || action !== "pull") {
    return;
  }

  // ctx.command = ["wiki", "docs", "pull", dir]
  // ctx.args = ["docs", "pull", dir]
  const dir = resolve(commandDir ?? ctx.args[2] ?? process.cwd());

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
    // Limit both staging and the commit to the selected docs directory. Using
    // --only for the commit preserves unrelated changes already in the index.
    await gitAddAll(dir, ".");
    const message = buildCommitMessage(changes, "pull");
    await gitCommit(dir, message, ["."]);

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
