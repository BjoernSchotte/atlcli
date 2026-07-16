/**
 * SimpleDateFormat subset for Scroll date placeholders (spec 004 Task 4).
 *
 * Scroll date placeholders accept a Java `SimpleDateFormat` argument, e.g.
 * `$scroll.exportdate.("dd.MM.yyyy")`. We implement the common numeric-pattern
 * tokens only (PLAN §2.2): `yyyy`, `MM`, `dd`, `HH`, `mm` (plus `yy`, `M`, `d`,
 * `H`, `m` single/short forms and literal quoting). Any token we don't recognize
 * makes the whole format fall back to ISO (`toISOString`) and records a report
 * note so the export surface stays honest (PLAN §2.2: "unknown format tokens
 * fall back to ISO + report line").
 *
 * Formatting is done in the local time zone (matching Word's own field
 * behaviour on the reader's machine is impossible; export-time local is the
 * pragmatic PoC choice and is deterministic in tests that pin the zone).
 */

/** Tokens we support, longest-first so `yyyy` matches before `yy`. */
const SUPPORTED_TOKENS = ["yyyy", "yy", "MM", "M", "dd", "d", "HH", "H", "mm", "m", "ss", "s"];

export interface DateFormatResult {
  text: string;
  /** Set when an unknown token forced the ISO fallback. */
  unknownToken?: string;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Format `date` with a SimpleDateFormat-subset `pattern`.
 *
 * Returns the formatted text, or the ISO date + `unknownToken` when the pattern
 * contains an unsupported alphabetic run. Literal text inside single quotes
 * (`'...'`) is emitted verbatim; `''` is a literal apostrophe.
 */
export function formatSimpleDate(date: Date, pattern: string): DateFormatResult {
  const values: Record<string, string> = {
    yyyy: String(date.getFullYear()),
    yy: pad2(date.getFullYear() % 100),
    MM: pad2(date.getMonth() + 1),
    M: String(date.getMonth() + 1),
    dd: pad2(date.getDate()),
    d: String(date.getDate()),
    HH: pad2(date.getHours()),
    H: String(date.getHours()),
    mm: pad2(date.getMinutes()),
    m: String(date.getMinutes()),
    ss: pad2(date.getSeconds()),
    s: String(date.getSeconds()),
  };

  let out = "";
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const ch = pattern[i];

    // Literal quoting.
    if (ch === "'") {
      if (pattern[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      const end = pattern.indexOf("'", i + 1);
      if (end === -1) {
        out += pattern.slice(i + 1);
        break;
      }
      out += pattern.slice(i + 1, end);
      i = end + 1;
      continue;
    }

    // Non-letter separators pass through.
    if (!/[A-Za-z]/.test(ch)) {
      out += ch;
      i += 1;
      continue;
    }

    // A run of the same letter is one pattern field.
    let j = i + 1;
    while (j < n && pattern[j] === ch) j += 1;
    const token = pattern.slice(i, j);

    if (token in values) {
      out += values[token];
      i = j;
      continue;
    }
    // Try the longest supported token that is a prefix (defensive; the
    // same-letter run already isolates fields, so this only helps mixed lengths).
    const match = SUPPORTED_TOKENS.find((t) => t === token);
    if (match) {
      out += values[match];
      i = j;
      continue;
    }

    // Unknown alphabetic token → ISO fallback for the whole value.
    return { text: date.toISOString().slice(0, 10), unknownToken: token };
  }

  return { text: out };
}

/**
 * Format a date for a placeholder occurrence: use the `.("pattern")` argument
 * if present, else the ISO date (`yyyy-MM-dd`), the deterministic default.
 */
export function formatDatePlaceholder(date: Date, argument?: string): DateFormatResult {
  if (argument == null || argument.trim() === "") {
    return { text: date.toISOString().slice(0, 10) };
  }
  return formatSimpleDate(date, argument);
}
