#!/usr/bin/env python3
"""Generate the synthetic, customer-neutral PDF-00 corpus."""

from __future__ import annotations

import hashlib
import json
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    BooleanObject,
    DecodedStreamObject,
    DictionaryObject,
    FloatObject,
    NameObject,
    NumberObject,
    TextStringObject,
)
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas


HERE = Path(__file__).resolve().parent
PAGE_WIDTH, PAGE_HEIGHT = A4


def stable_canvas(path: Path) -> canvas.Canvas:
    return canvas.Canvas(
        str(path),
        pagesize=A4,
        invariant=1,
        pageCompression=1,
        pdfVersion=(1, 7),
    )


def draw_header(pdf: canvas.Canvas, title: str, page: int = 1) -> None:
    pdf.setFont("Helvetica-Bold", 18)
    pdf.drawString(54, PAGE_HEIGHT - 64, title)
    pdf.setFont("Helvetica", 9)
    pdf.setFillColor(colors.HexColor("#536174"))
    pdf.drawRightString(PAGE_WIDTH - 54, PAGE_HEIGHT - 60, f"Neutral fixture | page {page}")
    pdf.setFillColor(colors.black)


def make_simple(path: Path) -> None:
    pdf = stable_canvas(path)
    draw_header(pdf, "Quarterly Garden Notes")
    pdf.setFont("Helvetica", 11)
    lines = [
        "This born-digital page contains selectable text in a simple reading order.",
        "The orchard team planted twelve neutral test trees and recorded stable results.",
        "A safe external reference follows: https://example.com/garden-notes",
    ]
    y = PAGE_HEIGHT - 105
    for line in lines:
        pdf.drawString(54, y, line)
        y -= 20
    pdf.setFont("Helvetica-Bold", 13)
    pdf.drawString(54, y - 8, "Checklist")
    pdf.setFont("Helvetica", 11)
    for item in ("Measure the plots", "Record the weather", "Publish the summary"):
        y -= 24
        pdf.drawString(68, y, f"- {item}")
    pdf.linkURL("https://example.com/garden-notes", (54, PAGE_HEIGHT - 151, 300, PAGE_HEIGHT - 134))
    pdf.save()


def make_complex_untagged(path: Path) -> None:
    pdf = stable_canvas(path)
    draw_header(pdf, "Two-column Field Report")
    left = [f"Left column sentence {index:02d} describes alpine observations." for index in range(1, 13)]
    right = [f"Right column sentence {index:02d} records coastal measurements." for index in range(1, 13)]
    pdf.setFont("Helvetica", 9)
    for index, line in enumerate(left):
        pdf.drawString(54, PAGE_HEIGHT - 105 - index * 18, line)
    for index, line in enumerate(right):
        pdf.drawString(310, PAGE_HEIGHT - 105 - index * 18, line)
    pdf.save()


