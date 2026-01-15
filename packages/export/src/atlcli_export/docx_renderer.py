"""DOCX template rendering using docxtpl."""

from pathlib import Path
from jinja2 import Environment
from docxtpl import DocxTemplate

from .context import build_context
from .filters import register_filters
from .docm_support import DocmConverter


def render_template(
    template_path: str | Path,
    page_data: dict,
    output_path: str | Path,
) -> Path:
    """Render a Word template with Confluence page data.

    Supports both .docx and .docm (macro-enabled) templates.

    Args:
        template_path: Path to the .docx or .docm template file
        page_data: Dictionary containing page information
        output_path: Path where the output .docx will be saved

    Returns:
        Path to the generated document
    """
    template_path = Path(template_path)
    output_path = Path(output_path)

    # Use context manager to handle .docm conversion and cleanup
    with DocmConverter(template_path) as usable_template:
        # Load template (now guaranteed to be .docx format)
        doc = DocxTemplate(str(usable_template))

        # Create Jinja2 environment and register custom filters
        jinja_env = Environment(autoescape=True)
        register_filters(jinja_env)

        # Build context with all variables
        context = build_context(page_data, doc)

        # Render template with custom jinja environment
        doc.render(context, jinja_env=jinja_env)

        # Ensure output directory exists
        output_path.parent.mkdir(parents=True, exist_ok=True)

        # Save document
        doc.save(output_path)

    return output_path
