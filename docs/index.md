# atlcli

A blazingly fast CLI for Atlassian products. Sync Confluence pages as markdown, manage Jira issues from your terminal.

## Features

<div class="grid cards" markdown>

-   :material-file-document-multiple:{ .lg .middle } **Confluence**

    ---

    Bidirectional markdown sync with conflict detection, macro support, and page templates.

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
atlcli docs pull ./my-docs --space TEAM

# Search Jira issues
atlcli jira search --assignee me --status "In Progress"
```

[:octicons-arrow-right-24: Full Getting Started Guide](getting-started.md)

## Why atlcli?

- **Fast** - Built with Bun for maximum performance
- **Developer-friendly** - Git-like workflows, markdown everywhere
- **Scriptable** - JSON output, exit codes, CI/CD ready
- **Extensible** - Plugin system for custom workflows
