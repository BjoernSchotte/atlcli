/**
 * Plugin loader for atlcli.
 *
 * Discovers and loads plugins from:
 * 1. ~/.atlcli/plugins/ directory (local plugins)
 * 2. Configured plugins in ~/.atlcli/config.json
 */

import { join } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type {
  AtlcliPlugin,
  CommandDefinition,
  PluginMetadata,
  PluginHooks,
  CommandContext,
} from "@atlcli/plugin-api";

/** Loaded plugin with metadata */
export interface LoadedPlugin {
  plugin: AtlcliPlugin;
  metadata: PluginMetadata;
}

/** Plugin registry manages all loaded plugins */
export class PluginRegistry {
  private plugins: Map<string, LoadedPlugin> = new Map();
  private commands: Map<string, { plugin: string; command: CommandDefinition }> = new Map();
  private hooks: {
    beforeCommand: Array<{ plugin: string; hook: NonNullable<PluginHooks["beforeCommand"]> }>;
    afterCommand: Array<{ plugin: string; hook: NonNullable<PluginHooks["afterCommand"]> }>;
    onError: Array<{ plugin: string; hook: NonNullable<PluginHooks["onError"]> }>;
  } = {
    beforeCommand: [],
    afterCommand: [],
    onError: [],
  };

  /** Register a plugin */
  register(plugin: AtlcliPlugin, metadata: PluginMetadata): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered`);
    }

    // Register commands
    if (plugin.commands) {
      for (const cmd of plugin.commands) {
        if (this.commands.has(cmd.name)) {
          const existing = this.commands.get(cmd.name)!;
          throw new Error(
            `Command "${cmd.name}" from plugin "${plugin.name}" conflicts with plugin "${existing.plugin}"`
          );
        }
        this.commands.set(cmd.name, { plugin: plugin.name, command: cmd });
      }
    }

    // Register hooks
    if (plugin.hooks) {
      if (plugin.hooks.beforeCommand) {
        this.hooks.beforeCommand.push({ plugin: plugin.name, hook: plugin.hooks.beforeCommand });
      }
      if (plugin.hooks.afterCommand) {
        this.hooks.afterCommand.push({ plugin: plugin.name, hook: plugin.hooks.afterCommand });
      }
      if (plugin.hooks.onError) {
        this.hooks.onError.push({ plugin: plugin.name, hook: plugin.hooks.onError });
      }
    }

    this.plugins.set(plugin.name, { plugin, metadata });
  }

  /** Unregister a plugin */
  unregister(name: string): void {
    const loaded = this.plugins.get(name);
    if (!loaded) return;

    // Remove commands
    for (const [cmdName, info] of this.commands) {
      if (info.plugin === name) {
        this.commands.delete(cmdName);
      }
    }

    // Remove hooks
    this.hooks.beforeCommand = this.hooks.beforeCommand.filter((h) => h.plugin !== name);
    this.hooks.afterCommand = this.hooks.afterCommand.filter((h) => h.plugin !== name);
    this.hooks.onError = this.hooks.onError.filter((h) => h.plugin !== name);

    this.plugins.delete(name);
  }

  /** Get a command by name */
  getCommand(name: string): CommandDefinition | null {
    return this.commands.get(name)?.command ?? null;
  }

  /** Get all registered commands */
  getAllCommands(): Array<{ name: string; plugin: string; command: CommandDefinition }> {
    return Array.from(this.commands.entries()).map(([name, info]) => ({
      name,
      plugin: info.plugin,
      command: info.command,
    }));
  }

  /** Get all loaded plugins */
  getAllPlugins(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }

  /** Get a plugin by name */
  getPlugin(name: string): LoadedPlugin | null {
    return this.plugins.get(name) ?? null;
  }

  /** Run beforeCommand hooks */
  async runBeforeHooks(ctx: CommandContext): Promise<void> {
    for (const { hook } of this.hooks.beforeCommand) {
      await hook(ctx);
    }
  }

  /** Run afterCommand hooks */
  async runAfterHooks(ctx: CommandContext): Promise<void> {
    for (const { hook } of this.hooks.afterCommand) {
      await hook(ctx);
    }
  }

  /** Run onError hooks */
  async runErrorHooks(ctx: CommandContext, error: Error): Promise<void> {
    for (const { hook } of this.hooks.onError) {
      await hook(ctx, error);
    }
  }

  /** Check if a command exists */
  hasCommand(name: string): boolean {
    return this.commands.has(name);
  }
}

/** Get the plugins directory path */
export function getPluginsDir(): string {
  return join(homedir(), ".atlcli", "plugins");
}

/** Get plugin config path */
export function getPluginConfigPath(): string {
  return join(homedir(), ".atlcli", "plugins.json");
}

/** Load plugin config */
export async function loadPluginConfig(): Promise<PluginMetadata[]> {
  const configPath = getPluginConfigPath();
  if (!existsSync(configPath)) {
    return [];
  }
  try {
    const content = await readFile(configPath, "utf-8");
    const config = JSON.parse(content);
    return Array.isArray(config.plugins) ? config.plugins : [];
  } catch {
    return [];
  }
}

/** Save plugin config */
export async function savePluginConfig(plugins: PluginMetadata[]): Promise<void> {
  const configPath = getPluginConfigPath();
  const dir = join(homedir(), ".atlcli");
  if (!existsSync(dir)) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(configPath, JSON.stringify({ plugins }, null, 2) + "\n");
}

/** Load a plugin from a path */
export async function loadPluginFromPath(pluginPath: string): Promise<AtlcliPlugin> {
  try {
    // Check if it's a directory with package.json
    const stats = await stat(pluginPath);
    let entryPoint = pluginPath;

    if (stats.isDirectory()) {
      const pkgPath = join(pluginPath, "package.json");
      if (existsSync(pkgPath)) {
        const pkgContent = await readFile(pkgPath, "utf-8");
        const pkg = JSON.parse(pkgContent);
        // Use exports or main field
        const entry = pkg.exports?.["."] || pkg.main || "src/index.ts";
        entryPoint = join(pluginPath, entry);
      } else {
        entryPoint = join(pluginPath, "index.ts");
      }
    }

    // Import the plugin
    const module = await import(entryPoint);
    const plugin = module.default || module;

    // Validate it's a proper plugin
    if (!plugin.name || !plugin.version) {
      throw new Error("Invalid plugin: missing name or version");
    }

    return plugin as AtlcliPlugin;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load plugin from ${pluginPath}: ${message}`);
  }
}

