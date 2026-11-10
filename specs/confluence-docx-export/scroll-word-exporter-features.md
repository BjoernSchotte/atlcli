# K15t Scroll Word Exporter Feature Analysis

This document provides a comprehensive feature analysis of K15t's Scroll Word Exporter for Confluence, serving as the "north star" for atlcli's Word export implementation.

## Overview

Scroll Word Exporter is a commercial Confluence add-on by K15t that exports Confluence pages to professionally-styled Microsoft Word documents. It supports both Cloud and Data Center deployments.

---

## 1. Template Placeholders/Variables

Scroll Word Exporter uses `$scroll.*` placeholders in Word templates that are replaced with Confluence metadata during export.

### Page Information
| Placeholder | Description |
|-------------|-------------|
| `$scroll.title` | Root page title |
| `$scroll.version` | Root page version |
| `$scroll.pageid` | Page ID |
| `$scroll.pageurl` | Full page URL |
| `$scroll.tinyurl` | Shortened URL |
| `$scroll.pagelabels` | Page labels (with optional `.capitalised` modifier) |

### Creator/Modifier Information
| Placeholder | Description |
|-------------|-------------|
| `$scroll.creator` | Page creator |
| `$scroll.creator.name` | Creator's username (Data Center only) |
| `$scroll.creator.fullName` | Creator's full name |
| `$scroll.creator.email` | Creator's email (Data Center only) |
| `$scroll.modifier` | Last modifier |
| `$scroll.modifier.name` | Modifier's username (Data Center only) |
| `$scroll.modifier.fullName` | Modifier's full name |
| `$scroll.modifier.email` | Modifier's email (Data Center only) |
| `$scroll.pageowner.fullName` | Page owner (Cloud only) |

### Dates
| Placeholder | Description |
|-------------|-------------|
| `$scroll.creationdate` | Creation date (supports SimpleDateFormat) |
| `$scroll.modificationdate` | Last modification date (supports SimpleDateFormat) |
| `$scroll.exportdate` | Export timestamp (supports SimpleDateFormat) |

### Space Information
| Placeholder | Description |
|-------------|-------------|
| `$scroll.space.key` | Space key |
| `$scroll.space.name` | Space name |
| `$scroll.space.url` | Space URL |
| `$scroll.spacelogo` | Space logo (with optional sizing) |
| `$scroll.globallogo` | System global logo |

### Export Information
| Placeholder | Description |
|-------------|-------------|
| `$scroll.content` | **Critical** - Marks where exported content starts |
| `$scroll.exporter` | Export user |
| `$scroll.exporter.name` | Exporter's username (Data Center only) |
| `$scroll.exporter.fullName` | Exporter's full name |
| `$scroll.exporter.email` | Exporter's email (Data Center only) |
| `$scroll.template.name` | Template name |
| `$scroll.template.modificationdate` | Template's last modification date |

### Dynamic Content
| Placeholder | Description |
|-------------|-------------|
| `$scroll.includepage.(pagename)` | Include content from specific page |
| `$scroll.pageproperty.(key)` | Custom page properties (from Page Properties macro) |
| `$scroll.pageproperty.(key,macroId)` | Page property with specific macro ID |
| `$scroll.jsoncontentproperty.(key)` | JSON content property with optional pointer/fallback |
| `$scroll.metadata.(key)` | Custom metadata (requires Comala Metadata App) |
| `$adhocState` | Document state from Comala workflows (Data Center only) |

### Date Formatting
Dates support SimpleDateFormat patterns:
- `$scroll.exportdate(yyyy-MM-dd)` -> `2025-01-15`
- `$scroll.creationdate(MMMM d, yyyy)` -> `January 15, 2025`

---

## 2. Confluence Macro Support

### Natively Supported Macros (with dedicated styles)

| Macro | Word Style | Notes |
|-------|-----------|-------|
| Info panel | `Scroll Info` | Table style with icon replacement |
| Warning panel | `Scroll Warning` | Table style with icon replacement |
| Note panel | `Scroll Note` | Table style with icon replacement |
| Tip panel | `Scroll Tip` | Table style with icon replacement |
| Panel macro | `Scroll Panel` | Table style |
| Code Block | `Scroll Code` | Table style, limited syntax highlighting |
| Block Quote | `Scroll Quote` | Table style |
| Section columns | `Scroll Section Column` | Table style |

### Macro Rendering Behavior

| Macro | Behavior |
|-------|----------|
| **Expand macro** | Auto-expanded in export (content always visible) |
| **TOC macro** | Replaced by Word's native TOC (if configured in template) |
| **Status macro** | Text only (colored lozenge not preserved) |
| **Jira macro** | Partial support - may show raw macro configuration |
| **Include macros** | Content included if accessible |
| **Emoticons** | Converted to text equivalents or omitted |
| **Drawio/Gliffy** | Rendered as images |

