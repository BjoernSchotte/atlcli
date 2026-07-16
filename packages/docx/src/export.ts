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

/**
 * Wall-clock durations of the export's (deliberately overlapping) phases —
 * `resolveMs` + `bodyMs` + `logoFetchMs` typically exceed `durationMs`
 * because they run concurrently. The seam aggregates (`imageFetchMs`,
 * `diagramRenderMs`, `diagramRasterMs`) are SUMS across calls. Surfaced as a
 * report note so a slow export names its slow leg.
 */
export interface ExportTimings {
  resolveMs: number;
  bodyMs: number;
  logoFetchMs: number;
  renderMs: number;
  imageFetchMs: number;
  imageFetches: number;
  diagramRenderMs: number;
  diagramRasterMs: number;
}

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
  /** Per-phase wall clocks (overlapping) + seam aggregates. */
  timings: ExportTimings;
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
  const timings: ExportTimings = {
    resolveMs: 0,
    bodyMs: 0,
    logoFetchMs: 0,
    renderMs: 0,
    imageFetchMs: 0,
    imageFetches: 0,
    diagramRenderMs: 0,
    diagramRasterMs: 0,
  };

  const zip = unzipDocx(input.templateBytes);
  const scan = scanZip(zip);

  // 1. Resolve non-content placeholders (lazy fetch driven by the used set).
  //    STARTED here, awaited only when the values are needed (step 4): the
  //    resolver's round-trips run concurrently with body serialization and
  //    the logo fetch below instead of gating them (perf finding: the
  //    sequential flow paid every network latency back to back).
  const usedRaw = [...scan.supported, ...scan.unsupported, ...scan.never].flatMap((h) => h.raw);
  const resolvedPromise = resolvePlaceholders(usedRaw, { details: input.details, template: input.template, exportDate }, input.deps).then(
    (r) => {
      timings.resolveMs = Date.now() - start;
      return r;
    }
  );

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
  const images = embedder && wantImages ? imageSeam(embedder, input.assets!, input.details.id, timings) : undefined;
  const diagrams =
    embedder && input.rasterizer
      ? diagramSeam(embedder, input.rasterizer, input.diagramTheme, timings)
      : undefined;

  // Logo pass, fetch leg (spec 005, gap G3): the template scan + space-logo
  // byte fetch start NOW so the (up to three-round-trip) logo chain overlaps
  // body serialization and the resolver; the archive is only touched in step
  // 3b below, in the same deterministic order as before. Never rejects.
  const logoFetch = startLogoPass(zip, {
    embedder,
    assets: input.assets,
    getSpaceLogo: input.deps?.getSpaceLogo,
    spaceKey: input.details.spaceKey,
  }).then((s) => {
    timings.logoFetchMs = Date.now() - start;
    return s;
  });

  const bodyStart = Date.now();
  const body = await serializeBlocks(blocks, { styleNames, images, diagrams });
  timings.bodyMs = Date.now() - bodyStart;

  // 3. Swap the $scroll.content paragraph for the rawxml tag paragraph. If the
  //    template has none, inject the tag before the body's final section break.
  const contentFound = injectContentTag(zip);
  const flowNotes: ExportNote[] = [];

  // 3b. Logo pass, embed leg: replace each $scroll.spacelogo /
  //     $scroll.globallogo placeholder PARAGRAPH with an inline drawing of the
  //     space logo (bytes fetched above). Runs before preprocessScrollText so
  //     a failed/skipped logo still has its token blanked there (never a
  //     literal), and before render so the drawing paragraphs pass through
  //     docxtemplater untouched.
  finishLogoPass(zip, await logoFetch, {
    embedder,
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
  const resolved = await resolvedPromise;
  preprocessScrollText(zip, resolved.values);

  // 5. Render with docxtemplater: the rawxml tag expands to the serialized body,
  //    inserted VERBATIM (the body is a DATA value, never re-parsed for tags), so
  //    literal braces / $scroll text in the page pass through unchanged. PUA
  //    delimiters guarantee the customer's own `{…}` is never a tag.
  const renderStart = Date.now();
  const rendered = renderContent(zip, body.xml);

  // 6. Synthesize the code style if the body referenced it; force TOC refresh.
  if (body.xml.includes(`w:pStyle w:val="${CODE_STYLE_ID}"`)) ensureCodeStyle(rendered);
  ensureUpdateFields(rendered);

  const bytes = rendered.generate({ type: "uint8array", compression: "DEFLATE" }) as unknown as Uint8Array;
  timings.renderMs = Date.now() - renderStart;

  const notes = [...resolved.notes, ...walkNotes, ...body.notes, ...flowNotes, timingNote(timings, Date.now() - start)];
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
      timings,
    },
  };
}

