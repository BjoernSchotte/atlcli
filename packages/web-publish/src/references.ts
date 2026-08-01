import {
  mentionDisplayText,
  smartCardDisplayText,
  type ExportBlock,
  type InlineNode,
  visitExportBlocksV1,
} from "@atlcli/export-blocks";
import type {
  PublicationAnchorV1,
  PublicationAssetEntryV1,
  PublicationLinkReferenceV1,
  PublicationPageReferencesV1,
  PublicationReferencePlanV1,
  ResolvedPublicationAssetV1,
  ResolvedPublicationLinkReferenceV1,
} from "./contracts.js";
import { normalizePublicationRouteV1, publicationSlugV1, validatePublicationOutputPathV1 } from "./routes.js";

const MAX_ANCHOR_LENGTH = 120;

export type PublicationReferencePlanningErrorCodeV1 =
  | "duplicate-page"
  | "duplicate-route"
  | "duplicate-asset"
  | "duplicate-reference"
  | "duplicate-anchor"
  | "unsafe-anchor"
  | "unsafe-external-link"
  | "dangling-page-reference"
  | "dangling-anchor-reference"
  | "dangling-asset-reference";

export class PublicationReferencePlanningErrorV1 extends Error {
  constructor(
    public readonly code: PublicationReferencePlanningErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "PublicationReferencePlanningErrorV1";
  }
}

export interface PublicationReferencePageInputV1 {
  sourceId: string;
  route: string;
  blocks: readonly ExportBlock[];
  links: readonly PublicationLinkReferenceV1[];
  assetIds: readonly string[];
}

export interface PlanPublicationReferencesRequestV1 {
  pages: readonly PublicationReferencePageInputV1[];
  assets: readonly PublicationAssetEntryV1[];
}

function fail(
  code: PublicationReferencePlanningErrorCodeV1,
  message: string,
): never {
  throw new PublicationReferencePlanningErrorV1(code, message);
}

function visibleInlineText(nodes: readonly InlineNode[]): string {
  return nodes.map((node) => {
    switch (node.type) {
      case "text":
        return node.text;
      case "link":
        return visibleInlineText(node.content);
      case "mention":
        return mentionDisplayText(node);
      case "date":
        return node.timestamp;
      case "status":
        return node.text || node.color;
      case "smartCard":
        return smartCardDisplayText(node.card);
      case "media":
        return node.alt ?? "Media";
      case "placeholder":
        return "";
      case "lineBreak":
        return " ";
      default: {
        const exhaustive: never = node;
        return exhaustive;
      }
    }
  }).join("").replace(/\s+/gu, " ").trim();
}

/**
 * Canonicalize an authored fragment lookup key. It deliberately rejects URL
 * syntax and control characters rather than decoding or guessing them.
 */
export function normalizePublicationAnchorReferenceV1(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized.length === 0 ||
    Array.from(normalized).length > MAX_ANCHOR_LENGTH ||
    /[\u0000-\u001F\u007F]/u.test(normalized) ||
    /[\\/%?#]/u.test(normalized) ||
    normalized === "." ||
    normalized === ".."
  ) {
    return fail("unsafe-anchor", "Anchor references must be a bounded plain fragment name");
  }
  return publicationSlugV1(normalized);
}

