/**
 * Git hook management for plugin-git.
 *
 * Installs/removes/checks post-commit hooks for auto-pushing to Confluence.
 */

import { readFile, writeFile, unlink, chmod, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { CommandContext } from "./types.js";
import { isGitRepo, getGitRoot } from "./utils.js";

/** Marker comment to identify our hook */
const HOOK_MARKER = "# atlcli-plugin-git hook";

/** The post-commit hook script */
const HOOK_SCRIPT = `#!/bin/sh
${HOOK_MARKER}
# Auto-push to Confluence on commit
# Installed by: atlcli git hook install

# Get the directory containing .atlcli
DOCS_DIR="$(git rev-parse --show-toplevel)"

# Skip if sync daemon is running (lockfile exists)
LOCKFILE="$DOCS_DIR/.atlcli/.sync.lock"
if [ -f "$LOCKFILE" ]; then
  echo "[atlcli-git] Sync daemon running, skipping auto-push"
  exit 0
fi

# Skip if no .atlcli directory (not initialized for atlcli)
if [ ! -d "$DOCS_DIR/.atlcli" ]; then
  exit 0
fi

# Push changes to Confluence
echo "[atlcli-git] Auto-pushing to Confluence..."
atlcli docs push "$DOCS_DIR" --quiet 2>&1 || {
  echo "[atlcli-git] Push failed (non-blocking)"
}

# Always exit 0 - don't block commits
exit 0
`;

/**
 * Get the path to the post-commit hook.
 */
async function getHookPath(dir: string): Promise<string> {
  const gitRoot = await getGitRoot(dir);
  return join(gitRoot, ".git", "hooks", "post-commit");
}

/**
 * Check if our hook is installed.
 */
async function isHookInstalled(hookPath: string): Promise<boolean> {
  if (!existsSync(hookPath)) {
    return false;
  }

  try {
    const content = await readFile(hookPath, "utf-8");
    return content.includes(HOOK_MARKER);
  } catch {
    return false;
  }
}

/**
 * Check if a hook file exists but is not ours.
 */
async function hasExistingHook(hookPath: string): Promise<boolean> {
  if (!existsSync(hookPath)) {
    return false;
  }

  try {
    const content = await readFile(hookPath, "utf-8");
    return !content.includes(HOOK_MARKER);
  } catch {
    return false;
  }
}

/**
 * Install the post-commit hook.
 */
export async function installHookHandler(ctx: CommandContext): Promise<void> {
  const dir = ctx.args[0] ? resolve(ctx.args[0]) : process.cwd();

  // Check if git repo
  if (!(await isGitRepo(dir))) {
    console.error("Error: Not a git repository");
    process.exitCode = 1;
    return;
  }

  // Check if .atlcli directory exists
  const atlcliDir = join(dir, ".atlcli");
  if (!existsSync(atlcliDir)) {
    console.error("Error: Directory not initialized for atlcli (missing .atlcli/)");
    console.error("Run 'atlcli docs init' first");
    process.exitCode = 1;
    return;
  }

  const hookPath = await getHookPath(dir);

  // Check if our hook is already installed
  if (await isHookInstalled(hookPath)) {
    if (ctx.output.json) {
      console.log(JSON.stringify({ status: "already_installed", path: hookPath }));
    } else {
      console.log("Hook already installed at:", hookPath);
    }
    return;
  }

  // Check for existing hook from another source
  if (await hasExistingHook(hookPath)) {
    const force = ctx.flags.force;
    if (!force) {
      console.error("Error: A post-commit hook already exists");
      console.error("Use --force to overwrite, or manually integrate the atlcli hook");
      process.exitCode = 1;
      return;
    }
    // Backup existing hook
    const backupPath = hookPath + ".backup";
    const existingContent = await readFile(hookPath, "utf-8");
    await writeFile(backupPath, existingContent);
    console.log("Backed up existing hook to:", backupPath);
  }

  // Write the hook
  await writeFile(hookPath, HOOK_SCRIPT);
  await chmod(hookPath, 0o755); // Make executable

  if (ctx.output.json) {
    console.log(JSON.stringify({ status: "installed", path: hookPath }));
  } else {
    console.log("Installed post-commit hook at:", hookPath);
    console.log("Changes will be auto-pushed to Confluence on commit.");
  }
}

/**
 * Remove the post-commit hook.
 */
export async function removeHookHandler(ctx: CommandContext): Promise<void> {
  const dir = ctx.args[0] ? resolve(ctx.args[0]) : process.cwd();

  // Check if git repo
  if (!(await isGitRepo(dir))) {
    console.error("Error: Not a git repository");
    process.exitCode = 1;
    return;
  }

  const hookPath = await getHookPath(dir);

  // Check if our hook is installed
  if (!(await isHookInstalled(hookPath))) {
    if (ctx.output.json) {
      console.log(JSON.stringify({ status: "not_installed" }));
    } else {
      console.log("Hook not installed (nothing to remove)");
    }
    return;
  }

  // Remove the hook
  await unlink(hookPath);

  // Restore backup if exists
  const backupPath = hookPath + ".backup";
  if (existsSync(backupPath)) {
    const backupContent = await readFile(backupPath, "utf-8");
    await writeFile(hookPath, backupContent);
    await chmod(hookPath, 0o755);
    await unlink(backupPath);
    console.log("Restored previous hook from backup");
  }

  if (ctx.output.json) {
    console.log(JSON.stringify({ status: "removed", path: hookPath }));
  } else {
    console.log("Removed post-commit hook from:", hookPath);
  }
}

/**
 * Show hook status.
 */
export async function statusHookHandler(ctx: CommandContext): Promise<void> {
  const dir = ctx.args[0] ? resolve(ctx.args[0]) : process.cwd();

  // Check if git repo
  if (!(await isGitRepo(dir))) {
    if (ctx.output.json) {
      console.log(JSON.stringify({ status: "not_git_repo" }));
    } else {
      console.log("Status: Not a git repository");
    }
    return;
  }

  const hookPath = await getHookPath(dir);
  const installed = await isHookInstalled(hookPath);
  const hasOther = await hasExistingHook(hookPath);

  // Check if .atlcli directory exists
  const atlcliDir = join(dir, ".atlcli");
  const initialized = existsSync(atlcliDir);

  // Check if sync daemon is running
  const lockFile = join(atlcliDir, ".sync.lock");
  const syncRunning = existsSync(lockFile);

  if (ctx.output.json) {
    console.log(
      JSON.stringify({
        installed,
        hookPath,
        hasOtherHook: hasOther,
        initialized,
        syncRunning,
      })
    );
  } else {
    console.log("Git hook status:");
    console.log("  Installed:", installed ? "Yes" : "No");
    console.log("  Hook path:", hookPath);
    if (hasOther) {
      console.log("  Note: Another hook exists (not from atlcli)");
    }
    console.log("  atlcli initialized:", initialized ? "Yes" : "No");
    if (syncRunning) {
      console.log("  Sync daemon: Running (hook will skip pushes)");
    }
  }
}
