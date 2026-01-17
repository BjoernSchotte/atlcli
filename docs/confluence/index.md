# Confluence

atlcli provides bidirectional sync between local markdown files and Confluence pages.

## Overview

Work with Confluence using familiar Git-like workflows:

```bash
# Initialize a local directory
atlcli wiki docs init ./team-docs --space TEAM

# Pull pages from Confluence
atlcli wiki docs pull ./team-docs

# Edit locally, then push changes
atlcli wiki docs push ./team-docs

# Watch for changes
atlcli wiki docs sync ./team-docs --watch
```

## Key Features

- **Bidirectional Sync** - Pull from Confluence, push local changes
- **DOCX Export** - Export pages to Word with customizable templates
- **Conflict Detection** - Warns when both local and remote changed
- **Markdown Format** - Write in markdown, atlcli handles conversion
- **Macro Support** - Use Confluence macros like info panels and TOC
- **Smart Links** - Jira issues and Confluence page links with display modes
- **Cross-Product Linking** - Link pages to Jira issues bidirectionally
- **Page Templates** - Create pages from reusable templates

## Quick Start

### 1. Initialize Directory

```bash
atlcli wiki docs init ./docs --space TEAM
```

### 2. Pull Pages

```bash
atlcli wiki docs pull ./docs
```

### 3. Edit Files

Files are standard markdown with YAML frontmatter:

```markdown
---
id: "12345"
title: "API Documentation"
space: "TEAM"
---

# API Documentation

Your content here...
```

### 4. Push Changes

```bash
atlcli wiki docs push ./docs
```

## Sections

- [Sync](sync.md) - Bidirectional sync, conflict handling, daemon mode
- [Pages](pages.md) - Create, update, delete, move, sort pages
- [Spaces](spaces.md) - Space operations
- [Export](export.md) - Export pages to DOCX with Word templates
- [Templates](templates.md) - Page templates with variables
- [Macros](macros.md) - Info panels, notes, warnings, TOC
- [Attachments](attachments.md) - Sync images and files
- [File Format](file-format.md) - Frontmatter and directory structure
