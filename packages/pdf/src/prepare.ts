import { renderDiagram } from "@atlcli/diagram";
import {
  ASSET_MAX_BYTES,
  ASSET_MAX_TOTAL_BYTES,
  AssetBudget,
  AssetBudgetExceededError,
  createInOrderLimiter,
  type ExportProgressCallback,
} from "@atlcli/confluence";
import type { ExportBlock, ExportNote } from "@atlcli/confluence";
import { assertSafeSvg } from "./svg-safety.js";
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
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 2048)));
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
    // see @atlcli/confluence svg-safety.ts. Validate the SAME decoded string
    // that gets embedded (no separately-decoded copy).
    assertSafeSvg(new TextDecoder().decode(asset.bytes));
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

  const walk = async (list: ExportBlock[]): Promise<PreparedPdfBlock[]> =>
    Promise.all(
      list.map(async (block): Promise<PreparedPdfBlock> => {
        switch (block.type) {
          case "callout":
            return { ...block, content: await walk(block.content) };
          case "blockquote":
            return { ...block, content: await walk(block.content) };
          case "orientation":
            return { ...block, content: await walk(block.content) };
          case "list":
            return {
              ...block,
              items: await Promise.all(
                block.items.map(async (item) => ({ ...item, content: await walk(item.content) }))
              ),
            };
          case "table":
            return {
              ...block,
              rows: await Promise.all(
                block.rows.map(async (row) => ({
                  cells: await Promise.all(
                    row.cells.map(async (cell) => ({ ...cell, content: await walk(cell.content) }))
                  ),
                }))
              ),
            };
          case "image": {
            const fallbackLabel =
              block.alt ?? (block.source.kind === "attachment" ? block.source.filename : "Image");
            const filename = block.source.kind === "attachment" ? block.source.filename : block.source.url;
            const owningPage = block.source.kind === "attachment" ? block.source.pageId : undefined;
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
              notes.push({
                level: "warning",
                code: "pdf-image-skipped",
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
            if (block.body && block.body.length > 0) prepared.body = await walk(block.body);
            if (block.plainBody !== undefined) prepared.plainBody = block.plainBody;
            return prepared;
          }
          case "heading":
          case "paragraph":
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
