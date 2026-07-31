import type {
  PublicationOutputProfileV1,
  PublicationRoutePolicyV1,
  PublicationRouteRecordV1,
} from "./contracts.js";

const MAX_GENERATED_ROUTE_SEGMENT_CODE_POINTS = 80;
const MAX_SOURCE_SUFFIX_CODE_POINTS = 24;
const MAX_ROUTE_SEGMENT_CODE_POINTS = 120;
const MAX_ROUTE_CODE_POINTS = 1_024;
const MAX_OUTPUT_SEGMENT_CODE_POINTS = 255;
const MAX_OUTPUT_PATH_CODE_POINTS = 4_096;
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const SAFE_ROUTE_SEGMENT = /^[\p{Letter}\p{Number}._~-]+$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export type PublicationRoutePlanningErrorCodeV1 =
  | "duplicate-source-id"
  | "duplicate-route-record"
  | "duplicate-custom-route"
  | "unknown-custom-source"
  | "unknown-tombstone-source"
  | "conflicting-source-state"
  | "invalid-route-policy"
  | "invalid-route-record"
  | "unsafe-prefix"
  | "unsafe-route"
  | "unsafe-output-path"
  | "route-collision"
  | "output-path-collision";

/** A closed route-planning failure suitable for CLI/report projection. */
export class PublicationRoutePlanningErrorV1 extends Error {
  constructor(
    public readonly code: PublicationRoutePlanningErrorCodeV1,
    message: string,
    public readonly details: Readonly<{
      sourceId?: string;
      otherSourceId?: string;
      route?: string;
      path?: string;
    }> = {},
  ) {
    super(message);
    this.name = "PublicationRoutePlanningErrorV1";
  }
}

export interface PublicationRoutePageV1 {
  sourceId: string;
  title: string;
}

export interface PublicationRoutePlanRequestV1 {
  /** Pages confirmed to be active in the next publication scope. */
  pages: readonly PublicationRoutePageV1[];
  /** Mutable project-owned registry from the previously activated state. */
  previousRoutes: readonly PublicationRouteRecordV1[];
  /** Explicitly confirmed removals/exclusions; never inferred by this planner. */
  tombstoneSourceIds: readonly string[];
  policy: PublicationRoutePolicyV1;
  outputProfile: PublicationOutputProfileV1;
  /** Handwritten/project routes that publishing must never claim. */
  reservedRoutes?: readonly string[];
  /** Handwritten/generated output files that publishing must never overwrite. */
  reservedOutputPaths?: readonly string[];
}

export interface PublicationRouteOutputV1 {
  sourceId: string;
  route: string;
  outputPath: string;
}

export interface PublicationRouteChangeV1 {
  kind: "assigned" | "changed" | "reactivated" | "tombstoned";
  sourceId: string;
  previousRoute?: string;
  nextRoute: string;
}

export interface PublicationRoutePlanV1 {
  routes: readonly PublicationRouteRecordV1[];
  activeOutputs: readonly PublicationRouteOutputV1[];
  changes: readonly PublicationRouteChangeV1[];
}

interface RouteOwner {
  sourceId: string;
  route: string;
}

interface OutputOwner {
  sourceId: string;
  route?: string;
  path: string;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function codePointSlice(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}

function nonEmptyIdentity(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || CONTROL_CHARACTERS.test(value)) {
    throw new PublicationRoutePlanningErrorV1(
      "duplicate-source-id",
      `${label} must be a non-empty string without control characters.`,
    );
  }
  return value;
}

function routeFold(route: string): string {
  return route.normalize("NFKC").toLowerCase();
}

function outputPathFold(path: string): string {
  return path.normalize("NFKC").toLowerCase();
}

