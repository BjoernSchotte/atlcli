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
- **Page templates** with Handlebars-style variables and modifiers
- **JSONL logging** for observability and enterprise audit

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
atlcli auth init                        # Interactive setup (prompts for credentials)
atlcli auth login                       # Login (uses existing token if available)
atlcli auth login --profile work        # Login and save as named profile
atlcli auth status                      # Show active profile
atlcli auth list                        # List all profiles
atlcli auth switch <name>               # Switch active profile
atlcli auth rename <old> <new>          # Rename a profile
atlcli auth logout [name]               # Log out (clear credentials, keep profile)
atlcli auth delete <name>               # Delete a profile entirely
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

# Reordering siblings (move within same parent)
atlcli page move ./docs/setup.md --before ./docs/intro.md
atlcli page move ./docs/advanced.md --after ./docs/basics.md
atlcli page move ./docs/quickstart.md --first
atlcli page move ./docs/appendix.md --last
atlcli page move --id 12345 --position 3

# Sorting children of a page
atlcli page sort ./docs/api.md --alphabetical
atlcli page sort ./docs/chapters.md --natural       # Chapter 1, 2, 10 (not 1, 10, 2)
atlcli page sort ./docs/changelog.md --by created --reverse
atlcli page sort --id 12345 --alphabetical --dry-run
```

**File path references:** The move and sort commands accept file paths (e.g., `./docs/page.md`) in addition to page IDs. The page ID is read from the `atlcli.id` frontmatter.

### Templates

```bash
atlcli template list                    # List available templates
atlcli template get --name <name>       # View template details
atlcli template create --name <name>    # Create empty template
atlcli template create --name <name> --from-file <file>  # Create from file
atlcli template validate --name <name>  # Validate template syntax
atlcli template preview --name <name>   # Preview rendered template
atlcli template delete --name <name> --confirm  # Delete template
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

### Logging

```bash
atlcli log list                          # List recent log entries
atlcli log list --since 1h               # Logs from the last hour
atlcli log list --type api --limit 50    # Filter by type
atlcli log list --level error            # Filter by level
atlcli log tail                          # Show recent logs
atlcli log tail -f                       # Follow new log entries
atlcli log show <id>                     # Show full entry details
atlcli log clear --before 7d --confirm   # Clear logs older than 7 days
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

## Page Templates

Create pages from reusable templates with a powerful Handlebars-style variable system.

### Template Storage

Templates are stored in two locations:
- **Local**: `.atlcli/templates/` in your project (project-specific)
- **Global**: `~/.config/atlcli/templates/` (available everywhere)

### Creating a Template

```bash
# Create from an existing file
atlcli template create --name meeting-notes --from-file ./templates/meeting.md

# Create as global template (available across projects)
atlcli template create --name meeting-notes --from-file ./meeting.md --global
```

### Template Format

Templates use YAML frontmatter for metadata and Handlebars-style `{{variable}}` syntax:

```markdown
---
template:
  name: "meeting-notes"
  description: "Weekly meeting notes template"
  variables:
    - name: "meeting_date"
      prompt: "Meeting date"
      type: "date"
      default: "{{TODAY}}"
    - name: "attendees"
      prompt: "Attendees (comma-separated)"
      type: "list"
      required: true
  target:
    labels: ["meeting-notes"]
---

# {{TITLE}}

