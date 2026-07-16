/**
 * DOCX export orchestration (spec 004 Task 5 / PLAN §2.3–2.5).
 *
 * Ties the pieces together into one browser-side flow:
 *   1. unzip the customer template (PizZip);
 *   2. scan its `$scroll.*` placeholders (reused classification);
 *   3. resolve non-content placeholders (lazy space/user fetch);
 *   4. walk the page storage → ExportBlock[] → OOXML body;
 *   5. swap the `$scroll.content` paragraph for a docxtemplater rawxml tag
 *      paragraph (`@scrollContent`, written with Private-Use-Area delimiters);
 *   6. preprocess the remaining `$scroll.*` text (run-normalized) across
 *      document + header/footer parts of the TEMPLATE — NEVER leaving a literal,
 *      and never touching the page body (which is not injected yet);
 *   7. render with docxtemplater: the engine expands the rawxml tag, inserting
 *      the serialized body VERBATIM — the page body is a DATA value, never
 *      re-parsed for tags, so literal braces and `$scroll.*` examples in the page
 *      survive (findings #7/#11);
 *   8. synthesize the code style, set `w:updateFields` so the TOC repaginates;
 *   9. emit bytes + a structured {@link ExportReport}.
 *
 * **Engine (PLAN Decision F1, Option A):** docxtemplater free is the rendering
 * engine, configured with Private-Use-Area delimiters (U+E000 … U+E001) instead
 * of the default `{…}`. docxtemplater always scans the whole document for its
 * delimiter pair; a PUA pair cannot occur in any real Word template or in
 * customer page content, so the customer template's literal `{`, `}`, `{foo}`
 * are NEVER treated as tags — never parsed, never mutated, never throw (finding
 * #11). Only our own injected `@scrollContent` tag is a tag, and its value (the
 * page body OOXML) is inserted through the free-tier rawxml module WITHOUT
 * re-parsing, so page-authored `$scroll.*` / braces pass through verbatim
 * (finding #7). Non-content `$scroll.*` placeholders are resolved to text on the
 * template parts BEFORE render (engine-agnostic run-normalized preprocessor,
 * findings #8/#9). Images embed through the self-built OOXML image module
 * (spec 005) when the host supplies an {@link AssetFetcher}; a missing fetcher
 * or a failed fetch/decode degrades to a report line, never a dangling
 * relationship (the 004-F3 skip-path invariant holds on every failure branch).
 */
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { storageToBlocks, type ConfluencePageDetails, type ExportNote } from "@atlcli/confluence";
import { documentPartNames, PLACEHOLDER_RE, scanZip, unzipDocx, type ScanResult } from "./scan.js";
import {
  resolvePlaceholders,
  type CurrentUser,
  type ResolveDeps,
  type TemplateMeta,
} from "./resolver.js";
import {
  serializeBlocks,
  type CodeBlock,
  type DiagramEmbedSeam,
  type ImageBlock,
  type ImageEmbedSeam,
} from "./serialize.js";
import { ImageEmbedder, ImageEmbedError } from "./image.js";
import { renderDiagram, type DiagramTheme } from "@atlcli/diagram";
import { parseLogoArgs } from "./placeholder-map.js";
import type { AssetFetcher, AssetRef, SvgRasterizer } from "./env.js";
import { CODE_STYLE_ID, codeStyleXml, parseStyleNames } from "./ooxml.js";
import {
  encodeXmlText,
  paragraphText,
  rewriteScrollText,
  splitParagraphs,
} from "./ooxml-text.js";

export interface ExportReport {
  /** Placeholders resolved to a non-empty value. */
  resolvedCount: number;
  /** Distinct unsupported/never placeholder bases (rendered empty). */
  unsupportedNames: string[];
  /** Number of images skipped (no fetcher, disabled, or embed failure). */
  skippedImages: number;
  /** Number of images embedded into the document (spec 005). */
  embeddedImages: number;
  /** Number of mermaid diagrams rendered + embedded as svgBlip/PNG (spec 005a). */
  renderedDiagrams: number;
  /** Wall-clock export duration in milliseconds. */
  durationMs: number;
  /** Suggested download filename (`<page-title>.docx`). */
  filename: string;
  /** All non-fatal notes (resolver + serializer + flow). */
  notes: ExportNote[];
  /** The template scan (reused classification), for the panel. */
  scan: ScanResult;
}

