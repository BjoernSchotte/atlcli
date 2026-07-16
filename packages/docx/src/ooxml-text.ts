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

const WT_RE = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
/** `<w:t>` bodies and hard-break/tab elements, in document order. */
const TEXT_OR_BREAK_RE = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:(?:br|tab|cr)\b[^>]*\/?>/g;
/** A `<w:r>…</w:r>` run (or the self-closing form). */
const RUN_RE = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>|<w:r(?:\s[^>]*)?\/>/g;

/**
 * A `<w:p …>` open, a `<w:p …/>` self-closing paragraph, or a `</w:p>` close.
 * Group 1 is `/` for the self-closing form. `<w:p\b` never matches `<w:pPr`
 * (no word boundary between `p` and `P`), so paragraph-properties are ignored.
 */
const P_TOKEN_RE = /<w:p\b[^>]*?(\/)?>|<\/w:p>/g;

/**
 * Split a document part into its TOP-LEVEL `<w:p>…</w:p>` paragraph blocks.
 *
 * A naive non-greedy `<w:p>…</w:p>` regex mis-segments a paragraph that nests
 * another paragraph — Word does exactly this when a run holds a drawing/text box
 * whose `<w:txbxContent>` contains its own `<w:p>`: the non-greedy match stops at
 * the INNER `</w:p>`, cutting the outer paragraph short and desyncing every
 * boundary after it (so e.g. a footer's `$scroll.title` run that trails a
 * text-box picture fell outside the captured paragraph and was never replaced).
 * This balanced scan tracks `<w:p>` depth and emits only the outermost blocks;
 * text-box descent is handled separately by {@link extractTextboxes}.
 */
export function splitParagraphs(xml: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let m: RegExpExecArray | null;
  P_TOKEN_RE.lastIndex = 0;
  while ((m = P_TOKEN_RE.exec(xml)) !== null) {
    if (m[0] === "</w:p>") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start !== -1) {
          out.push(xml.slice(start, P_TOKEN_RE.lastIndex));
          start = -1;
        }
      }
      continue;
    }
    if (m[1] === "/") {
      // Self-closing `<w:p/>`: a whole (empty) paragraph only at the top level.
      if (depth === 0) out.push(m[0]);
      continue;
    }
    if (depth === 0) start = m.index;
    depth += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text-box descent
// ---------------------------------------------------------------------------

const TXBX_OPEN = "<w:txbxContent";
const TXBX_CLOSE = "</w:txbxContent>";

/** A masked-out `<w:txbxContent>` region and the sentinel standing in for it. */
export interface TextboxRegion {
  /** A per-region marker placed in the masked XML (carries no OOXML tags). */
  sentinel: string;
  /** The `<w:txbxContent …>` opening tag, restored verbatim. */
  openTag: string;
  /** The region's inner XML (its own `<w:p>` paragraphs), for recursion. */
  inner: string;
}

/**
 * Replace every top-level `<w:txbxContent>…</w:txbxContent>` region with an
 * opaque sentinel so the enclosing paragraph can be tokenized into flat runs.
 *
 * Word puts placeholders in text boxes two ways at once via
 * `mc:AlternateContent`: a modern DrawingML `wps:txbx` (`mc:Choice`) and a VML
 * `v:textbox` fallback (`mc:Fallback`), each holding its OWN nested `<w:p>` +
 * `<w:r>`. Those nested runs break the non-greedy `RUN_RE`/paragraph regexes, so
 * we carve the text-box regions out first (balanced on `<w:txbxContent>` depth),
 * leaving a sentinel the caller can process opaquely and restore. Both the
 * Choice and the Fallback copy are separate top-level regions, so both are
 * returned — the caller resolves the placeholder in each (Word renders whichever
 * it supports).
 */
export function extractTextboxes(xml: string): { masked: string; regions: TextboxRegion[] } {
  if (!xml.includes(TXBX_OPEN)) return { masked: xml, regions: [] };
  const regions: TextboxRegion[] = [];
  let masked = "";
  let i = 0;
  for (;;) {
    const open = xml.indexOf(TXBX_OPEN, i);
    if (open === -1) {
      masked += xml.slice(i);
      break;
    }
    const openTagEnd = xml.indexOf(">", open);
    if (openTagEnd === -1) {
      masked += xml.slice(i);
      break;
    }
    // Self-closing `<w:txbxContent/>` (empty box): pass through untouched.
    if (xml[openTagEnd - 1] === "/") {
      masked += xml.slice(i, openTagEnd + 1);
      i = openTagEnd + 1;
      continue;
    }
    // Balanced scan for the matching close (text boxes rarely nest, but be safe).
    let depth = 1;
    let j = openTagEnd + 1;
    while (depth > 0) {
      const nextOpen = xml.indexOf(TXBX_OPEN, j);
      const nextClose = xml.indexOf(TXBX_CLOSE, j);
      if (nextClose === -1) break; // malformed — stop scanning
      if (nextOpen !== -1 && nextOpen < nextClose) {
        const t = xml.indexOf(">", nextOpen);
        if (t === -1) {
          depth -= 1;
          j = nextClose + TXBX_CLOSE.length;
        } else {
          depth += 1;
          j = t + 1;
        }
      } else {
        depth -= 1;
        j = nextClose + TXBX_CLOSE.length;
      }
    }
    const openTag = xml.slice(open, openTagEnd + 1);
    const inner = xml.slice(openTagEnd + 1, j - TXBX_CLOSE.length);
    // Sentinel uses Private-Use-Area brackets distinct from the export
    // delimiter pair (U+E000/U+E001); it is always restored before return.
    const sentinel = `txbx${regions.length}`;
    regions.push({ sentinel, openTag, inner });
    masked += xml.slice(i, open) + sentinel;
    i = j;
  }
  return { masked, regions };
}

