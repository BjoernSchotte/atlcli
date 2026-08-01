import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { STARLIGHT_PUBLISHING_EXPERIENCE_V1 } from "@atlcli/web-publish-starlight";
import {
  atlcliPublishingIntegration,
  PAGEFIND_OWNED_OUTPUT_PATH_PREFIX_V1,
  PUBLICATION_SEARCH_SEMANTIC_SLOTS_V1,
  publicationRoutePathV1,
  publicationStaticPathsV1,
} from "./integration.js";
import { readPublicationBundlePagesV1 } from "./loader.js";

test("declares Astro as a peer, never a bundled runtime dependency", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  expect(manifest.peerDependencies?.astro).toBe(">=7.1.6 <8");
  expect(manifest.dependencies?.astro).toBeUndefined();
});

test("exports Pagefind ownership and search semantics without theme DOM selectors", () => {
  expect(PAGEFIND_OWNED_OUTPUT_PATH_PREFIX_V1).toBe("pagefind");
  expect(PUBLICATION_SEARCH_SEMANTIC_SLOTS_V1).toEqual(["search-trigger", "search-modal", "main-content"]);
  expect(JSON.stringify(PUBLICATION_SEARCH_SEMANTIC_SLOTS_V1)).not.toContain("sl-");
});

test("keeps programmatic Astro runners and experimental collection storage out of the public contract", async () => {
  const [entrypoint, integration, loader, apiReport] = await Promise.all([
    readFile(new URL("./index.ts", import.meta.url), "utf8"),
    readFile(new URL("./integration.ts", import.meta.url), "utf8"),
    readFile(new URL("./loader.ts", import.meta.url), "utf8"),
    readFile(new URL("../etc/web-publish-astro.api.md", import.meta.url), "utf8"),
  ]);
  for (const source of [entrypoint, integration, loader, apiReport]) {
    expect(source).not.toContain("astro:content");
    expect(source).not.toContain("astro.build(");
    expect(source).not.toContain("experimental collection storage");
    expect(source).not.toContain("unstable_");
  }
  expect(apiReport).not.toContain("astro.build");
  expect(apiReport).not.toContain("ContentLayer");
});

test("stops on private build APIs or Confluence/network access in the loader boundary", async () => {
  const [manifest, integration, loader] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("./integration.ts", import.meta.url), "utf8"),
    readFile(new URL("./loader.ts", import.meta.url), "utf8"),
  ]);
  expect(manifest).not.toContain("@atlcli/confluence");
  for (const source of [integration, loader]) {
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("@astrojs/");
    expect(source).not.toContain("vite/dist");
    expect(source).not.toContain("node_modules/.bun");
  }
});

test("documents a verified-manifest-only future augmenter boundary without PWA paths", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  expect(readme).toContain("completed manifest");
  expect(readme).toContain("route/output registry");
  expect(readme).toContain("no service");
  expect(readme).toContain("PWA output path");
});

const page = {
  schema: "atlcli.publication-page/1",
  sourceId: "guide",
  sourceVersion: "1",
  title: "Guide",
  position: 0,
  depth: 0,
  route: "/guide/",
  blocks: [{ type: "paragraph", content: [{ type: "text", text: "Guide" }] }],
  notes: [],
  labels: [],
  links: [],
  assetIds: [],
  renderDependencies: [],
  pageDigest: "page-digest",
};

const installedExperience = {
  selection: {
    id: "fixture.experience", expectedVersion: "1", requiredCapabilities: ["search-modal"],
    designTokens: { accent: "#0052cc" }, componentOverrides: { search: "Search" },
  },
  descriptor: {
    schema: "atlcli.publication-experience/1", id: "fixture.experience", version: "1", engine: "astro",
    capabilities: ["search-modal"], slots: ["search-trigger", "search-modal"],
    designTokensSchema: "fixture.tokens/1",
    components: { slots: { "search-trigger": "Search", "search-modal": "Search" }, overrides: { search: "Search" }, blockOverrides: {} },
  },
  tokenValidator: { schema: "fixture.tokens/1", validate: () => [] },
} as const;

function bundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    assets: [],
    issues: [],
    ...overrides,
  };
}

function expectedConfig(root: string): {
  base: string;
  outputProfile: "directory";
  outDir: string;
  publicDir: string;
} {
  return {
    base: "/docs/",
    outputProfile: "directory",
    outDir: join(root, "dist"),
    publicDir: join(root, "public"),
  };
}

function resolvedConfig(root: string, overrides: Record<string, unknown> = {}): {
  output: string;
  base: string;
  site?: URL;
  outDir: URL;
  publicDir: URL;
  build: { format: string };
  trailingSlash: string;
} {
  return {
    output: "static",
    base: "/docs/",
    outDir: pathToFileURL(join(root, "dist")),
    publicDir: pathToFileURL(join(root, "public")),
    build: { format: "directory" },
    trailingSlash: "always",
    ...overrides,
  };
}

async function fixture(bundleValue = bundle()): Promise<{ root: string; bundlePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "atlcli-web-publish-astro-"));
  await mkdir(join(root, "pages"));
  await writeFile(join(root, "pages", "guide.json"), JSON.stringify(page));
  const bundlePath = join(root, "bundle.json");
  await writeFile(bundlePath, JSON.stringify(bundleValue));
  return { root, bundlePath };
}

test("reads only complete, referenced structured page documents", async () => {
  const { root, bundlePath } = await fixture();
  try {
    await expect(readPublicationBundlePagesV1({ bundlePath })).resolves.toMatchObject({
      bundle: { bundleDigest: "bundle-digest" },
      pages: [{ sourceId: "guide", blocks: page.blocks }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects partial bundles and paths outside the immutable bundle directory", async () => {
  const partial = await fixture(bundle({ complete: false }));
  try {
    await expect(readPublicationBundlePagesV1({ bundlePath: partial.bundlePath })).rejects.toThrow("complete bundle");
  } finally {
    await rm(partial.root, { recursive: true, force: true });
  }

  const escaped = await fixture(bundle({
    pages: [{ sourceId: "guide", path: "../outside.json", pageDigest: "page-digest" }],
  }));
  try {
    await expect(readPublicationBundlePagesV1({ bundlePath: escaped.bundlePath })).rejects.toThrow("escapes bundle directory");
  } finally {
    await rm(escaped.root, { recursive: true, force: true });
  }
});

test("uses only static Astro hooks, detects collisions, and writes private inventory", async () => {
  const { root, bundlePath } = await fixture();
  const output = join(root, "dist");
  const manifest = join(root, "private", "inventory.json");
  await mkdir(output);
  await writeFile(join(output, "index.html"), "<main>Guide</main>");
  const integration = atlcliPublishingIntegration({
    bundlePath,
    manifestPath: manifest,
    routePrefix: "/publish",
    expectedConfig: expectedConfig(root),
    experience: installedExperience,
  });
  try {
    expect(publicationRoutePathV1("/", "/publish")).toBe("/publish");
    expect(publicationRoutePathV1("/guide/", "/publish")).toBe("/publish/guide");
    await expect(publicationStaticPathsV1({ bundlePath })).resolves.toEqual([{
      params: { slug: "guide" },
      props: { sourceId: "guide" },
    }]);
    expect(() => integration.hooks["astro:config:done"]({
      config: resolvedConfig(root, { output: "server" }),
    })).toThrow("static output");
    await expect(integration.hooks["astro:routes:resolved"]({
      routes: [{ pathname: "/publish/guide" }],
    })).rejects.toThrow("route collision");
    await integration.hooks["astro:routes:resolved"]({ routes: [{ pathname: "/handwritten" }] });
    await integration.hooks["astro:build:done"]({
      dir: pathToFileURL(`${output}/`),
      pages: [{ pathname: "/publish/guide" }],
    });
    const value = JSON.parse(await readFile(manifest, "utf8")) as {
      outputRoot: string;
      pages: Array<{ sourceId: string; route: string; pathname: string }>;
      output: Array<{ path: string; byteLength: number; sha256: string }>;
      experience?: { id: string; version: string; digest: string };
    };
    expect(value.outputRoot).toBe("<private>");
    expect(value.experience).toEqual({ id: "fixture.experience", version: "1", digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(value.pages).toEqual([{ sourceId: "guide", route: "/guide/", pathname: "/publish/guide" }]);
    expect(value.output).toEqual([{ path: "index.html", byteLength: 18, sha256: expect.any(String) }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("materializes verified bundle assets but never overwrites an Astro output collision", async () => {
  const digest = "f0dad327e22e8cddc2e8057cf16d9b16ea6e36e87d31f46ee4d5943c69609c4f";
  const relativeAssetPath = `assets/${digest}/fixture.txt`;
  const { root, bundlePath } = await fixture(bundle({
    assets: [{
      assetId: "fixture-asset", path: relativeAssetPath, sha256: digest, byteLength: 14,
      mediaType: "text/plain", disposition: "inline", downloadName: "fixture.txt",
    }],
  }));
  const output = join(root, "dist");
  const destination = join(output, relativeAssetPath);
  try {
    await mkdir(join(root, "assets", digest), { recursive: true });
    await writeFile(join(root, relativeAssetPath), "fixture asset\n");
    await mkdir(join(output, "assets", digest), { recursive: true });
    await writeFile(destination, "handwritten output\n");
    const integration = atlcliPublishingIntegration({
      bundlePath, manifestPath: join(root, "private", "inventory.json"), routePrefix: "/publish",
      expectedConfig: expectedConfig(root),
    });
    await expect(integration.hooks["astro:build:done"]!({
      dir: pathToFileURL(`${output}/`), pages: [{ pathname: "/publish/guide" }],
    })).rejects.toThrow("collides with existing Astro output");
    expect(await readFile(destination, "utf8")).toBe("handwritten output\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts only a caller-imported compatible experience descriptor", async () => {
  const { root, bundlePath } = await fixture();
  try {
    expect(() => atlcliPublishingIntegration({
      bundlePath, manifestPath: join(root, "private", "inventory.json"), routePrefix: "/publish",
      expectedConfig: expectedConfig(root), experience: installedExperience,
    })).not.toThrow();
    expect(() => atlcliPublishingIntegration({
      bundlePath, manifestPath: join(root, "private", "inventory.json"), routePrefix: "/publish",
      expectedConfig: expectedConfig(root),
      experience: { ...installedExperience, selection: { ...installedExperience.selection, id: "other" } },
    })).toThrow("does not match installed experience");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts the installed Starlight descriptor without dynamic package resolution", async () => {
  const { root, bundlePath } = await fixture();
  try {
    const selected = atlcliPublishingIntegration({
      bundlePath, manifestPath: join(root, "private", "inventory.json"), routePrefix: "/publish",
      expectedConfig: expectedConfig(root),
      experience: {
        selection: {
          id: STARLIGHT_PUBLISHING_EXPERIENCE_V1.id,
          expectedVersion: STARLIGHT_PUBLISHING_EXPERIENCE_V1.version,
          requiredCapabilities: ["search-modal", "table-of-contents", "print-styles"],
          designTokens: { accent: "#0052cc" }, componentOverrides: { search: "Search" },
        },
        descriptor: STARLIGHT_PUBLISHING_EXPERIENCE_V1,
        tokenValidator: { schema: "atlcli.starlight.tokens/1", validate: () => [] },
      },
    });
    expect(selected.name).toBe("atlcli-publishing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates the operator-owned Astro URL and output profile without rewriting it", async () => {
  const { root, bundlePath } = await fixture();
  const options = {
    bundlePath,
    manifestPath: join(root, "private", "inventory.json"),
    routePrefix: "/publish",
    expectedConfig: {
      ...expectedConfig(root),
      site: "https://publish.example/docs/",
    },
  };
  const integration = atlcliPublishingIntegration(options);
  const valid = resolvedConfig(root, { site: new URL("https://publish.example/docs/") });
  try {
    expect(() => integration.hooks["astro:config:done"]({ config: valid })).not.toThrow();
    expect(() => integration.hooks["astro:config:done"]({
      config: resolvedConfig(root, { base: "/elsewhere", site: valid.site }),
    })).toThrow("base mismatch");
    expect(() => integration.hooks["astro:config:done"]({
      config: resolvedConfig(root, { build: { format: "file" }, site: valid.site }),
    })).toThrow("directory profile");
    expect(() => integration.hooks["astro:config:done"]({
      config: resolvedConfig(root, { trailingSlash: "never", site: valid.site }),
    })).toThrow("directory profile");
    expect(() => integration.hooks["astro:config:done"]({
      config: resolvedConfig(root, { site: new URL("https://other.example/docs/") }),
    })).toThrow("site mismatch");
    expect(() => integration.hooks["astro:config:done"]({
      config: resolvedConfig(root, { outDir: pathToFileURL(join(root, "other-dist")), site: valid.site }),
    })).toThrow("outDir mismatch");
    expect(() => integration.hooks["astro:config:done"]({
      config: resolvedConfig(root, { publicDir: pathToFileURL(join(root, "other-public")), site: valid.site }),
    })).toThrow("publicDir mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("injects a static catch-all only for an operator-owned layout entrypoint", () => {
  const withoutLayout = atlcliPublishingIntegration({
    bundlePath: "/bundle.json",
    manifestPath: "/private/inventory.json",
    routePrefix: "/publish",
    expectedConfig: {
      base: "/docs",
      outputProfile: "directory",
      outDir: "/dist",
      publicDir: "/public",
    },
  });
  const updates: unknown[] = [];
  withoutLayout.hooks["astro:config:setup"]?.({
    injectRoute: () => { throw new Error("must not inject without a layout"); },
    updateConfig: (config) => updates.push(config),
  });
  expect(updates).toHaveLength(1);
  expect(Object.keys(updates[0] as object)).toEqual(["vite"]);
  const plugin = (updates[0] as {
    vite: { plugins: Array<{
      name: string;
      resolveId(id: string): string | undefined;
      load(id: string): string | undefined;
    }> };
  }).vite.plugins[0]!;
  expect(plugin.name).toBe("atlcli-publication-bundle-path");
  expect(plugin.resolveId("virtual:atlcli-publication")).toBe("\0virtual:atlcli-publication");
  expect(plugin.resolveId("unrelated-module")).toBeUndefined();
  expect(plugin.load("\0virtual:atlcli-publication")).toBe(
    'export const bundlePath = "/bundle.json";',
  );
  expect(plugin.load("unrelated-module")).toBeUndefined();

  const withLayout = atlcliPublishingIntegration({
    bundlePath: "/bundle.json",
    manifestPath: "/private/inventory.json",
    routePrefix: "/publish",
    expectedConfig: {
      base: "/docs",
      outputProfile: "directory",
      outDir: "/dist",
      publicDir: "/public",
    },
    trustedLayoutEntrypoint: "/operator/src/pages/publish/[...slug].astro",
  });
  const injected: unknown[] = [];
  withLayout.hooks["astro:config:setup"]?.({
    injectRoute: (route) => injected.push(route),
    updateConfig: () => {},
  });
  expect(injected).toEqual([{
    pattern: "/publish/[...slug]",
    entrypoint: "/operator/src/pages/publish/[...slug].astro",
    prerender: true,
  }]);
});
