[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Build](https://github.com/BjoernSchotte/atlcli/actions/workflows/ci.yml/badge.svg)](https://github.com/BjoernSchotte/atlcli/actions)
[![Version](https://img.shields.io/github/v/release/BjoernSchotte/atlcli)](https://github.com/BjoernSchotte/atlcli/releases)
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

A blazingly fast CLI for Atlassian products. Sync Confluence pages as markdown, manage Jira issues from your terminal. Works with both Atlassian Cloud and Data Center (on-premises) deployments.

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

### Windows

Download `atlcli-windows-x64.zip` from the [latest release](https://github.com/BjoernSchotte/atlcli/releases/latest), extract it, and add the folder containing `atlcli.exe` to your `PATH`. The binary is unsigned, so Windows SmartScreen may show a warning on first run — click **More info** → **Run anyway**.

### From Source

```bash
git clone https://github.com/BjoernSchotte/atlcli.git
cd atlcli
bun install && bun run build
```

## Requirements

- macOS, Linux, or Windows (x64)
- Atlassian Cloud **or** Data Center (on-premises) instance
- API token from [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) (Cloud) or a Personal Access Token from your Data Center instance

See [Getting Started](https://atlcli.sh/getting-started/) for detailed setup instructions.

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
- [Contributing](https://atlcli.sh/contributing/)
- [Changelog](CHANGELOG.md)

## Development

```bash
bun install        # Install dependencies
bun run build      # Build all packages
bun run start      # Run development version
bun test           # Run tests
```

See [Contributing Guide](https://atlcli.sh/contributing/) for detailed development setup.

### Documentation development

The Astro documentation site requires Node.js 22.12.0 or newer. Use the
repository's declared Bun version (`1.3.5`) to install dependencies and run the
documentation commands:

```bash
bun install --frozen-lockfile
bun run docs:dev      # Start the local development server
bun run docs:check    # Run Astro diagnostics and type checking
bun run docs:build    # Build the production documentation site
```

### Project Structure

```
atlcli/
├── apps/
│   ├── browser-export-harness/ # Vite/Chromium DOCX + PDF conformance app
│   ├── cli/                    # CLI entry point and commands
│   ├── extension/              # Chrome MV3 export host
│   └── uno-dashboard/          # UNO dashboard web app
├── packages/
│   ├── core/                   # Shared utilities (config, logging, templates)
│   ├── confluence/             # Confluence client, conversion, shared export blocks
│   ├── docx/                   # Isomorphic DOCX engine + browser runtime
│   ├── export/                 # Legacy PDF/Word export (Python)
│   ├── jira/                   # Jira API client
│   ├── pdf/                    # Host-neutral PDF preparation and runner contracts
│   ├── pdf-compiler-browser/   # Private Typst-WASM browser adapter
│   └── plugin-api/             # Plugin type definitions
├── plugins/              # Built-in plugins (git, example)
├── scripts/              # Build and release scripts
├── services/             # Background services (UNO)
├── specs/                # Feature specifications and implementation plans
└── src/content/docs/     # Documentation (Astro Starlight)
```

## License

Apache License 2.0 - see [LICENSE](LICENSE) and [NOTICE](NOTICE)

---

Jira and Confluence are trademarks of Atlassian Corporation Plc, registered in the US and other countries.
atlcli is not affiliated with, endorsed by, or sponsored by Atlassian.
