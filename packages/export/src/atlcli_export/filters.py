"""Custom Jinja2 filters for docxtpl templates."""

from datetime import datetime
from typing import Optional


def date_filter(value: str, format: str = "YYYY-MM-DD") -> str:
    """Format an ISO date string according to the given format.

    Supports common format tokens:
    - YYYY: 4-digit year
    - YY: 2-digit year
    - MM: 2-digit month
    - DD: 2-digit day
    - HH: 2-digit hour (24h)
    - mm: 2-digit minute
    - ss: 2-digit second
    """
    if not value:
        return ""

    try:
        # Parse ISO format (handles both with and without timezone)
        if "T" in value:
            # ISO format with time
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        else:
            # Date only
            dt = datetime.fromisoformat(value)
    except ValueError:
        return value  # Return original if parsing fails

    # Convert format tokens to strftime
    result = format
    result = result.replace("YYYY", "%Y")
    result = result.replace("YY", "%y")
    result = result.replace("MM", "%m")
    result = result.replace("DD", "%d")
    result = result.replace("HH", "%H")
    result = result.replace("mm", "%M")
    result = result.replace("ss", "%S")

    return dt.strftime(result)


def default_filter(value: Optional[str], default: str = "") -> str:
    """Return default value if value is None or empty."""
    if value is None or value == "":
        return default
    return value


def register_filters(jinja_env) -> None:
    """Register all custom filters with a Jinja2 environment."""
    jinja_env.filters["date"] = date_filter
    jinja_env.filters["default"] = default_filter