**Date:** {{meeting_date | date:'MMMM D, YYYY'}}
**Attendees:**
{{#each attendees}}
- {{this}}
{{/each}}

## Notes

---
*Created by {{USER.displayName}} on {{NOW | date:'YYYY-MM-DD HH:mm'}}*
```

### Built-in Variables

| Variable | Description |
|----------|-------------|
| `{{NOW}}` | Current timestamp |
| `{{TODAY}}` | Current date |
| `{{YEAR}}`, `{{MONTH}}`, `{{DAY}}` | Date parts |
| `{{TIME}}`, `{{WEEKDAY}}` | Time and day name |
| `{{USER.displayName}}`, `{{USER.email}}` | Current user info |
| `{{SPACE.key}}`, `{{SPACE.name}}` | Target space info |
| `{{TITLE}}` | Page title |
| `{{UUID}}` | Random UUID |
| `{{ENV.VAR_NAME}}` | Environment variable |

### Modifiers

Chain modifiers with `|` for transformations:

```handlebars
{{name | upper}}                    # UPPERCASE
{{name | lower}}                    # lowercase
{{date | date:'MMMM D, YYYY'}}      # January 12, 2025
{{items | join:', '}}               # item1, item2, item3
{{value | default:'N/A'}}           # Fallback value
{{text | truncate:50}}              # Truncate to 50 chars
```

### Conditionals and Loops

```handlebars
{{#if status}}
  Status: {{status}}
{{else}}
  No status set
{{/if}}

{{#each items}}
  {{@number}}. {{this}}
{{/each}}
```

### Previewing Templates

```bash
# Preview with variables
atlcli template preview --name meeting-notes \
  --title "Weekly Sync" \
  --var attendees="Alice,Bob,Charlie"
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

Global config is stored in `~/.atlcli/config.json`:

```json
{
  "currentProfile": "work",
  "profiles": {
    "work": {
      "name": "work",
      "baseUrl": "https://mycompany.atlassian.net",
      "auth": { "type": "apiToken", "email": "user@company.com", "token": "..." }
    },
    "personal": {
      "name": "personal",
      "baseUrl": "https://personal.atlassian.net",
      "auth": { "type": "apiToken", "email": "me@example.com", "token": "..." }
    }
  },
  "logging": {
    "level": "info",
    "global": true,
    "project": true
  }
}
```

## Logging

atlcli includes comprehensive JSONL logging for observability and enterprise audit requirements.

### Log Locations

- **Global logs**: `~/.atlcli/logs/YYYY-MM-DD.jsonl`
- **Project logs**: `.atlcli/logs/YYYY-MM-DD.jsonl` (when `.atlcli/` exists)

### Log Entry Types

| Type | Description |
|------|-------------|
| `cli.command` | CLI command invocations with args and flags |
| `cli.result` | Command completion with exit code and duration |
| `api.request` | Confluence API requests (method, URL, headers) |
| `api.response` | API responses (status, body, duration) |
| `sync.event` | Sync events (pull, push, conflict) |
| `auth.change` | Authentication changes (login, logout, switch) |
| `error` | Errors with stack traces and context |

### Querying Logs

```bash
# List recent entries
atlcli log list --limit 20

# Filter by time range (relative or ISO dates)
atlcli log list --since 1h
atlcli log list --since "2025-01-01" --until "2025-01-31"

# Filter by level
atlcli log list --level error
atlcli log list --level warn

# Filter by type
atlcli log list --type api              # All API logs
atlcli log list --type cli.command      # Just command starts
atlcli log list --type sync             # Sync events

# Combine filters
atlcli log list --type api --level error --since 24h

# JSON output for scripting
atlcli log list --json | jq '.entries[] | select(.data.status >= 400)'
```

### Following Logs

```bash
# Show recent logs and follow new entries (defaults to global logs)
atlcli log tail -f

# Filter while following
atlcli log tail -f --level error

# Tail project-specific logs instead
atlcli log tail --project
```

### Viewing Full Entry Details

```bash
# Get entry ID from log list
atlcli log list --limit 5

# Show full details including all data fields
atlcli log show abc123-uuid-here
```

### Clearing Old Logs

```bash
# Clear logs older than 30 days
atlcli log clear --before 30d --confirm

# Clear only global logs
atlcli log clear --before 7d --global --confirm

# Clear only project logs
atlcli log clear --before 7d --project --confirm
```

### Disabling Logging

```bash
# Disable logging for a single command
atlcli page list --space DEV --no-log

# Disable logging globally (in config)
# Set "level": "off" in ~/.atlcli/config.json
```

### Log Configuration

Configure logging in `~/.atlcli/config.json`:

```json
{
  "logging": {
    "level": "info",    // off | error | warn | info | debug
    "global": true,     // Write to ~/.atlcli/logs/
    "project": true     // Write to .atlcli/logs/ (when present)
  }
}
```

### Sensitive Data Redaction

Sensitive fields are automatically redacted in logs:
- API tokens and passwords → `[REDACTED]`
- Authorization headers → `Basic [REDACTED]` or `Bearer [REDACTED]`

Fields like `email`, `title`, and `content` are **not** redacted (needed for audit).

### Log Entry Format

Each log entry is a JSON object on its own line:

```json
{
  "id": "5bb8303b-08ce-4c9d-9a2e-657ca2ceaece",
  "timestamp": "2025-01-12T12:12:20.722Z",
  "level": "info",
  "type": "api.request",
  "pid": 12345,
  "sessionId": "3ea06a39-52b2-4b18-a74b-8d0e6ee02ddf",
  "data": {
    "requestId": "ada26fed-45b8-42f1-881b-2034f6f9b6bd",
    "method": "GET",
    "url": "https://example.atlassian.net/wiki/rest/api/content/123",
    "headers": {
      "Authorization": "Basic [REDACTED]"
    }
  }
}
```

- **id**: Unique entry identifier
- **sessionId**: Correlates all logs from one CLI invocation
- **requestId**: Correlates API request with its response

## Environment Variables

```bash
ATLCLI_SITE=https://myorg.atlassian.net
ATLCLI_EMAIL=user@example.com
ATLCLI_API_TOKEN=your-token
```

Environment variables override the active profile when set.

## Profile Management

Manage multiple Atlassian accounts with named profiles.

### Setting Up Profiles

```bash
# Create first profile (auto-named from site hostname)
atlcli auth init

# Create a named profile
atlcli auth login --profile work --site https://work.atlassian.net

# Create another profile
atlcli auth login --profile personal --site https://personal.atlassian.net
```

### Using Profiles

```bash
# List all profiles
atlcli auth list

# Switch default profile
atlcli auth switch personal

# Use a specific profile for one command
atlcli page list --space DEV --profile work

# Check which profile is active
atlcli auth status
```

### Managing Profiles

```bash
# Rename a profile
atlcli auth rename old-name new-name

# Log out (clear credentials but keep profile for easy re-login)
atlcli auth logout work

# Delete a profile entirely
atlcli auth delete old-profile
```

All commands that connect to Confluence accept the `--profile` flag to override the default profile.

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
