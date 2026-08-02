import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { adfToBlocks, storageToBlocks } from "@atlcli/confluence";
import { defaultRegistry, resolveMacroBlocks } from "@atlcli/export-macros";
import { negotiatePublicationExperienceV1 } from "@atlcli/web-publish";
import { digestPublicationPageV1, type PublicationPageV1 } from "@atlcli/web-publish";
import {
  assertAstroStaticPerformanceBudgetV1,
  measureAstroStaticPerformanceV1,
  readPublicationBundlePagesV1,
} from "@atlcli/web-publish-astro";
import { PLAIN_PUBLISHING_EXPERIENCE_FIXTURE_V1 } from "../fixtures/plain-experience/src/experience.js";

const packageRoot = resolve(import.meta.dir, "..");
const workspaceRoot = resolve(packageRoot, "../..");
const fixture = resolve(packageRoot, "fixtures/starlight");
const plainExperienceFixture = resolve(packageRoot, "fixtures/plain-experience");
const publishedConsumerFixture = resolve(packageRoot, "fixtures/published-consumer");

function isWithinOutputRoot(outputDirectory: string, candidate: string): boolean {
  const relativePath = relative(resolve(outputDirectory), resolve(candidate));
  return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

async function run(command: string[], cwd: string): Promise<string> {
  const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  return stdout;
}

async function packPackage(name: string, destination: string): Promise<string> {
  const packageDirectory = resolve(workspaceRoot, "packages", name);
  await run(["bun", "pm", "pack", "--destination", destination], packageDirectory);
  const tarballs = (await readdir(destination)).filter((entry) => entry.endsWith(".tgz"));
  expect(tarballs).toHaveLength(1);
  return resolve(destination, tarballs[0]!);
}

test("a Starlight consumer presents ExportBlock document bodies with static search assets", async () => {
  await run(["bun", "run", "build", "--filter=@atlcli/export-blocks-astro"], workspaceRoot);
  await run(["bun", "run", "build", "--filter=@atlcli/web-publish-starlight"], workspaceRoot);
  await rm(resolve(fixture, ".astro"), { recursive: true, force: true });
  const output = await run(["bun", "run", "build"], fixture);
  expect(output).toMatch(/\d+ page\(s\) built/u);

  const html = await readFile(resolve(fixture, "dist/index.html"), "utf8");
  expect(html).toContain('data-atlcli-starlight-slot="main-content"');
  expect(html).toContain('data-atlcli-block="callout"');
  expect(html).toContain('data-atlcli-code-renderer="starlight-expressive-code"');
  expect(html).toContain('data-atlcli-code-language="TypeScript"');
  expect(html).toContain('data-atlcli-code-language="Text"');
  expect(html).toContain("wrap");
  expect(html).toContain("data-code=\"const source = &#x27;ExportBlock[]&#x27;;\"");
  expect(html).toContain("hostile\" title {1}");
  expect(html).toContain("&#x3C;/script>&#x3C;img src=x onerror=alert(1)>");
  expect(html).toContain("This body was published from ExportBlock[], not Markdown.");
  expect(html).toContain("sidebar-pane");
  expect(html).toContain("Release notes");
  expect(html).toContain("Publishing guide");
  expect(html).toContain('data-atlcli-publication-slot="breadcrumbs"');
  expect(html).toContain('data-atlcli-publication-slot="related-pages"');
  expect(html).toContain('data-atlcli-publication-slot="previous-next"');
  expect(html).toContain('data-atlcli-related-reasons="outbound-link inbound-link shared-label same-root"');
  expect(html).toContain('rel="next" href="/guide/"');
  expect(html).toContain("pagefind");
  expect(html.match(/\bdata-pagefind-body\b/gu)).toHaveLength(1);
  expect(html).not.toContain("exportBlockKind");
  expect(await stat(resolve(fixture, "dist/pagefind/pagefind.js"))).toBeDefined();
  const guide = await readFile(resolve(fixture, "dist/guide/index.html"), "utf8");
  expect(guide).toContain("data-atlcli-deep-link-action");
  expect(guide).toContain('href="#publish"');
  expect(guide).toContain("Prepare");
  expect(guide).toContain("Publish");
  expect(guide).toContain("Release notes");
  expect(guide).toContain("data-pagefind-body");
  expect(guide).toContain('data-pagefind-meta="source-id"');
  expect(guide).toContain('data-pagefind-filter="label"');
  const topic = await readFile(resolve(fixture, "dist/topics/publishing/index.html"), "utf8");
  expect(topic).toContain('data-atlcli-publication-slot="label-landing"');
  expect(topic).toContain("Topic: publishing");
  expect(topic.match(/<h1\b/gu)).toHaveLength(1);
  expect(topic).toContain('href="/guide/"');
  expect(topic).toContain('href="/"');
  expect(await stat(resolve(fixture, "dist/404.html"))).toBeDefined();
}, 30_000);

test("a bundle-driven Starlight consumer owns source, graph landing, and trusted 404 output", async () => {
  await run(["bun", "run", "build", "--filter=@atlcli/web-publish-astro"], workspaceRoot);
  await rm(resolve(publishedConsumerFixture, ".astro"), { recursive: true, force: true });
  const output = await run(["bun", "run", "build"], publishedConsumerFixture);
  expect(output).toContain("4 page(s) built");

  const page = await readFile(resolve(publishedConsumerFixture, "dist/publish/guide/index.html"), "utf8");
  expect(page).toContain('data-atlcli-starlight-slot="main-content"');
  expect(page).toContain("Bundle publishing guide");
  expect(page).toContain("immutable bundle rendered through the supported Starlight publishing adapter");
  expect(page).toContain('href="/docs/assets/f0dad327e22e8cddc2e8057cf16d9b16ea6e36e87d31f46ee4d5943c69609c4f/fixture.txt"');
  expect(page.match(/\bdata-pagefind-body\b/gu)).toHaveLength(1);

  const label = await readFile(resolve(publishedConsumerFixture, "dist/publish/topics/guide/index.html"), "utf8");
  expect(label).toContain('data-atlcli-publication-slot="label-landing"');
  expect(label).toContain("Topic: guide");
  expect(label).toContain('href="/docs/publish/guide/"');
  expect(label.match(/\bdata-pagefind-body\b/gu)).toHaveLength(1);
  expect(await stat(resolve(publishedConsumerFixture, "dist/404.html"))).toBeDefined();
  expect(await stat(resolve(publishedConsumerFixture, "dist/pagefind/pagefind.js"))).toBeDefined();
  const sitemap = await readFile(resolve(publishedConsumerFixture, "dist/sitemap-0.xml"), "utf8");
  expect(sitemap).toContain("https://publish.example/docs/publish/guide/");
  expect(sitemap).toContain("https://publish.example/docs/publish/topics/guide/");
  expect(await readFile(resolve(publishedConsumerFixture, "dist/robots.txt"), "utf8")).toContain(
    "Sitemap: https://publish.example/docs/sitemap-index.xml",
  );
  expect(await readFile(resolve(publishedConsumerFixture, "dist/feed.xml"), "utf8")).toContain("Bundle publishing guide");
  expect(page).toContain('rel="canonical" href="https://publish.example/docs/publish/guide/"');
  expect(page).toContain('rel="alternate" hreflang="en" href="https://publish.example/docs/publish/guide/"');
  const arabic = await readFile(resolve(publishedConsumerFixture, "dist/ar/publish/guide/index.html"), "utf8");
  expect(arabic).toContain('lang="ar"');
  expect(arabic).toContain('dir="rtl"');
  expect(arabic).toContain('data-pagefind-filter="language"');
  expect(arabic).toContain('rel="canonical" href="https://publish.example/docs/ar/publish/guide/"');
  expect(arabic).toContain('rel="alternate" hreflang="en" href="https://publish.example/docs/publish/guide/"');
  expect(arabic).toContain('"item":"https://publish.example/docs/ar/publish/guide/"');
  expect(page).toContain('property="og:title" content="Bundle publishing guide"');
  expect(page).toContain('type="application/ld+json"');

  const inventory = JSON.parse(
    await readFile(resolve(publishedConsumerFixture, "../evidence/published-consumer-inventory.json"), "utf8"),
  ) as {
    pages: Array<{ kind: string; sourceId: string; route: string; locale?: string; pathname: string }>;
    labelLandings: Array<{ kind: string; slug: string }>;
    projectPages: Array<{ kind: string; pathname: string }>;
  };
  expect(inventory.pages).toEqual([
    { kind: "page", sourceId: "guide-ar", route: "/guide/", locale: "ar", pathname: "ar/publish/guide/" },
    { kind: "page", sourceId: "guide", route: "/guide/", pathname: "publish/guide/" },
  ]);
  expect(inventory.labelLandings).toEqual([expect.objectContaining({ kind: "label", slug: "guide", pathname: "publish/topics/guide/" })]);
  expect(inventory.projectPages).toEqual([{ kind: "project", pathname: "404/" }]);
}, 30_000);

test("a deliberately small plain-Astro experience uses the same contract without a second dispatcher", async () => {
  const negotiation = negotiatePublicationExperienceV1(
    {
      id: "fixture.plain-astro",
      expectedVersion: "1.0.0",
      requiredCapabilities: [],
      designTokens: {},
      componentOverrides: {},
    },
    PLAIN_PUBLISHING_EXPERIENCE_FIXTURE_V1,
    { schema: "fixture.plain-astro.tokens/1", validate: () => [] },
  );
  expect(negotiation.compatible).toBe(true);
  expect(negotiation.descriptor.components.slots).toEqual({ "main-content": "ExportDocument" });

  await rm(resolve(plainExperienceFixture, ".astro"), { recursive: true, force: true });
  const output = await run(["bun", "run", "build"], plainExperienceFixture);
  expect(output).toContain("1 page(s) built");
  const html = await readFile(resolve(plainExperienceFixture, "dist/index.html"), "utf8");
  expect(html).toContain('data-atlcli-experience="fixture.plain-astro"');
  expect(html).toContain('data-atlcli-document');
  expect(html).toContain("All fields");
  expect(html).toContain('lang="ar" dir="rtl"');
  const source = await readFile(resolve(plainExperienceFixture, "src/pages/index.astro"), "utf8");
  expect(source).toContain("ExportDocument");
  expect(source).not.toContain("exportBlockKind");
  expect(source).not.toContain("switch (");
}, 30_000);

test("the production Starlight output satisfies static asset and search-index budgets", async () => {
  await run(["bun", "run", "build"], publishedConsumerFixture);
  const inventory = JSON.parse(
    await readFile(resolve(publishedConsumerFixture, "../evidence/published-consumer-inventory.json"), "utf8"),
  ) as { pages: readonly unknown[]; output: readonly { path: string; byteLength: number }[] };
  const measurement = measureAstroStaticPerformanceV1(inventory.output, inventory.pages.length);
  assertAstroStaticPerformanceBudgetV1(measurement);
  const paths = new Set(inventory.output.map((entry) => entry.path));
  expect(paths.has("pagefind/pagefind.js")).toBe(true);
  expect(paths.has("pagefind/pagefind-worker.js")).toBe(true);
  expect([...paths].some((path) => /^pagefind\/index\/[^/]+\.pf_index$/u.test(path))).toBe(true);
  expect(measurement.fontBytes).toBeGreaterThanOrEqual(0);
  expect(measurement.transformedImageBytes).toBeGreaterThanOrEqual(0);
  expect(measurement.pageCount).toBeGreaterThanOrEqual(2);
}, 30_000);

test("a trusted Starlight override changes heading presentation without changing content, assets, security output, or index routes", async () => {
  await run(["bun", "run", "build"], fixture);
  const outputDirectory = resolve(fixture, "dist");
  const [baseline, overridden] = await Promise.all([
    readFile(resolve(outputDirectory, "override-baseline/index.html"), "utf8"),
    readFile(resolve(outputDirectory, "override/index.html"), "utf8"),
  ]);
  expect(baseline).not.toContain("data-fixture-trusted-heading");
  expect(overridden).toContain("data-fixture-trusted-heading");
  for (const html of [baseline, overridden]) {
    expect(html).toContain("override-invariant-token");
    expect(html).toContain('href="https://docs.example.test/invariant"');
    expect(html).toContain('src="/assets/diagram.svg"');
    expect(html).toContain('data-atlcli-block="unknown"');
    expect(html).toContain("&lt;script&gt;must-not-execute&lt;/script&gt;");
    expect(html).not.toContain("<script>must-not-execute</script>");
    expect(html).toContain("data-pagefind-body");
  }

  const pagefindDirectory = resolve(outputDirectory, "pagefind");
  const staticOrigin = "https://atlcli-static.test";
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL): Promise<Response> => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
      if (url.origin !== staticOrigin) throw new Error(`unexpected Pagefind network request: ${url.href}`);
      const file = resolve(outputDirectory, url.pathname.replace(/^\/+/, ""));
      if (!isWithinOutputRoot(outputDirectory, file)) throw new Error(`Pagefind read escaped output: ${file}`);
      try {
        return new Response(await readFile(file), { status: 200 });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
});

  try {
    const pagefind = await import(`${pathToFileURL(resolve(pagefindDirectory, "pagefind.js")).href}?override-invariant=${Date.now()}`) as {
      createInstance(options: { basePath: string; noWorker: boolean }): {
        init(): Promise<void>;
        search(query: string, options?: { filters?: Record<string, string> }): Promise<{
          results: Array<{ data(): Promise<{ raw_url: string }> }>;
        }>;
      };
    };
    const instance = pagefind.createInstance({ basePath: `${staticOrigin}/pagefind/`, noWorker: true });
    await instance.init();
    const result = await instance.search("override-invariant-token", { filters: { label: "invariant" } });
    const paths = (await Promise.all(result.results.map(async (entry) => (await entry.data()).raw_url))).sort();
    expect(paths).toEqual(["/override-baseline/", "/override/"]);
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  }
}, 30_000);

