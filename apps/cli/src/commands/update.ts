/**
 * Update command for atlcli.
 *
 * atlcli update           - Check for updates and install if available
 * atlcli update --check   - Check only, don't install
 * atlcli update v0.5.0    - Install specific version
 */

import {
  output,
  hasFlag,
  checkForUpdates,
  installUpdate,
  loadUpdateState,
  saveUpdateState,
  getCurrentVersion,
  detectInstallMethod,
} from "@atlcli/core";
import type { OutputOptions } from "@atlcli/core";

export async function handleUpdate(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const checkOnly = hasFlag(flags, "check");
  const targetVersion = args[0]; // e.g., "v0.5.0" or undefined for latest

  const installMethod = detectInstallMethod();

  // Handle Homebrew installs
  if (installMethod === "homebrew" && !targetVersion) {
    const info = await checkForUpdates();

    if (opts.json) {
      output(
        {
          schemaVersion: "1",
          currentVersion: info.currentVersion,
          latestVersion: info.latestVersion,
          updateAvailable: info.updateAvailable,
          installMethod: "homebrew",
          updateCommand: "brew update && brew upgrade atlcli",
        },
        opts
      );
      return;
    }

    if (info.updateAvailable) {
      output(`Update available: ${info.currentVersion} → ${info.latestVersion}`, opts);
    } else {
      output(`atlcli ${info.currentVersion} is up to date.`, opts);
    }
    output("", opts);
    output("Installed via Homebrew. To update, run:", opts);
    output("  brew update && brew upgrade atlcli", opts);
    return;
  }

  // Handle source/development installs
  if (installMethod === "source" && !targetVersion) {
    const info = await checkForUpdates();

    if (opts.json) {
      output(
        {
          schemaVersion: "1",
          currentVersion: info.currentVersion,
          latestVersion: info.latestVersion,
          updateAvailable: info.updateAvailable,
          installMethod: "source",
          updateCommand: "git pull && bun run build",
        },
        opts
      );
      return;
    }

    if (info.updateAvailable) {
      output(`Update available: ${info.currentVersion} → ${info.latestVersion}`, opts);
    } else {
      output(`atlcli ${info.currentVersion} is up to date.`, opts);
    }
    output("", opts);
    output("Running from source. To update, run:", opts);
    output("  git pull && bun run build", opts);
    return;
  }

  // Handle unknown install method
  if (installMethod === "unknown" && !targetVersion) {
    const info = await checkForUpdates();

    if (opts.json) {
      output(
        {
          schemaVersion: "1",
          currentVersion: info.currentVersion,
          latestVersion: info.latestVersion,
          updateAvailable: info.updateAvailable,
          installMethod: "unknown",
          error: "Cannot determine installation method",
        },
        opts
      );
      return;
    }

    if (info.updateAvailable) {
      output(`Update available: ${info.currentVersion} → ${info.latestVersion}`, opts);
    } else {
      output(`atlcli ${info.currentVersion} is up to date.`, opts);
    }
    output("", opts);
    output("Cannot determine installation method.", opts);
    output("Please reinstall using:", opts);
    output("  curl -fsSL https://atlcli.sh/install.sh | bash", opts);
    return;
  }

  // Script installs - can auto-update
  try {
    const info = await checkForUpdates();

    // Update last check time
    await saveUpdateState({ lastCheck: new Date().toISOString() });

    // Check only mode
    if (checkOnly && !targetVersion) {
      if (opts.json) {
        output(
          {
            schemaVersion: "1",
            currentVersion: info.currentVersion,
            latestVersion: info.latestVersion,
            updateAvailable: info.updateAvailable,
            installMethod: info.installMethod,
          },
          opts
        );
        return;
      }

      if (info.updateAvailable) {
        output(`Update available: ${info.currentVersion} → ${info.latestVersion}`, opts);
        output("Run 'atlcli update' to install.", opts);
      } else {
        output(`atlcli ${info.currentVersion} is up to date.`, opts);
      }
      return;
    }

    // No update available and no specific version requested
    if (!info.updateAvailable && !targetVersion) {
      if (opts.json) {
        output(
          {
            schemaVersion: "1",
            currentVersion: info.currentVersion,
            latestVersion: info.latestVersion,
            updateAvailable: false,
            installMethod: info.installMethod,
          },
          opts
        );
        return;
      }

      output(`atlcli ${info.currentVersion} is up to date.`, opts);
      return;
    }

    // Install update
    const versionToInstall = targetVersion || info.latestVersion;

    if (!opts.json) {
      output(`Updating atlcli to ${versionToInstall}...`, opts);
    }

    const installedVersion = await installUpdate(targetVersion);

    if (opts.json) {
      output(
        {
          schemaVersion: "1",
          success: true,
          previousVersion: info.currentVersion,
          installedVersion,
        },
        opts
      );
      return;
    }

    output(`Successfully updated to ${installedVersion}`, opts);
    output("Restart your shell or run a new command to use the updated version.", opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (opts.json) {
      output(
        {
          schemaVersion: "1",
          success: false,
          error: message,
        },
        opts
      );
      return;
    }

    output(`Update failed: ${message}`, opts);
    process.exit(1);
  }
}

function updateHelp(): string {
  return `atlcli update [version] [options]

Check for and install updates.

Arguments:
  version         Specific version to install (e.g., v0.5.0)

Options:
  --check         Check for updates without installing
  --json          JSON output

Examples:
  atlcli update              # Update to latest version
  atlcli update --check      # Check if update is available
  atlcli update v0.5.0       # Install specific version
  atlcli update --json       # JSON output for scripting

Environment:
  ATLCLI_DISABLE_UPDATE_CHECK=1   Disable automatic update checks
`;
}
