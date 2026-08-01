import type { PublicationAnchorV1, PublicationPageV1 } from "./contracts.js";
import { planPublicationAnchorsV1 } from "./references.js";
import { normalizePublicationRoutePrefixV1, normalizePublicationRouteV1, publicationSlugV1 } from "./routes.js";

export type PublicationNavigationPlanningErrorCodeV1 =
  | "duplicate-page"
  | "duplicate-route"
  | "duplicate-root"
  | "unknown-root"
  | "unknown-parent"
  | "root-has-in-scope-parent"
  | "parent-cycle"
  | "depth-mismatch"
  | "invalid-related-limit"
  | "invalid-label-route-prefix"
  | "label-route-collision";

export class PublicationNavigationPlanningErrorV1 extends Error {
  constructor(
    public readonly code: PublicationNavigationPlanningErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "PublicationNavigationPlanningErrorV1";
  }
}

export interface PlanPublicationNavigationRequestV1 {
  /** Complete, included publication pages; no source fetch or HTML scan occurs here. */
  pages: readonly PublicationPageV1[];
  /** Authoritative scope roots from the immutable bundle. */
  rootIds: readonly string[];
  /** Bounded deterministic related-page result count. Defaults to six. */
  maxRelatedPages?: number;
  /** Namespace owned by generated label landing pages. Defaults to `/topics`. */
  labelRoutePrefix?: string;
}

export interface PublicationNavigationItemV1 {
  sourceId: string;
  title: string;
  route: string;
  children: readonly PublicationNavigationItemV1[];
}

export interface PublicationBreadcrumbV1 {
  sourceId: string;
  title: string;
  route: string;
}

export interface PublicationTocEntryV1 {
  anchorId: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}

export type PublicationRelatedReasonV1 =
  | "outbound-link"
  | "inbound-link"
  | "shared-label"
  | "same-parent"
  | "same-root";

export interface PublicationRelatedPageV1 {
  sourceId: string;
  title: string;
  route: string;
  score: number;
  reasons: readonly PublicationRelatedReasonV1[];
}

export interface PublicationPageNavigationV1 {
  sourceId: string;
  breadcrumbs: readonly PublicationBreadcrumbV1[];
  toc: readonly PublicationTocEntryV1[];
  previous?: PublicationBreadcrumbV1;
  next?: PublicationBreadcrumbV1;
  related: readonly PublicationRelatedPageV1[];
}

export interface PublicationLabelLandingV1 {
  label: string;
  slug: string;
  route: string;
  sourceIds: readonly string[];
}

export interface PublicationNavigationPlanV1 {
  roots: readonly PublicationNavigationItemV1[];
  pages: readonly PublicationPageNavigationV1[];
  labels: readonly PublicationLabelLandingV1[];
}

interface Node {
  page: PublicationPageV1;
  parent?: Node;
  children: Node[];
  rootId?: string;
}

const DEFAULT_MAX_RELATED_PAGES = 6;
const DEFAULT_LABEL_ROUTE_PREFIX = "/topics";

function fail(code: PublicationNavigationPlanningErrorCodeV1, message: string): never {
  throw new PublicationNavigationPlanningErrorV1(code, message);
}

function compareNodes(left: Node, right: Node): number {
  return left.page.position - right.page.position ||
    left.page.title.localeCompare(right.page.title) ||
    left.page.sourceId.localeCompare(right.page.sourceId);
}

function pageSummary(node: Node): PublicationBreadcrumbV1 {
  return { sourceId: node.page.sourceId, title: node.page.title, route: node.page.route };
}

function headingToc(anchors: readonly PublicationAnchorV1[]): readonly PublicationTocEntryV1[] {
  return anchors.flatMap((anchor) => anchor.kind === "heading" && anchor.level !== undefined && anchor.text !== undefined
    ? [{ anchorId: anchor.anchorId, level: anchor.level, text: anchor.text }]
    : []);
}

function rootOf(node: Node): string {
  if (node.rootId === undefined) throw new Error(`navigation root was not assigned for ${node.page.sourceId}`);
  return node.rootId;
}

function pageLinksTo(page: PublicationPageV1, sourceId: string): boolean {
  return page.links.some((link) => link.kind === "page" && link.sourceId === sourceId);
}

