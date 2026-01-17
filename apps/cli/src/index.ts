import {
  hasFlag,
  output,
  parseArgs,
  loadConfig,
  configureLogging,
  getLogger,
  Logger,
  isInteractive,
  getCurrentVersion,
  checkForUpdates,
  loadUpdateState,
  saveUpdateState,
  shouldCheckForUpdates,
  getFlagValue,
} from "@atlcli/core";
import type { CommandContext } from "@atlcli/plugin-api";
import { handleAuth } from "./commands/auth.js";
import { handleCompletion } from "./commands/completion.js";
import { handleConfig } from "./commands/config.js";
import { handleDoctor } from "./commands/doctor.js";
import { handleFlag } from "./commands/flag.js";
import { handleUpdate } from "./commands/update.js";
import { handleWiki } from "./commands/wiki.js";
import { handleLog } from "./commands/log.js";
import { handlePlugin } from "./commands/plugin.js";
import { handleJira } from "./commands/jira.js";
import { handleHelloworld } from "./commands/helloworld.js";
import { initializePlugins, getPluginRegistry } from "./plugins/loader.js";

const VERSION = getCurrentVersion();

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const [command, ...rest] = parsed._;
  const json = hasFlag(parsed.flags, "json");
  const noLog = hasFlag(parsed.flags, "no-log");
  const helpRequested = hasFlag(parsed.flags, "help") || hasFlag(parsed.flags, "h");
  const versionRequested = hasFlag(parsed.flags, "version") || hasFlag(parsed.flags, "v");
  const opts = { json };
  const startTime = Date.now();

  // Initialize logging (unless --no-log is specified)
  if (!noLog) {
    try {
      const config = await loadConfig();
      configureLogging({
        level: config.logging?.level ?? "info",
        enableGlobal: config.logging?.global ?? true,
        enableProject: config.logging?.project ?? true,
        projectDir: process.cwd(),
      });
    } catch {
      // Ignore config load errors for logging
      configureLogging({
        level: "info",
        enableGlobal: true,
        enableProject: true,
        projectDir: process.cwd(),
      });
    }
  } else {
    Logger.disable();
  }

  const logger = getLogger();

  // Initialize plugins (gracefully handles errors)
  await initializePlugins();
  const registry = getPluginRegistry();

  // Global version: show version if --version/-v flag
  if (versionRequested) {
    output({ version: VERSION }, opts);
    return;
  }

  // Global help: show root help if --help/-h with no command
  if (!command || (helpRequested && !command)) {
    output(rootHelp(registry), opts);
    return;
  }

  // Command-level help: show command-specific help
  if (helpRequested) {
    showCommandHelp(command, rest, registry, opts);
    return;
  }

  // Log command start
  logger.command({
    command: [command, ...rest],
    args: rest,
    flags: parsed.flags,
    cwd: process.cwd(),
  });

  // Build command context for hooks
  const ctx: CommandContext = {
    command: [command, ...rest],
    args: rest,
    flags: parsed.flags,
    output: opts,
  };

  // Run beforeCommand hooks
  try {
    await registry.runBeforeHooks(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(err instanceof Error ? err : new Error(message), {
      command: [command, ...rest],
    });
    process.stderr.write(`Hook error: ${message}\n`);
    process.exit(1);
  }

  try {
    // Built-in commands
    switch (command) {
      case "auth":
        await handleAuth(rest, parsed.flags, opts);
        break;
      case "completion":
        await handleCompletion(rest, parsed.flags, opts);
        break;
      case "config":
        await handleConfig(rest, parsed.flags, opts);
        break;
      case "doctor":
        await handleDoctor(rest, parsed.flags, opts);
        break;
      case "flag":
        await handleFlag(rest, parsed.flags, opts);
        break;
      case "wiki":
        await handleWiki(rest, parsed.flags, opts);
        break;
      case "jira":
        await handleJira(rest, parsed.flags, opts);
        break;
      case "log":
        await handleLog(rest, parsed.flags, opts);
        break;
      case "plugin":
        await handlePlugin(rest, parsed.flags, opts);
        break;
      case "update":
        await handleUpdate(rest, parsed.flags, opts);
        break;
      case "version":
        output({ version: VERSION }, opts);
        break;
      case "helloworld": {
        const helloworldEnabled = await getFlagValue<boolean>("helloworld", false);
        if (helloworldEnabled) {
          await handleHelloworld(rest, parsed.flags, opts);
        } else {
          output(rootHelp(registry), opts);
        }
        break;
      }
      default:
        // Check for plugin commands
        const pluginCmd = registry.getCommand(command);
        if (pluginCmd) {
          await executePluginCommand(pluginCmd, rest, parsed.flags, opts);
        } else {
          output(rootHelp(registry), opts);
        }
    }

    // Log command result
    logger.result({
      command: [command, ...rest],
      exitCode: 0,
      durationMs: Date.now() - startTime,
    });

    // Run afterCommand hooks
    await registry.runAfterHooks(ctx);

    // Check for updates (non-blocking, interactive only)
    // Skip in: CI/CD, non-interactive, JSON output, explicitly disabled, or when running update command
    if (
      command !== "update" &&
      isInteractive() &&
      !json &&
      !process.env.ATLCLI_DISABLE_UPDATE_CHECK
    ) {
      checkAndNotifyUpdate().catch(() => {}); // Ignore errors silently
    }
  } catch (err) {
    // Log error and result
    logger.error(err instanceof Error ? err : new Error(String(err)), {
      command: [command, ...rest],
    });
    logger.result({
      command: [command, ...rest],
      exitCode: 1,
      durationMs: Date.now() - startTime,
    });

    // Run error hooks
    await registry.runErrorHooks(ctx, err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

/**
 * Show help for a specific command.
 * Passes args to handler with help flag so nested subcommands can show their help.
 */
function showCommandHelp(
  command: string,
  subArgs: string[],
  registry: import("./plugins/loader.js").PluginRegistry,
  opts: { json: boolean }
): void {
  const helpFlags = { help: true };

  switch (command) {
    case "auth":
      handleAuth(subArgs, helpFlags, opts);
      break;
    case "completion":
      handleCompletion(subArgs, helpFlags, opts);
      break;
    case "config":
      handleConfig(subArgs, helpFlags, opts);
      break;
    case "doctor":
      handleDoctor(subArgs, helpFlags, opts);
      break;
    case "flag":
      handleFlag(subArgs, helpFlags, opts);
      break;
    case "wiki":
      handleWiki(subArgs, helpFlags, opts);
      break;
    case "jira":
      handleJira(subArgs, helpFlags, opts);
      break;
    case "log":
      handleLog(subArgs, helpFlags, opts);
      break;
    case "plugin":
      handlePlugin(subArgs, helpFlags, opts);
      break;
    case "update":
      handleUpdate(subArgs, helpFlags, opts);
      break;
    case "version":
      output({ version: VERSION }, opts);
      break;
    default:
      // Check for plugin commands
      const pluginCmd = registry.getCommand(command);
      if (pluginCmd) {
        output(pluginCommandHelp(pluginCmd), opts);
      } else {
        output(rootHelp(registry), opts);
      }
  }
}

async function executePluginCommand(
  cmd: import("@atlcli/plugin-api").CommandDefinition,
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: { json: boolean }
): Promise<void> {
  const [subcommand, ...subArgs] = args;

  // If no subcommand or help requested, show command help
  if (!subcommand || hasFlag(flags, "help")) {
    output(pluginCommandHelp(cmd), opts);
    return;
  }

  // Find subcommand
  const sub = cmd.subcommands?.find((s) => s.name === subcommand);
  if (!sub) {
    output(`Unknown subcommand: ${subcommand}`, opts);
    output("", opts);
    output(pluginCommandHelp(cmd), opts);
    return;
  }

  // Build context
  const ctx: CommandContext = {
    command: [cmd.name, subcommand],
    args: subArgs,
    flags,
    output: opts,
  };

  // Execute handler
  await sub.handler(ctx);
}

function pluginCommandHelp(cmd: import("@atlcli/plugin-api").CommandDefinition): string {
  const lines: string[] = [];
  lines.push(`atlcli ${cmd.name} <subcommand>`);
  lines.push("");
  lines.push(cmd.description);
  lines.push("");
  lines.push("Subcommands:");

  for (const sub of cmd.subcommands || []) {
    lines.push(`  ${sub.name.padEnd(16)} ${sub.description}`);
  }

  return lines.join("\n");
}

function rootHelp(registry: import("./plugins/loader.js").PluginRegistry): string {
  const pluginCommands = registry.getAllCommands();
  const pluginSection = pluginCommands.length > 0
    ? `
Plugin commands:
${pluginCommands.map((c) => `  ${c.name.padEnd(12)} ${c.command.description}`).join("\n")}
`
    : "";

  return `atlcli v${VERSION} • https://atlcli.sh • © Björn Schotte

atlcli <command>

Commands:
  auth        Authenticate and manage profiles
  completion  Generate shell completion scripts
  config      Manage CLI configuration
  doctor      Diagnose common issues
  flag        Manage feature flags
  wiki        Confluence operations (page, space, docs, search)
  jira        Jira operations (issue, board, sprint, epic)
  log         Query and manage logs
  plugin      Manage plugins
  update      Check for and install updates
  version     Show version
${pluginSection}
Global options:
  --profile <name>   Use specific auth profile
  --json             JSON output
  --no-log           Disable logging for this command
  --help, -h         Show help
  --version, -v      Show version
`;
}

/**
 * Check for updates and notify user if available (non-blocking).
 * Only checks once per day to avoid excessive API calls.
 */
async function checkAndNotifyUpdate(): Promise<void> {
  try {
    const state = await loadUpdateState();

    // Only check once per day
    if (!shouldCheckForUpdates(state)) {
      return;
    }

    const info = await checkForUpdates();

    // Save check time
    await saveUpdateState({ lastCheck: new Date().toISOString() });

    if (info.updateAvailable) {
      process.stderr.write(
        `\nUpdate available: ${info.currentVersion} → ${info.latestVersion}. Run: atlcli update\n`
      );
    }
  } catch {
    // Silently ignore update check errors
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
