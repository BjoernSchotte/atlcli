# Confluence Macros Phase 2 - Additional Macro Support

## Overview

This plan covers implementing bidirectional support for additional Confluence macros that were not included in Phase 1. These are primarily display/reporting macros that roundtrip well between markdown and Confluence storage format.

## Current Status

Phase 1 implemented these macros:
- Panel macros: `info`, `note`, `warning`, `tip`, `panel`
- Navigation: `toc`, `expand`, `children`, `pagetree`
- Content reuse: `excerpt`, `excerpt-include`, `include`
- Media: `gallery`, `attachments`, `multimedia`, `widget`
- Layout: `section`, `column`
- Inline: `status`, `anchor`, `jira`, `date`
- Code: `code`, `noformat`
- Reporting: `content-by-label`, `recently-updated`

## Phase 2 Macros

### Priority 1: Documentation Essentials

These macros are commonly used in technical documentation:

| Macro | Purpose | Syntax | Parameters |
|-------|---------|--------|------------|
| **toc-zone** | TOC for specific section | `:::toc-zone` | minLevel, maxLevel, location |
| **page-properties** | Key-value metadata | `:::page-properties` | id, hidden |
| **page-properties-report** | Query properties | `:::page-properties-report` | labels, spaces, cql |
| **task-report** | Task completion report | `:::task-report` | spaces, labels, days |

### Priority 2: Labels & Discovery

| Macro | Purpose | Syntax | Parameters |
|-------|---------|--------|------------|
| **labels-list** | Show page labels | `:::labels` | - |
| **popular-labels** | Tag cloud | `:::popular-labels` | count, spaces |
| **related-labels** | Related content | `:::related-labels` | labels |

### Priority 3: Content Listings

| Macro | Purpose | Syntax | Parameters |
|-------|---------|--------|------------|
| **blog-posts** | List blog entries | `:::blog-posts` | max, spaces, labels, time |
| **spaces-list** | List spaces | `:::spaces-list` | spaces, width |
| **page-index** | Alphabetical index | `:::page-index` | - |

### Priority 4: Page Metadata

| Macro | Purpose | Syntax | Parameters |
|-------|---------|--------|------------|
| **contributors** | Page contributors | `:::contributors` | mode, limit |
| **change-history** | Version history | `:::change-history` | - |

### Priority 5: Utility

| Macro | Purpose | Syntax | Parameters |
|-------|---------|--------|------------|
| **loremipsum** | Placeholder text | `:::loremipsum` | paragraphs |

---

## Detailed Implementation

### 1. toc-zone

Creates a table of contents for only the content within the zone.

**Markdown syntax:**
```markdown
:::toc-zone minLevel=2 maxLevel=4

## Section One
Content here...

## Section Two
More content...

:::
```

**Confluence storage:**
```xml
<ac:structured-macro ac:name="toc-zone">
  <ac:parameter ac:name="minLevel">2</ac:parameter>
  <ac:parameter ac:name="maxLevel">4</ac:parameter>
  <ac:rich-text-body>
    <h2>Section One</h2>
    <p>Content here...</p>
    <h2>Section Two</h2>
    <p>More content...</p>
  </ac:rich-text-body>
</ac:structured-macro>
```

**Parameters:**
- `minLevel` (1-6): Minimum heading level to include
- `maxLevel` (1-6): Maximum heading level to include
- `location` (top|bottom): Where to place TOC within zone

**Implementation:**

```typescript
// In markdownToStorage - block handler
} else if (macro === "toc-zone") {
  const minLevelMatch = firstLine.match(/minLevel=["']?(\d+)["']?/i);
  const maxLevelMatch = firstLine.match(/maxLevel=["']?(\d+)["']?/i);
  const locationMatch = firstLine.match(/location=["']?(top|bottom)["']?/i);

  let html = `<ac:structured-macro ac:name="toc-zone">`;
  if (minLevelMatch) {
    html += `\n<ac:parameter ac:name="minLevel">${escapeHtml(minLevelMatch[1])}</ac:parameter>`;
  }
  if (maxLevelMatch) {
    html += `\n<ac:parameter ac:name="maxLevel">${escapeHtml(maxLevelMatch[1])}</ac:parameter>`;
  }
  if (locationMatch) {
    html += `\n<ac:parameter ac:name="location">${escapeHtml(locationMatch[1])}</ac:parameter>`;
  }
  const innerHtml = markdownToStorage(innerContent);
  html += `\n<ac:rich-text-body>${innerHtml}</ac:rich-text-body>`;
  html += `\n</ac:structured-macro>`;
  return html;
}

// In preprocessStorageMacros
storage = storage.replace(
  /<ac:structured-macro\s+ac:name="toc-zone"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
  (_, inner) => {
    const minLevelMatch = inner.match(/<ac:parameter\s+ac:name="minLevel"[^>]*>([^<]*)<\/ac:parameter>/i);
    const maxLevelMatch = inner.match(/<ac:parameter\s+ac:name="maxLevel"[^>]*>([^<]*)<\/ac:parameter>/i);
    const locationMatch = inner.match(/<ac:parameter\s+ac:name="location"[^>]*>([^<]*)<\/ac:parameter>/i);
    const bodyMatch = inner.match(/<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/i);

    let params = "";
    if (minLevelMatch) params += ` minLevel=${minLevelMatch[1]}`;
    if (maxLevelMatch) params += ` maxLevel=${maxLevelMatch[1]}`;
    if (locationMatch) params += ` location=${locationMatch[1]}`;

    const body = bodyMatch ? bodyMatch[1] : "";
    return `<div data-macro="toc-zone" data-params="${escapeHtml(params.trim())}">${body}</div>`;
  }
);
```

