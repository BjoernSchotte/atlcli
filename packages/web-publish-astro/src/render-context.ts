import {
  astroExportAssetKeyV1,
  astroExportLinkKeyV1,
  type AstroExportBlockRenderContextV1,
  type AstroResolvedAssetV1,
  type AstroResolvedHeadingV1,
  type AstroResolvedLinkV1,
} from "@atlcli/export-blocks-astro";
import { visitExportBlocksV1, type ExportBlock, type ImageSource } from "@atlcli/export-blocks";
import { normalizePublicationAnchorReferenceV1, planPublicationAnchorsV1, type PublicationBundleV1, type PublicationPageV1 } from "@atlcli/web-publish";

export interface CreatePublicationRenderContextOptionsV1 {
  page: PublicationPageV1;
  bundle: PublicationBundleV1;
  /** URL base without a trailing slash; `/` is accepted. */
  base?: string;
  /** Route namespace owned by the trusted Astro project. */
  routePrefix?: string;
  /** All loaded pages, used only to resolve target-page anchor slugs. */
  pages?: readonly PublicationPageV1[];
  locale?: string;
  direction?: "ltr" | "rtl";
}

function normalizedBase(base: string | undefined): string {
  if (base === undefined || base === "") return "";
  if (base === "//") throw new TypeError("publication render context base must be a safe absolute path");
  const value = base.endsWith("/") ? base.slice(0, -1) : base;
  if (!value.startsWith("/") || value.includes("//") || value.includes("\\") || value.includes("?") || value.includes("#")) {
    throw new TypeError("publication render context base must be a safe absolute path");
  }
  return value;
}

function normalizedPrefix(prefix: string | undefined): string {
  if (prefix === undefined || prefix === "" || prefix === "/") return "";
  if (!prefix.startsWith("/") || prefix.endsWith("/") || prefix.includes("//") || prefix.includes("\\") || prefix.includes("?") || prefix.includes("#")) {
    throw new TypeError("publication render context routePrefix must be a safe absolute path");
  }
  return prefix;
}

function routeHref(base: string, prefix: string, route: string): string {
  if (!route.startsWith("/") || route.includes("\\") || route.includes("//") || route.includes("?") || route.includes("#") || route.split("/").some((segment) => segment === ".." || segment === ".")) {
    throw new TypeError(`publication route is not safe: ${route}`);
  }
  const normalizedRoute = route === "/" ? "" : route.replace(/^\/+|\/+$/gu, "");
  return `${base}${prefix}${normalizedRoute ? `/${normalizedRoute}/` : "/"}`;
}

function outputAssetHref(base: string, path: string): string {
  if (!path.startsWith("assets/") || path.includes("..") || path.includes("\\") || path.includes("//")) {
    throw new TypeError(`publication asset path is not safe: ${path}`);
  }
  return `${base}/${path}`;
}

function collectHeadings(blocks: readonly ExportBlock[]): readonly AstroResolvedHeadingV1[] {
  return planPublicationAnchorsV1(blocks)
    .filter((anchor) => anchor.kind === "heading")
    .map((anchor) => ({
      id: anchor.anchorId,
      level: anchor.level ?? 2,
      text: anchor.text ?? "",
    }));
}

function collectAssetSources(pageId: string, blocks: readonly ExportBlock[]): readonly ImageSource[] {
  const sources: ImageSource[] = [];
  const seen = new Set<string>();
  visitExportBlocksV1(blocks, {
    block(block) {
      if (block.type !== "image") return;
      const key = astroExportAssetKeyV1(block.source);
      if (seen.has(key)) return;
      seen.add(key);
      sources.push(block.source);
    },
    inline(node) {
      const source = node.type === "media" && node.source !== undefined
        ? node.source
        : node.type === "link" && node.target.kind === "attachment"
          ? { kind: "attachment" as const, pageId, filename: node.target.filename }
          : undefined;
      if (source === undefined) return;
      const key = astroExportAssetKeyV1(source);
      if (seen.has(key)) return;
      seen.add(key);
      sources.push(source);
    },
  });
  return sources;
}

function assetContext(
  page: PublicationPageV1,
  bundle: PublicationBundleV1,
  base: string,
): { assets: Readonly<Record<string, AstroResolvedAssetV1>>; bySource: Readonly<Record<string, AstroResolvedAssetV1>> } {
  const entries = new Map(bundle.assets.map((asset) => [asset.assetId, asset]));
  const context: Record<string, AstroResolvedAssetV1> = {};
  const bySource: Record<string, AstroResolvedAssetV1> = {};
  const sources = collectAssetSources(page.sourceId, page.blocks);
  sources.forEach((source, index) => {
    const assetId = page.assetIds[index];
    if (assetId === undefined) return;
    const entry = entries.get(assetId);
    if (entry === undefined) return;
    const href = outputAssetHref(base, entry.path);
    const resolved: AstroResolvedAssetV1 = {
      src: href,
      mediaType: entry.mediaType,
      downloadHref: href,
      downloadName: entry.downloadName,
      mode: "verified-original",
    };
    context[astroExportAssetKeyV1(source)] = resolved;
    bySource[astroExportAssetKeyV1(source)] = resolved;
  });
  return { assets: context, bySource };
}

