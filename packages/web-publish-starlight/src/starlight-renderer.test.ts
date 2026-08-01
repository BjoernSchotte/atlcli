import { expect, test } from "bun:test";
import { readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { negotiatePublicationExperienceV1 } from "@atlcli/web-publish";
import { PLAIN_PUBLISHING_EXPERIENCE_FIXTURE_V1 } from "../fixtures/plain-experience/src/experience.js";

const packageRoot = resolve(import.meta.dir, "..");
const workspaceRoot = resolve(packageRoot, "../..");
const fixture = resolve(packageRoot, "fixtures/starlight");
const plainExperienceFixture = resolve(packageRoot, "fixtures/plain-experience");
const publishedConsumerFixture = resolve(packageRoot, "fixtures/published-consumer");

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
      if (!file.startsWith(`${outputDirectory}/`)) throw new Error(`Pagefind read escaped output: ${file}`);
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