---

### 2. page-properties

Displays a table of key-value properties that can be queried by page-properties-report.

**Markdown syntax:**
```markdown
:::page-properties id="project-info"
| Key | Value |
|-----|-------|
| Status | Active |
| Owner | @john |
| Due Date | 2025-03-15 |
:::
```

**Confluence storage:**
```xml
<ac:structured-macro ac:name="details" ac:schema-version="1">
  <ac:parameter ac:name="id">project-info</ac:parameter>
  <ac:rich-text-body>
    <table>
      <tr><th>Key</th><th>Value</th></tr>
      <tr><td>Status</td><td>Active</td></tr>
      <tr><td>Owner</td><td>@john</td></tr>
      <tr><td>Due Date</td><td>2025-03-15</td></tr>
    </table>
  </ac:rich-text-body>
</ac:structured-macro>
```

Note: Confluence calls this macro "details" internally.

**Parameters:**
- `id`: Identifier for the property set (for querying)
- `hidden` (true|false): Hide the table on the page

**Implementation:**

```typescript
// In markdownToStorage - block handler
} else if (macro === "page-properties") {
  const idMatch = firstLine.match(/id=["']?([^"'\s]+)["']?/i);
  const hiddenMatch = firstLine.match(/hidden(?:=["']?(true|false)["']?)?/i);

  let html = `<ac:structured-macro ac:name="details" ac:schema-version="1">`;
  if (idMatch) {
    html += `\n<ac:parameter ac:name="id">${escapeHtml(idMatch[1])}</ac:parameter>`;
  }
  if (hiddenMatch && hiddenMatch[1] !== "false") {
    html += `\n<ac:parameter ac:name="hidden">true</ac:parameter>`;
  }
  const innerHtml = markdownToStorage(innerContent);
  html += `\n<ac:rich-text-body>${innerHtml}</ac:rich-text-body>`;
  html += `\n</ac:structured-macro>`;
  return html;
}

// In preprocessStorageMacros
storage = storage.replace(
  /<ac:structured-macro\s+ac:name="details"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
  (_, inner) => {
    const idMatch = inner.match(/<ac:parameter\s+ac:name="id"[^>]*>([^<]*)<\/ac:parameter>/i);
    const hiddenMatch = inner.match(/<ac:parameter\s+ac:name="hidden"[^>]*>([^<]*)<\/ac:parameter>/i);
    const bodyMatch = inner.match(/<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/i);

    let params = "";
    if (idMatch) params += ` id="${idMatch[1]}"`;
    if (hiddenMatch && hiddenMatch[1] === "true") params += ` hidden`;

    const body = bodyMatch ? bodyMatch[1] : "";
    return `<div data-macro="page-properties" data-params="${escapeHtml(params.trim())}">${body}</div>`;
  }
);
```

---

### 3. page-properties-report

Queries and displays properties from multiple pages.

**Markdown syntax:**
```markdown
:::page-properties-report labels="project-status" spaces="DEV,OPS"
:::
```

**Confluence storage:**
```xml
<ac:structured-macro ac:name="detailssummary">
  <ac:parameter ac:name="label">project-status</ac:parameter>
  <ac:parameter ac:name="spaces">DEV,OPS</ac:parameter>
</ac:structured-macro>
```

Note: Confluence calls this macro "detailssummary" internally.

**Parameters:**
- `labels`: Labels to filter pages (required)
- `spaces`: Spaces to search (comma-separated)
- `cql`: CQL query for advanced filtering
- `headings`: Column headings to include
- `sortBy`: Sort column
- `pageSize`: Results per page

**Implementation:**

