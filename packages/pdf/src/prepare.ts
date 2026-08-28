import { renderDiagram } from "@atlcli/diagram";
import {
  ASSET_MAX_BYTES,
  ASSET_MAX_TOTAL_BYTES,
  AssetBudget,
  AssetBudgetExceededError,
  AssetPipelineError,
  createInOrderLimiter,
  inlineMediaDisplayText,
  materializeTable,
  type ExportProgressCallback,
} from "@atlcli/confluence";
import type { Caption, ExportBlock, ExportNote, InlineNode } from "@atlcli/confluence";
import { renderTanStackChartSvgV1 } from "@atlcli/export-charts-tanstack";
import { assertSafeSvg } from "./svg-safety.js";
import { decodeSvgSource } from "@atlcli/confluence";
import {
  normalizeRasterAssetV1,
  resolveEffectivePpi,
  type ExportImageQualityV1,
  type RasterNormalizerPortV1,
} from "@atlcli/export-media";
import { LANDSCAPE_TEXT_WIDTH_PT, PORTRAIT_TEXT_WIDTH_PT } from "./serialize.js";
import type {
  PdfAssetResolver,
  PdfResolvedAsset,
  PreparedPdfAsset,
  PreparedPdfBlock,
  PreparedPdfCaption,
  PreparedPdfDocument,
  PreparedPdfInlineNode,
} from "./types.js";
import {
  canonicalCodeLanguage,
  DEFAULT_CODE_THEME,
  type CodeLanguageId,
  type CodeThemeId,
} from "@atlcli/code-highlight/registry";
import {
  highlightCodeWithRuntime,
  loadCodeHighlightRuntime,
  plainCodeHighlight,
  type CodeHighlightRuntime,
  type CodeHighlightRuntimeLoader,
} from "@atlcli/code-highlight/contract";

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

// Benchmark-only budget seam (issue #118 Phase 0): the ≥100 MiB image-heavy
// corpus must flow through the REAL preparation pipeline, and the product
// caps must not gain a public override to make that possible. Same Symbol.for
// pattern as the compiler memory probes — only a benchmark harness installs
// it on globalThis; release configuration has no path to it.
const BENCHMARK_ASSET_BUDGET = Symbol.for("atlcli.pdf.benchmark-asset-budget");

interface BenchmarkAssetBudgetOverride {
  maxAssetBytes?: number;
  maxTotalBytes?: number;
}

interface BenchmarkAssetBudgetHost {
  [BENCHMARK_ASSET_BUDGET]?: BenchmarkAssetBudgetOverride;
}

function benchmarkAssetBudget(): BenchmarkAssetBudgetOverride | undefined {
  return (globalThis as BenchmarkAssetBudgetHost)[BENCHMARK_ASSET_BUDGET];
}

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

