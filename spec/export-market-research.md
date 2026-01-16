# Confluence Export Market Research

## Executive Summary

This document analyzes the Confluence documentation export market to identify opportunities for differentiation. Our research covers user pain points from Atlassian Community forums, competitive landscape analysis, and gaps in existing solutions.

**Key Finding**: There is significant unmet demand for quality CLI-based export tooling that combines reliability, automation, and modern output formats without requiring expensive per-user licensing.

**Priority Insight**: For business users (non-technical), DOCX template-based exports are the highest-value feature. Tools like `docxtpl` (Python) enable business users to create branded templates entirely in Microsoft Word, then populate them programmatically.

**Existing Capability**: atlcli already has markdown export via `pull`/`sync` commands with bidirectional conversion. The export feature extends this with batch operations and professional formats.

---

## 1. User Pain Points

### 1.1 PDF Export Quality

The most universally criticized aspect of Confluence. Users describe native export as "terrible," "a mess," and "horribly broken":

| Issue | Impact |
|-------|--------|
| Image problems | Cropped, super-scaled, or missing (especially Draw.io) |
| Table formatting | Tables collapse, get cut off, or lose styling |
| Layout destruction | Multi-column layouts become single columns |
| Macro rendering | Panel borders disappear, icons low-res, content misaligns |
| Recurring breaks | Export formatting changes with Confluence updates |

**User quote**: "It's completely insane that an app that you have to PAY for is so bad at managing breaking changes."

### 1.2 Word Export Issues

- Exports to legacy `.doc` format (actually multi-part MIME, not binary)
- Incompatible with LibreOffice, Google Docs, Open Office
- Limited to first 50 images per document
- No native `.docx` support

### 1.3 No Automation API

This is a critical gap for DevOps workflows:

- **No REST API** for PDF/Word export in Confluence Cloud
- Feature request CONFCLOUD-61557 open since 2016 with high votes
- `exportSpace` XML-RPC removed in Confluence 9 with no replacement
- Users resort to "emulating UI activity via command line" with captured cookies

### 1.4 Batch/Bulk Export Limitations

- No recursive "export this page tree" option
- Space export is all-or-nothing
- No selective export with label filtering
- No scheduled/automated exports

### 1.5 Customization Friction

- PDF customization requires CSS/HTML knowledge
- Only applies to space exports, not single pages
- Page numbers broken in PDF Export v2 (CSS properties removed)
- Headers/footers require complex workarounds
- Cover pages and branding need third-party apps

### 1.6 Macro Content Loss

- Expand macros export in collapsed state
- JavaScript-dependent content fails to render
- Dynamic macros (charts, interactive) cannot export
- Excerpts and includes sometimes fail

---

## 2. Competitive Landscape

### 2.1 Native Confluence Export

**Formats**: PDF, Word (.doc), HTML, XML, CSV

**Strengths**:
- No additional cost
- Basic functionality works
- Space-level exports available

**Weaknesses**:
- Poor formatting quality
- No API automation
- Limited customization
- No modern Word format (.docx)

### 2.2 K15t Scroll Exporters (Market Leader)

**Pricing**: Starting $5/user/month (Cloud), with ~10% price increases in 2025

**Products**:
- Scroll PDF Exporter
- Scroll Word Exporter
- Scroll HTML Exporter
- Scroll Exporter Extensions (free add-on)

**Strengths**:
- Visual template editor with live preview
- Professional branding (logos, fonts, colors)
- PDF/A archiving compliance for regulated industries
- PDFreactor rendering engine
- REST API for automation
- Template library included
- Strong macro support (Draw.io, Gliffy, PlantUML, Mermaid)

**Weaknesses**:
- Per-user pricing scales poorly
- Template lock-in to K15t ecosystem
- Separate products for PDF/Word/HTML
- Cloud vs Data Center feature parity varies

**Scroll Word Template Engine**:
- Content Controls for placeholder insertion
- TOC macros and page break controls
- Orientation and layout controls
- REST API for programmatic exports
- Template variables limited compared to Jinja2-style

### 2.3 Other Marketplace Apps

| App | Pricing | Key Feature |
|-----|---------|-------------|
| PDF Export for Confluence | Free | Digital signatures |
| Easy PDF Export | Paid | Pixel-perfect layouts |
| miniOrange Exporter | Paid | Bulk export, Google Drive |
| Comala Document Management | Paid | Workflow integration |

### 2.4 Open Source Tools

