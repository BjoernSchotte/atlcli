# DOCX Export

Export Confluence pages to Microsoft Word (DOCX) format using customizable templates.

::: toc

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Space permission**: View permission on pages to export
- Word-compatible template file (`.docx` or `.docm`)

## Quick Start

```bash
# Export a page using a template
atlcli wiki export 12345678 --template corporate --output ./report.docx

# Export using space:title format
atlcli wiki export "DOCS:Architecture Overview" -t report -o ./arch.docx
```

## Page Reference Formats

| Format | Example | Description |
|--------|---------|-------------|
| Page ID | `12345678` | Numeric Confluence page ID |
| Space:Title | `DOCS:My Page` | Space key and page title |
| URL | `https://...` | Full Confluence page URL |

## Options

| Option | Description |
|--------|-------------|
| `--template, -t` | Template name or path (required) |
| `--output, -o` | Output file path (required) |
| `--no-images` | Don't embed images from attachments |
| `--include-children` | Include child pages in export |
| `--no-merge` | Keep children as separate array for template loops |
| `--no-toc-prompt` | Disable TOC update prompt in Word |
| `--profile` | Use a specific auth profile |

## Templates

### Template Resolution

Templates are resolved in order (first match wins):

1. Direct file path (if exists)
2. Project: `.atlcli/templates/confluence/<name>.docx`
3. Profile: `~/.atlcli/profiles/<profile>/templates/confluence/<name>.docx`
4. Global: `~/.atlcli/templates/confluence/<name>.docx`

atlcli supports both `.docx` and `.docm` (macro-enabled) templates.

### Template Management

```bash
# List available templates
atlcli wiki export template list

# Save a template
atlcli wiki export template save corporate --file ./template.docx --level global

# Delete a template
atlcli wiki export template delete old-template --confirm
```

### Template Levels

| Level | Location | Use Case |
|-------|----------|----------|
| `project` | `.atlcli/templates/confluence/` | Project-specific templates |
| `profile` | `~/.atlcli/profiles/<name>/templates/confluence/` | Instance-specific templates |
| `global` | `~/.atlcli/templates/confluence/` | Shared across all projects |

## Table of Contents

### Confluence TOC Macro

When a Confluence page contains a `:::toc` macro, it's converted to a Word-native TOC field:

```markdown
:::toc
:::
```

The exported TOC:
- Uses Word's built-in TOC functionality
- Includes heading levels 1-3 with hyperlinks
- Shows placeholder text until updated in Word

### TOC Update Behavior

By default, Word prompts to update fields when opening the document:

> "This document contains fields that may refer to other files. Do you want to update the fields in this document?"

Click **Yes** to populate the TOC with correct entries and page numbers.

### Disabling the Prompt

Use `--no-toc-prompt` to disable the update prompt:

```bash
atlcli wiki export 12345 -t report -o out.docx --no-toc-prompt
```

When using this option:
- Word opens without prompting
- TOC shows placeholder text
- Update manually: right-click TOC, select "Update Field"

## Template Variables

Templates use Jinja2 syntax. Available variables:

### Page Content

| Variable | Description |
|----------|-------------|
| `{{ title }}` | Page title |
| `{{ content }}` | Page content (as Word subdocument) |
| `{{ pageId }}` | Confluence page ID |
| `{{ pageUrl }}` | Full page URL |
| `{{ tinyUrl }}` | Short page URL |

### Author Information

| Variable | Description |
|----------|-------------|
| `{{ author }}` | Creator's display name |
| `{{ authorEmail }}` | Creator's email |
| `{{ modifier }}` | Last modifier's display name |
| `{{ modifierEmail }}` | Last modifier's email |

### Dates

| Variable | Description |
|----------|-------------|
| `{{ created }}` | Creation date (ISO format) |
| `{{ modified }}` | Last modified date (ISO format) |
| `{{ exportDate }}` | Export timestamp |

Use the `date` filter for formatting: `{{ modified | date('YYYY-MM-DD') }}`

### Space Information

| Variable | Description |
|----------|-------------|
| `{{ spaceKey }}` | Space key (e.g., "DOCS") |
| `{{ spaceName }}` | Space name |
| `{{ spaceUrl }}` | Space URL |

### Collections

| Variable | Description |
|----------|-------------|
| `{{ labels }}` | List of page labels |
| `{{ attachments }}` | List of attachments |
| `{{ children }}` | Child pages (with `--include-children --no-merge`) |

## Examples

### Basic Export

```bash
atlcli wiki export 12345678 --template basic --output ./page.docx
```

### Export with Children

```bash
# Merge children into single document
atlcli wiki export 12345 -t book -o book.docx --include-children

# Keep children separate for template loops
atlcli wiki export 12345 -t book -o book.docx --include-children --no-merge
```

### Export without Images

```bash
atlcli wiki export 12345 -t report -o report.docx --no-images
```

### Suppress TOC Prompt

```bash
atlcli wiki export 12345 -t report -o report.docx --no-toc-prompt
```

## Scroll Word Exporter Compatibility

atlcli supports templates created for Scroll Word Exporter. Scroll placeholders (`$scroll.title`, `$scroll.content`, etc.) are automatically converted to the equivalent atlcli variables.

## Troubleshooting

### Word Can't Open the File

- Ensure the template is a valid `.docx` or `.docm` file
- Check that the template was created in Word 2007 or later
- Try opening the template itself to verify it's not corrupted

### TOC Not Updating

- Click inside the TOC
- Right-click and select "Update Field"
- Choose "Update entire table"

### Images Not Appearing

- Verify images are attached to the Confluence page
- Check that `--no-images` flag is not set
- Embedded images use the template's image placeholder styling

## Related Topics

- [Pages](pages.md) - Page operations and finding page IDs
- [Attachments](attachments.md) - Managing page attachments for export
- [Templates](templates.md) - Page templates (different from export templates)
