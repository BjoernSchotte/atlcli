import { renderDiagram } from "@atlcli/diagram";
import type { ExportBlock, ExportNote } from "@atlcli/confluence";
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

export const PDF_MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const PDF_MAX_TOTAL_ASSET_BYTES = 50 * 1024 * 1024;
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
    const source = new TextDecoder().decode(asset.bytes);
    if (
      /<\s*(?:script|foreignObject)\b/i.test(source) ||
      /\son[a-z]+\s*=/i.test(source) ||
      /(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|data:)/i.test(source)
    ) {
      throw new Error("SVG contains active or externally loaded content");
    }
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

function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  let issued = 0;
  let nextToDeliver = 0;
  const queue: Array<{
    index: number;
    task: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }> = [];
  const finished = new Map<
    number,
    { ok: true; value: unknown } | { ok: false; reason: unknown }
  >();

  const flush = (): void => {
    while (finished.has(nextToDeliver)) {
      const result = finished.get(nextToDeliver)!;
      finished.delete(nextToDeliver);
      const item = delivered.get(nextToDeliver)!;
      delivered.delete(nextToDeliver);
      if (result.ok) item.resolve(result.value);
      else item.reject(result.reason);
      nextToDeliver += 1;
    }
  };
  const delivered = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  const next = (): void => {
    while (active < limit) {
      const item = queue.shift();
      if (!item) return;
      active += 1;
      void item.task()
        .then(
          (value) => finished.set(item.index, { ok: true, value }),
          (reason) => finished.set(item.index, { ok: false, reason })
        )
        .finally(() => {
          active -= 1;
          flush();
          next();
        });
    }
  };
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const index = issued;
      issued += 1;
      delivered.set(index, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      queue.push({ index, task, resolve: resolve as (value: unknown) => void, reject });
      next();
    });
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

export async function preparePdfDocument(
  blocks: ExportBlock[],
  resolver: PdfAssetResolver
): Promise<PreparedPdfDocument> {
  const assets: PreparedPdfAsset[] = [];
  const notes: ExportNote[] = [];
  const paths = new Map<
    string,
    Array<{ bytes: Uint8Array; mediaType: string; path: string }>
  >();
  const limit = createLimiter(PDF_ASSET_CONCURRENCY);
  let totalAssetBytes = 0;

  const addAsset = (rawAsset: PdfResolvedAsset, prefix: string): string => {
    const asset = validateResolvedAsset(rawAsset);
    const key = assetKey(asset.bytes, asset.mediaType);
    const bucket = paths.get(key) ?? [];
    const existing = bucket.find(
      (candidate) =>
        candidate.mediaType === asset.mediaType && sameBytes(candidate.bytes, asset.bytes)
    );
    if (existing) return existing.path;
    if (totalAssetBytes + asset.bytes.byteLength > PDF_MAX_TOTAL_ASSET_BYTES) {
      throw new Error("the PDF exceeds the 50 MB total image limit");
    }
    const path = `assets/${prefix}-${assets.length + 1}-${key}.${extensionFor(asset)}`;
    assets.push({ path, bytes: asset.bytes, mediaType: asset.mediaType });
    totalAssetBytes += asset.bytes.byteLength;
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
            try {
              const resolved = await limit(() =>
                resolver.resolve(
                  block.source.kind === "attachment"
                    ? { kind: "attachment", filename: block.source.filename }
                    : { kind: "external", url: block.source.url }
                )
              );
              return {
                type: "image",
                assetPath: addAsset(resolved, "image"),
                alt: block.alt,
                width: block.width,
                height: block.height,
                fallbackLabel,
              };
            } catch (error) {
              notes.push({
                level: "warning",
                code: "pdf-image-skipped",
                message: `${fallbackLabel} was not embedded: ${error instanceof Error ? error.message : String(error)}`,
              });
              return { type: "image", alt: block.alt, fallbackLabel };
            }
          }
          case "codeBlock": {
            if ((block.language ?? "").trim().toLowerCase() !== "mermaid") return block;
            const rendered = await renderDiagram(block.code);
            if (rendered.kind === "svg") {
              const bytes = new TextEncoder().encode(rendered.svg);
              const assetPath = addAsset(
                { bytes, mediaType: "image/svg+xml", filename: "diagram.svg" },
                "diagram"
              );
              return { type: "diagram", assetPath, source: block.code };
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
          case "heading":
          case "paragraph":
          case "divider":
          case "unknown":
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