| Tool | Language | Focus |
|------|----------|-------|
| confluence-markdown-exporter | Python | Markdown for Obsidian/DevOps |
| confluence-dumper (Siemens) | Python | Recursive API export |
| confluence-cli (pchuri) | Node.js | General CLI management |
| confluencer (mam-dev) | Python | Maintenance automation |
| gitfluence | Python | Git history preservation |

**Common Limitations**:
- Fragmented functionality
- Incomplete macro conversion
- No PDF generation
- Limited documentation
- Inconsistent maintenance

---

## 3. Market Gaps

### 3.1 CLI/Automation Gap

No existing tool provides:
- **Unified CLI** for all export formats (PDF, Word, HTML, Markdown)
- **CI/CD integration** without per-user licensing
- **Batch processing** with selective filtering
- **Template-based** output without vendor lock-in

### 3.2 Quality Gap

Native exports fail on:
- Complex table layouts
- Multi-column content
- Embedded diagrams (Draw.io, Mermaid)
- Macro-heavy pages

Third-party solutions address this but require:
- Per-user subscription costs
- Marketplace app installation
- Template configuration in web UI

### 3.3 Format Gap

No solution provides:
- Modern `.docx` without paid apps
- Static site generator output (MkDocs Material, Astro Starlight)
- Markdown with proper macro conversion
- Single-file HTML with embedded assets

### 3.4 Workflow Gap

Missing capabilities:
- Export triggered by page labels or metadata
- Git-based versioning of exports
- Webhook-triggered publishing
- Selective page tree export

---

## 4. Technology Research

### 4.1 DOCX Generation (Priority for Business Users)

#### Python: docxtpl (Recommended)

**Key Advantage**: Business users create templates entirely in Microsoft Word with Jinja2 placeholders.

**Workflow**:
1. Business user creates Word document with desired formatting
2. Inserts placeholders: `{{ customer_name }}`, `{{ invoice_date }}`
3. Saves as .docx template
4. Python script populates with data

**Syntax**:
```
Simple:     {{ variable_name }}
Loops:      {% for item in items %}{{ item.name }}{% endfor %}
Tables:     {%tr for row in rows %}...{% endfor %}
Conditions: {% if show_section %}...{% endif %}
Images:     {{ image }} (via InlineImage class)
```

**Maturity**: v0.20.2 (Nov 2025), actively maintained, Python 3.7-3.13

**Why This is Ideal**:
- Non-technical users can design templates in familiar Word
- Design team modifies fonts, colors, layouts without touching code
- Clear separation of presentation (Word) from data (Python)
- All Word features supported: headers/footers, tables, images, TOC

#### JavaScript: docxtemplater

**Similar concept** but with paid modules for advanced features:
- Free core: text replacement, loops, conditions
- Paid modules: images, HTML, tables, charts (€1,250-3,000/year)

**Alternative**: `docx-templates` (fully open source, more verbose syntax)

#### Comparison: docxtpl vs Scroll Word Exporter

| Feature | docxtpl (atlcli) | Scroll Word Exporter |
|---------|------------------|---------------------|
| Template Creation | Microsoft Word | Web UI or Word |
| Placeholder Syntax | Jinja2 (`{{ }}`) | Content Controls |
| Learning Curve | Low (familiar) | Medium (proprietary) |
| Licensing | Open source | Per-user/month |
| Variable Support | Full Jinja2 | Limited placeholders |
| Loop/Conditional | Yes | Limited |
| Custom Formatting | Full Word control | Template-locked |

### 4.2 Unified PDF + DOCX Generation (Lightweight Approaches)

**Key Finding**: No single library generates both PDF and DOCX from the exact same template. The best approaches use either:
1. Same data context with format-specific templates
2. Markdown as source with Pandoc for both outputs (recommended)

#### Option 1: Pandoc + Markdown (Recommended Unified Approach)

**What**: Single Markdown source generates both PDF and DOCX natively.

```bash
# PDF via Typst (fast, modern)
pandoc document.md --pdf-engine=typst -o document.pdf

# DOCX natively (well-supported)
pandoc document.md -o document.docx
```

**Advantages**:
- Single source document for both formats
- Typst PDF engine: milliseconds, ~40MB
- Native DOCX support is mature in Pandoc
- Pandoc total size: ~150MB (much lighter than LibreOffice ~500MB)
- Jinja2-style variables via `--metadata` or YAML front matter

