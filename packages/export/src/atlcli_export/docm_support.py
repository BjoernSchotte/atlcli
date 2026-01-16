"""Support for .docm (macro-enabled Word) files and Scroll placeholder conversion.

Converts .docm files to .docx format at runtime by updating the content type.
Also converts Scroll Word Exporter placeholders ($scroll.x) to Jinja2 syntax ({{ x }}).
"""

import re
import shutil
import tempfile
import zipfile
from pathlib import Path

# Content types
DOCM_CONTENT_TYPE = "application/vnd.ms-word.document.macroEnabled.main+xml"
DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"

# Scroll placeholder mappings to our Jinja2 variables
SCROLL_MAPPINGS = {
    "title": "title",
    "content": "content",
    "creator.fullName": "author",
    "creator.email": "authorEmail",
    "modifier.fullName": "modifier",
    "modifier.email": "modifierEmail",
    "creationdate": "created",
    "modificationdate": "modified",
    "pageid": "pageId",
    "pageurl": "pageUrl",
    "tinyurl": "tinyUrl",
    "pagelabels": "labels",
    "space.key": "spaceKey",
    "space.name": "spaceName",
    "space.url": "spaceUrl",
    "exporter.fullName": "exportedBy",
    "exportdate": "exportDate",
    "template.name": "templateName",
}


def is_docm_file(path: str | Path) -> bool:
    """Check if a file is a .docm (macro-enabled) Word document."""
    return str(path).lower().endswith('.docm')


def convert_scroll_placeholder(match: re.Match) -> str:
    """Convert a single Scroll placeholder match to Jinja2 syntax.

    Handles:
    - $scroll.variable → {{ variable }}
    - $!scroll.variable → {{ variable | default('') }}
    - $scroll.variable.("format") → {{ variable | date('format') }}
    """
    null_safe = match.group(1) == '!'
    scroll_var = match.group(2)
    date_format = match.group(3)  # May be None

    # Map Scroll variable to our variable name
    jinja_var = SCROLL_MAPPINGS.get(scroll_var, scroll_var)

    # Build filter chain
    filters = []
    if date_format:
        filters.append(f"date('{date_format}')")
    if null_safe:
        filters.append("default('')")

    if filters:
        return "{{ " + jinja_var + " | " + " | ".join(filters) + " }}"
    return "{{ " + jinja_var + " }}"


def convert_scroll_placeholders(text: str) -> str:
    """Convert all Scroll Word Exporter placeholders to Jinja2 syntax.

    Converts:
    - $scroll.title → {{ title }}
    - $scroll.creator.fullName → {{ author }}
    - $!scroll.variable → {{ variable | default('') }}
    - $scroll.creationdate.("yyyy-MM-dd") → {{ created | date('yyyy-MM-dd') }}
    """
    # Pattern matches:
    # - Optional ! for null-safe ($!scroll.x)
    # - Variable name (dot-notation allowed)
    # - Optional date format: .("format")
    pattern = r'\$(!)?scroll\.([a-zA-Z][a-zA-Z0-9.]*?)(?:\.?\("([^"]+)"\))?(?=\s|<|$|[^\w.])'

    return re.sub(pattern, convert_scroll_placeholder, text)


