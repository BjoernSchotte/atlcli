# TypeScript vs Python DOCX Export Analysis

## Overview

This document analyzes TypeScript alternatives to our current Python-based DOCX export implementation (python-docx + docxtpl). The goal is to evaluate whether a pure TypeScript approach could achieve feature parity with K15t Scroll Word Exporter while eliminating the Python subprocess dependency.

## Research Date: January 2026

## Library Comparison Matrix

| Criteria | docx-templates (TS) | docxtemplater (TS) | docx (TS) | easy-template-x (TS) | python-docx + docxtpl |
|----------|--------------------|--------------------|-----------|---------------------|----------------------|
| **Template Support** | Yes | Yes | Programmatic only | Yes | Yes (Jinja2) |
| **Business User Templates** | Yes | Yes | No | Yes (simplest) | Yes |
| **.docm Support** | Explicit (templates) | Not documented | No | Unknown | Workaround |
| **Images** | Free | Paid module | Free | Free | Free |
| **HTML to Word** | altChunk (MS Word only) | Paid module | No | No | Via htmldocx/subdoc |
| **Tables** | Full | Full | Full | Full | Full |
| **Nested Conditionals** | Buggy | Good | N/A | Good | Full Jinja2 |
| **Weekly Downloads** | Medium (varies by source) | High (varies by source) | Very high (varies by source) | Low (varies by source) | Many dependents |
| **Cost** | Free (MIT) | €500-3000/yr | Free (MIT) | Free (MIT) | Free |
| **Maintenance** | Good | Excellent | Excellent | Good | Good |
| **TypeScript Native** | Yes | Yes | Yes | Yes | No |

---

## Detailed Library Analysis

### 1. docx-templates (guigrpa/docx-templates)

**Best TS option for template-based generation**

**Strengths:**
- Native TypeScript with shipped type definitions
- Explicit .docm (macro-enabled) template support
- Built-in HTML command for rich content
- Works in Node.js, browser, and Deno
- Active maintenance (590 commits, 1.1k stars)
- MIT license, completely free

**Template Syntax:**
```
+++INS variable+++
+++FOR item IN items+++
  Row: +++item.name+++
+++END-FOR+++
+++IF condition+++
  Conditional content
+++END-IF+++
+++IMAGE myImage+++
+++HTML htmlContent+++
```

**Critical Limitations:**
- HTML uses altChunk mechanism - **only works in Microsoft Word**, fails in LibreOffice, Google Docs, PDF converters
- Nested IFs are currently disallowed (error), multiple IFs on the same line are problematic
- Nested FORs in the same paragraph can cause infinite-loop errors
- Security risk: templates can execute arbitrary JavaScript (templates must be trusted)
- 69 open issues (relatively high)

**Workaround for HTML limitation:** Must open and save in Word to convert altChunk to native elements, or use literal XML injection (requires OOXML expertise).

---

### 2. docxtemplater (open-xml-templating/docxtemplater)

**Most mature, but paid for key features**

**Strengths:**
- 8+ years of development, most stable
- Largest community (~134K weekly downloads)
- Commercial support available
- Syntax closer to Jinja2: `{variable}`, `{#loop}{/loop}`
- TypeScript definitions included

**Free Features (Core):**
- Text replacement
- Loops and conditionals
- Basic tables

**Paid Modules (€500-3000/year):**
| Module | Price | Feature |
|--------|-------|---------|
| Image | €500+ | Insert/replace images |
| HTML | €500+ | Convert HTML to native Word |
| Chart | €500+ | Update charts from JSON |
| Styling | €500+ | Conditional formatting |
| **Enterprise Bundle** | €3,000/yr | All 18 modules |

**Critical Limitations:**
- No documented .docm support
- Images and HTML require payment
- For full Scroll parity, need €3,000/year Enterprise license
- Redistribution may require an “appliance”/embedding license (not just SaaS)

---

### 3. docx (dolanmiu/docx)

**Best for programmatic document creation**

**Strengths:**
- Most active (5,090+ stars, ~280K downloads)
- Excellent TypeScript support
- Comprehensive feature set for creating documents from scratch
- Works in Node.js and browser
- Interactive playground at docx.js.org

**Limitations:**
- **No template support** - business users cannot create Word templates
- Requires programmatic definition of all document structure
- No .docm support
- Different paradigm from Scroll Word Exporter

**Use Case:** Good if we wanted to rebuild export without templates, converting markdown/HTML to Word elements programmatically.

---

### 4. easy-template-x

**Simplest syntax for non-technical users**

**Template Syntax:**
```
Hello {firstName} {lastName}!
{#items}
- {name}: {price}
{/items}
```

**Strengths:**
- Simplest syntax for business users
- Plugin architecture
- Unicode support (Hebrew, Arabic)

**Limitations:**
- .docm support not documented
- No built-in HTML conversion
- Smaller community (~6-16K downloads)

---

## Scroll Word Exporter Feature Parity

### Template Placeholders

| Scroll Placeholder | docx-templates | docxtemplater | Current Python |
|-------------------|----------------|---------------|----------------|
| `$scroll.title` | Custom parser | Custom parser | ✅ Implemented |
| `$scroll.content` | Custom parser | Custom parser | ✅ Implemented |
| `$scroll.creator.fullName` | Custom parser | Custom parser | ✅ Implemented |
| `$scroll.creationdate.("format")` | Custom parser | Custom parser | ✅ Implemented |
| `$!scroll.variable` (null-safe) | Custom parser | Custom parser | ✅ Implemented |