/**
 * All paragraph texts of a document part, descending into text boxes.
 *
 * Top-level paragraphs are read with text-box regions masked out (so a box's
 * text is never fused with the enclosing paragraph's own runs), and each text
 * box's inner paragraphs are collected independently (recursively). This is the
 * scan-side counterpart to {@link rewriteScrollText}: both walk the same set of
 * paragraphs so the panel's supported-list and the actual replacement agree.
 */
export function collectParagraphTexts(xml: string): string[] {
  const texts: string[] = [];
  collectParagraphTextsInto(xml, texts);
  // DrawingML text (SmartArt / chart / shape `<a:t>` runs) lives OUTSIDE the
  // WordprocessingML `<w:p>` tree — in `<a:p>` paragraphs, either inline in this
  // part or (more commonly) in a separate chart/diagram part. Collect those too
  // so the scan panel's supported-list matches what {@link rewriteScrollText}
  // resolves. Reads the whole part (nested boxes included), reads only `<a:t>`.
  for (const text of collectDrawingTexts(xml)) texts.push(text);
  return texts;
}

function collectParagraphTextsInto(xml: string, texts: string[]): void {
  const { masked, regions } = extractTextboxes(xml);
  for (const region of regions) collectParagraphTextsInto(region.inner, texts);
  for (const para of splitParagraphs(masked)) texts.push(paragraphText(para));
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

/** Replace the first occurrence of `needle` in `haystack` (literal, `$`-safe). */
function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const idx = haystack.indexOf(needle);
  if (idx === -1) return haystack;
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
}

/**
 * Resolve `$scroll.*` text across a whole document part, descending into text
 * boxes and past drawing-adjacent runs.
 *
 * Text boxes are masked out first (so the enclosing paragraph tokenizes into
 * flat runs — a drawing/pict run is a non-mergeable boundary that keeps finding
 * #8's no-fuse guarantee, while a clean `<w:t>` run sharing the paragraph still
 * gets replaced), each top-level paragraph is run-normalized via
 * {@link rewriteParagraphText}, then every masked text box is restored with its
 * OWN inner paragraphs resolved (recursively — covering both the `mc:Choice`
 * DrawingML box and the `mc:Fallback` VML box, so Word shows the resolved value
 * whichever it renders). `transform` receives each run-merged placeholder string
 * and returns its replacement.
 */
export function rewriteScrollText(
  xml: string,
  transform: (joined: string) => string
): string {
  // WordprocessingML pass first (paragraph/run/text-box tree), then the
  // DrawingML pass over the WHOLE result — the latter walks `<a:p>` paragraphs
  // wherever they sit (inline shapes here, or a chart/diagram part passed as
  // `xml`), so a single top-level DrawingML sweep covers every `<a:t>` run,
  // including any nested inside a restored text box.
  const afterWml = rewriteScrollTextWml(xml, transform);
  return rewriteDrawingText(afterWml, transform);
}

function rewriteScrollTextWml(
  xml: string,
  transform: (joined: string) => string
): string {
  const { masked, regions } = extractTextboxes(xml);

  // 1. Rewrite the top-level paragraphs on the MASKED xml, where drawing/text-box
  //    runs are opaque sentinels — so run tokenization stays flat and correct.
  let out = masked;
  for (const para of splitParagraphs(masked)) {
    const text = paragraphText(para);
    if (!text.includes("$scroll") && !text.includes("$adhocState")) continue;
    const rewritten = rewriteParagraphText(para, transform);
    if (rewritten !== para) out = replaceFirst(out, para, rewritten);
  }

  // 2. Restore each text box, resolving its inner paragraphs recursively.
  //    NOTE: recursion re-masks/rewrites each box's OWN `<w:p>` runs, so the
  //    text-box boundary is honoured — an outer run's `$scr` is never fused with
  //    an inner box run's `oll.title`. A text box is a separate story; a word
  //    cannot straddle that boundary in real authoring, so NOT merging across it
  //    is the correct behaviour, not a gap (see shape ③ regression test).
  for (const region of regions) {
    const processedInner = rewriteScrollTextWml(region.inner, transform);
    out = replaceFirst(out, region.sentinel, region.openTag + processedInner + "</w:txbxContent>");
  }

  return out;
}

