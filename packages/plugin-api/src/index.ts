/**
 * @atlcli/plugin-api
 *
 * Plugin API for extending atlcli with custom commands and hooks.
 *
 * @example
 * ```typescript
 * import { definePlugin } from "@atlcli/plugin-api";
 *
 * export default definePlugin({
 *   name: "my-plugin",
 *   version: "1.0.0",
 *   description: "My custom atlcli plugin",
 *   commands: [{
 *     name: "mycommand",
 *     description: "Do something cool",
 *     subcommands: [{
 *       name: "action",
 *       description: "Perform an action",
 *       flags: [{ name: "verbose", alias: "v", description: "Verbose output" }],
 *       handler: async (ctx) => {
 *         if (ctx.flags.verbose) {
 *           console.log("Verbose mode enabled");
 *         }
 *         console.log("Action performed!");
 *       }
 *     }]
 *   }],
 *   hooks: {
 *     beforeCommand: async (ctx) => {
 *       console.log(`Running: ${ctx.command.join(" ")}`);
 *     }
 *   }
 * });
 * ```
 */

// Types
export type {
  AtlcliPlugin,
  CommandDefinition,
  Subcommand,
  FlagDefinition,
  CommandContext,
  OutputOptions,
  FlagValue,
  PluginHooks,
  PluginMetadata,
  PluginManifest,
} from "./types.js";

// Helpers
export {
  definePlugin,
  defineCommand,
  defineSubcommand,
  defineFlag,
} from "./define.js";
