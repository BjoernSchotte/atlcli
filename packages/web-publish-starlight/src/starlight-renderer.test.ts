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
  expect(html).toContain("data-atlcli-related-pages");
  expect(html).toContain("pagefind");
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
  expect(await stat(resolve(fixture, "dist/404.html"))).toBeDefined();
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
