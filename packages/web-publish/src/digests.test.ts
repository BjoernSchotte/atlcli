import { describe, expect, test } from "bun:test";
import { chartModelDigestV1, type ChartModelV1 } from "@atlcli/export-blocks";
import {
  PublicationDigestErrorV1,
  PublicationReferencePlanningErrorV1,
  assertPublicationBundleReferencesV1,
  canonicalPublicationJsonV1,
  digestPublicationBundleV1,
  digestPublicationJsonV1,
  digestPublicationPageV1,
  digestPublicationRefreshPlanV1,
  type PublicationBundleV1,
  type PublicationPageV1,
  type PublicationRefreshPlanV1,
} from "./index.js";

const page = {
  schema: "atlcli.publication-page/1",
  sourceId: "guide",
  sourceVersion: "1",
  title: "Guide",
  position: 0,
  depth: 0,
  route: "/guide/",
  blocks: [{ type: "heading", level: 1, content: [{ type: "text", text: "Guide" }] }],
  notes: [],
  labels: [],
  links: [{ referenceId: "image", kind: "asset", assetId: "image" }],
  assetIds: ["image"],
  renderDependencies: [],
  pageDigest: "page-digest",
} as const satisfies PublicationPageV1;

const bundle = {
  schema: "atlcli.publication-bundle/1",
  bundleDigest: "bundle-digest",
  createdBy: { name: "atlcli", version: "0.1.0" },
  sourceSnapshot: {
    sourceDigest: "source-digest",
    complete: true,
    deletionAuthority: "complete-scan",
    rootIds: ["guide"],
    pages: [{
      sourceId: "guide",
      sourceVersion: "1",
      representation: "atlas_doc_format",
      position: 0,
      depth: 0,
      title: "Guide",
      contentDigest: "content-digest",
      metadataDigest: "metadata-digest",
      assetMetadataDigest: "asset-metadata-digest",
      macroDependencyDigest: "no-live-dependencies",
      state: "included",
    }],
  },
  sourcePolicyDigest: "policy-digest",
  complete: true,
  rootIds: ["guide"],
  pages: [{ sourceId: "guide", path: "pages/guide.json", pageDigest: "page-digest" }],
  routes: [{ sourceId: "guide", route: "/guide/", state: "active", assignedBy: "generated", previousRoutes: [] }],
  assets: [{
    assetId: "image",
    path: "assets/image.png",
    sha256: "a".repeat(64),
    byteLength: 1,
    mediaType: "image/png",
    disposition: "inline",
  }],
  issues: [],
} as const satisfies PublicationBundleV1;

const refreshPlan = {
  schema: "atlcli.publication-refresh-plan/1",
  previousBundleDigest: "previous",
  sourceSnapshot: bundle.sourceSnapshot,
  changes: [{ kind: "add", sourceId: "guide", nextDigest: "page-digest" }],
  complete: true,
  issues: [],
  planDigest: "plan-digest",
} as const satisfies PublicationRefreshPlanV1;

function expectDigestError(run: () => unknown, code: PublicationDigestErrorV1["code"]): void {
  expect(run).toThrow(PublicationDigestErrorV1);
  try {
    run();
  } catch (error) {
    expect((error as PublicationDigestErrorV1).code).toBe(code);
  }
}