function sharedLabelCount(left: PublicationPageV1, right: PublicationPageV1): number {
  const labels = new Set(left.labels.map((label) => label.normalize("NFKC").toLowerCase()));
  return right.labels.reduce((count, label) => count + (labels.has(label.normalize("NFKC").toLowerCase()) ? 1 : 0), 0);
}

function routeFold(route: string): string {
  return route.normalize("NFKC").toLowerCase();
}

function labelRoute(prefix: string, label: string): string {
  return normalizePublicationRouteV1(`${prefix}/${publicationSlugV1(label)}/`);
}

function relatedPages(
  page: Node,
  nodes: readonly Node[],
  limit: number,
): readonly PublicationRelatedPageV1[] {
  const related = nodes.flatMap((candidate) => {
    if (candidate === page) return [];
    const reasons: PublicationRelatedReasonV1[] = [];
    let score = 0;
    if (pageLinksTo(page.page, candidate.page.sourceId)) {
      score += 100;
      reasons.push("outbound-link");
    }
    if (pageLinksTo(candidate.page, page.page.sourceId)) {
      score += 75;
      reasons.push("inbound-link");
    }
    if (sharedLabelCount(page.page, candidate.page) > 0) {
      score += 20;
      reasons.push("shared-label");
    }
    if (page.parent === candidate.parent) {
      score += 10;
      reasons.push("same-parent");
    }
    if (rootOf(page) === rootOf(candidate)) {
      score += 5;
      reasons.push("same-root");
    }
    return score === 0 ? [] : [{
      ...pageSummary(candidate), score, reasons: Object.freeze(reasons),
    }];
  });
  return Object.freeze(related.sort((left, right) =>
    right.score - left.score || left.title.localeCompare(right.title) || left.sourceId.localeCompare(right.sourceId),
  ).slice(0, limit));
}

/**
 * Build the complete theme-neutral navigation model from the trusted page
 * graph. It intentionally has no HTML, Astro, Starlight, network, or source
 * representation dependency.
 */
