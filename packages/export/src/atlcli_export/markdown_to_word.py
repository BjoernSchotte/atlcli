"""Convert markdown to Word document elements."""

import re
from typing import Optional
import markdown
from markdown.extensions.tables import TableExtension
from markdown.extensions.fenced_code import FencedCodeExtension
from bs4 import BeautifulSoup, Tag
from docx.shared import Pt, Inches, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from docxtpl import DocxTemplate


class MarkdownToWordConverter:
    """Converts markdown text to Word document elements."""

    def __init__(self, template: DocxTemplate):
        self.template = template
        self.md = markdown.Markdown(
            extensions=[
                TableExtension(),
                FencedCodeExtension(),
                "nl2br",
            ]
        )

    def convert(self, md_text: str) -> str:
        """Convert markdown to subdocument for template insertion.

        For the vertical slice, we return the content as a subdocument
        that can be inserted into the template.
        """
        # Parse markdown to HTML
        html = self.md.convert(md_text)
        self.md.reset()

        # Create subdocument
        subdoc = self.template.new_subdoc()

        # Parse HTML and build Word elements
        soup = BeautifulSoup(html, "html.parser")
        self._process_elements(soup, subdoc)

        return subdoc

    def _process_elements(self, soup: BeautifulSoup, subdoc) -> None:
        """Process HTML elements and add to subdocument."""
        for element in soup.children:
            if isinstance(element, Tag):
                self._process_tag(element, subdoc)
            elif isinstance(element, str) and element.strip():
                # Plain text
                p = subdoc.add_paragraph(element.strip())

    def _process_tag(self, tag: Tag, subdoc, paragraph=None) -> None:
        """Process a single HTML tag."""
        tag_name = tag.name.lower()

        if tag_name in ("h1", "h2", "h3", "h4", "h5", "h6"):
            level = int(tag_name[1])
            p = subdoc.add_paragraph(style=f"Heading {level}")
            self._add_inline_content(tag, p)

        elif tag_name == "p":
            p = subdoc.add_paragraph()
            self._add_inline_content(tag, p)

        elif tag_name == "ul":
            self._process_list(tag, subdoc, ordered=False)

        elif tag_name == "ol":
            self._process_list(tag, subdoc, ordered=True)

        elif tag_name == "pre":
            # Code block
            code = tag.find("code")
            code_text = code.get_text() if code else tag.get_text()
            p = subdoc.add_paragraph()
            run = p.add_run(code_text)
            run.font.name = "Courier New"
            run.font.size = Pt(9)
            # Light gray background via shading
            self._add_shading(p, "E8E8E8")

        elif tag_name == "blockquote":
            for child in tag.children:
                if isinstance(child, Tag) and child.name == "p":
                    p = subdoc.add_paragraph()
                    p.paragraph_format.left_indent = Inches(0.5)
                    self._add_inline_content(child, p)
                    # Add italic styling for quotes
                    for run in p.runs:
                        run.italic = True

        elif tag_name == "table":
            self._process_table(tag, subdoc)

        elif tag_name == "hr":
            # Horizontal rule - add empty paragraph with bottom border
            p = subdoc.add_paragraph()

        elif tag_name in ("div", "section", "article"):
            # Container elements - process children
            for child in tag.children:
                if isinstance(child, Tag):
                    self._process_tag(child, subdoc)

        else:
            # Unknown block element - try to process as paragraph
            p = subdoc.add_paragraph()
            self._add_inline_content(tag, p)

    def _add_inline_content(self, tag: Tag, paragraph) -> None:
        """Add inline content (text, bold, italic, links, code) to a paragraph."""
        for child in tag.children:
            if isinstance(child, str):
                if child.strip():
                    paragraph.add_run(child)
            elif isinstance(child, Tag):
                child_name = child.name.lower()

                if child_name in ("strong", "b"):
                    run = paragraph.add_run(child.get_text())
                    run.bold = True

                elif child_name in ("em", "i"):
                    run = paragraph.add_run(child.get_text())
                    run.italic = True

                elif child_name == "code":
                    run = paragraph.add_run(child.get_text())
                    run.font.name = "Courier New"
                    run.font.size = Pt(10)

                elif child_name == "a":
                    # Hyperlink - for now just add text with blue color
                    href = child.get("href", "")
                    run = paragraph.add_run(child.get_text())
                    run.font.color.rgb = RGBColor(0, 0, 238)
                    run.underline = True

                elif child_name == "br":
                    paragraph.add_run("\n")

                elif child_name == "span":
                    # Check for status macro
                    classes = child.get("class", [])
                    if "status" in classes:
                        self._add_status_badge(child, paragraph)
                    else:
                        paragraph.add_run(child.get_text())

                else:
                    # Recursively process other inline elements
                    self._add_inline_content(child, paragraph)

    def _process_list(self, tag: Tag, subdoc, ordered: bool = False, level: int = 0) -> None:
        """Process ordered or unordered list."""
        for i, li in enumerate(tag.find_all("li", recursive=False)):
            p = subdoc.add_paragraph()

            # Add bullet or number
            if ordered:
                prefix = f"{i + 1}. "
            else:
                prefix = "\u2022 "  # Bullet character

            # Indent based on nesting level
            p.paragraph_format.left_indent = Inches(0.25 * (level + 1))

            # Add prefix
            p.add_run(prefix)

            # Process content
            for child in li.children:
                if isinstance(child, str):
                    if child.strip():
                        p.add_run(child.strip())
                elif isinstance(child, Tag):
                    if child.name in ("ul", "ol"):
                        # Nested list
                        self._process_list(
                            child, subdoc,
                            ordered=(child.name == "ol"),
                            level=level + 1
                        )
                    else:
                        self._add_inline_content(child, p)

    def _process_table(self, tag: Tag, subdoc) -> None:
        """Process HTML table to Word table."""
        rows = tag.find_all("tr")
        if not rows:
            return

        # Count columns from first row
        first_row = rows[0]
        cols = len(first_row.find_all(["th", "td"]))

        if cols == 0:
            return

        # Create table
        table = subdoc.add_table(rows=len(rows), cols=cols)
        table.style = "Table Grid"

        for row_idx, tr in enumerate(rows):
            cells = tr.find_all(["th", "td"])
            for col_idx, cell in enumerate(cells):
                if col_idx < cols:
                    word_cell = table.rows[row_idx].cells[col_idx]
                    word_cell.text = cell.get_text().strip()

                    # Bold for header cells
                    if cell.name == "th":
                        for paragraph in word_cell.paragraphs:
                            for run in paragraph.runs:
                                run.bold = True

    def _add_shading(self, paragraph, color: str) -> None:
        """Add background shading to a paragraph."""
        shading = OxmlElement("w:shd")
        shading.set(qn("w:fill"), color)
        paragraph._p.get_or_add_pPr().append(shading)

    def _add_status_badge(self, tag: Tag, paragraph) -> None:
        """Add a colored status badge."""
        text = tag.get_text()
        color_class = None
        for cls in tag.get("class", []):
            if cls.startswith("status-"):
                color_class = cls.replace("status-", "")
                break

        # Map colors
        color_map = {
            "green": RGBColor(0, 128, 0),
            "yellow": RGBColor(204, 153, 0),
            "red": RGBColor(204, 0, 0),
            "blue": RGBColor(0, 0, 204),
            "grey": RGBColor(128, 128, 128),
            "gray": RGBColor(128, 128, 128),
        }

        run = paragraph.add_run(f" [{text}] ")
        run.bold = True
        if color_class and color_class in color_map:
            run.font.color.rgb = color_map[color_class]
