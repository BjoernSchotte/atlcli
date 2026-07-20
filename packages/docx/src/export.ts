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
import {
  AssetBudget,
  assertSafeSvg,
  decodeSvgSource,
  storageToBlocks,
  type ConfluencePageDetails,
  type ExportBlock,
  type ExportNote,
  type ExportProgressCallback,
} from "@atlcli/confluence";
import { resolveMacroBlocks, type MacroResolutionOptions } from "@atlcli/export-macros";
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
  type ImageEmbedOutcome,
  type ImageEmbedSeam,
} from "./serialize.js";
import {
  boundRasterTarget,
  ImageEmbedder,
  ImageEmbedError,
  isSvg,
  MAX_CONTENT_WIDTH_PX,
  parseSvgSize,
  relsPathFor,
  resolveTargetSize,
} from "./image.js";
import { renderDiagram, type DiagramTheme } from "@atlcli/diagram";
import { parseIncludePageArgs, parseLogoArgs, type IncludePageRef } from "./placeholder-map.js";
import type { IncludeLookupOutcome } from "./resolver.js";
import type { AssetFetcher, AssetRef, HostCallContext, SvgRasterizer } from "./env.js";
import {
  CAPTION_STYLE_ID,
  captionStyleXml,
  CODE_STYLE_ID,
  codeStyleXml,
  LIST_PARAGRAPH_STYLE_ID,
  listParagraphStyleXml,
  parseStyleNames,
  resolveCaptionLang,
  type CaptionLang,
  type TableStyleSource,
} from "./ooxml.js";
import { NumberingAllocator } from "./numbering.js";
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
  /** Wall clock of the cross-page include pass (fetch + walk + serialize). */
  includeFetchMs: number;
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
  /** All non-fatal notes (resolver + serializer + flow + compose/fetch). */
  notes: ExportNote[];
  /**
   * False when the composed document omitted content (partial-mode unreadable
   * pages, spec 002). Single-page/normal exports are `true`. Carried from
   * {@link ExportInput.complete}.
   */
  complete: boolean;
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
  /**
   * The ROOT page. Template placeholders (title/author/…) resolve against it.
   * In a single-page export it is also the content source; in a tree/space
   * export the content comes from {@link blocks} and this stays the root so
   * placeholders keep the existing convention (spec 002).
   */
  details: ConfluencePageDetails;
  /**
   * Pre-composed document blocks (spec 002 `composeChapters` output). When set,
   * the engine serializes THESE instead of walking `details.storage`, so a
   * multi-page tree/space export flows through the same serializer as a single
   * page. Absent → single-page behavior (walk `details.storage`).
   */
  blocks?: ExportBlock[];
  /**
   * Notes from the fetch/compose phases (tree-cycle, label-filtered, …, spec
   * 002) to surface in the report alongside the engine's own notes.
   */
  sourceNotes?: ExportNote[];
  /**
   * Whether the composed document is complete (spec 002 completeness contract).
   * Defaults to `true` (single-page/normal exports are always complete).
   */
  complete?: boolean;
  /** Abort signal threaded into asset fetches + the final emit (spec 002). */
  signal?: AbortSignal;
  /** Granular progress callback (spec 002 — asset embedding + emit phases). */
  onProgress?: ExportProgressCallback;
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
  /**
   * Caption locale for SEQ labels (spec 003 C3): `Figure`/`Table`/`Listing`
   * vs. `Abbildung`/`Tabelle`/`Listing`. Any BCP-47 language tag is accepted
   * (`de`, `de-DE`, `en_US`, …) and resolved to a shipped label set via
   * {@link resolveCaptionLang}; unsupported languages fall back to English
   * with a `caption-lang-fallback` warning note. Defaults to `"en"`.
   */
  captionLang?: string;
  /**
   * Export-control filtering mode (spec 003 C4), threaded into the walker:
   * `"apply"` (default) runs the scroll-only/scroll-ignore truth table;
   * `"passthrough"` (CLI `--keep-ignored`) keeps BOTH macro bodies for
   * debugging. Only affects the single-page walk (pre-composed `blocks`
   * carry their own walk options).
   */
  exportControls?: "apply" | "passthrough";
  /**
   * Dynamic-macro resolution (spec 004). When set, an async resolver pass runs
   * directly after `storageToBlocks` (mirroring the two-hop `assets`/`rasterizer`
   * pattern: a host can pass this on {@link ExportInput} directly, or set it on
   * {@link import("./env.js").ExportEnv} for `runExport` to thread through).
   * Absent → today's behavior byte-for-byte.
   */
  macros?: MacroResolutionOptions;
  /**
   * Table style source (spec 006 G3b / B9). `{ source: "template" }` defers
   * table appearance to the template's own table style (default name
   * `Scroll Table Normal`, or `styleId` to name another). When the named style
   * is not defined in `word/styles.xml`, the export falls back to the built-in
   * `"confluence"` grid with a report note. Absent / `{ source: "confluence" }`
   * keeps today's behavior byte-identical.
   */
  tableStyle?: { source: "template" | "confluence"; styleId?: string };
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
    includeFetchMs: 0,
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
  // Pre-composed blocks (tree/space export) bypass the single-page walk; the
  // root page's storage is only walked when no composed blocks were supplied.
  const walked = input.blocks
    ? { blocks: input.blocks, notes: [] as ExportNote[] }
    : storageToBlocks(input.details.storage ?? "", {
        exporter: "word",
        ...(input.exportControls ? { exportControls: input.exportControls } : {}),
      });
  // Dynamic-macro resolution (spec 004): staged fallback chain between the
  // walker and the serializer. Runs once on the (possibly composed) block tree.
  let blocks = walked.blocks;
  let walkNotes = walked.notes;
  if (input.macros) {
    const rootPage = {
      id: input.details.id,
      ...(input.details.version !== undefined ? { version: input.details.version } : {}),
      ...(input.details.spaceKey !== undefined ? { spaceKey: input.details.spaceKey } : {}),
    };
    const resolved = await resolveMacroBlocks(
      { blocks, notes: walkNotes },
      input.macros.registry,
      input.macros.contextFor(rootPage),
      {
        ...(input.macros.live !== undefined ? { live: input.macros.live } : {}),
        contextFor: (p) => input.macros!.contextFor(p ?? rootPage),
        targetEngine: "docx",
      }
    );
    blocks = resolved.blocks;
    walkNotes = resolved.notes;
  }
  const styleNames = parseStyleNames(zip.file("word/styles.xml")?.asText() ?? "");
  // Numbering inventory (spec 006 G2): parse the template's existing
  // word/numbering.xml maxima BEFORE body serialization so the allocator hands
  // out ids above them — acquisition happens DURING serializeBlocks, so a
  // post-render scan would be too late (see PLAN "Numbering inventory happens
  // before serialization"). A malformed part degrades to a safe zero base.
  const numbering = new NumberingAllocator(inspectNumberingPart(zip));
  // One embedder per export owns the unique-id counters for images AND
  // diagrams (spec 005a: "unique element ids reused from 005 — no collisions
  // with page images"). Attachment images additionally need an asset fetcher;
  // diagrams additionally need a rasterizer — each seam exists independently.
  const wantImages = Boolean(input.assets) && input.embedImages !== false;
  const embedder = wantImages || input.rasterizer ? new ImageEmbedder(zip) : undefined;
  // One shared asset budget per export (spec 002): total-byte cap + content
  // dedup, identical to the PDF engine. A breach is a FATAL scope-level error
  // (thrown out of the seam, aborting before any output), unlike per-image
  // decode failures which stay warnings.
  const budget = new AssetBudget();
  const imageBlockCount = wantImages ? countImageBlocks(blocks) : 0;
  const images = embedder && wantImages
    ? imageSeam(embedder, input.assets!, input.details.id, timings, {
        budget,
        signal: input.signal,
        onProgress: input.onProgress,
        total: imageBlockCount,
        ...(input.rasterizer ? { rasterizer: input.rasterizer } : {}),
      })
    : undefined;
  const diagrams =
    embedder && input.rasterizer
      ? diagramSeam(embedder, input.rasterizer, input.diagramTheme, timings, budget)
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

  // The template's body-level sectPr (portrait) is cloned into orientation
  // regions' section sandwiches (spec 003 C6); read before any zip surgery.
  const bodySectPr = readBodySectPr(zip);
  // Locale precedence (spec 003 C3): the explicit option is the only source
  // today (ExportInput has no host-locale field); unsupported tags fall back
  // to English with a warning note surfaced in the report.
  const captionLocale = resolveCaptionLang(input.captionLang);
  // Table style source (spec 006 G3b): resolve the requested template style
  // name to an id; a missing style falls back to the confluence grid + note.
  const tableStyleResolution = resolveTableStyle(input.tableStyle, styleNames);
  const bodyStart = Date.now();
  const body = await serializeBlocks(blocks, {
    styleNames,
    numbering,
    images,
    diagrams,
    ...(bodySectPr ? { bodySectPr } : {}),
    captionLang: captionLocale.lang,
    tableStyle: tableStyleResolution.tableStyle,
  });
  timings.bodyMs = Date.now() - bodyStart;

  // 3. Swap the $scroll.content paragraph for the rawxml tag paragraph. If the
  //    template has none, inject the tag before the body's final section break.
  const contentFound = injectContentTag(zip);
  const flowNotes: ExportNote[] = [];
  if (captionLocale.note) flowNotes.push(captionLocale.note);
  if (tableStyleResolution.note) flowNotes.push(tableStyleResolution.note);
  // STYLEREF verification (spec 006 G1): validate each template STYLEREF field's
  // referenced style name against the styles this export actually emitted —
  // distinguishing "style not in the template at all" from "defined but unused
  // after promotion in this export". Diagnostics only; no behavior change.
  flowNotes.push(...validateStylerefFields(scan.stylerefStyleNames, styleNames, body.headingStyleIds));

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

  // 3c. Include pass (spec 005 D1): swap each atomic `$scroll.includepage.(…)`
  //     paragraph — across body AND headers/footers — for a rawxml tag whose
  //     value is the referenced page's serialized OOXML body. Runs after the
  //     logo pass (shares the one ImageEmbedder so relationship/drawing ids
  //     never collide) and before preprocessScrollText, so any token the pass
  //     leaves in place (invalid args, fetch failure, non-atomic paragraph) is
  //     blanked there — never a literal on any path.
  const includes = await runIncludePass({
    zip,
    input,
    embedder,
    wantImages,
    assets: input.assets,
    rasterizer: input.rasterizer,
    diagramTheme: input.diagramTheme,
    budget,
    styleNames,
    captionLang: captionLocale.lang,
    timings,
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
  const rendered = renderContent(zip, body.xml, includes);

  // 5b. A page body ENDING in an orientation region leaves its region-closing
  //     sectPr paragraph directly before the template's body-level sectPr —
  //     an empty final section that renders as a spurious blank page. Merge
  //     the two: the region's sectPr BECOMES the body-level sectPr, so the
  //     document simply ends with the region (spec 003 C6 review fix).
  mergeTrailingRegionSectPr(rendered);

  // 6. Synthesize the code/caption styles if the body OR any included page
  //    referenced them; force TOC refresh. An included page can be the only
  //    thing carrying a code macro or a captioned figure (spec 005 D1).
  const includeXml = [...includes.values()].join("");
  const styledXml = body.xml + includeXml;
  if (styledXml.includes(`w:pStyle w:val="${CODE_STYLE_ID}"`)) ensureCodeStyle(rendered);
  if (styledXml.includes(`w:pStyle w:val="${CAPTION_STYLE_ID}"`)) ensureCaptionStyle(rendered);
  // Native list numbering (spec 006 G2): write word/numbering.xml (+ content
  // type + relationship) only when a list actually acquired an id, and
  // synthesize the fallback ListParagraph style if the body OR an included
  // page referenced it (an include can be the only content carrying a list).
  if (numbering.isUsed) {
    ensureNumberingPart(rendered, numbering);
    if (styledXml.includes(`w:pStyle w:val="${LIST_PARAGRAPH_STYLE_ID}"`)) ensureListParagraphStyle(rendered);
    if (numbering.capExceeded) {
      flowNotes.push({
        level: "warning",
        code: "numbering-cap-reached",
        message:
          "This document has more ordered lists than Word's 2047-instance numbering limit; the excess lists reuse a numbering definition and may not all restart at 1.",
      });
    }
  }
  ensureUpdateFields(rendered);

  const bytes = rendered.generate({ type: "uint8array", compression: "DEFLATE" }) as unknown as Uint8Array;
  timings.renderMs = Date.now() - renderStart;

  const notes = [
    ...(input.sourceNotes ?? []),
    ...resolved.notes,
    ...walkNotes,
    ...body.notes,
    ...flowNotes,
    timingNote(timings, Date.now() - start),
  ];
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
      complete: input.complete ?? true,
      scan,
      timings,
    },
  };
}

