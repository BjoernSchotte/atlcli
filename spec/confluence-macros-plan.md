# Confluence Macros Support Plan

## Current Status

We currently support these macros with `:::` syntax:
- `info`, `note`, `warning`, `tip` (panel macros)
- `expand` (collapsible section)
- `toc` (table of contents)

## Macro Categories & Priority

### Priority 1: Essential Documentation Macros

These are frequently used and map well to markdown:

| Macro | Purpose | Proposed Syntax | Parameters |
|-------|---------|-----------------|------------|
| **code** | Syntax-highlighted code block | Use fenced code blocks ` ``` ` | language, title, collapse |
| **panel** | Generic colored panel | `:::panel title="Title" bgColor="#fff"` | title, bgColor, borderColor |
| **status** | Colored status lozenge | `{status:color}Text{status}` or inline | color (grey/red/yellow/green/blue) |
| **anchor** | Link target | `{#anchor-name}` (already HTML standard) | name |
| **noformat** | Preformatted text | Already supported via code blocks | - |

### Priority 2: Content Organization

| Macro | Purpose | Proposed Syntax | Parameters |
|-------|---------|-----------------|------------|
| **children** | List child pages | `:::children` | depth, sort, style |
| **pagetree** | Hierarchical page tree | `:::pagetree` | root, startDepth |
| **excerpt** | Mark reusable content | `:::excerpt` | name, hidden |
| **excerpt-include** | Include excerpt from another page | `:::excerpt-include page="Page Title"` | page |
| **include** | Include entire page | `:::include page="Page Title"` | page |
| **toc-zone** | TOC for specific section | `:::toc-zone` | - |

### Priority 3: Media & Attachments

| Macro | Purpose | Proposed Syntax | Parameters |
|-------|---------|-----------------|------------|
| **gallery** | Image gallery | `:::gallery` | columns, size |
| **attachments** | List attachments | `:::attachments` | patterns, sort |
| **multimedia** | Embed video/audio | `:::multimedia url="..."` | url, width, height |
| **widget** | Embed external content | `:::widget url="..."` | url, width, height |
| **pdf** | Embed PDF | `:::pdf file="..."` | file, page |

### Priority 4: Reporting & Dynamic

| Macro | Purpose | Proposed Syntax | Parameters |
|-------|---------|-----------------|------------|
| **content-by-label** | List pages by label | `:::content-by-label labels="..."` | labels, spaces, sort |
| **recently-updated** | Recent changes | `:::recently-updated` | spaces, max |
| **task-report** | Task list summary | `:::task-report` | spaces, labels |
| **contributors** | Page contributors | `:::contributors` | - |
| **chart** | Data visualization | `:::chart type="pie"` | type, data in body |

### Priority 5: Layout Macros

| Macro | Purpose | Proposed Syntax | Parameters |
|-------|---------|-----------------|------------|
| **column** | Multi-column layout | `:::columns`...`:::column` | width |
| **section** | Section container | `:::section` | - |

### Not Converted (But Preserved)

These macros don't convert to readable markdown but **must be preserved** for round-trip safety:

- **livesearch** - Interactive, requires Confluence
- **create-from-template** - Interactive
- **jira-issues** / **jira-chart** - Requires live Jira connection
- **user-profile** / **profile-picture** - Requires Confluence user data
- **network** - Social features
- **team-calendar** - External integration
- **roadmap-planner** - Interactive planning tool
- **blog-posts** - Confluence-specific
- **page-properties** / **page-properties-report** - Confluence metadata

### Macro Preservation Strategy

**All unrecognized macros must be preserved - zero data loss is mandatory.**

This includes:
- Built-in macros we choose not to convert (jira-issues, livesearch, etc.)
- **Third-party marketplace app macros** (draw.io, Gliffy, Lucidchart, etc.)
- **Custom user macros** created by admins
- **Any future macros** Atlassian adds that we don't know about yet

The converter must use a **whitelist approach**: only macros we explicitly handle get converted to markdown syntax. Everything else gets preserved verbatim.

When pulling from Confluence:

```markdown
:::confluence jira-issues
<!--raw
<ac:structured-macro ac:name="jira">
  <ac:parameter ac:name="server">MyJira</ac:parameter>
  <ac:parameter ac:name="jqlQuery">project = DEV</ac:parameter>
</ac:structured-macro>
-->
*[Jira Issues - view in Confluence]*
:::
```

**Design:**
1. Wrap in `:::confluence <macro-name>` block
2. Store original XML in HTML comment (`<!--raw ... -->`)
3. Show human-readable placeholder text
4. On push, extract and restore the original XML verbatim

**Benefits:**
- Zero data loss on round-trip
- Readable placeholder in markdown
- User can see what macro exists
- Original parameters fully preserved

**Implementation:**

```typescript
// In storageToMarkdown():
function handleUnknownMacro(macroXml: string, macroName: string): string {
  const placeholder = `*[${macroName} - view in Confluence]*`;
  return `\n:::confluence ${macroName}\n<!--raw\n${macroXml}\n-->\n${placeholder}\n:::\n`;
}

// In markdownToStorage():
function restoreConfluenceMacro(block: string): string {
  const rawMatch = block.match(/<!--raw\n([\s\S]*?)\n-->/);
  if (rawMatch) {
    return rawMatch[1]; // Return original XML
  }
  return ''; // Strip if no raw content
}
```

**Warning on edit:**
If user modifies content inside a `:::confluence` block (outside the raw comment), show warning that changes may be lost since we can't convert back to the native macro format.

## Implementation Plan

### Phase 1: Quick Wins (Easy to implement)

1. **status** - Inline colored lozenge
   - Markdown: `{status:green}Done{status}` or `[Done]{.status .green}`
   - Storage: `<ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">Done</ac:parameter></ac:structured-macro>`

2. **panel** - Generic panel with custom colors
   - Markdown: `:::panel title="Custom Panel" bgColor="#f0f0f0"`
   - Extends existing panel implementation

3. **anchor** - Named anchor points
   - Markdown: `{#my-anchor}` or `<a id="my-anchor"></a>`
   - Storage: `<ac:structured-macro ac:name="anchor"><ac:parameter ac:name="0">my-anchor</ac:parameter></ac:structured-macro>`

4. **noformat** - Already works via code blocks without language

### Phase 2: Content Reuse

1. **excerpt** - Define reusable snippets
   - Markdown: `:::excerpt name="intro"`
   - Round-trips to storage format

2. **excerpt-include** - Include from other pages
   - Markdown: `:::excerpt-include page="623869955" name="intro"`
   - Note: Requires page ID or title resolution

3. **include** - Include entire page
   - Markdown: `:::include page="623869955"`

### Phase 3: Media

1. **gallery** - Image gallery from attachments
   - Markdown: `:::gallery columns=3`

2. **attachments** - List file attachments
   - Markdown: `:::attachments patterns="*.pdf"`

3. **multimedia** / **widget** - Embed external content
   - Markdown: `:::widget url="https://youtube.com/..."`

### Phase 4: Layout

1. **columns** - Multi-column layout
   ```markdown
   :::columns
   :::column width=50%
   Left content
   :::
   :::column width=50%
   Right content
   :::
   :::
   ```

### Phase 5: Dynamic Content

These are view-only in markdown (show placeholder):
- **content-by-label**
- **recently-updated**
- **children**
- **pagetree**

## Syntax Design Principles

1. **Fenced blocks** (`:::macro`) for block-level macros with body content
2. **Inline syntax** (`{macro:param}text{macro}`) for inline macros
3. **Parameters** as `key="value"` pairs after macro name
4. **Nested content** supported via indentation or inner `:::`

## Example Document

```markdown
# Project Overview

{#top}

:::info Important Notice
This document is under active development.
:::

## Status

Current status: {status:green}On Track{status}

## Introduction

:::excerpt name="intro"
This project aims to revolutionize documentation workflows.
:::

## Details

:::expand Click for technical details
- Built with TypeScript
- Uses Bun runtime
- Bidirectional sync
:::

:::panel title="Quick Links" bgColor="#e3fcef"
- [Back to top](#top)
- [API Docs](/pages/api)
:::

## Media

:::gallery columns=4
:::

## Child Pages

:::children depth=2
:::
```

## Testing Strategy

**First-class bidirectional compatibility is critical.** Every macro must round-trip perfectly between markdown and Confluence storage format.

### Test Matrix

For each supported macro, we need tests covering:

| Test Type | Description |
|-----------|-------------|
| **Markdown → Storage** | Convert markdown syntax to Confluence storage XML |
| **Storage → Markdown** | Convert Confluence storage XML to markdown syntax |
| **Round-trip** | MD → Storage → MD should produce identical output |
| **Confluence-created** | Pages created in Confluence UI must convert cleanly |
| **Edge cases** | Empty body, special characters, nested macros |

### Test Cases Per Macro

```typescript
describe("info macro", () => {
  it("converts markdown to storage format");
  it("converts storage format to markdown");
  it("round-trips without data loss");
  it("handles title with special characters");
  it("handles empty body");
  it("handles nested formatting (bold, links, code)");
  it("preserves whitespace correctly");
});
```

### Integration Tests

1. **Pull Test**: Create page in Confluence Cloud UI with each macro → pull → verify markdown
2. **Push Test**: Create markdown with macro syntax → push → verify in Confluence UI
3. **Edit Cycle**: Pull → edit locally → push → pull again → compare

### Compatibility Testing

Test against real Confluence Cloud instances:
- Create pages using Confluence's macro picker (not just API)
- Verify all parameter variations are captured
- Test with different Confluence Cloud versions/updates

### Regression Suite

Maintain a corpus of:
- `fixtures/macros/*.storage.xml` - Real Confluence storage format samples
- `fixtures/macros/*.md` - Expected markdown output
- `fixtures/macros/*.roundtrip.md` - Expected round-trip output

Run on every PR:
```bash
bun test packages/core/src/__tests__/macros/
```

### Known Compatibility Considerations

1. **Parameter order**: Confluence may output params in different order
2. **Whitespace**: Confluence normalizes whitespace differently
3. **Self-closing tags**: `<macro/>` vs `<macro></macro>`
4. **CDATA sections**: Some content wrapped in CDATA
5. **Entity encoding**: `&amp;` vs `&` handling

### Acceptance Criteria

A macro is considered "fully supported" when:
- [ ] Markdown → Storage produces valid Confluence XML
- [ ] Storage → Markdown produces clean, readable markdown
- [ ] Round-trip preserves all content and parameters
- [ ] Works with pages created in Confluence Cloud UI
- [ ] Has comprehensive test coverage
- [ ] Documented in README with examples

## Sources

- [Confluence Data Center Macros](https://confluence.atlassian.com/doc/macros-139387.html)
- [Confluence Cloud Macros](https://support.atlassian.com/confluence-cloud/docs/what-are-macros/)
