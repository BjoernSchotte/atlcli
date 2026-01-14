# Attachments

Sync images and files with Confluence pages.

## Image References

Reference images in markdown:

```markdown
![Diagram](./images/architecture.png)
```

On push, atlcli uploads the image as an attachment and updates the reference.

## Pull Attachments

```bash
atlcli wiki docs pull ./docs --attachments
```

Downloads all attachments to a local `attachments/` directory.

## Push Attachments

New or modified local files are automatically uploaded on push.

## Supported Formats

- Images: PNG, JPG, GIF, SVG
- Documents: PDF, DOCX, XLSX
- Archives: ZIP

## Size Limits

Attachments are subject to your Confluence instance limits (typically 25MB per file).