**Template Variables**:
```yaml
---
title: "{{ title }}"
author: "{{ author }}"
date: "{{ date }}"
---
# {{ title }}
{{ content }}
```

**Maturity**: Pandoc v3.6+ with Typst v0.13+ support

#### Option 2: Python - docxtpl + fpdf2 (Same Data, Different Templates)

**What**: Use Jinja2 data context with format-specific templates.

```python
# Shared data context
context = {"title": "Report", "items": [...]}

# DOCX generation
from docxtpl import DocxTemplate
doc = DocxTemplate("template.docx")
doc.render(context)
doc.save("output.docx")

# PDF generation
from fpdf import FPDF
from jinja2 import Template
html_template = Template(open("template.html").read())
pdf = FPDF()
pdf.add_page()
pdf.write_html(html_template.render(**context))
pdf.output("output.pdf")
```

**Advantages**:
- Pure Python, no external dependencies
- fpdf2 is ~2MB, docxtpl is ~1MB
- Same Jinja2 syntax in both templates
- Business users can still design DOCX templates in Word

**Libraries**:
| Library | Format | Size | Notes |
|---------|--------|------|-------|
| docxtpl | DOCX | ~1MB | Jinja2 in Word templates |
| fpdf2 | PDF | ~2MB | Pure Python, HTML support |
| WeasyPrint | PDF | ~50MB | Better CSS, needs Cairo |

#### Option 3: TypeScript - abstract-document or docx + pdfmake

**abstract-document** (Unified API):
```typescript
import { AbstractDoc } from 'abstract-document';
// Single definition renders to both PDF and DOCX
```

**docx + pdfmake** (Same JSON data):
```typescript
const data = { title: "Report", items: [...] };

// DOCX via docx library
import { Document, Packer } from 'docx';
const doc = new Document({ sections: [...] });

// PDF via pdfmake
import pdfMake from 'pdfmake';
const pdfDoc = pdfMake.createPdf({ content: [...] });
```

**Libraries**:
| Library | Format | Weekly Downloads | Notes |
|---------|--------|------------------|-------|
| docx | DOCX | 300K+ | Declarative, TypeScript-native |
| pdfmake | PDF | 200K+ | JSON document definition |
| abstract-document | Both | ~350 | Unified API (less mature) |

#### Option 4: LibreOffice Headless (Heavy but Reliable)

**Note**: LibreOffice is ~500MB+ but provides highest fidelity DOCX→PDF conversion.

```bash
# Convert DOCX to PDF
libreoffice --headless --convert-to pdf output.docx
```

**For high-volume**: Use `unoserver` for persistent listener (2-4x throughput).

**When to use**: When exact DOCX formatting must be preserved in PDF.

#### Comparison: Lightweight Approaches

| Approach | PDF | DOCX | Size | Same Source | Business User Templates |
|----------|-----|------|------|-------------|------------------------|
| **Pandoc + Markdown** | Yes | Yes | ~150MB | Yes | No (Markdown) |
| **docxtpl + fpdf2** | Yes | Yes | ~3MB | Same data | Yes (Word templates) |
| **docx + pdfmake** | Yes | Yes | ~5MB | Same data | No (code-based) |
| **LibreOffice** | Yes | Yes | ~500MB | Yes | Yes |

#### Recommendation

| Use Case | Recommended Approach |
|----------|---------------------|
| **Technical docs, same source** | Pandoc + Markdown + Typst |
| **Business templates in Word** | docxtpl + fpdf2 (Python) |
| **Node.js/TypeScript stack** | docx + pdfmake |
| **Exact DOCX→PDF fidelity** | LibreOffice (accept the weight) |

### 4.3 Static Site Generators

#### MkDocs Material (Python)

**Key Features**:
- YAML configuration (`mkdocs.yml`)
- Built-in search (lunr.js)
- 60+ language support (i18n via `mkdocs-static-i18n` plugin)
- Versioning via `mike`
- Beautiful Material Design theme
- Admonitions, code blocks, tabs

**Front Matter**:
```yaml
---
title: Page Title
description: SEO description
tags:
  - api
  - reference
---
```

**Navigation**: Configured in `mkdocs.yml` or auto-generated

#### Astro Starlight (TypeScript)

**Key Features**:
- Built on Astro (fast builds)
- Pagefind search (built-in)
- Native i18n support
- MDX/Markdoc support
- Framework-agnostic components

