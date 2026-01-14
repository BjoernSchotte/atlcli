# atlcli

A blazingly fast CLI for Atlassian products. Write documentation in markdown, sync bidirectionally with Confluence. Manage Jira issues from your terminal.

**Core feature:** True bidirectional sync between local markdown files and Confluence wiki pages - edit locally in your favorite editor, push to Confluence, or pull remote changes. Conflict detection included.

**Extensive macro support:** Full conversion of Confluence macros to markdown and back:

- **Simple macros:** info, note, warning, tip panels, expand/collapse, table of contents
- **Complex macros:** code blocks with syntax highlighting, tables, task lists, layouts
- **Unknown macros:** Preserved as-is during sync - no information loss

## Features

<div class="grid cards" markdown>

-   :material-file-document-multiple:{ .lg .middle } **Confluence**

    ---

    **Bidirectional markdown/wiki sync** - write in your editor, sync to Confluence. Pull, push, watch mode with conflict detection. Plus macro support and templates.

    [:octicons-arrow-right-24: Confluence Guide](confluence/index.md)

-   :material-checkbox-marked-circle:{ .lg .middle } **Jira**

    ---

    Full issue lifecycle, JQL search, sprint analytics, and timer-based time tracking.

    [:octicons-arrow-right-24: Jira Guide](jira/index.md)

-   :material-puzzle:{ .lg .middle } **Plugins**

    ---

    Extensible plugin system for custom workflows and integrations.

    [:octicons-arrow-right-24: Plugin Guide](plugins/index.md)

-   :material-book-open-variant:{ .lg .middle } **Recipes**

    ---

    Real-world workflows for team docs, sprint reporting, and CI/CD integration.

    [:octicons-arrow-right-24: Recipes](recipes/index.md)

</div>

## Quick Start

```bash
# Install
git clone https://github.com/BjoernSchotte/atlcli.git
cd atlcli && bun install && bun run build

# Authenticate
atlcli auth init

# Sync Confluence docs
atlcli wiki docs pull ./my-docs --space TEAM

# Search Jira issues
atlcli jira search --assignee me --status "In Progress"
```

[:octicons-arrow-right-24: Full Getting Started Guide](getting-started.md)

## Why atlcli?

- **Fast** - Built with Bun for maximum performance
- **Developer-friendly** - Git-like workflows, markdown everywhere
- **Scriptable** - JSON output, exit codes, CI/CD ready
- **Extensible** - Plugin system for custom workflows