### Known Macro Issues
- Info/Warning/Tip/Note icons replaced with text "Icon"
- Inline macros may not export content
- Third-party macro content may not render
- Code blocks lose some whitespace in round-trip scenarios
- Syntax highlighting limited/not fully supported

---

## 3. Styling Capabilities

### Paragraph Styles
| Style Name | Maps To |
|------------|---------|
| `Normal` | Standard paragraphs |
| `Scroll Heading 1-6` | Confluence heading levels 1-6 |
| `Scroll Plain Text` | Preformatted content |
| `Scroll Inline Code` | Monospace/code text (default: Courier New 10pt) |
| `Scroll Caption` | Page titles from macros |
| `Scroll Expand Macro Text` | Expandable content |

### List Styles
| Style Name | Maps To |
|------------|---------|
| `Scroll List Bullet` | Bulleted list level 1 |
| `Scroll List Bullet 2-8` | Bulleted list levels 2-8 |
| `Scroll List Number` | Numbered list level 1 |
| `Scroll List Number 2-8` | Numbered list levels 2-8 |

### Table Styles
| Style Name | Maps To |
|------------|---------|
| `Scroll Table Normal` | Standard Confluence tables |
| `Scroll Warning/Info/Note/Tip` | Admonition macros |
| `Scroll Panel` | Panel macro |
| `Scroll Code` | Code blocks |
| `Scroll Quote` | Block quotes |
| `Scroll Section Column` | Section macro columns |

### Customization Options
- Full control over fonts, colors, sizes via Word styles
- Custom templates can define any Word style
- Supports `.docm` files with VBA macros for advanced formatting
- Brand templates with logos, headers, footers

---

## 4. Multi-Page Export

### Export Scope Options
- **"Only this page"** - Single page export
- **"This page and its children"** - Full page tree export
- **Label-based filtering** - Include/exclude pages with specific labels

### Heading Hierarchy Handling
- Page titles become top-level headings
- Page hierarchy converted to heading levels
- Headings within pages are normalized:
  - First heading on page sets the base level
  - Skipped levels are closed up (e.g., h1 -> h3 becomes h1 -> h2)
  - Creates sensible TOC hierarchy automatically

### Page Title Handling
- Option to merge first heading with page title (avoid duplication)
- `{scroll-pagetitle}` macro for custom export titles
- Page titles can be omitted if they duplicate first heading

---

## 5. Image Handling

### Embedded Images
- Images attached to Confluence pages are embedded in Word document
- Full resolution available via "Export thumbnail images in full resolution" option
- Large images auto-scaled to fit page (Word limitation)

### External/Linked Images
- **Data Center**: External images require host in Confluence Allowlist
- **Cloud**: External images NOT downloaded (Atlassian limitation)
- Workaround: Embed image directly on page or add to template

### Known Limitations
- Word cannot split large images across pages
- Very large diagrams may become unreadable when scaled
- No explicit DPI/resolution control in export settings

---

## 6. Table of Contents

### Auto-Generation
- TOC configured in Word template using native Word TOC feature
- Populated automatically during export from heading styles
- Supports customizable depth (TOC 1, TOC 2, etc.)

### Configuration Steps
1. Insert Word TOC via References > Table of Contents
2. Configure heading levels to include
3. Place `$scroll.content` placeholder after TOC
4. Customize TOC styles (font, size, color per level)

### Auto-Update
- TOC shows "No table of content entries found" in template
- Populated when document opens with exported content
- For auto-update on open, use `.docm` template with VBA macro

---

## 7. Headers/Footers

### Static Content
- Standard Word headers/footers supported
- Company logos, document titles, copyright notices

### Dynamic Content with Placeholders
- Any `$scroll.*` placeholder works in headers/footers
- Common uses:
  - `$scroll.title` - Document title
  - `$scroll.exportdate` - Export date
  - `$scroll.space.name` - Space name
  - `$scroll.exporter.fullName` - Who exported

### Dynamic Heading References
- Display current section heading in header/footer
- Uses Word's StyleRef field with Scroll Heading styles
- Example: Show `Scroll Heading 1` of current page in header

### Page Numbers
- Standard Word page numbering supported
- "Page X of Y" patterns supported

---

## 8. Limitations and Known Issues

### Microsoft Word Limitations
| Limitation | Details |
|------------|---------|
| **List items** | Max 2,046 list items per document |
| **List levels** | Max 9 list levels (Confluence allows more) |
| **Table columns** | Max 63 columns per table |
| **Image scaling** | Large images scaled to fit page |
| **Keep-with-next** | May fail for large objects causing poor page breaks |

### Macro Rendering Issues
- Admonition macros add extra line breaks in lists
- Code block whitespace may be lost in round-trips
- Inline macro content may not export
- Jira macro may show raw configuration
- Status macro icons not preserved

### Performance Issues
- Large exports can consume significant memory
- May cause Confluence performance degradation
- External conversion process recommended for large exports (8GB+ RAM)
- "Creating Word File" step can be slow