/**
 * One compact, always-present report line naming each phase's wall clock —
 * so a slow export tells the user (and us) WHICH leg was slow without any
 * extra tooling. Phases overlap by design, so they don't sum to the total.
 */
function timingNote(t: ExportTimings, totalMs: number): ExportNote {
  const parts = [
    `body ${t.bodyMs} ms` +
      (t.diagramRenderMs || t.diagramRasterMs
        ? ` (diagrams: render ${t.diagramRenderMs} ms, rasterize ${t.diagramRasterMs} ms)`
        : "") +
      (t.imageFetches ? ` (${t.imageFetches} image fetch(es): ${t.imageFetchMs} ms)` : ""),
    `placeholders ${t.resolveMs} ms`,
    ...(t.logoFetchMs ? [`logo fetch ${t.logoFetchMs} ms`] : []),
    `render+zip ${t.renderMs} ms`,
  ];
  return {
    level: "info",
    code: "perf-timing",
    message: `Timing: ${totalMs} ms total — ${parts.join(" · ")} (phases overlap).`,
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
}

interface LogoOccurrence {
  part: string;
  paragraph: string;
  /** The raw token (carries the `.(H,W)` size args). */
  raw: string;
  base: string;
}

/** Outcome of the logo FETCH leg, consumed by {@link finishLogoPass}. */
interface LogoPassState {
  occurrences: LogoOccurrence[];
  /** Distinct bases used, sorted (drives per-base skip notes). */
  bases: string[];
  outcome:
    | { kind: "skip"; message: string; level: "info" | "warning" }
    | { kind: "bytes"; bytes: Uint8Array };
}

/**
 * Logo pass (spec 005, gap G3), FETCH leg: scan the template parts for
 * `$scroll.spacelogo` / `$scroll.globallogo` placeholder paragraphs and — when
 * any exist — fetch the space-logo bytes. The space-logo round-trip stays lazy
 * (it fires only when a template actually uses a logo placeholder), but the
 * returned promise is started EARLY by the caller so the chain (icon lookup →
 * asset fetch) overlaps the export's other work. Touches nothing in the zip
 * and never rejects; every failure becomes a `skip` outcome that
 * {@link finishLogoPass} turns into the same notes as before.
 */
async function startLogoPass(zip: PizZip, input: LogoPassInput): Promise<LogoPassState | null> {
  const { embedder, assets, getSpaceLogo, spaceKey } = input;

  const occurrences: LogoOccurrence[] = [];
  for (const part of documentPartNames(zip)) {
    const xml = zip.file(part)?.asText() ?? "";
    if (!xml.includes("$scroll.spacelogo") && !xml.includes("$scroll.globallogo")) continue;
    for (const para of splitParagraphs(xml)) {
      const m = paragraphText(para).match(LOGO_TOKEN_RE);
      if (m) occurrences.push({ part, paragraph: para, raw: m[0], base: `$scroll.${m[1]}` });
    }
  }
  if (occurrences.length === 0) return null;

  const bases = [...new Set(occurrences.map((o) => o.base))].sort();
  const state = (outcome: LogoPassState["outcome"]): LogoPassState => ({ occurrences, bases, outcome });
  const skip = (message: string, level: "info" | "warning" = "warning"): LogoPassState =>
    state({ kind: "skip", message, level });

  if (!embedder || !assets) {
    return skip("image embedding is off or no asset fetcher is available; rendered empty.", "info");
  }
  if (!getSpaceLogo) return skip("no space-logo fetcher is available; rendered empty.");
  if (!spaceKey) return skip("the page has no space key; rendered empty.");

  try {
    const ref = await getSpaceLogo(spaceKey);
    if (!ref) return skip(`space "${spaceKey}" has no logo; rendered empty.`, "info");
    return state({ kind: "bytes", bytes: await assets.fetch(ref) });
  } catch (err) {
    return skip(
      `the space logo could not be fetched (${err instanceof Error ? err.message : String(err)}); rendered empty.`
    );
  }
}

/**
 * Logo pass, EMBED leg: replace each `$scroll.spacelogo` / `$scroll.globallogo`
 * placeholder paragraph with an inline `<w:drawing>` of the space logo, across
 * the main story and all header/footer parts (the embedder writes the
 * `r:embed` relationship into each part's own rels).
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
function finishLogoPass(
  zip: PizZip,
  fetched: LogoPassState | null,
  input: { embedder?: ImageEmbedder; spaceKey?: string; notes: ExportNote[] }
): void {
  if (!fetched) return;
  const { embedder, spaceKey, notes } = input;
  const { occurrences, bases, outcome } = fetched;

  if (outcome.kind === "skip") {
    for (const base of bases) {
      notes.push({
        level: outcome.level,
        code: "logo-skipped",
        message: `${base} was not embedded: ${outcome.message}`,
      });
    }
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
      const drawing = embedder!.embed(outcome.bytes, {
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
 * How many asset fetches may be in flight at once. 6 is the classic
 * per-origin browser cap for HTTP/1.1 connections, safe in every host shape
 * (CLI, extension panel, a future Tauri webview) and gentle on the
 * Confluence API; HTTP/2 hosts simply multiplex the six.
 */
const ASSET_FETCH_CONCURRENCY = 6;

/** Minimal promise pool: run `fn`s with at most `max` concurrently in flight. */
function pLimit(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const release = (): void => {
    active -= 1;
    queue.shift()?.();
  };
  return <T,>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = (): void => {
        active += 1;
        // Promise.resolve().then(fn) also routes a SYNCHRONOUSLY-throwing fn
        // into the rejection path — a bare fn() call would skip release() and
        // leak the slot (six such failures would deadlock the queue).
        Promise.resolve()
          .then(fn)
          .then(
            (v) => {
              release();
              resolve(v);
            },
            (e) => {
              release();
              reject(e);
            }
          );
      };
      if (active < max) run();
      else queue.push(run);
    });
}

