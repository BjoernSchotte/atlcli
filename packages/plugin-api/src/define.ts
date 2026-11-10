/**
 * Helper functions for defining plugins.
 */

import type { AtlcliPlugin, CommandDefinition } from "./types.js";

/**
 * Define an atlcli plugin.
 * This is the main entry point for plugin authors.
 *
 * @example
 * ```typescript
 * import { definePlugin } from "@atlcli/plugin-api";
 *
 * export default definePlugin({
 *   name: "my-plugin",
 *   version: "1.0.0",
 *   commands: [{
 *     name: "hello",
 *     description: "Say hello",
 *     subcommands: [{
 *       name: "world",
 *       description: "Say hello world",
 *       handler: async (ctx) => {
 *         console.log("Hello, world!");
 *       }
 *     }]
 *   }]
 * });
 * ```
 */
export function definePlugin(plugin: AtlcliPlugin): AtlcliPlugin {
  // Validate plugin
  if (!plugin.name) {
    throw new Error("Plugin must have a name");
  }
  if (!plugin.version) {
    throw new Error("Plugin must have a version");
  }
  if (!/^\d+\.\d+\.\d+/.test(plugin.version)) {
    throw new Error("Plugin version must be semver format");
  }

  // Validate commands
  if (plugin.commands) {
    for (const cmd of plugin.commands) {
      validateCommand(cmd);
    }
  }

  return plugin;
}

/**
 * Helper to define a command.
 */
export function defineCommand(command: CommandDefinition): CommandDefinition {
  validateCommand(command);
  return command;
}

function validateCommand(cmd: CommandDefinition): void {
  if (!cmd.name) {
    throw new Error("Command must have a name");
  }
  if (!/^[a-z][a-z0-9-]*$/.test(cmd.name)) {
    throw new Error(`Command name "${cmd.name}" must be lowercase alphanumeric with hyphens`);
  }
  if (cmd.subcommands) {
    for (const sub of cmd.subcommands) {
      if (!sub.name) {
        throw new Error(`Subcommand of "${cmd.name}" must have a name`);
      }
      if (!sub.handler) {
        throw new Error(`Subcommand "${cmd.name} ${sub.name}" must have a handler`);
      }
    }
  }
}