function assertSafeSegment(segment: string, kind: "route" | "output"): void {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    CONTROL_CHARACTERS.test(segment) ||
    segment.endsWith(".") ||
    segment.endsWith(" ") ||
    Array.from(segment).length > (
      kind === "route" ? MAX_ROUTE_SEGMENT_CODE_POINTS : MAX_OUTPUT_SEGMENT_CODE_POINTS
    ) ||
    WINDOWS_RESERVED_SEGMENT.test(segment)
  ) {
    throw new PublicationRoutePlanningErrorV1(
      kind === "route" ? "unsafe-route" : "unsafe-output-path",
      `Unsafe ${kind} segment "${segment}".`,
      kind === "route" ? { route: segment } : { path: segment },
    );
  }
  if (kind === "route" && !SAFE_ROUTE_SEGMENT.test(segment)) {
    throw new PublicationRoutePlanningErrorV1(
      "unsafe-route",
      `Route segment "${segment}" contains unsupported characters.`,
      { route: segment },
    );
  }
}

/**
 * Normalize and validate a route prefix. The root spellings `""` and `"/"`
 * both normalize to `""`; non-root prefixes have no trailing slash.
 */
export function normalizePublicationRoutePrefixV1(prefix: string): string {
  if (typeof prefix !== "string" || CONTROL_CHARACTERS.test(prefix)) {
    throw new PublicationRoutePlanningErrorV1(
      "unsafe-prefix",
      "Route prefix must be a string without control characters.",
    );
  }
  if (prefix === "" || prefix === "/") return "";
  if (
    !prefix.startsWith("/") ||
    prefix.endsWith("/") ||
    prefix.includes("//") ||
    prefix.includes("\\") ||
    prefix.includes("?") ||
    prefix.includes("#") ||
    prefix.includes("%") ||
    Array.from(prefix).length > MAX_ROUTE_CODE_POINTS
  ) {
    throw new PublicationRoutePlanningErrorV1(
      "unsafe-prefix",
      `Unsafe route prefix "${prefix}". Use an absolute path without a trailing slash.`,
      { route: prefix },
    );
  }
  const normalized = prefix.normalize("NFC");
  for (const segment of normalized.slice(1).split("/")) {
    try {
      assertSafeSegment(segment, "route");
    } catch (error) {
      if (error instanceof PublicationRoutePlanningErrorV1) {
        throw new PublicationRoutePlanningErrorV1(
          "unsafe-prefix",
          `Unsafe route prefix "${prefix}": ${error.message}`,
          { route: prefix },
        );
      }
      throw error;
    }
  }
  return normalized;
}

/** Normalize a safe absolute publication route to its trailing-slash form. */
export function normalizePublicationRouteV1(route: string): string {
  if (
    typeof route !== "string" ||
    route.length === 0 ||
    CONTROL_CHARACTERS.test(route) ||
    !route.startsWith("/") ||
    route.includes("//") ||
    route.includes("\\") ||
    route.includes("?") ||
    route.includes("#") ||
    route.includes("%") ||
    Array.from(route).length > MAX_ROUTE_CODE_POINTS
  ) {
    throw new PublicationRoutePlanningErrorV1(
      "unsafe-route",
      `Unsafe publication route "${String(route)}".`,
      { route: String(route) },
    );
  }
  if (route === "/") return route;
  const normalized = route.normalize("NFC");
  const withoutTrailingSlash = normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
  const segments = withoutTrailingSlash.slice(1).split("/");
  for (const segment of segments) assertSafeSegment(segment, "route");
  return `/${segments.join("/")}/`;
}

/**
 * Produce a conservative, Unicode-capable route segment from an authored
 * title. Separators and punctuation never survive into the path.
 */
export function publicationSlugV1(title: string): string {
  const normalized = String(title)
    .replace(/ß/g, "ss")
    .replace(/ẞ/g, "ss")
    .normalize("NFKD")
    // Fold Latin accents while preserving script-significant marks such as
    // Japanese dakuten; NFC recomposes those before tokenization.
    .replace(/[\u0300-\u036f]+/g, "")
    .normalize("NFC")
    .toLowerCase();
  const parts = normalized.match(/[\p{Letter}\p{Number}]+/gu) ?? [];
  let slug = codePointSlice(parts.join("-"), MAX_GENERATED_ROUTE_SEGMENT_CODE_POINTS)
    .replace(/-+$/g, "");
  if (!slug) slug = "page";
  if (WINDOWS_RESERVED_SEGMENT.test(slug) || slug === "." || slug === "..") {
    slug = `${slug}-page`;
  }
  return slug;
}

