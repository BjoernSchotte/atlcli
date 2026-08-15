import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  handlePublish,
  collectChartRenderDependenciesV1,
  isMissingPublicationAttachmentErrorV1,
  latestPublicationBuildNameV1,
  normalizePublicationLinksV1,
  normalizePublicationPositionV1,
  publicationBuildEnvironmentV1,
  publishHelp,
  replaceMissingPublicationAssetsV1,
} from "./publish.js";
import { getCompletions } from "../completions.js";

const project = {
  schema: "atlcli.publication-project/1",
  publicationKey: "synthetic-docs",
  source: { kind: "page", pageId: "page-1" },
  sourcePolicy: {
    representation: "adf-primary",
    includeLabels: [],
    excludeLabels: [],
    excludeMode: "prune-subtree",
    maxPages: 10,
    maxFolders: 10,
  },
  completeness: "strict",
  visibility: "internal",
  routes: {
    prefix: "/publish",
    generatedStyle: "stable-pretty",
    collisions: "stable-source-suffix",
    tombstones: "retain",
    customRoutes: [],
  },
  macros: { mode: "static-only", unknown: "visible-fallback", maxRows: 100, maxNodes: 100, maxBytes: 100_000 },
  assets: {
    selfContained: true,
    external: "same-origin-only",
    allowedOrigins: [],
    activeContent: "block",
    maxAssetBytes: 1_000_000,
    maxTotalBytes: 10_000_000,
    maxImagePixels: 10_000_000,
    maxSvgNodes: 500,
  },
  renderers: { allowedRendererIds: [], allowIslands: false, maxIslandBytes: 1, maxChartRows: 1, maxChartSeries: 1 },
  experience: { id: "atlcli.starlight", expectedVersion: "1.0.0", requiredCapabilities: ["seo"], designTokens: {}, componentOverrides: {} },
  search: { provider: "pagefind", enabled: true, ui: "both", languages: ["en"], filters: ["space", "label", "content-type", "language"], metadata: ["title", "description", "breadcrumbs"], ranking: { title: 5, headings: 3, labels: 2, body: 1 }, shortcut: "mod+k" },
  seo: { sitemap: true, robots: "noindex", canonical: true, structuredData: ["WebSite"], socialCards: "metadata-only", feed: "disabled" },
  i18n: { defaultLocale: "en", locales: ["en"], routeMode: "hide-default", fallback: {}, uiTranslations: "starlight" },
  media: { images: "verified-original", formats: ["original"], fonts: "system", imageZoom: true, code: "expressive-code" },
  analytics: { provider: "none" },
  editLink: { provider: "none" },
  builder: {
    builder: "astro-static",
    projectDir: "/tmp/atlcli-publish-site",
    integrationOptions: { bundlePath: "/tmp/atlcli-publish-bundle", routePrefix: "/publish", experienceId: "atlcli.starlight" },
    outputProfile: "directory",
    base: "/",
    buildCommand: ["bun", "run", "build"],
  },
  retention: { bundles: 2, builds: 2, graceSeconds: 60 },
} as const;

test("publishing help documents the four-stage lifecycle and explicit safety flags", () => {
  expect(publishHelp()).toContain("plan      Acquire metadata");
  expect(publishHelp()).toContain("refresh   Acquire, validate");
  expect(publishHelp()).toContain("--confirm-public");
});

test("Astro build handoff exposes only the active bundle and private inventory paths", () => {
  const environment = publicationBuildEnvironmentV1("./bundle/publication.json", "./private/inventory.json");
  expect(Object.keys(environment).sort()).toEqual([
    "ATLCLI_PUBLICATION_BUNDLE_PATH",
    "ATLCLI_PUBLICATION_INVENTORY_PATH",
  ]);
  expect(environment.ATLCLI_PUBLICATION_BUNDLE_PATH).toBe(resolve("./bundle/publication.json"));
  expect(environment.ATLCLI_PUBLICATION_INVENTORY_PATH).toBe(resolve("./private/inventory.json"));
  expect(() => publicationBuildEnvironmentV1("", "inventory.json")).toThrow("non-empty");
});

test("publication positions replace provider non-finite ordering values deterministically", () => {
  expect(normalizePublicationPositionV1(3, 9)).toBe(3);
  expect(normalizePublicationPositionV1(null, 9)).toBe(9);
  expect(normalizePublicationPositionV1(Number.NaN, 9)).toBe(9);
  expect(normalizePublicationPositionV1(Number.POSITIVE_INFINITY, 9)).toBe(9);
});

