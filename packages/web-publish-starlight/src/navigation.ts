import {
  normalizePublicationRoutePrefixV1,
  normalizePublicationRouteV1,
  publicationLocaleRouteV1,
  type PublicationI18nOptionsV1,
  type PublicationBreadcrumbV1,
  type PublicationNavigationItemV1,
  type PublicationNavigationPlanV1,
  type PublicationLabelLandingV1,
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

export interface StarlightPublicationLabelLandingV1 {
  label: string;
  slug: string;
  href: string;
  pages: readonly StarlightPublicationLinkV1[];
}

export interface StarlightPublicationNavigationModelV1 {
  routePrefix: string;
  sidebar: readonly StarlightPublicationSidebarEntryV1[];
  pages: readonly StarlightPublicationPageNavigationV1[];
  labels: readonly StarlightPublicationLabelLandingV1[];
}

export interface CreateStarlightPublicationNavigationOptionsV1 {
  /** A complete, already validated neutral graph plan. */
  navigation: PublicationNavigationPlanV1;
  /** Namespace owned by the publication route, e.g. `/publish`, without Astro's base. */
  routePrefix: string;
  /** Optional canonical Astro base prefix, e.g. `/docs`, without a trailing slash. */
  base?: string;
  /** Trusted, localized label for a group landing link. */
  landingLabel: string;
  /** Shared locale route policy; omitted for single-locale publications. */
  i18n?: PublicationI18nOptionsV1;
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

/** Convert a neutral route to its static Starlight URL, including an optional Astro base. */
export function starlightPublicationHrefV1(
  route: string,
  routePrefix: string,
  base = "",
  locale: string | undefined = undefined,
  i18n: PublicationI18nOptionsV1 | undefined = undefined,
): string {
  const namespacedRoute = normalizePublicationRouteV1(
    `${normalizePublicationRoutePrefixV1(routePrefix)}${normalizePublicationRouteV1(route)}`,
  );
  const normalizedRoute = i18n === undefined
    ? namespacedRoute
    : publicationLocaleRouteV1(namespacedRoute, locale ?? i18n.defaultLocale, i18n);
  const prefix = normalizePublicationRoutePrefixV1(base);
  return normalizedRoute === "/" ? `${prefix}/` || "/" : `${prefix}${normalizedRoute}`;
}

function link(value: PublicationBreadcrumbV1, routePrefix: string, base: string, i18n?: PublicationI18nOptionsV1): StarlightPublicationLinkV1 {
  return { sourceId: value.sourceId, title: value.title, href: starlightPublicationHrefV1(value.route, routePrefix, base, value.locale, i18n) };
}

function relatedLink(value: PublicationRelatedPageV1, routePrefix: string, base: string, i18n?: PublicationI18nOptionsV1): StarlightPublicationRelatedLinkV1 {
  return {
    ...link(value, routePrefix, base, i18n),
    score: value.score,
    reasons: value.reasons,
  };
}

function sidebarEntry(
  item: PublicationNavigationItemV1,
  routePrefix: string,
  base: string,
  landingLabel: string,
  expanded: boolean,
  i18n?: PublicationI18nOptionsV1,
): StarlightPublicationSidebarEntryV1 {
  // Starlight localizes its documented sidebar links for the current route.
  // Passing a locale-prefixed href here would make the current locale appear
  // twice on translated pages; ordinary publication chrome below uses the
  // explicit locale-aware href path.
  const href = starlightPublicationHrefV1(item.route, routePrefix, base);
  if (item.children.length === 0) return { label: item.title, link: href };
  return {
    label: item.title,
    collapsed: !expanded,
    items: [
      { label: landingLabel, link: href },
      ...item.children.map((child) => sidebarEntry(child, routePrefix, base, landingLabel, false, i18n)),
    ],
  };
}

function pageNavigation(
  page: PublicationPageNavigationV1,
  routePrefix: string,
  base: string,
  i18n?: PublicationI18nOptionsV1,
): StarlightPublicationPageNavigationV1 {
  return Object.freeze({
    sourceId: page.sourceId,
    breadcrumbs: Object.freeze(page.breadcrumbs.map((entry) => link(entry, routePrefix, base, i18n))),
    toc: page.toc,
    ...(page.previous === undefined ? {} : { previous: link(page.previous, routePrefix, base, i18n) }),
    ...(page.next === undefined ? {} : { next: link(page.next, routePrefix, base, i18n) }),
    related: Object.freeze(page.related.map((entry) => relatedLink(entry, routePrefix, base, i18n))),
  });
}

function labelLanding(
  label: PublicationLabelLandingV1,
  pages: ReadonlyMap<string, StarlightPublicationPageNavigationV1>,
  routePrefix: string,
  base: string,
  i18n?: PublicationI18nOptionsV1,
): StarlightPublicationLabelLandingV1 {
  const members = label.sourceIds.map((sourceId) => {
    const page = pages.get(sourceId);
    const current = page?.breadcrumbs.at(-1);
    if (current === undefined) {
      throw new StarlightPublicationNavigationErrorV1(`label '${label.label}' references unknown page '${sourceId}'`);
    }
    return current;
  });
  return Object.freeze({
    label: label.label,
    slug: label.slug,
    href: starlightPublicationHrefV1(label.route, routePrefix, base, undefined, i18n),
    pages: Object.freeze(members),
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
  const base = normalizePublicationRoutePrefixV1(options.base ?? "");
  const pages = Object.freeze(options.navigation.pages.map((page) => pageNavigation(page, routePrefix, base, options.i18n)));
  const pagesBySourceId = new Map(pages.map((page) => [page.sourceId, page]));
  return Object.freeze({
    routePrefix,
    sidebar: Object.freeze(options.navigation.roots.map((root) =>
      // Starlight's documented sidebar input applies its configured base.
      // Other publication chrome uses fully base-aware href values above.
      sidebarEntry(root, routePrefix, "", landingLabel, true, options.i18n),
    )),
    pages,
    labels: Object.freeze(options.navigation.labels.map((label) => labelLanding(label, pagesBySourceId, routePrefix, base, options.i18n))),
  });
}

/** Look up a generated label landing without deriving identity from its URL. */
export function starlightPublicationLabelLandingV1(
  model: StarlightPublicationNavigationModelV1,
  slug: string,
): StarlightPublicationLabelLandingV1 {
  const landing = model.labels.find((entry) => entry.slug === slug);
  if (landing === undefined) {
    throw new StarlightPublicationNavigationErrorV1(`navigation has no label landing '${slug}'`);
  }
  return landing;
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
