/**
 * Shell completion command.
 *
 * atlcli completion zsh      - Output zsh completion script
 * atlcli completion bash     - Output bash completion script
 * atlcli completion __complete <args> - Internal: get completions for args
 */

import { output, hasFlag } from "@atlcli/core";
import type { OutputOptions } from "@atlcli/core";
import {
  getCompletions,
  ZSH_COMPLETION_SCRIPT,
  BASH_COMPLETION_SCRIPT,
  PluginCommandInfo,
} from "../completions.js";
import { getPluginRegistry } from "../plugins/loader.js";

export async function handleCompletion(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const [sub, ...rest] = args;

  // Show help if no subcommand
  if (!sub) {
    output(completionHelp(), opts);
    return;
  }

  switch (sub) {
    case "zsh":
      // Output zsh completion script (raw, not JSON)
      process.stdout.write(ZSH_COMPLETION_SCRIPT);
      return;

    case "bash":
      // Output bash completion script (raw, not JSON)
      process.stdout.write(BASH_COMPLETION_SCRIPT);
      return;

    case "__complete":
      // Internal: called by shell completion scripts
      // Get plugin registry (plugins already initialized in main())
      const registry = getPluginRegistry();
      const pluginCommands: PluginCommandInfo[] = registry
        .getAllCommands()
        .map((c) => ({
          name: c.name,
          subcommands: c.command.subcommands?.map((s) => s.name),
        }));

      // Get raw args from process.argv to preserve empty strings
      // parseArgs strips empty strings, but we need them for completion
      const rawArgs = process.argv.slice(2); // Remove 'bun' and script path
      const completeIdx = rawArgs.indexOf("__complete");
      const completionArgs = completeIdx >= 0 ? rawArgs.slice(completeIdx + 1) : rest;

      // Returns one completion per line
      const completions = getCompletions(completionArgs, pluginCommands);
      for (const c of completions) {
        process.stdout.write(c + "\n");
      }
      return;

    default:
      output(completionHelp(), opts);
      return;
  }
}

function completionHelp(): string {
  return `atlcli completion <shell>

Generate shell completion scripts for tab completion.

Commands:
  zsh         Output zsh completion script
  bash        Output bash completion script

Setup:
  # Zsh - add to ~/.zshrc
  eval "$(atlcli completion zsh)"

  # Bash - add to ~/.bashrc
  eval "$(atlcli completion bash)"

Examples:
  atlcli completion zsh
  atlcli completion bash
  atlcli completion zsh >> ~/.zshrc
`;
}
