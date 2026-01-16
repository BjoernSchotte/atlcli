# Confluence DOCX Export with Word Templates

## Overview

Implement DOCX export feature with Word template support, achieving feature parity with K15t Scroll Word Exporter. Business users design templates in Microsoft Word with Jinja2 placeholders, and atlcli populates them with Confluence content.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  atlcli (TS)    │────▶│ @atlcli/export   │────▶│  output.docx    │
│  CLI + Config   │     │  (Python pkg)    │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
        │                       │
        │                       ├── docxtpl (Jinja2 templates)
        │                       ├── python-docx (Word manipulation)
        │                       └── markdown-to-word (new converter)
        │
        ▼
┌─────────────────┐
│ Confluence API  │
│ (page + attach) │
└─────────────────┘
```

**Flow:**
1. CLI fetches page from Confluence (existing ConfluenceClient)
2. CLI calls Python subprocess with page data as JSON
3. Python package renders template with docxtpl
4. Returns generated DOCX file

## User Requirements (from questions)

| Requirement | Decision |
|-------------|----------|
| Architecture | Python subprocess via `@atlcli/export` package |
| Content scope | Full with macros (info panels, status, expand) |
| PDF output | Phase 2 (DOCX only in Phase 1) |
| Batch export | Single page + `--include-children` flag |
| Templates source | Research Scroll defaults (done below) |
| Template storage | Hierarchical (global → profile → project) |
| Attachments | Both options: `--embed-images` flag |
| Children merge | User choice with `--merge` default |
| Python version | 3.12+ |
| Install | Auto pip install |
| Date format | Custom filter: `{{ modified \| date('YYYY-MM-DD') }}` |
| Testing | DOCSY space |
| Command | `atlcli confluence export` |
| Page lookup | ID, title (SPACE:Title), or URL |

## Scroll Word Exporter Parity

### Placeholder Mapping

Scroll uses `$scroll.variable` syntax. We use Jinja2 `{{ variable }}` (docxtpl native).

| Scroll Placeholder | atlcli Equivalent | Description |
|--------------------|-------------------|-------------|
| `$scroll.title` | `{{ title }}` | Page title |
| `$scroll.content` | `{{ content }}` | Main body (rich) |
| `$scroll.creator.fullName` | `{{ author }}` | Author name |
| `$scroll.creator.email` | `{{ authorEmail }}` | Author email |
| `$scroll.modifier.fullName` | `{{ modifier }}` | Last editor |
| `$scroll.modifier.email` | `{{ modifierEmail }}` | Editor email |
| `$scroll.creationdate` | `{{ created }}` | Creation date |
| `$scroll.modificationdate` | `{{ modified }}` | Modified date |
| `$scroll.creationdate.("yyyy-MM-dd")` | `{{ created \| date('YYYY-MM-DD') }}` | Formatted date |
| `$scroll.pageid` | `{{ pageId }}` | Page ID |
| `$scroll.pageurl` | `{{ pageUrl }}` | Full page URL |
| `$scroll.tinyurl` | `{{ tinyUrl }}` | Short URL |
| `$scroll.pagelabels` | `{{ labels }}` | Labels list |
| `$scroll.space.key` | `{{ spaceKey }}` | Space key |
| `$scroll.space.name` | `{{ spaceName }}` | Space name |
| `$scroll.space.url` | `{{ spaceUrl }}` | Space URL |
| `$scroll.exporter.fullName` | `{{ exportedBy }}` | Who ran export |
| `$scroll.exportdate` | `{{ exportDate }}` | Export timestamp |
| `$scroll.template.name` | `{{ templateName }}` | Template used |

### Loop Variables (Phase 1)

```jinja
{% for child in children %}
  {{ child.title }} - {{ child.author }}
{% endfor %}