test("the generated Pagefind indexes cover excerpts, anchors, facets, languages, diacritics, and no-result states", async () => {
  await run(["bun", "run", "build"], publishedConsumerFixture);
  const outputDirectory = resolve(publishedConsumerFixture, "dist");
  const pagefindPath = resolve(outputDirectory, "pagefind/pagefind.js");
  const staticOrigin = "https://atlcli-pagefind.test";
  const originalFetch = globalThis.fetch;
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL): Promise<Response> => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
      if (url.origin !== staticOrigin) throw new Error(`unexpected Pagefind network request: ${url.href}`);
      const file = resolve(outputDirectory, url.pathname.replace(/^\/+/, ""));
      if (!isWithinOutputRoot(outputDirectory, file)) throw new Error(`Pagefind read escaped output: ${file}`);
      try {
        return new Response(await readFile(file), { status: 200 });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  });
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL(`${staticOrigin}/`) });

  type PagefindData = {
    raw_url: string;
    url: string;
    meta: { title?: string; "source-id"?: string };
    excerpt: string;
    plain_excerpt: string;
    filters: Record<string, string[]>;
    anchors: Array<{ id: string; text: string }>;
    sub_results: Array<{ url: string; anchor: { id: string } }>;
  };
  type PagefindInstance = {
    init(): Promise<void>;
    filters(): Promise<Record<string, Record<string, number>>>;
    search(query: string, options?: { filters?: Record<string, string> }): Promise<{
      results: Array<{ data(): Promise<PagefindData> }>;
    }>;
  };

  const load = async (language: string): Promise<PagefindInstance> => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { currentScript: null, querySelector: () => ({ getAttribute: () => language }) },
    });
    const pagefind = await import(`${pathToFileURL(pagefindPath).href}?matrix-language=${language}-${Date.now()}`) as {
      createInstance(options: { basePath: string; noWorker: boolean }): PagefindInstance;
    };
    const instance = pagefind.createInstance({ basePath: `${staticOrigin}/pagefind/`, noWorker: true });
    await instance.init();
    return instance;
  };

  try {
    const english = await load("en");
    const found = await english.search("Verify", { filters: { label: "guide" } });
    expect(found.results).toHaveLength(1);
    const englishData = await found.results[0]!.data();
    expect(englishData).toMatchObject({
      raw_url: "/publish/guide/",
      meta: { title: "Bundle publishing guide", "source-id": "guide" },
      filters: { label: ["guide"], language: ["en"] },
    });
    expect(englishData.excerpt).toContain("<mark>Verify</mark>");
    expect(englishData.plain_excerpt).toContain("Verify the release");
    expect(englishData.anchors).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "verify", text: "Verify the release" }),
    ]));
    expect(englishData.sub_results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: "https://atlcli-pagefind.test/publish/guide/#verify",
        anchor: expect.objectContaining({ id: "verify" }),
      }),
    ]));
    expect(await english.filters()).toMatchObject({ label: expect.objectContaining({ guide: expect.any(Number) }) });
    await expect(english.search("query-with-no-matching-publication", { filters: { label: "guide" } }))
      .resolves.toMatchObject({ results: [] });

    const arabic = await load("ar");
    const diacritic = await arabic.search("cafe", { filters: { label: "guide" } });
    expect(diacritic.results).toHaveLength(1);
    const arabicData = await diacritic.results[0]!.data();
    expect(arabicData).toMatchObject({
      raw_url: "/ar/publish/guide/",
      meta: { title: "Leitfaden", "source-id": "guide-ar" },
      filters: { label: ["guide"], language: ["ar"] },
    });
    expect(arabicData.plain_excerpt).toContain("café");
    expect(arabicData.anchors).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "rtl", text: "RTL proof" }),
    ]));
    expect(await arabic.search("Guide", { filters: { language: "en" } })).toMatchObject({ results: [] });
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
    else Reflect.deleteProperty(globalThis, "location");
  }
}, 30_000);