// ---------------------------------------------------------------------------
// DrawingML text (SmartArt / chart / shape `<a:t>` runs)
// ---------------------------------------------------------------------------
//
// Placeholders can live in DrawingML text, which uses the `a:` namespace and is
// structurally independent of the `w:` paragraph/run tree handled above:
//   • SmartArt diagram text  — `word/diagrams/data*.xml` (`<dgm:t><a:p><a:r><a:t>`)
//   • chart titles / labels  — `word/charts/chart*.xml`  (`<c:tx><c:rich><a:p>…`)
//   • drawing/shape text     — inline `<a:p><a:r><a:t>` inside a `<w:drawing>`
//
// The `<a:t>` run is the DrawingML analogue of `<w:t>`. Word can split a single
// logical string across adjacent `<a:t>` runs (same rsid discipline as `<w:t>`),
// so we merge consecutive `<a:t>` within one `<a:p>` before matching — with an
// `<a:br/>` hard break as a boundary a placeholder cannot span (mirrors the
// `<w:br/>` rule). Unlike `<w:r>`, an `<a:t>` carries no `<w:rPr>`-equivalent we
// need to gate on, so ALL consecutive `<a:t>` in one `<a:p>` are mergeable.
//
// We touch ONLY `<a:t>` text bodies — never geometry, style, or any other
// structural DrawingML — so every modified part stays well-formed.

/** A DrawingML `<a:p>…</a:p>` paragraph (or the self-closing `<a:p/>`). */
const A_P_RE = /<a:p\b[^>]*>[\s\S]*?<\/a:p>|<a:p\b[^>]*\/>/g;
/** An `<a:t …>` body (group 1 = open tag, group 2 = inner) or an `<a:br/>`. */
const A_TEXT_OR_BREAK_RE = /(<a:t\b[^>]*>)([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/?>/g;

interface AtToken {
  openTag: string;
  inner: string;
  start: number;
  end: number;
}

/**
 * Resolve `$scroll.*` text in the DrawingML `<a:t>` runs of every `<a:p>` in
 * `xml`. Consecutive `<a:t>` in one paragraph are merged (so a split placeholder
 * is detected); an `<a:br/>` breaks the merge. The replacement lands in the
 * first `<a:t>` of its run group; the rest are emptied. Non-`<a:t>` DrawingML is
 * untouched.
 */
export function rewriteDrawingText(
  xml: string,
  transform: (joined: string) => string
): string {
  if (!xml.includes("<a:t")) return xml;
  return xml.replace(A_P_RE, (pXml) => rewriteDrawingParagraph(pXml, transform));
}

function rewriteDrawingParagraph(pXml: string, transform: (joined: string) => string): string {
  const tokens: (AtToken | "break")[] = [];
  A_TEXT_OR_BREAK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = A_TEXT_OR_BREAK_RE.exec(pXml)) !== null) {
    if (m[1] !== undefined) {
      tokens.push({ openTag: m[1], inner: m[2], start: m.index, end: m.index + m[0].length });
    } else {
      tokens.push("break");
    }
  }

  // Collect edits (start/end/replacement) for run groups whose merged text
  // changes; apply them in one left-to-right splice so offsets stay valid.
  const edits: { start: number; end: number; text: string }[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i] === "break") {
      i += 1;
      continue;
    }
    const seg: AtToken[] = [];
    while (i < tokens.length && tokens[i] !== "break") {
      seg.push(tokens[i] as AtToken);
      i += 1;
    }
    const joined = seg.map((t) => decodeXmlText(t.inner)).join("");
    const replaced = transform(joined);
    if (replaced !== joined) {
      edits.push({ start: seg[0].start, end: seg[0].end, text: `${seg[0].openTag}${encodeXmlText(replaced)}</a:t>` });
      for (let k = 1; k < seg.length; k++) {
        edits.push({ start: seg[k].start, end: seg[k].end, text: `${seg[k].openTag}</a:t>` });
      }
    }
  }
  if (!edits.length) return pXml;

  let out = "";
  let last = 0;
  for (const e of edits) {
    out += pXml.slice(last, e.start) + e.text;
    last = e.end;
  }
  return out + pXml.slice(last);
}

/**
 * The decoded text of every DrawingML `<a:p>` in `xml`, one string per paragraph
 * (an `<a:br/>` contributes a newline so no placeholder spans it). Scan-side
 * counterpart to {@link rewriteDrawingText}.
 */
export function collectDrawingTexts(xml: string): string[] {
  if (!xml.includes("<a:t")) return [];
  const texts: string[] = [];
  for (const pMatch of xml.matchAll(A_P_RE)) {
    let out = "";
    A_TEXT_OR_BREAK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = A_TEXT_OR_BREAK_RE.exec(pMatch[0])) !== null) {
      out += m[2] !== undefined ? decodeXmlText(m[2]) : "\n";
    }
    if (out) texts.push(out);
  }
  return texts;
}
