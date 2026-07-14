/**
 * Low-level OOXML text helpers shared by the placeholder scan (Task 3) and the
 * `$scroll.*` preprocessor (Task 5).
 *
 * The central problem both solve is **run splitting**: Word frequently splits a
 * single logical string like `$scroll.title` across several `<w:r><w:t>` runs
 * (rsid boundaries, spell-check state), so a naive substring search over one run
 * misses the placeholder. These helpers merge the `<w:t>` text of a paragraph
 * before matching/replacing (engine-decision.md: "Production must first
 * normalise/merge runs inside placeholder paragraphs before find/replace").
 *
 * The functions are string-level (regex over well-formed OOXML) rather than
 * DOM-based: DOMParser is unavailable in the MV3 service worker and adds weight
 * in the panel, and the confluence walker already proves a regex/token approach
 * is sufficient for this shape of XML.
 */

/** Decode the XML entities that appear in `<w:t>` bodies. */
export function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

/** Encode text for insertion into a `<w:t>` body. */
export function encodeXmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const PARAGRAPH_RE = /<w:p\b[^>]*>[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g;
const WT_RE = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;

/** Split a document part into its `<w:p>…</w:p>` paragraph blocks (in order). */
export function splitParagraphs(xml: string): string[] {
  return xml.match(PARAGRAPH_RE) ?? [];
}

/** The concatenated, entity-decoded `<w:t>` text of a paragraph. */
export function paragraphText(paragraphXml: string): string {
  let out = "";
  let m: RegExpExecArray | null;
  WT_RE.lastIndex = 0;
  while ((m = WT_RE.exec(paragraphXml)) !== null) {
    out += decodeXmlText(m[1]);
  }
  return out;
}

/**
 * Collapse every `<w:t>` in a paragraph into the first one, applying `transform`
 * to the joined (decoded) text. The first `<w:t>` keeps its run's formatting and
 * receives the full transformed text (re-encoded, `xml:space="preserve"`); all
 * other `<w:t>` bodies are emptied. This makes a run-split placeholder
 * contiguous and replaceable while preserving the paragraph's first-run style.
 *
 * Paragraphs with no `<w:t>` are returned unchanged.
 */
export function rewriteParagraphText(
  paragraphXml: string,
  transform: (joined: string) => string
): string {
  const texts: string[] = [];
  WT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WT_RE.exec(paragraphXml)) !== null) texts.push(decodeXmlText(m[1]));
  if (texts.length === 0) return paragraphXml;

  const joined = texts.join("");
  const replaced = transform(joined);
  if (replaced === joined) return paragraphXml;

  let idx = 0;
  return paragraphXml.replace(WT_RE, () => {
    // Normalize each <w:t> to xml:space="preserve" so leading/trailing spaces
    // survive; the first run receives the full transformed text, the rest blank.
    const isFirst = idx === 0;
    idx += 1;
    const body = isFirst ? encodeXmlText(replaced) : "";
    return `<w:t xml:space="preserve">${body}</w:t>`;
  });
}
