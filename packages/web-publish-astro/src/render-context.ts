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

type PlannedAnchorsV1 = ReturnType<typeof planPublicationAnchorsV1>;

interface AnchorPlanV1 {
  anchors: PlannedAnchorsV1;
  /** Normalized anchor id or source anchor to the first matching rendered anchor id. */
  byReference: ReadonlyMap<string, string>;
}

// One render context is created per page, but all of them share the loaded
// bundle. Everything derived from the bundle as a whole is computed once per
// loaded object instead of once per rendered page.
const anchorPlans = new WeakMap<readonly ExportBlock[], AnchorPlanV1>();
const pageIndexes = new WeakMap<readonly PublicationPageV1[], ReadonlyMap<string, PublicationPageV1>>();
const bundleIndexes = new WeakMap<PublicationBundleV1, Map<string, BundleIndexV1>>();

interface BundleIndexV1 {
  routeBySourceId: ReadonlyMap<string, string>;
  assetById: ReadonlyMap<string, PublicationBundleV1["assets"][number]>;
}

function anchorPlan(blocks: readonly ExportBlock[]): AnchorPlanV1 {
  let plan = anchorPlans.get(blocks);
  if (plan === undefined) {
    const anchors = planPublicationAnchorsV1(blocks);
    const byReference = new Map<string, string>();
    for (const anchor of anchors) {
      if (!byReference.has(anchor.anchorId)) byReference.set(anchor.anchorId, anchor.anchorId);
      if (anchor.sourceAnchor !== undefined && !byReference.has(anchor.sourceAnchor)) byReference.set(anchor.sourceAnchor, anchor.anchorId);
    }
    plan = { anchors, byReference };
    anchorPlans.set(blocks, plan);
  }
  return plan;
}

function pageIndex(pages: readonly PublicationPageV1[]): ReadonlyMap<string, PublicationPageV1> {
  let index = pageIndexes.get(pages);
  if (index === undefined) {
    index = new Map(pages.map((page) => [page.sourceId, page]));
    pageIndexes.set(pages, index);
  }
  return index;
}

function bundleIndex(bundle: PublicationBundleV1, base: string, prefix: string): BundleIndexV1 {
  let byLocation = bundleIndexes.get(bundle);
  if (byLocation === undefined) {
    byLocation = new Map();
    bundleIndexes.set(bundle, byLocation);
  }
  const location = `${base}\u0000${prefix}`;
  let index = byLocation.get(location);
  if (index === undefined) {
    const routeBySourceId = new Map<string, string>();
    for (const route of bundle.routes) {
      if (route.state !== "active") continue;
      routeHref(base, prefix, route.route); // rejects an unsafe route before any link uses it
      routeBySourceId.set(route.sourceId, route.route);
    }
    const assetById = new Map<string, PublicationBundleV1["assets"][number]>();
    for (const asset of bundle.assets) {
      if (!assetById.has(asset.assetId)) assetById.set(asset.assetId, asset);
    }
    index = { routeBySourceId, assetById };
    byLocation.set(location, index);
  }
  return index;
}

function collectHeadings(blocks: readonly ExportBlock[]): readonly AstroResolvedHeadingV1[] {
  return anchorPlan(blocks).anchors
    .filter((anchor) => anchor.kind === "heading")
    .map((anchor) => ({
      id: anchor.anchorId,
      level: anchor.level ?? 2,
      text: anchor.text ?? "",
    }));
}

function collectHeadingAnchors(blocks: readonly ExportBlock[]): Readonly<Record<string, string>> {
  const planned = anchorPlan(blocks).anchors;
  const headingAnchors: Record<string, string> = {};
  let anchorIndex = 0;
  visitExportBlocksV1(blocks, {
    block(block, visitContext) {
      if (block.type !== "anchor" && block.type !== "heading") return;
      const anchor = planned[anchorIndex++];
      if (anchor === undefined) throw new Error("publication anchor plan is out of sync with export blocks");
      if (block.type === "heading") headingAnchors[visitContext.path] = anchor.anchorId;
    },
  });
  return headingAnchors;
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
  entries: BundleIndexV1["assetById"],
  base: string,
): { assets: Readonly<Record<string, AstroResolvedAssetV1>>; bySource: Readonly<Record<string, AstroResolvedAssetV1>> } {
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
  const { routeBySourceId, assetById } = bundleIndex(options.bundle, base, prefix);
  const links: Record<string, AstroResolvedLinkV1> = {};
  // Anchors of a link target are planned on demand: most pages are never the
  // target of an anchored link from the page being rendered.
  const targetPage = (sourceId: string): PublicationPageV1 | undefined => options.pages === undefined
    ? (sourceId === options.page.sourceId ? options.page : undefined)
    : pageIndex(options.pages).get(sourceId);
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
            const target = targetPage(reference.sourceId);
            anchorId = target === undefined ? undefined : anchorPlan(target.blocks).byReference.get(normalized);
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
      const asset = assetById.get(reference.assetId);
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
  // Anchor links are embedded in the block tree rather than in the page
  // reference manifest. Resolve them against the page-local anchor plan so a
  // stale Confluence anchor becomes the render kit's visible unresolved
  // fallback instead of a dead `#fragment` that fails output verification.
  const pageAnchors = anchorPlan(options.page.blocks).byReference;
  visitExportBlocksV1(options.page.blocks, {
    inline(node) {
      if (node.type !== "link" || node.target.kind !== "anchor") return;
      let normalized: string;
      try {
        normalized = normalizePublicationAnchorReferenceV1(node.target.anchor);
      } catch {
        links[astroExportLinkKeyV1(node.target)] = { kind: "unresolved", href: "#" };
        return;
      }
      const anchorId = pageAnchors.get(normalized);
      links[astroExportLinkKeyV1(node.target)] = anchorId === undefined
        ? { kind: "unresolved", href: "#" }
        : { kind: "page", href: `#${encodeURIComponent(anchorId)}` };
    },
  });
  const resolvedAssets = assetContext(options.page, assetById, base);
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
    headingAnchors: collectHeadingAnchors(options.page.blocks),
    links,
    assets: resolvedAssets.assets,
    ...(options.bundle.chartPolicy === undefined ? {} : { chartPolicy: options.bundle.chartPolicy }),
    notes: "inline",
  };
}
