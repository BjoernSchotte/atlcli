/**
 * Self-built OOXML image module (spec 005).
 *
 * The engine decision (spec 004 F1, docxtemplater free) leaves no library
 * image support, so embedding is hand-built zip surgery on the template's
 * PizZip archive — the four coordinated edits OOXML needs per image
 * (research §2): a media part (`word/media/…`), a `document.xml.rels`
 * relationship, a `[Content_Types].xml` default, and an inline
 * `<w:drawing>` fragment referencing the relationship with EMU sizing.
 *
 * Isomorphic by construction: dimensions come from an in-house header
 * decoder over a `DataView` (no node `Buffer`/`image-size`), bytes are
 * `Uint8Array`, and the rels/content-type edits are string splices (no
 * `xmldom`). SVG is detected but deferred (research §5: svgBlip needs a
 * rasterized PNG fallback, which requires a canvas — not isomorphic); an
 * SVG asset degrades to the caller's report line.
 *
 * The failure invariant callers rely on: {@link ImageEmbedder.embed} writes
 * NOTHING to the archive unless it returns a drawing fragment — a thrown
 * {@link ImageEmbedError} leaves no dangling media part or relationship.
 */
import type PizZip from "pizzip";
import {
  ASSET_MAX_BYTES,
  type ExportNote,
  type MediaBorder,
} from "@atlcli/confluence";
import {
  boundRasterTarget,
  decodeImageInfo,
  isSvg,
  parseSvgSize,
  resolveTargetSize,
  MAX_RASTER_AXIS_PX,
  MAX_RASTER_PIXELS,
  type ImageFormat,
  type ImageInfo,
  type TargetSize,
} from "@atlcli/export-media";

// Inspection, sizing, and raster budgets moved to `@atlcli/export-media`
// (issue #118 Phase 1) so the PDF and DOCX engines share one implementation.
// Re-exported here so this module's existing consumers keep working.
export {
  boundRasterTarget,
  decodeImageInfo,
  isSvg,
  parseSvgSize,
  resolveTargetSize,
  MAX_RASTER_AXIS_PX,
  MAX_RASTER_PIXELS,
  type ImageFormat,
  type ImageInfo,
  type TargetSize,
};

/** 914400 EMU/inch ÷ 96 dpi (research §2.5; matches Scroll/Word defaults). */
export const EMU_PER_PX = 9525;

/**
 * Content-width cap in pixels: ~6.25" of usable A4/Letter width at 96 dpi,
 * matching the 9000 dxa table width the serializer already targets.
 */
export const MAX_CONTENT_WIDTH_PX = 600;

/**
 * Refuse to embed assets above this size (spec 005 risk 2: docx bloat).
 * Aliases the SHARED per-file cap (spec 002) so the DOCX and PDF engines'
 * limits can never drift — same pattern as `PDF_MAX_ASSET_BYTES`.
 */
export const MAX_IMAGE_BYTES = ASSET_MAX_BYTES;

/** A non-fatal embed failure: the export continues with a report line. */
export class ImageEmbedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageEmbedError";
  }
}



// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------


/** px → EMU with rounding (research §2.5). */
export function pxToEmu(px: number): number {
  return Math.round(px * EMU_PER_PX);
}



// ---------------------------------------------------------------------------
// Accessibility audit (spec 011, PDF/UA lane — same audit, DOCX side)
// ---------------------------------------------------------------------------

/**
 * True when an image carries no author-written alternative text.
 *
 * Mirrors `isMissingAltText` in `packages/pdf/src/prepare.ts` exactly, including
 * the whitespace rule: `alt=" "` satisfies no assistive technology, and
 * Confluence's editor produces it readily. The two engines must agree on what
 * counts as "has alt text" or the same source page audits differently depending
 * on which format an author exported.
 */
export function isMissingAltText(alt: string | undefined): boolean {
  return (alt ?? "").trim().length === 0;
}

/**
 * The alt-text audit note for one embedded image, or `null` when the image has
 * alt text.
 *
 * Worth stating plainly, because the emitted XML looks fine either way:
 * {@link inlineImageParagraph} always writes a non-empty `descr`, falling back
 * to the filename (`opts.alt || opts.name || "image"`). Word therefore reports
 * the picture as "has alt text" and its own accessibility checker stays silent,
 * while a screen reader reads out `chart-final-v2.png`. This audit is the only
 * signal an author gets that the fallback was taken.
 *
 * The emitted `image-missing-alt` code is SHARED with the PDF engine (spec 010),
 * which emits the same code from `packages/pdf/src/prepare.ts` for the same
 * source-block condition. Both must keep emitting it: `notesByCode` is the
 * only cross-format handle a CI pipeline has on "pages that still need alt
 * text", and it must not depend on which format was exported. The DOCX note
 * carries no `source.blockPath` (this serializer tracks none) — less
 * provenance for the same fact, not a different fact.
 */
