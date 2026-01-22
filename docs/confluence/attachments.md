# Attachments

Sync images and files with Confluence pages.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Space permission**: View for pull, Edit for push operations

## Quick Start

```bash
# Pull pages (attachments included by default)
atlcli wiki docs pull ./docs

# Pull without attachments (faster)
atlcli wiki docs pull ./docs --no-attachments

# Push - atlcli automatically uploads new/changed attachments
atlcli wiki docs push ./docs
```

## Image References

Reference images in markdown:

```markdown
![Diagram](./images/architecture.png)
```

On push, atlcli uploads the image as an attachment and updates the reference.

## Pull Attachments

Attachments are downloaded by default during pull. To skip them:

```bash
atlcli wiki docs pull ./docs --no-attachments
```

Attachments are saved to a directory named after the page (e.g., `page-name/` alongside `page-name.md`).

## Push Attachments

New or modified local files are automatically uploaded on push.

## Supported Formats

- Images: PNG, JPG, GIF, SVG
- Documents: PDF, DOCX, XLSX
- Archives: ZIP

## Size Limits

Attachments are subject to your Confluence instance limits (typically 25MB per file).

## Examples

### Minimal: Add an Image to a Page

```markdown
# Architecture Overview

Here's our system diagram:

![System Architecture](./architecture.png)
```

On push, atlcli uploads `architecture.png` and converts the reference to a Confluence attachment link.

### Advanced: Organize Attachments in Subdirectories

```
docs/
├── api-reference.md
├── api-reference/
│   └── images/
│       ├── auth-flow.png
│       └── request-lifecycle.svg
└── getting-started.md
```

Reference with relative paths:

```markdown
# API Reference

## Authentication Flow

![Auth Flow](./api-reference/images/auth-flow.png)
```

atlcli preserves the directory structure and uploads all referenced files.

## Troubleshooting

### Attachment Not Uploading

**Symptom**: Image referenced in markdown not appearing in Confluence.

**Causes**:
- File path incorrect or file doesn't exist
- File exceeds size limit
- Unsupported format

**Fix**: Verify the file exists at the referenced path. Check file size and format.

### Broken Image After Pull

**Symptom**: Image shows as broken link after pulling.

**Cause**: Attachment was deleted in Confluence or pull ran with `--no-attachments`.

**Fix**: Run `atlcli wiki docs pull ./docs` to re-download attachments.

## Related Topics

- [Sync](sync.md) - Pull and push with attachment handling
- [File Format](file-format.md) - Attachment directory structure
- [Export](export.md) - Include attachments in DOCX exports
