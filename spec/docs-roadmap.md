# Documentation Reorganization Roadmap

## Overview

Reorganize atlcli documentation for first-class developer experience using mkdocs-material, with a slim README and comprehensive docs site.

## Goals

1. **Slim README** - Installation, elevator pitch, quick links only
2. **Organized docs/** - Product-based structure (Confluence, Jira)
3. **Modern docs site** - mkdocs-material with search, navigation, code highlighting
4. **Automated deployment** - GitHub Actions to gh-pages
5. **English** - Single language for now

---

## Phase 1: Directory Structure

```
docs/
├── index.md                    # Home / Landing page
├── getting-started.md          # Installation, quick start, first steps
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
├── plugins/
│   ├── index.md                # Plugin system overview
│   ├── using-plugins.md        # Installing, enabling, disabling
│   ├── creating-plugins.md     # Plugin API, creating custom plugins
│   └── plugin-git.md           # Git integration plugin
│
├── reference/
│   ├── cli-commands.md         # Full CLI reference (auto-generated?)
│   ├── environment.md          # Environment variables
│   └── troubleshooting.md      # Common issues, FAQ
│
└── contributing.md             # Development setup, architecture, contributing
```

---

## Phase 2: Slim README.md

New README structure (~100-150 lines):

```markdown
# atlcli

Extensible CLI for Atlassian products - Confluence and Jira.

## Features

- Confluence: Bidirectional markdown sync, macros, templates
- Jira: Full issue lifecycle, sprints, analytics, time tracking
- Plugin system for extensibility
- Multiple auth profiles

## Installation

[Quick install instructions]

## Quick Start

[3-5 essential commands for each product]

## Documentation

Full documentation at: https://your-org.github.io/atlcli/

- [Getting Started](docs link)
- [Confluence Guide](docs link)
- [Jira Guide](docs link)
- [Plugin Development](docs link)

## License

MIT
```

---

## Phase 3: mkdocs-material Setup

### mkdocs.yml

```yaml
site_name: atlcli
site_description: Extensible CLI for Atlassian products
site_url: https://bjoernschotte.github.io/atlcli/
repo_url: https://github.com/BjoernSchotte/atlcli
repo_name: BjoernSchotte/atlcli

theme:
  name: material
  palette:
    - scheme: default
      primary: blue
      accent: blue
      toggle:
        icon: material/brightness-7
        name: Switch to dark mode
    - scheme: slate
      primary: blue
      accent: blue
      toggle:
        icon: material/brightness-4
        name: Switch to light mode
  features:
    - navigation.instant
    - navigation.tracking
    - navigation.tabs
    - navigation.sections
    - navigation.expand
    - navigation.top
    - search.suggest
    - search.highlight
    - content.code.copy
    - content.tabs.link

nav:
  - Home: index.md
  - Getting Started: getting-started.md
  - Authentication: authentication.md
  - Configuration: configuration.md
  - Confluence:
    - Overview: confluence/index.md
    - Sync: confluence/sync.md
    - Pages: confluence/pages.md
    - Spaces: confluence/spaces.md
    - Templates: confluence/templates.md
    - Macros: confluence/macros.md
    - Attachments: confluence/attachments.md
    - File Format: confluence/file-format.md
  - Jira:
    - Overview: jira/index.md
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
  - Plugins:
    - Overview: plugins/index.md
    - Using Plugins: plugins/using-plugins.md
    - Creating Plugins: plugins/creating-plugins.md
    - Git Plugin: plugins/plugin-git.md
  - Reference:
    - CLI Commands: reference/cli-commands.md
    - Environment: reference/environment.md
    - Troubleshooting: reference/troubleshooting.md
  - Contributing: contributing.md

markdown_extensions:
  - pymdownx.highlight:
      anchor_linenums: true
  - pymdownx.superfences
  - pymdownx.tabbed:
      alternate_style: true
  - pymdownx.details
  - pymdownx.snippets
  - admonition
  - tables
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
```

### Dependencies

```bash
# Add to project or use pip
pip install mkdocs-material mkdocs-minify-plugin
```

Or add to project:

```json
// package.json scripts
{
  "scripts": {
    "docs:serve": "mkdocs serve",
    "docs:build": "mkdocs build",
    "docs:deploy": "mkdocs gh-deploy"
  }
}
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

      - name: Install dependencies
        run: pip install mkdocs-material mkdocs-minify-plugin

      - name: Build docs
        run: mkdocs build

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

| Task | Description | Priority |
|------|-------------|----------|
| Create docs/ structure | Create directories and placeholder files | High |
| Migrate README content | Extract content to appropriate doc pages | High |
| Slim README | Rewrite README to essentials only | High |
| Add mkdocs.yml | Configure mkdocs-material | High |
| Add GH workflow | Set up docs.yml workflow | High |
| Write index.md | Landing page with overview | High |
| Write getting-started.md | Installation, quick start | High |
| Migrate Confluence docs | Split README Confluence content | Medium |
| Migrate Jira docs | Split README Jira content | Medium |
| Migrate Plugin docs | Split README plugin content | Medium |
| Write reference pages | CLI reference, env vars, troubleshooting | Medium |
| Add code examples | Ensure all pages have runnable examples | Low |
| Add screenshots/diagrams | Visual aids where helpful | Low |

---

## Phase 6: Content Guidelines

### Style
- Use imperative voice for instructions ("Run the command", not "You should run")
- Start each page with a brief overview paragraph
- Include practical examples for every feature
- Use admonitions (tip, warning, note) for callouts
- Keep code blocks focused and commented

### Structure per page
1. Brief intro (1-2 sentences)
2. Quick example (show, don't tell)
3. Detailed explanation
4. Options/flags table (where applicable)
5. More examples
6. Related pages links

### Code blocks
- Always specify language for syntax highlighting
- Use `bash` for CLI commands
- Show expected output where helpful
- Use `# Comments` to explain non-obvious parts

---

## Success Criteria

- [ ] README is under 150 lines
- [ ] All current README content preserved in docs/
- [ ] mkdocs serves locally without errors
- [ ] GH Pages deployment works
- [ ] Navigation is intuitive (< 3 clicks to any topic)
- [ ] Search works for all content
- [ ] Mobile-friendly layout
- [ ] Dark/light mode toggle works
