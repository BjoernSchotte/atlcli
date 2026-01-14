[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Build](https://github.com/BjoernSchotte/atlcli/actions/workflows/ci.yml/badge.svg)](https://github.com/BjoernSchotte/atlcli/actions)
[![Docs](https://img.shields.io/badge/docs-online-brightgreen)](https://atlcli.sh/)

```
         _   _      _ _
   __ _ | |_| | ___| (_)
  / _` || __| |/ __| | |
 | (_| || |_| | (__| | |
  \__,_| \__|_|\___|_|_|

  Extensible CLI for Atlassian products
```

# atlcli

A blazingly fast CLI for Atlassian products. Sync Confluence pages as markdown, manage Jira issues from your terminal.

## Key Features

**Confluence**
- Bidirectional markdown sync with conflict detection
- Macro support (info, note, warning, expand, toc)
- Page templates with Handlebars-style variables
- Attachment sync with smart change detection

**Jira**
- Full issue lifecycle from the command line
- JQL search with convenient shortcuts
- Sprint analytics (velocity, burndown, predictability)
- Timer-based time tracking
- Issue templates for quick reuse

**General**
- Multiple auth profiles
- Plugin system for extensibility
- Comprehensive JSONL logging

## Installation

### Quick Install (macOS/Linux)

```bash
curl -fsSL https://atlcli.sh/install.sh | bash
```

### Homebrew

```bash
brew install bjoernschotte/tap/atlcli
```

### From Source

```bash
git clone https://github.com/BjoernSchotte/atlcli.git
cd atlcli
bun install && bun run build
```

## Quick Example

```bash
# Authenticate
atlcli auth init

# Sync Confluence docs
atlcli wiki docs init ./my-docs --space TEAM
atlcli wiki docs pull ./my-docs
# Edit locally...
atlcli wiki docs push ./my-docs

# Search Jira issues
atlcli jira search --assignee me --status "In Progress"

# Track time on an issue
atlcli jira worklog timer start PROJ-123
# ... work ...
atlcli jira worklog timer stop PROJ-123
```

## Documentation

Full documentation: **https://atlcli.sh/**

- [Getting Started](https://atlcli.sh/getting-started/)
- [Confluence Guide](https://atlcli.sh/confluence/)
- [Jira Guide](https://atlcli.sh/jira/)
- [CLI Reference](https://atlcli.sh/reference/cli-commands/)
- [Plugin Development](https://atlcli.sh/plugins/)

## Development

```bash
bun install        # Install dependencies
bun run build      # Build
bun run start      # Run development version
bun test           # Run tests
```

### Project Structure

```
atlcli/
├── apps/cli/           # CLI application
├── packages/
│   ├── core/           # Shared utilities
│   ├── confluence/     # Confluence API client
│   └── jira/           # Jira API client
└── docs/               # Documentation
```

## License

MIT - see [LICENSE](LICENSE)