export function auditImageAltText(input: {
  alt?: string;
  /** Human label for the image — attachment filename or external URL. */
  name: string;
  /** Provenance for the note (spec 003): which page the image lives on. */
  pageId?: string;
}): ExportNote | null {
  if (!isMissingAltText(input.alt)) return null;
  return {
    level: "warning",
    code: "image-missing-alt",
    message:
      `The image "${input.name}" has no alternative text; Word falls back to the technical ` +
      `filename, which assistive technology cannot use. Add alt text on the source page.`,
    source: {
      ...(input.pageId ? { pageId: input.pageId } : {}),
      assetName: input.name,
    },
  };
}

// ---------------------------------------------------------------------------
// Drawing fragment
// ---------------------------------------------------------------------------

/** Escape a string for an XML attribute value (quotes included). */
function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface DrawingParams {
  /** Full relationship id, e.g. `rId7` (never a bare number — research §2.1). */
  relId: string;
  /** Unique per image across the whole document (research §5: id collisions). */
  docPrId: number;
  /** Element name shown in Word's selection pane. */
  name: string;
  /** Explicit assistive-technology contract for this drawing. */
  accessibility:
    | { kind: "labelled"; description: string }
    | { kind: "decorative" };
  cxEmu: number;
  cyEmu: number;
  /** Float the drawing to one side and let following body text wrap around it. */
  wrap?: "left" | "right";
  /**
   * Optional `<w:pPr>…</w:pPr>` carried onto the emitted paragraph — used by
   * the logo pass to preserve the replaced placeholder paragraph's alignment.
   */
  pPrXml?: string;
  /**
   * Relationship id of an SVG media part (spec 005a). When set, the blip
   * gains the `asvg:svgBlip` extension: modern Word renders the vector SVG,
   * older Word falls back to the raster `relId` (the mandatory PNG).
   */
  svgRelId?: string;
  /** Authored ADF border rendered on the picture shape itself. */
  border?: MediaBorder;
}

/**
 * The inline `<w:p><w:drawing>` fragment for one embedded image — the fuller,
 * Word-blessed shape from the reference module (research §2.1): effectExtent,
 * aspect-ratio locks (`graphicFrameLocks`/`picLocks`), `a14:useLocalDpi`,
 * `noFill` shape properties. All namespaces are declared inline (the spike's
 * robustness improvement), so the fragment is self-contained wherever the
 * serializer splices it.
 */
function pictureBorder(border: MediaBorder | undefined): string {
  if (!border) return `<a:ln><a:noFill/></a:ln>`;
  const rgb = border.color.slice(1, 7).toUpperCase();
  const alphaHex = border.color.length === 9 ? border.color.slice(7, 9) : undefined;
  const alpha = alphaHex === undefined
    ? ""
    : `<a:alpha val="${Math.round((Number.parseInt(alphaHex, 16) / 255) * 100000)}"/>`;
  return (
    `<a:ln w="${border.size * 12700}">` +
    `<a:solidFill><a:srgbClr val="${rgb}">${alpha}</a:srgbClr></a:solidFill>` +
    `</a:ln>`
  );
}

