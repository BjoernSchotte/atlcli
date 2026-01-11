import { hasFlag, output, parseArgs } from "@atlcli/core";
import type { CommandContext } from "@atlcli/plugin-api";
import { handleAuth } from "./commands/auth.js";
import { handlePage } from "./commands/page.js";
import { handleSpace } from "./commands/space.js";
import { handleDocs } from "./commands/docs.js";
import { handlePlugin } from "./commands/plugin.js";
import { handleSearch } from "./commands/search.js";
import { initializePlugins, getPluginRegistry } from "./plugins/loader.js";

const VERSION = "0.2.0";

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const [command, ...rest] = parsed._;
  const json = hasFlag(parsed.flags, "json");
  const opts = { json };

  // Initialize plugins (gracefully handles errors)
  await initializePlugins();
  const registry = getPluginRegistry();

  if (!command) {
    output(rootHelp(registry), opts);
    return;
  }

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
    process.stderr.write(`Hook error: ${message}\n`);
    process.exit(1);
  }

  try {
    // Built-in commands
    switch (command) {
      case "auth":
        await handleAuth(rest, parsed.flags, opts);
        break;
      case "page":
        await handlePage(rest, parsed.flags, opts);
        break;
      case "space":
        await handleSpace(rest, parsed.flags, opts);
        break;
      case "docs":
        await handleDocs(rest, parsed.flags, opts);
        break;
      case "plugin":
        await handlePlugin(rest, parsed.flags, opts);
        break;
      case "search":
        await handleSearch(rest, parsed.flags, opts);
        break;
      case "version":
        output({ version: VERSION }, opts);
        break;
      default:
        // Check for plugin commands
        const pluginCmd = registry.getCommand(command);
        if (pluginCmd) {
          await executePluginCommand(pluginCmd, rest, parsed.flags, opts);
        } else {
          output(rootHelp(registry), opts);
        }
    }

    // Run afterCommand hooks
    await registry.runAfterHooks(ctx);
  } catch (err) {
    // Run error hooks
    await registry.runErrorHooks(ctx, err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

async function executePluginCommand(
  cmd: import("@atlcli/plugin-api").CommandDefinition,
  args: string[],
  flags: Record<string, string | boolean>,
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

  return `atlcli <command>

Commands:
  auth        Authenticate and manage profiles
  space       Confluence space operations
  page        Confluence page operations
  docs        Confluence docs sync (pull/push)
  search      Search Confluence content
  plugin      Manage plugins
  version     Show version
${pluginSection}
Global options:
  --json      JSON output
  --help      Show help
`;
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