/**
 * Resolve the requested table style source (spec 006 G3b / B9) against the
 * template's styles. `"template"` mode looks up the style name (default
 * `Scroll Table Normal`) and, when defined, hands the id to the serializer;
 * when the style is absent it falls back to the built-in `"confluence"` grid
 * with a report note. `"confluence"`/absent is a byte-identical no-op.
 */
function resolveTableStyle(
  input: { source: "template" | "confluence"; styleId?: string } | undefined,
  styleNames: Map<string, string>
): { tableStyle: TableStyleSource; note?: ExportNote } {
  if (!input || input.source !== "template") return { tableStyle: { source: "confluence" } };
  const name = input.styleId ?? "Scroll Table Normal";
  const id = styleNames.get(name.toLowerCase());
  if (!id) {
    return {
      tableStyle: { source: "confluence" },
      note: {
        level: "warning",
        code: "table-style-missing",
        message: `The template does not define a "${name}" table style; tables use the built-in grid instead.`,
      },
    };
  }
  return { tableStyle: { source: "template", styleId: id } };
}

/**
 * Validate STYLEREF fields against the heading styles this export emitted
 * (spec 006 G1). Two distinct diagnostics:
 *  - `styleref-style-not-in-template` (info): the referenced style name is not
 *    defined in `word/styles.xml` at all (builtin-fallback / localized-name /
 *    typo case) — the field resolves via Word's own name lookup or blank.
 *  - `styleref-style-unused-in-export` (warning): the style IS defined but no
 *    heading in THIS export carries it (heading promotion shifted every
 *    heading's effective level), so the field resolves to the previous
 *    section's text or blank rather than the intended chapter.
 */
