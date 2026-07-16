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

/** 914400 EMU/inch ÷ 96 dpi (research §2.5; matches Scroll/Word defaults). */
export const EMU_PER_PX = 9525;

/**
 * Content-width cap in pixels: ~6.25" of usable A4/Letter width at 96 dpi,
 * matching the 9000 dxa table width the serializer already targets.
 */
export const MAX_CONTENT_WIDTH_PX = 600;

/** Refuse to embed assets above this size (spec 005 risk 2: docx bloat). */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export type ImageFormat = "png" | "jpeg" | "gif";

export interface ImageInfo {
  format: ImageFormat;
  /** Media-part filename extension. */
  ext: string;
  /** MIME type for the `[Content_Types].xml` default. */
  mime: string;
  /** Intrinsic pixel dimensions from the header. */
  width: number;
  height: number;
}

/** A non-fatal embed failure: the export continues with a report line. */
export class ImageEmbedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageEmbedError";
  }
}

// ---------------------------------------------------------------------------
// Format sniffing + dimension decoding (research §4: in-browser, DataView)
// ---------------------------------------------------------------------------

/**
 * Decode format + intrinsic dimensions from the image header. Returns `null`
 * for anything that is not a well-formed PNG/JPEG/GIF.
 */
export function decodeImageInfo(bytes: Uint8Array): ImageInfo | null {
  return decodePng(bytes) ?? decodeJpeg(bytes) ?? decodeGif(bytes);
}

/** PNG: 8-byte signature, IHDR width/height at offsets 16/20 (big-endian). */
function decodePng(bytes: Uint8Array): ImageInfo | null {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || SIG.some((b, i) => bytes[i] !== b)) return null;
  // Bytes 12–15 must name the IHDR chunk (always first in a valid PNG).
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height) return null;
  return { format: "png", ext: "png", mime: "image/png", width, height };
}

/** GIF: `GIF87a`/`GIF89a`, logical-screen width/height at 6/8 (little-endian). */
function decodeGif(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 10) return null;
  const head = String.fromCharCode(...bytes.subarray(0, 6));
  if (head !== "GIF87a" && head !== "GIF89a") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  if (!width || !height) return null;
  return { format: "gif", ext: "gif", mime: "image/gif", width, height };
}

/**
 * JPEG: walk the marker segments from SOI until a start-of-frame (SOF0–SOF15,
 * excluding the non-frame C4/C8/CC markers) yields height/width, or the scan
 * data (SOS) begins.
 */
function decodeJpeg(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return null; // desynced — not a marker
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    // Standalone markers without a length (RSTn, SOI, EOI, TEM).
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      i += 2;
      continue;
    }
    if (i + 4 > bytes.length) return null;
    const length = view.getUint16(i + 2);
    if (length < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 > bytes.length) return null;
      const height = view.getUint16(i + 5);
      const width = view.getUint16(i + 7);
      if (!width || !height) return null;
      return { format: "jpeg", ext: "jpeg", mime: "image/jpeg", width, height };
    }
    if (marker === 0xda) return null; // scan data reached without a SOF
    i += 2 + length;
  }
  return null;
}

/**
 * True when the bytes look like an SVG document (optionally behind a BOM /
 * XML declaration / comments). Only the first 512 bytes are inspected.
 */
