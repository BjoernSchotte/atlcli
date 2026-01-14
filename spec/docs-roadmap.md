# Documentation Reorganization Roadmap

## Overview

Reorganize atlcli documentation for first-class developer experience using mkdocs-material, with a slim README and comprehensive docs site.

## Decisions Summary

| Decision | Choice |
|----------|--------|
| Site name | `atlcli` (simple) |
| Color scheme | Teal/Cyan |
| Logo | Custom logo later (placeholder for now) |
| Navigation | Tabs + sections (top tabs for products, sidebar within) |
| Features | Code copy, nav tracking, search suggestions, instant loading |
| Versioning | No versioning (single version) |
| Analytics | Skip for now (Plausible placeholder for later) |
| Footer | Full (social links + "Made with mkdocs-material" + copyright) |
| Changelog | Link to GitHub releases |
| CLI Reference | Quick reference (cheat-sheet style with links) |
| Edit links | Yes (GitHub edit on each page) |
| Getting Started | Full tutorial (install, auth, examples for both products) |
| Tab labels | With material icons (Confluence, Jira) |
| Troubleshooting | Single page (covers both products) |
| Tone | Developer-focused (assumes technical knowledge, direct) |
| GitHub Pages | atlcli.sh (custom domain) |
| Examples | Both side-by-side (tabbed human-readable + JSON) |
| README | Feature highlights + workflow example + badges |
| Badges | Standard set (license, build status, docs) |
| Specs | Keep separate (spec/ internal, docs/ user-facing) |
| Extra pages | Use cases/recipes section |

---

## Phase 1: Directory Structure

```
docs/
├── index.md                    # Home / Landing page
├── getting-started.md          # Full tutorial: install, auth, Confluence + Jira examples
├── authentication.md           # Auth profiles, API tokens, env vars
├── configuration.md            # Config files, logging, plugins
│
├── confluence/
│   ├── index.md                # Confluence overview
│   ├── sync.md                 # Bidirectional sync (pull/push/sync daemon)
│   ├── pages.md                # Page operations (create, update, delete, move, sort)
│   ├── spaces.md               # Space operations
│   ├── templates.md            # Page templates with variables
│   ├── macros.md               # Confluence macros (info, note, expand, toc)
│   ├── attachments.md          # Attachment sync
│   └── file-format.md          # Frontmatter, directory structure
│
├── jira/
│   ├── index.md                # Jira overview
│   ├── issues.md               # Issue CRUD, transitions, comments, links
│   ├── search.md               # JQL search, shortcuts
│   ├── boards-sprints.md       # Boards, sprints, backlog
│   ├── time-tracking.md        # Worklogs, timer mode
│   ├── epics.md                # Epic management
│   ├── analytics.md            # Velocity, burndown, predictability
│   ├── bulk-operations.md      # Bulk edit, transition, label, delete
│   ├── filters.md              # Saved JQL filters
│   ├── templates.md            # Issue templates
│   ├── import-export.md        # CSV/JSON import/export
│   ├── webhooks.md             # Webhook server
│   └── fields.md               # Custom fields, components, versions
│
├── recipes/
│   ├── index.md                # Use cases overview
│   ├── team-docs.md            # "Sync team documentation" workflow
│   ├── sprint-reporting.md     # "Automated sprint reports" workflow
│   ├── ci-cd-docs.md           # "CI/CD documentation publish" workflow
│   └── issue-triage.md         # "Bulk issue triage" workflow
│
├── plugins/
│   ├── index.md                # Plugin system overview
│   ├── using-plugins.md        # Installing, enabling, disabling
│   ├── creating-plugins.md     # Plugin API, creating custom plugins
│   └── plugin-git.md           # Git integration plugin
│
├── reference/
│   ├── cli-commands.md         # Quick reference (cheat-sheet style)
│   ├── environment.md          # Environment variables
│   └── troubleshooting.md      # Common issues for both products
│
└── contributing.md             # Development setup, architecture, contributing
```

---

## Phase 2: Slim README.md

Target: ~100-150 lines with badges, feature highlights, and workflow example.