All TS libraries would require building a custom `$scroll.*` to native syntax converter, which we've already built for Python.

### Confluence Macro Support

| Macro | Scroll Behavior | docx-templates | Current Python |
|-------|-----------------|----------------|----------------|
| Info/Warning/Note/Tip panels | Styled tables | Build as tables | ✅ Implemented |
| Status badges | Text only | Custom styling | ✅ Implemented |
| Code blocks | Scroll Code style | Via HTML | ✅ Implemented |
| Expand macro | Auto-expanded | Build content | ✅ Implemented |
| TOC | Word native TOC | Word refresh | ✅ Placeholder |
| Jira macro | Partial | Build links | ✅ Implemented |

### Critical Gaps in TS Libraries

1. **HTML Rendering Cross-Platform**: docx-templates' altChunk fails in LibreOffice
2. **Nested Logic**: docx-templates disallows nested IFs and can loop on nested FORs in the same paragraph
3. **Cost & licensing**: docxtemplater needs €3K/year for full features; redistribution may require an appliance license
4. **.docm**: Only docx-templates explicitly documents template support; docxtemplater does not

---

## Current Python Implementation Strengths

1. **All features free** - python-docx and docxtpl are MIT/open source
2. **Jinja2 power** - Full template language with nested logic, filters, macros
3. **Subdocument support** - Rich content insertion via tpl.new_subdoc()
4. **Scroll compatibility** - Our preprocessor converts `$scroll.*` to Jinja2
5. **Cross-platform HTML** - Using htmldocx/subdocs works in LibreOffice
6. **Already implemented** - Panels, status badges, images, code blocks working

### Python Limitations

1. **Python dependency** - Requires Python 3.12+ installed
2. **.docm workaround** - Convert to .docx before templating; macros not preserved
3. **No track changes** - python-docx limitation
4. **TOC page numbers** - Requires Word/LibreOffice to populate

---

## Cost Analysis

| Approach | Year 1 | Year 2+ | Notes |
|----------|--------|---------|-------|
| **Current Python** | $0 | $0 | All dependencies free |
| **docx-templates** | $0 | $0 | Free, but HTML limitation |
| **docxtemplater PRO** | €1,250 | €1,250 | 4 modules |
| **docxtemplater Enterprise** | €3,000 | €3,000 | All 18 modules |
| **Scroll Word Exporter** | $60-$26,700 | Same | Cloud vs Data Center |

---

## Recommendation

### Stay with Python

**Rationale:**

1. **Cost**: TS alternatives either lack features (docx-templates HTML limitation) or cost €3000/year (docxtemplater)

2. **Feature completeness**: We already have panels, status badges, images, code blocks, children merge working

3. **Scroll compatibility**: Our `$scroll.*` preprocessor and Jinja2 syntax are closer to Scroll's model than docx-templates' `+++COMMAND+++` syntax

4. **HTML rendering**: docx-templates' altChunk fails in LibreOffice - our subdoc approach is more portable

5. **.docm**: docx-templates has native support, but our workaround is functional and we can improve it

6. **Risk**: Migration would require rebuilding all conversion logic with uncertain feature parity

### If Pure TS Required in Future

The path would be:
1. Use `docx` (programmatic) for building Word elements from parsed markdown
2. Skip template-based approach entirely
3. Build our own "template" system using document merging/patching
4. Accept limitation that business users can't edit templates in Word

This would be significant effort (~2-4 weeks) for uncertain benefit.

### Potential Improvements to Current Approach

1. **Improve .docm support**: Clean up monkey-patch, add to docm_support.py
2. **Bundle Python**: Consider PyInstaller or similar for standalone distribution
3. **Lazy install**: Only install Python package when export is first used
4. **Caching**: Cache Python subprocess for faster subsequent exports

---

## Sources

- [docx-templates GitHub](https://github.com/guigrpa/docx-templates)
- [docxtemplater](https://docxtemplater.com/)
- [docx by dolanmiu](https://github.com/dolanmiu/docx)
- [easy-template-x](https://github.com/alonrbar/easy-template-x)
- [python-docx](https://python-docx.readthedocs.io/)
- [docxtpl](https://docxtpl.readthedocs.io/)
- [K15t Scroll Word Exporter](https://www.k15t.com/software/scroll-word-exporter)
- [npm trends comparison](https://npmtrends.com/docx-templates-vs-docxtemplater-vs-easy-template-x)

---

## Evidence & sources to verify (direct links)

- **docx-templates .docm support + altChunk HTML limitation**: README notes .docm templates and HTML via altChunk (Word‑only). https://github.com/guigrpa/docx-templates
- **docx-templates nested IF/FOR constraints**: issue documenting nested IFs disallowed and nested FOR in same paragraph causing loops. https://github.com/guigrpa/docx-templates/issues/433
- **docxtemplater pricing & modules**: official pricing page for Image/HTML and Enterprise bundles. https://docxtemplater.com/pricing
- **docxtemplater redistribution/appliance license**: licensing page notes requirements for redistribution/embedding. https://docxtemplater.com
- **docxtemplater .docm support**: no explicit .docm support documented in README; verify if any issues mention .docm. https://github.com/open-xml-templating/docxtemplater