```typescript
// In markdownToStorage - block handler
} else if (macro === "page-properties-report") {
  const labelsMatch = firstLine.match(/labels=["']?([^"'\s]+)["']?/i);
  const spacesMatch = firstLine.match(/spaces=["']?([^"'\s]+)["']?/i);
  const cqlMatch = firstLine.match(/cql=["']([^"']+)["']/i);
  const headingsMatch = firstLine.match(/headings=["']([^"']+)["']/i);
  const sortByMatch = firstLine.match(/sortBy=["']?([^"'\s]+)["']?/i);
  const pageSizeMatch = firstLine.match(/pageSize=["']?(\d+)["']?/i);

  let html = `<ac:structured-macro ac:name="detailssummary">`;
  if (labelsMatch) {
    html += `\n<ac:parameter ac:name="label">${escapeHtml(labelsMatch[1])}</ac:parameter>`;
  }
  if (spacesMatch) {
    html += `\n<ac:parameter ac:name="spaces">${escapeHtml(spacesMatch[1])}</ac:parameter>`;
  }
  if (cqlMatch) {
    html += `\n<ac:parameter ac:name="cql">${escapeHtml(cqlMatch[1])}</ac:parameter>`;
  }
  if (headingsMatch) {
    html += `\n<ac:parameter ac:name="headings">${escapeHtml(headingsMatch[1])}</ac:parameter>`;
  }
  if (sortByMatch) {
    html += `\n<ac:parameter ac:name="sortBy">${escapeHtml(sortByMatch[1])}</ac:parameter>`;
  }
  if (pageSizeMatch) {
    html += `\n<ac:parameter ac:name="pageSize">${escapeHtml(pageSizeMatch[1])}</ac:parameter>`;
  }
  html += `\n</ac:structured-macro>`;
  return html;
}

// In preprocessStorageMacros - handle both self-closing and with body
storage = storage.replace(
  /<ac:structured-macro\s+ac:name="detailssummary"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
  (_, inner) => {
    const labelMatch = inner.match(/<ac:parameter\s+ac:name="label"[^>]*>([^<]*)<\/ac:parameter>/i);
    const spacesMatch = inner.match(/<ac:parameter\s+ac:name="spaces"[^>]*>([^<]*)<\/ac:parameter>/i);
    const cqlMatch = inner.match(/<ac:parameter\s+ac:name="cql"[^>]*>([^<]*)<\/ac:parameter>/i);
    const headingsMatch = inner.match(/<ac:parameter\s+ac:name="headings"[^>]*>([^<]*)<\/ac:parameter>/i);
    const sortByMatch = inner.match(/<ac:parameter\s+ac:name="sortBy"[^>]*>([^<]*)<\/ac:parameter>/i);
    const pageSizeMatch = inner.match(/<ac:parameter\s+ac:name="pageSize"[^>]*>([^<]*)<\/ac:parameter>/i);

    let params: string[] = [];
    if (labelMatch) params.push(`labels="${labelMatch[1]}"`);
    if (spacesMatch) params.push(`spaces="${spacesMatch[1]}"`);
    if (cqlMatch) params.push(`cql="${cqlMatch[1]}"`);
    if (headingsMatch) params.push(`headings="${headingsMatch[1]}"`);
    if (sortByMatch) params.push(`sortBy="${sortByMatch[1]}"`);
    if (pageSizeMatch) params.push(`pageSize="${pageSizeMatch[1]}"`);

    return `<div data-macro="page-properties-report" data-params="${escapeHtml(params.join(' '))}"></div>`;
  }
);

storage = storage.replace(
  /<ac:structured-macro\s+ac:name="detailssummary"[^>]*\/>/gi,
  () => `<div data-macro="page-properties-report"></div>`
);
```

---

### 4. task-report

Shows task completion status across pages.

**Markdown syntax:**
```markdown
:::task-report spaces="DEV" labels="sprint-1" days=30
:::
```

**Confluence storage:**
```xml
<ac:structured-macro ac:name="tasks-report-macro">
  <ac:parameter ac:name="spaces">DEV</ac:parameter>
  <ac:parameter ac:name="labels">sprint-1</ac:parameter>
  <ac:parameter ac:name="days">30</ac:parameter>
</ac:structured-macro>
```

**Parameters:**
- `spaces`: Spaces to search (comma-separated)
- `labels`: Labels to filter by
- `days`: Time period in days
- `assignee`: Filter by assignee
- `status`: Filter by status (complete|incomplete)

**Implementation:**

