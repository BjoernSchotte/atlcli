---
title: "Macros"
description: "Macros - atlcli documentation"
---

# Macros

atlcli provides extensive Confluence macro support with bidirectional conversion between markdown and Confluence Storage Format.

## Prerequisites

- Basic understanding of markdown syntax
- For push operations: Edit permission on target Confluence space

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

atlcli converts standard fenced code blocks to Confluence code macros:

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

### Noformat Block

Preformatted text without syntax highlighting:

````markdown
```noformat
This text preserves whitespace
  and formatting exactly
    as written.
```
````

## Text Formatting

### Colored Text

Apply color to inline text:

```markdown
This is {color:red}red text{color} and {color:#0066cc}blue text{color}.
```

Supports CSS color names and hex codes.

### Background Color

Highlight text with background color:

```markdown
This is {bg:yellow}highlighted{bg} text.
{bg:#e6f3ff}Custom background{bg}
```

### Subscript and Superscript

```markdown
H~2~O (subscript)
E=mc^2^ (superscript)
```

## Task Lists

Native checkbox support:

```markdown
- [ ] Unchecked task
- [x] Completed task
- [ ] Another pending task
```

Converts to Confluence's native task list format with proper checkboxes.

## Date Macro

Insert formatted dates:

```markdown
{date:2025-01-15}
```

Rendered as a Confluence date picker showing the specified date.

## Emoticons

Use emoji shortcodes:

```markdown
:smile: :thumbsup: :warning: :star:
```

### Supported Emoticons

| Shortcode | Aliases |
|-----------|---------|
| `:smile:` | `:)` |
| `:sad:` | `:(` |
| `:thumbs-up:` | `:+1:`, `:thumbsup:` |
| `:thumbs-down:` | `:-1:`, `:thumbsdown:` |
| `:star:` | |
| `:warning:` | `:warn:` |
| `:info:` | `:information:` |
| `:tick:` | `:check:`, `:checkmark:` |
| `:cross:` | `:x:`, `:error:` |
| `:light-on:` | `:bulb:`, `:idea:` |
| `:heart:` | `:love:` |
| `:question:` | `:?:` |

## User Mentions

Mention users by account ID:

```markdown
@[John Doe](557058:abcd-efgh-ijkl)
```

The account ID can be found in Confluence user profiles or via the API.

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

## Smart Links

Atlassian smart links are rich links to Jira issues, Confluence pages, and other Atlassian content that display contextual information. atlcli supports bidirectional conversion of smart links.

### Markdown Format

When pulling pages, atlcli converts smart links to standard markdown URLs:

```markdown
# Inline link (default)
[PROJ-123](https://your-site.atlassian.net/browse/PROJ-123)

# Card view - shows preview card
[PROJ-123](https://your-site.atlassian.net/browse/PROJ-123)<!--card-->

# Embed view - embeds content
[Page Title](https://your-site.atlassian.net/wiki/spaces/TEAM/pages/12345)<!--embed-->
```

### How It Works

| Direction | Process |
|-----------|---------|
| **Pull** | Smart links → Full URLs with display mode annotations |
| **Push** | Atlassian URLs → Smart links with `data-card-appearance` |

### Display Modes

| Mode | Annotation | Description |
|------|------------|-------------|
| Inline | (none) | Link appears inline in text |
| Card | `<!--card-->` | Shows preview card with title and metadata |
| Embed | `<!--embed-->` | Embeds full content preview |

### Supported URL Patterns

- **Jira Issues**: `/browse/PROJ-123`
- **Confluence Pages**: `/wiki/spaces/SPACE/pages/12345`
- **Trello**: `trello.com/c/...` or `trello.com/b/...`
- **Bitbucket**: `bitbucket.org/user/repo`

### Profile-Based Conversion

atlcli converts only URLs matching your active profile's Atlassian instance to smart links. External URLs remain as regular markdown links.

```markdown
# Converted to smart link (same instance)
[Issue](https://your-site.atlassian.net/browse/PROJ-123)

# Remains regular link (different instance)
[External](https://other-site.atlassian.net/browse/PROJ-456)
```

