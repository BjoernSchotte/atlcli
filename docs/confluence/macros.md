# Macros

atlcli provides extensive Confluence macro support with bidirectional conversion between markdown and Confluence Storage Format.

## Panel Macros

### Info Panel

```markdown
::: info
This is an informational message.
:::
```

With title:

```markdown
::: info "Important Information"
This is an info panel with a title.
:::
```

### Note Panel

```markdown
::: note
This is a note for the reader.
:::
```

### Warning Panel

```markdown
::: warning
This action cannot be undone!
:::
```

### Tip Panel

```markdown
::: tip
Pro tip: Use keyboard shortcuts for faster navigation.
:::
```

### Custom Panel

Full control over panel styling:

```markdown
::: panel title="Custom Panel" bgColor="#f0f0f0" borderColor="#ccc" borderStyle="solid"
Custom styled panel content.
:::
```

Options:

| Option | Description |
|--------|-------------|
| `title` | Panel title |
| `bgColor` | Background color (hex) |
| `borderColor` | Border color (hex) |
| `borderStyle` | solid, dashed, none |

## Expand/Collapse

### Basic Expand

```markdown
::: expand "Click to expand"
This content is hidden by default.
:::
```

### Expanded by Default

```markdown
::: expand "Details" expanded=true
This content is visible by default.
:::
```

## Table of Contents

```markdown
::: toc
:::
```

With options:

```markdown
::: toc minLevel=2 maxLevel=4
:::
```

Options:

| Option | Description |
|--------|-------------|
| `minLevel` | Minimum heading level (default: 1) |
| `maxLevel` | Maximum heading level (default: 6) |
| `style` | none, disc, circle, square |

## Code Blocks

Standard fenced code blocks are converted to Confluence code macros:

````markdown
```javascript
function hello() {
  console.log("Hello, world!");
}
```
````

With title:

````markdown
```python title="example.py"
def hello():
    print("Hello, world!")
```
````

With line numbers:

````markdown
```typescript linenumbers=true
const greeting: string = "Hello";
console.log(greeting);
```
````

### Supported Languages

JavaScript, TypeScript, Python, Java, Go, Rust, C, C++, C#, Ruby, PHP, SQL, Bash, YAML, JSON, XML, HTML, CSS, and many more.

## Status Macro

Inline status labels:

```markdown
{status:green}Approved{status}
{status:yellow}In Review{status}
{status:red}Rejected{status}
{status:blue}In Progress{status}
{status:grey}Draft{status}
```

Colors: `green`, `yellow`, `red`, `blue`, `grey`

## Anchor Macro

Create link anchors:

```markdown
{#my-anchor}

Link to [my section](#my-anchor).
```

## Jira Integration

### Single Issue

```markdown
{jira:PROJ-123}
```

### JQL Query

```markdown
{jira:project = PROJ AND status = Open|columns=key,summary,status}
```

Options:

| Option | Description |
|--------|-------------|
| `columns` | Columns to display |
| `count` | Show count only |
| `cache` | Cache duration |

## Page Structure

### Children Macro

List child pages:

```markdown
::: children
:::
```

With options:

```markdown
::: children depth=2 sort=title
:::
```

Options:

| Option | Description |
|--------|-------------|
| `depth` | How many levels deep |
| `sort` | title, created, modified |
| `reverse` | Reverse sort order |
| `style` | none, disc, circle, square |

### Page Tree

Display page tree navigation:

```markdown
::: pagetree root=12345 depth=3
:::
```

### Recently Updated

```markdown
::: recently-updated spaces=TEAM,DOCS max=10
:::
```

### Content by Label

```markdown
::: content-by-label labels=api,documentation
:::
```

## Layout Macros

### Section and Column

```markdown
::: section
::: column width=50%
Left column content.
:::
::: column width=50%
Right column content.
:::
:::
```

### Excerpt

Mark content for reuse:

```markdown
::: excerpt
This content can be included in other pages.
:::
```

### Include Excerpt

Include excerpt from another page:

```markdown
::: excerpt-include page="Page Title" nopanel=true
:::
```

## Media Macros

### Gallery

Display attached images as gallery:

```markdown
::: gallery columns=3
:::
```

### Attachments List

List page attachments:

```markdown
::: attachments patterns=*.pdf,*.docx
:::
```

### Multimedia

Embed video or audio:

```markdown
::: multimedia url="https://youtube.com/watch?v=..." width=640 height=480
:::
```

### Widget/Embed

Embed external content:

```markdown
::: widget url="https://example.com/embed" width=100%
:::
```

## Confluence Wiki Syntax

For compatibility, Confluence wiki attachment syntax is also supported:

```markdown
!image.png!                    <!-- Inline image -->
!image.png|alt=Description!    <!-- Image with alt text -->
!document.pdf!                 <!-- File download link -->
```

## Unknown Macros

**Macros that atlcli doesn't recognize are preserved as-is.** This ensures no information loss during sync:

```markdown
::: unknown-macro param1=value1 param2=value2
Content inside the unknown macro.
:::
```

On push, this is converted to Confluence's storage format and preserved. On pull, it's converted back exactly.

## Conversion Details

| Direction | Process |
|-----------|---------|
| **Push** | Markdown → Confluence Storage Format (XHTML) |
| **Pull** | Storage Format → Markdown |

### Round-Trip Safety

All supported macros round-trip cleanly:

1. Pull page with macros → Markdown
2. Edit markdown
3. Push back → Identical macro rendering

### Unsupported Macros

Some complex macros render to placeholder text with a note:

```markdown
<!-- Confluence macro: roadmap - not fully supported, preserved as-is -->
::: roadmap
...
:::
```

## Best Practices

1. **Use standard markdown** when possible (tables, code blocks, lists)
2. **Reserve macros** for Confluence-specific features (panels, toc, jira)
3. **Test round-trips** for complex pages before relying on sync
4. **Check preview** with `atlcli wiki docs preview` before pushing
