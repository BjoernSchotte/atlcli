import type { ExportBlock, ImageSource } from "@atlcli/export-blocks";

export interface AstroResolvedHeadingV1 {
  id: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}

export interface AstroResolvedLinkV1 {
  href: string;
  kind: "page" | "asset" | "external" | "unresolved";
}

export interface AstroResolvedAssetV1 {
  src: string;
  mediaType: string;
  alt?: string;
}

/**
 * The render-kit deliberately accepts only normalized block data plus
 * pre-resolved, render-safe publication context. It never decodes ADF/Storage
 * and never performs network access.
 */
export interface AstroExportBlockRenderContextV1 {
  locale: string;
  direction: "ltr" | "rtl";
  headings: Readonly<Record<string, AstroResolvedHeadingV1>>;
  links: Readonly<Record<string, AstroResolvedLinkV1>>;
  assets: Readonly<Record<string, AstroResolvedAssetV1>>;
  notes: "inline" | "collect" | "omit-noncritical";
}

/** Input contract reserved for the future exhaustive `ExportDocument.astro`. */
export interface AstroExportDocumentPropsV1 {
  blocks: readonly ExportBlock[];
  context: AstroExportBlockRenderContextV1;
}

/** Stable asset-context key; the source URL itself is never a rendering input. */
export function astroExportAssetKeyV1(source: ImageSource): string {
  return source.kind === "attachment"
    ? `attachment:${source.pageId ?? ""}:${source.filename}`
    : `external:${source.url}`;
}

/** The stable semantic marker prefix used by the render kit's stylesheet. */
export const ASTRO_EXPORT_BLOCKS_DATA_PREFIX_V1 = "data-atlcli-block";