export interface ExportResult {
  bytes: Uint8Array;
  report: ExportReport;
}

export interface ExportInput {
  templateBytes: Uint8Array;
  details: ConfluencePageDetails;
  template: TemplateMeta;
  exportDate?: Date;
  deps?: ResolveDeps;
  /**
   * How image bytes are fetched (spec 005). Absent → every image degrades to
   * a report note, exactly the pre-005 behavior.
   */
  assets?: AssetFetcher;
  /**
   * Set `false` to skip image embedding even when `assets` is available
   * (the CLI's `--no-images`). Defaults to `true`.
   */
  embedImages?: boolean;
  /**
   * SVG → PNG rasterization (spec 005a). When present, mermaid code blocks
   * render to svgBlip + PNG@2x drawings; absent → they stay source code
   * blocks with a report note. Independent of `embedImages`, which governs
   * page ATTACHMENT images.
   */
  rasterizer?: SvgRasterizer;
  /**
   * Diagram brand colors (spec 005a Task 4). Defaults to the neutral
   * zinc-light theme matching the export's code blocks and body text.
   */
  diagramTheme?: DiagramTheme;
}

/**
 * docxtemplater delimiter pair from the Unicode Private Use Area (U+E000,
 * U+E001), built from code points so no control byte lives in this source. These
 * code points are reserved for private agreement and carry no character
 * semantics, so they cannot appear in a real Word template or in customer page
 * content. docxtemplater scans the whole document for exactly this pair, so with
 * a PUA pair the customer's literal `{`, `}`, `{foo}` (and guillemets `«…»`,
 * which appear in real German/French prose) are never delimiters — never parsed,
 * never mutated, never throw (finding #11).
 */
const DELIM_START = String.fromCodePoint(0xe000);
const DELIM_END = String.fromCodePoint(0xe001);

/** The rawxml data key whose value is the serialized page body OOXML. */
const CONTENT_KEY = "scrollContent";

/**
 * The paragraph we swap in for `$scroll.content` before render. Its ONLY text is
 * the docxtemplater rawxml tag `@scrollContent` (delimited with the PUA pair);
 * the free-tier rawxml module requires a raw tag to be the sole content of its
 * paragraph, and expands the WHOLE paragraph to the tag's value — so the
 * serialized body replaces this placeholder paragraph cleanly. It contains no
 * `$scroll` text, so the `$scroll.*` preprocessor leaves it untouched.
 */
const CONTENT_TAG_PARA =
  `<w:p><w:r><w:t xml:space="preserve">${DELIM_START}@${CONTENT_KEY}${DELIM_END}</w:t></w:r></w:p>`;

/**
 * Thrown when docxtemplater cannot render the (delimiter-swapped) template.
 * With PUA delimiters this is not expected — the customer's own text is never a
 * tag — but a residual malformed input is classified specifically here rather
 * than surfacing as a generic "Export failed" (second half of finding #11). The
 * caller can present the structured `details` instead of a bare message.
 */
export class DocxRenderError extends Error {
  constructor(
    message: string,
    readonly details: string[]
  ) {
    super(message);
    this.name = "DocxRenderError";
  }
}

/** Turn a page title into a safe `.docx` filename. */
export function toDownloadFilename(title: string): string {
  const base = (title || "export").replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim();
  return `${base || "export"}.docx`;
}

/**
 * Run the full export. Returns the `.docx` bytes and a report.
 * Throws {@link import("./scan.js").DocxError} on a truly fatal template problem
 * (an unreadable / non-Word zip from {@link unzipDocx}), or {@link
 * DocxRenderError} if docxtemplater cannot render the delimiter-swapped template
 * (not expected with PUA delimiters). The customer template's own text is never
 * scanned with `{…}`, so literal braces / `$scroll.*` examples can't cause a
 * parse error.
 */