```markdown
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Build](https://github.com/BjoernSchotte/atlcli/actions/workflows/ci.yml/badge.svg)](https://github.com/BjoernSchotte/atlcli/actions)
[![Docs](https://img.shields.io/badge/docs-online-brightgreen)](https://atlcli.sh/)

# atlcli

A blazingly fast CLI for Atlassian products. Sync Confluence pages as markdown, manage Jira issues from your terminal.

## Key Features

**Confluence**
- Bidirectional markdown sync with conflict detection
- Macro support (info, note, warning, expand, toc)
- Page templates with Handlebars-style variables

**Jira**
- Full issue lifecycle from the command line
- JQL search with convenient shortcuts
- Sprint analytics (velocity, burndown)
- Timer-based time tracking

**General**
- Multiple auth profiles
- Plugin system for extensibility
- Comprehensive logging

## Installation

\`\`\`bash
git clone https://github.com/BjoernSchotte/atlcli.git
cd atlcli
bun install && bun run build
\`\`\`

## Quick Example

\`\`\`bash
# Authenticate
atlcli auth init

# Sync Confluence docs
atlcli docs init ./my-docs --space TEAM
atlcli docs pull ./my-docs
# Edit locally...
atlcli docs push ./my-docs

# Search Jira issues
atlcli jira search --assignee me --status "In Progress"

# Track time on an issue
atlcli jira worklog timer start PROJ-123
\`\`\`

## Documentation

Full documentation: **https://atlcli.sh/**

- [Getting Started](https://atlcli.sh/getting-started/)
- [Confluence Guide](https://atlcli.sh/confluence/)
- [Jira Guide](https://atlcli.sh/jira/)
- [Plugin Development](https://atlcli.sh/plugins/)

## License

MIT - see [LICENSE](LICENSE)
```

---

## Phase 3: mkdocs-material Setup

### mkdocs.yml

```yaml
site_name: atlcli
site_description: Extensible CLI for Atlassian products
site_url: https://atlcli.sh/
repo_url: https://github.com/BjoernSchotte/atlcli
repo_name: BjoernSchotte/atlcli
edit_uri: edit/main/docs/

theme:
  name: material
  # logo: assets/logo.png  # Add later
  # favicon: assets/favicon.png  # Add later
  palette:
    - scheme: default
      primary: teal
      accent: cyan
      toggle:
        icon: material/brightness-7
        name: Switch to dark mode
    - scheme: slate
      primary: teal
      accent: cyan
      toggle:
        icon: material/brightness-4
        name: Switch to light mode
  features:
    - navigation.instant
    - navigation.tracking
    - navigation.tabs
    - navigation.tabs.sticky
    - navigation.sections
    - navigation.expand
    - navigation.top
    - search.suggest
    - search.highlight
    - content.code.copy
    - content.tabs.link
    - content.action.edit
  icon:
    repo: fontawesome/brands/github

nav:
  - Home: index.md
  - Getting Started: getting-started.md
  - Confluence:
    - confluence/index.md
    - Sync: confluence/sync.md
    - Pages: confluence/pages.md
    - Spaces: confluence/spaces.md
    - Templates: confluence/templates.md
    - Macros: confluence/macros.md
    - Attachments: confluence/attachments.md
    - File Format: confluence/file-format.md
  - Jira:
    - jira/index.md
    - Issues: jira/issues.md
    - Search: jira/search.md
    - Boards & Sprints: jira/boards-sprints.md
    - Time Tracking: jira/time-tracking.md
    - Epics: jira/epics.md
    - Analytics: jira/analytics.md
    - Bulk Operations: jira/bulk-operations.md
    - Filters: jira/filters.md
    - Templates: jira/templates.md
    - Import/Export: jira/import-export.md
    - Webhooks: jira/webhooks.md
    - Fields: jira/fields.md
  - Recipes:
    - recipes/index.md
    - Team Docs Sync: recipes/team-docs.md
    - Sprint Reporting: recipes/sprint-reporting.md
    - CI/CD Docs: recipes/ci-cd-docs.md
    - Issue Triage: recipes/issue-triage.md
  - Plugins:
    - plugins/index.md
    - Using Plugins: plugins/using-plugins.md
    - Creating Plugins: plugins/creating-plugins.md
    - Git Plugin: plugins/plugin-git.md
  - Reference:
    - reference/cli-commands.md
    - Authentication: authentication.md
    - Configuration: configuration.md
    - Environment: reference/environment.md
    - Troubleshooting: reference/troubleshooting.md
  - Contributing: contributing.md

markdown_extensions:
  - pymdownx.highlight:
      anchor_linenums: true
      line_spans: __span
      pygments_lang_class: true
  - pymdownx.inlinehilite
  - pymdownx.superfences
  - pymdownx.tabbed:
      alternate_style: true
  - pymdownx.details
  - pymdownx.snippets
  - admonition
  - tables
  - attr_list
  - md_in_html
  - toc:
      permalink: true

plugins:
  - search
  - minify:
      minify_html: true

extra:
  social:
    - icon: fontawesome/brands/github
      link: https://github.com/BjoernSchotte/atlcli
      name: atlcli on GitHub
  generator: true  # "Made with Material for MkDocs"
  # analytics:  # Add Plausible later
  #   provider: custom
  #   property: plausible

copyright: Copyright &copy; 2025 Björn Schotte
```

