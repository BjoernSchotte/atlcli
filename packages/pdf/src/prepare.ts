import { renderDiagram } from "@atlcli/diagram";
import {
  ASSET_MAX_BYTES,
  ASSET_MAX_TOTAL_BYTES,
  AssetBudget,
  AssetBudgetExceededError,
  createInOrderLimiter,
  materializeTable,
  type ExportProgressCallback,
} from "@atlcli/confluence";
import type { ExportBlock, ExportNote } from "@atlcli/confluence";
import { assertSafeSvg } from "./svg-safety.js";
import { decodeSvgSource } from "@atlcli/confluence";
import type {
  PdfAssetResolver,
  PdfResolvedAsset,
  PreparedPdfAsset,
  PreparedPdfBlock,
  PreparedPdfDocument,
} from "./types.js";

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/webp": "webp",
};

// The per-file and total caps are the SHARED contract with the DOCX engine
// (spec 002): both engines import the same constants so the caps never drift.
export const PDF_MAX_ASSET_BYTES = ASSET_MAX_BYTES;
export const PDF_MAX_TOTAL_ASSET_BYTES = ASSET_MAX_TOTAL_BYTES;
export const PDF_ASSET_CONCURRENCY = 4;

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function sniffMediaType(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 24 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (byte, index) => bytes[index] === byte
    )
  ) return "image/png";
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length >= 10 && /GIF8[79]a/.test(ascii(bytes, 0, 6))) return "image/gif";
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  ) return "image/webp";
  // BOM/encoding-aware (spec 011 security corpus): a UTF-16LE/BE SVG must be
  // recognized so its content is scanned by the shared policy rather than
  // slipping through as "unrecognized bytes".
  const head = decodeSvgSource(bytes.subarray(0, Math.min(bytes.length, 4096)));
  if (/<svg(?:\s|>)/i.test(head.replace(/^\uFEFF/, "").trimStart())) return "image/svg+xml";
  return null;
}

