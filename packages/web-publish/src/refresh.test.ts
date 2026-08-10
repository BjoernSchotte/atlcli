import { describe, expect, test } from "bun:test";
import {
  PublicationRefreshPlanningErrorV1,
  planPublicationRefreshV1,
  type PublicationSourcePageSnapshotV1,
  type PublicationSourceSnapshotV1,
} from "./index.js";

function page(
  sourceId: string,
  overrides: Partial<PublicationSourcePageSnapshotV1> = {},
): PublicationSourcePageSnapshotV1 {
  return {
    sourceId,
    sourceVersion: "1",
    representation: "atlas_doc_format",
    position: 0,
    depth: 0,
    title: sourceId,
    contentDigest: `content-${sourceId}`,
    metadataDigest: `metadata-${sourceId}`,
    assetMetadataDigest: `assets-${sourceId}`,
    macroDependencyDigest: `live-macros-${sourceId}`,
    state: "included",
    ...overrides,
  };
}

function snapshot(
  pages: readonly PublicationSourcePageSnapshotV1[],
  overrides: Partial<PublicationSourceSnapshotV1> = {},
): PublicationSourceSnapshotV1 {
  return {
    sourceDigest: "source-digest",
    complete: true,
    deletionAuthority: "complete-scan",
    rootIds: ["guide"],
    pages,
    ...overrides,
  };
}

function routes(sourceId: string, route: string) {
  return [{ sourceId, route, state: "active" as const, assignedBy: "generated" as const, previousRoutes: [] }];
}

function expectError(
  run: () => Promise<unknown>,
  code: PublicationRefreshPlanningErrorV1["code"],
): Promise<void> {
  return run().then(
    () => { throw new Error(`Expected ${code}`); },
    (error: unknown) => {
      expect(error).toBeInstanceOf(PublicationRefreshPlanningErrorV1);
      expect((error as PublicationRefreshPlanningErrorV1).code).toBe(code);
    },
  );
}

describe("publication refresh planning", () => {
  test("distinguishes every non-destructive source state without guessing deletion", async () => {
    const previous = snapshot([
      page("deleted"), page("excluded"), page("out"), page("inaccessible"), page("partial-missing"),
    ]);
    const current = snapshot([
      page("excluded", { state: "excluded" }),
      page("out", { state: "out-of-scope" }),
      page("inaccessible", { state: "inaccessible" }),
    ], { complete: false, deletionAuthority: "none" });

    const plan = await planPublicationRefreshV1({ previous, current });
    expect(plan.complete).toBe(false);
    expect(plan.changes.map((change) => [change.sourceId, change.kind])).toEqual([
      ["excluded", "exclude"],
      ["inaccessible", "inaccessible"],
      ["out", "out-of-scope"],
    ]);
    expect(plan.issues.map((issue) => [issue.source?.sourceId, issue.code])).toEqual([
      ["deleted", "partial-source"],
      ["excluded", "excluded-source"],
      ["inaccessible", "inaccessible-source"],
      ["out", "out-of-scope-source"],
      ["partial-missing", "partial-source"],
    ]);
  });

  test("permits destructive deletion only with complete-scan authority", async () => {
    const previous = snapshot([page("gone")]);
    const plan = await planPublicationRefreshV1({
      previous,
      current: snapshot([]),
      previousRoutes: routes("gone", "/gone/"),
    });
    expect(plan.changes).toEqual([{
      kind: "confirmed-delete",
      sourceId: "gone",
      previousDigest: "content-gone",
      previousRoute: "/gone/",
    }]);
    expect(plan.issues).toEqual([{
      level: "info",
      code: "confirmed-delete",
      message: "Page deletion was confirmed by a complete source traversal.",
      source: { sourceId: "gone" },
    }]);

    await expectError(() => planPublicationRefreshV1({
      previous,
      current: snapshot([page("gone", { state: "deleted" })], { complete: false, deletionAuthority: "none" }),
    }), "unconfirmed-delete");
  });

  test("reports independent content, metadata, move, asset, live dependency, and route changes deterministically", async () => {
    const previous = snapshot([page("guide", {
      title: "Old title",
      contentDigest: "content-old",
      metadataDigest: "metadata-old",
      assetMetadataDigest: "assets-old",
      macroDependencyDigest: "live-macros-old",
      parentId: "old-parent",
      position: 1,
      depth: 1,
    })]);
    const current = snapshot([page("guide", {
      title: "New title",
      contentDigest: "content-new",
      metadataDigest: "metadata-new",
      assetMetadataDigest: "assets-new",
      macroDependencyDigest: "live-macros-new",
      parentId: "new-parent",
      position: 2,
      depth: 2,
    })]);
    const forward = await planPublicationRefreshV1({
      previous,
      current,
      previousRoutes: routes("guide", "/old/"),
      currentRoutes: routes("guide", "/new/"),
    });
    const reverse = await planPublicationRefreshV1({
      previous: { ...previous, pages: [...previous.pages].reverse() },
      current: { ...current, pages: [...current.pages].reverse() },
      previousRoutes: routes("guide", "/old/"),
      currentRoutes: routes("guide", "/new/"),
    });
    expect(forward).toEqual(reverse);
    expect(forward.changes.map((change) => change.kind)).toEqual([
      "asset-change", "content-change", "live-dependency-change", "metadata-change", "move", "route-change",
    ]);
    expect(forward.planDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("invalidates only the page whose selected chart table changed", async () => {
    const previous = snapshot([
      page("chart-page", {
        contentDigest: "chart-model-fnv1a-old",
        macroDependencyDigest: "selected-table-fnv1a-old",
      }),
      page("unrelated-page", {
        contentDigest: "unrelated-content-stable",
        macroDependencyDigest: "selected-table-fnv1a-stable",
      }),
    ]);
    const current = snapshot([
      page("chart-page", {
        sourceVersion: "2",
        contentDigest: "chart-model-fnv1a-new",
        macroDependencyDigest: "selected-table-fnv1a-new",
      }),
      page("unrelated-page", {
        sourceVersion: "2",
        contentDigest: "unrelated-content-stable",
        macroDependencyDigest: "selected-table-fnv1a-stable",
      }),
    ]);

    const plan = await planPublicationRefreshV1({ previous, current });

    expect(plan.changes.map((change) => [change.sourceId, change.kind])).toEqual([
      ["chart-page", "content-change"],
      ["chart-page", "live-dependency-change"],
    ]);
    expect(plan.changes.some((change) => change.sourceId === "unrelated-page")).toBe(false);
    expect(plan.planDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("rejects duplicate observations and registry records rather than changing output ambiguously", async () => {
    await expectError(() => planPublicationRefreshV1({
      current: snapshot([page("guide"), page("guide")]),
    }), "duplicate-current-page");
    await expectError(() => planPublicationRefreshV1({
      current: snapshot([page("guide")]),
      currentRoutes: [...routes("guide", "/guide/"), ...routes("guide", "/other/")],
    }), "duplicate-current-route");
  });
});