{% for attachment in attachments %}
  {{ attachment.filename }} ({{ attachment.size }})
{% endfor %}
```

### Content Handling

The `{{ content }}` variable is special - it inserts rich Word content (not plain text).
We'll use docxtpl's subdocument feature or RichText for this.

## Implementation Plan

### Phase 1A: Python Package Foundation

**Create:** `packages/export/` (Python package)

```
packages/export/
├── pyproject.toml
├── src/
│   └── atlcli_export/
│       ├── __init__.py
│       ├── cli.py              # Entry point for subprocess
│       ├── docx_renderer.py    # docxtpl wrapper
│       ├── markdown_to_word.py # MD → Word elements
│       ├── context.py          # Build template context
│       └── filters.py          # Jinja2 filters (date, etc.)
└── tests/
```

**pyproject.toml:**
```toml
[project]
name = "atlcli-export"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "docxtpl>=0.18.0",
    "python-docx>=1.1.0",
    "markdown>=3.5",
]

[project.scripts]
atlcli-export = "atlcli_export.cli:main"
```

**Key files:**

1. **cli.py** - Subprocess entry point
```python
def main():
    # Read JSON from stdin
    # Call renderer
    # Write DOCX to specified path
    # Return status to stdout
```

2. **docx_renderer.py** - Template rendering
```python
def render_template(template_path: str, context: dict, output_path: str):
    doc = DocxTemplate(template_path)
    doc.render(context)
    doc.save(output_path)
```

3. **markdown_to_word.py** - Convert markdown to Word elements
```python
def markdown_to_subdoc(markdown: str, tpl: DocxTemplate) -> Subdoc:
    # Parse markdown
    # Create Word paragraphs, tables, lists
    # Handle images, code blocks, macros
    # Return as subdocument for insertion
```

4. **context.py** - Build template context from page data
```python
def build_context(page_data: dict, template: DocxTemplate) -> dict:
    return {
        'title': page_data['title'],
        'content': markdown_to_subdoc(page_data['markdown'], template),
        'author': page_data['author']['displayName'],
        # ... all other variables
    }
```

5. **filters.py** - Custom Jinja2 filters
```python
def date_filter(value: str, format: str = 'YYYY-MM-DD') -> str:
    # Parse ISO date, format according to pattern
```

### Phase 1B: CLI Integration

**Modify:** `apps/cli/src/commands/confluence.ts`

Add export subcommand handling:

```typescript
// New export command
case "export":
  await handleExport(rest, flags, opts);
  return;
```

**Create:** `apps/cli/src/commands/confluence-export.ts`

```typescript
export async function handleExport(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  // 1. Parse page identifier (ID, title, or URL)
  const pageRef = args[0];
  const pageId = await resolvePageId(client, pageRef);

  // 2. Fetch page with content
  const page = await client.getPage(pageId);

  // 3. Convert storage to markdown (existing)
  const markdown = storageToMarkdown(page.storage);

  // 4. Fetch attachments if --embed-images
  const attachments = await client.listAttachments(pageId);

  // 5. Build page data JSON
  const pageData = buildPageData(page, markdown, attachments);

  // 6. Resolve template path
  const templatePath = await resolveTemplate(flags);

  // 7. Ensure Python package installed
  await ensureExportPackage();

  // 8. Call Python subprocess
  const outputPath = await callExportSubprocess(pageData, templatePath);

  // 9. Handle --include-children if specified
  if (hasFlag(flags, "include-children")) {
    await exportChildren(client, pageId, pageData, templatePath, outputPath);
  }

  output({ generated: outputPath }, opts);
}
```

**Helper functions:**

```typescript
// Resolve page from ID, "SPACE:Title", or URL
async function resolvePageId(client: ConfluenceClient, ref: string): Promise<string> {
  // If numeric, return as-is
  // If URL, extract page ID from path
  // If "SPACE:Title", search via CQL
}

// Auto-install Python package
async function ensureExportPackage(): Promise<void> {
  // Check if atlcli-export is installed
  // If not, run: pip install atlcli-export
}