function validateResolvedAsset(asset: PdfResolvedAsset): PdfResolvedAsset {
  if (asset.bytes.byteLength === 0) throw new Error("the fetched image was empty");
  if (asset.bytes.byteLength > PDF_MAX_ASSET_BYTES) {
    throw new Error("the image exceeds the 25 MB per-file limit");
  }
  const sniffed = sniffMediaType(asset.bytes);
  if (!sniffed) throw new Error("unsupported or corrupt image bytes");
  const declared = asset.mediaType.toLowerCase().split(";", 1)[0]!.trim();
  if (declared !== "application/octet-stream" && declared !== sniffed) {
    throw new Error(`image content does not match its declared media type (${declared})`);
  }
  if (sniffed === "image/svg+xml") {
    // Shared blocklist with the DOCX engine and logo-settings validation —
    // see @atlcli/confluence svg-safety.ts. Validate the SAME (BOM-aware
    // decoded) string that gets embedded, so a UTF-16 payload cannot hide a
    // <script> from the scanner.
    assertSafeSvg(decodeSvgSource(asset.bytes));
  }
  return { ...asset, mediaType: sniffed };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function extensionFor(asset: PdfResolvedAsset): string {
  const fromMime = EXTENSIONS[asset.mediaType.toLowerCase()];
  if (fromMime) return fromMime;
  const fromName = asset.filename?.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
  return fromName ?? "bin";
}

function assetKey(bytes: Uint8Array, mediaType: string): string {
  // Fast deterministic non-cryptographic hash for job-local deduplication.
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  for (let i = 0; i < mediaType.length; i += 1) {
    hash ^= mediaType.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface PreparePdfOptions {
  /** Granular progress callback (spec 002 — one event per embedded asset). */
  onProgress?: ExportProgressCallback;
  /**
   * Cancellation signal (spec 008 T3.2). Threaded into each asset resolve so an
   * in-flight fetch is actually aborted on Ctrl-C, and an `AbortError` aborts
   * the export rather than being swallowed as a per-image skip note.
   */
  signal?: AbortSignal;
  /**
   * Fallback provenance for emitted notes (spec 011, PDF/UA alt-text audit).
   * A block's own attachment `pageId` always wins; this fills the gap for
   * external images and single-page exports, where the host knows which page
   * is being exported but the block does not carry it. Purely descriptive —
   * it never changes what is rendered.
   */
  pageContext?: { pageId?: string; pageTitle?: string; pageUrl?: string };
}

/**
 * True when an image block carries no author-written alternative text.
 *
 * Whitespace-only alt counts as missing: a `alt=" "` attribute satisfies no
 * assistive technology, and Confluence's editor produces it readily.
 */
export function isMissingAltText(alt: string | undefined): boolean {
  return (alt ?? "").trim().length === 0;
}

/** True for a cancellation error, from either the DOM or Node abort surface. */
function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export async function preparePdfDocument(
  blocks: ExportBlock[],
  resolver: PdfAssetResolver,
  options: PreparePdfOptions = {}
): Promise<PreparedPdfDocument> {
  const assets: PreparedPdfAsset[] = [];
  const notes: ExportNote[] = [];
  const paths = new Map<
    string,
    Array<{ bytes: Uint8Array; mediaType: string; path: string }>
  >();
  const limit = createInOrderLimiter(PDF_ASSET_CONCURRENCY);
  // Shared total-byte cap + content dedup (spec 002); a breach throws
  // AssetBudgetExceededError, which propagates out of prepare and aborts the
  // export identically to the DOCX engine.
  const budget = new AssetBudget();
  const assetTotal = countAssetBlocks(blocks);
  let assetsDone = 0;
  const reportAsset = (detail?: string): void => {
    assetsDone += 1;
    options.onProgress?.({ phase: "assets", done: assetsDone, total: assetTotal, ...(detail ? { detail } : {}) });
  };

  const addAsset = (
    rawAsset: PdfResolvedAsset,
    prefix: string,
    meta: { filename: string; pageId?: string }
  ): string => {
    const asset = validateResolvedAsset(rawAsset);
    const key = assetKey(asset.bytes, asset.mediaType);
    const bucket = paths.get(key) ?? [];
    const existing = bucket.find(
      (candidate) =>
        candidate.mediaType === asset.mediaType && sameBytes(candidate.bytes, asset.bytes)
    );
    if (existing) return existing.path;
    // Account NEW bytes only (dedup handled above + inside the budget). Throws
    // AssetBudgetExceededError with the offender list on a total-cap breach.
    budget.account(asset.bytes, meta);
    const path = `assets/${prefix}-${assets.length + 1}-${key}.${extensionFor(asset)}`;
    assets.push({ path, bytes: asset.bytes, mediaType: asset.mediaType });
    bucket.push({ bytes: asset.bytes, mediaType: asset.mediaType, path });
    paths.set(key, bucket);
    return path;
  };

  // Block paths mirror the serializer's convention (`blocks[0].content[1]`,
  // `blocks[2].rows[0].cells[1].content[0]`) so a note's `source.blockPath` is
  // comparable across the prepare and serialize stages and against the PDF
  // source map.
  const walk = async (list: ExportBlock[], parentPath = "blocks"): Promise<PreparedPdfBlock[]> =>
    Promise.all(
      list.map(async (block, index): Promise<PreparedPdfBlock> => {
        const path = `${parentPath}[${index}]`;
        switch (block.type) {
          case "callout":
          case "expand":
            return { ...block, content: await walk(block.content, `${path}.content`) };
          case "blockquote":
            return { ...block, content: await walk(block.content, `${path}.content`) };
          case "orientation":
            return { ...block, content: await walk(block.content, `${path}.content`) };
          case "layout":
            return {
              ...block,
              columns: await Promise.all(block.columns.map(async (column, columnIndex) => ({
                ...column,
                content: await walk(
                  column.content,
                  `${path}.columns[${columnIndex}].content`,
                ),
              }))),
            };
          case "list":
            return {
              ...block,
              items: await Promise.all(
                block.items.map(async (item, itemIndex) => ({
                  ...item,
                  content: await walk(item.content, `${path}.items[${itemIndex}].content`),
                }))
              ),
            };
          case "table": {
            const materialized = materializeTable(block);
            return {
              ...block,
              rows: await Promise.all(
                materialized.rows.map(async (row, rowIndex) => ({
                  ...row,
                  cells: await Promise.all(
                    row.cells.map(async (cell, cellIndex) => ({
                      ...cell,
                      content: await walk(
                        cell.content,
                        `${path}.rows[${rowIndex}].cells[${cellIndex}].content`
                      ),
                    }))
                  ),
                }))
              ),
              ...(materialized.columnWidths !== undefined
                ? { columnWidths: materialized.columnWidths }
                : {}),
            };
          }
          case "image": {
            const fallbackLabel =
              block.alt ?? (block.source.kind === "attachment" ? block.source.filename : "Image");
            const filename = block.source.kind === "attachment" ? block.source.filename : block.source.url;
            const owningPage = block.source.kind === "attachment" ? block.source.pageId : undefined;
            // Alt-text audit (spec 011, PDF/UA 7.3). Emitted from the SOURCE
            // block, before any fetch — the defect is on the source page and is
            // independent of whether the bytes resolve, so a skipped image is
            // audited too. Provenance points the author at the exact page and
            // block to fix; without it "an image has no alt text" is unfixable
            // advice in a 500-page tree export.
            //
            // The code is the SHARED `image-missing-alt` (spec 010), the same one
            // `auditImageAltText` emits in `packages/docx/src/image.ts` from the
            // identical `isMissingAltText` rule. "This image has no alt text" is
            // a fact about the Confluence page, not about the output format, so
            // a consumer must not have to know which engine ran to filter for
            // it. The PDF note stays richer — it carries `source.blockPath`,
            // which the DOCX serializer cannot supply — but richer provenance
            // for the same fact is not a different fact.
            if (isMissingAltText(block.alt)) {
              const pageId = owningPage ?? options.pageContext?.pageId;
              const source = {
                ...(pageId ? { pageId } : {}),
                ...(options.pageContext?.pageTitle ? { pageTitle: options.pageContext.pageTitle } : {}),
                ...(options.pageContext?.pageUrl ? { pageUrl: options.pageContext.pageUrl } : {}),
                blockPath: path,
                assetName: filename,
              };
              notes.push({
                level: "warning",
                code: "image-missing-alt",
                message:
                  `The image "${filename}" has no alternative text; the exported PDF falls back to ` +
                  `a technical label, which assistive technology cannot use. Add alt text on the source page.`,
                source,
              });
            }
            try {
              const resolved = await limit(() =>
                resolver.resolve(
                  block.source.kind === "attachment"
                    ? {
                        kind: "attachment",
                        filename: block.source.filename,
                        ...(owningPage ? { pageId: owningPage } : {}),
                      }
                    : {
                        kind: "external",
                        url: block.source.url,
                        // Provenance marker (spec 004): export_view-derived URLs
                        // are untrusted; the host resolver routes them through
                        // its policy-checked external fetcher.
                        ...(block.source.trust ? { trust: block.source.trust } : {}),
                      },
                  options.signal ? { signal: options.signal } : {}
                )
              );
              const assetPath = addAsset(resolved, "image", {
                filename,
                ...(owningPage ? { pageId: owningPage } : {}),
              });
              reportAsset(filename);
              return {
                type: "image",
                assetPath,
                alt: block.alt,
                width: block.width,
                height: block.height,
                fallbackLabel,
                caption: block.caption,
              };
            } catch (error) {
              // A shared-budget breach is a FATAL scope-level error (same as
              // DOCX) — never a per-image warning. Let it abort the export.
              if (error instanceof AssetBudgetExceededError) throw error;
              // A cancellation must abort the whole export, not be downgraded to
              // a soft per-image skip note (spec 008 T3.2).
              if (isAbortError(error)) throw error;
              reportAsset(filename);
              // SHARED with DOCX (spec 010): one named image could not be
              // embedded, and here is why. The DOCX counterpart is the
              // `image-embed-failed` branch in `packages/docx/src/serialize.ts`
              // — same position in the pipeline (after the per-image fetch
              // failed), same warning level, same consequence (a fallback in
              // place of the picture).
              //
              // NOT `image-skipped`, despite this note's retired name
              // (`pdf-image-skipped`). `image-skipped` is DOCX's *info* note for
              // "this export was configured with no image pipeline at all", a
              // whole-export fact the PDF engine cannot even express: `resolver`
              // is a required parameter of `preparePdfDocument`.
              notes.push({
                level: "warning",
                code: "image-embed-failed",
                message: `${fallbackLabel} was not embedded: ${error instanceof Error ? error.message : String(error)}`,
              });
              return { type: "image", alt: block.alt, fallbackLabel, caption: block.caption };
            }
          }
          case "codeBlock": {
            if ((block.language ?? "").trim().toLowerCase() !== "mermaid") return block;
            const rendered = await renderDiagram(block.code);
            if (rendered.kind === "svg") {
              const bytes = new TextEncoder().encode(rendered.svg);
              const assetPath = addAsset(
                { bytes, mediaType: "image/svg+xml", filename: "diagram.svg" },
                "diagram",
                { filename: "diagram.svg" }
              );
              reportAsset("diagram.svg");
              return { type: "diagram", assetPath, source: block.code, caption: block.caption };
            }
            notes.push({
              level: rendered.kind === "unsupported" ? "info" : "warning",
              code:
                rendered.kind === "unsupported"
                  ? "pdf-diagram-unsupported"
                  : "pdf-diagram-failed",
              message:
                rendered.kind === "unsupported"
                  ? `${rendered.diagramType} diagram rendered as source code.`
                  : `Diagram rendered as source code: ${rendered.reason}`,
            });
            return block;
          }
          case "unknown": {
            // Placeholder floor (spec 004): prepare the preserved body so images
            // /tables inside an unresolved macro still render; keep plainBody.
            const prepared: PreparedPdfBlock = { type: "unknown", macroName: block.macroName };
            if (block.body && block.body.length > 0) prepared.body = await walk(block.body, `${path}.body`);
            if (block.plainBody !== undefined) prepared.plainBody = block.plainBody;
            return prepared;
          }
          case "heading":
          case "paragraph":
          case "mediaFallback":
          case "divider":
          case "pageBreak":
          case "anchor":
            return block;
          default: {
            const exhaustive: never = block;
            return exhaustive;
          }
        }
      })
    );

  return { blocks: await walk(blocks), assets, notes };
}

/** Count asset-bearing blocks (images + mermaid code) for progress totals. */
function countAssetBlocks(blocks: ExportBlock[]): number {
  let count = 0;
  const walk = (list: ExportBlock[]): void => {
    for (const block of list) {
      switch (block.type) {
        case "image":
          count += 1;
          break;
        case "codeBlock":
          if ((block.language ?? "").trim().toLowerCase() === "mermaid") count += 1;
          break;
        case "callout":
        case "expand":
        case "blockquote":
        case "orientation":
          walk(block.content);
          break;
        case "list":
          for (const item of block.items) walk(item.content);
          break;
        case "layout":
          for (const column of block.columns) walk(column.content);
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