def make_scan(path: Path) -> None:
    image = Image.new("RGB", (1240, 1754), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((70, 70, 1170, 1684), outline="#26364a", width=5)
    draw.text((110, 135), "SCANNED NEUTRAL NOTICE", fill="#17212d")
    draw.text((110, 220), "This page has pixels only and intentionally no PDF text layer.", fill="#17212d")
    draw.text((110, 275), "OCR is outside the PDF import MVP.", fill="#17212d")
    buffer = BytesIO()
    image.save(buffer, format="PNG", optimize=False)
    buffer.seek(0)
    pdf = stable_canvas(path)
    pdf.drawImage(ImageReader(buffer), 0, 0, width=PAGE_WIDTH, height=PAGE_HEIGHT, preserveAspectRatio=True)
    pdf.save()


def make_mixed(path: Path) -> None:
    image = Image.new("RGB", (1000, 500), "#f3f6f9")
    draw = ImageDraw.Draw(image)
    draw.rectangle((10, 10, 990, 490), outline="#315d8a", width=4)
    draw.text((50, 70), "RASTER APPENDIX: pixels only", fill="#17212d")
    buffer = BytesIO()
    image.save(buffer, format="PNG", optimize=False)
    buffer.seek(0)
    pdf = stable_canvas(path)
    draw_header(pdf, "Mixed Document", 1)
    pdf.setFont("Helvetica", 11)
    pdf.drawString(54, PAGE_HEIGHT - 115, "Page one is born-digital and should produce text facts.")
    pdf.showPage()
    pdf.drawImage(ImageReader(buffer), 54, 250, width=487, height=244, preserveAspectRatio=True)
    pdf.save()


def make_table(path: Path, ambiguous: bool) -> None:
    pdf = stable_canvas(path)
    title = "Ambiguous Alignment" if ambiguous else "Measured Harvest Table"
    draw_header(pdf, title)
    pdf.setFont("Helvetica", 10)
    rows = [
        ("Plot", "Apples", "Pears"),
        ("North", "12", "8"),
        ("South", "9", "11"),
    ]
    x_positions = (70, 250, 390)
    y = PAGE_HEIGHT - 130
    for row_index, row in enumerate(rows):
        pdf.setFont("Helvetica-Bold" if row_index == 0 else "Helvetica", 10)
        for x, value in zip(x_positions, row):
            pdf.drawString(x, y, value)
        y -= 34 if ambiguous else 30
    if not ambiguous:
        pdf.setStrokeColor(colors.HexColor("#315d8a"))
        for x in (60, 230, 370, 510):
            pdf.line(x, PAGE_HEIGHT - 205, x, PAGE_HEIGHT - 105)
        for y_line in (PAGE_HEIGHT - 105, PAGE_HEIGHT - 135, PAGE_HEIGHT - 165, PAGE_HEIGHT - 205):
            pdf.line(60, y_line, 510, y_line)
    else:
        pdf.setFont("Helvetica-Oblique", 9)
        pdf.drawString(70, y - 12, "Negative fixture: alignment alone must not become a native table.")
    pdf.save()


def make_figure(path: Path) -> None:
    image = Image.new("RGB", (240, 160), "#e8f1f8")
    draw = ImageDraw.Draw(image)
    draw.ellipse((30, 25, 135, 130), fill="#52a36d", outline="#205735", width=4)
    draw.rectangle((145, 45, 215, 125), fill="#d68b42", outline="#7b451d", width=4)
    buffer = BytesIO()
    image.save(buffer, format="PNG", optimize=False)
    buffer.seek(0)
    pdf = stable_canvas(path)
    draw_header(pdf, "Figure Composition")
    pdf.drawImage(ImageReader(buffer), 70, 485, width=240, height=160)
    pdf.setFillColor(colors.HexColor("#315d8a"))
    pdf.rect(330, 485, 180, 160, fill=0, stroke=1)
    pdf.line(350, 520, 485, 615)
    pdf.line(350, 615, 485, 520)
    pdf.setFillColor(colors.black)
    pdf.setFont("Helvetica-Oblique", 10)
    pdf.drawString(70, 465, "Figure 1. Raster shapes beside a vector diagram.")
    pdf.save()


def pdf_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def make_tagged(path: Path) -> None:
    writer = PdfWriter()
    page = writer.add_blank_page(width=PAGE_WIDTH, height=PAGE_HEIGHT)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
            NameObject("/Encoding"): NameObject("/WinAnsiEncoding"),
        }
    )
    font_ref = writer._add_object(font)
    image = DecodedStreamObject()
    image.set_data(bytes([82, 163, 109] * 16))
    image.update(
        {
            NameObject("/Type"): NameObject("/XObject"),
            NameObject("/Subtype"): NameObject("/Image"),
            NameObject("/Width"): NumberObject(4),
            NameObject("/Height"): NumberObject(4),
            NameObject("/ColorSpace"): NameObject("/DeviceRGB"),
            NameObject("/BitsPerComponent"): NumberObject(8),
        }
    )
    image_ref = writer._add_object(image)
    page[NameObject("/Resources")] = DictionaryObject(
        {
            NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_ref}),
            NameObject("/XObject"): DictionaryObject({NameObject("/Im1"): image_ref}),
        }
    )
    page[NameObject("/StructParents")] = NumberObject(0)
    text_values = [
        ("/H1", 0, 72, 770, 20, "Structured Garden Report"),
        ("/P", 1, 72, 735, 11, "Tagged content connects structure roles to marked text."),
        ("/TH", 2, 72, 680, 10, "Plot"),
        ("/TH", 3, 220, 680, 10, "Yield"),
        ("/TD", 4, 72, 650, 10, "North"),
        ("/TD", 5, 220, 650, 10, "Twelve"),
        ("/Caption", 7, 72, 475, 10, "Figure 1. Green sample tile."),
    ]
    commands = ["q 0.19 0.36 0.54 RG 60 625 300 85 re S Q"]
    for role, mcid, x, y, size, value in text_values:
        commands.append(
            f"{role} <</MCID {mcid}>> BDC BT /F1 {size} Tf {x} {y} Td ({pdf_string(value)}) Tj ET EMC"
        )
    commands.append("/Figure <</MCID 6>> BDC q 120 0 0 120 72 500 cm /Im1 Do Q EMC")
    content = DecodedStreamObject()
    content.set_data(("\n".join(commands) + "\n").encode("ascii"))
    page[NameObject("/Contents")] = writer._add_object(content)

    structure_root = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/StructTreeRoot"),
            NameObject("/ParentTreeNextKey"): NumberObject(1),
        }
    )
    structure_root_ref = writer._add_object(structure_root)

    def structure_element(role: str, mcid: int | None = None, alt: str | None = None) -> tuple[DictionaryObject, object]:
        element = DictionaryObject(
            {
                NameObject("/Type"): NameObject("/StructElem"),
                NameObject("/S"): NameObject(role),
                NameObject("/P"): structure_root_ref,
                NameObject("/Pg"): page.indirect_reference,
            }
        )
        if mcid is not None:
            element[NameObject("/K")] = NumberObject(mcid)
        if alt is not None:
            element[NameObject("/Alt")] = TextStringObject(alt)
        ref = writer._add_object(element)
        return element, ref

    _, h1_ref = structure_element("/H1", 0)
    _, paragraph_ref = structure_element("/P", 1)
    table, table_ref = structure_element("/Table")
    header_row, header_row_ref = structure_element("/TR")
    data_row, data_row_ref = structure_element("/TR")
    table[NameObject("/K")] = ArrayObject([header_row_ref, data_row_ref])
    table[NameObject("/P")] = structure_root_ref
    cell_refs = []
    for role, mcid in (("/TH", 2), ("/TH", 3), ("/TD", 4), ("/TD", 5)):
        cell, cell_ref = structure_element(role, mcid)
        cell[NameObject("/A")] = DictionaryObject(
            {
                NameObject("/O"): NameObject("/Table"),
                NameObject("/RowSpan"): NumberObject(1),
                NameObject("/ColSpan"): NumberObject(1),
            }
        )
        cell_refs.append(cell_ref)
    header_row[NameObject("/K")] = ArrayObject(cell_refs[:2])
    header_row[NameObject("/P")] = table_ref
    data_row[NameObject("/K")] = ArrayObject(cell_refs[2:])
    data_row[NameObject("/P")] = table_ref
    for ref in cell_refs[:2]:
        ref.get_object()[NameObject("/P")] = header_row_ref
    for ref in cell_refs[2:]:
        ref.get_object()[NameObject("/P")] = data_row_ref
    figure, figure_ref = structure_element("/Figure", 6, "Green square sample tile")
    caption, caption_ref = structure_element("/Caption", 7)
    figure[NameObject("/K")] = ArrayObject([NumberObject(6), caption_ref])
    caption[NameObject("/P")] = figure_ref
    top_refs = ArrayObject([h1_ref, paragraph_ref, table_ref, figure_ref])
    structure_root[NameObject("/K")] = top_refs
    parent_tree = DictionaryObject(
        {
            NameObject("/Nums"): ArrayObject(
                [
                    NumberObject(0),
                    ArrayObject(
                        [h1_ref, paragraph_ref, *cell_refs, figure_ref, caption_ref]
                    ),
                ]
            )
        }
    )
    structure_root[NameObject("/ParentTree")] = writer._add_object(parent_tree)
    writer._root_object[NameObject("/StructTreeRoot")] = structure_root_ref
    writer._root_object[NameObject("/MarkInfo")] = DictionaryObject(
        {NameObject("/Marked"): BooleanObject(True)}
    )
    writer._root_object[NameObject("/Lang")] = TextStringObject("en-US")
    writer.add_outline_item("Structured Garden Report", 0)
    writer.add_uri(0, "https://example.com/structured-garden", (72, 710, 360, 730))
    writer.add_metadata({"/Title": "Neutral Structured Garden Report", "/Author": "AtlCLI fixture generator"})
    with path.open("wb") as output:
        writer.write(output)