function sourceSuffix(sourceId: string): string {
  return codePointSlice(publicationSlugV1(sourceId), MAX_SOURCE_SUFFIX_CODE_POINTS);
}

function routeWithinPrefix(route: string, prefix: string): boolean {
  return prefix === "" || route === `${prefix}/` || route.startsWith(`${prefix}/`);
}

/** Normalize a route and prove that it remains inside the configured prefix. */
export function normalizePublicationRouteForPrefixV1(
  route: string,
  prefix: string,
): string {
  const normalizedPrefix = normalizePublicationRoutePrefixV1(prefix);
  const normalizedRoute = normalizePublicationRouteV1(route);
  if (!routeWithinPrefix(normalizedRoute, normalizedPrefix)) {
    throw new PublicationRoutePlanningErrorV1(
      "unsafe-route",
      `Route "${normalizedRoute}" is outside prefix "${normalizedPrefix || "/"}".`,
      { route: normalizedRoute },
    );
  }
  return normalizedRoute;
}

function generatedRoute(prefix: string, title: string): string {
  return `${prefix}/${publicationSlugV1(title)}/`;
}

/** Map a builder-neutral logical route to its final relative Astro output. */
export function publicationRouteToOutputPathV1(
  route: string,
  outputProfile: PublicationOutputProfileV1,
): string {
  const normalized = normalizePublicationRouteV1(route);
  const stem = normalized === "/" ? "" : normalized.slice(1, -1);
  const path = outputProfile === "directory"
    ? (stem ? `${stem}/index.html` : "index.html")
    : (stem ? `${stem}.html` : "index.html");
  validatePublicationOutputPathV1(path);
  return path;
}

/** Validate a relative POSIX output path without normalizing unsafe input. */
export function validatePublicationOutputPathV1(path: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("//") ||
    CONTROL_CHARACTERS.test(path) ||
    Array.from(path).length > MAX_OUTPUT_PATH_CODE_POINTS ||
    /^[A-Za-z]:/.test(path)
  ) {
    throw new PublicationRoutePlanningErrorV1(
      "unsafe-output-path",
      `Unsafe publication output path "${String(path)}".`,
      { path: String(path) },
    );
  }
  for (const segment of path.split("/")) {
    assertSafeSegment(segment, "output");
    if (/[<>:"|?*]/.test(segment)) {
      throw new PublicationRoutePlanningErrorV1(
        "unsafe-output-path",
        `Unsafe publication output segment "${segment}".`,
        { path },
      );
    }
  }
  return path.normalize("NFC");
}

function claimRoute(
  route: string,
  sourceId: string,
  exact: Map<string, RouteOwner>,
  folded: Map<string, RouteOwner>,
  allowExactSameOwner: boolean,
): void {
  const exactOwner = exact.get(route);
  if (exactOwner && (!allowExactSameOwner || exactOwner.sourceId !== sourceId)) {
    throw new PublicationRoutePlanningErrorV1(
      "route-collision",
      `Route "${route}" is owned by both "${exactOwner.sourceId}" and "${sourceId}".`,
      { sourceId, otherSourceId: exactOwner.sourceId, route },
    );
  }
  const foldedKey = routeFold(route);
  const foldedOwner = folded.get(foldedKey);
  if (foldedOwner && foldedOwner.route !== route) {
    throw new PublicationRoutePlanningErrorV1(
      "route-collision",
      `Route "${route}" case-folds to existing route "${foldedOwner.route}".`,
      { sourceId, otherSourceId: foldedOwner.sourceId, route },
    );
  }
  if (!exactOwner) exact.set(route, { sourceId, route });
  if (!foldedOwner) folded.set(foldedKey, { sourceId, route });
}

function routeAvailable(
  route: string,
  sourceId: string,
  exact: ReadonlyMap<string, RouteOwner>,
  folded: ReadonlyMap<string, RouteOwner>,
): boolean {
  const exactOwner = exact.get(route);
  if (exactOwner && exactOwner.sourceId !== sourceId) return false;
  const foldedOwner = folded.get(routeFold(route));
  return !foldedOwner || (foldedOwner.sourceId === sourceId && foldedOwner.route === route);
}

