import { expect, test } from "bun:test";
import type { PublicationPageV1, PublicationProjectV1, PublicationRefreshPlanV1 } from "./contracts.js";
import {
  applyPublicationChartBudgetPolicyV1,
  collectPublicationChartBudgetIssuesV1,
  createPublicationChartRenderPolicyV1,
} from "./chart-budgets.js";

const project = {
  schema: "atlcli.publication-project/1",
  publicationKey: "chart-budget",
  source: { kind: "page", pageId: "p" },
  sourcePolicy: { representation: "adf-primary", includeLabels: [], excludeLabels: [], excludeMode: "page-only", maxPages: 1, maxFolders: 1 },
  completeness: "strict",
  visibility: "internal",
  routes: { prefix: "/", generatedStyle: "stable-pretty", collisions: "stable-source-suffix", tombstones: "retain", customRoutes: [] },
  macros: { mode: "static-only", unknown: "visible-fallback", maxRows: 1, maxNodes: 3, maxBytes: 400 },
  assets: { selfContained: true, external: "same-origin-only", allowedOrigins: [], activeContent: "block", maxAssetBytes: 1, maxTotalBytes: 1, maxImagePixels: 1, maxSvgNodes: 1 },
  renderers: { allowedRendererIds: [], allowIslands: false, maxIslandBytes: 128_000, maxChartRows: 90, maxChartSeries: 20, maxChartPoints: 900, maxChartSvgNodes: 50_000, maxChartSvgBytes: 1_000_000, maxChartRenderMs: 1_000, maxChartIslandMountMs: 120 },
  experience: { id: "atlcli.starlight", requiredCapabilities: [], designTokens: {}, componentOverrides: {} },
  search: { provider: "pagefind", enabled: true, languages: ["en"], filters: [], metadata: [], ranking: { title: 1, headings: 1, labels: 1, body: 1 }, ui: "page", shortcut: "none" },
  seo: { sitemap: true, robots: "noindex", canonical: true, structuredData: [], socialCards: "metadata-only", feed: "disabled" },
  i18n: { defaultLocale: "en", locales: ["en"], routeMode: "hide-default", fallback: {}, uiTranslations: "starlight" },
  media: { images: "verified-original", formats: ["original"], fonts: "system", imageZoom: false, code: "expressive-code" },
  analytics: { provider: "none" }, editLink: { provider: "none" },
  builder: { builder: "astro-static", projectDir: "/tmp/site", integrationOptions: { bundlePath: "/tmp/bundle", routePrefix: "/", experienceId: "atlcli.starlight" }, outputProfile: "directory", base: "/", buildCommand: ["bun", "run", "build"] },
  retention: { bundles: 1, builds: 1, graceSeconds: 0 },
} as const satisfies PublicationProjectV1;

const page = {
  schema: "atlcli.publication-page/1",
  sourceId: "p", sourceVersion: "1", title: "Chart", position: 0, depth: 0, route: "/chart/",
  blocks: [{ type: "chart", chart: { schema: "atlcli.chart/1", kind: "bar", data: { mode: "categories", labels: ["A", "B"], series: [{ id: "s", label: "Series", values: [1, 2] }] }, source: { kind: "cloud-adf", macroName: "chart" } } }],
  notes: [], labels: [], links: [], assetIds: [], renderDependencies: [], pageDigest: "digest",
} as const satisfies PublicationPageV1;

const plan = {
  schema: "atlcli.publication-refresh-plan/1", sourceSnapshot: { sourceDigest: "s", complete: true, deletionAuthority: "complete-scan", rootIds: ["p"], pages: [] }, changes: [], complete: true, issues: [], planDigest: "old",
} as const satisfies PublicationRefreshPlanV1;

test("freezes independent normalization, static, and island chart limits", () => {
  const policy = createPublicationChartRenderPolicyV1(project);
  expect(policy).toMatchObject({
    strict: true,
    normalization: { maxRows: 1, maxPoints: 3, maxBytes: 400 },
    static: { maxSvgNodes: 50_000, maxSvgBytes: 1_000_000, maxRenderMs: 1_000 },
    island: { enabled: false, maxRows: 90, maxSeries: 20, maxPoints: 900, maxBytes: 65_536, maxMountMs: 120 },
  });
  expect(createPublicationChartRenderPolicyV1({
    ...project,
    renderers: { ...project.renderers, maxChartIslandMountMs: Number.MAX_SAFE_INTEGER },
  }).island.maxMountMs).toBe(1_000);
});

test("strict admission reports safe budget issues and makes the refresh incomplete", async () => {
  expect(collectPublicationChartBudgetIssuesV1(project, [page]).map((issue) => issue.message)).toEqual([
    "Chart publication admission exceeded the configured macro maxNodes budget.",
    "Chart publication admission exceeded the configured macro maxRows budget.",
  ]);
  const applied = await applyPublicationChartBudgetPolicyV1(project, [page], plan);
  expect(applied.complete).toBe(false);
  expect(applied.issues.every((issue) => issue.code === "chart-p0-diagnostic" && issue.level === "error")).toBe(true);
  expect(applied.planDigest).not.toBe("old");
});
