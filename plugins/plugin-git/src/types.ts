/**
 * Types for plugin-git.
 *
 * Note: For production plugins, import these from "@atlcli/plugin-api"
 * This file defines types locally to avoid workspace dependency issues.
 */

/** Output options passed to commands */
export interface OutputOptions {
  json: boolean;
  quiet: boolean;
}

/** Flag value types */
export type FlagValue = string | number | boolean | undefined;

/** Context passed to command handlers and hooks */
export interface CommandContext {
  /** Full command path (e.g., ["docs", "pull"]) */
  command: string[];

  /** Positional arguments */
  args: string[];

  /** Parsed flags */
  flags: Record<string, FlagValue>;

  /** Output options */
  output: OutputOptions;

  /** Optional abort signal */
  signal?: AbortSignal;
}

/** Plugin hooks interface */
export interface PluginHooks {
  /** Called before any command executes */
  beforeCommand?: (ctx: CommandContext) => Promise<void>;

  /** Called after successful command execution */
  afterCommand?: (ctx: CommandContext) => Promise<void>;

  /** Called when a command fails */
  onError?: (ctx: CommandContext, error: Error) => Promise<void>;
}

/** Flag definition for commands */
export interface FlagDefinition {
  name: string;
  alias?: string;
  description: string;
  hasValue?: boolean;
  default?: FlagValue;
}

/** Subcommand definition */
export interface Subcommand {
  name: string;
  description: string;
  flags?: FlagDefinition[];
  handler: (ctx: CommandContext) => Promise<void>;
}

/** Command definition (top-level command with subcommands) */
export interface CommandDefinition {
  name: string;
  description: string;
  subcommands?: Subcommand[];
}

/** Full plugin interface */
export interface AtlcliPlugin {
  name: string;
  version: string;
  description?: string;

  /** Commands provided by this plugin */
  commands?: CommandDefinition[];

  /** Lifecycle hooks */
  hooks?: PluginHooks;

  /** Called when plugin is loaded */
  initialize?: () => Promise<void>;

  /** Called when plugin is unloaded */
  cleanup?: () => Promise<void>;
}