/**
 * Bridge the serializer's {@link ImageEmbedSeam} to the host's
 * {@link AssetFetcher} + the OOXML {@link ImageEmbedder}: resolve the block's
 * source to an {@link AssetRef}, fetch the bytes, embed. EVERY throw —
 * fetch, decode, oversized — funnels into `{ok:false}` so the serializer
 * writes a report line and the export always succeeds; the embedder writes
 * nothing to the archive unless it returns a fragment, so a failure never
 * leaves a dangling media part or relationship.
 *
 * Fetches are started by the serializer's prefetch pass and pooled at
 * {@link ASSET_FETCH_CONCURRENCY}, so N images cost ~1 network latency
 * instead of N; embedding (and thus relationship-id allocation) still
 * happens in document order through {@link ImageEmbedSeam.embed}.
 */
function imageSeam(
  embedder: ImageEmbedder,
  assets: AssetFetcher,
  pageId: string,
  timings: ExportTimings
): ImageEmbedSeam {
  const limit = pLimit(ASSET_FETCH_CONCURRENCY);
  // Keyed by the CANONICAL asset URL, not block identity: a page that shows
  // the same attachment twice downloads it once (the embedder already
  // deduplicates the media part; this deduplicates the network fetch).
  const fetches = new Map<string, Promise<Uint8Array>>();
  const fetchBytes = (block: ImageBlock): Promise<Uint8Array> => {
    const ref = assetRefFor(block, pageId);
    let p = fetches.get(ref.url);
    if (!p) {
      p = limit(async () => {
        const t = Date.now();
        try {
          return await assets.fetch(ref);
        } finally {
          timings.imageFetches += 1;
          timings.imageFetchMs += Date.now() - t;
        }
      });
      // The prefetch caller never awaits; without this consumed branch a
      // fetch failing before embed() awaits it would surface as an
      // unhandled rejection. embed() awaits the ORIGINAL promise and still
      // sees the real error.
      p.catch(() => {});
      fetches.set(ref.url, p);
    }
    return p;
  };
  return {
    prefetch(block: ImageBlock) {
      void fetchBytes(block);
    },
    async embed(block: ImageBlock) {
      try {
        const bytes = await fetchBytes(block);
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
  theme: DiagramTheme | undefined,
  timings: ExportTimings
): DiagramEmbedSeam {
  let count = 0;
  // Render + rasterize results, keyed by exact source: the serializer's prefetch
  // pass starts this CPU/async work up front so it overlaps the export's
  // network round-trips; embed() then consumes the in-flight result in
  // document order. Repeated occurrences of the same source share preparation
  // (theme + rasterizer are seam-wide), while each occurrence still embeds in
  // document order and receives its own drawing id. The preparation never
  // rejects — every failure is a value — so an unawaited prefetch can't surface
  // an unhandled rejection.
  type DiagramPrep =
    | { kind: "ready"; svg: string; png: Uint8Array; widthPx: number; heightPx: number }
    | { kind: "unsupported"; diagramType: string }
    | { kind: "failed"; reason: string };
  const preps = new Map<string, Promise<DiagramPrep>>();
  // Preparations are CHAINED, not fanned out: render + rasterize are
  // main-thread CPU work in every host (beautiful-mermaid is synchronous;
  // the panel's canvas rasterizer and the CLI's resvg-wasm both burn the
  // one JS thread), so running six at once cannot finish sooner — but it
  // CAN thrash (observed in the extension panel: six concurrent canvas
  // rasterizations took seconds each instead of tens of ms). The chain
  // still starts at prefetch time, so diagram CPU overlaps the export's
  // network round-trips exactly as before.
  let chain: Promise<unknown> = Promise.resolve();
  const prepare = (block: CodeBlock): Promise<DiagramPrep> => {
    const key = block.code;
    let p = preps.get(key);
    if (!p) {
      const work = async (): Promise<DiagramPrep> => {
        const renderStart = Date.now();
        const rendered = await renderDiagram(block.code, theme);
        timings.diagramRenderMs += Date.now() - renderStart;
        if (rendered.kind === "unsupported") {
          return { kind: "unsupported", diagramType: rendered.diagramType };
        }
        if (rendered.kind === "failed") return { kind: "failed", reason: rendered.reason };
        try {
          const rasterStart = Date.now();
          const png = await rasterizer.rasterize(rendered.svg, {
            widthPx: rendered.widthPx * 2,
            heightPx: rendered.heightPx * 2,
          });
          timings.diagramRasterMs += Date.now() - rasterStart;
          return {
            kind: "ready",
            svg: rendered.svg,
            png,
            widthPx: rendered.widthPx,
            heightPx: rendered.heightPx,
          };
        } catch (err) {
          return { kind: "failed", reason: err instanceof Error ? err.message : String(err) };
        }
      };
      p = chain.then(work);
      chain = p;
      preps.set(key, p);
    }
    return p;
  };
  return {
    prefetch(block: CodeBlock) {
      void prepare(block);
    },
    async embed(block: CodeBlock) {
      const prep = await prepare(block);
      if (prep.kind === "unsupported") {
        return { ok: false as const, route: "unsupported" as const, diagramType: prep.diagramType };
      }
      if (prep.kind === "failed") {
        return { ok: false as const, route: "failed" as const, reason: prep.reason };
      }
      try {
        count += 1;
        const xml = embedder.embedSvg(prep.svg, prep.png, {
          name: `Mermaid diagram ${count}`,
          // Accessibility (spec 005a Task 3): the diagram SOURCE is the
          // best available description of the drawing.
          alt: block.code,
          widthPx: prep.widthPx,
          heightPx: prep.heightPx,
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
