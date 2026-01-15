/**
 * Plugin management commands.
 *
 * atlcli plugin list          - List installed plugins
 * atlcli plugin install <src> - Install a plugin
 * atlcli plugin remove <name> - Remove a plugin
 * atlcli plugin enable <name> - Enable a plugin
 * atlcli plugin disable <name>- Disable a plugin
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, cp, rm } from "node:fs/promises";
import {
  OutputOptions,
  output,
  fail,
  hasFlag,
  ERROR_CODES,
} from "@atlcli/core";
import {
  getPluginRegistry,
  getPluginsDir,
  loadPluginConfig,
  savePluginConfig,
  loadPluginFromPath,
} from "../plugins/loader.js";
import type { PluginMetadata } from "@atlcli/plugin-api";

export async function handlePlugin(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const sub = args[0];

  // Show help if no subcommand
  if (!sub) {
    output(pluginHelp(), opts);
    return;
  }

  switch (sub) {
    case "list":
      await handleList(opts);
      return;
    case "install":
      await handleInstall(args.slice(1), flags, opts);
      return;
    case "remove":
      await handleRemove(args.slice(1), opts);
      return;
    case "enable":
      await handleEnable(args.slice(1), opts);
      return;
    case "disable":
      await handleDisable(args.slice(1), opts);
      return;
    default:
      output(pluginHelp(), opts);
  }
}

async function handleList(opts: OutputOptions): Promise<void> {
  const registry = getPluginRegistry();

  if (opts.json) {
    const plugins = registry.getAllPlugins().map((p) => ({
      name: p.plugin.name,
      version: p.plugin.version,
      description: p.plugin.description,
      source: p.metadata.source,
      enabled: p.metadata.enabled,
      commands: p.plugin.commands?.map((c) => c.name) ?? [],
    }));
    output(JSON.stringify(plugins, null, 2), opts);
    return;
  }

  const plugins = registry.getAllPlugins();

  if (plugins.length === 0) {
    output("No plugins installed.", opts);
    output("", opts);
    output("Install a plugin with:", opts);
    output("  atlcli plugin install <path-to-plugin>", opts);
    return;
  }

  output("Installed plugins:", opts);
  output("", opts);

  for (const { plugin, metadata } of plugins) {
    const status = metadata.enabled ? "enabled" : "disabled";
    const commands = plugin.commands?.map((c) => c.name).join(", ") || "none";
    output(`  ${plugin.name}@${plugin.version} (${status})`, opts);
    if (plugin.description) {
      output(`    ${plugin.description}`, opts);
    }
    output(`    Source: ${metadata.source} (${metadata.location})`, opts);
    output(`    Commands: ${commands}`, opts);
    output("", opts);
  }
}

async function handleInstall(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const source = args[0];

  if (!source) {
    fail(opts, 1, ERROR_CODES.USAGE, "Usage: atlcli plugin install <path>");
  }

  // For now, only support local path installation
  // Future: support npm package names
  if (!existsSync(source)) {
    fail(opts, 1, ERROR_CODES.IO, `Plugin source not found: ${source}`);
  }

  // Load and validate the plugin
  let plugin;
  try {
    plugin = await loadPluginFromPath(source);
  } catch (err) {
    fail(opts, 1, ERROR_CODES.IO, `Failed to load plugin: ${err}`);
  }

  // Check if already installed
  const config = await loadPluginConfig();
  const existing = config.find((p) => p.name === plugin.name);
  if (existing) {
    fail(opts, 1, ERROR_CODES.CONFIG, `Plugin "${plugin.name}" is already installed`);
  }

  // Copy to plugins directory
  const pluginsDir = getPluginsDir();
  const targetDir = join(pluginsDir, plugin.name);

  if (!existsSync(pluginsDir)) {
    await mkdir(pluginsDir, { recursive: true });
  }

  if (existsSync(targetDir)) {
    await rm(targetDir, { recursive: true });
  }

  await cp(source, targetDir, { recursive: true });

  // Add to config
  const metadata: PluginMetadata = {
    name: plugin.name,
    version: plugin.version,
    source: "local",
    location: targetDir,
    enabled: true,
  };

  config.push(metadata);
  await savePluginConfig(config);

  // Register in current session
  const registry = getPluginRegistry();
  if (plugin.initialize) {
    await plugin.initialize();
  }
  registry.register(plugin, metadata);

  if (opts.json) {
    output(JSON.stringify({ installed: plugin.name, version: plugin.version }), opts);
  } else {
    output(`Installed plugin: ${plugin.name}@${plugin.version}`, opts);
    if (plugin.commands?.length) {
      output(`Commands: ${plugin.commands.map((c) => c.name).join(", ")}`, opts);
    }
  }
}

async function handleRemove(args: string[], opts: OutputOptions): Promise<void> {
  const name = args[0];

  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "Usage: atlcli plugin remove <name>");
  }

  const config = await loadPluginConfig();
  const index = config.findIndex((p) => p.name === name);

  if (index === -1) {
    fail(opts, 1, ERROR_CODES.CONFIG, `Plugin "${name}" is not installed`);
  }

  const metadata = config[index];

  // Remove from filesystem if local
  if (metadata.source === "local" && existsSync(metadata.location)) {
    await rm(metadata.location, { recursive: true });
  }

  // Remove from config
  config.splice(index, 1);
  await savePluginConfig(config);

  // Unregister from current session
  const registry = getPluginRegistry();
  const loaded = registry.getPlugin(name);
  if (loaded?.plugin.cleanup) {
    await loaded.plugin.cleanup();
  }
  registry.unregister(name);

  if (opts.json) {
    output(JSON.stringify({ removed: name }), opts);
  } else {
    output(`Removed plugin: ${name}`, opts);
  }
}

async function handleEnable(args: string[], opts: OutputOptions): Promise<void> {
  const name = args[0];

  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "Usage: atlcli plugin enable <name>");
  }

  const config = await loadPluginConfig();
  const plugin = config.find((p) => p.name === name);

  if (!plugin) {
    fail(opts, 1, ERROR_CODES.CONFIG, `Plugin "${name}" is not installed`);
  }

  if (plugin.enabled) {
    output(`Plugin "${name}" is already enabled`, opts);
    return;
  }

  plugin.enabled = true;
  await savePluginConfig(config);

  // Load into current session
  try {
    const loadedPlugin = await loadPluginFromPath(plugin.location);
    if (loadedPlugin.initialize) {
      await loadedPlugin.initialize();
    }
    getPluginRegistry().register(loadedPlugin, plugin);
  } catch (err) {
    output(`Warning: Plugin enabled but failed to load: ${err}`, opts);
  }

  if (opts.json) {
    output(JSON.stringify({ enabled: name }), opts);
  } else {
    output(`Enabled plugin: ${name}`, opts);
  }
}

async function handleDisable(args: string[], opts: OutputOptions): Promise<void> {
  const name = args[0];

  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "Usage: atlcli plugin disable <name>");
  }

  const config = await loadPluginConfig();
  const plugin = config.find((p) => p.name === name);

  if (!plugin) {
    fail(opts, 1, ERROR_CODES.CONFIG, `Plugin "${name}" is not installed`);
  }

  if (!plugin.enabled) {
    output(`Plugin "${name}" is already disabled`, opts);
    return;
  }

  plugin.enabled = false;
  await savePluginConfig(config);

  // Unload from current session
  const registry = getPluginRegistry();
  const loaded = registry.getPlugin(name);
  if (loaded?.plugin.cleanup) {
    await loaded.plugin.cleanup();
  }
  registry.unregister(name);

  if (opts.json) {
    output(JSON.stringify({ disabled: name }), opts);
  } else {
    output(`Disabled plugin: ${name}`, opts);
  }
}

function pluginHelp(): string {
  return `atlcli plugin <command>

Manage CLI plugins to extend functionality.

Commands:
  list            List installed plugins
  install <path>  Install a plugin from local path
  remove <name>   Remove an installed plugin
  enable <name>   Enable a disabled plugin
  disable <name>  Disable a plugin

Examples:
  atlcli plugin list
  atlcli plugin install ./my-plugin
  atlcli plugin remove my-plugin
  atlcli plugin enable my-plugin
  atlcli plugin disable my-plugin
`;
}