## Jira Integration

### Single Issue (Legacy)

The `{jira:KEY}` syntax is deprecated. Use full URLs instead:

```markdown
# Deprecated (still works)
{jira:PROJ-123}

# Recommended - use full URL
[PROJ-123](https://your-site.atlassian.net/browse/PROJ-123)
```

When pulling pages, Jira macros are automatically converted to full URLs.

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

## TOC Zone

Create a table of contents for a specific section:

```markdown
::: toc-zone minLevel=2 maxLevel=4
## Section 1
Content...
## Section 2
Content...
:::
```

Only headings within the zone are included in the TOC.

## Page Properties

### Details Summary (Page Properties Panel)

Display page metadata in a panel:

```markdown
::: details
| Property | Value |
|----------|-------|
| Status | Active |
| Owner | John |
:::
```

### Details (Hidden Metadata)

Store metadata without displaying:

```markdown
::: detailssummary hidden=true
| Key | Value |
|-----|-------|
| internal-id | 12345 |
:::
```

## Tasks Report

Display a summary of tasks across pages:

```markdown
:::tasks-report-macro spaces="TEAM" pageSize=20
:::
```

Shows tasks from specified spaces with pagination.

## Labels Macros

### Labels List

Display labels for the current page:

```markdown
:::labels-list
:::
```

### Popular Labels

Show frequently used labels in a space:

```markdown
:::popular-labels spaces="TEAM" count=20
:::
```

### Related Labels

Show labels related to current page's labels:

```markdown
:::related-labels labels="api,docs"
:::
```

## Blog Posts

Display recent blog posts:

```markdown
:::blog-posts max=10 spaces="DEV,OPS" labels="announcement"
:::
```

Options:

| Option | Description |
|--------|-------------|
| `max` | Maximum posts to show |
| `spaces` | Comma-separated space keys |
| `labels` | Filter by labels |
| `author` | Filter by author account ID |
| `time` | Time period filter |
| `sort` | Sort order |

## Spaces List

List available spaces:

```markdown
:::spaces-list
:::
```

## Page Index

Display alphabetical index of pages:

```markdown
:::page-index
:::
```

## Contributors

Show page contributors:

```markdown
:::contributors mode=list showCount=true
:::
```

Options:

| Option | Description |
|--------|-------------|
| `mode` | `list` or `inline` |
| `showCount` | Show contribution count |
| `limit` | Max contributors to show |
| `order` | `update` or `name` |
| `showLastTime` | Show last contribution time |

## Change History

Display page change history:

```markdown
:::change-history
:::
```

Options:

| Option | Description |
|--------|-------------|
| `limit` | Max entries to show |
| `showProfilePic` | Show contributor avatars |
| `showSpace` | Show space name |

## Lorem Ipsum

Generate placeholder text:

```markdown
:::loremipsum paragraphs=3
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

**atlcli preserves unrecognized macros as-is.** This ensures no information loss during sync:

```markdown
::: unknown-macro param1=value1 param2=value2
Content inside the unknown macro.
:::
```

On push, atlcli converts this to Confluence's storage format and preserves it. On pull, atlcli converts it back exactly.

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

## Troubleshooting

### Macro Not Rendering

**Symptom**: Macro appears as raw text in Confluence.

**Cause**: Unclosed macro block or incorrect syntax.

**Fix**: Ensure every `:::macro` has a matching `:::` closing tag. Validate with:
```bash
atlcli wiki docs check ./docs/page.md
```

### Unknown Macro Warning

**Symptom**: Warning about unrecognized macro during push.

**Cause**: The macro isn't in atlcli's supported list.

**Fix**: This is safe—atlcli preserves unknown macros as-is, and they render correctly in Confluence.

## Related Topics

- [Sync](sync.md) - Push and pull pages with macro content
- [Validation](validation.md) - Pre-push checks including macro syntax
- [File Format](file-format.md) - Frontmatter and markdown structure
- [Pages](pages.md) - Create and update pages