// Call Python subprocess
async function callExportSubprocess(
  pageData: object,
  templatePath: string,
  outputPath: string
): Promise<string> {
  // Spawn: atlcli-export --template X --output Y
  // Pipe pageData as JSON to stdin
  // Wait for completion
  // Return output path
}
```

### Phase 1C: Template Storage

**Create:** `packages/confluence/src/templates.ts`

Mirror Jira template pattern with hierarchical storage:

```typescript
// Storage locations
// Global: ~/.atlcli/templates/confluence/
// Profile: ~/.atlcli/profiles/{name}/templates/confluence/
// Project: .atlcli/templates/confluence/

export class ConfluenceTemplateStorage {
  async list(): Promise<TemplateSummary[]>;
  async get(name: string): Promise<string>; // Returns path to .docx
  async save(name: string, sourcePath: string): Promise<void>;
  async delete(name: string): Promise<void>;
}

export class ConfluenceTemplateResolver {
  // Project > Profile > Global precedence
  async resolve(name: string): Promise<string | null>;
}
```

**Template metadata:** Store as `{name}.meta.json` alongside `{name}.docx`:
```json
{
  "name": "corporate-report",
  "description": "Standard corporate report template",
  "createdAt": "2025-01-15T10:00:00Z",
  "variables": ["title", "content", "author", "modified"]
}
```

### Phase 1D: Content Conversion (markdown → Word)

This is the critical piece. Need to convert our markdown to Word elements.

**Supported elements (Phase 1):**

| Markdown | Word Element |
|----------|--------------|
| `# Heading` | Heading 1-6 styles |
| `**bold**` | Bold run |
| `*italic*` | Italic run |
| `[link](url)` | Hyperlink |
| `![img](path)` | Inline image |
| `- list item` | Bullet list |
| `1. item` | Numbered list |
| `\`code\`` | Monospace run |
| ``` \`\`\`code\`\`\` ``` | Code block (styled paragraph) |
| `> quote` | Block quote style |
| `\| table \|` | Word table |
| `::: info` | Info panel (styled box) |
| `::: warning` | Warning panel |
| `{status:color}` | Colored status badge |

**Implementation approach:**

```python
import markdown
from markdown.extensions import tables, fenced_code
from docx import Document
from docx.shared import Pt, Inches
from docxtpl import DocxTemplate, Subdoc

class MarkdownToWordConverter:
    def __init__(self, template: DocxTemplate):
        self.template = template
        self.md = markdown.Markdown(extensions=['tables', 'fenced_code'])

    def convert(self, md_text: str) -> Subdoc:
        # Parse markdown to HTML
        html = self.md.convert(md_text)

        # Create subdocument
        subdoc = self.template.new_subdoc()

        # Parse HTML and build Word elements
        self._process_html(html, subdoc)

        return subdoc

    def _process_html(self, html: str, subdoc: Subdoc):
        # Use BeautifulSoup to parse
        # Walk tree and create corresponding Word elements
        # Handle: p, h1-h6, strong, em, a, img, ul, ol, li, table, pre, blockquote
        # Handle custom macros: div.info-panel, span.status, etc.
```

## Content Source: Fresh Pull vs Local Markdown

### Options

| Flag | Behavior | Use Case |
|------|----------|----------|
| `--source remote` (default) | Always fetch fresh from Confluence | Ensure latest content |
| `--source local` | Use local `.md` files from sync | Offline export, include local edits |
| `--source auto` | Use local if synced & clean, else remote | Smart default for synced projects |

### Decision Factors

**Fresh pull (remote):**
- Always gets latest content
- No dependency on local sync state
- Works from any directory
- Requires network access

**Local markdown (local):**
- Works offline
- Includes unpushed local edits
- Faster (no API calls)
- Requires prior `wiki docs pull`
- Must be in synced directory

**Recommendation:** Default to `--source remote` for simplicity, but support `--source local` for power users working in synced directories.

### Implementation

