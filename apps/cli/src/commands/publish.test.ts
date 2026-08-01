import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { handlePublish, publishHelp } from "./publish.js";
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