def make_adversarial(path: Path) -> None:
    source = HERE / "simple-untagged.pdf"
    reader = PdfReader(source)
    writer = PdfWriter()
    writer.append_pages_from_reader(reader)
    writer.add_js("app.alert('neutral fixture action');")
    writer.add_attachment("neutral-note.txt", b"Embedded neutral fixture; import must not extract this by default.\n")
    writer.add_metadata({"/Title": "Neutral actions and attachment fixture"})
    with path.open("wb") as output:
        writer.write(output)


def make_encrypted(path: Path) -> None:
    reader = PdfReader(HERE / "simple-untagged.pdf")
    writer = PdfWriter()
    writer.append_pages_from_reader(reader)
    writer.encrypt(user_password="neutral-fixture", owner_password="neutral-owner", algorithm="AES-256-R5")
    with path.open("wb") as output:
        writer.write(output)


def make_hundred_pages(path: Path, heading_rich: bool) -> None:
    pdf = stable_canvas(path)
    root_pages = {1: "Part One", 26: "Part Two", 51: "Part Three", 76: "Part Four"}
    for page in range(1, 101):
        if heading_rich and page in root_pages:
            draw_header(pdf, root_pages[page], page)
        else:
            draw_header(pdf, "Long Neutral Report" if not heading_rich else "Section Notes", page)
        pdf.setFont("Helvetica", 10)
        pdf.drawString(54, PAGE_HEIGHT - 110, f"Stable content token PAGE-{page:03d} belongs to source page {page}.")
        if heading_rich and page in {39, 40, 41}:
            pdf.setFont("Helvetica-Bold", 11)
            pdf.drawString(54, PAGE_HEIGHT - 150, f"Atomic table segment {page - 38} of 3")
            pdf.rect(54, PAGE_HEIGHT - 250, 470, 80, stroke=1, fill=0)
        pdf.showPage()
    pdf.save()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    digest.update(path.read_bytes())
    return digest.hexdigest()


