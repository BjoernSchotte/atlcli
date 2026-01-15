"""CLI entry point for atlcli-export subprocess."""

import argparse
import json
import sys
from pathlib import Path

from .docx_renderer import render_template


def main() -> int:
    """Main entry point for the CLI.

    Reads page data from stdin (JSON) and renders to DOCX.

    Returns:
        Exit code (0 for success, 1 for error)
    """
    parser = argparse.ArgumentParser(
        description="Render Confluence page to DOCX using Word template"
    )
    parser.add_argument(
        "--template", "-t",
        required=True,
        help="Path to Word template (.docx or .docm)"
    )
    parser.add_argument(
        "--output", "-o",
        required=True,
        help="Output path for generated document"
    )
    parser.add_argument(
        "--input", "-i",
        help="Input JSON file (default: read from stdin)"
    )

    args = parser.parse_args()

    try:
        # Read page data
        if args.input:
            with open(args.input, "r", encoding="utf-8") as f:
                page_data = json.load(f)
        else:
            page_data = json.load(sys.stdin)

        # Validate template exists
        template_path = Path(args.template)
        if not template_path.exists():
            print(json.dumps({
                "success": False,
                "error": f"Template not found: {template_path}"
            }))
            return 1

        # Render document
        output_path = render_template(
            template_path=template_path,
            page_data=page_data,
            output_path=args.output,
        )

        # Output success response
        print(json.dumps({
            "success": True,
            "output": str(output_path)
        }))
        return 0

    except json.JSONDecodeError as e:
        print(json.dumps({
            "success": False,
            "error": f"Invalid JSON input: {e}"
        }))
        return 1
    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": str(e)
        }))
        return 1


if __name__ == "__main__":
    sys.exit(main())
