```
         _   _      _ _
   __ _ | |_| | ___| (_)
  / _` || __| |/ __| | |
 | (_| || |_| | (__| | |
  \__,_| \__|_|\___|_|_|

  Extensible CLI for Atlassian products
```

# atlcli

A blazingly fast, extensible CLI for Atlassian products. Currently supports Confluence with bidirectional markdown sync, with Jira support planned.

## Features

- Markdown to Confluence storage format conversion
- Bidirectional sync with conflict detection
- Confluence macro support (info, note, warning, tip, expand, toc)
- GFM support (tables, task lists, fenced code blocks)
- Multiple auth profiles
- Clean filename handling with YAML frontmatter
- **Plugin system** for extending with custom commands

## Installation

```bash
# Clone and install
git clone https://github.com/your-org/atlcli.git
cd atlcli
bun install
bun run build
```

## Quick Start

```bash
# Authenticate with Confluence
atlcli auth init

# Initialize a directory for sync
atlcli docs init ./my-docs --space MYSPACE

# Pull pages from Confluence
atlcli docs pull ./my-docs

# Edit locally, then push changes
atlcli docs push ./my-docs

# Start bidirectional sync
atlcli docs sync ./my-docs --poll-interval 30000
```

## Commands

### Authentication

```bash
atlcli auth init              # Interactive setup
atlcli auth status            # Check current auth
atlcli auth list              # List all profiles
```

### Spaces

```bash
atlcli space list             # List all spaces
atlcli space get <KEY>        # Get space details
atlcli space create --key KEY --name "Name"
```

### Pages

```bash
atlcli page list --space KEY           # List pages in space
atlcli page get <ID>                   # Get page content
atlcli page create --space KEY --title "Title" --body "Content"
atlcli page update <ID> --body "New content"
atlcli page delete <ID>
```

### Documentation Sync

```bash
atlcli docs init <dir> --space <KEY>     # Initialize directory for space sync
atlcli docs init <dir> --ancestor <ID>   # Initialize for page tree sync
atlcli docs init <dir> --page-id <ID>    # Initialize for single page sync
atlcli docs pull [dir]                    # Pull from Confluence
atlcli docs push [dir]                    # Push to Confluence
atlcli docs push <file>                   # Push single file
atlcli docs add <file>                    # Add new file to tracking
atlcli docs status [dir]                  # Show sync status
atlcli docs sync <dir>                    # Bidirectional sync daemon
atlcli docs resolve <file> --accept <mode>
```

### Plugins

```bash
atlcli plugin list              # List installed plugins
atlcli plugin install <path>    # Install from local path
atlcli plugin remove <name>     # Remove a plugin
atlcli plugin enable <name>     # Enable a disabled plugin
atlcli plugin disable <name>    # Disable a plugin
```

## Bidirectional Sync

The `docs sync` command starts a daemon that keeps local files and Confluence pages in sync automatically.

### Partial Sync (Scope Options)

You can choose to sync an entire space, a page tree (parent + children), or just a single page:

```bash
# Full space sync (all pages in the space)
atlcli docs init ./docs --space TEAM
atlcli docs sync ./docs --space TEAM

# Page tree sync (parent page and all descendants)
atlcli docs init ./docs --ancestor 12345
atlcli docs sync ./docs --ancestor 12345

# Single page sync
atlcli docs init ./docs --page-id 67890
atlcli docs sync ./docs --page-id 67890
```

Once initialized, the scope is stored in `.atlcli/config.json` and you can omit the scope flags:

```bash
# Uses scope from config
atlcli docs pull ./docs
atlcli docs push ./docs
atlcli docs sync ./docs
```

You can override the stored scope with command-line flags when needed.

### Single File Operations

Push or pull individual files without affecting others:

```bash
# Push a single file (uses frontmatter ID)
atlcli docs push ./docs/my-page.md

# Pull updates for a specific page
atlcli docs pull ./docs --page-id 12345
```

### Basic Usage

```bash
# Sync entire space
atlcli docs sync ./docs --space DEV

# Sync with faster polling (every 15 seconds)
atlcli docs sync ./docs --space DEV --poll-interval 15000

# Sync a page tree (parent and all children)
atlcli docs sync ./docs --ancestor 12345

# Sync a single page
atlcli docs sync ./page.md --page-id 12345
```

### Auto-Create New Pages

With `--auto-create`, new markdown files are automatically created as Confluence pages:

```bash
# Start sync with auto-create enabled
atlcli docs sync ./docs --space DEV --auto-create

# Now create a new file - it will be pushed to Confluence automatically
echo "# New Page\n\nContent here." > ./docs/new-page.md
# The daemon detects the new file, creates a page, and adds frontmatter with the page ID
```

### Sync Options

```bash
atlcli docs sync <dir> [options]

Scope options (uses .atlcli/config.json scope if not specified):
  --page-id <id>        Sync single page by ID
  --ancestor <id>       Sync page tree under parent ID
  --space <key>         Sync entire space

Behavior options:
  --poll-interval <ms>  Polling interval in ms (default: 30000)
  --no-poll             Disable polling (local watch only)
  --no-watch            Disable local file watching (poll only)
  --on-conflict <mode>  Conflict handling: merge|local|remote (default: merge)
  --auto-create         Auto-create Confluence pages for new local files
  --dry-run             Show what would sync without changes
  --json                JSON output for scripting
  --profile <name>      Use specific auth profile

Webhook options (optional, for real-time updates):
  --webhook-port <port> Start webhook server on port
  --webhook-url <url>   Public URL to register with Confluence
```

### How Sync Works

1. **Initial sync**: Pulls all pages in scope and creates local files with frontmatter
2. **Local changes**: File watcher detects edits and pushes to Confluence
3. **Remote changes**: Poller checks for Confluence edits and pulls updates
4. **Conflicts**: Three-way merge automatically resolves non-overlapping changes

### Conflict Resolution

When both local and remote change the same lines, conflicts are marked with git-style markers:

```markdown
<<<<<<< LOCAL
Your local changes
=======
Remote changes from Confluence
>>>>>>> REMOTE
```

Resolve conflicts manually or use:

```bash
# Accept local version
atlcli docs resolve ./docs/page.md --accept local

# Accept remote version
atlcli docs resolve ./docs/page.md --accept remote
```

### Checking Sync Status

```bash
atlcli docs status ./docs

# Output:
#   synced:          15 files
#   local-modified:   2 files
#   remote-modified:  1 file
#   conflict:         1 file
```

### Example Workflows

**Team documentation workflow:**
```bash
# Initial setup
atlcli docs init ./team-docs --space TEAM
atlcli docs pull ./team-docs

# Start sync daemon (runs in background)
atlcli docs sync ./team-docs --space TEAM --poll-interval 30000 &

# Edit files locally - changes sync automatically
vim ./team-docs/architecture.md
```

**CI/CD documentation publish:**
```bash
# One-time push (no daemon)
atlcli docs push ./docs --space DOCS

# Or pull latest, merge, and push
atlcli docs pull ./docs --space DOCS
# ... make changes ...
atlcli docs push ./docs
```

**Watch mode for development:**
```bash
# Watch local changes only (no polling)
atlcli docs sync ./docs --space DEV --no-poll

# Poll only (no file watching)
atlcli docs sync ./docs --space DEV --no-watch --poll-interval 10000
```

## File Format

Files use YAML frontmatter for page tracking:

```markdown
---
atlcli:
  id: "623869955"
  title: "My Page Title"
---

# My Page Title

Content here...
```

## Confluence Macros

Use triple-colon syntax for Confluence macros:

```markdown
:::info Alert Title
This is an info panel.
:::

:::note
Important note here.
:::

:::warning Be Careful
Warning message.
:::

:::tip Pro Tip
Helpful tip.
:::

:::expand Click to expand
Hidden content here.
:::

:::toc
:::
```

## Directory Structure

After `docs init`, your directory will have a structure matching the Confluence page hierarchy:

```
my-docs/
├── .atlcli/
│   ├── config.json      # Space/scope configuration
│   ├── state.json       # Sync state tracking
│   └── cache/           # Base versions for 3-way merge
├── architecture.md                     # Root-level page
├── architecture/                       # Children of "Architecture"
│   ├── api-design.md
│   └── database.md
├── getting-started.md                  # Another root-level page
└── getting-started/
    └── installation.md                 # Child of "Getting Started"
```

**Hierarchy rules:**
- Page file: `{slug}.md`
- Child pages go in: `{parent-slug}/` directory
- Root pages (no parent in sync scope) go in the sync root
- When a page moves in Confluence, the local file is moved to match

## Configuration

Global config is stored in `~/.config/atlcli/config.json`:

```json
{
  "profiles": [
    {
      "name": "my-org",
      "baseUrl": "https://myorg.atlassian.net",
      "email": "user@example.com"
    }
  ],
  "activeProfile": "my-org"
}
```

API tokens are stored securely in `~/.config/atlcli/credentials.json`.

## Environment Variables

```bash
ATLCLI_BASE_URL=https://myorg.atlassian.net
ATLCLI_EMAIL=user@example.com
ATLCLI_API_TOKEN=your-token
```

## Plugins

atlcli supports plugins to extend functionality with custom commands and hooks.

### Installing Plugins

```bash
# Install from local path
atlcli plugin install ./my-plugin

# List installed plugins
atlcli plugin list

# Remove a plugin
atlcli plugin remove my-plugin
```

### Core Plugins

#### plugin-git

Git integration for bidirectional Confluence sync. Automatically commits pulled changes and pushes on commit.

```bash
# Install the plugin
atlcli plugin install ./plugins/plugin-git

# Install git hook for auto-push on commit
atlcli git hook install ./my-docs

# Check hook status
atlcli git hook status ./my-docs

# Remove hook
atlcli git hook remove ./my-docs
```

**Features:**
- **Auto-commit on pull**: After `docs pull`, changes are automatically committed with message `sync(confluence): pull N page(s) from Confluence`
- **Auto-push on commit**: Post-commit hook runs `docs push` automatically (skipped if sync daemon is running)

See [plugin-git README](./plugins/plugin-git/README.md) for full documentation.

### Using Plugin Commands

Once installed, plugin commands appear in the help:

```bash
atlcli --help
# Shows built-in commands plus:
# Plugin commands:
#   hello        Example hello command

# Run plugin commands like any other
atlcli hello world
atlcli hello greet --name "Developer"
```

### Creating a Plugin

Plugins are Node.js/Bun packages that export a plugin definition.

**1. Create the plugin structure:**

```
my-plugin/
├── package.json
└── src/
    └── index.ts
```

**2. Define package.json:**

```json
{
  "name": "my-atlcli-plugin",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "atlcli": {
    "plugin": true
  },
  "dependencies": {
    "@atlcli/plugin-api": "^1.0.0"
  }
}
```

**3. Create the plugin (src/index.ts):**

```typescript
import { definePlugin } from "@atlcli/plugin-api";

export default definePlugin({
  name: "my-plugin",
  version: "1.0.0",
  description: "My custom atlcli plugin",

  // Add new commands
  commands: [
    {
      name: "mycommand",
      description: "Do something useful",
      subcommands: [
        {
          name: "action",
          description: "Perform an action",
          flags: [
            { name: "verbose", alias: "v", description: "Verbose output" }
          ],
          handler: async (ctx) => {
            if (ctx.flags.verbose) {
              console.log("Verbose mode enabled");
            }
            console.log("Action performed!");
          }
        }
      ]
    }
  ],

  // Optional: Hook into command lifecycle
  hooks: {
    beforeCommand: async (ctx) => {
      // Runs before any command
    },
    afterCommand: async (ctx) => {
      // Runs after successful commands
    },
    onError: async (ctx, error) => {
      // Runs when a command fails
    }
  }
});
```

**4. Install and test:**

```bash
atlcli plugin install ./my-plugin
atlcli mycommand action --verbose
```

### Plugin API

The `@atlcli/plugin-api` package provides TypeScript types and helpers:

```typescript
import {
  definePlugin,      // Define a plugin
  defineCommand,     // Define a command
  defineSubcommand,  // Define a subcommand
  defineFlag,        // Define a flag
  // Types
  AtlcliPlugin,
  CommandDefinition,
  Subcommand,
  FlagDefinition,
  CommandContext,
  PluginHooks
} from "@atlcli/plugin-api";
```

### Plugin Storage

- Installed plugins: `~/.atlcli/plugins/`
- Plugin config: `~/.atlcli/plugins.json`

## Development

```bash
# Install dependencies
bun install

# Build
bun run build

# Run development version
bun run start -- <command>
# Or directly:
bun run apps/cli/src/index.ts <command>

# Run tests
bun test

# Type check
bun run typecheck
```

### Project Structure

```
atlcli/
├── apps/
│   └── cli/                 # @atlcli/cli - Main CLI application
├── packages/
│   ├── core/                # @atlcli/core - Shared utilities
│   ├── confluence/          # @atlcli/confluence - Confluence API & sync
│   └── plugin-api/          # @atlcli/plugin-api - Plugin interfaces
└── plugins/
    └── example-plugin/      # Example plugin for reference
```

## License

MIT License

Copyright (c) 2025

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