function claimOutput(
  owner: OutputOwner,
  exact: Map<string, OutputOwner>,
  folded: Map<string, OutputOwner>,
): void {
  const existingExact = exact.get(owner.path);
  const foldedKey = outputPathFold(owner.path);
  const existingFolded = folded.get(foldedKey);
  const collision = existingExact ?? (
    existingFolded && existingFolded.path !== owner.path ? existingFolded : undefined
  );
  if (collision && collision.sourceId !== owner.sourceId) {
    throw new PublicationRoutePlanningErrorV1(
      "output-path-collision",
      `Output path "${owner.path}" collides with "${collision.path}".`,
      {
        sourceId: owner.sourceId,
        otherSourceId: collision.sourceId,
        route: owner.route,
        path: owner.path,
      },
    );
  }
  if (!existingExact) exact.set(owner.path, owner);
  if (!existingFolded) folded.set(foldedKey, owner);
}

function changedRecord(
  sourceId: string,
  previous: PublicationRouteRecordV1 | undefined,
  route: string,
  state: PublicationRouteRecordV1["state"],
  assignedBy: PublicationRouteRecordV1["assignedBy"],
): PublicationRouteRecordV1 {
  const previousRoutes = new Set(previous?.previousRoutes ?? []);
  if (previous && previous.route !== route) previousRoutes.add(previous.route);
  previousRoutes.delete(route);
  return {
    sourceId,
    route,
    state,
    assignedBy,
    previousRoutes: [...previousRoutes].sort(compareStrings),
  };
}

/**
 * Reconcile the project-owned route registry without inferring source state.
 * Existing and tombstoned identities are reserved before any new allocation.
 */
