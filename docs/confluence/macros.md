# Macros

Use Confluence macros in your markdown files.

## Supported Macros

### Info Panel

```markdown
::: info
This is an informational message.
:::
```

Renders as a blue info panel.

### Note Panel

```markdown
::: note
This is a note.
:::
```

### Warning Panel

```markdown
::: warning
This is a warning message.
:::
```

### Expand

```markdown
::: expand "Click to expand"
Hidden content here.
:::
```

### Table of Contents

```markdown
::: toc
:::
```

Generates a table of contents from headings.

## Conversion

atlcli converts these to Confluence Storage Format (XHTML) on push and back to markdown on pull.
