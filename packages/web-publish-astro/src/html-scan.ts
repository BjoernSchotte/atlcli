/**
 * Minimal HTML start-tag scanner for output verification. It is not a DOM
 * parser: it only answers "which elements and attributes would a browser
 * create", so safety checks look at markup instead of at page text.
 *
 * Wherever this scanner and a browser could disagree it errs towards seeing
 * MORE markup (the content of `<style>`, `<title>`, `<textarea>`, comments
 * that a browser would end early, end tags with quoted `>`), never less. Raw
 * text elements are read both ways: as markup, and as text that ends at the
 * element's end tag with the markup after it scanned normally.
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
const SCRIPT_TOKEN = /<!--|-->|<(\/?)script(?=[\t\n\f\r />])/giu;
/** Elements whose content an HTML parser reads as text up to the matching end tag: no tags, no comments. */
const RAW_TEXT_END: Readonly<Record<string, RegExp>> = Object.fromEntries(
  ["textarea", "title", "style", "xmp", "noscript", "noembed", "noframes"].map((name) => [name, new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "giu")]),
);

/**
 * Where a browser ends an HTML `<script>` body that starts at `from`. `<!--`
 * escapes it and a `<script` inside the escape makes the next `</script` plain
 * text, so the first `</script` is not always the end.
 */
function scriptEnd(html: string, from: number): number {
  let state: "data" | "escaped" | "double-escaped" = "data";
  SCRIPT_TOKEN.lastIndex = from;
  for (let match = SCRIPT_TOKEN.exec(html); match !== null; match = SCRIPT_TOKEN.exec(html)) {
    if (match[0] === "<!--") {
      if (state === "data") state = "escaped";
      SCRIPT_TOKEN.lastIndex = match.index + 2; // `<!-->` opens and closes the escape
    } else if (match[0] === "-->") {
      state = "data";
    } else if (match[1] === "/") {
      if (state !== "double-escaped") return match.index;
      state = "escaped";
    } else if (state === "escaped") {
      state = "double-escaped";
    }
  }
  return html.length;
}

/** One pass over `text`, which starts at offset `base` of the document. */
interface ScanPassV1 {
  text: string;
  base: number;
  start: number;
  foreignDepth: number;
  /** False inside raw text, where `<!--` does not open a comment. */
  comments: boolean;
}

/** Scan the start tags, attributes and script bodies of an HTML document. */
export function scanHtmlV1(html: string): ScannedHtmlV1 {
  // Where the scanner cannot know how a browser reads an element (raw text or
  // markup), it scans both readings. Readings meet again at the same offset in
  // the same state, which ends the later one.
  const found: ScanResultV1 = { tags: new Map(), scripts: new Map(), visited: new Set() };
  const passes: ScanPassV1[] = [{ text: html, base: 0, start: 0, foreignDepth: 0, comments: true }];
  for (let pass = passes.pop(); pass !== undefined; pass = passes.pop()) scanPass(pass, passes, found);
  const inDocumentOrder = <T>(entries: Map<string, { at: number; value: T }>): T[] =>
    [...entries.values()].sort((left, right) => left.at - right.at).map((entry) => entry.value);
  return { tags: inDocumentOrder(found.tags), scripts: inDocumentOrder(found.scripts) };
}

/** Findings keyed by document span, so that passes which reach the same tag report it once. */
interface ScanResultV1 {
  tags: Map<string, { at: number; value: ScannedHtmlTagV1 }>;
  scripts: Map<string, { at: number; value: string }>;
  visited: Set<string>;
}

function scanPass({ text: html, base, start, comments, ...pass }: ScanPassV1, passes: ScanPassV1[], { tags, scripts, visited }: ScanResultV1): void {
  const length = html.length;
  // Inside `<svg>`/`<math>` a browser does not treat `<script>` content as raw
  // text, so its content is scanned as markup there.
  let foreignDepth = pass.foreignDepth;
  let index = start;
  while (index < length) {
    const open = html.indexOf("<", index);
    if (open === -1) break;
    const state = `${base + open}:${base + length}:${foreignDepth}:${comments}`;
    if (visited.has(state)) break;
    visited.add(state);
    index = open + 1;
    if (html.startsWith("!--", index)) {
      if (!comments) continue;
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
    tags.set(`${base + open}:${base + index}`, { at: base + open, value: { name, attributes } });
    if ((name === "svg" || name === "math") && !selfClosing) foreignDepth += 1;
    if (name === "script") {
      const end = scriptEnd(html, index);
      scripts.set(`${base + index}:${base + end}`, { at: base + index, value: html.slice(index, end) });
      if (foreignDepth === 0) {
        // Between the first `</script` and the real end a browser sees script
        // text; scanning it as markup too can only find more.
        const firstEnd = skipPast(SCRIPT_END, html, index).start;
        if (firstEnd < end) passes.push({ text: html.slice(firstEnd, end), base: base + firstEnd, start: 0, foreignDepth, comments: false });
        index = end;
        continue;
      }
      // Markup in foreign content, raw text at an HTML integration point
      // (`<foreignObject>`, `<desc>`, `<title>`): this pass reads it as markup,
      // a second one resumes after the end tag.
      passes.push({ text: html, base, start: end, foreignDepth, comments });
    } else if (name === "plaintext" || RAW_TEXT_END[name] !== undefined) {
      // A browser ends the element at its end tag whatever the content looks
      // like, so one pass resumes there. The content is still scanned as
      // markup: without comments and cut off at the end tag, and by this pass
      // as before (which is also how a browser without scripting reads
      // `<noscript>`, and how foreign content reads all of these).
      const end = name === "plaintext" ? length : skipPast(RAW_TEXT_END[name]!, html, index).start;
      passes.push({ text: html.slice(index, end), base: base + index, start: 0, foreignDepth, comments: false });
      passes.push({ text: html, base, start: end, foreignDepth, comments });
    }
  }
}