/** Discover plugins in the plugins directory */
export async function discoverLocalPlugins(): Promise<Array<{ path: string; name: string }>> {
  const pluginsDir = getPluginsDir();
  if (!existsSync(pluginsDir)) {
    return [];
  }

  const entries = await readdir(pluginsDir, { withFileTypes: true });
  const plugins: Array<{ path: string; name: string }> = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const pluginPath = join(pluginsDir, entry.name);
      const pkgPath = join(pluginPath, "package.json");

      if (existsSync(pkgPath)) {
        try {
          const pkgContent = await readFile(pkgPath, "utf-8");
          const pkg = JSON.parse(pkgContent);
          if (pkg.atlcli?.plugin) {
            plugins.push({ path: pluginPath, name: pkg.name || entry.name });
          }
        } catch {
          // Skip invalid packages
        }
      }
    }
  }

  return plugins;
}

/** Load all configured and discovered plugins */
export async function loadAllPlugins(registry: PluginRegistry): Promise<void> {
  // Load from config
  const config = await loadPluginConfig();
  for (const meta of config) {
    if (!meta.enabled) continue;

    try {
      const plugin = await loadPluginFromPath(meta.location);
      if (plugin.initialize) {
        await plugin.initialize();
      }
      registry.register(plugin, meta);
    } catch (err) {
      // Log but don't fail - plugin loading should be graceful
      console.error(`Warning: Failed to load plugin "${meta.name}": ${err}`);
    }
  }

  // Discover local plugins not in config
  const localPlugins = await discoverLocalPlugins();
  // Track loaded plugin locations to avoid duplicates
  const loadedLocations = new Set(config.map((m) => m.location));

  for (const { path, name } of localPlugins) {
    // Skip if already loaded from config (by path or name)
    if (loadedLocations.has(path)) continue;
    if (registry.getPlugin(name)) continue;

    try {
      const plugin = await loadPluginFromPath(path);
      // Also check by plugin's internal name
      if (registry.getPlugin(plugin.name)) continue;

      if (plugin.initialize) {
        await plugin.initialize();
      }
      registry.register(plugin, {
        name: plugin.name,
        version: plugin.version,
        source: "local",
        location: path,
        enabled: true,
      });
    } catch (err) {
      console.error(`Warning: Failed to load local plugin at ${path}: ${err}`);
    }
  }
}

/** Global plugin registry instance */
let globalRegistry: PluginRegistry | null = null;

/** Get or create the global plugin registry */
export function getPluginRegistry(): PluginRegistry {
  if (!globalRegistry) {
    globalRegistry = new PluginRegistry();
  }
  return globalRegistry;
}

/** Initialize plugins (call once at startup) */
export async function initializePlugins(): Promise<PluginRegistry> {
  const registry = getPluginRegistry();
  await loadAllPlugins(registry);
  return registry;
}
