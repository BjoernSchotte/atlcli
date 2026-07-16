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
  const paths = new Map<string, string>();

  const addAsset = (asset: PdfResolvedAsset, prefix: string): string => {
    const key = assetKey(asset.bytes, asset.mediaType);
    const existing = paths.get(key);
    if (existing) return existing;
    const path = `assets/${prefix}-${assets.length + 1}-${key}.${extensionFor(asset)}`;
    assets.push({ path, bytes: asset.bytes, mediaType: asset.mediaType });
    paths.set(key, path);
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
              const resolved = await resolver.resolve(
                block.source.kind === "attachment"
                  ? { kind: "attachment", filename: block.source.filename }
                  : { kind: "external", url: block.source.url }
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
