/**
 * Plugin API types for atlcli extensibility.
 *
 * Plugins can:
 * - Add new top-level commands
 * - Add subcommands to existing commands
 * - Hook into command lifecycle (before/after/error)
 */

/** Output options passed to command handlers */
export interface OutputOptions {
  json: boolean;
}

/** Parsed flag from command line */
export type FlagValue = string | boolean;

/** Context passed to command handlers and hooks */
export interface CommandContext {
  /** The full command path (e.g., ["confluence", "page", "get"]) */
  command: string[];
  /** Positional arguments after the command */
  args: string[];
  /** Parsed flags */
  flags: Record<string, FlagValue>;
  /** Output options */
  output: OutputOptions;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/** Flag definition for a command */
export interface FlagDefinition {
  /** Flag name (without --) */
  name: string;
  /** Short alias (single char, without -) */
  alias?: string;
  /** Description for help text */
  description: string;
  /** Whether flag takes a value (default: false = boolean flag) */
  hasValue?: boolean;
  /** Default value if not provided */
  default?: FlagValue;
  /** Whether this flag is required */
  required?: boolean;
}

/** Subcommand definition */
export interface Subcommand {
  /** Subcommand name (e.g., "list", "get", "create") */
  name: string;
  /** Description for help text */
  description: string;
  /** Available flags for this subcommand */
  flags?: FlagDefinition[];
  /** Usage examples */
  examples?: string[];
  /** Handler function */
  handler: (ctx: CommandContext) => Promise<void>;
}

/** Top-level command definition */
export interface CommandDefinition {
  /** Command name (e.g., "bitbucket", "github") */
  name: string;
  /** Description for help text */
  description: string;
  /** Subcommands */
  subcommands?: Subcommand[];
  /** Global flags for all subcommands */
  flags?: FlagDefinition[];
  /** Handler for command without subcommand (shows help by default) */
  handler?: (ctx: CommandContext) => Promise<void>;
}

/** Hook functions for extending existing commands */
export interface PluginHooks {
  /**
   * Called before any command executes.
   * Can modify context or throw to prevent execution.
   */
  beforeCommand?: (ctx: CommandContext) => Promise<void>;

  /**
   * Called after a command completes successfully.
   */
  afterCommand?: (ctx: CommandContext) => Promise<void>;

  /**
   * Called when a command throws an error.
   * Can handle or re-throw the error.
   */
  onError?: (ctx: CommandContext, error: Error) => Promise<void>;
}

/** Plugin definition */
export interface AtlcliPlugin {
  /** Unique plugin name (used for identification) */
  name: string;
  /** Plugin version (semver) */
  version: string;
  /** Human-readable description */
  description?: string;

  /** New commands to register */
  commands?: CommandDefinition[];

  /** Hooks into command lifecycle */
  hooks?: PluginHooks;

  /**
   * Called when plugin is loaded.
   * Use for async initialization.
   */
  initialize?: () => Promise<void>;

  /**
   * Called when plugin is unloaded.
   * Use for cleanup.
   */
  cleanup?: () => Promise<void>;
}

/** Plugin metadata stored in config */
export interface PluginMetadata {
  /** Plugin name */
  name: string;
  /** Plugin version */
  version: string;
  /** How the plugin was installed */
  source: "npm" | "local" | "builtin";
  /** Path or package name */
  location: string;
  /** Whether plugin is enabled */
  enabled: boolean;
}

/** Plugin manifest in package.json */
export interface PluginManifest {
  name: string;
  version: string;
  atlcli?: {
    plugin: boolean;
  };
}
