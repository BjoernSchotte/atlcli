"""Body-free geometry oracle for the temporary PDF architecture spike."""

from __future__ import annotations

import json
import sys
from typing import Any

import pdfplumber


def table_summary(table: Any) -> dict[str, Any]:
    extracted = table.extract() or []
    column_count = max((len(row) for row in extracted), default=0)
    empty_cells = sum(
        1
        for row in extracted
        for cell in row
        if cell is None or not str(cell).strip()
    )
    return {
        "bbox": [round(float(value), 3) for value in table.bbox],
        "rows": len(extracted),
        "columns": column_count,
        "emptyCells": empty_cells,
    }


def find_tables(page: Any, settings: dict[str, Any]) -> list[dict[str, Any]]:
    try:
        return [table_summary(table) for table in page.find_tables(settings)]
    except Exception:
        return []


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: pdfplumber_oracle.py <pdf>", file=sys.stderr)
        return 2

    pages: list[dict[str, Any]] = []
    with pdfplumber.open(sys.argv[1]) as document:
        for index, page in enumerate(document.pages):
            line_tables = find_tables(
                page,
                {
                    "vertical_strategy": "lines",
                    "horizontal_strategy": "lines",
                    "snap_tolerance": 3,
                    "join_tolerance": 3,
                    "intersection_tolerance": 3,
                },
            )
            text_tables = find_tables(
                page,
                {
                    "vertical_strategy": "text",
                    "horizontal_strategy": "text",
                    "min_words_vertical": 2,
                    "min_words_horizontal": 1,
                },
            )
            pages.append(
                {
                    "pageIndex": index,
                    "characterCount": len(page.chars),
                    "lineCount": len(page.lines),
                    "rectangleCount": len(page.rects),
                    "curveCount": len(page.curves),
                    "lineTables": line_tables,
                    "textTables": text_tables,
                }
            )

    print(
        json.dumps(
            {
                "schema": "atlcli.pdfplumber-geometry-oracle/1",
                "engine": f"pdfplumber {pdfplumber.__version__}",
                "pages": pages,
            },
            ensure_ascii=True,
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
