"""Build template context from page data."""

from datetime import datetime
from typing import Any
from docxtpl import DocxTemplate

from .markdown_to_word import MarkdownToWordConverter


def build_context(page_data: dict, template: DocxTemplate) -> dict[str, Any]:
    """Build the template context from Confluence page data.

    Args:
        page_data: Dictionary containing page information from atlcli
        template: DocxTemplate instance for creating subdocuments

    Returns:
        Dictionary with all template variables
    """
    # Convert markdown content to Word subdocument
    converter = MarkdownToWordConverter(template)
    content_subdoc = converter.convert(page_data.get("markdown", ""))

    # Extract author info
    author_info = page_data.get("author", {})
    modifier_info = page_data.get("modifier", author_info)

    # Build context matching Scroll Word Exporter variables
    context = {
        # Page content
        "title": page_data.get("title", ""),
        "content": content_subdoc,

        # Author information
        "author": author_info.get("displayName", ""),
        "authorEmail": author_info.get("email", ""),

        # Modifier information
        "modifier": modifier_info.get("displayName", ""),
        "modifierEmail": modifier_info.get("email", ""),

        # Dates
        "created": page_data.get("created", ""),
        "modified": page_data.get("modified", ""),

        # Page identifiers
        "pageId": page_data.get("pageId", ""),
        "pageUrl": page_data.get("pageUrl", ""),
        "tinyUrl": page_data.get("tinyUrl", ""),

        # Labels
        "labels": page_data.get("labels", []),

        # Space information
        "spaceKey": page_data.get("spaceKey", ""),
        "spaceName": page_data.get("spaceName", ""),
        "spaceUrl": page_data.get("spaceUrl", ""),

        # Export metadata
        "exportedBy": page_data.get("exportedBy", ""),
        "exportDate": datetime.now().isoformat(),
        "templateName": page_data.get("templateName", ""),

        # Attachments (for loops)
        "attachments": page_data.get("attachments", []),

        # Children pages (for loops)
        "children": page_data.get("children", []),
    }

    return context