test("publication links outside the selected scope remain visible as unresolved references", () => {
  expect(normalizePublicationLinksV1([
    { referenceId: "inside", kind: "page", sourceId: "page-1" },
    { referenceId: "outside", kind: "page", sourceId: "page-2", anchorId: "section" },
  ], new Set(["page-1"]))).toEqual([
    { referenceId: "inside", kind: "page", sourceId: "page-1" },
    { referenceId: "outside", kind: "unresolved", reason: "outside-scope", label: "Out-of-scope Confluence link" },
  ]);
});

test("chart source-table digests become ID-free page render dependencies", () => {
  const dependency = (digest: string) => collectChartRenderDependenciesV1([{
    type: "chart",
    localId: "provider-private-local-id",
    chart: {
      schema: "atlcli.chart/1",
      kind: "bar",
      data: { mode: "categories", labels: ["A"], series: [{ id: "value", label: "Value", values: [10] }] },
      source: {
        kind: "cloud-adf",
        macroName: "chart",
        sourceTableDigests: [digest],
        dependencyDigest: digest,
      },
    },
  }]);
  expect(dependency("fnv1a-11111111")).toEqual([{
    kind: "macro-data",
    key: "chart:0",
    version: "atlcli.chart/1",
    digest: "fnv1a-11111111",
    live: false,
  }]);
  expect(dependency("fnv1a-22222222")).not.toEqual(dependency("fnv1a-11111111"));
  expect(JSON.stringify(dependency("fnv1a-11111111"))).not.toContain("provider-private-local-id");
  expect(collectChartRenderDependenciesV1([])).toEqual([]);
});

test("explicit missing-attachment fallback keeps the page and removes dangling asset references", async () => {
  const page = {
    schema: "atlcli.publication-page/1" as const,
    sourceId: "page-1",
    sourceVersion: "1",
    title: "Guide",
    position: 0,
    depth: 0,
    route: "/guide/",
    blocks: [],
    notes: [],
    labels: [],
    links: [{ referenceId: "attachment", kind: "asset" as const, assetId: "asset-missing" }],
    assetIds: ["asset-missing"],
    renderDependencies: [],
    pageDigest: "pending",
  };
  const [result] = await replaceMissingPublicationAssetsV1([page], [{ assetId: "asset-missing", pageId: "page-1", filename: "missing.png" }]);
  expect(result).toMatchObject({
    assetIds: [],
    links: [{ referenceId: "attachment", kind: "unresolved", reason: "missing" }],
  });
  expect(isMissingPublicationAttachmentErrorV1(new Error("Publication attachment is missing on page page-1: missing.png"))).toBe(true);
  expect(isMissingPublicationAttachmentErrorV1(new Error("unsafe SVG"))).toBe(false);
});

test("publication verification selects the newest build and uses the digest only as a tie-breaker", () => {
  expect(latestPublicationBuildNameV1([
    { name: "older", mtimeMs: 10 },
    { name: "newer", mtimeMs: 20 },
    { name: "tie-b", mtimeMs: 20 },
    { name: "tie-a", mtimeMs: 20 },
  ])).toBe("tie-b");
});

test("publishing lifecycle is discoverable through shell completion", () => {
  expect(getCompletions(["wiki", "publish", ""])).toEqual(["plan", "refresh", "build", "verify", "run", "status", "prune"]);
  expect(getCompletions(["wiki", "publish", "verify", "--"])).toContain("--build");
});

test("public and partial projects fail closed before profile/network access", async () => {
  const root = await mkdtemp("/tmp/atlcli-publish-cli-");
  const path = join(root, "publish.json");
  try {
    await writeFile(path, JSON.stringify({ ...project, visibility: "public", completeness: "allow-partial" }));
    await expect(handlePublish(["status"], { project: path }, { json: true })).rejects.toThrow("--confirm-public");
    await expect(handlePublish(["status"], { project: path, "confirm-public": true }, { json: true })).rejects.toThrow("--allow-partial");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown lifecycle operations are rejected after project schema validation", async () => {
  const root = await mkdtemp("/tmp/atlcli-publish-cli-");
  const path = join(root, "publish.json");
  try {
    await writeFile(path, JSON.stringify(project));
    await expect(handlePublish(["nope"], { project: path }, { json: true })).rejects.toThrow('Unknown wiki publish operation "nope"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration errors identify the field without echoing private values", async () => {
  const root = await mkdtemp("/tmp/atlcli-publish-cli-");
  const path = join(root, "publish.json");
  const secret = "publish-secret-must-not-appear";
  try {
    await writeFile(path, JSON.stringify({
      ...project,
      privateValue: secret,
    }));
    let caught: unknown;
    try {
      await handlePublish(["status"], { project: path }, { json: true });
    } catch (error) {
      caught = error;
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("privateValue");
    expect(message).not.toContain(secret);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
