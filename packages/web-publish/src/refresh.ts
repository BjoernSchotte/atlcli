import type {
  PublicationChangeV1,
  PublicationIssueV1,
  PublicationRefreshPlanV1,
  PublicationRouteRecordV1,
  PublicationSourcePageSnapshotV1,
  PublicationSourceSnapshotV1,
} from "./contracts.js";
import { PUBLICATION_ISSUE_CODES_V1 } from "./contracts.js";
import { digestPublicationRefreshPlanV1 } from "./digests.js";
import { normalizePublicationRouteV1 } from "./routes.js";

export type PublicationRefreshPlanningErrorCodeV1 =
  | "duplicate-previous-page"
  | "duplicate-current-page"
  | "duplicate-previous-route"
  | "duplicate-current-route"
  | "unconfirmed-delete";

export class PublicationRefreshPlanningErrorV1 extends Error {
  constructor(
    public readonly code: PublicationRefreshPlanningErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "PublicationRefreshPlanningErrorV1";
  }
}

export interface PlanPublicationRefreshRequestV1 {
  previousBundleDigest?: string;
  previous?: PublicationSourceSnapshotV1;
  current: PublicationSourceSnapshotV1;
  previousRoutes?: readonly PublicationRouteRecordV1[];
  currentRoutes?: readonly PublicationRouteRecordV1[];
}

function fail(code: PublicationRefreshPlanningErrorCodeV1, message: string): never {
  throw new PublicationRefreshPlanningErrorV1(code, message);
}

function pageMap(
  snapshot: PublicationSourceSnapshotV1 | undefined,
  duplicateCode: "duplicate-previous-page" | "duplicate-current-page",
): ReadonlyMap<string, PublicationSourcePageSnapshotV1> {
  const pages = new Map<string, PublicationSourcePageSnapshotV1>();
  if (snapshot === undefined) return pages;
  for (const page of snapshot.pages) {
    if (pages.has(page.sourceId)) fail(duplicateCode, `Source snapshot repeats page '${page.sourceId}'`);
    pages.set(page.sourceId, page);
  }
  return pages;
}

function activeRouteMap(
  records: readonly PublicationRouteRecordV1[] | undefined,
  duplicateCode: "duplicate-previous-route" | "duplicate-current-route",
): ReadonlyMap<string, string> {
  const routes = new Map<string, string>();
  for (const record of records ?? []) {
    if (record.state !== "active") continue;
    if (routes.has(record.sourceId)) fail(duplicateCode, `Route registry repeats '${record.sourceId}'`);
    routes.set(record.sourceId, normalizePublicationRouteV1(record.route));
  }
  return routes;
}

function addChange(
  changes: PublicationChangeV1[],
  kind: PublicationChangeV1["kind"],
  sourceId: string,
  previous: PublicationSourcePageSnapshotV1 | undefined,
  current: PublicationSourcePageSnapshotV1 | undefined,
  previousRoute: string | undefined,
  nextRoute: string | undefined,
): void {
  changes.push({
    kind,
    sourceId,
    ...(previous === undefined ? {} : { previousDigest: previous.contentDigest }),
    ...(current === undefined ? {} : { nextDigest: current.contentDigest }),
    ...(previousRoute === undefined ? {} : { previousRoute }),
    ...(nextRoute === undefined ? {} : { nextRoute }),
  });
}

function changeIssue(
  kind: PublicationChangeV1["kind"],
  sourceId: string,
): PublicationIssueV1 | undefined {
  switch (kind) {
    case "confirmed-delete":
      return { level: "info", code: PUBLICATION_ISSUE_CODES_V1.CONFIRMED_DELETE, message: "Page deletion was confirmed by a complete source traversal.", source: { sourceId } };
    case "exclude":
      return { level: "info", code: PUBLICATION_ISSUE_CODES_V1.EXCLUDED_SOURCE, message: "Page is excluded by the publication source policy.", source: { sourceId } };
    case "out-of-scope":
      return { level: "info", code: PUBLICATION_ISSUE_CODES_V1.OUT_OF_SCOPE_SOURCE, message: "Page is outside the configured publication scope.", source: { sourceId } };
    case "inaccessible":
      return { level: "warning", code: PUBLICATION_ISSUE_CODES_V1.INACCESSIBLE_SOURCE, message: "Page is temporarily inaccessible and is not deletion evidence.", source: { sourceId } };
    default:
      return undefined;
  }
}

function sortChanges(changes: readonly PublicationChangeV1[]): readonly PublicationChangeV1[] {
  return [...changes].sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId) || left.kind.localeCompare(right.kind),
  );
}

function sortIssues(issues: readonly PublicationIssueV1[]): readonly PublicationIssueV1[] {
  return [...issues].sort((left, right) =>
    (left.source?.sourceId ?? "").localeCompare(right.source?.sourceId ?? "") ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message),
  );
}