/**
 * Resolve one immutable publication page into the render-kit context. The
 * helper is intentionally data-only: no network, source parsing, component
 * lookup, or URL synthesis from Confluence IDs is performed.
 */
export function createPublicationRenderContextV1(
  options: CreatePublicationRenderContextOptionsV1,
): AstroExportBlockRenderContextV1 {
  const base = normalizedBase(options.base);
  const prefix = normalizedPrefix(options.routePrefix);
  const routeBySourceId = new Map(
    options.bundle.routes.filter((route) => route.state === "active").map((route) => [route.sourceId, route.route]),
  );
  for (const route of options.bundle.routes) {
    if (route.state === "active") routeHref(base, prefix, route.route);
  }
  const links: Record<string, AstroResolvedLinkV1> = {};
  const pages = options.pages ?? [options.page];
  const anchorsBySourceId = new Map(
    pages.map((page) => [page.sourceId, planPublicationAnchorsV1(page.blocks)]),
  );
  for (const reference of options.page.links) {
    if (reference.kind === "page") {
      const route = routeBySourceId.get(reference.sourceId);
      if (route === undefined) {
        links[reference.referenceId] = { kind: "unresolved", href: "#" };
      } else {
        let anchorId: string | undefined;
        if (reference.anchorId !== undefined) {
          try {
            const normalized = normalizePublicationAnchorReferenceV1(reference.anchorId);
            anchorId = anchorsBySourceId.get(reference.sourceId)?.find((anchor) =>
              anchor.anchorId === normalized || anchor.sourceAnchor === normalized,
            )?.anchorId;
          } catch {
            anchorId = undefined;
          }
        }
        if (reference.anchorId !== undefined && anchorId === undefined) {
          links[reference.referenceId] = { kind: "unresolved", href: "#" };
          continue;
        }
        const resolved: AstroResolvedLinkV1 = {
          kind: "page",
          href: `${routeHref(base, prefix, route)}${anchorId === undefined ? "" : `#${encodeURIComponent(anchorId)}`}`,
        };
        links[reference.referenceId] = resolved;
        links[astroExportLinkKeyV1({ kind: "page", contentTitle: "", contentId: reference.sourceId, ...(reference.anchorId === undefined ? {} : { anchor: reference.anchorId }) })] = resolved;
      }
    } else if (reference.kind === "asset") {
      const asset = options.bundle.assets.find((entry) => entry.assetId === reference.assetId);
      const resolved: AstroResolvedLinkV1 = asset === undefined
        ? { kind: "unresolved", href: "#" }
        : { kind: "asset", href: outputAssetHref(base, asset.path) };
      links[reference.referenceId] = resolved;
    } else if (reference.kind === "external") {
      let url: URL;
      try {
        url = new URL(reference.href);
      } catch {
        links[reference.referenceId] = { kind: "unresolved", href: "#" };
        continue;
      }
      if (!(["http:", "https:", "mailto:", "tel:"] as readonly string[]).includes(url.protocol)) {
        links[reference.referenceId] = { kind: "unresolved", href: "#" };
        continue;
      }
      const resolved: AstroResolvedLinkV1 = { kind: "external", href: url.href };
      links[reference.referenceId] = resolved;
      links[astroExportLinkKeyV1({ kind: "external", href: reference.href })] = resolved;
    } else {
      links[reference.referenceId] = { kind: "unresolved", href: "#" };
    }
  }
  const resolvedAssets = assetContext(options.page, options.bundle, base);
  for (const source of collectAssetSources(options.page.sourceId, options.page.blocks)) {
    if (source.kind !== "attachment") continue;
    const asset = resolvedAssets.bySource[astroExportAssetKeyV1(source)];
    if (asset === undefined) continue;
    links[astroExportLinkKeyV1({ kind: "attachment", filename: source.filename })] = {
      kind: "asset",
      href: asset.src,
    };
  }
  return {
    locale: options.locale ?? "en",
    direction: options.direction ?? "ltr",
    headings: Object.fromEntries(collectHeadings(options.page.blocks).map((heading) => [heading.id, heading])),
    links,
    assets: resolvedAssets.assets,
    notes: "inline",
  };
}