```typescript
async function getPageContent(
  client: ConfluenceClient,
  pageRef: string,
  source: 'remote' | 'local' | 'auto'
): Promise<{ markdown: string; page: PageInfo }> {
  if (source === 'local' || source === 'auto') {
    const localContent = await tryLoadLocalMarkdown(pageRef);
    if (localContent) {
      return localContent;
    }
    if (source === 'local') {
      throw new Error('Local markdown not found. Run "wiki docs pull" first or use --source remote');
    }
  }
  // Fetch from Confluence
  const page = await client.getPage(pageId);
  const markdown = storageToMarkdown(page.storage);
  return { markdown, page };
}
```

## Scroll Template Compatibility

### Legacy `$scroll.variable` Support

Support Scroll Word Exporter templates directly for easy migration:

| Scroll Syntax | Our Syntax | Handled By |
|---------------|------------|------------|
| `$scroll.title` | `{{ title }}` | Pre-processor |
| `$scroll.content` | `{{ content }}` | Pre-processor |
| `$scroll.creator.fullName` | `{{ author }}` | Pre-processor |
| `$scroll.creationdate.("yyyy-MM-dd")` | `{{ created \| date('yyyy-MM-dd') }}` | Pre-processor |
| `$!scroll.variable` | `{{ variable \| default('') }}` | Pre-processor |

### Template Processing Pipeline

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ Input Template  │────▶│  Pre-processor  │────▶│ docxtpl Render  │
│ (.docx)         │     │ (Scroll→Jinja2) │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

**Pre-processor converts:**
```python
def convert_scroll_placeholders(template_xml: str) -> str:
    # $scroll.variable → {{ variable }}
    # $scroll.creator.fullName → {{ author }}
    # $scroll.creationdate.("format") → {{ created | date('format') }}
    # $!scroll.variable → {{ variable | default('') }}
```

### Template Conversion Command

```bash
# Convert Scroll template to native Jinja2 format
atlcli confluence template convert scroll-template.docx --output native-template.docx

# Shows what will be converted
atlcli confluence template convert scroll-template.docx --dry-run
```

This allows users to:
1. Use existing Scroll templates directly (auto-converted at runtime)
2. Convert templates permanently for better performance
3. Gradually migrate without breaking existing workflows

## CLI Command Reference

```bash
# Basic export
atlcli confluence export <page> --template <name> --output <path>

# Page reference formats
atlcli confluence export 12345678                    # By ID
atlcli confluence export "DOCSY:Architecture"        # By space:title
atlcli confluence export "https://...wiki/12345678"  # By URL

# Content source options
atlcli confluence export 12345678 --source remote    # Always fetch fresh (default)
atlcli confluence export 12345678 --source local     # Use local synced markdown
atlcli confluence export 12345678 --source auto      # Local if clean, else remote

# With options
atlcli confluence export 12345678 \
  --template corporate-report \
  --output ./reports/architecture.docx \
  --embed-images \
  --include-children \
  --merge \
  --source local

# Template management
atlcli confluence template list
atlcli confluence template save <name> --file <path.docx> [--level global|profile|project]
atlcli confluence template get <name>
atlcli confluence template delete <name> --confirm

# Without template (default formatting)
atlcli confluence export 12345678 --output ./export.docx
```

## Files to Create/Modify

### New Files

| File | Purpose |
|------|---------|
| `packages/export/pyproject.toml` | Python package config |
| `packages/export/src/atlcli_export/__init__.py` | Package init |
| `packages/export/src/atlcli_export/cli.py` | CLI entry point |
| `packages/export/src/atlcli_export/docx_renderer.py` | Template rendering |
| `packages/export/src/atlcli_export/markdown_to_word.py` | MD→Word converter |
| `packages/export/src/atlcli_export/context.py` | Context builder |
| `packages/export/src/atlcli_export/filters.py` | Jinja2 filters |
| `packages/confluence/src/templates.ts` | Template storage |
| `apps/cli/src/commands/confluence-export.ts` | Export command |
| `docs/confluence/export.md` | Documentation |

