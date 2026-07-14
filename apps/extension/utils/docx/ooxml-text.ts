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
/** `<w:t>` bodies and hard-break/tab elements, in document order. */
const TEXT_OR_BREAK_RE = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:(?:br|tab|cr)\b[^>]*\/?>/g;
/** A `<w:r>…</w:r>` run (or the self-closing form). */
const RUN_RE = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>|<w:r(?:\s[^>]*)?\/>/g;

/** Split a document part into its `<w:p>…</w:p>` paragraph blocks (in order). */
export function splitParagraphs(xml: string): string[] {
  return xml.match(PARAGRAPH_RE) ?? [];
}

/**
 * The entity-decoded text of a paragraph, with a hard-break/tab boundary
 * rendered as a newline. Concatenating `<w:t>` bodies across `<w:br/>`/`<w:tab/>`
 * would fuse text that is visually on separate lines — that fusion produced
 * false placeholder matches (e.g. `$scroll.title` + `Version` → `$scroll.titleVersion`),
 * so a break contributes a separator that no placeholder can span.
 */
export function paragraphText(paragraphXml: string): string {
  let out = "";
  let m: RegExpExecArray | null;
  TEXT_OR_BREAK_RE.lastIndex = 0;
  while ((m = TEXT_OR_BREAK_RE.exec(paragraphXml)) !== null) {
    out += m[1] !== undefined ? decodeXmlText(m[1]) : "\n";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run-aware rewrite
// ---------------------------------------------------------------------------

interface Part {
  kind: "run" | "other";
  text: string;
}

interface RunInfo {
  /** The leading `<w:rPr>…</w:rPr>` (formatting signature), or "" if none. */
  rpr: string;
  /** Mergeable = pure `<w:t>` text with no break/tab and no drawing/object. */
  mergeable: boolean;
}

/** Inner XML of a run (between `<w:r …>` and `</w:r>`); "" for `<w:r/>`. */
function runInner(runXml: string): string {
  const m = runXml.match(/^<w:r(?:\s[^>]*)?>([\s\S]*)<\/w:r>$/);
  return m ? m[1] : "";
}

function parseRunInfo(runXml: string): RunInfo {
  const inner = runInner(runXml);
  const rpr = inner.match(/^<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] ?? "";
  const hasText = /<w:t\b[^>]*>/.test(inner);
  const hasBreak = /<w:(?:br|tab|cr)\b/.test(inner);
  const hasObject = /<w:(?:drawing|object|pict|fldChar|instrText)\b/.test(inner);
  return { rpr, mergeable: hasText && !hasBreak && !hasObject };
}

/** Concatenated, decoded `<w:t>` text of a single run. */
function runText(runXml: string): string {
  let out = "";
  for (const m of runXml.matchAll(WT_RE)) out += decodeXmlText(m[1]);
  return out;
}

/** Tokenize a paragraph into ordered run / non-run parts (order preserved). */
function tokenizeParts(paragraphXml: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  RUN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RUN_RE.exec(paragraphXml)) !== null) {
    if (m.index > last) parts.push({ kind: "other", text: paragraphXml.slice(last, m.index) });
    parts.push({ kind: "run", text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < paragraphXml.length) parts.push({ kind: "other", text: paragraphXml.slice(last) });
  return parts;
}

/** Write `text` into the first `<w:t>` of the segment; empty the rest. */
function writeSegment(parts: Part[], segIdx: number[], text: string): void {
  let wrote = false;
  for (const k of segIdx) {
    parts[k] = {
      kind: "run",
      text: parts[k].text.replace(WT_RE, () => {
        if (!wrote) {
          wrote = true;
          return `<w:t xml:space="preserve">${encodeXmlText(text)}</w:t>`;
        }
        return `<w:t xml:space="preserve"></w:t>`;
      }),
    };
  }
}

/**
 * Apply `transform` to placeholder text within run boundaries.
 *
 * Adjacent `<w:t>` runs that share the same `<w:rPr>` formatting and are not
 * separated by a `<w:br/>`/`<w:tab/>` are merged into one segment so a
 * placeholder split across rsid-driven runs (`$scr`|`oll.`|`title`) is detected
 * and replaced. Text is NOT fused across break/tab boundaries or across a
 * formatting change (differing `<w:rPr>`), so a line break or an italic switch
 * mid-paragraph keeps its own segment — preserving both the break elements and
 * per-run formatting. The replaced text lands in the first `<w:t>` of its
 * segment; other `<w:t>` bodies in the same segment are emptied.
 *
 * Paragraphs with no mergeable text are returned unchanged.
 */
export function rewriteParagraphText(
  paragraphXml: string,
  transform: (joined: string) => string
): string {
  const parts = tokenizeParts(paragraphXml);
  let changed = false;

  let i = 0;
  while (i < parts.length) {
    if (parts[i].kind !== "run") {
      i += 1;
      continue;
    }
    const info = parseRunInfo(parts[i].text);
    if (!info.mergeable) {
      i += 1;
      continue;
    }
    // Grow a segment of consecutive same-rPr mergeable runs.
    const segIdx = [i];
    let j = i + 1;
    while (j < parts.length && parts[j].kind === "run") {
      const qi = parseRunInfo(parts[j].text);
      if (!qi.mergeable || qi.rpr !== info.rpr) break;
      segIdx.push(j);
      j += 1;
    }
    const joined = segIdx.map((k) => runText(parts[k].text)).join("");
    const replaced = transform(joined);
    if (replaced !== joined) {
      writeSegment(parts, segIdx, replaced);
      changed = true;
    }
    i = j;
  }

  return changed ? parts.map((p) => p.text).join("") : paragraphXml;
}
