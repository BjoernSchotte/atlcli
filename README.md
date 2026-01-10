```
         _   _      _ _
   __ _ | |_| | ___| (_)
  / _` || __| |/ __| | |
 | (_| || |_| | (__| | |
  \__,_| \__|_|\___|_|_|

  Confluence CLI with superpowers
```

# atlcli

A blazingly fast CLI for Atlassian Confluence with bidirectional markdown sync.

## Features

- Markdown to Confluence storage format conversion
- Bidirectional sync with conflict detection
- Confluence macro support (info, note, warning, tip, expand, toc)
- GFM support (tables, task lists, fenced code blocks)
- Multiple auth profiles
- Clean filename handling with YAML frontmatter

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
atlcli docs init <dir> --space <KEY>    # Initialize directory
atlcli docs pull [dir]                   # Pull from Confluence
atlcli docs push [dir]                   # Push to Confluence
atlcli docs add <file>                   # Add new file to tracking
atlcli docs status [dir]                 # Show sync status
atlcli docs sync <dir>                   # Bidirectional sync daemon
atlcli docs resolve <file> --accept <mode>
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

After `docs init`, your directory will have:

```
my-docs/
├── .atlcli/
│   ├── config.json      # Space configuration
│   ├── state.json       # Sync state tracking
│   └── cache/           # Base versions for 3-way merge
├── page-one.md
└── page-two.md
```

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

## Development

```bash
# Install dependencies
bun install

# Build
bun run build

# Run development version
bun run apps/atlcli/src/index.ts <command>

# Type check
bun run typecheck
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
