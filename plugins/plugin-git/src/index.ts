/**
 * plugin-git - Git integration for atlcli Confluence sync.
 *
 * Features:
 * 1. Auto-commit: Automatically commits changes after `docs pull`
 * 2. Git hooks: Install post-commit hook for auto-push to Confluence
 *
 * Usage:
 *   atlcli plugin install ./plugins/plugin-git
 *   atlcli git hook install     # Enable auto-push on commit
 *   atlcli git hook status      # Check hook status
 *   atlcli git hook remove      # Disable auto-push
 */

import { autoCommitAfterPull } from "./auto-commit.js";
import {
  installHookHandler,
  removeHookHandler,
  statusHookHandler,
} from "./git-hooks.js";
import type { AtlcliPlugin, CommandDefinition, Subcommand } from "./types.js";

// Nested subcommand structure for git hook commands
const hookSubcommands: Subcommand[] = [
  {
    name: "install",
    description: "Install post-commit hook for auto-push to Confluence",
    flags: [
      {
        name: "force",
        alias: "f",
        description: "Overwrite existing hook",
      },
    ],
    handler: installHookHandler,
  },
  {
    name: "remove",
    description: "Remove the post-commit hook",
    handler: removeHookHandler,
  },
  {
    name: "status",
    description: "Show git hook status",
    handler: statusHookHandler,
  },
];

// Git command with nested subcommands
const gitCommands: CommandDefinition[] = [
  {
    name: "git",
    description: "Git integration commands",
    subcommands: [
      {
        name: "hook",
        description: "Manage git hooks for auto-push",
        // Note: nested subcommands not directly supported by plugin API,
        // so we handle routing in the handler
        flags: [
          {
            name: "force",
            alias: "f",
            description: "Overwrite existing hook (for install)",
          },
        ],
        handler: async (ctx) => {
          // Route to appropriate sub-handler based on first arg
          const subcommand = ctx.args[0];
          // Shift args for the sub-handler
          const subCtx = { ...ctx, args: ctx.args.slice(1) };

          switch (subcommand) {
            case "install":
              await installHookHandler(subCtx);
              break;
            case "remove":
              await removeHookHandler(subCtx);
              break;
            case "status":
              await statusHookHandler(subCtx);
              break;
            default:
              console.log(`Usage: atlcli git hook <install|remove|status> [dir]

Commands:
  install [dir]   Install post-commit hook for auto-push
  remove [dir]    Remove the post-commit hook
  status [dir]    Show git hook status

Options:
  --force, -f     Overwrite existing hook (install only)
  --json          JSON output
`);
          }
        },
      },
    ],
  },
];

/** Plugin definition */
const plugin: AtlcliPlugin = {
  name: "plugin-git",
  version: "1.0.0",
  description: "Git integration for Confluence sync - auto-commit on pull, auto-push on commit",

  commands: gitCommands,

  hooks: {
    // Auto-commit changes after docs pull
    afterCommand: autoCommitAfterPull,
  },

  initialize: async () => {
    // Plugin initialization (if needed)
  },

  cleanup: async () => {
    // Plugin cleanup (if needed)
  },
};

export default plugin;