```typescript
// In markdownToStorage - block handler
} else if (macro === "task-report") {
  const spacesMatch = firstLine.match(/spaces=["']?([^"'\s]+)["']?/i);
  const labelsMatch = firstLine.match(/labels=["']?([^"'\s]+)["']?/i);
  const daysMatch = firstLine.match(/days=["']?(\d+)["']?/i);
  const assigneeMatch = firstLine.match(/assignee=["']?([^"'\s]+)["']?/i);
  const statusMatch = firstLine.match(/status=["']?(complete|incomplete)["']?/i);

  let html = `<ac:structured-macro ac:name="tasks-report-macro">`;
  if (spacesMatch) {
    html += `\n<ac:parameter ac:name="spaces">${escapeHtml(spacesMatch[1])}</ac:parameter>`;
  }
  if (labelsMatch) {
    html += `\n<ac:parameter ac:name="labels">${escapeHtml(labelsMatch[1])}</ac:parameter>`;
  }
  if (daysMatch) {
    html += `\n<ac:parameter ac:name="days">${escapeHtml(daysMatch[1])}</ac:parameter>`;
  }
  if (assigneeMatch) {
    html += `\n<ac:parameter ac:name="assignee">${escapeHtml(assigneeMatch[1])}</ac:parameter>`;
  }
  if (statusMatch) {
    html += `\n<ac:parameter ac:name="status">${escapeHtml(statusMatch[1])}</ac:parameter>`;
  }
  html += `\n</ac:structured-macro>`;
  return html;
}

// In preprocessStorageMacros
storage = storage.replace(
  /<ac:structured-macro\s+ac:name="tasks-report-macro"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
  (_, inner) => {
    const spacesMatch = inner.match(/<ac:parameter\s+ac:name="spaces"[^>]*>([^<]*)<\/ac:parameter>/i);
    const labelsMatch = inner.match(/<ac:parameter\s+ac:name="labels"[^>]*>([^<]*)<\/ac:parameter>/i);
    const daysMatch = inner.match(/<ac:parameter\s+ac:name="days"[^>]*>([^<]*)<\/ac:parameter>/i);
    const assigneeMatch = inner.match(/<ac:parameter\s+ac:name="assignee"[^>]*>([^<]*)<\/ac:parameter>/i);
    const statusMatch = inner.match(/<ac:parameter\s+ac:name="status"[^>]*>([^<]*)<\/ac:parameter>/i);

    let params: string[] = [];
    if (spacesMatch) params.push(`spaces="${spacesMatch[1]}"`);
    if (labelsMatch) params.push(`labels="${labelsMatch[1]}"`);
    if (daysMatch) params.push(`days=${daysMatch[1]}`);
    if (assigneeMatch) params.push(`assignee="${assigneeMatch[1]}"`);
    if (statusMatch) params.push(`status="${statusMatch[1]}"`);

    return `<div data-macro="task-report" data-params="${escapeHtml(params.join(' '))}"></div>`;
  }
);

storage = storage.replace(
  /<ac:structured-macro\s+ac:name="tasks-report-macro"[^>]*\/>/gi,
  () => `<div data-macro="task-report"></div>`
);
```

---

### 5. labels-list

Shows labels attached to the current page.

**Markdown syntax:**
```markdown
:::labels
:::
```

**Confluence storage:**
```xml
<ac:structured-macro ac:name="labels-list"/>
```

**Parameters:** None

**Implementation:**

```typescript
// In markdownToStorage - block handler
} else if (macro === "labels") {
  return `<ac:structured-macro ac:name="labels-list"/>`;
}

// In preprocessStorageMacros
storage = storage.replace(
  /<ac:structured-macro\s+ac:name="labels-list"[^>]*\/?>([\s\S]*?<\/ac:structured-macro>)?/gi,
  () => `<div data-macro="labels"></div>`
);
```

---

### 6. popular-labels

Shows a tag cloud of popular labels.

**Markdown syntax:**
```markdown
:::popular-labels count=20 spaces="DEV,OPS"
:::
```

**Confluence storage:**
```xml
<ac:structured-macro ac:name="popular-labels">
  <ac:parameter ac:name="count">20</ac:parameter>
  <ac:parameter ac:name="spaces">DEV,OPS</ac:parameter>
</ac:structured-macro>
```

**Parameters:**
- `count`: Number of labels to show
- `spaces`: Spaces to include (comma-separated)
- `style`: Display style (list|heatmap)

**Implementation:**

```typescript
// In markdownToStorage - block handler
} else if (macro === "popular-labels") {
  const countMatch = firstLine.match(/count=["']?(\d+)["']?/i);
  const spacesMatch = firstLine.match(/spaces=["']?([^"'\s]+)["']?/i);
  const styleMatch = firstLine.match(/style=["']?(list|heatmap)["']?/i);

  let html = `<ac:structured-macro ac:name="popular-labels">`;
  if (countMatch) {
    html += `\n<ac:parameter ac:name="count">${escapeHtml(countMatch[1])}</ac:parameter>`;
  }
  if (spacesMatch) {
    html += `\n<ac:parameter ac:name="spaces">${escapeHtml(spacesMatch[1])}</ac:parameter>`;
  }
  if (styleMatch) {
    html += `\n<ac:parameter ac:name="style">${escapeHtml(styleMatch[1])}</ac:parameter>`;
  }
  html += `\n</ac:structured-macro>`;
  return html;
}

// In preprocessStorageMacros
storage = storage.replace(
  /<ac:structured-macro\s+ac:name="popular-labels"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
  (_, inner) => {
    const countMatch = inner.match(/<ac:parameter\s+ac:name="count"[^>]*>([^<]*)<\/ac:parameter>/i);
    const spacesMatch = inner.match(/<ac:parameter\s+ac:name="spaces"[^>]*>([^<]*)<\/ac:parameter>/i);
    const styleMatch = inner.match(/<ac:parameter\s+ac:name="style"[^>]*>([^<]*)<\/ac:parameter>/i);

    let params: string[] = [];
    if (countMatch) params.push(`count=${countMatch[1]}`);
    if (spacesMatch) params.push(`spaces="${spacesMatch[1]}"`);
    if (styleMatch) params.push(`style="${styleMatch[1]}"`);

    return `<div data-macro="popular-labels" data-params="${escapeHtml(params.join(' '))}"></div>`;
  }
);

storage = storage.replace(
  /<ac:structured-macro\s+ac:name="popular-labels"[^>]*\/>/gi,
  () => `<div data-macro="popular-labels"></div>`
);
```