**Front Matter**:
```yaml
---
title: Page Title
description: SEO description
sidebar:
  label: Custom Label
  order: 1
hero:
  title: Welcome
---
```

#### Comparison

| Feature | MkDocs Material | Astro Starlight |
|---------|-----------------|-----------------|
| Language | Python | JavaScript/TypeScript |
| Config | YAML | JavaScript |
| Search | lunr.js | Pagefind |
| Versioning | Mature (mike) | In development |
| i18n | Plugin-based | Native |
| Components | Limited | React/Vue/Svelte |

**Recommendation**: Target both, prioritize MkDocs Material for Python users.

---

## 5. Differentiation Opportunities

### 5.1 CLI-First Architecture

**Opportunity**: Build a CLI tool that provides export capabilities without requiring Marketplace app installation or per-user licensing.

**Differentiators**:
- Works with existing Confluence REST API
- No admin privileges required for basic operations
- Profile-based authentication (like atlcli)
- Scriptable for CI/CD pipelines

### 5.2 Markdown-Native with Macro Intelligence

**Existing Capability**: atlcli already has bidirectional markdown conversion via `pull`/`sync` commands.

**Export Extension**:
- Batch export entire spaces or page trees
- Preserve all macros in markdown-compatible syntax
- Generate front matter for MkDocs Material or Astro Starlight
- Attachment handling with local paths
- Link rewriting for offline use

### 5.3 DOCX Templates for Business Users (Priority)

**Opportunity**: Enable non-technical business users to create branded Word templates.

**Implementation**:
- Use `docxtpl` (Python) for template population
- Business users design templates in Microsoft Word
- Simple placeholder syntax: `{{ title }}`, `{{ content }}`
- Support loops for tables: `{% for row in data %}...{% endfor %}`
- Headers, footers, cover pages all in Word

**User Workflow**:
```
1. Business user creates Word template with branding
2. Adds placeholders where content should go
3. Runs: atlcli confluence export PAGE-123 --format docx --template corporate.docx
4. Gets professionally branded Word document
```

#### Technical Architecture

**Content Pipeline**:
```
Confluence Storage Format → Markdown (existing) → Word Elements (new)
```

We leverage the existing `storageToMarkdown()` conversion, then build a new markdown-to-Word-elements converter that produces `python-docx` objects for insertion into templates.

**Template Variables** (Scroll Word Exporter parity):

| Variable | Description | Type |
|----------|-------------|------|
| `{{ title }}` | Page title | Text |
| `{{ content }}` | Main body content | Rich content |
| `{{ author }}` | Author display name | Text |
| `{{ authorEmail }}` | Author email | Text |
| `{{ created }}` | Creation date | Date |
| `{{ modified }}` | Last modified date | Date |
| `{{ version }}` | Version number | Number |
| `{{ spaceKey }}` | Space key | Text |
| `{{ spaceName }}` | Space name | Text |
| `{{ labels }}` | Page labels | List |
| `{{ pageId }}` | Page ID | Text |
| `{{ pageUrl }}` | Full page URL | Text |
| `{{ toc }}` | Table of contents | Rich content |

**Loop Variables** (for child pages, attachments):
```jinja
{% for child in children %}
  {{ child.title }} - {{ child.author }}
{% endfor %}

{% for attachment in attachments %}
  {{ attachment.name }} ({{ attachment.size }})
{% endfor %}
```

#### PDF Output Approaches

**Approach A: Separate PDF Template (Lightweight, ~3MB)**
- Use `fpdf2` with Jinja2 HTML template
- Same data context as DOCX
- Different template file (HTML instead of DOCX)
- Best for: users who want lightweight deployment

```bash
atlcli confluence export PAGE-123 --format pdf --template report.html
```

**Approach B: DOCX-to-PDF Conversion (Exact Fidelity)**
- Generate DOCX first using docxtpl
- Convert to PDF via external tool
- Options:
  - Pandoc (~150MB): `pandoc output.docx -o output.pdf`
  - LibreOffice (~500MB): `libreoffice --headless --convert-to pdf output.docx`
- Best for: exact Word formatting preservation

```bash
atlcli confluence export PAGE-123 --format pdf --template corporate.docx --pdf-engine pandoc
```

**Comparison**:

| Approach | Size | Fidelity | Speed | Dependencies |
|----------|------|----------|-------|--------------|
| fpdf2 + HTML | ~3MB | Good | Fast | None |
| Pandoc | ~150MB | Good | Fast | pandoc binary |
| LibreOffice | ~500MB | Exact | Slow | libreoffice |