### Modified Files

| File | Changes |
|------|---------|
| `apps/cli/src/commands/confluence.ts` | Add export subcommand routing |
| `packages/confluence/src/index.ts` | Export template types |

## Testing Plan

### Unit Tests

1. **Python package:**
   - `test_markdown_to_word.py` - Conversion for each element type
   - `test_docx_renderer.py` - Template rendering
   - `test_filters.py` - Date formatting

2. **TypeScript:**
   - `confluence-export.test.ts` - Page resolution, subprocess handling
   - `templates.test.ts` - Storage and resolution

### E2E Tests

```bash
# 1. Create test template in Word with placeholders
# 2. Export page from DOCSY space
atlcli confluence export "DOCSY:Test Page" \
  --template test-template \
  --output ./test-output.docx

# 3. Open in Word and verify:
#    - Title, author, dates populated
#    - Content formatted correctly
#    - Tables, images, code blocks work
#    - Macros (info panels) rendered

# 4. Test with children
atlcli confluence export "DOCSY:Parent" \
  --template test-template \
  --include-children \
  --output ./test-children.docx
```

## Implementation Order

1. **Phase 1:** Python package foundation ✅
   - [x] Create package structure
   - [x] Implement basic docx_renderer
   - [x] Implement simple markdown_to_word (paragraphs, headings, bold/italic)
   - [x] Test with basic template

2. **Phase 2:** CLI integration ✅
   - [x] Add export command routing
   - [x] Implement page resolution (ID, title, URL)
   - [x] Implement subprocess calling
   - [x] Auto pip install

3. **Phase 3:** Content conversion ✅
   - [x] Tables
   - [x] Images (with --embed-images)
   - [x] Code blocks
   - [x] Lists
   - [x] Links

4. **Phase 4:** Advanced features ✅
   - [x] Macro panels (info, warning, note, tip)
   - [x] Status badges
   - [x] Template storage (hierarchical)
   - [x] --include-children with merge

5. **Phase 5:** Polish 🔄
   - [ ] Documentation
   - [x] Golden test page for comparison testing
   - [ ] Feature parity comparison with Scroll Word Exporter
   - [ ] Error handling improvements
   - [ ] Default template

## Golden Test Page

A comprehensive test page `DOCSY:Export Feature Test Suite` was created to compare atlcli export with Scroll Word Exporter.

**Test fixtures location:** `packages/export/tests/fixtures/`

| File | Purpose |
|------|---------|
| `export-feature-test-suite.md` | Source markdown with all 16 feature sections |
| `test-image.jpg` | Sample image for image embedding tests |
| `golden-export.docx` | Scroll Word Exporter reference output |
| `basic-template.docx` | Default atlcli template |

**Test page sections:**
1. Basic Formatting (text styles, lists, blockquotes)
2. Tables
3. Code Blocks
4. Links
5. Images
6. Panel Macros (info, warning, note, tip)
7. Status Badges
8. Expand/Collapse
9. Table of Contents
10. Excerpt Macros
11. Task Lists
12. Jira Integration
13. Anchors
14. Emoticons
15. Dynamic Macros (children, content-by-label)
16. Page Properties

**Comparison testing approach:**
```bash
# Export with atlcli
atlcli wiki export 642809861 --template basic-template --output test-export.docx

# Compare against golden-export.docx for feature parity
```

## Verification

```bash
# 1. Install Python package
cd packages/export && pip install -e .

# 2. Run Python tests
pytest packages/export/tests/

# 3. Run TypeScript tests
bun test packages/confluence/src/templates.test.ts
bun test apps/cli/src/commands/confluence-export.test.ts

# 4. E2E test
atlcli confluence export "DOCSY:Getting Started" \
  --template corporate \
  --output ./test.docx

# 5. Verify output in Microsoft Word
open ./test.docx
```