def write_truth_manifest(paths: list[Path]) -> None:
    fixtures = {
        "simple-untagged.pdf": {"class": "digital-untagged", "pages": 1, "tokens": ["Quarterly Garden Notes", "twelve neutral test trees"], "annotations": 1},
        "complex-untagged.pdf": {"class": "digital-untagged", "pages": 1, "tokens": ["Left column sentence 01", "Right column sentence 12"], "columns": 2},
        "complex-tagged.pdf": {"class": "tagged", "pages": 1, "tokens": ["Structured Garden Report", "North", "Twelve"], "roles": {"H1": 1, "P": 1, "Table": 1, "TR": 2, "TH": 2, "TD": 2, "Figure": 1, "Caption": 1}, "tableSpans": 4, "figureAlt": "Green square sample tile", "annotations": 1, "outlines": 1, "physicalImages": 1},
        "scan.pdf": {"class": "scan", "pages": 1, "pdfTextTokens": [], "renderedTextOnly": "SCANNED NEUTRAL NOTICE"},
        "mixed.pdf": {"class": "mixed", "pages": 2, "digitalPages": [1], "scanPages": [2]},
        "table-positive.pdf": {"class": "digital-untagged", "pages": 1, "tablePolicy": "candidate-only-with-grid-evidence"},
        "table-negative.pdf": {"class": "digital-untagged", "pages": 1, "tablePolicy": "must-not-be-native"},
        "figure.pdf": {"class": "digital-untagged", "pages": 1, "physicalImages": 1, "vectorFigures": 1},
        "adversarial-actions.pdf": {"class": "digital-untagged", "pages": 1, "javascriptActions": 1, "embeddedFiles": 1, "policy": "report-never-execute-or-extract"},
        "encrypted.pdf": {"class": "encrypted", "pages": None, "password": "neutral-fixture", "policy": "reject-v1"},
        "heading-rich-100.pdf": {"class": "digital-untagged", "pages": 100, "rootPages": [1, 26, 51, 76], "expectedRanges": [[1, 25], [26, 50], [51, 75], [76, 100]], "atomicRegion": [39, 41], "unassignedPages": 0, "duplicatePages": 0},
        "heading-poor-100.pdf": {"class": "digital-untagged", "pages": 100, "rootPages": [], "expectedRanges": [[1, 20], [21, 40], [41, 60], [61, 80], [81, 100]], "unassignedPages": 0, "duplicatePages": 0},
    }
    for path in paths:
        fixtures[path.name]["sha256"] = sha256(path)
        fixtures[path.name]["bytes"] = path.stat().st_size
    payload = {
        "schema": "atlcli.import-pdf.fixture-truth/v1",
        "license": "Apache-2.0",
        "provenance": "Generated locally from specs/import-pdf-mvp/fixtures/generate.py; no customer or tenant input.",
        "fixtures": fixtures,
    }
    (HERE / "truth.json").write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> None:
    makers = [
        ("simple-untagged.pdf", make_simple),
        ("complex-untagged.pdf", make_complex_untagged),
        ("complex-tagged.pdf", make_tagged),
        ("scan.pdf", make_scan),
        ("mixed.pdf", make_mixed),
        ("table-positive.pdf", lambda path: make_table(path, False)),
        ("table-negative.pdf", lambda path: make_table(path, True)),
        ("figure.pdf", make_figure),
        ("heading-rich-100.pdf", lambda path: make_hundred_pages(path, True)),
        ("heading-poor-100.pdf", lambda path: make_hundred_pages(path, False)),
    ]
    paths = []
    for name, maker in makers:
        path = HERE / name
        maker(path)
        paths.append(path)
    adversarial = HERE / "adversarial-actions.pdf"
    make_adversarial(adversarial)
    paths.append(adversarial)
    encrypted = HERE / "encrypted.pdf"
    make_encrypted(encrypted)
    paths.append(encrypted)
    write_truth_manifest(paths)
    print(f"generated {len(paths)} neutral PDF fixtures")


if __name__ == "__main__":
    main()