function nextAnchorId(seed: string, used: Set<string>): string {
  const base = publicationSlugV1(seed).slice(0, MAX_ANCHOR_LENGTH) || "section";
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    const suffixText = `-${suffix}`;
    candidate = `${base.slice(0, MAX_ANCHOR_LENGTH - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function planAnchors(blocks: readonly ExportBlock[]): readonly PublicationAnchorV1[] {
  const anchors: PublicationAnchorV1[] = [];
  const usedIds = new Set<string>();
  const sourceAnchors = new Set<string>();

  function addBookmark(name: string): void {
    const sourceAnchor = normalizePublicationAnchorReferenceV1(name);
    if (sourceAnchors.has(sourceAnchor)) {
      fail("duplicate-anchor", `Duplicate page-local anchor '${sourceAnchor}'`);
    }
    sourceAnchors.add(sourceAnchor);
    anchors.push({
      anchorId: nextAnchorId(sourceAnchor, usedIds),
      sourceAnchor,
      kind: "bookmark",
    });
  }

  visitExportBlocksV1(blocks, {
    block(block) {
      if (block.type === "anchor") {
        addBookmark(block.name);
        return;
      }
      if (block.type !== "heading") return;

      const text = visibleInlineText(block.content);
      const authored = block.explicitAnchor;
      const sourceAnchor = authored === undefined
        ? undefined
        : normalizePublicationAnchorReferenceV1(authored);
      if (sourceAnchor !== undefined) {
        if (sourceAnchors.has(sourceAnchor)) {
          fail("duplicate-anchor", `Duplicate page-local anchor '${sourceAnchor}'`);
        }
        sourceAnchors.add(sourceAnchor);
      }
      anchors.push({
        anchorId: nextAnchorId(sourceAnchor ?? (text || "section"), usedIds),
        ...(sourceAnchor === undefined ? {} : { sourceAnchor }),
        kind: "heading",
        level: block.level,
        text,
      });
    },
  });
  return anchors;
}

function resolvedAsset(asset: PublicationAssetEntryV1): ResolvedPublicationAssetV1 {
  return {
    assetId: asset.assetId,
    path: validatePublicationOutputPathV1(asset.path),
    mediaType: asset.mediaType,
    byteLength: asset.byteLength,
    sha256: asset.sha256,
    disposition: asset.disposition,
    ...(asset.downloadName === undefined ? {} : { downloadName: asset.downloadName }),
  };
}

function externalHref(href: string): string {
  try {
    const url = new URL(href);
    if (url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" || url.protocol === "tel:") {
      return url.href;
    }
  } catch {
    // Closed below; only explicit safe absolute external URLs belong here.
  }
  return fail("unsafe-external-link", "External references must use an allowed absolute URL scheme");
}

/**
 * Resolve all source-independent page, anchor, and asset references before a
 * builder sees them. This intentionally returns logical routes/output paths,
 * never an Astro `base` URL or filesystem location.
 */
export function planPublicationReferencesV1(
  request: PlanPublicationReferencesRequestV1,
): PublicationReferencePlanV1 {
  const pages = [...request.pages].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const assetById = new Map<string, ResolvedPublicationAssetV1>();
  for (const asset of request.assets) {
    if (assetById.has(asset.assetId)) fail("duplicate-asset", `Duplicate asset '${asset.assetId}'`);
    assetById.set(asset.assetId, resolvedAsset(asset));
  }

  const pageById = new Map<string, PublicationReferencePageInputV1>();
  const pageByRoute = new Map<string, string>();
  const anchorsByPage = new Map<string, readonly PublicationAnchorV1[]>();
  for (const page of pages) {
    if (pageById.has(page.sourceId)) fail("duplicate-page", `Duplicate page '${page.sourceId}'`);
    const route = normalizePublicationRouteV1(page.route);
    const existing = pageByRoute.get(route);
    if (existing !== undefined) fail("duplicate-route", `Route '${route}' belongs to both '${existing}' and '${page.sourceId}'`);
    pageById.set(page.sourceId, page);
    pageByRoute.set(route, page.sourceId);
    anchorsByPage.set(page.sourceId, planAnchors(page.blocks));
  }

  return {
    pages: pages.map((page): PublicationPageReferencesV1 => {
      const route = normalizePublicationRouteV1(page.route);
      const seenReferenceIds = new Set<string>();
      const links: ResolvedPublicationLinkReferenceV1[] = page.links.map((reference) => {
        if (seenReferenceIds.has(reference.referenceId)) {
          fail("duplicate-reference", `Page '${page.sourceId}' repeats reference '${reference.referenceId}'`);
        }
        seenReferenceIds.add(reference.referenceId);

        if (reference.kind === "page") {
          const targetPage = pageById.get(reference.sourceId);
          if (targetPage === undefined) {
            fail("dangling-page-reference", `Page '${page.sourceId}' references missing page '${reference.sourceId}'`);
          }
          const anchorId = reference.anchorId === undefined
            ? undefined
            : normalizePublicationAnchorReferenceV1(reference.anchorId);
          if (anchorId !== undefined) {
            const targetAnchors = anchorsByPage.get(reference.sourceId) ?? [];
            const resolvedAnchor = targetAnchors.find((anchor) =>
              anchor.anchorId === anchorId || anchor.sourceAnchor === anchorId,
            );
            if (resolvedAnchor === undefined) {
              fail("dangling-anchor-reference", `Page '${page.sourceId}' references missing anchor '${anchorId}' on '${reference.sourceId}'`);
            }
            return {
              referenceId: reference.referenceId,
              target: { kind: "page", sourceId: reference.sourceId, route: normalizePublicationRouteV1(targetPage.route), anchorId: resolvedAnchor.anchorId },
            };
          }
          return {
            referenceId: reference.referenceId,
            target: { kind: "page", sourceId: reference.sourceId, route: normalizePublicationRouteV1(targetPage.route) },
          };
        }
        if (reference.kind === "asset") {
          const asset = assetById.get(reference.assetId);
          if (asset === undefined) {
            fail("dangling-asset-reference", `Page '${page.sourceId}' references missing asset '${reference.assetId}'`);
          }
          return { referenceId: reference.referenceId, target: { kind: "asset", assetId: asset.assetId, path: asset.path } };
        }
        if (reference.kind === "external") {
          return { referenceId: reference.referenceId, target: { kind: "external", href: externalHref(reference.href) } };
        }
        return { referenceId: reference.referenceId, target: { kind: "unresolved", label: reference.label } };
      });

      const assets = page.assetIds.map((assetId) => {
        const asset = assetById.get(assetId);
        if (asset === undefined) fail("dangling-asset-reference", `Page '${page.sourceId}' lists missing asset '${assetId}'`);
        return asset;
      });
      return {
        sourceId: page.sourceId,
        route,
        anchors: anchorsByPage.get(page.sourceId) ?? [],
        links,
        assets,
      };
    }),
  };
}