function validateStylerefFields(
  referencedNames: string[],
  styleNames: Map<string, string>,
  emittedHeadingStyleIds: string[]
): ExportNote[] {
  const notes: ExportNote[] = [];
  const emitted = new Set(emittedHeadingStyleIds);
  for (const name of referencedNames) {
    const id = styleNames.get(name.toLowerCase());
    if (!id) {
      notes.push({
        level: "info",
        code: "styleref-style-not-in-template",
        message: `A STYLEREF field references the style "${name}", which is not defined in the template; the running header relies on Word's own name resolution.`,
      });
    } else if (!emitted.has(id)) {
      notes.push({
        level: "warning",
        code: "styleref-style-unused-in-export",
        message: `A STYLEREF field references the style "${name}", but no heading in this export uses it (heading promotion), so the running header may show a previous chapter or be blank.`,
      });
    }
  }
  return notes;
}

/** Count `image` blocks anywhere in the tree (for asset-phase progress totals). */
function countImageBlocks(blocks: ExportBlock[]): number {
  let count = 0;
  const walk = (list: ExportBlock[]): void => {
    for (const block of list) {
      switch (block.type) {
        case "image":
          count += 1;
          break;
        case "callout":
        case "blockquote":
        case "orientation":
          walk(block.content);
          break;
        case "list":
          for (const item of block.items) walk(item.content);
          break;
        case "table":
          for (const row of block.rows) for (const cell of row.cells) walk(cell.content);
          break;
      }
    }
  };
  walk(blocks);
  return count;
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
    ...(t.includeFetchMs ? [`includes ${t.includeFetchMs} ms`] : []),
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
function renderContent(zip: PizZip, bodyXml: string, includes?: Map<string, string>): PizZip {
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
    // Each `@scrollInclude<i>` rawxml tag (spec 005 D1) expands to its included
    // page's serialized OOXML body, inserted VERBATIM alongside the page body —
    // never re-parsed for tags, so literal braces / `$scroll.*` examples inside
    // an included page survive.
    doc.render({ [CONTENT_KEY]: bodyXml, ...(includes ? Object.fromEntries(includes) : {}) });
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
  // spec 006 G4: an SVG attachment that could not be rasterized/embedded.
  "image-svg-no-rasterizer",
  "image-svg-oversized",
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
interface ImageSeamOptions {
  budget: AssetBudget;
  signal?: AbortSignal;
  onProgress?: ExportProgressCallback;
  total: number;
  /**
   * SVG → PNG rasterizer (spec 006 G4). When present, an SVG page attachment
   * embeds through the dual-part svgBlip path (SVG + 2× PNG fallback); when
   * absent, an SVG attachment degrades with `image-svg-no-rasterizer`.
   */
  rasterizer?: SvgRasterizer;
}

/** The default display size for an SVG whose intrinsic size is undeterminable. */
const SVG_FALLBACK_SIZE = { widthPx: 600, heightPx: 400 };

function imageSeam(
  embedder: ImageEmbedder,
  assets: AssetFetcher,
  pageId: string,
  timings: ExportTimings,
  seamOpts: ImageSeamOptions,
  // Which document part the serialized output lands in (spec 005 D1). Threaded
  // straight into `embed`'s `partPath` so an image embedded for an included page
  // in a header/footer writes its `r:embed` relationship into THAT part's rels
  // (`word/header1.xml.rels`, …), not the default `word/document.xml.rels` — the
  // dangling-relationship failure mode the 004-F3 invariant exists to prevent.
  // Omitted for the main body → defaults to `word/document.xml` (unchanged).
  partPath?: string
): ImageEmbedSeam {
  const { budget, signal, onProgress, total, rasterizer } = seamOpts;
  const context: HostCallContext = { signal };
  const limit = pLimit(ASSET_FETCH_CONCURRENCY);
  let done = 0;
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
          // Thread the abort signal so a mid-export Ctrl-C stops the download.
          return await assets.fetch(ref, context);
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
  const budgetMeta = (block: ImageBlock): { filename: string; pageId?: string } => {
    const filename = block.source.kind === "attachment" ? block.source.filename : block.source.url;
    const owningPage = block.source.kind === "attachment" ? block.source.pageId ?? pageId : pageId;
    return { filename, ...(owningPage ? { pageId: owningPage } : {}) };
  };
  // One progress event per SETTLED image — success or per-image failure alike
  // (matching the PDF engine's per-asset reporting) — so `done` reaches `total`
  // even when some images degrade to report notes. A fatal budget breach aborts
  // without reporting: the export is over, not progressing.
  const reportDone = (detail?: string): void => {
    done += 1;
    onProgress?.({ phase: "assets", done, total, ...(detail !== undefined ? { detail } : {}) });
  };
  return {
    prefetch(block: ImageBlock) {
      void fetchBytes(block);
    },
    async embed(block: ImageBlock) {
      const name = block.source.kind === "attachment" ? block.source.filename : undefined;
      let bytes: Uint8Array;
      try {
        bytes = await fetchBytes(block);
      } catch (err) {
        reportDone(name);
        return { ok: false as const, reason: err instanceof Error ? err.message : String(err) };
      }
      // Budget accounting BEFORE embed: a total-cap breach is fatal and must
      // abort the whole export (never a per-image warning), so it is NOT caught
      // by the per-image failure branch below — it propagates out of the seam.
      budget.account(bytes, budgetMeta(block));
      // SVG attachment path (spec 006 G4): embed vector-sharp via svgBlip with a
      // 2× PNG fallback. Detected here before the raster embedder is reached, so
      // the deferral throw in ImageEmbedder.embed is never hit for this path.
      if (isSvg(bytes)) {
        const outcome = await embedSvgAttachment(block, bytes, name);
        reportDone(name);
        return outcome;
      }
      try {
        const xml = embedder.embed(bytes, {
          alt: block.alt,
          name,
          widthPx: block.width,
          heightPx: block.height,
          ...(partPath ? { partPath } : {}),
        });
        reportDone(name);
        return { ok: true as const, xml };
      } catch (err) {
        reportDone(name);
        return { ok: false as const, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  /**
   * Embed one SVG page attachment (spec 006 G4). Validates the SAME decoded
   * UTF-8 string it embeds (`assertSafeSvg`), sizes it via `parseSvgSize` (with
   * a default + info note), guards the rasterizer target
   * (`resolveTargetSize` → `boundRasterTarget`), rasterizes the PNG fallback at
   * 2×, and embeds both parts through `embedSvg({ origin: "image" })` so it
   * tallies as an image, not a diagram. Missing rasterizer or an oversized
   * target degrades with a precise note code instead of embedding.
   */
  async function embedSvgAttachment(
    block: ImageBlock,
    bytes: Uint8Array,
    name: string | undefined
  ): Promise<ImageEmbedOutcome> {
    if (!rasterizer) {
      return {
        ok: false as const,
        code: "image-svg-no-rasterizer",
        level: "warning" as const,
        reason: "no SVG rasterizer is available in this export; the SVG was skipped",
      };
    }
    // Embed exactly the string that was validated (re-encode for embedSvg), not
    // the pre-decode bytes — a BOM / non-UTF-8 declaration must not let a
    // different byte sequence slip past the safety check. decodeSvgSource is
    // BOM-aware, so a UTF-16LE/BE payload is decoded to its real characters and
    // its `<script>` is caught by assertSafeSvg (spec 011 must-reject).
    const source = decodeSvgSource(bytes);
    try {
      assertSafeSvg(source);
    } catch (err) {
      return { ok: false as const, reason: err instanceof Error ? err.message : String(err) };
    }
    const sideNotes: ExportNote[] = [];
    const parsed = parseSvgSize(source);
    const intrinsic = parsed ?? SVG_FALLBACK_SIZE;
    if (!parsed) {
      sideNotes.push({
        level: "info",
        code: "image-svg-default-size",
        message: `SVG ${describeImageBlock(block)} has no intrinsic size; using a ${SVG_FALLBACK_SIZE.widthPx}×${SVG_FALLBACK_SIZE.heightPx} default.`,
      });
    }
    const display = resolveTargetSize(
      { width: intrinsic.widthPx, height: intrinsic.heightPx },
      { widthPx: block.width, heightPx: block.height },
      MAX_CONTENT_WIDTH_PX
    );
    const raster = boundRasterTarget({ widthPx: display.widthPx * 2, heightPx: display.heightPx * 2 });
    if (!raster) {
      return {
        ok: false as const,
        code: "image-svg-oversized",
        level: "warning" as const,
        reason: "the SVG's resolved dimensions exceed the rasterization budget",
      };
    }
    let png: Uint8Array;
    try {
      png = await rasterizer.rasterize(source, raster);
    } catch (err) {
      return { ok: false as const, reason: err instanceof Error ? err.message : String(err) };
    }
    // Account the PNG against the shared budget (the SVG bytes were already
    // accounted above). A breach is fatal — propagate out of the seam.
    budget.account(png, { filename: (name ?? "image") + ".png" });
    try {
      const xml = embedder.embedSvg(source, png, {
        origin: "image",
        alt: block.alt ?? name,
        name,
        widthPx: display.widthPx,
        heightPx: display.heightPx,
      });
      return { ok: true as const, xml, ...(sideNotes.length ? { notes: sideNotes } : {}) };
    } catch (err) {
      return { ok: false as const, reason: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Human label for an image block in a note (attachment filename or URL). */
function describeImageBlock(block: ImageBlock): string {
  return block.source.kind === "attachment"
    ? `"${block.source.filename}"`
    : `"${block.source.url}"`;
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
  timings: ExportTimings,
  budget: AssetBudget,
  // Target part for the embedded svgBlip/PNG relationships (spec 005 D1) — same
  // rationale as {@link imageSeam}'s `partPath`. Omitted → `word/document.xml`.
  partPath?: string
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
        // Shared raster budget (spec 006 G4): guard the 2× target before it
        // reaches the rasterizer's canvas allocation — the same guard the SVG-
        // attachment path uses, applied here since author dimensions can widen
        // a diagram too.
        const target = boundRasterTarget({
          widthPx: rendered.widthPx * 2,
          heightPx: rendered.heightPx * 2,
        });
        if (!target) {
          return {
            kind: "failed",
            reason: "the diagram's rasterization target exceeds the size budget",
          };
        }
        try {
          const rasterStart = Date.now();
          const png = await rasterizer.rasterize(rendered.svg, target);
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
      // Diagram bytes count against the SAME shared budget as page images
      // (spec 002): both the SVG and its mandatory PNG fallback are embedded
      // into the archive, so both are accounted. A total-cap breach is fatal —
      // it stays OUTSIDE the try/catch below so it propagates out of the seam
      // (aborting the export) instead of degrading to a code-block fallback.
      // Repeated occurrences of the same diagram share bytes → budget dedups.
      budget.account(new TextEncoder().encode(prep.svg), { filename: "diagram.svg" });
      budget.account(prep.png, { filename: "diagram.png" });
      try {
        count += 1;
        const xml = embedder.embedSvg(prep.svg, prep.png, {
          name: `Mermaid diagram ${count}`,
          // Accessibility (spec 005a Task 3): the diagram SOURCE is the
          // best available description of the drawing.
          alt: block.code,
          widthPx: prep.widthPx,
          heightPx: prep.heightPx,
          ...(partPath ? { partPath } : {}),
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

// ---------------------------------------------------------------------------
// Include pass (spec 005 D1)
// ---------------------------------------------------------------------------

/** One include token, matching the shared placeholder grammar for its base. */
const INCLUDE_TOKEN_RE = /\$scroll\.includepage(?:\.?\([^)]*\))?/;

/**
 * Deliberate v1 guess (spec 005 Risks): at most 25 unique included target
 * pages, at most 2 MiB of cumulative included storage per export. Chosen for
 * parity with `ASSET_FETCH_CONCURRENCY`, not measured — revisit on a real
 * large-template report. Exceeding either degrades deterministically
 * (`includepage-budget-exceeded`), never an unbounded fan-out.
 */
const INCLUDE_BUDGET_MAX_PAGES = 25;
const INCLUDE_BUDGET_MAX_STORAGE_BYTES = 2 * 1024 * 1024;

interface IncludeOccurrence {
  /** Stable index → rawxml key `scrollInclude<index>` (one per occurrence). */
  index: number;
  part: string;
  paragraph: string;
  /** The raw token (carries the `.(…)` argument group). */
  raw: string;
}

interface IncludePassDeps {
  zip: PizZip;
  input: ExportInput;
  embedder?: ImageEmbedder;
  wantImages: boolean;
  assets?: AssetFetcher;
  rasterizer?: SvgRasterizer;
  diagramTheme?: DiagramTheme;
  budget: AssetBudget;
  styleNames: Map<string, string>;
  captionLang: CaptionLang;
  timings: ExportTimings;
  /** Sink for the pass's report notes (part of the export's flow notes). */
  notes: ExportNote[];
}

/**
 * The cross-page include pass (spec 005 D1). Returns a `Map<rawxmlKey, OOXML>`
 * to hand docxtemplater; every entry corresponds to one atomic include
 * occurrence whose paragraph has been swapped for its `@scrollInclude<i>` tag.
 *
 * Invariants:
 *  - **Never a literal.** Any occurrence not swapped (invalid args, fetch
 *    failure, non-atomic paragraph, budget, self-include) is left in place for
 *    `preprocessScrollText` to blank.
 *  - **Self-include only is a cycle.** A page including ITSELF would double its
 *    own body inline — blocked with `includepage-cycle`. Every other repeat
 *    (the same target in body + header, or twice in one part) renders normally;
 *    true multi-hop cycles are structurally impossible (included content is
 *    never re-scanned for further tokens).
 *  - **One fetch + one walk per unique target.** Fetches de-duplicate by
 *    canonical ref key through a bounded pool; `storageToBlocks` caches per
 *    resolved pageId. `serializeBlocks` still runs per OCCURRENCE so each
 *    occurrence's images/diagrams embed into ITS OWN target part's rels.
 */
async function runIncludePass(pass: IncludePassDeps): Promise<Map<string, string>> {
  const { zip, input, notes } = pass;
  const includes = new Map<string, string>();

  // 1. Occurrence scan across body + headers/footers (+ chart/diagram parts).
  const occurrences: IncludeOccurrence[] = [];
  for (const part of documentPartNames(zip)) {
    const xml = zip.file(part)?.asText() ?? "";
    if (!xml.includes("$scroll.includepage")) continue;
    for (const para of splitParagraphs(xml)) {
      const text = paragraphText(para);
      const m = text.match(INCLUDE_TOKEN_RE);
      if (!m) continue;
      // Atomic-paragraph check: the token must be the paragraph's SOLE visible
      // content. Otherwise a whole-paragraph OOXML swap would silently delete
      // the surrounding prose (docxtemplater's free-tier rawxml requires the tag
      // to own its paragraph). Not atomic ⇒ note + leave in place (blanks in
      // step 4), no fetch, no swap.
      if (m[0].trim() !== text.trim()) {
        notes.push({
          level: "warning",
          code: "includepage-invalid-context",
          message: `${m[0]} shares a paragraph with other text; only a paragraph whose sole content is the include token is expanded — leave it on its own line. Rendered empty.`,
        });
        continue;
      }
      occurrences.push({ index: occurrences.length, part, paragraph: para, raw: m[0] });
    }
  }
  if (occurrences.length === 0) return includes;

  const startFetch = Date.now();
  const getIncludedPage = input.deps?.getIncludedPage;

  // 2. Fetch leg: de-duplicated by canonical ref key, bounded pool (one
  //    round-trip per unique target however many times it is referenced).
  const limit = pLimit(ASSET_FETCH_CONCURRENCY);
  const fetchCache = new Map<string, Promise<IncludeLookupOutcome>>();
  const canonicalKey = (ref: IncludePageRef): string =>
    ref.pageId ? `id:${ref.pageId}` : `title:${ref.spaceKey ?? ""}:${ref.title ?? ""}`;
  const fetchRef = (ref: IncludePageRef): Promise<IncludeLookupOutcome> => {
    const key = canonicalKey(ref);
    let p = fetchCache.get(key);
    if (!p) {
      // Missing dep ⇒ transient-error (nothing to fetch with).
      p = getIncludedPage
        ? limit(() => getIncludedPage(ref))
        : Promise.resolve<IncludeLookupOutcome>({
            kind: "transient-error",
            message: "no include fetcher is available",
          });
      p.catch(() => {});
      fetchCache.set(key, p);
    }
    return p;
  };

  // 3. Render + budget state, keyed by the resolved pageId.
  const blocksCache = new Map<string, ReturnType<typeof storageToBlocks>>();
  const acceptedPages = new Set<string>();
  let cumulativeStorageBytes = 0;
  let budgetNoted = false;

  const note = (code: string, message: string, level: "info" | "warning" = "warning"): void => {
    notes.push({ level, code, message });
  };

  for (const occ of occurrences) {
    const ref = parseIncludePageArgs(occ.raw);
    if (!ref) {
      note("includepage-unresolved", `${occ.raw} names no page; rendered empty.`);
      continue;
    }

    // Self-include (pageId form): a page cannot include itself (would double its
    // body inline). Caught before the fetch when the id is explicit.
    if (ref.pageId && ref.pageId === input.details.id) {
      note("includepage-cycle", `${occ.raw}: a page cannot include itself; rendered empty.`);
      continue;
    }

    const outcome = await fetchRef(ref);
    let page: ConfluencePageDetails;
    switch (outcome.kind) {
      case "resolved":
        page = outcome.page;
        break;
      case "ambiguous":
        page = outcome.page;
        note(
          "includepage-ambiguous-title",
          `${occ.raw} matched ${outcome.count} pages; used the first (id-sorted). Disambiguate with a SPACE:Title or (pageId) form.`,
          "info"
        );
        break;
      case "not-found-or-forbidden":
        note("includepage-unresolved", `${occ.raw} was not found or is not readable; rendered empty.`);
        continue;
      case "auth-failed":
        note(
          "includepage-auth-failed",
          `${occ.raw}: authentication failed while fetching the included page; check the export credentials. Rendered empty.`
        );
        continue;
      case "rate-limited":
        note(
          "includepage-rate-limited",
          `${occ.raw}: Confluence rate-limited the include fetch; rendered empty — retry the export.`
        );
        continue;
      case "transient-error":
        note(
          "includepage-transient-error",
          `${occ.raw} could not be fetched (${outcome.message}); rendered empty.`
        );
        continue;
    }

    // Self-include (title/space form): only knowable after the ref resolves.
    if (page.id === input.details.id) {
      note("includepage-cycle", `${occ.raw}: a page cannot include itself; rendered empty.`);
      continue;
    }

    // Budget: gate only NEW unique targets; already-accepted ones keep rendering.
    if (!acceptedPages.has(page.id)) {
      const size = (page.storage ?? "").length;
      if (
        acceptedPages.size >= INCLUDE_BUDGET_MAX_PAGES ||
        cumulativeStorageBytes + size > INCLUDE_BUDGET_MAX_STORAGE_BYTES
      ) {
        if (!budgetNoted) {
          note(
            "includepage-budget-exceeded",
            `Include budget exceeded (>${INCLUDE_BUDGET_MAX_PAGES} unique pages or >${INCLUDE_BUDGET_MAX_STORAGE_BYTES} bytes); further new includes rendered empty.`
          );
          budgetNoted = true;
        }
        continue;
      }
      acceptedPages.add(page.id);
      cumulativeStorageBytes += size;
    }

    // Walk once per unique pageId (cached); collect walk notes only once.
    let walked = blocksCache.get(page.id);
    if (!walked) {
      walked = storageToBlocks(page.storage ?? "", { exporter: "word" });
      blocksCache.set(page.id, walked);
      notes.push(...walked.notes);
    }

    // Serialize PER OCCURRENCE with part-bound seams: an included page's image
    // or diagram embeds its relationship into THIS occurrence's target part.
    const images =
      pass.embedder && pass.wantImages && pass.assets
        ? imageSeam(
            pass.embedder,
            pass.assets,
            page.id,
            pass.timings,
            { budget: pass.budget, ...(input.signal ? { signal: input.signal } : {}), total: 0 },
            occ.part
          )
        : undefined;
    const diagrams =
      pass.embedder && pass.rasterizer
        ? diagramSeam(pass.embedder, pass.rasterizer, pass.diagramTheme, pass.timings, pass.budget, occ.part)
        : undefined;
    const serialized = await serializeBlocks(walked.blocks, {
      styleNames: pass.styleNames,
      ...(images ? { images } : {}),
      ...(diagrams ? { diagrams } : {}),
      captionLang: pass.captionLang,
    });
    notes.push(...serialized.notes);

    const key = `scrollInclude${occ.index}`;
    includes.set(key, serialized.xml);

    // Swap the occurrence paragraph for the rawxml tag (sole content — atomic
    // check above guarantees the free-tier rawxml contract).
    const xml = zip.file(occ.part)?.asText() ?? "";
    if (xml.includes(occ.paragraph)) {
      const tagPara = `<w:p><w:r><w:t xml:space="preserve">${DELIM_START}@${key}${DELIM_END}</w:t></w:r></w:p>`;
      zip.file(occ.part, xml.replace(occ.paragraph, tagPara));
    }
  }

  pass.timings.includeFetchMs = Date.now() - startFetch;
  return includes;
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
    // Composed tree/space documents carry the owning page on the block
    // (ImageSource.pageId, spec 002); an attachment must be fetched from the
    // page it lives on, not the export root. Single-page blocks have no
    // per-block pageId and keep using the export's page.
    const owningPage = block.source.pageId ?? pageId;
    return {
      url: `/download/attachments/${encodeURIComponent(owningPage)}/${encodeURIComponent(block.source.filename)}`,
      pageId: owningPage,
      filename: block.source.filename,
    };
  }
  // External image: carry the provenance marker (spec 004) so the host's asset
  // fetcher can route untrusted export_view-derived URLs through its stricter
  // policy-checked fetcher instead of an unrestricted fetch.
  return {
    url: block.source.url,
    pageId,
    ...(block.source.trust ? { trust: block.source.trust } : {}),
  };
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

/**
 * Parse the template's existing `word/numbering.xml` maxima (spec 006 G2), so
 * the {@link NumberingAllocator} allocates above them (the `maxExistingDrawingId`
 * pattern). Runs BEFORE body serialization. A missing or malformed part
 * degrades to a safe `{ 0, 0 }` base rather than throwing — a broken template
 * numbering part must never fail the whole export.
 */
export function inspectNumberingPart(zip: PizZip): { abstractNumId: number; numId: number } {
  const xml = zip.file("word/numbering.xml")?.asText();
  if (!xml) return { abstractNumId: 0, numId: 0 };
  let maxAbstract = 0;
  let maxNum = 0;
  try {
    for (const m of xml.matchAll(/<w:abstractNum\b[^>]*\bw:abstractNumId="(\d+)"/g)) {
      const id = Number(m[1]);
      if (Number.isFinite(id) && id > maxAbstract) maxAbstract = id;
    }
    for (const m of xml.matchAll(/<w:num\b[^>]*\bw:numId="(\d+)"/g)) {
      const id = Number(m[1]);
      if (Number.isFinite(id) && id > maxNum) maxNum = id;
    }
  } catch {
    return { abstractNumId: 0, numId: 0 };
  }
  return { abstractNumId: maxAbstract, numId: maxNum };
}

/**
 * Write the synthesized numbering (spec 006 G2): create `word/numbering.xml`
 * (or merge into an existing one), register the content-type override, and add
 * the `numbering` relationship to the document's rels — all with the ids the
 * allocator already handed out during serialization (no re-basing).
 */
export function ensureNumberingPart(zip: PizZip, allocator: NumberingAllocator): void {
  const { abstractNums, nums } = allocator.toXml();
  const path = "word/numbering.xml";
  const existing = zip.file(path)?.asText();
  if (existing && /<w:numbering\b/.test(existing)) {
    // Merge: abstractNums must precede the first <w:num> (schema order); nums go
    // at the end. Splice each piece into the right place.
    let merged = existing;
    const firstNum = merged.search(/<w:num\b/);
    if (firstNum !== -1) {
      merged = merged.slice(0, firstNum) + abstractNums + merged.slice(firstNum);
    } else {
      merged = merged.replace("</w:numbering>", `${abstractNums}</w:numbering>`);
    }
    merged = merged.replace("</w:numbering>", `${nums}</w:numbering>`);
    zip.file(path, merged);
  } else {
    zip.file(
      path,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        abstractNums +
        nums +
        `</w:numbering>`
    );
  }
  // Content-type override (a specific part, not a default-by-extension).
  const ctPath = "[Content_Types].xml";
  const ct = zip.file(ctPath)?.asText();
  if (ct && !ct.includes("word/numbering.xml")) {
    zip.file(
      ctPath,
      ct.replace(
        "</Types>",
        `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`
      )
    );
  }
  // Relationship from the main document part (reuse the image module's helper).
  const relsPath = relsPathFor("word/document.xml");
  const rels =
    zip.file(relsPath)?.asText() ??
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  if (!/relationships\/numbering/.test(rels)) {
    const ids = [...rels.matchAll(/Id=["']rId(\d+)["']/g)].map((m) => Number(m[1]));
    const rid = `rId${(ids.length ? Math.max(...ids) : 0) + 1}`;
    zip.file(
      relsPath,
      rels.replace(
        "</Relationships>",
        `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`
      )
    );
  }
}

/** Add the fallback ListParagraph style to styles.xml if absent (spec 006 G2). */
export function ensureListParagraphStyle(zip: PizZip): void {
  const path = "word/styles.xml";
  const xml = zip.file(path)?.asText();
  if (!xml) return;
  if (xml.includes(`w:styleId="${LIST_PARAGRAPH_STYLE_ID}"`)) return;
  zip.file(path, xml.replace("</w:styles>", `${listParagraphStyleXml()}</w:styles>`));
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
 * When the last body content is a section-closing paragraph (an orientation
 * region at document end) immediately followed by the body-level `<w:sectPr>`,
 * the final section is EMPTY — a spurious blank page. Replace the pair with
 * the region's own `sectPr` as the body-level one: the document's last section
 * IS the region, in its orientation (spec 003 C6 review fix).
 */
export function mergeTrailingRegionSectPr(zip: PizZip): void {
  const part = "word/document.xml";
  const xml = zip.file(part)?.asText();
  if (!xml) return;
  const merged = xml.replace(
    /<w:p><w:pPr>(<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>)<\/w:pPr><\/w:p>(<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>)(?=<\/w:body>)/,
    "$1"
  );
  if (merged !== xml) zip.file(part, merged);
}

/** Add the synthesized caption paragraph style to styles.xml if absent. */
export function ensureCaptionStyle(zip: PizZip): void {
  const path = "word/styles.xml";
  const xml = zip.file(path)?.asText();
  if (!xml) return;
  if (xml.includes(`w:styleId="${CAPTION_STYLE_ID}"`)) return;
  zip.file(path, xml.replace("</w:styles>", `${captionStyleXml()}</w:styles>`));
}

/**
 * Read the template's body-level `<w:sectPr>` (the last one before `</w:body>`).
 * Extracted from the same location logic as {@link injectContentTagAtEnd} and
 * threaded into the serializer so orientation regions clone the template's
 * ACTUAL page dimensions (spec 003 C6). Returns `undefined` when the template
 * has no body section (the serializer then synthesizes an A4 fallback).
 */
export function readBodySectPr(zip: PizZip): string | undefined {
  const xml = zip.file("word/document.xml")?.asText();
  if (!xml) return undefined;
  const bodyClose = xml.lastIndexOf("</w:body>");
  const start = xml.lastIndexOf("<w:sectPr", bodyClose === -1 ? undefined : bodyClose);
  if (start === -1) return undefined;
  const close = xml.indexOf("</w:sectPr>", start);
  if (close !== -1) return xml.slice(start, close + "</w:sectPr>".length);
  // Self-closing body sectPr (rare): `<w:sectPr .../>`.
  const selfClose = xml.indexOf("/>", start);
  const openEnd = xml.indexOf(">", start);
  if (selfClose !== -1 && (openEnd === -1 || selfClose <= openEnd)) {
    return xml.slice(start, selfClose + 2);
  }
  return undefined;
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
