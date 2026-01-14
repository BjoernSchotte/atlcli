# Pages

Create, update, delete, move, and sort Confluence pages.

## Create Page

```bash
atlcli docs create --space TEAM --title "New Page" --parent "Parent Page"
```

Options:

| Flag | Description |
|------|-------------|
| `--space` | Space key |
| `--title` | Page title |
| `--parent` | Parent page title or ID |
| `--content` | Page content (markdown) |
| `--file` | Read content from file |

## Update Page

```bash
atlcli docs update --page 12345 --content "Updated content"
```

## Delete Page

```bash
atlcli docs delete --page 12345 --confirm
```

## Move Page

```bash
atlcli docs move --page 12345 --parent 67890
```

## Sort Pages

Reorder child pages alphabetically:

```bash
atlcli docs sort --parent 12345
```