def fix_content_placeholder_level(xml_content: str) -> str:
    """Fix {{ content }} placeholder to be at paragraph level for subdocument insertion.

    Scroll templates have $scroll.content inline within a paragraph:
    <w:p>...<w:r><w:t>{{ content }}</w:t></w:r></w:p>

    But docxtpl subdocuments need paragraph-level placement:
    </w:p>{{p content }}<w:p>

    This function restructures the XML to move content placeholder to paragraph level.
    It also preserves section breaks (w:sectPr) that may be attached to the original
    paragraph (important for cover pages and multi-section templates).
    """
    # Pattern: find paragraph containing {{ content }}
    # Match: <w:p ...>...<w:t...>{{ content }}...</w:t>...</w:p>
    # We need to replace the entire paragraph with just {{p content }}

    import re

    content_placeholder = re.compile(r'\{\{\s*content\s*\}\}')

    # First, find if {{ content }} exists inline
    if not content_placeholder.search(xml_content):
        return xml_content

    # Find and replace the entire paragraph containing {{ content }}
    # Match <w:p ...>...</w:p> that contains {{ content }}
    def replace_content_paragraph(xml):
        # Split by paragraphs and find the one with content
        result = []
        i = 0
        while i < len(xml):
            # Find start of paragraph
            p_start = xml.find('<w:p', i)
            if p_start == -1:
                result.append(xml[i:])
                break

            # Add content before paragraph
            result.append(xml[i:p_start])

            # Find matching </w:p>
            # Need to handle nested elements, count depth
            depth = 0
            j = p_start
            p_end = -1
            while j < len(xml):
                if xml[j:j+4] == '<w:p' and (j+4 >= len(xml) or xml[j+4] in ' >'):
                    depth += 1
                elif xml[j:j+5] == '</w:p' and (j+5 >= len(xml) or xml[j+5] in ' >'):
                    depth -= 1
                    if depth == 0:
                        p_end = xml.find('>', j) + 1
                        break
                j += 1

            if p_end == -1:
                result.append(xml[p_start:])
                break

            paragraph = xml[p_start:p_end]

            # Check if this paragraph contains {{ content }}
            if content_placeholder.search(paragraph):
                # Preserve section breaks if present in paragraph properties
                ppr_match = re.search(r'<w:pPr[\s\S]*?</w:pPr>', paragraph)
                ppr_xml = ppr_match.group(0) if ppr_match else ""
                has_sect = "<w:sectPr" in ppr_xml

                # Replace entire paragraph with {{p content }}
                replacement = "{{p content }}"

                if has_sect:
                    # Keep the section properties in a standalone paragraph
                    replacement += f"<w:p>{ppr_xml}</w:p>"

                result.append(replacement)
            else:
                result.append(paragraph)

            i = p_end

        return ''.join(result)

    return replace_content_paragraph(xml_content)


def normalize_split_placeholders(xml_content: str) -> str:
    """Normalize Word XML where placeholders are split across multiple w:t runs.

    Word often splits text like '$scroll.content' into multiple runs:
    <w:t>$</w:t>...<w:t>scroll.content</w:t>

    This function moves the $ from the first run to the second run,
    keeping XML structure valid.
    """
    # Strategy: Find <w:t>$</w:t> followed (within some distance) by <w:t>scroll.
    # or <w:t>!scroll. - then remove the $ from first run and prepend to second.

    # Pattern: $ at end of w:t, followed by tags, then scroll in another w:t
    # We replace $ with empty and prepend $ to scroll
    pattern = r'(\$)(</w:t>)((?:</w:r>)?(?:<[^>]+>)*?)(<w:t[^>]*>)(!?scroll\.)'

    def move_dollar(m):
        # Remove $ from first position, prepend to scroll
        # Group 1: $
        # Group 2: </w:t>
        # Group 3: intermediate tags (keep as-is)
        # Group 4: <w:t...>
        # Group 5: scroll. or !scroll.
        return m.group(2) + m.group(3) + m.group(4) + m.group(1) + m.group(5)

    return re.sub(pattern, move_dollar, xml_content)


def convert_docm_to_docx(docm_path: str | Path, convert_placeholders: bool = True) -> Path:
    """Convert a .docm file to .docx format.

    Creates a temporary copy with updated content type so python-docx can open it.
    The macros (vbaProject.bin) are preserved but won't be executed.
    Optionally converts Scroll Word Exporter placeholders to Jinja2 syntax.

    Args:
        docm_path: Path to the .docm file
        convert_placeholders: If True, convert $scroll.x placeholders to {{ x }}

    Returns:
        Path to the temporary .docx file (caller should clean up)
    """
    docm_path = Path(docm_path)

    # Create temp file with .docx extension
    temp_dir = tempfile.mkdtemp(prefix="atlcli_export_")
    temp_docx = Path(temp_dir) / f"{docm_path.stem}.docx"

    # XML files that may contain placeholders
    xml_files = {'word/document.xml', 'word/header1.xml', 'word/header2.xml',
                 'word/header3.xml', 'word/footer1.xml', 'word/footer2.xml',
                 'word/footer3.xml'}

    # Read the original .docm
    with zipfile.ZipFile(docm_path, 'r') as zin:
        content_types = zin.read('[Content_Types].xml').decode('utf-8')

        # Replace .docm content type with .docx content type
        new_content_types = content_types.replace(
            DOCM_CONTENT_TYPE,
            DOCX_CONTENT_TYPE
        )

        # Write new zip with updated content types and converted placeholders
        with zipfile.ZipFile(temp_docx, 'w', zipfile.ZIP_DEFLATED) as zout:
            for item in zin.namelist():
                if item == '[Content_Types].xml':
                    zout.writestr(item, new_content_types)
                elif convert_placeholders and item in xml_files:
                    # Convert Scroll placeholders in XML content
                    try:
                        content = zin.read(item).decode('utf-8')
                        # First normalize split placeholders, then convert
                        normalized = normalize_split_placeholders(content)
                        converted = convert_scroll_placeholders(normalized)
                        # Fix content placeholder to paragraph level for subdocuments
                        fixed = fix_content_placeholder_level(converted)
                        zout.writestr(item, fixed.encode('utf-8'))
                    except (UnicodeDecodeError, KeyError):
                        # If file doesn't exist or can't be decoded, copy as-is
                        zout.writestr(item, zin.read(item))
                else:
                    zout.writestr(item, zin.read(item))

    return temp_docx