### Common Complaints (from community/support forums)
- Blank pages appearing unexpectedly
- "Queueing Export" step taking too long
- "Cannot export - not the latest version" errors
- Panel macros with wide borders cause export errors
- Third-party macro compatibility issues

---

## 9. Pricing (as of 2024-2025)

### Cloud Pricing
| Users | Monthly Cost |
|-------|--------------|
| Up to 10 | $5/month flat |
| 11+ users | $0.90/user/month |

*30-day free trial available*

### Data Center Pricing (Annual)
| User Tier | Annual Cost |
|-----------|-------------|
| 500 | $5,200 |
| 1,000 | $6,500 |
| 2,000 | $9,000 |
| 3,000 | $11,000 |
| 5,000 | $14,300 |
| 10,000 | $16,400 |
| 20,000 | $17,700 |
| 50,000 | $19,500 |
| 100,000 | $22,500 |
| Unlimited | $26,700 |

---

## 10. Scroll Exporter Extensions (Free Add-on)

Additional macros for export control:

| Macro | Purpose |
|-------|---------|
| `Scroll Only` | Content appears only in export, not in Confluence |
| `Scroll Only Inline` | Inline version of above |
| `Scroll Ignore` | Content appears in Confluence, excluded from export |
| `Scroll Pagebreak` | Force page break in export |
| `Scroll Title` | Custom captions for images/tables/code |
| `{index-term}` | Define index entries (primary/secondary/tertiary) |
| `{scroll-pagetitle}` | Custom page title for export |

---

## atlcli Export Feature Checklist

### Priority 1: Core Features
- [ ] Single page export to .docx
- [ ] Multi-page (page tree) export to .docx
- [ ] Basic heading hierarchy preservation
- [ ] Standard paragraph/text formatting
- [ ] Bulleted and numbered lists
- [ ] Tables (basic)
- [ ] Embedded images
- [ ] Code blocks (monospace)

### Priority 2: Template System
- [ ] Custom Word template support
- [ ] Basic placeholders ($page.title, $space.name, $export.date)
- [ ] Content placeholder ($scroll.content equivalent)
- [ ] Headers/footers with placeholders
- [ ] Style mapping (Scroll Heading 1-6, etc.)

### Priority 3: Macro Support
- [ ] Info/Warning/Note/Tip panels
- [ ] Expand macro (auto-expand)
- [ ] Panel macro
- [ ] Code block with language hint
- [ ] Block quote

### Priority 4: Advanced Features
- [ ] Table of Contents generation
- [ ] Page label filtering
- [ ] Full resolution image option
- [ ] Creator/modifier metadata placeholders
- [ ] Page properties as placeholders
- [ ] Custom date formatting

### Priority 5: Nice-to-Have
- [ ] VBA macro templates (.docm)
- [ ] Index term generation
- [ ] Scroll Only/Ignore macros
- [ ] External image handling
- [ ] Cross-reference preservation

---

## Sources

- [K15t Help Center - Scroll Word Exporter](https://help.k15t.com/scroll-word-exporter/5.16/cloud)
- [Add Placeholders Documentation](https://help.k15t.com/scroll-word-exporter/5.16/cloud/add-placeholders)
- [Scroll Word Exporter Macros](https://help.k15t.com/scroll-word-exporter/5.17/cloud/scroll-word-exporter-macros)
- [Word Limitations](https://help.k15t.com/scroll-word-exporter/5.17/cloud/how-can-word-limitations-affect-my-export)
- [Creating Headers/Footers](https://help.k15t.com/scroll-word-exporter/5.16/cloud/creating-a-header-or-footer)
- [Creating Table of Contents](https://help.k15t.com/scroll-word-exporter/5.16/cloud/creating-a-table-of-contents)
- [Defining Paragraph Styles](https://help.k15t.com/scroll-word-exporter/5.16/cloud/defining-paragraph-styles)
- [Overview of Available Styles](https://help.k15t.com/scroll-word-exporter/5.16/cloud/overview-on-the-available-styles)
- [How Heading Levels are Handled](https://help.k15t.com/scroll-word-exporter/5.15/cloud/how-heading-levels-are-handled)
- [Data Center Pricing](https://www.k15t.com/announcements/k15t-apps-pricing-for-new-data-center-tiers/pricing-for-new-data-center-tiers-scroll-exporters-for-confluence)
- [Atlassian Marketplace - Scroll Word Exporter](https://marketplace.atlassian.com/apps/24982/scroll-word-exporter-for-confluence)
- [Scroll Exporter Extensions](https://marketplace.atlassian.com/apps/1217037/scroll-exporter-extensions)
- [Atlassian Community - 5 Ways to Supercharge Exports](https://community.atlassian.com/forums/App-Central-articles/5-Ways-to-Supercharge-Your-Confluence-Exports-With-the-Scroll/ba-p/2196929)