---

## Phase 4: GitHub Actions Workflow

### .github/workflows/docs.yml

```yaml
name: Deploy Documentation

on:
  push:
    branches: [main]
    paths:
      - 'docs/**'
      - 'mkdocs.yml'
      - '.github/workflows/docs.yml'
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.x'

      - name: Cache pip
        uses: actions/cache@v4
        with:
          path: ~/.cache/pip
          key: ${{ runner.os }}-pip-mkdocs-material
          restore-keys: |
            ${{ runner.os }}-pip-

      - name: Install dependencies
        run: pip install mkdocs-material mkdocs-minify-plugin

      - name: Build docs
        run: mkdocs build --strict

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: site/

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

---

## Phase 5: Implementation Tasks

| # | Task | Priority | Est. |
|---|------|----------|------|
| 1 | Create docs/ directory structure with placeholder files | High | S |
| 2 | Add mkdocs.yml configuration | High | S |
| 3 | Add .github/workflows/docs.yml | High | S |
| 4 | Write docs/index.md (landing page) | High | M |
| 5 | Write docs/getting-started.md (full tutorial) | High | L |
| 6 | Slim down README.md | High | M |
| 7 | Write docs/authentication.md | High | M |
| 8 | Write docs/configuration.md | High | M |
| 9 | Migrate Confluence content (8 pages) | Medium | L |
| 10 | Migrate Jira content (13 pages) | Medium | L |
| 11 | Write recipes/ pages (4 pages) | Medium | M |
| 12 | Write plugins/ pages (4 pages) | Medium | M |
| 13 | Write reference/ pages (3 pages) | Medium | M |
| 14 | Write docs/contributing.md | Medium | M |
| 15 | Test local mkdocs serve | High | S |
| 16 | Test GitHub Pages deployment | High | S |
| 17 | Add logo placeholder and favicon | Low | S |

S = Small (< 30 min), M = Medium (30-60 min), L = Large (1-2 hours)

---

## Phase 6: Content Guidelines

### Tone
- **Developer-focused**: Assume technical knowledge, be direct and efficient
- Use imperative voice: "Run the command" not "You should run"
- Skip unnecessary explanation, link to details when needed

### Example Format (tabbed)

Use tabs to show both human-readable and JSON output:

```markdown
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
      "issues": [
        {"key": "PROJ-123", "status": "In Progress", "summary": "Fix login bug"},
        {"key": "PROJ-124", "status": "To Do", "summary": "Add dark mode"}
      ]
    }
    ```
```

### Page Structure
1. Brief intro (1-2 sentences, what this page covers)
2. Quick example (show the most common use case)
3. Detailed sections with more examples
4. Options/flags table (where applicable)
5. Related pages links at bottom

### Admonitions
Use sparingly:
- `!!! tip` - Helpful shortcuts or best practices
- `!!! warning` - Gotchas or destructive operations
- `!!! note` - Important context or prerequisites

---

## Success Criteria

- [ ] README is under 150 lines with badges
- [ ] All current README content preserved in docs/
- [ ] `mkdocs serve` runs without errors
- [ ] GitHub Pages deployment succeeds
- [ ] Navigation tabs work (Home, Confluence, Jira, Recipes, Plugins, Reference)
- [ ] Search finds content across all pages
- [ ] Dark/light mode toggle works
- [ ] Edit links go to correct GitHub files
- [ ] Code copy buttons work
- [ ] Tabbed examples render correctly
- [ ] Mobile layout is usable