describe("canonical publication digests", () => {
  test("sorts object keys but retains array order and strips recognized private/volatile fields", () => {
    expect(canonicalPublicationJsonV1({
      z: ["second", "first"],
      a: { projectDir: "/private/workspace", accessToken: "secret", stable: true },
      activeBundleDigest: "self",
      createdAt: "volatile",
    })).toBe('{"a":{"stable":true},"z":["second","first"]}');
  });

  test("rejects cycles, non-finite values, class instances, and sparse arrays", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expectDigestError(() => canonicalPublicationJsonV1(cycle), "cyclic-value");
    expectDigestError(() => canonicalPublicationJsonV1({ value: Number.NaN }), "unsupported-value");
    expectDigestError(() => canonicalPublicationJsonV1(new Date()), "unsupported-value");
    expectDigestError(() => canonicalPublicationJsonV1([, "value"]), "unsupported-value");
  });

  test("creates portable Web-Crypto SHA-256 identities and excludes self digests", async () => {
    await expect(digestPublicationJsonV1({ b: 2, a: 1 })).resolves.toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
    await expect(digestPublicationPageV1(page)).resolves.toBe(await digestPublicationPageV1({
      ...page,
      pageDigest: "another-self-digest",
    }));
    await expect(digestPublicationRefreshPlanV1(refreshPlan)).resolves.toBe(
      await digestPublicationRefreshPlanV1({ ...refreshPlan, previousBundleDigest: "other", planDigest: "another" }),
    );
  });

  test("proves page, route, asset, and link references before a bundle digest", async () => {
    expect(() => assertPublicationBundleReferencesV1(bundle, [page])).not.toThrow();
    const originalDigest = await digestPublicationBundleV1(bundle, [page]);
    expect(originalDigest).toMatch(/^[a-f0-9]{64}$/);
    const changedPage = { ...page, pageDigest: "changed-page-digest" };
    const changedBundle = {
      ...bundle,
      pages: [{ ...bundle.pages[0]!, pageDigest: changedPage.pageDigest }],
    };
    await expect(digestPublicationBundleV1(changedBundle, [changedPage])).resolves.not.toBe(originalDigest);

    expectDigestError(() => assertPublicationBundleReferencesV1({
      ...bundle,
      routes: [],
    }, [page]), "missing-active-route");
    expectDigestError(() => assertPublicationBundleReferencesV1({
      ...bundle,
      pages: [{ ...bundle.pages[0]!, pageDigest: "wrong" }],
    }, [page]), "bundle-page-mismatch");
    expectDigestError(() => assertPublicationBundleReferencesV1({
      ...bundle,
      sourceSnapshot: {
        ...bundle.sourceSnapshot,
        pages: [{ ...bundle.sourceSnapshot.pages[0]!, state: "deleted" }],
      },
    }, [page]), "non-included-source");
    expectDigestError(() => assertPublicationBundleReferencesV1({
      ...bundle,
      sourceSnapshot: { ...bundle.sourceSnapshot, complete: false },
    }, [page]), "incomplete-source-snapshot");
    expectDigestError(() => assertPublicationBundleReferencesV1({
      ...bundle,
      routes: [
        ...bundle.routes,
        { sourceId: "retired", route: "/retired/", state: "active", assignedBy: "generated", previousRoutes: [] },
      ],
    }, [page]), "active-route-without-page");
    expect(() => assertPublicationBundleReferencesV1({
      ...bundle,
      assets: [],
    }, [page])).toThrow(PublicationReferencePlanningErrorV1);
  });

  test("propagates a selected chart-table change through model, page, and bundle identities", async () => {
    const chart = {
      schema: "atlcli.chart/1",
      kind: "bar",
      data: {
        mode: "categories",
        labels: ["Guide"],
        series: [{ id: "pages", label: "Pages", values: [12] }],
      },
      source: {
        kind: "cloud-adf",
        macroName: "chart",
        sourceTableDigests: ["fnv1a-12345678"],
        dependencyDigest: "selected-table-fnv1a-12345678",
      },
    } as const satisfies ChartModelV1;
    const changedChart = {
      ...chart,
      data: {
        ...chart.data,
        series: [{ ...chart.data.series[0]!, values: [13] }],
      },
      source: {
        ...chart.source,
        sourceTableDigests: ["fnv1a-87654321"],
        dependencyDigest: "selected-table-fnv1a-87654321",
      },
    } as const satisfies ChartModelV1;
    const chartPage = {
      ...page,
      sourceId: "provider-page-21465016",
      sourceVersion: "41",
      route: "/charts/",
      title: "Charts",
      blocks: [{ type: "chart" as const, chart }],
      links: [],
      assetIds: [],
    } satisfies PublicationPageV1;
    const changedChartPage = {
      ...chartPage,
      sourceVersion: "42",
      blocks: [{ type: "chart" as const, chart: changedChart }],
    } satisfies PublicationPageV1;
    const oldPageDigest = await digestPublicationPageV1(chartPage);
    const newPageDigest = await digestPublicationPageV1(changedChartPage);
    const storedChartPage = { ...chartPage, pageDigest: oldPageDigest } satisfies PublicationPageV1;
    const storedChangedChartPage = { ...changedChartPage, pageDigest: newPageDigest } satisfies PublicationPageV1;
    const chartBundle = {
      ...bundle,
      sourceSnapshot: {
        ...bundle.sourceSnapshot,
        rootIds: [chartPage.sourceId],
        pages: [{
          ...bundle.sourceSnapshot.pages[0]!,
          sourceId: chartPage.sourceId,
          sourceVersion: chartPage.sourceVersion,
          title: chartPage.title,
          contentDigest: chartModelDigestV1(chart),
          macroDependencyDigest: chart.source.dependencyDigest,
        }],
      },
      rootIds: [chartPage.sourceId],
      pages: [{ sourceId: chartPage.sourceId, path: "pages/chart.json", pageDigest: oldPageDigest }],
      routes: [{ sourceId: chartPage.sourceId, route: chartPage.route, state: "active" as const, assignedBy: "generated" as const, previousRoutes: [] }],
      assets: [],
    } satisfies PublicationBundleV1;
    const changedChartBundle = {
      ...chartBundle,
      sourceSnapshot: {
        ...chartBundle.sourceSnapshot,
        sourceDigest: "source-digest-after-selected-table-change",
        pages: [{
          ...chartBundle.sourceSnapshot.pages[0]!,
          sourceVersion: changedChartPage.sourceVersion,
          contentDigest: chartModelDigestV1(changedChart),
          macroDependencyDigest: changedChart.source.dependencyDigest,
        }],
      },
      pages: [{ ...chartBundle.pages[0]!, pageDigest: newPageDigest }],
    } satisfies PublicationBundleV1;

    expect(chartModelDigestV1(changedChart)).not.toBe(chartModelDigestV1(chart));
    expect(newPageDigest).not.toBe(oldPageDigest);
    await expect(digestPublicationBundleV1(changedChartBundle, [storedChangedChartPage])).resolves.not.toBe(
      await digestPublicationBundleV1(chartBundle, [storedChartPage]),
    );

    // Provider identifiers remain available to the private build package while
    // the source-neutral chart node carries only non-reversible table digests.
    expect(chartPage.sourceId).toBe("provider-page-21465016");
    expect(chartPage.sourceVersion).toBe("41");
    expect(JSON.stringify(chartPage.blocks)).not.toContain(chartPage.sourceId);
    expect(JSON.stringify(chartPage.blocks)).not.toContain(chartPage.sourceVersion);
  });
});
