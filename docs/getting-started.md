# Getting Started

This guide walks you through installing atlcli, authenticating with Atlassian, and running your first commands.

## Installation

### Quick Install (Recommended)

The fastest way to install atlcli on macOS or Linux:

```bash
curl -fsSL https://atlcli.sh/install.sh | bash
```

Install a specific version:

```bash
curl -fsSL https://atlcli.sh/install.sh | bash -s v0.5.1
```

This installs to `~/.atlcli/bin` and updates your shell PATH automatically.

### Homebrew

Alternatively, install via Homebrew:

```bash
brew install bjoernschotte/tap/atlcli
```

To upgrade:

```bash
brew upgrade atlcli
```

### Manual Download

Download the latest release for your platform from the [releases page](https://github.com/BjoernSchotte/atlcli/releases):

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `atlcli-darwin-arm64.tar.gz` |
| macOS (Intel) | `atlcli-darwin-x64.tar.gz` |
| Linux (ARM64) | `atlcli-linux-arm64.tar.gz` |
| Linux (x64) | `atlcli-linux-x64.tar.gz` |

Extract and add to your PATH:

```bash
tar -xzf atlcli-*.tar.gz
sudo mv atlcli /usr/local/bin/
```

### From Source

For development or if you want the latest unreleased changes:

**Prerequisites:**

- [Bun](https://bun.sh) v1.0 or later

```bash
git clone https://github.com/BjoernSchotte/atlcli.git
cd atlcli
bun install
bun run build
```

The CLI is now available at `./apps/cli/dist/atlcli`.

!!! tip "Add to PATH"
    Add the dist directory to your PATH or create an alias:
    ```bash
    alias atlcli="$(pwd)/apps/cli/dist/atlcli"
    ```

## Authentication

atlcli uses API tokens for authentication. You can manage multiple profiles for different Atlassian instances.

### Create an API Token

1. Go to [Atlassian Account Settings](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click **Create API token**
3. Give it a descriptive name (e.g., "atlcli")
4. Copy the token

### Initialize Authentication

```bash
atlcli auth init
```

Follow the prompts to enter:

- **Instance URL**: Your Atlassian instance (e.g., `https://yourcompany.atlassian.net`)
- **Email**: Your Atlassian account email
- **API Token**: The token you created

Your credentials are stored securely at `~/.atlcli/credentials.json`.

### Multiple Profiles

Create named profiles for different instances:

```bash
atlcli auth init --profile work
atlcli auth init --profile personal
```

Use `--profile` with any command:

```bash
atlcli jira search --assignee me --profile work
```

## Confluence Quick Start

### Initialize a Local Directory

```bash
atlcli wiki docs init ./team-docs --space TEAM
```

This creates a local directory linked to the TEAM space.

### Pull Pages

```bash
atlcli wiki docs pull ./team-docs
```

Pages are downloaded as markdown files with YAML frontmatter:

```markdown
---
id: "12345"
title: "Meeting Notes"
space: "TEAM"
---

# Meeting Notes

Content here...
```

### Edit and Push

Edit files locally with your favorite editor, then push changes:

```bash
atlcli wiki docs push ./team-docs
```

atlcli detects changes and updates only modified pages.

## Jira Quick Start

### Search Issues

```bash
# Your assigned issues
atlcli jira search --assignee me

# Open bugs in a project
atlcli jira search --project PROJ --type Bug --status Open

# Using JQL directly
atlcli jira search --jql "project = PROJ AND sprint in openSprints()"
```

### View an Issue

```bash
atlcli jira get PROJ-123
```

### Create an Issue

```bash
atlcli jira create --project PROJ --type Task --summary "Fix login bug"
```

### Track Time

```bash
# Start a timer
atlcli jira worklog timer start PROJ-123

# Stop and log time
atlcli jira worklog timer stop PROJ-123

# Or log directly
atlcli jira worklog add PROJ-123 --time 2h --comment "Code review"
```

## JSON Output

All commands support `--json` for scripting:

=== "Human-readable"
    ```bash
    atlcli jira search --assignee me
    ```
    ```
    PROJ-123  In Progress  Fix login bug
    PROJ-124  To Do        Add dark mode
    ```

=== "JSON"
    ```bash
    atlcli jira search --assignee me --json
    ```
    ```json
    {
      "schemaVersion": "1",
      "issues": [
        {"key": "PROJ-123", "status": "In Progress", "summary": "Fix login bug"},
        {"key": "PROJ-124", "status": "To Do", "summary": "Add dark mode"}
      ]
    }
    ```

## Next Steps

- [Confluence Guide](confluence/index.md) - Deep dive into sync, templates, macros
- [Jira Guide](jira/index.md) - Issues, boards, sprints, analytics
- [Recipes](recipes/index.md) - Real-world workflows
- [Configuration](configuration.md) - Customize atlcli behavior
