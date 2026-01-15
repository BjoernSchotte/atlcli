"""atlcli-export: DOCX export with Word template support."""

__version__ = "0.1.0"

from .docx_renderer import render_template
from .context import build_context
from .markdown_to_word import MarkdownToWordConverter
from .docm_support import (
    is_docm_file,
    convert_docm_to_docx,
    DocmConverter,
    convert_scroll_placeholders,
    normalize_split_placeholders,
    has_scroll_placeholders,
)

__all__ = [
    "render_template",
    "build_context",
    "MarkdownToWordConverter",
    "is_docm_file",
    "convert_docm_to_docx",
    "DocmConverter",
    "convert_scroll_placeholders",
    "normalize_split_placeholders",
    "has_scroll_placeholders",
]