/** A drawing run that can be placed between ordinary text runs in one paragraph. */
export function inlineImageRun(p: DrawingParams): string {
  const name = escAttr(p.name);
  const labelledDescription =
    p.accessibility.kind === "labelled"
      ? escAttr(p.accessibility.description)
      : undefined;
  const docPr =
    labelledDescription !== undefined
      ? `<wp:docPr id="${p.docPrId}" name="${name}" descr="${labelledDescription}"/>`
      : (
          `<wp:docPr id="${p.docPrId}" name="${name}">` +
          `<a:extLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
          `<a:ext uri="{C183D7F6-B498-43B3-948B-1728B52AA6E4}">` +
          `<adec:decorative xmlns:adec="http://schemas.microsoft.com/office/drawing/2017/decorative" val="1"/>` +
          `</a:ext></a:extLst></wp:docPr>`
        );
  const nonVisualPictureProperties =
    labelledDescription !== undefined
      ? `<pic:cNvPr id="${p.docPrId}" name="${name}" descr="${labelledDescription}"/>`
      : `<pic:cNvPr id="${p.docPrId}" name="${name}"/>`;
  const drawingOpen = p.wrap
    ? `<wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="0" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
      `<wp:simplePos x="0" y="0"/>` +
      `<wp:positionH relativeFrom="column"><wp:align>${p.wrap}</wp:align></wp:positionH>` +
      `<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>`
    : `<wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">`;
  const wrap = p.wrap
    ? `<wp:wrapSquare wrapText="${p.wrap === "left" ? "right" : "left"}"/>`
    : "";
  const drawingClose = p.wrap ? "</wp:anchor>" : "</wp:inline>";
  return (
    `<w:r><w:drawing>` +
    drawingOpen +
    `<wp:extent cx="${p.cxEmu}" cy="${p.cyEmu}"/>` +
    `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    wrap +
    docPr +
    `<wp:cNvGraphicFramePr>` +
    `<a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>` +
    `</wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr>` +
    nonVisualPictureProperties +
    `<pic:cNvPicPr><a:picLocks noChangeAspect="1" noChangeArrowheads="1"/></pic:cNvPicPr>` +
    `</pic:nvPicPr>` +
    `<pic:blipFill>` +
    `<a:blip r:embed="${p.relId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<a:extLst><a:ext uri="{28A0092B-C50C-407E-A947-70E740481C1C}">` +
    `<a14:useLocalDpi xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" val="0"/>` +
    `</a:ext>` +
    (p.svgRelId
      ? `<a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}">` +
        `<asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="${p.svgRelId}"/>` +
        `</a:ext>`
      : "") +
    `</a:extLst>` +
    `</a:blip>` +
    `<a:srcRect/><a:stretch><a:fillRect/></a:stretch>` +
    `</pic:blipFill>` +
    `<pic:spPr bwMode="auto">` +
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${p.cxEmu}" cy="${p.cyEmu}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    `<a:noFill/>${pictureBorder(p.border)}` +
    `</pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic>${drawingClose}</w:drawing></w:r>`
  );
}

export function inlineImageParagraph(p: DrawingParams): string {
  return `<w:p>${p.pPrXml ?? ""}${inlineImageRun(p)}</w:p>`;
}

// ---------------------------------------------------------------------------
// The embedder: media part + relationship + content type on a PizZip archive
// ---------------------------------------------------------------------------

export interface ImageEmbedderOptions {
  /** Content-width cap in px; defaults to {@link MAX_CONTENT_WIDTH_PX}. */
  maxWidthPx?: number;
}

export interface EmbedImageOptions {
  /** Alt text for `descr` (accessibility). */
  alt?: string;
  /**
   * Override the drawing's assistive-technology contract.
   *
   * Ordinary source images remain labelled from `alt`/`name`; built-in
   * semantic adornments may opt into the Office 2019 decorative marker.
   */
  accessibility?:
    | { kind: "labelled"; description: string }
    | { kind: "decorative" };
  /** Human-facing name (e.g. the attachment filename). */
  name?: string;
  /** Author-specified rendered width in px (Confluence `ac:width`). */
  widthPx?: number;
  /** Author-specified rendered height in px. */
  heightPx?: number;
  /** ADF media wrapping side. */
  wrap?: "left" | "right";
  /**
   * The document part whose XML will carry the returned drawing (default
   * `word/document.xml`). An `r:embed` relationship is only valid in the rels
   * of the part that references it, so a logo drawn into a header/footer must
   * name that part here — the relationship then lands in e.g.
   * `word/_rels/header1.xml.rels` (spec 005 logo pass).
   */
  partPath?: string;
  /** `<w:pPr>…</w:pPr>` to preserve on the emitted paragraph (see {@link DrawingParams.pPrXml}). */
  pPrXml?: string;
  /** Authored ADF border rendered on the picture shape. */
  border?: MediaBorder;
}

export interface EmbedSvgOptions {
  /** Alt text for `descr` (spec 005a: the diagram SOURCE is the description). */
  alt?: string;
  /** Explicit assistive-technology contract for the SVG drawing. */
  accessibility?:
    | { kind: "labelled"; description: string }
    | { kind: "decorative" };
  /** Human-facing name (shown in Word's selection pane). */
  name?: string;
  /** Intrinsic pixel width of the SVG (drives the width-capped display size). */
  widthPx: number;
  /** Intrinsic pixel height of the SVG. */
  heightPx: number;
  /** ADF media wrapping side. */
  wrap?: "left" | "right";
  /** Document part whose rels carry the relationships (default `word/document.xml`). */
  partPath?: string;
  /** `<w:pPr>…</w:pPr>` to preserve on the emitted paragraph. */
  pPrXml?: string;
  /**
   * What the embed counts as (spec 006 G4). `"diagram"` (default, mermaid's
   * existing call) increments `diagramCount`; `"image"` (an SVG page
   * attachment) increments `embeddedCount` — an attachment SVG is an image,
   * not a rendered diagram, so the report tallies it as `embeddedImages`.
   */
  origin?: "image" | "diagram";
  /** Authored ADF border rendered on the picture shape. */
  border?: MediaBorder;
}

interface MediaEntry {
  /** Media-part filename (under `word/media/`), shared across parts. */
  filename: string;
  /** Relationship id PER RELS PART — the same media gets one rel per part. */
  relIds: Map<string, string>;
  info: ImageInfo;
  bytes: Uint8Array;
}

const DOCUMENT_PART = "word/document.xml";
const CT_PATH = "[Content_Types].xml";
const EMPTY_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;

/**
 * Embeds images into one document's PizZip archive. Construct once per export:
 * the instance owns the unique-id counters (docPr ids seeded above anything
 * the template already contains; rIds above the existing rels) and the
 * byte-identical dedup map (identical images share one media part +
 * relationship, each occurrence still getting its own unique docPr id).
 */
export class ImageEmbedder {
  private readonly zip: PizZip;
  private readonly maxWidthPx: number;
  private nextDocPrId: number;
  private mediaIndex = 0;
  private embedded = 0;
  private diagramsEmbedded = 0;
  /** FNV-1a+length key → entries with those bytes (hash collisions chained). */
  private readonly dedup = new Map<string, MediaEntry[]>();

  constructor(zip: PizZip, opts: ImageEmbedderOptions = {}) {
    this.zip = zip;
    this.maxWidthPx = opts.maxWidthPx ?? MAX_CONTENT_WIDTH_PX;
    this.nextDocPrId = maxExistingDrawingId(zip) + 1;
  }

  /** Number of image occurrences successfully embedded so far (not diagrams). */
  get embeddedCount(): number {
    return this.embedded;
  }

  /** Number of diagram occurrences successfully embedded so far (spec 005a). */
  get diagramCount(): number {
    return this.diagramsEmbedded;
  }

  /**
   * Embed one image occurrence and return its `<w:p><w:drawing>` fragment.
   * Throws {@link ImageEmbedError} on unsupported/oversized/undecodable input
   * — in that case the archive is untouched (no dangling media part or rel).
   */
  embed(bytes: Uint8Array, opts: EmbedImageOptions = {}): string {
    return this.embedRaster(bytes, opts, false);
  }

  /** Embed an image as a drawing run inside an existing paragraph. */
  embedInline(bytes: Uint8Array, opts: EmbedImageOptions = {}): string {
    return this.embedRaster(bytes, opts, true);
  }

  /**
   * Embed a built-in semantic callout icon as an inline drawing.
   *
   * It uses the same media/relationship/id machinery as page images, but it is
   * exporter chrome rather than authored page media and therefore does not
   * increment {@link embeddedCount}.
   */
  embedCalloutIconInline(bytes: Uint8Array, opts: EmbedImageOptions): string {
    return this.embedRaster(bytes, opts, true, false);
  }

  private embedRaster(
    bytes: Uint8Array,
    opts: EmbedImageOptions,
    inline: boolean,
    countAsImage = true,
  ): string {
    if (bytes.length === 0) throw new ImageEmbedError("the fetched image was empty");
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new ImageEmbedError(
        `the image is too large to embed (${Math.round(bytes.length / (1024 * 1024))} MB > ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB)`
      );
    }
    // The DOCX image seam (spec 006 G4) now routes SVG page attachments to the
    // dual-part svgBlip path BEFORE reaching this raster embedder, so this throw
    // is no longer the SVG-attachment path — it is now a defense-in-depth guard
    // for OTHER `embed()` callers (e.g. the logo pass, which embeds raster
    // formats only). Vector SVG has no place in the raster embedder.
    if (isSvg(bytes)) throw new ImageEmbedError("SVG images cannot be embedded through the raster path");
    const info = decodeImageInfo(bytes);
    if (!info) throw new ImageEmbedError("unsupported image format (PNG, JPEG and GIF are supported)");

    const entry = this.findOrCreateMedia(bytes, info);
    const relId = this.ensureRelationship(entry, opts.partPath ?? DOCUMENT_PART);
    const size = resolveTargetSize(info, { widthPx: opts.widthPx, heightPx: opts.heightPx }, this.maxWidthPx);
    const docPrId = this.nextDocPrId++;
    if (countAsImage) this.embedded += 1;
    const params: DrawingParams = {
      relId,
      docPrId,
      name: opts.name || `Image ${docPrId}`,
      accessibility: opts.accessibility ?? {
        kind: "labelled",
        description: opts.alt || opts.name || "image",
      },
      cxEmu: pxToEmu(size.widthPx),
      cyEmu: pxToEmu(size.heightPx),
      wrap: opts.wrap,
      pPrXml: opts.pPrXml,
      border: opts.border,
    };
    return inline ? inlineImageRun(params) : inlineImageParagraph(params);
  }

  /**
   * Embed a vector diagram: an SVG media part PLUS its mandatory PNG raster
   * fallback in the same `<a:blip>` (spec 005a §2.4 — Word's `svgBlip` support
   * is version-dependent, so the raster copy always rides along). Returns the
   * `<w:p><w:drawing>` fragment sized to the SVG's intrinsic `widthPx` ×
   * `heightPx`, width-capped like any other image.
   *
   * Throws {@link ImageEmbedError} when either leg is invalid (empty/oversized
   * bytes, a fallback that is not a well-formed PNG, bytes that are not SVG) —
   * all validation happens BEFORE the first archive write, so a throw leaves
   * no dangling media part or relationship (the 004-F3 invariant).
   */
  embedSvg(svg: string | Uint8Array, pngFallback: Uint8Array, opts: EmbedSvgOptions): string {
    return this.embedSvgDrawing(svg, pngFallback, opts, false);
  }

  /** Embed SVG + PNG fallback as a drawing run inside an existing paragraph. */
  embedSvgInline(
    svg: string | Uint8Array,
    pngFallback: Uint8Array,
    opts: EmbedSvgOptions,
  ): string {
    return this.embedSvgDrawing(svg, pngFallback, opts, true);
  }

  private embedSvgDrawing(
    svg: string | Uint8Array,
    pngFallback: Uint8Array,
    opts: EmbedSvgOptions,
    inline: boolean,
  ): string {
    const svgBytes = typeof svg === "string" ? new TextEncoder().encode(svg) : svg;
    if (svgBytes.length === 0) throw new ImageEmbedError("the rendered SVG was empty");
    if (svgBytes.length > MAX_IMAGE_BYTES) throw new ImageEmbedError("the rendered SVG is too large to embed");
    if (!isSvg(svgBytes)) throw new ImageEmbedError("the diagram did not render to a well-formed SVG");
    if (pngFallback.length === 0) throw new ImageEmbedError("the rasterized PNG fallback was empty");
    if (pngFallback.length > MAX_IMAGE_BYTES) throw new ImageEmbedError("the rasterized PNG fallback is too large to embed");
    const pngInfo = decodeImageInfo(pngFallback);
    if (!pngInfo || pngInfo.format !== "png") {
      throw new ImageEmbedError("the rasterizer did not produce a well-formed PNG fallback");
    }
    if (!opts.widthPx || !opts.heightPx) throw new ImageEmbedError("the diagram has no usable intrinsic size");

    const svgInfo: ImageInfo = {
      format: "svg",
      ext: "svg",
      mime: "image/svg+xml",
      width: opts.widthPx,
      height: opts.heightPx,
    };
    const partPath = opts.partPath ?? DOCUMENT_PART;
    const svgEntry = this.findOrCreateMedia(svgBytes, svgInfo);
    const pngEntry = this.findOrCreateMedia(pngFallback, pngInfo);
    const svgRelId = this.ensureRelationship(svgEntry, partPath);
    const pngRelId = this.ensureRelationship(pngEntry, partPath);
    const size = resolveTargetSize(
      { width: opts.widthPx, height: opts.heightPx },
      {},
      this.maxWidthPx
    );
    const docPrId = this.nextDocPrId++;
    if ((opts.origin ?? "diagram") === "image") this.embedded += 1;
    else this.diagramsEmbedded += 1;
    const params: DrawingParams = {
      relId: pngRelId,
      svgRelId,
      docPrId,
      name: opts.name || `Diagram ${docPrId}`,
      accessibility: opts.accessibility ?? {
        kind: "labelled",
        description: opts.alt || opts.name || "diagram",
      },
      cxEmu: pxToEmu(size.widthPx),
      cyEmu: pxToEmu(size.heightPx),
      wrap: opts.wrap,
      pPrXml: opts.pPrXml,
      border: opts.border,
    };
    return inline ? inlineImageRun(params) : inlineImageParagraph(params);
  }

  /** Reuse the media part for byte-identical images, else write a new one. */
  private findOrCreateMedia(bytes: Uint8Array, info: ImageInfo): MediaEntry {
    const key = `${fnv1a(bytes)}:${bytes.length}`;
    const bucket = this.dedup.get(key);
    if (bucket) {
      for (const candidate of bucket) {
        if (sameBytes(candidate.bytes, bytes)) return candidate;
      }
    }
    const entry: MediaEntry = { filename: this.writeMedia(bytes, info), relIds: new Map(), info, bytes };
    if (bucket) bucket.push(entry);
    else this.dedup.set(key, [entry]);
    return entry;
  }

  /** The two shared archive edits: media part + content-type default. */
  private writeMedia(bytes: Uint8Array, info: ImageInfo): string {
    let filename: string;
    do {
      this.mediaIndex += 1;
      filename = `atlcli-image${this.mediaIndex}.${info.ext}`;
    } while (this.zip.file(`word/media/${filename}`));

    ensureContentTypeDefault(this.zip, info.ext, info.mime);
    this.zip.file(`word/media/${filename}`, bytes);
    return filename;
  }

  /**
   * Ensure the media part is related from `partPath`'s rels (created on first
   * use per part — the same media gets exactly one relationship per part).
   */
  private ensureRelationship(entry: MediaEntry, partPath: string): string {
    const relsPath = relsPathFor(partPath);
    const existing = entry.relIds.get(relsPath);
    if (existing) return existing;

    const rels = this.zip.file(relsPath)?.asText() ?? EMPTY_RELS;
    // Match both quote styles, like the settings-part surgery in export.ts.
    const ids = [...rels.matchAll(/Id=["']rId(\d+)["']/g)].map((m) => Number(m[1]));
    const relId = `rId${(ids.length ? Math.max(...ids) : 0) + 1}`;
    this.zip.file(
      relsPath,
      rels.replace(
        "</Relationships>",
        `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${entry.filename}"/></Relationships>`
      )
    );
    entry.relIds.set(relsPath, relId);
    return relId;
  }
}

/** `word/header1.xml` → `word/_rels/header1.xml.rels` (OPC rels convention). */
export function relsPathFor(partPath: string): string {
  const slash = partPath.lastIndexOf("/");
  const dir = slash === -1 ? "" : partPath.slice(0, slash + 1);
  const base = slash === -1 ? partPath : partPath.slice(slash + 1);
  return `${dir}_rels/${base}.rels`;
}

/** Add a `<Default Extension=…>` to `[Content_Types].xml` unless present. */
export function ensureContentTypeDefault(zip: PizZip, ext: string, mime: string): void {
  const ct = zip.file(CT_PATH)?.asText();
  if (!ct) return; // not a Word package — unzipDocx would have rejected it
  if (new RegExp(`<Default[^>]+Extension="${ext}"`, "i").test(ct)) return;
  zip.file(CT_PATH, ct.replace("</Types>", `<Default Extension="${ext}" ContentType="${mime}"/></Types>`));
}

/**
 * Highest `wp:docPr`/`pic:cNvPr` id anywhere in the template's XML parts, so
 * our ids never collide with drawings the template already carries.
 */
function maxExistingDrawingId(zip: PizZip): number {
  let max = 0;
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir || !path.endsWith(".xml")) continue;
    const xml = entry.asText();
    for (const m of xml.matchAll(/<(?:wp:docPr|pic:cNvPr)\b[^>]*\bid="(\d+)"/g)) {
      const id = Number(m[1]);
      if (id > max) max = id;
    }
  }
  return max;
}

/** 32-bit FNV-1a over the bytes (dedup bucket key; equality is verified). */
function fnv1a(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