test("a packed Starlight consumer builds from the published package boundary without network access", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "atlcli-starlight-packed-"));
  const tarballs = resolve(root, "tarballs");
  const consumer = resolve(root, "consumer");
  try {
    await run(["bun", "run", "build", "--filter=@atlcli/export-blocks-astro", "--filter=@atlcli/web-publish-astro", "--filter=@atlcli/web-publish-starlight"], workspaceRoot);
    const [exportBlocks, exportBlocksAstro, webPublish, webPublishAstro, webPublishStarlight] = await Promise.all([
      packPackage("export-blocks", resolve(tarballs, "export-blocks")),
      packPackage("export-blocks-astro", resolve(tarballs, "export-blocks-astro")),
      packPackage("web-publish", resolve(tarballs, "web-publish")),
      packPackage("web-publish-astro", resolve(tarballs, "web-publish-astro")),
      packPackage("web-publish-starlight", resolve(tarballs, "web-publish-starlight")),
    ]);
    await cp(publishedConsumerFixture, consumer, { recursive: true });
    await cp(resolve(packageRoot, "fixtures", "evidence"), resolve(root, "evidence"), { recursive: true });
    await writeFile(resolve(consumer, "package.json"), JSON.stringify({
      name: "atlcli-packed-starlight-consumer",
      private: true,
      type: "module",
      scripts: { build: "astro build" },
      dependencies: {
        "@atlcli/web-publish": `file:${webPublish}`,
        "@atlcli/web-publish-astro": `file:${webPublishAstro}`,
        "@atlcli/web-publish-starlight": `file:${webPublishStarlight}`,
        "@astrojs/starlight": "0.41.5",
        astro: "7.1.6",
      },
      overrides: {
        "@atlcli/export-blocks": `file:${exportBlocks}`,
        "@atlcli/export-blocks-astro": `file:${exportBlocksAstro}`,
        "@atlcli/web-publish": `file:${webPublish}`,
        "@atlcli/web-publish-astro": `file:${webPublishAstro}`,
      },
    }, null, 2));
    await run(["bun", "install", "--offline"], consumer);
    await run(["bun", "run", "build"], consumer);
    const html = await readFile(resolve(consumer, "dist/publish/guide/index.html"), "utf8");
    expect(html).toContain("Bundle publishing guide");
    expect(html).toContain('data-atlcli-starlight-slot="main-content"');
    expect(await stat(resolve(consumer, "dist/pagefind/pagefind.js"))).toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("a production harness converts Cloud ADF and DC Storage before a packed Astro build", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "atlcli-astro-production-harness-"));
  const tarballs = resolve(root, "tarballs");
  const consumer = resolve(root, "consumer");
  try {
    const cloud = adfToBlocks(JSON.stringify({
      version: 1,
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Cloud ADF publication" }] },
        { type: "paragraph", content: [{ type: "text", text: "Cloud content was normalized before Astro." }] },
        {
          type: "extension",
          attrs: {
            extensionType: "com.atlassian.confluence.macro.core",
            extensionKey: "toc",
            localId: "cloud-toc",
          },
        },
        {
          type: "blockCard",
          attrs: {
            datasource: {
              id: "d8b75300-dfda-4519-b6cd-e49abbd50401",
              parameters: { cloudId: "cloud-1", jql: "project = ATL ORDER BY created DESC" },
              views: [{ type: "table", properties: { columns: [{ key: "key" }, { key: "summary" }] } }],
            },
            url: "https://jira.example.test/browse/ATL-1",
          },
        },
      ],
    }), { pageContext: { id: "guide", version: 7 } });
    const dc = storageToBlocks([
      '<h1>Data Center Storage publication</h1>',
      '<p>Storage content was normalized before Astro.</p>',
      '<ac:structured-macro ac:name="toc" ac:macro-id="dc-toc"/>',
      '<table><tbody><tr><th>Environment</th><td>DC</td></tr></tbody></table>',
      '<ac:structured-macro ac:name="unknown-marketplace-macro"><ac:plain-text-body><![CDATA[Visible DC fallback]]></ac:plain-text-body></ac:structured-macro>',
    ].join(""), { pageContext: { id: "guide-ar", version: 11 } });
    const registry = defaultRegistry({
      storageToBlocks: (storage, options) => storageToBlocks(storage, options),
      htmlToExportBlocks: (html) => storageToBlocks(html),
      parsePageProperties: () => [],
      extractMacroBody: () => undefined,
    });
    const [resolvedCloud, resolvedDc] = await Promise.all([
      resolveMacroBlocks(cloud, registry, { page: { id: "guide", version: 7 }, depth: 0, visited: new Set() }, { live: false, targetEngine: "web" }),
      resolveMacroBlocks(dc, registry, { page: { id: "guide-ar", version: 11 }, depth: 0, visited: new Set() }, { live: false, targetEngine: "web" }),
    ]);
    expect(resolvedCloud.blocks.some((block) => block.type === "heading" && block.content.some((node) => node.type === "text" && node.text === "Cloud ADF publication"))).toBe(true);
    expect(resolvedCloud.blocks.some((block) => block.type === "unknown" && block.macroName === "jira")).toBe(true);
    expect(resolvedDc.blocks.some((block) => block.type === "table")).toBe(true);
    expect(resolvedDc.blocks.some((block) => block.type === "unknown" && block.macroName === "unknown-marketplace-macro")).toBe(true);
    expect(JSON.stringify([...resolvedCloud.blocks, ...resolvedDc.blocks])).not.toContain("<ac:");
    expect(JSON.stringify([...resolvedCloud.blocks, ...resolvedDc.blocks])).not.toContain("type\":\"doc\"");

    await run(["bun", "run", "build", "--filter=@atlcli/export-blocks-astro", "--filter=@atlcli/web-publish-astro", "--filter=@atlcli/web-publish-starlight"], workspaceRoot);
    const [exportBlocks, exportBlocksAstro, webPublish, webPublishAstro, webPublishStarlight] = await Promise.all([
      packPackage("export-blocks", resolve(tarballs, "export-blocks")),
      packPackage("export-blocks-astro", resolve(tarballs, "export-blocks-astro")),
      packPackage("web-publish", resolve(tarballs, "web-publish")),
      packPackage("web-publish-astro", resolve(tarballs, "web-publish-astro")),
      packPackage("web-publish-starlight", resolve(tarballs, "web-publish-starlight")),
    ]);
    await cp(publishedConsumerFixture, consumer, { recursive: true });
    await cp(resolve(packageRoot, "fixtures", "evidence"), resolve(root, "evidence"), { recursive: true });

    const cloudPage = JSON.parse(await readFile(resolve(consumer, "publication/pages/guide.json"), "utf8")) as PublicationPageV1;
    const dcPage = JSON.parse(await readFile(resolve(consumer, "publication/pages/guide-ar.json"), "utf8")) as PublicationPageV1;
    const materialize = async (page: PublicationPageV1, result: { blocks: typeof cloud.blocks; notes: typeof cloud.notes }, representation: "atlas_doc_format" | "storage") => {
      const candidate = {
        ...page,
        title: representation === "storage" ? "Data Center Storage publication" : "Cloud ADF publication",
        blocks: result.blocks,
        notes: result.notes,
        renderDependencies: [],
        pageDigest: "",
      } satisfies PublicationPageV1;
      return { ...candidate, pageDigest: await digestPublicationPageV1(candidate) };
    };
    const [cloudPageOut, dcPageOut] = await Promise.all([
      materialize(cloudPage, resolvedCloud, "atlas_doc_format"),
      materialize(dcPage, resolvedDc, "storage"),
    ]);
    await writeFile(resolve(consumer, "publication/pages/guide.json"), JSON.stringify(cloudPageOut, null, 2));
    await writeFile(resolve(consumer, "publication/pages/guide-ar.json"), JSON.stringify(dcPageOut, null, 2));
    const bundlePath = resolve(consumer, "publication/bundle.json");
    const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
      pages: { sourceId: string; path: string; pageDigest: string }[];
      sourceSnapshot: { pages: { sourceId: string; representation: "atlas_doc_format" | "storage" }[] };
      complete: boolean;
    };
    bundle.pages = bundle.pages.map((entry) => ({
      ...entry,
      pageDigest: entry.sourceId === "guide" ? cloudPageOut.pageDigest : dcPageOut.pageDigest,
    }));
    bundle.sourceSnapshot.pages = bundle.sourceSnapshot.pages.map((entry) => ({
      ...entry,
      representation: entry.sourceId === "guide" ? "atlas_doc_format" : "storage",
    }));
    await writeFile(bundlePath, JSON.stringify(bundle, null, 2));
    const partialBundlePath = resolve(consumer, "publication/partial-bundle.json");
    await writeFile(partialBundlePath, JSON.stringify({ ...bundle, complete: false }, null, 2));
    await expect(readPublicationBundlePagesV1({ bundlePath: partialBundlePath })).rejects.toThrow("complete bundle");
    await rm(partialBundlePath, { force: true });

    await writeFile(resolve(consumer, "src/pages/synthetic-charts.astro"), `---
import StaticChart from "@atlcli/export-blocks-astro/components/StaticChart.astro";
import InteractiveChart from "@atlcli/export-blocks-astro/components/InteractiveChart.astro";
---
<StaticChart chart={{ title: "Synthetic publication", labels: ["ADF", "Storage"], series: [{ name: "Pages", values: [1, 1] }] }} />
<InteractiveChart enabled chart={{ title: "Synthetic island", labels: ["ADF", "Storage"], series: [{ name: "Pages", values: [1, 1] }] }} />
`);
    await writeFile(resolve(consumer, "package.json"), JSON.stringify({
      name: "atlcli-production-harness-consumer",
      private: true,
      type: "module",
      scripts: { build: "astro build" },
      dependencies: {
        "@atlcli/web-publish": `file:${webPublish}`,
        "@atlcli/web-publish-astro": `file:${webPublishAstro}`,
        "@atlcli/web-publish-starlight": `file:${webPublishStarlight}`,
        "@astrojs/starlight": "0.41.5",
        astro: "7.1.6",
      },
      overrides: {
        "@atlcli/export-blocks": `file:${exportBlocks}`,
        "@atlcli/export-blocks-astro": `file:${exportBlocksAstro}`,
        "@atlcli/web-publish": `file:${webPublish}`,
        "@atlcli/web-publish-astro": `file:${webPublishAstro}`,
      },
    }, null, 2));
    await run(["bun", "install", "--offline"], consumer);
    await run(["bun", "run", "build"], consumer);
    const cloudHtml = await readFile(resolve(consumer, "dist/docs/publish/guide/index.html"), "utf8").catch(async () => readFile(resolve(consumer, "dist/publish/guide/index.html"), "utf8"));
    const dcHtml = await readFile(resolve(consumer, "dist/ar/publish/guide/index.html"), "utf8");
    const chartHtml = await readFile(resolve(consumer, "dist/synthetic-charts/index.html"), "utf8");
    expect(cloudHtml).toContain("Cloud ADF publication");
    expect(cloudHtml).toContain('data-macro-name="jira"');
    expect(dcHtml).toContain("Data Center Storage publication");
    expect(dcHtml).toContain("Visible DC fallback");
    expect(chartHtml).toContain('data-atlcli-block="chart"');
    expect(chartHtml).toContain('data-atlcli-chart-island="enabled"');
    expect(await stat(resolve(consumer, "dist/pagefind/pagefind.js"))).toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