---

### 7. related-labels

Shows content related by labels.

**Markdown syntax:**
```markdown
:::related-labels labels="api,documentation"
:::
```

**Confluence storage:**
```xml
<ac:structured-macro ac:name="related-labels">
  <ac:parameter ac:name="labels">api,documentation</ac:parameter>
</ac:structured-macro>
```

**Parameters:**
- `labels`: Labels to find related content for (comma-separated)

**Implementation:**

```typescript
// In markdownToStorage - block handler
} else if (macro === "related-labels") {
  const labelsMatch = firstLine.match(/labels=["']?([^"'\s]+)["']?/i);

  let html = `<ac:structured-macro ac:name="related-labels">`;
  if (labelsMatch) {
    html += `\n<ac:parameter ac:name="labels">${escapeHtml(labelsMatch[1])}</ac:parameter>`;
  }
  html += `\n</ac:structured-macro>`;
  return html;
}

// In preprocessStorageMacros
storage = storage.replace(
  /<ac:structured-macro\s+ac:name="related-labels"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
  (_, inner) => {
    const labelsMatch = inner.match(/<ac:parameter\s+ac:name="labels"[^>]*>([^<]*)<\/ac:parameter>/i);

    let params = "";
    if (labelsMatch) params = `labels="${labelsMatch[1]}"`;

    return `<div data-macro="related-labels" data-params="${escapeHtml(params)}"></div>`;
  }
);

storage = storage.replace(
  /<ac:structured-macro\s+ac:name="related-labels"[^>]*\/>/gi,
  () => `<div data-macro="related-labels"></div>`
);
```

---

### 8. blog-posts

Lists blog posts from specified spaces.

**Markdown syntax:**
```markdown
:::blog-posts max=10 spaces="TEAM" labels="announcement" time="1M"
:::
```

**Confluence storage:**
```xml
<ac:structured-macro ac:name="blog-posts">
  <ac:parameter ac:name="max">10</ac:parameter>
  <ac:parameter ac:name="spaces">TEAM</ac:parameter>
  <ac:parameter ac:name="labels">announcement</ac:parameter>
  <ac:parameter ac:name="time">1M</ac:parameter>
</ac:structured-macro>
```

**Parameters:**
- `max`: Maximum number of posts
- `spaces`: Spaces to include (comma-separated, or @self)
- `labels`: Filter by labels
- `time`: Time period (e.g., 1M, 1W, 30D)
- `sort`: Sort order (created|modified)
- `author`: Filter by author

**Implementation:**

```typescript
// In markdownToStorage - block handler
} else if (macro === "blog-posts") {
  const maxMatch = firstLine.match(/max=["']?(\d+)["']?/i);
  const spacesMatch = firstLine.match(/spaces=["']?([^"'\s]+)["']?/i);
  const labelsMatch = firstLine.match(/labels=["']?([^"'\s]+)["']?/i);
  const timeMatch = firstLine.match(/time=["']?([^"'\s]+)["']?/i);
  const sortMatch = firstLine.match(/sort=["']?(created|modified)["']?/i);
  const authorMatch = firstLine.match(/author=["']?([^"'\s]+)["']?/i);

  let html = `<ac:structured-macro ac:name="blog-posts">`;
  if (maxMatch) {
    html += `\n<ac:parameter ac:name="max">${escapeHtml(maxMatch[1])}</ac:parameter>`;
  }
  if (spacesMatch) {
    html += `\n<ac:parameter ac:name="spaces">${escapeHtml(spacesMatch[1])}</ac:parameter>`;
  }
  if (labelsMatch) {
    html += `\n<ac:parameter ac:name="labels">${escapeHtml(labelsMatch[1])}</ac:parameter>`;
  }
  if (timeMatch) {
    html += `\n<ac:parameter ac:name="time">${escapeHtml(timeMatch[1])}</ac:parameter>`;
  }
  if (sortMatch) {
    html += `\n<ac:parameter ac:name="sort">${escapeHtml(sortMatch[1])}</ac:parameter>`;
  }
  if (authorMatch) {
    html += `\n<ac:parameter ac:name="author">${escapeHtml(authorMatch[1])}</ac:parameter>`;
  }
  html += `\n</ac:structured-macro>`;
  return html;
}

// In preprocessStorageMacros
storage = storage.replace(
  /<ac:structured-macro\s+ac:name="blog-posts"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
  (_, inner) => {
    const maxMatch = inner.match(/<ac:parameter\s+ac:name="max"[^>]*>([^<]*)<\/ac:parameter>/i);
    const spacesMatch = inner.match(/<ac:parameter\s+ac:name="spaces"[^>]*>([^<]*)<\/ac:parameter>/i);
    const labelsMatch = inner.match(/<ac:parameter\s+ac:name="labels"[^>]*>([^<]*)<\/ac:parameter>/i);
    const timeMatch = inner.match(/<ac:parameter\s+ac:name="time"[^>]*>([^<]*)<\/ac:parameter>/i);
    const sortMatch = inner.match(/<ac:parameter\s+ac:name="sort"[^>]*>([^<]*)<\/ac:parameter>/i);
    const authorMatch = inner.match(/<ac:parameter\s+ac:name="author"[^>]*>([^<]*)<\/ac:parameter>/i);

    let params: string[] = [];
    if (maxMatch) params.push(`max=${maxMatch[1]}`);
    if (spacesMatch) params.push(`spaces="${spacesMatch[1]}"`);
    if (labelsMatch) params.push(`labels="${labelsMatch[1]}"`);
    if (timeMatch) params.push(`time="${timeMatch[1]}"`);
    if (sortMatch) params.push(`sort="${sortMatch[1]}"`);
    if (authorMatch) params.push(`author="${authorMatch[1]}"`);

    return `<div data-macro="blog-posts" data-params="${escapeHtml(params.join(' '))}"></div>`;
  }
);

storage = storage.replace(
  /<ac:structured-macro\s+ac:name="blog-posts"[^>]*\/>/gi,
  () => `<div data-macro="blog-posts"></div>`
);
```

