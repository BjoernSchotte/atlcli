import { expect, test } from "bun:test";
import type { ChartDiagnosticCodeV1 } from "@atlcli/export-blocks";
import {
  applyPublicationChartDiagnosticPolicyV1,
  assertPublicationChartBuildPolicyV1,
  collectPublicationChartIssuesV1,
  type PublicationPageV1,
  type PublicationProjectV1,
  type PublicationRefreshPlanV1,
} from "./index.js";

function project(completeness: "strict" | "allow-partial", p0Codes?: readonly ChartDiagnosticCodeV1[]): PublicationProjectV1 {
  return {
    schema: "atlcli.publication-project/1",
    publicationKey: "chart-policy",
    source: { kind: "page", pageId: "page-1" },
    sourcePolicy: { representation: "adf-primary", includeLabels: [], excludeLabels: [], excludeMode: "page-only", maxPages: 10, maxFolders: 10 },
    completeness,
    visibility: "internal",
    routes: { prefix: "/", generatedStyle: "stable-pretty", collisions: "stable-source-suffix", tombstones: "retain", customRoutes: [] },
    macros: { mode: "static-only", unknown: "visible-fallback", maxRows: 100, maxNodes: 1_000, maxBytes: 100_000, ...(p0Codes ? { chartDiagnostics: { p0Codes } } : {}) },
    assets: { selfContained: true, external: "same-origin-only", allowedOrigins: [], activeContent: "block", maxAssetBytes: 1_000_000, maxTotalBytes: 10_000_000, maxImagePixels: 10_000_000, maxSvgNodes: 10_000 },
    renderers: { allowedRendererIds: [], allowIslands: false, maxIslandBytes: 1, maxChartRows: 100, maxChartSeries: 10 },
    experience: { id: "atlcli.starlight", requiredCapabilities: [], designTokens: {}, componentOverrides: {} },
    search: { provider: "pagefind", enabled: true, languages: ["en"], filters: [], metadata: [], ranking: { title: 1, headings: 1, labels: 1, body: 1 }, ui: "page", shortcut: "none" },
    seo: { sitemap: true, robots: "noindex", canonical: true, structuredData: [], socialCards: "metadata-only", feed: "disabled" },
    i18n: { defaultLocale: "en", locales: ["en"], routeMode: "hide-default", fallback: {}, uiTranslations: "starlight" },
    media: { images: "verified-original", formats: ["original"], fonts: "system", imageZoom: false, code: "expressive-code" },
    analytics: { provider: "none" },
    editLink: { provider: "none" },
    builder: { builder: "astro-static", projectDir: "/tmp/site", integrationOptions: { bundlePath: "/tmp/bundle", routePrefix: "/", experienceId: "atlcli.starlight" }, outputProfile: "directory", base: "/", buildCommand: ["bun", "run", "build"] },
    retention: { bundles: 2, builds: 2, graceSeconds: 60 },
  };
}

const page: PublicationPageV1 = {
  schema: "atlcli.publication-page/1",
  sourceId: "page-1",
  sourceVersion: "1",
  title: "Chart",
  position: 0,
  depth: 0,
  route: "/chart/",
  blocks: [{
    type: "chart",
    localId: "private-provider-id",
    chart: {
      schema: "atlcli.chart/1",
      kind: "bar",
      data: { mode: "categories", labels: ["A"], series: [{ id: "values", label: "Values", values: [1] }] },
      source: { kind: "cloud-adf", macroName: "chart" },
    },
    diagnostics: [
      { code: "skipped-row", message: "Secret provider value was skipped.", row: 2 },
      { code: "invalid-option", message: "3D was flattened.", parameter: "3d" },
    ],
  }],
  notes: [],
  labels: [],
  links: [],
  assetIds: [],
  renderDependencies: [],
  pageDigest: "page-digest",
};

const refreshPlan: PublicationRefreshPlanV1 = {
  schema: "atlcli.publication-refresh-plan/1",
  sourceSnapshot: { sourceDigest: "source", complete: true, deletionAuthority: "complete-scan", rootIds: ["page-1"], pages: [] },
  changes: [],
  complete: true,
  issues: [],
  planDigest: "old-digest",
};

test("strict chart policy converts default P0 diagnostics into safe build-blocking issues", async () => {
  const strict = project("strict");
  const issues = collectPublicationChartIssuesV1(strict, [page]);
  expect(issues.map((issue) => [issue.level, issue.code])).toEqual([
    ["warning", "chart-diagnostic"],
    ["error", "chart-p0-diagnostic"],
  ]);
  expect(JSON.stringify(issues)).not.toContain("Secret provider value");
  expect(JSON.stringify(issues)).not.toContain("private-provider-id");
  const applied = await applyPublicationChartDiagnosticPolicyV1(strict, [page], refreshPlan);
  expect(applied.complete).toBe(false);
  expect(applied.planDigest).not.toBe("old-digest");
  expect(() => assertPublicationChartBuildPolicyV1(strict, applied.issues)).toThrow("P0 chart diagnostics");
});

test("allow-partial keeps the visible chart and reports every diagnostic without blocking the build", async () => {
  const partial = project("allow-partial");
  const applied = await applyPublicationChartDiagnosticPolicyV1(partial, [page], refreshPlan);
  expect(applied.complete).toBe(true);
  expect(applied.issues).toHaveLength(2);
  expect(applied.issues.every((issue) => issue.level === "warning")).toBe(true);
  expect(() => assertPublicationChartBuildPolicyV1(partial, applied.issues)).not.toThrow();
});

test("project policy can promote an otherwise approximated chart option to P0", () => {
  const strict = project("strict", ["invalid-option"]);
  expect(collectPublicationChartIssuesV1(strict, [page]).map((issue) => [issue.code, issue.level])).toEqual([
    ["chart-diagnostic", "warning"],
    ["chart-p0-diagnostic", "error"],
  ]);
});