export function planPublicationNavigationV1(
  request: PlanPublicationNavigationRequestV1,
): PublicationNavigationPlanV1 {
  const maxRelatedPages = request.maxRelatedPages ?? DEFAULT_MAX_RELATED_PAGES;
  if (!Number.isSafeInteger(maxRelatedPages) || maxRelatedPages < 1 || maxRelatedPages > 100) {
    fail("invalid-related-limit", "maxRelatedPages must be a safe integer from 1 through 100");
  }
  let labelRoutePrefix: string;
  try {
    labelRoutePrefix = normalizePublicationRoutePrefixV1(request.labelRoutePrefix ?? DEFAULT_LABEL_ROUTE_PREFIX);
  } catch {
    fail("invalid-label-route-prefix", "labelRoutePrefix must be a safe non-root publication route prefix");
  }
  if (labelRoutePrefix === "") {
    fail("invalid-label-route-prefix", "labelRoutePrefix must not be the publication root");
  }
  const byId = new Map<string, Node>();
  const byRoute = new Map<string, Node>();
  for (const page of request.pages) {
    if (byId.has(page.sourceId)) fail("duplicate-page", `Duplicate navigation page '${page.sourceId}'`);
    const route = normalizePublicationRouteV1(page.route);
    if (route !== page.route || byRoute.has(route)) {
      fail("duplicate-route", `Duplicate or non-canonical navigation route '${page.route}'`);
    }
    const node: Node = { page, children: [] };
    byId.set(page.sourceId, node);
    byRoute.set(route, node);
  }

  const roots: Node[] = [];
  const rootIds = new Set<string>();
  for (const rootId of request.rootIds) {
    if (rootIds.has(rootId)) fail("duplicate-root", `Root '${rootId}' occurs more than once`);
    const root = byId.get(rootId);
    if (root === undefined) fail("unknown-root", `Root '${rootId}' is not an included page`);
    rootIds.add(rootId);
    roots.push(root);
  }
  if (roots.length === 0 && byId.size > 0) fail("unknown-root", "A non-empty page graph requires at least one root");

  for (const node of byId.values()) {
    const parentId = node.page.parentId;
    if (parentId === undefined || !byId.has(parentId)) {
      if (!rootIds.has(node.page.sourceId)) {
        fail("unknown-parent", `Page '${node.page.sourceId}' has no included parent and is not an explicit root`);
      }
      continue;
    }
    if (rootIds.has(node.page.sourceId)) {
      fail("root-has-in-scope-parent", `Root '${node.page.sourceId}' has included parent '${parentId}'`);
    }
    const parent = byId.get(parentId)!;
    if (node.page.depth !== parent.page.depth + 1) {
      fail("depth-mismatch", `Page '${node.page.sourceId}' depth does not follow parent '${parentId}'`);
    }
    node.parent = parent;
    parent.children.push(node);
  }

  const visiting = new Set<Node>();
  const visited = new Set<Node>();
  const assignRoot = (node: Node, rootId: string): void => {
    if (visiting.has(node)) fail("parent-cycle", `Page graph has a parent cycle at '${node.page.sourceId}'`);
    if (visited.has(node)) {
      if (node.rootId !== rootId) fail("parent-cycle", `Page '${node.page.sourceId}' belongs to multiple roots`);
      return;
    }
    visiting.add(node);
    node.rootId = rootId;
    node.children.sort(compareNodes);
    for (const child of node.children) assignRoot(child, rootId);
    visiting.delete(node);
    visited.add(node);
  };
  roots.sort(compareNodes);
  for (const root of roots) assignRoot(root, root.page.sourceId);
  if (visited.size !== byId.size) {
    const unassigned = [...byId.values()].find((node) => !visited.has(node));
    fail("parent-cycle", `Page '${unassigned?.page.sourceId ?? "unknown"}' is disconnected from the declared roots`);
  }

  const toItem = (node: Node): PublicationNavigationItemV1 => Object.freeze({
    ...pageSummary(node), children: Object.freeze(node.children.map(toItem)),
  });
  const ordered: Node[] = [];
  const visit = (node: Node): void => {
    ordered.push(node);
    node.children.forEach(visit);
  };
  roots.forEach(visit);

  const pages = Object.freeze(ordered.map((node, index): PublicationPageNavigationV1 => {
    const breadcrumbs: PublicationBreadcrumbV1[] = [];
    for (let current: Node | undefined = node; current !== undefined; current = current.parent) {
      breadcrumbs.unshift(pageSummary(current));
    }
    return Object.freeze({
      sourceId: node.page.sourceId,
      breadcrumbs: Object.freeze(breadcrumbs),
      toc: Object.freeze(headingToc(planPublicationAnchorsV1(node.page.blocks))),
      ...(index > 0 ? { previous: pageSummary(ordered[index - 1]!) } : {}),
      ...(index + 1 < ordered.length ? { next: pageSummary(ordered[index + 1]!) } : {}),
      related: relatedPages(node, ordered, maxRelatedPages),
    });
  }));

  const labelGroups = new Map<string, { label: string; sourceIds: string[] }>();
  for (const node of ordered) {
    for (const label of node.page.labels) {
      const key = label.normalize("NFKC").toLowerCase();
      const group = labelGroups.get(key) ?? { label, sourceIds: [] };
      group.sourceIds.push(node.page.sourceId);
      labelGroups.set(key, group);
    }
  }
  const labelRoutes = new Map<string, string>();
  for (const route of byRoute.keys()) labelRoutes.set(routeFold(route), "page");
  const labels = Object.freeze([...labelGroups.values()].map((group): PublicationLabelLandingV1 => {
    const slug = publicationSlugV1(group.label);
    const route = labelRoute(labelRoutePrefix, group.label);
    const collision = labelRoutes.get(routeFold(route));
    if (collision !== undefined) {
      fail("label-route-collision", `Label '${group.label}' collides with ${collision} route '${route}'`);
    }
    labelRoutes.set(routeFold(route), "another label");
    return Object.freeze({
      label: group.label,
      slug,
      route,
      sourceIds: Object.freeze(group.sourceIds.sort()),
    });
  }).sort((left, right) => left.label.localeCompare(right.label) || left.slug.localeCompare(right.slug)));

  return Object.freeze({ roots: Object.freeze(roots.map(toItem)), pages, labels });
}