---

### 9. spaces-list

Lists Confluence spaces.

**Markdown syntax:**
```markdown
:::spaces-list spaces="DEV,OPS,TEAM" width=100%
:::
```

**Confluence storage:**
```xml
<ac:structured-macro ac:name="spaces-list">
  <ac:parameter ac:name="spaces">DEV,OPS,TEAM</ac:parameter>
  <ac:parameter ac:name="width">100%</ac:parameter>
</ac:structured-macro>
```

**Parameters:**
- `spaces`: Spaces to list (comma-separated, or @all, @favorites)
- `width`: Display width
- `theme`: Display theme

**Implementation:**

```typescript
// In markdownToStorage - block handler
} else if (macro === "spaces-list") {
  const spacesMatch = firstLine.match(/spaces=["']?([^"'\s]+)["']?/i);
  const widthMatch = firstLine.match(/width=["']?([^"'\s]+)["']?/i);
  const themeMatch = firstLine.match(/theme=["']?([^"'\s]+)["']?/i);

  let html = `<ac:structured-macro ac:name="spaces-list">`;
  if (spacesMatch) {
    html += `\n<ac:parameter ac:name="spaces">${escapeHtml(spacesMatch[1])}</ac:parameter>`;
  }
  if (widthMatch) {
    html += `\n<ac:parameter ac:name="width">${escapeHtml(widthMatch[1])}</ac:parameter>`;
  }
  if (themeMatch) {
    html += `\n<ac:parameter ac:name="theme">${escapeHtml(themeMatch[1])}</ac:parameter>`;
  }
  html += `\n</ac:structured-macro>`;
  return html;
}

// In preprocessStorageMacros
storage = storage.replace(
  /<ac:structured-macro\s+ac:name="spaces-list"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
  (_, inner) => {
    const spacesMatch = inner.match(/<ac:parameter\s+ac:name="spaces"[^>]*>([^<]*)<\/ac:parameter>/i);
    const widthMatch = inner.match(/<ac:parameter\s+ac:name="width"[^>]*>([^<]*)<\/ac:parameter>/i);
    const themeMatch = inner.match(/<ac:parameter\s+ac:name="theme"[^>]*>([^<]*)<\/ac:parameter>/i);

    let params: string[] = [];
    if (spacesMatch) params.push(`spaces="${spacesMatch[1]}"`);
    if (widthMatch) params.push(`width="${widthMatch[1]}"`);
    if (themeMatch) params.push(`theme="${themeMatch[1]}"`);

    return `<div data-macro="spaces-list" data-params="${escapeHtml(params.join(' '))}"></div>`;
  }
);

storage = storage.replace(
  /<ac:structured-macro\s+ac:name="spaces-list"[^>]*\/>/gi,
  () => `<div data-macro="spaces-list"></div>`
);
```

---

### 10. page-index

Shows an alphabetical index of pages.

**Markdown syntax:**
```markdown
:::page-index
:::
```

**Confluence storage:**
```xml
<ac:structured-macro ac:name="index"/>
```

**Parameters:** None for basic usage

**Implementation:**

```typescript
// In markdownToStorage - block handler
} else if (macro === "page-index") {
  return `<ac:structured-macro ac:name="index"/>`;
}

// In preprocessStorageMacros
storage = storage.replace(
  /<ac:structured-macro\s+ac:name="index"[^>]*\/?>([\s\S]*?<\/ac:structured-macro>)?/gi,
  () => `<div data-macro="page-index"></div>`
);
```

---

### 11. contributors

Shows who contributed to the page.

**Markdown syntax:**
```markdown
:::contributors mode=list limit=10
:::
```

