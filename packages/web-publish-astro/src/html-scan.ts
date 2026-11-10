/**
 * Minimal HTML start-tag scanner for output verification. It is not a DOM
 * parser: it only answers "which elements and attributes would a browser
 * create", so safety checks look at markup instead of at page text.
 *
 * Wherever this scanner and a browser could disagree it errs towards seeing
 * MORE markup (the content of `<style>`, `<title>`, `<textarea>`, comments
 * that a browser would end early, end tags with quoted `>`), never less.
 */

export interface ScannedHtmlTagV1 {
  /** Lower-cased element name. */
  name: string;
  /** Lower-cased attribute name to entity-decoded value; the first duplicate wins, as in a browser. */
  attributes: ReadonlyMap<string, string>;
}

export interface ScannedHtmlV1 {
  tags: readonly ScannedHtmlTagV1[];
  /** Raw text of every HTML `<script>` element body. */
  scripts: readonly string[];
}

const WHITESPACE = "\t\n\f\r ";
// Entities that can spell a URL scheme or its separators. Unknown named
// entities stay literal, which can only make a URL fail to resolve.
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", colon: ":", tab: "\t", newline: "\n",
  sol: "/", bsol: "\\", period: ".", num: "#", quest: "?", nbsp: " ",
};

function decodeEntities(value: string): string {
  return value.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z]+));?/giu, (match, hex: string | undefined, decimal: string | undefined, name: string | undefined) => {
    if (name !== undefined) {
      // Case-folded lookup decodes slightly more than a browser would, never less.
      const key = name.toLowerCase();
      const decoded = NAMED_ENTITIES[key];
      if (decoded === undefined) return match;
      // Named references need their semicolon, except the legacy `&amp`/`&lt`/`&gt`/`&quot`.
      return match.endsWith(";") || ["amp", "lt", "gt", "quot"].includes(key) ? decoded : match;
    }
    const codePoint = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(decimal!, 10);
    return codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? String.fromCodePoint(codePoint)
      : "\ufffd";
  });
}

/** Position just past the first match at or after `from`, or the end of input. */
function skipPast(pattern: RegExp, html: string, from: number): { start: number; end: number } {
  pattern.lastIndex = from;
  const match = pattern.exec(html);
  return match === null ? { start: html.length, end: html.length } : { start: match.index, end: match.index + match[0].length };
}

const COMMENT_END = /--!?>/gu;
const SCRIPT_END = /<\/script(?=[\t\n\f\r />])/giu;

/** Scan the start tags, attributes and script bodies of an HTML document. */
export function scanHtmlV1(html: string): ScannedHtmlV1 {
  const tags: ScannedHtmlTagV1[] = [];
  const scripts: string[] = [];
  const length = html.length;
  // Inside `<svg>`/`<math>` a browser does not treat `<script>` content as raw
  // text, so its content is scanned as markup there.
  let foreignDepth = 0;
  let index = 0;
  while (index < length) {
    const open = html.indexOf("<", index);
    if (open === -1) break;
    index = open + 1;
    if (html.startsWith("!--", index)) {
      index += 3;
      if (html.startsWith(">", index)) { index += 1; continue; }
      if (html.startsWith("->", index)) { index += 2; continue; }
      index = skipPast(COMMENT_END, html, index).end;
      continue;
    }
    const first = html[index] ?? "";
    if (first === "/") {
      const end = html.indexOf(">", index);
      const name = /^\/([a-z][^\t\n\f\r />]*)/iu.exec(html.slice(index, index + 64))?.[1]?.toLowerCase();
      if ((name === "svg" || name === "math") && foreignDepth > 0) foreignDepth -= 1;
      index = end === -1 ? length : end + 1;
      continue;
    }
    if (first === "!" || first === "?") {
      const end = html.indexOf(">", index);
      index = end === -1 ? length : end + 1;
      continue;
    }
    if (!/[a-z]/iu.test(first)) continue;

    let cursor = index;
    while (cursor < length && !WHITESPACE.includes(html[cursor]!) && html[cursor] !== "/" && html[cursor] !== ">") cursor += 1;
    const name = html.slice(index, cursor).toLowerCase();
    const attributes = new Map<string, string>();
    let selfClosing = false;
    while (cursor < length) {
      const character = html[cursor]!;
      if (WHITESPACE.includes(character)) { cursor += 1; continue; }
      if (character === "/") {
        selfClosing = html[cursor + 1] === ">";
        cursor += 1;
        continue;
      }
      if (character === ">") break;
      const nameStart = cursor;
      cursor += 1; // a leading `=` is part of the attribute name
      while (cursor < length && !WHITESPACE.includes(html[cursor]!) && !"/>=".includes(html[cursor]!)) cursor += 1;
      const attributeName = html.slice(nameStart, cursor).toLowerCase();
      while (cursor < length && WHITESPACE.includes(html[cursor]!)) cursor += 1;
      let value = "";
      if (html[cursor] === "=") {
        cursor += 1;
        while (cursor < length && WHITESPACE.includes(html[cursor]!)) cursor += 1;
        const quote = html[cursor];
        if (quote === "\"" || quote === "'") {
          const close = html.indexOf(quote, cursor + 1);
          value = html.slice(cursor + 1, close === -1 ? length : close);
          cursor = close === -1 ? length : close + 1;
        } else {
          const valueStart = cursor;
          while (cursor < length && !WHITESPACE.includes(html[cursor]!) && html[cursor] !== ">") cursor += 1;
          value = html.slice(valueStart, cursor);
        }
      }
      if (!attributes.has(attributeName)) attributes.set(attributeName, decodeEntities(value));
    }
    index = Math.min(cursor + 1, length);
    tags.push({ name, attributes });
    if ((name === "svg" || name === "math") && !selfClosing) foreignDepth += 1;
    if (name === "script" && foreignDepth === 0) {
      const end = skipPast(SCRIPT_END, html, index).start;
      scripts.push(html.slice(index, end));
      index = end;
    }
  }
  return { tags, scripts };
}
