"""Custom Jinja2 filters for docxtpl templates."""

from datetime import datetime
from typing import Optional


def _format_java_token(dt: datetime, token: str) -> str:
    """Format a single Java-style date token."""
    ch = token[0]
    length = len(token)

    if ch in ("y", "Y"):
        if length == 2:
            return f"{dt.year % 100:02d}"
        return f"{dt.year:04d}"

    if ch == "M":
        if length >= 4:
            return dt.strftime("%B")
        if length == 3:
            return dt.strftime("%b")
        if length == 2:
            return f"{dt.month:02d}"
        return str(dt.month)

    if ch in ("d", "D"):
        if length == 2:
            return f"{dt.day:02d}"
        return str(dt.day)

    if ch == "H":
        if length == 2:
            return f"{dt.hour:02d}"
        return str(dt.hour)

    if ch == "h":
        hour = dt.hour % 12 or 12
        if length == 2:
            return f"{hour:02d}"
        return str(hour)

    if ch == "m":
        if length == 2:
            return f"{dt.minute:02d}"
        return str(dt.minute)

    if ch == "s":
        if length == 2:
            return f"{dt.second:02d}"
        return str(dt.second)

    if ch == "a":
        return "AM" if dt.hour < 12 else "PM"

    return token


def _format_java_date(dt: datetime, pattern: str) -> str:
    """Format a datetime using Java-style pattern tokens (supports Scroll formats)."""
    result: list[str] = []
    i = 0
    in_literal = False

    while i < len(pattern):
        ch = pattern[i]

        if ch == "'":
            if i + 1 < len(pattern) and pattern[i + 1] == "'":
                result.append("'")
                i += 2
                continue
            in_literal = not in_literal
            i += 1
            continue

        if in_literal:
            result.append(ch)
            i += 1
            continue

        if ch.isalpha():
            j = i
            while j < len(pattern) and pattern[j] == ch:
                j += 1
            token = pattern[i:j]
            result.append(_format_java_token(dt, token))
            i = j
            continue

        result.append(ch)
        i += 1

    return "".join(result)


def date_filter(value: str, format: str = "YYYY-MM-DD") -> str:
    """Format an ISO date string according to the given format (Java-style tokens)."""
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

    return _format_java_date(dt, format)


def default_filter(value: Optional[str], default: str = "") -> str:
    """Return default value if value is None or empty."""
    if value is None or value == "":
        return default
    return value


def register_filters(jinja_env) -> None:
    """Register all custom filters with a Jinja2 environment."""
    jinja_env.filters["date"] = date_filter
    jinja_env.filters["default"] = default_filter