**Confluence storage:**
```xml
<ac:structured-macro ac:name="contributors">
  <ac:parameter ac:name="mode">list</ac:parameter>
  <ac:parameter ac:name="limit">10</ac:parameter>
</ac:structured-macro>
```

**Parameters:**
- `mode`: Display mode (list|inline)
- `limit`: Maximum contributors to show
- `include`: Include specific contribution types
- `showLastTime`: Show last contribution time
- `showCount`: Show contribution count

**Implementation:**

```typescript
// In markdownToStorage - block handler
} else if (macro === "contributors") {
  const modeMatch = firstLine.match(/mode=["']?(list|inline)["']?/i);
  const limitMatch = firstLine.match(/limit=["']?(\d+)["']?/i);
  const showLastTimeMatch = firstLine.match(/showLastTime(?:=["']?(true|false)["']?)?/i);
  const showCountMatch = firstLine.match(/showCount(?:=["']?(true|false)["']?)?/i);

  let html = `<ac:structured-macro ac:name="contributors">`;
  if (modeMatch) {
    html += `\n<ac:parameter ac:name="mode">${escapeHtml(modeMatch[1])}</ac:parameter>`;
  }
  if (limitMatch) {
    html += `\n<ac:parameter ac:name="limit">${escapeHtml(limitMatch[1])}</ac:parameter>`;
  }
  if (showLastTimeMatch && showLastTimeMatch[1] !== "false") {
    html += `\n<ac:parameter ac:name="showLastTime">true</ac:parameter>`;
  }
  if (showCountMatch && showCountMatch[1] !== "false") {
    html += `\n<ac:parameter ac:name="showCount">true</ac:parameter>`;
  }
  html += `\n</ac:structured-macro>`;
  return html;
}

// In preprocessStorageMacros
storage = storage.replace(
  /<ac:structured-macro\s+ac:name="contributors"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
  (_, inner) => {
    const modeMatch = inner.match(/<ac:parameter\s+ac:name="mode"[^>]*>([^<]*)<\/ac:parameter>/i);
    const limitMatch = inner.match(/<ac:parameter\s+ac:name="limit"[^>]*>([^<]*)<\/ac:parameter>/i);
    const showLastTimeMatch = inner.match(/<ac:parameter\s+ac:name="showLastTime"[^>]*>([^<]*)<\/ac:parameter>/i);
    const showCountMatch = inner.match(/<ac:parameter\s+ac:name="showCount"[^>]*>([^<]*)<\/ac:parameter>/i);

    let params: string[] = [];
    if (modeMatch) params.push(`mode="${modeMatch[1]}"`);
    if (limitMatch) params.push(`limit=${limitMatch[1]}`);
    if (showLastTimeMatch && showLastTimeMatch[1] === "true") params.push("showLastTime");
    if (showCountMatch && showCountMatch[1] === "true") params.push("showCount");

    return `<div data-macro="contributors" data-params="${escapeHtml(params.join(' '))}"></div>`;
  }
);

storage = storage.replace(
  /<ac:structured-macro\s+ac:name="contributors"[^>]*\/>/gi,
  () => `<div data-macro="contributors"></div>`
);
```

---

### 12. change-history

Shows page version history.

**Markdown syntax:**
```markdown
:::change-history
:::
```

**Confluence storage:**
```xml
<ac:structured-macro ac:name="change-history"/>
```

**Parameters:** None

**Implementation:**

```typescript
// In markdownToStorage - block handler
} else if (macro === "change-history") {
  return `<ac:structured-macro ac:name="change-history"/>`;
}

// In preprocessStorageMacros
storage = storage.replace(
  /<ac:structured-macro\s+ac:name="change-history"[^>]*\/?>([\s\S]*?<\/ac:structured-macro>)?/gi,
  () => `<div data-macro="change-history"></div>`
);
```

---

### 13. loremipsum

Generates placeholder text (useful for prototyping).

**Markdown syntax:**
```markdown
:::loremipsum paragraphs=3
:::
```

**Confluence storage:**
```xml
<ac:structured-macro ac:name="loremipsum">
  <ac:parameter ac:name="0">3</ac:parameter>
</ac:structured-macro>
```

**Parameters:**
- `paragraphs`: Number of paragraphs (default 1)

**Implementation:**

```typescript
// In markdownToStorage - block handler
} else if (macro === "loremipsum") {
  const paragraphsMatch = firstLine.match(/paragraphs=["']?(\d+)["']?/i);
  const count = paragraphsMatch ? paragraphsMatch[1] : "1";

  return `<ac:structured-macro ac:name="loremipsum">\n<ac:parameter ac:name="0">${escapeHtml(count)}</ac:parameter>\n</ac:structured-macro>`;
}

// In preprocessStorageMacros
storage = storage.replace(
  /<ac:structured-macro\s+ac:name="loremipsum"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
  (_, inner) => {
    const countMatch = inner.match(/<ac:parameter\s+ac:name="[^"]*"[^>]*>(\d+)<\/ac:parameter>/i);
    const count = countMatch ? countMatch[1] : "1";

    return `<div data-macro="loremipsum" data-params="paragraphs=${count}"></div>`;
  }
);

storage = storage.replace(
  /<ac:structured-macro\s+ac:name="loremipsum"[^>]*\/>/gi,
  () => `<div data-macro="loremipsum" data-params="paragraphs=1"></div>`
);
```