### 5.4 Batch Operations

**Opportunity**: Enable sophisticated batch exports that Confluence native and open source tools lack.

**Differentiators**:
- Export by label, parent page, or CQL query
- Parallel processing for large spaces
- Resume/retry for interrupted exports
- Progress reporting and logging

### 5.5 Modern PDF Generation

**Opportunity**: Use Typst for fast, high-quality PDFs with accessibility compliance.

**Differentiators**:
- Millisecond compilation (vs seconds)
- PDF/A compliance built-in (regulated industries)
- PDF/UA accessibility (government requirements)
- Lightweight deployment (~40MB)

---

## 6. Proposed USP Features

Based on market analysis, these features would provide strong differentiation:

### 6.1 `atlcli confluence export` Command Suite

```bash
# Export single page to various formats
atlcli confluence export PAGE-123 --format pdf --output ./docs/
atlcli confluence export PAGE-123 --format markdown --output ./docs/
atlcli confluence export PAGE-123 --format docx --output ./docs/

# Export page tree recursively
atlcli confluence export PAGE-123 --include-children --format markdown

# Export by label
atlcli confluence export --space DOCS --label release-notes --format pdf

# Export with DOCX template (business user workflow)
atlcli confluence export PAGE-123 --format docx --template corporate.docx
```

### 6.2 Markdown Export (Existing + Enhanced)

Leveraging existing markdown conversion from `pull`/`sync`:
- Batch export entire spaces
- Preserve all macros in markdown-compatible syntax
- Generate front matter for static site generators
- Support for Obsidian-style wiki links

### 6.3 DOCX Template Export (Business User Priority)

```bash
# Use Word template designed by business users
atlcli confluence export PAGE-123 \
  --format docx \
  --template ./templates/corporate-report.docx

# Batch export with template
atlcli confluence export --space DOCS --label public \
  --format docx \
  --template ./templates/client-deliverable.docx
```

**Template Variables Available**:
- `{{ title }}` - Page title
- `{{ content }}` - Main content (HTML converted to Word)
- `{{ author }}` - Author display name
- `{{ lastModified }}` - Last modification date
- `{{ labels }}` - Page labels
- `{{ spaceKey }}` - Space key
- `{{ attachments }}` - List of attachments

### 6.4 Batch Export with Filtering

```bash
# Export entire space
atlcli confluence export --space DOCS --format markdown --output ./wiki/

# Filter by label
atlcli confluence export --space DOCS --label public --format html

# Filter by CQL
atlcli confluence export --cql "label = 'api-docs' AND lastModified > '2025-01-01'"
```

### 6.5 CI/CD Integration

```yaml
# GitHub Actions example
- name: Export documentation
  run: |
    atlcli confluence export \
      --space DOCS \
      --label release \
      --format markdown \
      --output ./docs/

- name: Build MkDocs site
  run: mkdocs build
```

### 6.6 Template-Based PDF

```bash
# Generate PDF with Typst (fast, accessible)
atlcli confluence export PAGE-123 \
  --format pdf \
  --pdf-engine typst \
  --template ./templates/report.typ \
  --cover-page \
  --toc
```

### 6.7 Static Site Generation Bridge

```bash
# Export space as MkDocs-ready content
atlcli confluence export --space DOCS \
  --format mkdocs \
  --output ./docs/ \
  --generate-nav

# Export as Astro Starlight content
atlcli confluence export --space DOCS \
  --format starlight \
  --output ./src/content/docs/
```

---

## 7. Implementation Priority

Based on market demand, technical feasibility, and business user focus:

### Phase 1: Foundation (Markdown + Batch)
1. **Batch markdown export** - Extend existing conversion to spaces/trees
2. **Batch operations** - Export by page tree, labels, CQL
3. **Attachment handling** - Download and link locally
4. **Static site front matter** - MkDocs Material / Astro Starlight

### Phase 2: Business Formats (DOCX Priority)
5. **DOCX export with templates** - Using docxtpl, business user focus
6. **PDF export with Typst** - Fast, accessible, modern
7. **Single-file HTML** - Embedded CSS/images

### Phase 3: Advanced Features
8. **Template library** - Pre-built templates for common use cases
9. **Incremental export** - Only changed pages
10. **Webhook triggers** - Auto-export on publish

---

## 8. Competitive Positioning

### Target Users