def convert_docx_placeholders(docx_path: str | Path) -> Path:
    """Convert Scroll placeholders in a .docx file.

    Creates a temporary copy with converted placeholders.

    Args:
        docx_path: Path to the .docx file

    Returns:
        Path to the temporary .docx file with converted placeholders
    """
    docx_path = Path(docx_path)

    # Create temp file with .docx extension
    temp_dir = tempfile.mkdtemp(prefix="atlcli_export_")
    temp_docx = Path(temp_dir) / docx_path.name

    # XML files that may contain placeholders
    xml_files = {'word/document.xml', 'word/header1.xml', 'word/header2.xml',
                 'word/header3.xml', 'word/footer1.xml', 'word/footer2.xml',
                 'word/footer3.xml'}

    with zipfile.ZipFile(docx_path, 'r') as zin:
        with zipfile.ZipFile(temp_docx, 'w', zipfile.ZIP_DEFLATED) as zout:
            for item in zin.namelist():
                if item in xml_files:
                    try:
                        content = zin.read(item).decode('utf-8')
                        # First normalize split placeholders, then convert
                        normalized = normalize_split_placeholders(content)
                        converted = convert_scroll_placeholders(normalized)
                        # Fix content placeholder to paragraph level for subdocuments
                        fixed = fix_content_placeholder_level(converted)
                        zout.writestr(item, fixed.encode('utf-8'))
                    except (UnicodeDecodeError, KeyError):
                        zout.writestr(item, zin.read(item))
                else:
                    zout.writestr(item, zin.read(item))

    return temp_docx


def has_scroll_placeholders(docx_path: str | Path) -> bool:
    """Check if a Word document contains Scroll placeholders."""
    xml_files = {'word/document.xml', 'word/header1.xml', 'word/header2.xml',
                 'word/header3.xml', 'word/footer1.xml', 'word/footer2.xml',
                 'word/footer3.xml'}

    try:
        with zipfile.ZipFile(docx_path, 'r') as zin:
            for item in zin.namelist():
                if item in xml_files:
                    try:
                        content = zin.read(item).decode('utf-8')
                        if '$scroll.' in content or '$!scroll.' in content:
                            return True
                    except (UnicodeDecodeError, KeyError):
                        pass
    except zipfile.BadZipFile:
        pass
    return False


class DocmConverter:
    """Context manager for .docm to .docx conversion with automatic cleanup.

    Also handles Scroll placeholder conversion for both .docm and .docx files.
    """

    def __init__(self, template_path: str | Path, convert_placeholders: bool = True):
        self.original_path = Path(template_path)
        self.converted_path: Path | None = None
        self.temp_dir: str | None = None
        self.convert_placeholders = convert_placeholders

    def __enter__(self) -> Path:
        """Convert .docm to .docx if needed, convert placeholders, return usable path."""
        if is_docm_file(self.original_path):
            # .docm file - convert format and placeholders
            self.converted_path = convert_docm_to_docx(
                self.original_path,
                convert_placeholders=self.convert_placeholders
            )
            self.temp_dir = str(self.converted_path.parent)
            return self.converted_path
        elif self.convert_placeholders and has_scroll_placeholders(self.original_path):
            # .docx file with Scroll placeholders - convert placeholders only
            self.converted_path = convert_docx_placeholders(self.original_path)
            self.temp_dir = str(self.converted_path.parent)
            return self.converted_path
        return self.original_path

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Clean up temporary files."""
        if self.temp_dir:
            shutil.rmtree(self.temp_dir, ignore_errors=True)
        return False
