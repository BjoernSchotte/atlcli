---
title: "Shell Completions"
description: "Shell Completions - atlcli documentation"
---

# Shell Completions

atlcli provides tab completion support for Bash and Zsh shells. Completions work for commands, subcommands, flags, and plugin commands.

## Prerequisites

- Bash or Zsh shell
- atlcli installed and in PATH

## Quick Setup

### Zsh

Add to your `~/.zshrc`:

```bash
eval "$(atlcli completion zsh)"
```

Or append the script permanently:

```bash
atlcli completion zsh >> ~/.zshrc
source ~/.zshrc
```

### Bash

Add to your `~/.bashrc`:

```bash
eval "$(atlcli completion bash)"
```

Or append the script permanently:

```bash
atlcli completion bash >> ~/.bashrc
source ~/.bashrc
```

## Usage

After setup, press `Tab` to complete:

```bash
# Complete commands
atlcli j<Tab>           # → jira

# Complete subcommands
atlcli jira i<Tab>      # → issue

# Complete nested subcommands
atlcli jira issue c<Tab> # → comment, create

# Complete flags
atlcli jira search --<Tab>  # → --assignee, --jql, --project, ...
```

## How It Works

atlcli uses dynamic completions. When you press Tab, your shell calls `atlcli completion __complete` with the current command line. atlcli returns matching completions including:

1. **Built-in commands** - auth, wiki, jira, log, plugin, etc.
2. **Subcommands** - nested commands like `jira issue create`
3. **Flags** - command-specific and global flags
4. **Plugin commands** - any installed plugin commands

## Plugin Support

Completions automatically include commands from installed plugins. If you install a plugin that provides the `git` command with subcommands like `hook`, `commit`, those will be available in tab completion.

```bash
# Plugin commands are included
atlcli git <Tab>        # → hook, commit, ...
```

## Troubleshooting

### Completions not working

1. Ensure the completion script is loaded:
   ```bash
   # Zsh
   type _atlcli

   # Bash
   complete -p atlcli
   ```

2. Reload your shell configuration:
   ```bash
   source ~/.zshrc   # or ~/.bashrc
   ```

3. Test completions directly:
   ```bash
   atlcli completion __complete jira
   # Should output: analyze, board, bulk, ...
   ```

### Slow completions

Completions load plugins on each invocation. If you have many plugins, this may add slight latency. The built-in command structure is cached in the CLI.

## Manual Script Installation

If you prefer to manage the completion script manually:

```bash
# Generate and save the script
atlcli completion zsh > ~/.atlcli-completion.zsh

# Source it in your .zshrc
echo 'source ~/.atlcli-completion.zsh' >> ~/.zshrc
```

## Fish Shell

Fish shell completion is not yet supported. Track progress in [GitHub Issues](https://github.com/BjoernSchotte/atlcli/issues).

## Related Topics

- [CLI Commands](cli-commands.md) - Full command reference
- [Plugins](../plugins/index.md) - Plugin commands are also completed