| Segment | Pain Point | Our Solution |
|---------|------------|--------------|
| DevOps Engineers | No automation API | CLI with scripting |
| Technical Writers | Poor export quality | Smart markdown conversion |
| Business Users | Need branded documents | DOCX templates in Word |
| Small Teams | Per-user pricing | Flat rate or free |
| Docs-as-Code Teams | No static site support | MkDocs/Starlight integration |
| Compliance Teams | Audit trail needs | Git-based versioning |

### Positioning Statement

> atlcli provides professional-grade Confluence export capabilities through a modern CLI, eliminating the need for expensive per-user marketplace apps while delivering superior markdown conversion, DOCX templating for business users, and automation support.

### Key Differentiators

1. **No per-user licensing** - Tool-based, not seat-based
2. **DOCX templates for business users** - Design in Word, populate with CLI
3. **Markdown-native** - Best-in-class macro conversion (existing capability)
4. **CI/CD ready** - Built for automation from the start
5. **Modern PDF** - Typst for speed and accessibility compliance
6. **Static site bridge** - First-class MkDocs Material / Astro Starlight support
7. **Open and extensible** - Not locked to proprietary templates

---

## 9. Technology Stack Recommendations

### Unified PDF + DOCX (Lightweight)

**Option A: Pandoc + Markdown (Recommended for Technical Docs)**
- Single Markdown source → both PDF and DOCX
- PDF via Typst engine (~40MB, milliseconds)
- Size: ~150MB total (vs LibreOffice ~500MB)
- Best for: documentation, technical content

**Option B: docxtpl + fpdf2 (Recommended for Business Users)**
- Business users design DOCX templates in Word
- Same Jinja2 data context for both formats
- Size: ~3MB total (pure Python)
- Best for: invoices, reports, branded documents

**Option C: docx + pdfmake (TypeScript/Node.js)**
- Same JSON data structure for both
- Size: ~5MB total
- Best for: Node.js applications

### DOCX Generation
- **Python**: `docxtpl` - Jinja2 in Word templates, business user friendly
- **TypeScript**: `docx` - Declarative API, TypeScript-native

### PDF Generation
- **Lightweight**: fpdf2 (~2MB, pure Python) or pdfmake (~3MB, Node.js)
- **Better styling**: WeasyPrint (~50MB, needs Cairo)
- **Best quality**: Pandoc + Typst (~150MB combined)

### Static Sites
- **Python users**: MkDocs Material
- **TypeScript users**: Astro Starlight
- Both require specific front matter and navigation config

### Heavy Option (When Fidelity Matters)
- **LibreOffice headless**: ~500MB but exact DOCX→PDF conversion
- Use `unoserver` for batch processing (2-4x throughput)
- Only when exact Word formatting must be preserved

---

## 10. Research Sources

### Community Forums
- Atlassian Community: Confluence export discussions
- Feature requests: CONFCLOUD-61557, CONFSERVER-40457
- Reddit: r/confluence, r/atlassian discussions

### Product Documentation
- K15t Help Center: Scroll Exporters documentation
- Atlassian Documentation: Native export capabilities

### Open Source
- GitHub: confluence-markdown-exporter, confluence-cli, confluencer
- DEV Community: Confluence Export CLI article

### Technology Documentation
- [docxtpl Documentation](https://docxtpl.readthedocs.io/)
- [fpdf2 Documentation](https://py-pdf.github.io/fpdf2/)
- [Typst Documentation](https://typst.app/docs/)
- [Pandoc User's Guide](https://pandoc.org/MANUAL.html)
- [MkDocs Material](https://squidfunk.github.io/mkdocs-material/)
- [Astro Starlight](https://starlight.astro.build/)
- [docxtemplater](https://docxtemplater.com/)
- [docx (TypeScript)](https://docx.js.org/)
- [pdfmake](https://pdfmake.github.io/docs/)
- [abstract-document](https://www.npmjs.com/package/abstract-document)
- [WeasyPrint](https://doc.courtbouillon.org/weasyprint/stable/)

### Claude/Anthropic Skills
- [Anthropic Skills Repository](https://github.com/anthropics/skills)
- Claude uses: ReportLab (PDF), python-docx (DOCX), pypdf (PDF manipulation)

### Market Analysis
- Atlassian Marketplace: Export app listings and pricing
- Snyk: Package health analysis for library selection
- npm trends: docxtemplater vs docx-templates vs easy-template-x