export async function exportDocx(input: ExportInput): Promise<ExportResult> {
  const start = Date.now();
  const exportDate = input.exportDate ?? new Date();

  const zip = unzipDocx(input.templateBytes);
  const scan = scanZip(zip);

  // 1. Resolve non-content placeholders (lazy fetch driven by the used set).
  const usedRaw = [...scan.supported, ...scan.unsupported, ...scan.never].flatMap((h) => h.raw);
  const resolved = await resolvePlaceholders(usedRaw, { details: input.details, template: input.template, exportDate }, input.deps);

  // 2. Storage → blocks → OOXML body. When the host supplied an asset fetcher
  //    (and images aren't disabled), the serializer's image seam embeds each
  //    image into THIS zip (media + rel + content type) before render — the
  //    rendered rawxml body then references relationships that already exist.
  const { blocks, notes: walkNotes } = storageToBlocks(input.details.storage ?? "");
  const styleNames = parseStyleNames(zip.file("word/styles.xml")?.asText() ?? "");
  // One embedder per export owns the unique-id counters for images AND
  // diagrams (spec 005a: "unique element ids reused from 005 — no collisions
  // with page images"). Attachment images additionally need an asset fetcher;
  // diagrams additionally need a rasterizer — each seam exists independently.
  const wantImages = Boolean(input.assets) && input.embedImages !== false;
  const embedder = wantImages || input.rasterizer ? new ImageEmbedder(zip) : undefined;
  const images = embedder && wantImages ? imageSeam(embedder, input.assets!, input.details.id) : undefined;
  const diagrams =
    embedder && input.rasterizer
      ? diagramSeam(embedder, input.rasterizer, input.diagramTheme)
      : undefined;
  const body = await serializeBlocks(blocks, { styleNames, images, diagrams });

  // 3. Swap the $scroll.content paragraph for the rawxml tag paragraph. If the
  //    template has none, inject the tag before the body's final section break.
  const contentFound = injectContentTag(zip);
  const flowNotes: ExportNote[] = [];

  // 3b. Logo pass (spec 005, gap G3): replace each $scroll.spacelogo /
  //     $scroll.globallogo placeholder PARAGRAPH with an inline drawing of the
  //     space logo. Runs before preprocessScrollText so a failed/skipped logo
  //     still has its token blanked there (never a literal), and before render
  //     so the drawing paragraphs pass through docxtemplater untouched.
  await embedLogoPlaceholders(zip, {
    embedder,
    assets: input.assets,
    getSpaceLogo: input.deps?.getSpaceLogo,
    spaceKey: input.details.spaceKey,
    notes: flowNotes,
  });

  if (!contentFound) {
    injectContentTagAtEnd(zip);
    flowNotes.push({
      level: "info",
      code: "no-content-placeholder",
      message: "Template had no $scroll.content; page body was inserted before the final section break.",
    });
  }

  // 4. Resolve remaining $scroll.* text across the TEMPLATE parts (the page body
  //    is NOT injected yet — so page-authored $scroll.* examples can't be hit).
  //    Runs before render so the engine only ever sees resolved text + the one
  //    rawxml tag.
  preprocessScrollText(zip, resolved.values);

  // 5. Render with docxtemplater: the rawxml tag expands to the serialized body,
  //    inserted VERBATIM (the body is a DATA value, never re-parsed for tags), so
  //    literal braces / $scroll text in the page pass through unchanged. PUA
  //    delimiters guarantee the customer's own `{…}` is never a tag.
  const rendered = renderContent(zip, body.xml);

  // 6. Synthesize the code style if the body referenced it; force TOC refresh.
  if (body.xml.includes(`w:pStyle w:val="${CODE_STYLE_ID}"`)) ensureCodeStyle(rendered);
  ensureUpdateFields(rendered);

  const bytes = rendered.generate({ type: "uint8array", compression: "DEFLATE" }) as unknown as Uint8Array;

  const notes = [...resolved.notes, ...walkNotes, ...body.notes, ...flowNotes];
  // Every image-skip note kind counts toward the report's skipped-image total:
  // serializer `image-skipped`/`image-embed-failed`, walker `image-unresolved`
  // and `inline-image-skipped`.
  const skippedImages = notes.filter((n) => IMAGE_SKIP_CODES.has(n.code)).length;

  return {
    bytes,
    report: {
      resolvedCount: resolved.resolvedCount,
      unsupportedNames: resolved.unsupportedNames,
      skippedImages,
      embeddedImages: embedder?.embeddedCount ?? 0,
      renderedDiagrams: embedder?.diagramCount ?? 0,
      durationMs: Date.now() - start,
      filename: toDownloadFilename(input.details.title),
      notes,
      scan,
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the template with docxtemplater (PUA delimiters) so the `@scrollContent`
 * rawxml tag expands to `bodyXml`. Returns the rendered PizZip archive for
 * follow-up surgery (code style, updateFields). Any docxtemplater failure is
 * re-thrown as a {@link DocxRenderError} carrying the engine's structured
 * explanation, so the caller never sees a generic "Export failed".
 */
function renderContent(zip: PizZip, bodyXml: string): PizZip {
  let doc: Docxtemplater<PizZip>;
  try {
    doc = new Docxtemplater<PizZip>(zip, {
      delimiters: { start: DELIM_START, end: DELIM_END },
      paragraphLoop: true,
      linebreaks: true,
      // Suppress docxtemplater's internal console.error on a template error; we
      // classify and surface it via DocxRenderError instead (engine-decision.md
      // notes the cosmetic console noise).
      errorLogging: false,
    });
    doc.render({ [CONTENT_KEY]: bodyXml });
  } catch (err) {
    throw new DocxRenderError(
      "The Word template could not be rendered.",
      explainDocxError(err)
    );
  }
  return doc.getZip();
}

interface DocxErrorLike {
  message?: string;
  properties?: {
    explanation?: string;
    errors?: DocxErrorLike[];
  };
}

/**
 * Flatten a docxtemplater error into human-readable lines. A multi-error
 * `TemplateError` carries `properties.errors[]` (each with its own
 * `properties.explanation`); a single error carries `properties.explanation`
 * directly; a plain Error just yields its message.
 */
function explainDocxError(err: unknown): string[] {
  const e = err as DocxErrorLike;
  const nested = e.properties?.errors;
  if (nested?.length) {
    return nested.map((n) => n.properties?.explanation ?? n.message ?? "unknown template error");
  }
  const explanation = e.properties?.explanation;
  if (explanation) return [explanation];
  return [err instanceof Error ? err.message : String(err)];
}

// ---------------------------------------------------------------------------
// Zip surgery
// ---------------------------------------------------------------------------

/** Note kinds that mean "an image was not embedded" (for the report tally). */
const IMAGE_SKIP_CODES = new Set([
  "image-skipped",
  "image-embed-failed",
  "image-unresolved",
  "inline-image-skipped",
  "logo-skipped",
  "logo-embed-failed",
]);

// ---------------------------------------------------------------------------
// Logo pass (spec 005, gap G3)
// ---------------------------------------------------------------------------

/** One logo token, matching the shared PLACEHOLDER_RE grammar for these bases. */
const LOGO_TOKEN_RE = /\$scroll\.(spacelogo|globallogo)(?:\.?\([^)]*\))?/;

interface LogoPassInput {
  embedder?: ImageEmbedder;
  assets?: AssetFetcher;
  getSpaceLogo?: (spaceKey: string) => Promise<AssetRef | null>;
  spaceKey?: string;
  notes: ExportNote[];
}

interface LogoOccurrence {
  part: string;
  paragraph: string;
  /** The raw token (carries the `.(H,W)` size args). */
  raw: string;
  base: string;
}

/**
 * Replace each `$scroll.spacelogo` / `$scroll.globallogo` placeholder
 * paragraph with an inline `<w:drawing>` of the space logo, across the main
 * story and all header/footer parts (the embedder writes the `r:embed`
 * relationship into each part's own rels).
 *
 * Both bases resolve to the SPACE logo (`GET /space/{key}?expand=icon`):
 * Confluence Cloud exposes no separately fetchable global logo, so
 * `$scroll.globallogo` degrades to the space logo with an info note rather
 * than to nothing. The whole placeholder paragraph is replaced (mirroring the
 * `$scroll.content` contract), preserving its `<w:pPr>` so alignment survives;
 * any other text in that paragraph is dropped.
 *
 * Every failure branch — no fetcher, no dep, no space key, fetch error,
 * undecodable bytes (the Cloud DEFAULT space logo is an SVG, which spec 005
 * defers) — leaves the token in place for {@link preprocessScrollText} to
 * blank, and adds a note whose code counts toward `skippedImages`. The
 * embedder writes nothing on failure, so no dangling media part or
 * relationship survives (the 004-F3 invariant).
 */
async function embedLogoPlaceholders(zip: PizZip, input: LogoPassInput): Promise<void> {
  const { embedder, assets, getSpaceLogo, spaceKey, notes } = input;

  // Collect occurrences first: the space-logo round-trip stays lazy (it fires
  // only when a template actually uses a logo placeholder).
  const occurrences: LogoOccurrence[] = [];
  for (const part of documentPartNames(zip)) {
    const xml = zip.file(part)?.asText() ?? "";
    if (!xml.includes("$scroll.spacelogo") && !xml.includes("$scroll.globallogo")) continue;
    for (const para of splitParagraphs(xml)) {
      const m = paragraphText(para).match(LOGO_TOKEN_RE);
      if (m) occurrences.push({ part, paragraph: para, raw: m[0], base: `$scroll.${m[1]}` });
    }
  }
  if (occurrences.length === 0) return;

  const bases = [...new Set(occurrences.map((o) => o.base))].sort();
  const skipAll = (message: string, level: "info" | "warning" = "warning"): void => {
    for (const base of bases) {
      notes.push({ level, code: "logo-skipped", message: `${base} was not embedded: ${message}` });
    }
  };

  if (!embedder || !assets) {
    skipAll("image embedding is off or no asset fetcher is available; rendered empty.", "info");
    return;
  }
  if (!getSpaceLogo) {
    skipAll("no space-logo fetcher is available; rendered empty.");
    return;
  }
  if (!spaceKey) {
    skipAll("the page has no space key; rendered empty.");
    return;
  }

  let bytes: Uint8Array;
  try {
    const ref = await getSpaceLogo(spaceKey);
    if (!ref) {
      skipAll(`space "${spaceKey}" has no logo; rendered empty.`, "info");
      return;
    }
    bytes = await assets.fetch(ref);
  } catch (err) {
    skipAll(
      `the space logo could not be fetched (${err instanceof Error ? err.message : String(err)}); rendered empty.`
    );
    return;
  }

  if (bases.includes("$scroll.globallogo")) {
    notes.push({
      level: "info",
      code: "placeholder-substituted",
      message:
        "$scroll.globallogo resolved to the space logo — Confluence Cloud has no separately fetchable global logo.",
    });
  }

  for (const occ of occurrences) {
    const xml = zip.file(occ.part)?.asText() ?? "";
    if (!xml.includes(occ.paragraph)) continue; // already replaced (identical paragraph)
    const args = parseLogoArgs(occ.raw);
    try {
      const drawing = embedder.embed(bytes, {
        name: occ.base === "$scroll.globallogo" ? "Global logo" : "Space logo",
        alt: `${spaceKey} space logo`,
        heightPx: args.heightPx,
        widthPx: args.widthPx,
        partPath: occ.part,
        pPrXml: occ.paragraph.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0],
      });
      zip.file(occ.part, xml.replace(occ.paragraph, drawing));
    } catch (err) {
      notes.push({
        level: "warning",
        code: "logo-embed-failed",
        message:
          `${occ.base} could not be embedded` +
          `${err instanceof ImageEmbedError ? ` (${err.message})` : ""}; rendered empty.`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Image seam (spec 005)
// ---------------------------------------------------------------------------

/**
 * Bridge the serializer's {@link ImageEmbedSeam} to the host's
 * {@link AssetFetcher} + the OOXML {@link ImageEmbedder}: resolve the block's
 * source to an {@link AssetRef}, fetch the bytes, embed. EVERY throw —
 * fetch, decode, oversized — funnels into `{ok:false}` so the serializer
 * writes a report line and the export always succeeds; the embedder writes
 * nothing to the archive unless it returns a fragment, so a failure never
 * leaves a dangling media part or relationship.
 */
function imageSeam(embedder: ImageEmbedder, assets: AssetFetcher, pageId: string): ImageEmbedSeam {
  return {
    async embed(block: ImageBlock) {
      try {
        const bytes = await assets.fetch(assetRefFor(block, pageId));
        const name = block.source.kind === "attachment" ? block.source.filename : undefined;
        const xml = embedder.embed(bytes, {
          alt: block.alt,
          name,
          widthPx: block.width,
          heightPx: block.height,
        });
        return { ok: true as const, xml };
      } catch (err) {
        return { ok: false as const, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Diagram seam (spec 005a)
// ---------------------------------------------------------------------------

/**
 * Bridge the serializer's {@link DiagramEmbedSeam} to the mermaid renderer,
 * the host's {@link SvgRasterizer} and the OOXML embedder: render the source
 * to a themed SVG, rasterize the mandatory PNG fallback at 2× the intrinsic
 * size, embed both through one `<a:blip>` (svgBlip + raster). Failure on ANY
 * leg — render, rasterize, embed — funnels into a non-ok outcome so the
 * serializer takes the pinned code-block route; the embedder writes nothing
 * to the archive unless it returns a fragment, so no failure leaves a
 * dangling media part or relationship (the 004-F3 invariant).
 */
function diagramSeam(
  embedder: ImageEmbedder,
  rasterizer: SvgRasterizer,
  theme: DiagramTheme | undefined
): DiagramEmbedSeam {
  let count = 0;
  return {
    async embed(block: CodeBlock) {
      const rendered = await renderDiagram(block.code, theme);
      if (rendered.kind === "unsupported") {
        return { ok: false as const, route: "unsupported" as const, diagramType: rendered.diagramType };
      }
      if (rendered.kind === "failed") {
        return { ok: false as const, route: "failed" as const, reason: rendered.reason };
      }
      try {
        const png = await rasterizer.rasterize(rendered.svg, {
          widthPx: rendered.widthPx * 2,
          heightPx: rendered.heightPx * 2,
        });
        count += 1;
        const xml = embedder.embedSvg(rendered.svg, png, {
          name: `Mermaid diagram ${count}`,
          // Accessibility (spec 005a Task 3): the diagram SOURCE is the
          // best available description of the drawing.
          alt: block.code,
          widthPx: rendered.widthPx,
          heightPx: rendered.heightPx,
        });
        return { ok: true as const, xml };
      } catch (err) {
        return {
          ok: false as const,
          route: "failed" as const,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

/**
 * The {@link AssetRef} for an image block. Attachments use Confluence's
 * canonical download path, RELATIVE to the wiki base (`/wiki` on Cloud) —
 * exactly the shape the API's own `downloadUrl` uses, so a token host can
 * feed it straight to its binary-request helper and a session host prefixes
 * its wiki base. External images pass their absolute URL through.
 */
function assetRefFor(block: ImageBlock, pageId: string): AssetRef {
  if (block.source.kind === "attachment") {
    return {
      url: `/download/attachments/${encodeURIComponent(pageId)}/${encodeURIComponent(block.source.filename)}`,
      pageId,
      filename: block.source.filename,
    };
  }
  return { url: block.source.url, pageId };
}

/** Replace the paragraph containing `$scroll.content` with the rawxml tag. */
function injectContentTag(zip: PizZip): boolean {
  for (const part of documentPartNames(zip)) {
    const xml = zip.file(part)?.asText() ?? "";
    for (const para of splitParagraphs(xml)) {
      if (paragraphText(para).includes("$scroll.content")) {
        zip.file(part, xml.replace(para, CONTENT_TAG_PARA));
        return true;
      }
    }
  }
  return false;
}

/** Insert the rawxml tag before the body's final section break (fallback). */
function injectContentTagAtEnd(zip: PizZip): void {
  const part = "word/document.xml";
  const xml = zip.file(part)?.asText();
  if (!xml) return;
  // The body-level sectPr is the last <w:sectPr> before </w:body>.
  const bodyClose = xml.lastIndexOf("</w:body>");
  const sectPr = xml.lastIndexOf("<w:sectPr", bodyClose === -1 ? undefined : bodyClose);
  if (sectPr !== -1) {
    zip.file(part, xml.slice(0, sectPr) + CONTENT_TAG_PARA + xml.slice(sectPr));
  } else if (bodyClose !== -1) {
    zip.file(part, xml.slice(0, bodyClose) + CONTENT_TAG_PARA + xml.slice(bodyClose));
  }
}

/**
 * Replace every `$scroll.*` / `$adhocState` occurrence across the document,
 * header/footer, and chart/SmartArt-diagram parts with its resolved value (empty
 * for unsupported/never).
 *
 * {@link rewriteScrollText} run-normalizes each placeholder paragraph (merging
 * split runs), descends into text boxes (`mc:Choice` + `mc:Fallback`), replaces
 * clean `<w:t>` runs that share a paragraph with a drawing/pict run, AND resolves
 * DrawingML `<a:t>` runs (SmartArt / chart / shape text, including in the
 * separate chart/diagram parts enumerated by {@link documentPartNames}) — so a
 * title inside a cover-page text box, a `$scroll.title` run trailing a footer
 * picture, and a chart/SmartArt title are all resolved. A `$scroll.*` inside a
 * field INSTRUCTION (`w:instr` / `<w:instrText>`) is intentionally left literal:
 * it is field logic, not displayed text, and rewriting it would corrupt the
 * field (only the field's cached RESULT `<w:t>` runs resolve). Guarantees no
 * literal placeholder survives in any displayed text.
 */
export function preprocessScrollText(zip: PizZip, values: Map<string, string>): void {
  for (const part of documentPartNames(zip)) {
    const xml = zip.file(part)?.asText();
    if (!xml) continue;
    if (!xml.includes("$scroll") && !xml.includes("$adhocState")) continue;
    // Function-free replacement path: resolved values may contain `$`, so
    // rewriteScrollText splices literally rather than via String.replace.
    const rewritten = rewriteScrollText(xml, (joined) => replaceTokens(joined, values));
    if (rewritten !== xml) zip.file(part, rewritten);
  }
}

/** Replace each placeholder token in text; unknown tokens → empty (no literal). */
function replaceTokens(text: string, values: Map<string, string>): string {
  PLACEHOLDER_RE.lastIndex = 0;
  return text.replace(PLACEHOLDER_RE, (m) => values.get(m) ?? "");
}

/** Add the synthesized code paragraph style to styles.xml if absent. */
export function ensureCodeStyle(zip: PizZip): void {
  const path = "word/styles.xml";
  const xml = zip.file(path)?.asText();
  if (!xml) return;
  if (xml.includes(`w:styleId="${CODE_STYLE_ID}"`)) return;
  zip.file(path, xml.replace("</w:styles>", `${codeStyleXml()}</w:styles>`));
}

/**
 * Ensure `word/settings.xml` carries `<w:updateFields w:val="true"/>` so Word
 * offers to repaginate a TOC field on open. Creates settings.xml (+ content-type
 * + relationship) when a bare template lacks it.
 */
export function ensureUpdateFields(zip: PizZip): void {
  const path = "word/settings.xml";
  const existing = zip.file(path)?.asText();
  if (existing) {
    if (/<w:updateFields\b/.test(existing)) {
      // Normalize BOTH the self-closing (`<w:updateFields w:val="false"/>`) and
      // the paired (`<w:updateFields w:val="false"></w:updateFields>`) forms to a
      // single self-closing `true` — the paired form was previously left as-is,
      // so a template pinning the TOC to false never refreshed.
      const normalized = existing
        .replace(/<w:updateFields\b[^>]*>[\s\S]*?<\/w:updateFields>/, '<w:updateFields w:val="true"/>')
        .replace(/<w:updateFields\b[^>]*\/>/, '<w:updateFields w:val="true"/>');
      zip.file(path, normalized);
      return;
    }
    // Insert as the first child of <w:settings …>.
    const opened = existing.replace(/(<w:settings\b[^>]*>)/, '$1<w:updateFields w:val="true"/>');
    zip.file(path, opened);
    return;
  }
  // No settings.xml — synthesize one and register it.
  const settings =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:updateFields w:val="true"/></w:settings>`;
  zip.file(path, settings);
  registerSettingsPart(zip);
}

function registerSettingsPart(zip: PizZip): void {
  const ctPath = "[Content_Types].xml";
  const ct = zip.file(ctPath)?.asText();
  if (ct && !ct.includes("word/settings.xml")) {
    zip.file(
      ctPath,
      ct.replace(
        "</Types>",
        `<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>`
      )
    );
  }
  const relsPath = "word/_rels/document.xml.rels";
  const rels =
    zip.file(relsPath)?.asText() ??
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  if (!rels.includes("settings.xml")) {
    // Parse existing rIds regardless of quote style (`Id="rId1"` or `Id='rId1'`),
    // then allocate max+1 — matching only double-quoted ids could re-issue an id
    // already used with single quotes and collide.
    const ids = [...rels.matchAll(/Id=["']rId(\d+)["']/g)].map((m) => Number(m[1]));
    const rid = `rId${(ids.length ? Math.max(...ids) : 0) + 1}`;
    zip.file(
      relsPath,
      rels.replace(
        "</Relationships>",
        `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>`
      )
    );
  }
}

// Re-export for the panel/tests: keep encode local usage referenced.
export { encodeXmlText };
export type { CurrentUser };