export function isSvg(bytes: Uint8Array): boolean {
  let head = "";
  const limit = Math.min(bytes.length, 512);
  for (let i = 0; i < limit; i++) head += String.fromCharCode(bytes[i]);
  head = head.replace(/^(?:\uFEFF|\xEF\xBB\xBF)/, "").trimStart();
  if (!head.startsWith("<")) return false;
  return /<svg[\s>]/i.test(head);
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

export interface TargetSize {
  widthPx: number;
  heightPx: number;
}

/**
 * Resolve the rendered size: author-specified px override the intrinsic size
 * (one missing axis scales by the intrinsic aspect ratio), then the result is
 * capped to `maxWidthPx` preserving aspect (spec 005: width-capping).
 */
export function resolveTargetSize(
  intrinsic: { width: number; height: number },
  wanted: { widthPx?: number; heightPx?: number },
  maxWidthPx: number
): TargetSize {
  let w = intrinsic.width;
  let h = intrinsic.height;
  if (wanted.widthPx && wanted.heightPx) {
    w = wanted.widthPx;
    h = wanted.heightPx;
  } else if (wanted.widthPx) {
    h = Math.round((intrinsic.height * wanted.widthPx) / intrinsic.width);
    w = wanted.widthPx;
  } else if (wanted.heightPx) {
    w = Math.round((intrinsic.width * wanted.heightPx) / intrinsic.height);
    h = wanted.heightPx;
  }
  if (w > maxWidthPx) {
    h = Math.round((h * maxWidthPx) / w);
    w = maxWidthPx;
  }
  return { widthPx: Math.max(1, w), heightPx: Math.max(1, h) };
}

/** px → EMU with rounding (research §2.5). */
export function pxToEmu(px: number): number {
  return Math.round(px * EMU_PER_PX);
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
  /** Alt text carried onto `wp:docPr`/`pic:cNvPr` `descr` (accessibility). */
  descr: string;
  cxEmu: number;
  cyEmu: number;
}

/**
 * The inline `<w:p><w:drawing>` fragment for one embedded image — the fuller,
 * Word-blessed shape from the reference module (research §2.1): effectExtent,
 * aspect-ratio locks (`graphicFrameLocks`/`picLocks`), `a14:useLocalDpi`,
 * `noFill` shape properties. All namespaces are declared inline (the spike's
 * robustness improvement), so the fragment is self-contained wherever the
 * serializer splices it.
 */
export function inlineImageParagraph(p: DrawingParams): string {
  const name = escAttr(p.name);
  const descr = escAttr(p.descr);
  return (
    `<w:p><w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<wp:extent cx="${p.cxEmu}" cy="${p.cyEmu}"/>` +
    `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${p.docPrId}" name="${name}" descr="${descr}"/>` +
    `<wp:cNvGraphicFramePr>` +
    `<a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>` +
    `</wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr>` +
    `<pic:cNvPr id="${p.docPrId}" name="${name}" descr="${descr}"/>` +
    `<pic:cNvPicPr><a:picLocks noChangeAspect="1" noChangeArrowheads="1"/></pic:cNvPicPr>` +
    `</pic:nvPicPr>` +
    `<pic:blipFill>` +
    `<a:blip r:embed="${p.relId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<a:extLst><a:ext uri="{28A0092B-C50C-407E-A947-70E740481C1C}">` +
    `<a14:useLocalDpi xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" val="0"/>` +
    `</a:ext></a:extLst>` +
    `</a:blip>` +
    `<a:srcRect/><a:stretch><a:fillRect/></a:stretch>` +
    `</pic:blipFill>` +
    `<pic:spPr bwMode="auto">` +
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${p.cxEmu}" cy="${p.cyEmu}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    `<a:noFill/><a:ln><a:noFill/></a:ln>` +
    `</pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  );
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
  /** Human-facing name (e.g. the attachment filename). */
  name?: string;
  /** Author-specified rendered width in px (Confluence `ac:width`). */
  widthPx?: number;
  /** Author-specified rendered height in px. */
  heightPx?: number;
}

interface MediaEntry {
  relId: string;
  info: ImageInfo;
  bytes: Uint8Array;
}

const RELS_PATH = "word/_rels/document.xml.rels";
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
  /** FNV-1a+length key → entries with those bytes (hash collisions chained). */
  private readonly dedup = new Map<string, MediaEntry[]>();

  constructor(zip: PizZip, opts: ImageEmbedderOptions = {}) {
    this.zip = zip;
    this.maxWidthPx = opts.maxWidthPx ?? MAX_CONTENT_WIDTH_PX;
    this.nextDocPrId = maxExistingDrawingId(zip) + 1;
  }

  /** Number of image occurrences successfully embedded so far. */
  get embeddedCount(): number {
    return this.embedded;
  }

  /**
   * Embed one image occurrence and return its `<w:p><w:drawing>` fragment.
   * Throws {@link ImageEmbedError} on unsupported/oversized/undecodable input
   * — in that case the archive is untouched (no dangling media part or rel).
   */
  embed(bytes: Uint8Array, opts: EmbedImageOptions = {}): string {
    if (bytes.length === 0) throw new ImageEmbedError("the fetched image was empty");
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new ImageEmbedError(
        `the image is too large to embed (${Math.round(bytes.length / (1024 * 1024))} MB > 25 MB)`
      );
    }
    if (isSvg(bytes)) throw new ImageEmbedError("SVG images are not embedded yet (spec 005 deferral)");
    const info = decodeImageInfo(bytes);
    if (!info) throw new ImageEmbedError("unsupported image format (PNG, JPEG and GIF are supported)");

    const entry = this.findOrCreateMedia(bytes, info);
    const size = resolveTargetSize(info, { widthPx: opts.widthPx, heightPx: opts.heightPx }, this.maxWidthPx);
    const docPrId = this.nextDocPrId++;
    this.embedded += 1;
    return inlineImageParagraph({
      relId: entry.relId,
      docPrId,
      name: opts.name || `Image ${docPrId}`,
      descr: opts.alt || opts.name || "image",
      cxEmu: pxToEmu(size.widthPx),
      cyEmu: pxToEmu(size.heightPx),
    });
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
    const entry: MediaEntry = { relId: this.writeMedia(bytes, info), info, bytes };
    if (bucket) bucket.push(entry);
    else this.dedup.set(key, [entry]);
    return entry;
  }

  /** The three archive edits: media part, content-type default, relationship. */
  private writeMedia(bytes: Uint8Array, info: ImageInfo): string {
    let filename: string;
    do {
      this.mediaIndex += 1;
      filename = `atlcli-image${this.mediaIndex}.${info.ext}`;
    } while (this.zip.file(`word/media/${filename}`));

    ensureContentTypeDefault(this.zip, info.ext, info.mime);

    const rels = this.zip.file(RELS_PATH)?.asText() ?? EMPTY_RELS;
    // Match both quote styles, like the settings-part surgery in export.ts.
    const ids = [...rels.matchAll(/Id=["']rId(\d+)["']/g)].map((m) => Number(m[1]));
    const relId = `rId${(ids.length ? Math.max(...ids) : 0) + 1}`;
    this.zip.file(
      RELS_PATH,
      rels.replace(
        "</Relationships>",
        `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${filename}"/></Relationships>`
      )
    );
    this.zip.file(`word/media/${filename}`, bytes);
    return relId;
  }
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
