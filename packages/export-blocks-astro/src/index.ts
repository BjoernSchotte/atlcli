import type { ExportBlock, ImageSource, LinkTarget } from "@atlcli/export-blocks";
import type { AstroExportBlockOverrideSlotV1 } from "./overrides.js";

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
  /** Optional build-generated responsive variants; URLs are validated at render time. */
  srcset?: readonly { src: string; width: number; mediaType?: string }[];
  sizes?: string;
  width?: number;
  height?: number;
  /** Optional verified original/download URL, never inferred from source content. */
  downloadHref?: string;
  downloadName?: string;
  mode?: "verified-original" | "astro-responsive";
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
  /** Stable export-block visitor paths to the planner's page-local heading IDs. */
  headingAnchors?: Readonly<Record<string, string>>;
  links: Readonly<Record<string, AstroResolvedLinkV1>>;
  assets: Readonly<Record<string, AstroResolvedAssetV1>>;
  notes: "inline" | "collect" | "omit-noncritical";
}

/**
 * Structural component input deliberately avoids importing Astro internals in
 * the public declaration build. Astro projects pass a statically imported
 * `.astro` factory; source content can never provide one.
 */
export type AstroExportBlockOverrideComponentV1 = (props: Record<string, unknown>) => unknown;

/** Components statically imported by trusted Astro project code at build time. */
export type AstroExportBlockOverridesV1 = Readonly<Partial<Record<
  AstroExportBlockOverrideSlotV1,
  AstroExportBlockOverrideComponentV1
>>>;

/** Input contract reserved for the future exhaustive `ExportDocument.astro`. */
export interface AstroExportDocumentPropsV1 {
  blocks: readonly ExportBlock[];
  context: AstroExportBlockRenderContextV1;
  overrides?: AstroExportBlockOverridesV1;
}

/** Stable asset-context key; the source URL itself is never a rendering input. */
export function astroExportAssetKeyV1(source: ImageSource): string {
  return source.kind === "attachment"
    ? `attachment:${source.pageId ?? ""}:${source.filename}`
    : `external:${source.url}`;
}

/** Stable semantic lookup key for a trusted link resolver. */
export function astroExportLinkKeyV1(target: LinkTarget): string {
  switch (target.kind) {
    case "external": return JSON.stringify(["external", target.href]);
    case "page": return JSON.stringify(["page", target.contentId ?? target.contentTitle, target.anchor ?? ""]);
    case "attachment": return JSON.stringify(["attachment", target.filename]);
    case "anchor": return JSON.stringify(["anchor", target.anchor]);
  }
}

/** The stable semantic marker prefix used by the render kit's stylesheet. */
export const ASTRO_EXPORT_BLOCKS_DATA_PREFIX_V1 = "data-atlcli-block";

export {
  ASTRO_EXPORT_BLOCK_OVERRIDE_SLOTS_V1,
  AstroExportBlockOverrideErrorV1,
  createAstroExportBlockOverrideRegistryV1,
  type AstroExportBlockOverrideDescriptorV1,
  type AstroExportBlockOverrideSelectionV1,
  type AstroExportBlockOverrideSlotV1,
} from "./overrides.js";

export {
  StaticChartValidationErrorV1,
  TANSTACK_CHART_RENDERER_ADAPTER_V1,
  normalizeStaticChartV1,
  resolveChartRendererAdapterV1,
  validateInteractiveChartV1,
  type ChartRendererAdapterIdV1,
  type ChartRendererAdapterV1,
  type NormalizedStaticChartV1,
  type StaticChartModelV1,
  type StaticChartSeriesV1,
} from "./charts.js";