export function planPublicationRoutesV1(
  request: PublicationRoutePlanRequestV1,
): PublicationRoutePlanV1 {
  if (
    request.policy.generatedStyle !== "stable-pretty" ||
    request.policy.collisions !== "stable-source-suffix" ||
    request.policy.tombstones !== "retain"
  ) {
    throw new PublicationRoutePlanningErrorV1(
      "invalid-route-policy",
      "Route planning supports only stable-pretty, stable-source-suffix, and retained tombstones.",
    );
  }
  if (request.outputProfile !== "directory" && request.outputProfile !== "portable-file") {
    throw new PublicationRoutePlanningErrorV1(
      "invalid-route-policy",
      `Unsupported output profile "${String(request.outputProfile)}".`,
    );
  }
  const prefix = normalizePublicationRoutePrefixV1(request.policy.prefix);
  const pageById = new Map<string, PublicationRoutePageV1>();
  for (const page of request.pages) {
    const sourceId = nonEmptyIdentity(page.sourceId, "Page sourceId");
    if (pageById.has(sourceId)) {
      throw new PublicationRoutePlanningErrorV1(
        "duplicate-source-id",
        `Duplicate active page sourceId "${sourceId}".`,
        { sourceId },
      );
    }
    pageById.set(sourceId, page);
  }

  const previousById = new Map<string, PublicationRouteRecordV1>();
  const routeExact = new Map<string, RouteOwner>();
  const routeFolded = new Map<string, RouteOwner>();
  for (const record of request.previousRoutes) {
    const sourceId = nonEmptyIdentity(record.sourceId, "Route record sourceId");
    if (
      (record.state !== "active" && record.state !== "tombstone") ||
      (record.assignedBy !== "generated" && record.assignedBy !== "operator") ||
      !Array.isArray(record.previousRoutes)
    ) {
      throw new PublicationRoutePlanningErrorV1(
        "invalid-route-record",
        `Route record for "${sourceId}" has an unsupported state or assignment.`,
        { sourceId, route: record.route },
      );
    }
    if (previousById.has(sourceId)) {
      throw new PublicationRoutePlanningErrorV1(
        "duplicate-route-record",
        `Duplicate route record for sourceId "${sourceId}".`,
        { sourceId },
      );
    }
    const route = normalizePublicationRouteForPrefixV1(record.route, prefix);
    if (route !== record.route) {
      throw new PublicationRoutePlanningErrorV1(
        "unsafe-route",
        `Existing route "${record.route}" is not canonical; expected "${route}".`,
        { sourceId, route: record.route },
      );
    }
    claimRoute(route, sourceId, routeExact, routeFolded, false);
    const seenPrevious = new Set<string>();
    for (const prior of record.previousRoutes) {
      const normalizedPrior = normalizePublicationRouteV1(prior);
      if (normalizedPrior !== prior || seenPrevious.has(prior) || prior === route) {
        throw new PublicationRoutePlanningErrorV1(
          "duplicate-route-record",
          `Route record for "${sourceId}" contains a duplicate or non-canonical previous route.`,
          { sourceId, route: prior },
        );
      }
      normalizePublicationRouteForPrefixV1(prior, prefix);
      seenPrevious.add(prior);
      claimRoute(prior, sourceId, routeExact, routeFolded, false);
    }
    previousById.set(sourceId, record);
  }

  const tombstoneIds = new Set<string>();
  for (const rawSourceId of request.tombstoneSourceIds) {
    const sourceId = nonEmptyIdentity(rawSourceId, "Tombstone sourceId");
    if (tombstoneIds.has(sourceId)) {
      throw new PublicationRoutePlanningErrorV1(
        "duplicate-source-id",
        `Duplicate tombstone sourceId "${sourceId}".`,
        { sourceId },
      );
    }
    if (pageById.has(sourceId)) {
      throw new PublicationRoutePlanningErrorV1(
        "conflicting-source-state",
        `Source "${sourceId}" cannot be active and tombstoned in one plan.`,
        { sourceId },
      );
    }
    if (!previousById.has(sourceId)) {
      throw new PublicationRoutePlanningErrorV1(
        "unknown-tombstone-source",
        `Cannot tombstone unknown source "${sourceId}" without a retained route.`,
        { sourceId },
      );
    }
    tombstoneIds.add(sourceId);
  }

  const reservedRoutes: string[] = [];
  for (const reserved of request.reservedRoutes ?? []) {
    const route = normalizePublicationRouteV1(reserved);
    claimRoute(route, `[reserved:${route}]`, routeExact, routeFolded, false);
    reservedRoutes.push(route);
  }

  const customById = new Map<string, string>();
  for (const override of request.policy.customRoutes) {
    const sourceId = nonEmptyIdentity(override.sourceId, "Custom route sourceId");
    if (customById.has(sourceId)) {
      throw new PublicationRoutePlanningErrorV1(
        "duplicate-custom-route",
        `Duplicate custom route for sourceId "${sourceId}".`,
        { sourceId },
      );
    }
    if (!pageById.has(sourceId)) {
      throw new PublicationRoutePlanningErrorV1(
        "unknown-custom-source",
        `Custom route targets inactive or unknown source "${sourceId}".`,
        { sourceId, route: override.route },
      );
    }
    const route = normalizePublicationRouteForPrefixV1(override.route, prefix);
    customById.set(sourceId, route);
  }

  // Operator choices are authoritative and reserve their targets before any
  // generated allocation. A route already retained by the same source may be
  // reused (for example, reverting to a previous route).
  for (const [sourceId, route] of [...customById].sort(([left], [right]) =>
    compareStrings(left, right))) {
    if (!routeAvailable(route, sourceId, routeExact, routeFolded)) {
      const owner = routeExact.get(route) ?? routeFolded.get(routeFold(route));
      throw new PublicationRoutePlanningErrorV1(
        "route-collision",
        `Custom route "${route}" is already owned by "${owner?.sourceId ?? "another route"}".`,
        { sourceId, otherSourceId: owner?.sourceId, route },
      );
    }
    claimRoute(route, sourceId, routeExact, routeFolded, true);
  }

  const nextById = new Map<string, PublicationRouteRecordV1>(previousById);
  const changes: PublicationRouteChangeV1[] = [];
  const newGenerated = [...pageById.values()]
    .filter((page) => !previousById.has(page.sourceId) && !customById.has(page.sourceId))
    .map((page) => ({ page, baseRoute: generatedRoute(prefix, page.title) }))
    .sort((left, right) =>
      compareStrings(left.baseRoute, right.baseRoute) ||
      compareStrings(left.page.sourceId, right.page.sourceId));

  for (const { page, baseRoute } of newGenerated) {
    let route = baseRoute;
    if (!routeAvailable(route, page.sourceId, routeExact, routeFolded)) {
      const stem = baseRoute.slice(0, -1);
      const suffix = sourceSuffix(page.sourceId);
      route = `${stem}-${suffix}/`;
      let ordinal = 2;
      while (!routeAvailable(route, page.sourceId, routeExact, routeFolded)) {
        route = `${stem}-${suffix}-${ordinal}/`;
        ordinal += 1;
      }
    }
    claimRoute(route, page.sourceId, routeExact, routeFolded, false);
    nextById.set(page.sourceId, {
      sourceId: page.sourceId,
      route,
      state: "active",
      assignedBy: "generated",
      previousRoutes: [],
    });
    changes.push({ kind: "assigned", sourceId: page.sourceId, nextRoute: route });
  }

  for (const page of [...pageById.values()].sort((left, right) =>
    compareStrings(left.sourceId, right.sourceId))) {
    const previous = previousById.get(page.sourceId);
    const customRoute = customById.get(page.sourceId);
    if (!previous && !customRoute) continue;
    const route = customRoute ?? previous!.route;
    const record = changedRecord(
      page.sourceId,
      previous,
      route,
      "active",
      customRoute ? "operator" : previous!.assignedBy,
    );
    nextById.set(page.sourceId, record);
    if (!previous) {
      changes.push({ kind: "assigned", sourceId: page.sourceId, nextRoute: route });
    } else if (previous.route !== route) {
      changes.push({
        kind: "changed",
        sourceId: page.sourceId,
        previousRoute: previous.route,
        nextRoute: route,
      });
    } else if (previous.state === "tombstone") {
      changes.push({ kind: "reactivated", sourceId: page.sourceId, nextRoute: route });
    }
  }

  for (const sourceId of [...tombstoneIds].sort(compareStrings)) {
    const previous = previousById.get(sourceId)!;
    nextById.set(sourceId, { ...previous, state: "tombstone" });
    if (previous.state !== "tombstone") {
      changes.push({ kind: "tombstoned", sourceId, nextRoute: previous.route });
    }
  }

  const outputExact = new Map<string, OutputOwner>();
  const outputFolded = new Map<string, OutputOwner>();
  for (const route of reservedRoutes) {
    const path = publicationRouteToOutputPathV1(route, request.outputProfile);
    claimOutput(
      { sourceId: `[reserved-route:${route}]`, route, path },
      outputExact,
      outputFolded,
    );
  }
  for (const path of request.reservedOutputPaths ?? []) {
    const normalized = validatePublicationOutputPathV1(path);
    if (normalized !== path) {
      throw new PublicationRoutePlanningErrorV1(
        "unsafe-output-path",
        `Reserved output path "${path}" is not canonical; expected "${normalized}".`,
        { path },
      );
    }
    claimOutput(
      { sourceId: `[reserved:${path}]`, path },
      outputExact,
      outputFolded,
    );
  }

  // Current and retained historical routes participate in the output mapping
  // check, so a newly active page cannot claim a path whose route identity is
  // still retained by another source.
  for (const [sourceId, record] of [...nextById].sort(([left], [right]) =>
    compareStrings(left, right))) {
    for (const route of [record.route, ...record.previousRoutes]) {
      const path = publicationRouteToOutputPathV1(route, request.outputProfile);
      claimOutput({ sourceId, route, path }, outputExact, outputFolded);
    }
  }

  const routes = [...nextById.values()]
    .map((record) => ({
      ...record,
      previousRoutes: [...record.previousRoutes].sort(compareStrings),
    }))
    .sort((left, right) => compareStrings(left.sourceId, right.sourceId));
  const activeOutputs = routes
    .filter((record) => record.state === "active" && pageById.has(record.sourceId))
    .map((record) => ({
      sourceId: record.sourceId,
      route: record.route,
      outputPath: publicationRouteToOutputPathV1(record.route, request.outputProfile),
    }));

  return {
    routes,
    activeOutputs,
    changes: changes.sort((left, right) =>
      compareStrings(left.sourceId, right.sourceId) ||
      compareStrings(left.kind, right.kind)),
  };
}
