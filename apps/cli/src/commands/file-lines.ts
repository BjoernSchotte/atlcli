/**
 * Splits file bytes into records for `atlcli.files.lines`: text lines, JSON
 * Lines or CSV records (RFC 4180; a quoted field may span lines). The port
 * reads a file a window at a time and continues at `consumed`. Pure.
 */
import type { LinesFormat } from "@atlcli/script-runtime";

export interface LinesPage {
  items: unknown[];
  /** Bytes of `data` that formed complete records; the next window starts there. */
  consumed: number;
  /** Physical lines those records spanned. */
  lines: number;
}

const decoder = new TextDecoder();

/**
 * Up to `max` records from `data`. Without `eof` a record is complete only at
 * its line break; at the end of the file the rest is a record too. `start`:
 * `data` begins the file (a UTF-8 byte order mark is dropped). `line` is the
 * number of lines before `data`, for error messages.
 */
export function readLinesPage(data: Uint8Array, o: { format: LinesFormat; eof: boolean; max: number; line: number; start: boolean }): LinesPage {
  const csv = o.format === "csv";
  let pos = o.start && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0;
  let lines = 0;
  const items: unknown[] = [];
  while (items.length < o.max && pos < data.length) {
    let end = pos;
    let quoted = false;
    let breaks = 0;
    for (; end < data.length; end++) {
      const b = data[end];
      if (csv && b === 0x22) quoted = !quoted;
      else if (b === 0x0a) {
        if (!quoted) break;
        breaks++;
      }
    }
    if (end >= data.length && !o.eof) break;
    let text = decoder.decode(data.subarray(pos, end));
    if (text.endsWith("\r")) text = text.slice(0, -1);
    const lineNo = o.line + lines + 1;
    pos = Math.min(end + 1, data.length);
    lines += 1 + breaks;
    if (o.format === "jsonl") {
      if (!text.trim()) continue;
      try {
        items.push(JSON.parse(text));
      } catch (error) {
        throw new Error(`line ${lineNo} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (csv) {
      if (text === "") continue;
      items.push(parseCsvRecord(text));
    } else {
      items.push(text);
    }
  }
  return { items, consumed: pos, lines };
}

/** The fields of one CSV record (RFC 4180: `""` inside quotes is a quote; quoted fields may hold commas and line breaks). */
export function parseCsvRecord(text: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      fields.push(field);
      field = "";
    } else field += c;
  }
  fields.push(field);
  return fields;
}