function validateResolvedAsset(
  asset: PdfResolvedAsset,
  maxAssetBytes: number
): PdfResolvedAsset {
  if (asset.bytes.byteLength === 0) throw new Error("the fetched image was empty");
  if (asset.bytes.byteLength > maxAssetBytes) {
    throw new Error(
      `the image exceeds the ${Math.floor(maxAssetBytes / (1024 * 1024))} MB per-file limit`
    );
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
  /** Resolved bundled Shiki theme for every non-diagram code block. */
  codeTheme?: CodeThemeId;
  /** Lazy host adapter. Omitted means use package conditions after known usage. */
  codeHighlightRuntimeLoader?: CodeHighlightRuntimeLoader;
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
  /**
   * Explicit image-quality request (issue #118 Phase 1). Absent or
   * `original` keeps every raster byte untouched. `standard`/`print` (or an
   * `imagePpi` override) deterministically downscale rasters to the render
   * envelope × PPI before embedding — smaller decoded rasters shrink both
   * the host bundle and Typst's in-WASM decode footprint. Never upscales,
   * never touches SVG/vector, keeps JPEG as JPEG and alpha lossless, and
   * keeps the ORIGINAL bytes for anything it cannot decode faithfully.
   */
  imageQuality?: ExportImageQualityV1;
  /**
   * Optional async raster host used by browser runtimes. Omitted keeps the
   * pinned pure-TypeScript implementation. The port changes only pixel
   * decode/resize execution; target geometry and output codec remain shared.
   */
  rasterNormalizer?: RasterNormalizerPortV1;
}

/**
 * Conservative render-envelope cap for profile normalization: the portrait
 * usable text width, or the landscape width when the document contains ANY
 * landscape orientation block. A per-use envelope propagated from layout is
 * the finer future refinement; this v1 heuristic only ever OVER-estimates
 * the rendered size, so it can never downscale below what layout shows.
 */
function renderEnvelopeWidthPt(blocks: ExportBlock[]): number {
  const containsLandscape = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(containsLandscape);
    const record = value as Record<string, unknown>;
    if (record.type === "orientation" && record.landscape === true) return true;
    return Object.values(record).some(containsLandscape);
  };
  return containsLandscape(blocks) ? LANDSCAPE_TEXT_WIDTH_PT : PORTRAIT_TEXT_WIDTH_PT;
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

/** Distinct known non-diagram grammars, in first-occurrence order. */
function collectPdfCodeHighlightLanguages(
  blocks: readonly ExportBlock[],
): CodeLanguageId[] {
  const languages = new Set<CodeLanguageId>();
  const walk = (list: readonly ExportBlock[]): void => {
    for (const block of list) {
      switch (block.type) {
        case "codeBlock": {
          const requested = (block.language ?? "").trim().toLowerCase();
          if (requested === "mermaid") break;
          const canonical = canonicalCodeLanguage(requested);
          if (canonical) languages.add(canonical);
          break;
        }
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
          for (const row of block.rows) {
            for (const cell of row.cells) walk(cell.content);
          }
          break;
        case "unknown":
          if (block.body) walk(block.body);
          for (const frame of block.extensionFrames ?? []) walk(frame.content);
          break;
      }
    }
  };
  walk(blocks);
  return [...languages];
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
  const highlightLanguages = collectPdfCodeHighlightLanguages(blocks);
  let highlightRuntimePromise: Promise<CodeHighlightRuntime> | undefined;
  const getHighlightRuntime = (): Promise<CodeHighlightRuntime> => {
    highlightRuntimePromise ??= (
      options.codeHighlightRuntimeLoader ?? loadCodeHighlightRuntime
    )();
    return highlightRuntimePromise;
  };
  const highlightPreload =
    highlightLanguages.length > 0
      ? getHighlightRuntime()
          .then((runtime) =>
            runtime.prepare(
              highlightLanguages,
              options.codeTheme ?? DEFAULT_CODE_THEME,
            ),
          )
          .catch(() => {
            // A loaded runtime can retry a grammar; an unavailable runtime
            // retains the plain-text fallback.
          })
      : Promise.resolve();
  const paths = new Map<
    string,
    Array<{ bytes: Uint8Array; mediaType: string; path: string }>
  >();
  const limit = createInOrderLimiter(PDF_ASSET_CONCURRENCY);
  // Shared total-byte cap + content dedup (spec 002); a breach throws
  // AssetBudgetExceededError, which propagates out of prepare and aborts the
  // export identically to the DOCX engine. Snapshot the benchmark override
  // once so a mid-prepare hook change cannot split the caps.
  const budgetOverride = benchmarkAssetBudget();
  const maxAssetBytes = budgetOverride?.maxAssetBytes ?? PDF_MAX_ASSET_BYTES;
  const budget = new AssetBudget(
    budgetOverride?.maxTotalBytes === undefined
      ? {}
      : { maxTotalBytes: budgetOverride.maxTotalBytes }
  );
  // Explicit image profile (issue #118 Phase 1): resolve the effective PPI
  // once (throws on an invalid request BEFORE any asset is fetched) and track
  // aggregate-only diagnostics — counts and bytes, never media or names.
  const effectivePpi = options.imageQuality ? resolveEffectivePpi(options.imageQuality) : null;
  const envelopePt = effectivePpi === null ? 0 : renderEnvelopeWidthPt(blocks);
  const normalizeRaster = options.rasterNormalizer
    ? (request: Parameters<RasterNormalizerPortV1["normalize"]>[0]) =>
        options.rasterNormalizer!.normalize(request)
    : normalizeRasterAssetV1;
  // Decoded rasters are the largest prepare-side allocation. The port may be
  // backed by native browser APIs, but PDF preparation still owns the
  // single-heavy-work invariant and deterministic completion order.
  const normalizeLimit = createInOrderLimiter(1);
  const profileStats = {
    normalized: 0,
    sourceBytes: 0,
    normalizedBytes: 0,
    kept: new Map<string, number>(),
  };
  const assetTotal = countAssetBlocks(blocks);
  let assetsDone = 0;
  const reportAsset = (detail?: string): void => {
    assetsDone += 1;
    options.onProgress?.({ phase: "assets", done: assetsDone, total: assetTotal, ...(detail ? { detail } : {}) });
  };

  const addAsset = async (
    rawAsset: PdfResolvedAsset,
    prefix: string,
    meta: { filename: string; pageId?: string; authoredWidthPx?: number }
  ): Promise<string> => {
    let asset = validateResolvedAsset(rawAsset, maxAssetBytes);
    if (effectivePpi !== null) {
      const normalized = await normalizeLimit(() =>
        Promise.resolve(normalizeRaster({
          bytes: asset.bytes,
          mediaType: asset.mediaType,
          renderEnvelopeWidthPt: envelopePt,
          ppi: effectivePpi,
          ...(meta.authoredWidthPx !== undefined
            ? { authored: { widthPx: meta.authoredWidthPx } }
            : {}),
        })),
      );
      if (normalized.kind === "normalized") {
        profileStats.normalized += 1;
        profileStats.sourceBytes += asset.bytes.byteLength;
        profileStats.normalizedBytes += normalized.bytes.byteLength;
        asset = { ...asset, bytes: normalized.bytes, mediaType: normalized.mediaType };
      } else {
        profileStats.kept.set(
          normalized.reason,
          (profileStats.kept.get(normalized.reason) ?? 0) + 1,
        );
      }
    }
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

  const prepareInline = async (
    nodes: InlineNode[],
    parentPath: string,
  ): Promise<PreparedPdfInlineNode[]> =>
    Promise.all(nodes.map(async (node, index): Promise<PreparedPdfInlineNode> => {
      const path = `${parentPath}[${index}]`;
      if (node.type === "link") {
        return { ...node, content: await prepareInline(node.content, `${path}.content`) };
      }
      if (node.type !== "media") return node;

      const fallbackLabel = inlineMediaDisplayText(node);
      if (!node.source) return { ...node, fallbackLabel };
      const filename =
        node.source.kind === "attachment" ? node.source.filename : node.source.url;
      const owningPage =
        node.source.kind === "attachment" ? node.source.pageId : undefined;
      if (isMissingAltText(node.alt)) {
        const pageId = owningPage ?? options.pageContext?.pageId;
        notes.push({
          level: "warning",
          code: "image-missing-alt",
          message:
            `The inline image "${filename}" has no alternative text; the exported PDF falls back to ` +
            `a technical label, which assistive technology cannot use. Add alt text on the source page.`,
          source: {
            ...(pageId ? { pageId } : {}),
            ...(options.pageContext?.pageTitle
              ? { pageTitle: options.pageContext.pageTitle }
              : {}),
            ...(options.pageContext?.pageUrl ? { pageUrl: options.pageContext.pageUrl } : {}),
            blockPath: path,
            assetName: filename,
          },
        });
      }
      try {
        const resolved = await limit(() =>
          resolver.resolve(
            node.source!.kind === "attachment"
              ? {
                  kind: "attachment",
                  filename: node.source!.filename,
                  ...(owningPage ? { pageId: owningPage } : {}),
                }
              : {
                  kind: "external",
                  url: node.source!.url,
                  ...(node.source!.trust ? { trust: node.source!.trust } : {}),
                },
            options.signal ? { signal: options.signal } : {},
          ),
        );
        const assetPath = await addAsset(resolved, "inline-image", {
          filename,
          ...(owningPage ? { pageId: owningPage } : {}),
          ...(node.width !== undefined ? { authoredWidthPx: node.width } : {}),
        });
        reportAsset(filename);
        return { ...node, assetPath, fallbackLabel };
      } catch (error) {
        if (error instanceof AssetBudgetExceededError) throw error;
        if (isAbortError(error)) throw error;
        reportAsset(filename);
        notes.push({
          level: "warning",
          code: "image-embed-failed",
          message: `${fallbackLabel} was not embedded: ${error instanceof Error ? error.message : String(error)}`,
          source: {
            ...(owningPage ? { pageId: owningPage } : {}),
            blockPath: path,
            assetName: filename,
          },
        });
        return { ...node, fallbackLabel };
      }
    }));

  const prepareCaption = async (
    caption: Caption | undefined,
    path: string,
  ): Promise<PreparedPdfCaption | undefined> =>
    caption
      ? { ...caption, content: await prepareInline(caption.content, `${path}.content`) }
      : undefined;

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
            const caption = await prepareCaption(block.caption, `${path}.caption`);
            const { caption: _sourceCaption, ...table } = block;
            return {
              ...table,
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
              ...(caption ? { caption } : {}),
            };
          }
          case "image": {
            const caption = await prepareCaption(block.caption, `${path}.caption`);
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
              const assetPath = await addAsset(resolved, "image", {
                filename,
                ...(owningPage ? { pageId: owningPage } : {}),
                ...(block.width !== undefined ? { authoredWidthPx: block.width } : {}),
              });
              reportAsset(filename);
              return {
                type: "image",
                assetPath,
                alt: block.alt,
                width: block.width,
                height: block.height,
                fallbackLabel,
                ...(block.media ? { media: block.media } : {}),
                ...(block.mediaPresentation ? { mediaPresentation: block.mediaPresentation } : {}),
                ...(block.mediaGroup ? { mediaGroup: block.mediaGroup } : {}),
                ...(block.border ? { border: block.border } : {}),
                ...(block.annotations ? { annotations: block.annotations } : {}),
                ...(caption ? { caption } : {}),
                ...(block.link ? { link: block.link } : {}),
              };
            } catch (error) {
              // A shared-budget breach is a FATAL scope-level error (same as
              // DOCX) — never a per-image warning. Let it abort the export.
              if (
                error instanceof AssetBudgetExceededError ||
                error instanceof AssetPipelineError
              ) {
                throw error;
              }
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
              return {
                type: "image",
                alt: block.alt,
                width: block.width,
                height: block.height,
                fallbackLabel,
                ...(block.media ? { media: block.media } : {}),
                ...(block.mediaPresentation ? { mediaPresentation: block.mediaPresentation } : {}),
                ...(block.mediaGroup ? { mediaGroup: block.mediaGroup } : {}),
                ...(block.border ? { border: block.border } : {}),
                ...(block.annotations ? { annotations: block.annotations } : {}),
                ...(caption ? { caption } : {}),
                ...(block.link ? { link: block.link } : {}),
              };
            }
          }
          case "codeBlock": {
            const caption = await prepareCaption(block.caption, `${path}.caption`);
            const { caption: _sourceCaption, ...codeBlock } = block;
            if ((block.language ?? "").trim().toLowerCase() !== "mermaid") {
              const canonical = block.language
                ? canonicalCodeLanguage(block.language)
                : undefined;
              const highlight = await highlightCodeWithRuntime(
                canonical
                  ? await getHighlightRuntime().catch(() => undefined)
                  : undefined,
                block.code,
                block.language,
                options.codeTheme ?? DEFAULT_CODE_THEME,
              );
              if (highlight.skipped) {
                notes.push({
                  level: "info",
                  code: "code-highlight-skipped",
                  message: `Code block${block.language ? ` (${block.language})` : ""} was not syntax-highlighted (${highlight.skipped}); rendered as plain monospace.`,
                  source: { blockPath: path },
                });
              }
              return { ...codeBlock, highlight, ...(caption ? { caption } : {}) };
            }
            const rendered = await renderDiagram(block.code);
            if (rendered.kind === "svg") {
              const bytes = new TextEncoder().encode(rendered.svg);
              const assetPath = await addAsset(
                { bytes, mediaType: "image/svg+xml", filename: "diagram.svg" },
                "diagram",
                { filename: "diagram.svg" }
              );
              reportAsset("diagram.svg");
              return {
                type: "diagram",
                assetPath,
                source: block.code,
                ...(caption ? { caption } : {}),
                ...(block.wrap !== undefined ? { wrap: block.wrap } : {}),
                ...(block.hideLineNumbers !== undefined
                  ? { hideLineNumbers: block.hideLineNumbers }
                  : {}),
                ...(block.firstLineNumber !== undefined
                  ? { firstLineNumber: block.firstLineNumber }
                  : {}),
                ...(block.title !== undefined ? { title: block.title } : {}),
                ...(block.initiallyCollapsed !== undefined
                  ? { initiallyCollapsed: block.initiallyCollapsed }
                  : {}),
                ...(block.localId !== undefined ? { localId: block.localId } : {}),
                ...(block.uniqueId !== undefined ? { uniqueId: block.uniqueId } : {}),
              };
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
            const highlight = plainCodeHighlight(
              block.code,
              options.codeTheme ?? DEFAULT_CODE_THEME,
            );
            if (highlight.skipped) {
              notes.push({
                level: "info",
                code: "code-highlight-skipped",
                message: `Code block (${block.language}) was not syntax-highlighted (${highlight.skipped}); rendered as plain monospace.`,
                source: { blockPath: path },
              });
            }
            return { ...codeBlock, highlight, ...(caption ? { caption } : {}) };
          }
          case "unknown": {
            // Placeholder floor (spec 004): prepare the preserved body so images
            // /tables inside an unresolved macro still render. Every non-body
            // field is provenance and must survive this target preparation.
            const { body, extensionFrames, ...metadata } = block;
            return {
              ...metadata,
              ...(block.plainBody
                ? {
                    plainBodyHighlight: plainCodeHighlight(
                      block.plainBody.slice(0, 20_000),
                      options.codeTheme ?? DEFAULT_CODE_THEME,
                    ),
                  }
                : {}),
              ...(body
                ? { body: await walk(body, `${path}.body`) }
                : {}),
              ...(extensionFrames
                ? {
                    extensionFrames: await Promise.all(
                      extensionFrames.map(async (frame, index) => ({
                        ...frame,
                        content: await walk(
                          frame.content,
                          `${path}.extensionFrames[${index}].content`,
                        ),
                      })),
                    ),
                  }
                : {}),
            };
          }
          case "heading":
          case "paragraph":
            return {
              ...block,
              content: await prepareInline(block.content, `${path}.content`),
            };
          case "mediaFallback": {
            const caption = await prepareCaption(block.caption, `${path}.caption`);
            const { caption: _sourceCaption, ...fallback } = block;
            return { ...fallback, ...(caption ? { caption } : {}) };
          }
          case "chart": {
            const caption = await prepareCaption(block.caption, `${path}.caption`);
            const { caption: _sourceCaption, ...chart } = block;
            const svg = renderTanStackChartSvgV1(block.chart);
            const visualAssetPath = await addAsset(
              { bytes: new TextEncoder().encode(svg), mediaType: "image/svg+xml", filename: "chart.svg" },
              "chart",
              { filename: "chart.svg" },
            );
            return { ...chart, visualAssetPath, ...(caption ? { caption } : {}) };
          }
          case "smartCard":
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

  const preparedBlocks = await walk(blocks);
  await highlightPreload;
  if (effectivePpi !== null && (profileStats.normalized > 0 || profileStats.kept.size > 0)) {
    // ONE aggregate diagnostics note (PLAN.md privacy rule): counts, bytes,
    // and reasons only — never media bytes, filenames, or tenant data.
    const keptSummary = [...profileStats.kept.entries()]
      .map(([reason, count]) => `${reason}: ${count}`)
      .join(", ");
    notes.push({
      level: "info",
      code: "image-profile-applied",
      message:
        `Image profile "${options.imageQuality!.imageProfile}"` +
        `${options.imageQuality!.imagePpi ? ` (${options.imageQuality!.imagePpi} PPI)` : ""}` +
        ` normalized ${profileStats.normalized} raster asset(s): ` +
        `${(profileStats.sourceBytes / 1048576).toFixed(2)} MiB source -> ` +
        `${(profileStats.normalizedBytes / 1048576).toFixed(2)} MiB embedded` +
        `${keptSummary ? `; kept untouched (${keptSummary})` : ""}.`,
    });
  }
  return { blocks: preparedBlocks, assets, notes };
}

/** Count asset-bearing blocks (images + mermaid code) for progress totals. */
function countAssetBlocks(blocks: ExportBlock[]): number {
  let count = 0;
  const countInline = (nodes: InlineNode[]): void => {
    for (const node of nodes) {
      if (node.type === "link") countInline(node.content);
      else if (node.type === "media" && node.source) count += 1;
    }
  };
  const countCaption = (caption: Caption | undefined): void => {
    if (caption) countInline(caption.content);
  };
  const walk = (list: ExportBlock[]): void => {
    for (const block of list) {
      switch (block.type) {
        case "heading":
        case "paragraph":
          countInline(block.content);
          break;
        case "image":
          count += 1;
          countCaption(block.caption);
          break;
        case "codeBlock":
          countCaption(block.caption);
          if ((block.language ?? "").trim().toLowerCase() === "mermaid") count += 1;
          break;
        case "mediaFallback":
          countCaption(block.caption);
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
          countCaption(block.caption);
          for (const row of block.rows) for (const cell of row.cells) walk(cell.content);
          break;
      }
    }
  };
  walk(blocks);
  return count;
}