function addStateChange(
  changes: PublicationChangeV1[],
  issues: PublicationIssueV1[],
  kind: "exclude" | "out-of-scope" | "inaccessible" | "confirmed-delete",
  sourceId: string,
  previous: PublicationSourcePageSnapshotV1 | undefined,
  current: PublicationSourcePageSnapshotV1 | undefined,
  previousRoute: string | undefined,
  nextRoute: string | undefined,
): void {
  addChange(changes, kind, sourceId, previous, current, previousRoute, nextRoute);
  const issue = changeIssue(kind, sourceId);
  if (issue !== undefined) issues.push(issue);
}

/**
 * Produce an explicit, deterministic refresh diff. A missing page becomes a
 * destructive `confirmed-delete` only if the *current* traversal is complete
 * and holds complete-scan deletion authority; access failure and partial scans
 * can therefore never remove a published page by inference.
 */
export async function planPublicationRefreshV1(
  request: PlanPublicationRefreshRequestV1,
): Promise<PublicationRefreshPlanV1> {
  const previousPages = pageMap(request.previous, "duplicate-previous-page");
  const currentPages = pageMap(request.current, "duplicate-current-page");
  const previousRoutes = activeRouteMap(request.previousRoutes, "duplicate-previous-route");
  const currentRoutes = activeRouteMap(request.currentRoutes, "duplicate-current-route");
  const changes: PublicationChangeV1[] = [];
  const issues: PublicationIssueV1[] = [];
  const sourceIds = [...new Set([...previousPages.keys(), ...currentPages.keys()])].sort();

  for (const sourceId of sourceIds) {
    const previous = previousPages.get(sourceId);
    const current = currentPages.get(sourceId);
    const previousRoute = previousRoutes.get(sourceId);
    const nextRoute = currentRoutes.get(sourceId);

    if (current === undefined) {
      if (previous === undefined) continue;
      if (request.current.complete && request.current.deletionAuthority === "complete-scan") {
        addStateChange(changes, issues, "confirmed-delete", sourceId, previous, undefined, previousRoute, undefined);
      } else {
        issues.push({
          level: "warning",
          code: PUBLICATION_ISSUE_CODES_V1.PARTIAL_SOURCE,
          message: "Page is absent from a partial or non-authoritative traversal; deletion is not inferred.",
          source: { sourceId },
        });
      }
      continue;
    }

    if (current.state === "deleted") {
      if (!request.current.complete || request.current.deletionAuthority !== "complete-scan") {
        fail("unconfirmed-delete", `Page '${sourceId}' is marked deleted without complete-scan authority`);
      }
      addStateChange(changes, issues, "confirmed-delete", sourceId, previous, current, previousRoute, nextRoute);
      continue;
    }
    if (current.state === "excluded") {
      addStateChange(changes, issues, "exclude", sourceId, previous, current, previousRoute, nextRoute);
      continue;
    }
    if (current.state === "out-of-scope") {
      addStateChange(changes, issues, "out-of-scope", sourceId, previous, current, previousRoute, nextRoute);
      continue;
    }
    if (current.state === "inaccessible") {
      addStateChange(changes, issues, "inaccessible", sourceId, previous, current, previousRoute, nextRoute);
      continue;
    }

    if (previous === undefined || previous.state !== "included") {
      addChange(changes, "add", sourceId, previous, current, previousRoute, nextRoute);
      continue;
    }
    if (previous.contentDigest !== current.contentDigest) {
      addChange(changes, "content-change", sourceId, previous, current, previousRoute, nextRoute);
    }
    if (previous.metadataDigest !== current.metadataDigest || previous.title !== current.title) {
      addChange(changes, "metadata-change", sourceId, previous, current, previousRoute, nextRoute);
    }
    if (
      previous.parentId !== current.parentId ||
      previous.position !== current.position ||
      previous.depth !== current.depth
    ) {
      addChange(changes, "move", sourceId, previous, current, previousRoute, nextRoute);
    }
    if (previous.assetMetadataDigest !== current.assetMetadataDigest) {
      addChange(changes, "asset-change", sourceId, previous, current, previousRoute, nextRoute);
    }
    if (previous.macroDependencyDigest !== current.macroDependencyDigest) {
      addChange(changes, "live-dependency-change", sourceId, previous, current, previousRoute, nextRoute);
    }
    if (previousRoute !== nextRoute && (previousRoute !== undefined || nextRoute !== undefined)) {
      addChange(changes, "route-change", sourceId, previous, current, previousRoute, nextRoute);
    }
  }

  const provisional: PublicationRefreshPlanV1 = {
    schema: "atlcli.publication-refresh-plan/1",
    ...(request.previousBundleDigest === undefined ? {} : { previousBundleDigest: request.previousBundleDigest }),
    sourceSnapshot: request.current,
    changes: sortChanges(changes),
    complete: request.current.complete,
    issues: sortIssues(issues),
    planDigest: "pending",
  };
  return { ...provisional, planDigest: await digestPublicationRefreshPlanV1(provisional) };
}
