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
  locale?: string;
  translationKey?: string;
  children: readonly PublicationNavigationItemV1[];
}

export interface PublicationBreadcrumbV1 {
  sourceId: string;
  title: string;
  route: string;
  locale?: string;
  translationKey?: string;
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
  locale?: string;
  translationKey?: string;
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
  /** Folded labels and linked page ids, computed once instead of per compared pair. */
  labels: ReadonlySet<string>;
  outbound: ReadonlySet<string>;
}

/** Lookups that let a page find its related candidates without scanning every page. */
interface RelatedIndexV1 {
  byId: ReadonlyMap<string, Node>;
  roots: readonly Node[];
  inbound: ReadonlyMap<string, readonly Node[]>;
  byLabel: ReadonlyMap<string, readonly Node[]>;
  /** Pages of one root in result order (title, then source id). */
  byRoot: ReadonlyMap<string, readonly Node[]>;
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
  return {
    sourceId: node.page.sourceId,
    title: node.page.title,
    route: node.page.route,
    ...(node.page.locale === undefined ? {} : { locale: node.page.locale }),
    ...(node.page.translationKey === undefined ? {} : { translationKey: node.page.translationKey }),
  };
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

function foldLabel(label: string): string {
  return label.normalize("NFKC").toLowerCase();
}

function compareRelated(left: { title: string; sourceId: string }, right: { title: string; sourceId: string }): number {
  return left.title.localeCompare(right.title) || left.sourceId.localeCompare(right.sourceId);
}

function push<K>(map: Map<K, Node[]>, key: K, node: Node): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [node]);
  else list.push(node);
}

function relatedIndex(byId: ReadonlyMap<string, Node>, roots: readonly Node[], ordered: readonly Node[]): RelatedIndexV1 {
  const inbound = new Map<string, Node[]>();
  const byLabel = new Map<string, Node[]>();
  const byRoot = new Map<string, Node[]>();
  for (const node of ordered) {
    for (const sourceId of node.outbound) push(inbound, sourceId, node);
    for (const label of node.labels) push(byLabel, label, node);
    push(byRoot, rootOf(node), node);
  }
  for (const members of byRoot.values()) members.sort((left, right) => compareRelated(left.page, right.page));
  return { byId, roots, inbound, byLabel, byRoot };
}

function routeFold(route: string): string {
  return route.normalize("NFKC").toLowerCase();
}

function routeIdentity(route: string, locale: string | undefined): string {
  return `${locale ?? ""}\u0000${route}`;
}

function labelRoute(prefix: string, label: string): string {
  return normalizePublicationRouteV1(`${prefix}/${publicationSlugV1(label)}/`);
}

function relatedPages(
  page: Node,
  index: RelatedIndexV1,
  limit: number,
): readonly PublicationRelatedPageV1[] {
  // Every page of the same root is related with the lowest score, so ranking
  // all pairs is quadratic. Only pages reachable through a link, a label or
  // the parent can score higher; the remaining places are filled from the
  // root's pre-sorted member list.
  // ponytail: a label or parent shared by most pages still yields that many
  // candidates per page; cap per-label fan-out if such graphs get large.
  const candidates = new Set<Node>();
  for (const sourceId of page.outbound) {
    const target = index.byId.get(sourceId);
    if (target !== undefined) candidates.add(target);
  }
  for (const source of index.inbound.get(page.page.sourceId) ?? []) candidates.add(source);
  for (const label of page.labels) {
    for (const labelled of index.byLabel.get(label) ?? []) candidates.add(labelled);
  }
  for (const sibling of page.parent?.children ?? index.roots) candidates.add(sibling);
  candidates.delete(page);

  const pageRoot = rootOf(page);
  const related = [...candidates].map((candidate): PublicationRelatedPageV1 => {
    const reasons: PublicationRelatedReasonV1[] = [];
    let score = 0;
    if (page.outbound.has(candidate.page.sourceId)) {
      score += 100;
      reasons.push("outbound-link");
    }
    if (candidate.outbound.has(page.page.sourceId)) {
      score += 75;
      reasons.push("inbound-link");
    }
    if ([...candidate.labels].some((label) => page.labels.has(label))) {
      score += 20;
      reasons.push("shared-label");
    }
    if (page.parent === candidate.parent) {
      score += 10;
      reasons.push("same-parent");
    }
    if (pageRoot === rootOf(candidate)) {
      score += 5;
      reasons.push("same-root");
    }
    return { ...pageSummary(candidate), score, reasons: Object.freeze(reasons) };
  }).sort((left, right) => right.score - left.score || compareRelated(left, right)).slice(0, limit);
  for (const member of index.byRoot.get(pageRoot) ?? []) {
    if (related.length >= limit) break;
    if (member === page || candidates.has(member)) continue;
    related.push({ ...pageSummary(member), score: 5, reasons: Object.freeze(["same-root" as const]) });
  }
  return Object.freeze(related);
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
    const identity = routeIdentity(route, page.locale);
    if (route !== page.route || byRoute.has(identity)) {
      fail("duplicate-route", `Duplicate or non-canonical navigation route '${page.route}' in locale '${page.locale ?? "default"}'`);
    }
    const node: Node = {
      page,
      children: [],
      labels: new Set(page.labels.map(foldLabel)),
      outbound: new Set(page.links.flatMap((link) => link.kind === "page" ? [link.sourceId] : [])),
    };
    byId.set(page.sourceId, node);
    byRoute.set(identity, node);
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
  const related = relatedIndex(byId, roots, ordered);

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
      related: relatedPages(node, related, maxRelatedPages),
    });
  }));

  const labelGroups = new Map<string, { label: string; sourceIds: string[] }>();
  for (const node of ordered) {
    for (const label of node.page.labels) {
      const key = foldLabel(label);
      const group = labelGroups.get(key) ?? { label, sourceIds: [] };
      group.sourceIds.push(node.page.sourceId);
      labelGroups.set(key, group);
    }
  }
  const labelRoutes = new Map<string, string>();
  for (const node of byId.values()) {
    labelRoutes.set(routeFold(routeIdentity(node.page.route, node.page.locale)), "page");
  }
  const labels = Object.freeze([...labelGroups.values()].map((group): PublicationLabelLandingV1 => {
    const slug = publicationSlugV1(group.label);
    const route = labelRoute(labelRoutePrefix, group.label);
    const collision = labelRoutes.get(routeFold(routeIdentity(route, undefined)));
    if (collision !== undefined) {
      fail("label-route-collision", `Label '${group.label}' collides with ${collision} route '${route}'`);
    }
    labelRoutes.set(routeFold(routeIdentity(route, undefined)), "another label");
    return Object.freeze({
      label: group.label,
      slug,
      route,
      sourceIds: Object.freeze(group.sourceIds.sort()),
    });
  }).sort((left, right) => left.label.localeCompare(right.label) || left.slug.localeCompare(right.slug)));

  return Object.freeze({ roots: Object.freeze(roots.map(toItem)), pages, labels });
}
