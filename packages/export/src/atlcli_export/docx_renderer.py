"""DOCX template rendering using docxtpl."""

from pathlib import Path
from jinja2 import Environment
from docxtpl import DocxTemplate

from .context import build_context
from .filters import register_filters
from .docm_support import DocmConverter


def _is_toc_sdt(sdt) -> bool:
    """Check if an SDT element is a Table of Contents."""
    from docx.oxml.ns import qn

    # Look for docPartGallery element with value "Table of Contents"
    for elem in sdt.iter():
        if elem.tag == qn('w:docPartGallery'):
            if elem.get(qn('w:val')) == 'Table of Contents':
                return True
    return False


def _mark_toc_dirty(docx) -> bool:
    """Mark TOC fields as dirty so Word prompts user to update.

    The dirty attribute must be on the fldChar element with fldCharType="begin",
    NOT on the sdtPr element. This is per OOXML spec (CT_FldChar has dirty attr).

    Returns:
        True if a TOC was found and marked dirty, False otherwise.
    """
    from docx.oxml.ns import qn

    found_toc = False
    body = docx.element.body

    # Find all SDT (structured document tag) elements
    for sdt in body.iter(qn('w:sdt')):
        if _is_toc_sdt(sdt):
            found_toc = True
            # Find fldChar with fldCharType="begin" and set dirty on it
            for fld_char in sdt.iter(qn('w:fldChar')):
                if fld_char.get(qn('w:fldCharType')) == 'begin':
                    fld_char.set(qn('w:dirty'), 'true')
                    break
    return found_toc


def _has_toc_field(docx) -> bool:
    """Check if document contains a TOC field (SDT-based).

    Returns:
        True if a TOC field was found, False otherwise.
    """
    from docx.oxml.ns import qn

    body = docx.element.body

    # Check for SDT-based TOC (both template and Confluence-injected are now SDT-wrapped)
    for sdt in body.iter(qn('w:sdt')):
        if _is_toc_sdt(sdt):
            return True

    return False


def render_template(
    template_path: str | Path,
    page_data: dict,
    output_path: str | Path,
) -> tuple[Path, bool]:
    """Render a Word template with Confluence page data.

    Supports both .docx and .docm (macro-enabled) templates.

    Args:
        template_path: Path to the .docx or .docm template file
        page_data: Dictionary containing page information (including noTocPrompt flag)
        output_path: Path where the output .docx will be saved

    Returns:
        Tuple of (output_path, has_toc) where has_toc indicates if document contains TOC
    """
    template_path = Path(template_path)
    output_path = Path(output_path)

    # Check if user wants to suppress TOC dirty flag
    no_toc_prompt = page_data.get("noTocPrompt", False)

    # Use context manager to handle .docm conversion and cleanup
    with DocmConverter(template_path) as usable_template:
        # Load template (now guaranteed to be .docx format)
        doc = DocxTemplate(str(usable_template))

        # Create Jinja2 environment and register custom filters
        # Note: autoescape must be False for docxtpl XML rendering to work correctly
        jinja_env = Environment(autoescape=False)
        register_filters(jinja_env)

        # Build context with all variables
        context = build_context(page_data, doc)

        # Render template with custom jinja environment
        doc.render(context, jinja_env=jinja_env)

        # Ensure output directory exists
        output_path.parent.mkdir(parents=True, exist_ok=True)

        # Save document first (must happen before accessing underlying Document)
        doc.save(output_path)

    # Post-process: check for TOC and optionally mark dirty
    # Note: This must happen after docxtpl save() because get_docx() interferes
    # with docxtpl's internal render buffer
    from docx import Document
    final_doc = Document(str(output_path))

    # Check if document has any TOC (template or injected from Confluence macro)
    has_toc = _has_toc_field(final_doc)

    # Mark TOC as dirty unless user disabled the prompt
    if has_toc and not no_toc_prompt:
        _mark_toc_dirty(final_doc)

    final_doc.save(output_path)

    return output_path, has_toc
