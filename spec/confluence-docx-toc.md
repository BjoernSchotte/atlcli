# Confluence DOCX Export: TOC Handling

## Summary

- **Template TOC**: Word-native TOC from the `.docx` template is preserved and marked dirty
- **Confluence TOC macro**: `:::toc` in the page is converted to a Word-native TOC field
- **Both sources** are wrapped in SDT (Structured Document Tag) containers for consistent behavior
- **Dirty flag**: By default, all TOCs are marked dirty so Word prompts to update on open
- **`--no-toc-prompt`**: Disables the dirty flag for users who prefer no modal prompt

## Why Manual Update is Required

Word TOCs are implemented as **field codes**. The visible entries and page numbers
are a **cached result** that Word computes using its layout engine. Our export
pipeline builds the document structure but does **not** run a layout engine, so:

- We cannot reliably compute page numbers
- We cannot populate the cached TOC entries without a layout engine

Open XML does not include a layout engine, and we are not bundling LibreOffice
or any other external renderer at this time. This keeps the CLI lightweight and
fully open source.

## TOC Sources

### 1. Template Word TOC

Word templates can contain a native TOC field (Insert → Table of Contents). These
are stored as SDT (Structured Document Tag) elements with `docPartGallery="Table of Contents"`.

When exporting:
- The template TOC is preserved as-is
- It's marked as "dirty" so Word prompts to update
- After update, it shows entries based on heading styles in the exported content

### 2. Confluence `:::toc` Macro

Confluence pages can contain a TOC macro that shows a table of contents for that page.
In markdown format, this appears as:

```markdown
:::toc
:::
```

When exporting:
- The macro is converted to a Word-native TOC field (`{ TOC \o "1-3" \h \z \u }`)
- It's wrapped in an SDT container (same structure as template TOCs)
- It's marked as "dirty" so Word prompts to update
- Placeholder text "Table of Contents - Update to populate" is shown until updated

## Behavior Matrix

### Pull/Push Markdown (Round-trip)

| Action | Result |
|--------|--------|
| **Pull** page with TOC macro | Converted to `:::toc\n:::` in markdown |
| **Push** markdown with `:::toc` | Converted back to Confluence storage format |

The TOC macro round-trips cleanly between Confluence and local markdown.

### Export to DOCX

| Template Has TOC | Page Has `:::toc` | `--no-toc-prompt` | Word Behavior |
|------------------|-------------------|-------------------|---------------|
| No | No | - | Clean open, no TOC |
| No | Yes | No (default) | TOC injected, Word prompts to update |
| No | Yes | Yes | TOC injected, Word opens cleanly |
| Yes | No | No (default) | Template TOC preserved, Word prompts |
| Yes | No | Yes | Template TOC preserved, Word opens cleanly |
| Yes | Yes | No (default) | Both TOCs present, Word prompts |
| Yes | Yes | Yes | Both TOCs present, Word opens cleanly |

## CLI Flags

### `--no-toc-prompt`

Disables the TOC dirty flag. Use this when:
- You prefer Word to open without the "Update fields?" modal
- You'll update the TOC manually later
- You're automating document generation and don't want interactive prompts

```bash
# Default: Word will prompt to update TOC
atlcli wiki export 12345 -t report -o output.docx

# No prompt: Word opens cleanly, update TOC manually
atlcli wiki export 12345 -t report -o output.docx --no-toc-prompt
```

When `--no-toc-prompt` is used and the document contains a TOC, the CLI output
includes a note reminding you to update manually.

## Expected UX in Word

### Default Behavior (TOC marked dirty)

When you open an exported file that contains a TOC:

1. Word shows a prompt: "This document contains fields that may refer to other files. Do you want to update the fields in this document?"
2. Click **Yes** to update
3. The TOC populates with correct entries and page numbers

### With `--no-toc-prompt`

When you open the file:

1. Word opens cleanly (no prompt)
2. TOC shows placeholder text or stale entries
3. To update manually:
   - Click inside the TOC
   - Right-click and choose "Update Field"
   - Select "Update entire table"

## Technical Implementation

### SDT Container Structure

Both template and Confluence-injected TOCs use the same SDT structure:

```xml
<w:sdt>
  <w:sdtPr>
    <w:docPartObj>
      <w:docPartGallery w:val="Table of Contents"/>
      <w:docPartUnique/>
    </w:docPartObj>
  </w:sdtPr>
  <w:sdtContent>
    <w:p>
      <!-- TOC field code with dirty flag on fldChar -->
      <w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>
      <w:r><w:instrText> TOC \o "1-3" \h \z \u </w:instrText></w:r>
      <w:r><w:fldChar w:fldCharType="separate"/></w:r>
      <w:r><w:t>Table of Contents - Update to populate</w:t></w:r>
      <w:r><w:fldChar w:fldCharType="end"/></w:r>
    </w:p>
  </w:sdtContent>
</w:sdt>
```

### Dirty Flag

Per OOXML spec, the dirty flag is set on the `w:fldChar` element with `fldCharType="begin"`:

```xml
<w:fldChar w:fldCharType="begin" w:dirty="true"/>
```

This tells Word to prompt the user to update fields when opening the document.
The `w:dirty` attribute is part of the `CT_FldChar` complex type in OOXML.

### TOC Field Switches

The TOC field uses these switches:
- `\o "1-3"` - Include heading levels 1-3
- `\h` - Create hyperlinks to headings
- `\z` - Hide page numbers in Web view
- `\u` - Use applied paragraph outline level

## Files

- `packages/export/src/atlcli_export/markdown_to_word.py` - `_insert_toc_macro_output()` injects Word TOC
- `packages/export/src/atlcli_export/docx_renderer.py` - `_mark_toc_dirty()` and `_has_toc_field()`
- `apps/cli/src/commands/export.ts` - CLI flag handling
