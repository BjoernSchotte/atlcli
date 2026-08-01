import {
  normalizePublicationRoutePrefixV1,
  normalizePublicationRouteV1,
  type PublicationBreadcrumbV1,
  type PublicationNavigationItemV1,
  type PublicationNavigationPlanV1,
  type PublicationPageNavigationV1,
  type PublicationRelatedPageV1,
  type PublicationTocEntryV1,
} from "@atlcli/web-publish";

export type StarlightPublicationSidebarEntryV1 =
  | {
      label: string;
      link: string;
    }
  | {
      label: string;
      collapsed: boolean;
      items: readonly StarlightPublicationSidebarEntryV1[];
    };

export interface StarlightPublicationLinkV1 {
  sourceId: string;
  title: string;
  href: string;
}

export interface StarlightPublicationRelatedLinkV1 extends StarlightPublicationLinkV1 {
  score: number;
  reasons: readonly PublicationRelatedPageV1["reasons"][number][];
}

export interface StarlightPublicationPageNavigationV1 {
  sourceId: string;
  breadcrumbs: readonly StarlightPublicationLinkV1[];
  toc: readonly PublicationTocEntryV1[];
  previous?: StarlightPublicationLinkV1;
  next?: StarlightPublicationLinkV1;
  related: readonly StarlightPublicationRelatedLinkV1[];
}

export interface StarlightPublicationNavigationModelV1 {
  routePrefix: string;
  sidebar: readonly StarlightPublicationSidebarEntryV1[];
  pages: readonly StarlightPublicationPageNavigationV1[];
}

export interface CreateStarlightPublicationNavigationOptionsV1 {
  /** A complete, already validated neutral graph plan. */
  navigation: PublicationNavigationPlanV1;
  /** Namespace owned by the publication route, e.g. `/publish`. */
  routePrefix: string;
  /** Trusted, localized label for a group landing link. */
  landingLabel: string;
}

export class StarlightPublicationNavigationErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StarlightPublicationNavigationErrorV1";
  }
}

function requireLabel(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new StarlightPublicationNavigationErrorV1("landingLabel must be a non-empty string");
  }
  return value;
}

/** Convert a neutral publication route to the selected Starlight route namespace. */
export function starlightPublicationHrefV1(route: string, routePrefix: string): string {
  const normalizedRoute = normalizePublicationRouteV1(route);
  const prefix = normalizePublicationRoutePrefixV1(routePrefix);
  return normalizedRoute === "/" ? `${prefix}/` || "/" : `${prefix}${normalizedRoute}`;
}

function link(value: PublicationBreadcrumbV1, routePrefix: string): StarlightPublicationLinkV1 {
  return { sourceId: value.sourceId, title: value.title, href: starlightPublicationHrefV1(value.route, routePrefix) };
}

function relatedLink(value: PublicationRelatedPageV1, routePrefix: string): StarlightPublicationRelatedLinkV1 {
  return {
    ...link(value, routePrefix),
    score: value.score,
    reasons: value.reasons,
  };
}

function sidebarEntry(
  item: PublicationNavigationItemV1,
  routePrefix: string,
  landingLabel: string,
  expanded: boolean,
): StarlightPublicationSidebarEntryV1 {
  const href = starlightPublicationHrefV1(item.route, routePrefix);
  if (item.children.length === 0) return { label: item.title, link: href };
  return {
    label: item.title,
    collapsed: !expanded,
    items: [
      { label: landingLabel, link: href },
      ...item.children.map((child) => sidebarEntry(child, routePrefix, landingLabel, false)),
    ],
  };
}

function pageNavigation(
  page: PublicationPageNavigationV1,
  routePrefix: string,
): StarlightPublicationPageNavigationV1 {
  return Object.freeze({
    sourceId: page.sourceId,
    breadcrumbs: Object.freeze(page.breadcrumbs.map((entry) => link(entry, routePrefix))),
    toc: page.toc,
    ...(page.previous === undefined ? {} : { previous: link(page.previous, routePrefix) }),
    ...(page.next === undefined ? {} : { next: link(page.next, routePrefix) }),
    related: Object.freeze(page.related.map((entry) => relatedLink(entry, routePrefix))),
  });
}

/**
 * Translate trusted neutral navigation data to the documented Starlight sidebar
 * shape. It intentionally receives no source page body and does not inspect
 * rendered markup or Starlight-private route data.
 */
export function createStarlightPublicationNavigationV1(
  options: CreateStarlightPublicationNavigationOptionsV1,
): StarlightPublicationNavigationModelV1 {
  const landingLabel = requireLabel(options.landingLabel);
  const routePrefix = normalizePublicationRoutePrefixV1(options.routePrefix);
  return Object.freeze({
    routePrefix,
    sidebar: Object.freeze(options.navigation.roots.map((root) =>
      sidebarEntry(root, routePrefix, landingLabel, true),
    )),
    pages: Object.freeze(options.navigation.pages.map((page) => pageNavigation(page, routePrefix))),
  });
}

/** Look up one page's already translated navigation without URL-derived identity. */
export function starlightPublicationPageNavigationV1(
  model: StarlightPublicationNavigationModelV1,
  sourceId: string,
): StarlightPublicationPageNavigationV1 {
  const page = model.pages.find((entry) => entry.sourceId === sourceId);
  if (page === undefined) {
    throw new StarlightPublicationNavigationErrorV1(`navigation has no page '${sourceId}'`);
  }
  return page;
}