---

## Shared Turndown Rule

All these macros use a similar div-based preprocessing, so they can share a single turndown rule:

```typescript
// Handle Phase 2 macros (generic div-based)
service.addRule("phase2Macros", {
  filter: (node) => {
    if (node.nodeName !== "DIV") return false;
    const macro = (node as Element).getAttribute?.("data-macro");
    return [
      "toc-zone", "page-properties", "page-properties-report", "task-report",
      "labels", "popular-labels", "related-labels", "blog-posts",
      "spaces-list", "page-index", "contributors", "change-history", "loremipsum"
    ].includes(macro || "");
  },
  replacement: (content, node) => {
    const macro = (node as Element).getAttribute?.("data-macro") || "";
    const params = (node as Element).getAttribute?.("data-params") || "";

    // Macros with body content
    if (["toc-zone", "page-properties"].includes(macro) && content.trim()) {
      return `\n\n:::${macro}${params ? " " + params : ""}\n${content.trim()}\n:::\n\n`;
    }

    // Macros without body
    return `\n\n:::${macro}${params ? " " + params : ""}\n:::\n\n`;
  },
});
```

---

## Update KNOWN_MACROS

Add the new macros to the KNOWN_MACROS list:

```typescript
const KNOWN_MACROS = [
  // Phase 1 (existing)
  "info", "note", "warning", "tip", "expand", "toc", "status", "anchor",
  "jira", "panel", "code", "noformat", "excerpt", "excerpt-include",
  "include", "gallery", "attachments", "multimedia", "widget", "section",
  "column", "children", "content-by-label", "recently-updated", "pagetree", "date",
  // Phase 2 (new)
  "toc-zone", "details", "detailssummary", "tasks-report-macro", "labels-list",
  "popular-labels", "related-labels", "blog-posts", "spaces-list", "index",
  "contributors", "change-history", "loremipsum"
];
```

---

## Testing Strategy

### Unit Tests

For each macro, test:
1. Markdown → Storage conversion
2. Storage → Markdown conversion
3. Round-trip (MD → Storage → MD)
4. All parameter combinations
5. Edge cases (empty params, special characters)

### E2E Tests

Test in DOCSY space:
1. Create page with each macro via markdown
2. Push to Confluence
3. Verify renders correctly in Confluence UI
4. Pull back and verify markdown matches

### Test File Template

```typescript
describe("phase 2 macros", () => {
  describe("toc-zone", () => {
    test("converts basic toc-zone to storage", () => {
      const md = ":::toc-zone\n## Heading\nContent\n:::";
      const storage = markdownToStorage(md);
      expect(storage).toContain('ac:name="toc-zone"');
      expect(storage).toContain("<ac:rich-text-body>");
    });

    test("converts storage toc-zone to markdown", () => {
      const storage = `<ac:structured-macro ac:name="toc-zone"><ac:rich-text-body><h2>Heading</h2></ac:rich-text-body></ac:structured-macro>`;
      const md = storageToMarkdown(storage);
      expect(md).toContain(":::toc-zone");
      expect(md).toContain("## Heading");
    });

    test("handles minLevel and maxLevel params", () => {
      const md = ":::toc-zone minLevel=2 maxLevel=4\n## H2\n### H3\n:::";
      const storage = markdownToStorage(md);
      expect(storage).toContain('ac:name="minLevel">2</ac:parameter>');
      expect(storage).toContain('ac:name="maxLevel">4</ac:parameter>');
    });
  });

  // Similar tests for each macro...
});
```

---

## Implementation Order

### Week 1: Priority 1 - Documentation Essentials
1. toc-zone
2. page-properties
3. page-properties-report
4. task-report

### Week 2: Priority 2 - Labels & Discovery
5. labels-list
6. popular-labels
7. related-labels

### Week 3: Priority 3 - Content Listings
8. blog-posts
9. spaces-list
10. page-index

### Week 4: Priority 4 & 5 - Metadata & Utility
11. contributors
12. change-history
13. loremipsum

---

## Files to Modify

| File | Changes |
|------|---------|
| `packages/confluence/src/markdown.ts` | Add handlers for all 13 macros |
| `packages/confluence/src/markdown.test.ts` | Add tests for all 13 macros |

---

## Acceptance Criteria

A macro is complete when:
- [ ] Markdown → Storage produces valid Confluence XML
- [ ] Storage → Markdown produces clean markdown
- [ ] Round-trip preserves all content and parameters
- [ ] Works with pages created in Confluence Cloud UI
- [ ] All parameters are supported
- [ ] Unit tests pass
- [ ] E2E test in DOCSY space passes
