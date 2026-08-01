import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const workspaceRoot = resolve(import.meta.dir, "../../..");
const fixtureDirectory = resolve(import.meta.dir, "../fixtures/astro-consumer");

function isWithinOutputRoot(outputDirectory: string, candidate: string): boolean {
  const relativePath = relative(resolve(outputDirectory), resolve(candidate));
  return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

async function run(
  command: string[],
  cwd: string,
  environment: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn(command, { cwd, env: { ...process.env, ...environment }, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  return { stdout, stderr };
}

async function packPackage(name: string, destination: string): Promise<string> {
  const packageDirectory = resolve(workspaceRoot, "packages", name);
  await run(["bun", "pm", "pack", "--destination", destination], packageDirectory);
  const tarballs = (await readdir(destination)).filter((entry) => entry.endsWith(".tgz"));
  expect(tarballs).toHaveLength(1);
  return join(destination, tarballs[0]!);
}

test("Astro consumer harness loads structured pages and emits a private inventory", async () => {
  await run(["bun", "run", "build", "--filter=@atlcli/web-publish-astro"], workspaceRoot);
  const result = await run(["bun", "run", "build"], fixtureDirectory);
  expect(result.stdout).toContain("loaded 1 structured publication page(s)");

  const html = await readFile(resolve(fixtureDirectory, "dist/publish/guide/index.html"), "utf8");
  expect(html).toContain('data-atlcli-source-id="guide"');
  expect(html).toContain("data-pagefind-body");
  expect(html).toContain("data-atlcli-search");
  expect(html).toContain('data-atlcli-search-mode="modal"');
  expect(html).toContain('data-atlcli-search-mode="page"');
  expect(html).toContain('data-pagefind-runtime="main-thread"');
  expect(html).toContain("Search publication");
  expect(html).toContain("Nothing matched.");
  expect(html).toContain("pagefind/pagefind.js");
  expect(html).toContain("&lt;img src=x onerror=alert");
  expect(html).not.toContain("<img src=x onerror");
  expect(html).toContain("Structured blocks: 1");
  expect(html).not.toContain("bundle.json");
  expect(await readFile(resolve(fixtureDirectory, "dist/assets/f0dad327e22e8cddc2e8057cf16d9b16ea6e36e87d31f46ee4d5943c69609c4f/fixture.txt"), "utf8"))
    .toBe("fixture asset\n");
  const inventory = JSON.parse(
    await readFile(resolve(fixtureDirectory, "../evidence/build-inventory.json"), "utf8"),
  ) as { outputRoot: string; bundleDigest: string; pages: Array<{ kind: string; sourceId: string; route: string; pathname: string }>; output: Array<{ path: string }> };
  expect(inventory.outputRoot).toBe("<private>");
  expect(inventory.bundleDigest).toBe("bundle-digest");
  expect(inventory.pages).toEqual([{ kind: "page", sourceId: "guide", route: "/guide/", pathname: "publish/guide/" }]);
  expect(inventory).toMatchObject({
    labelLandings: [{ kind: "label", label: "guide", slug: "guide", route: "/topics/guide/", pathname: "publish/topics/guide/" }],
  });
  expect(inventory.output.length).toBeGreaterThanOrEqual(2);
  expect(inventory.output).toContainEqual(expect.objectContaining({ path: "publish/guide/index.html" }));
  expect(inventory.output).toContainEqual(expect.objectContaining({ path: "publish/topics/guide/index.html" }));
  expect(inventory.output).toContainEqual(expect.objectContaining({ path: "assets/f0dad327e22e8cddc2e8057cf16d9b16ea6e36e87d31f46ee4d5943c69609c4f/fixture.txt" }));
  expect(inventory.output).toContainEqual(expect.objectContaining({ path: "pagefind/pagefind.js" }));
  const labelLanding = await readFile(resolve(fixtureDirectory, "dist/publish/topics/guide/index.html"), "utf8");
  expect(labelLanding).toContain('data-atlcli-label-slug="guide"');
  expect(labelLanding).toContain("Topic: guide");
  const runtimeText = await Promise.all(inventory.output
    .filter((entry) => /\.(?:html|js|css)$/u.test(entry.path))
    .map((entry) => readFile(resolve(fixtureDirectory, "dist", entry.path), "utf8")));
  for (const text of runtimeText) {
    expect(text).not.toContain("/_image");
    expect(text).not.toMatch(/(?:atlassian\.net|confluence|cloudId|tenant)/iu);
  }
}, 30_000);

test("Astro builds root, nested-directory, and nested-portable URL profiles", async () => {
  const cases = [
    { profile: "root-directory", output: "dist-root/publish/guide/index.html", inventory: "../evidence/build-inventory-root-directory.json" },
    { profile: "nested-directory", output: "dist/publish/guide/index.html", inventory: "../evidence/build-inventory.json" },
    { profile: "nested-portable", output: "dist-file/publish/guide.html", inventory: "../evidence/build-inventory-nested-portable.json" },
  ] as const;
  try {
    for (const fixture of cases) {
      await run(["bun", "run", "build"], fixtureDirectory, { ATLCLI_ASTRO_FIXTURE_PROFILE: fixture.profile });
      const html = await readFile(resolve(fixtureDirectory, fixture.output), "utf8");
      expect(html).toContain('data-atlcli-source-id="guide"');
      expect(html).toContain(`data-pagefind-url="${fixture.profile === "root-directory" ? "/" : "/docs/"}pagefind/pagefind.js"`);
      const inventory = JSON.parse(await readFile(resolve(fixtureDirectory, fixture.inventory), "utf8")) as {
        pages: Array<{ pathname: string }>;
      };
      expect(inventory.pages).toEqual([expect.objectContaining({
        pathname: fixture.profile === "nested-portable" ? "publish/guide" : "publish/guide/",
      })]);
    }
  } finally {
    await Promise.all(cases.filter((fixture) => fixture.profile !== "nested-directory").map(async (fixture) => {
      await rm(resolve(fixtureDirectory, fixture.output.split("/")[0]!), { recursive: true, force: true });
      await rm(resolve(fixtureDirectory, fixture.inventory), { force: true });
    }));
  }
}, 30_000);

test("directory-index and portable-file servers crawl every generated route, link, and asset", async () => {
  const cases = [
    { profile: "nested-directory", outputDirectory: "dist", base: "/docs", outputPath: "publish/guide/index.html" },
    { profile: "nested-portable", outputDirectory: "dist-file", base: "/docs", outputPath: "publish/guide.html" },
  ] as const;
  for (const fixture of cases) {
    await run(["bun", "run", "build"], fixtureDirectory, { ATLCLI_ASTRO_FIXTURE_PROFILE: fixture.profile });
    const outputRoot = resolve(fixtureDirectory, fixture.outputDirectory);
    const inventoryFile = fixture.profile === "nested-directory" ? "build-inventory.json" : "build-inventory-nested-portable.json";
    const inventory = JSON.parse(await readFile(resolve(fixtureDirectory, "../evidence", inventoryFile), "utf8")) as {
      output: Array<{ path: string }>;
    };
    const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const prefix = `${fixture.base}/`;
      if (!pathname.startsWith(prefix)) {
        response.writeHead(404).end();
        return;
      }
      const relativePath = pathname.slice(prefix.length);
      const candidates = relativePath.endsWith("/")
        ? [`${relativePath}index.html`, `${relativePath.slice(0, -1)}.html`]
        : [relativePath, `${relativePath}.html`, `${relativePath}/index.html`];
      for (const candidate of candidates) {
        try {
          const bytes = await readFile(resolve(outputRoot, candidate));
          response.writeHead(200).end(bytes);
          return;
        } catch {
          // Try the next safe output candidate.
        }
      }
      response.writeHead(404).end();
    };
    let server: ReturnType<typeof createServer> | undefined;
    let port: number | undefined;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidatePort = 45_000 + ((process.pid + attempt) % 1_000);
      const candidate = createServer(handleRequest);
      try {
        await new Promise<void>((resolvePromise, reject) => {
          candidate.once("error", reject);
          candidate.listen(candidatePort, "127.0.0.1", resolvePromise);
        });
        server = candidate;
        port = candidatePort;
        break;
      } catch (error) {
        candidate.close();
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }
    if (server === undefined || port === undefined) throw new Error("could not allocate a loopback fixture port");
    const origin = `http://127.0.0.1:${port}`;
    try {
      const urls = inventory.output.map((entry) => {
        if (entry.path.endsWith("/index.html")) return `${origin}${fixture.base}/${entry.path.slice(0, -"index.html".length)}`;
        if (entry.path.endsWith(".html") && fixture.profile === "nested-portable") return `${origin}${fixture.base}/${entry.path.slice(0, -".html".length)}/`;
        return `${origin}${fixture.base}/${entry.path}`;
      });
      for (const url of urls) expect((await fetch(url)).status).toBe(200);
      const page = await readFile(resolve(outputRoot, fixture.outputPath), "utf8");
      for (const match of page.matchAll(/\b(?:href|src)=["']([^"'#?]+)["']/giu)) {
        const target = new URL(match[1]!, `${origin}${fixture.base}/`);
        if (target.origin !== origin || !target.pathname.startsWith(`${fixture.base}/`)) continue;
        expect((await fetch(target)).status, target.href).toBe(200);
      }
    } finally {
      await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    }
  }
}, 60_000);

test("the built Pagefind client searches the static index through its main-thread fallback", async () => {
  await run(["bun", "run", "build"], fixtureDirectory);
  const outputDirectory = resolve(fixtureDirectory, "dist");
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
    const pagefind = await import(`${pathToFileURL(join(pagefindDirectory, "pagefind.js")).href}?main-thread-test=${Date.now()}`) as {
      createInstance(options: { basePath: string; noWorker: boolean }): {
        init(): Promise<void>;
        search(query: string, options?: { filters?: Record<string, string> }): Promise<{
          results: Array<{ data(): Promise<{ raw_url: string; meta: { title?: string } }> }>;
        }>;
      };
    };
    const instance = pagefind.createInstance({
      basePath: `${staticOrigin}/pagefind/`,
      noWorker: true,
    });
    await instance.init();
    const found = await instance.search("Structured blocks", { filters: { label: "guide" } });
    expect(found.results).toHaveLength(1);
    await expect(found.results[0]!.data()).resolves.toMatchObject({
      raw_url: "/publish/guide/",
      meta: { title: "Guide" },
    });
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  }
}, 30_000);

test("packed integration builds a clean Astro project with fetch disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlcli-web-publish-astro-packed-"));
  const tarballDirectory = join(root, "tarballs");
  const consumerDirectory = join(root, "consumer");
  try {
    await run(["bun", "run", "build", "--filter=@atlcli/web-publish-astro"], workspaceRoot);
    const [exportBlocks, exportBlocksAstro, webPublish, webPublishAstro] = await Promise.all([
      packPackage("export-blocks", join(tarballDirectory, "export-blocks")),
      packPackage("export-blocks-astro", join(tarballDirectory, "export-blocks-astro")),
      packPackage("web-publish", join(tarballDirectory, "web-publish")),
      packPackage("web-publish-astro", join(tarballDirectory, "web-publish-astro")),
    ]);
    await cp(fixtureDirectory, consumerDirectory, {
      recursive: true,
      filter: (source) => !source.includes("/dist") && !source.includes("/evidence"),
    });
    await writeFile(join(consumerDirectory, "package.json"), JSON.stringify({
      name: "packed-astro-publication-consumer",
      private: true,
      type: "module",
      scripts: { build: "astro build" },
      dependencies: {
        "@atlcli/web-publish-astro": `file:${webPublishAstro}`,
        astro: "7.1.6",
      },
      overrides: {
        "@atlcli/export-blocks": `file:${exportBlocks}`,
        "@atlcli/export-blocks-astro": `file:${exportBlocksAstro}`,
        "@atlcli/web-publish": `file:${webPublish}`,
      },
    }, null, 2));
    await writeFile(join(consumerDirectory, "block-network.mjs"), [
      "globalThis.fetch = async () => { throw new Error('network access is forbidden during static publication build'); };",
    ].join("\n"));
    await writeFile(join(consumerDirectory, "assert-packed.mjs"), [
      "const resolved = import.meta.resolve('@atlcli/web-publish-astro');",
      "if (!resolved.includes('/node_modules/')) throw new Error(`expected installed package, received ${resolved}`);",
    ].join("\n"));
    await run(["bun", "install", "--offline"], consumerDirectory);
    await run(["bun", "assert-packed.mjs"], consumerDirectory);
    const result = await run(
      ["bun", "run", "--preload", "./block-network.mjs", "build"],
      consumerDirectory,
    );
    expect(result.stdout).toContain("2 page(s) built");
    const html = await readFile(join(consumerDirectory, "dist/publish/guide/index.html"), "utf8");
    expect(html).toContain("Structured blocks: 1");
    expect(html).not.toContain("bundle.json");
    expect(await readFile(join(consumerDirectory, "dist/assets/f0dad327e22e8cddc2e8057cf16d9b16ea6e36e87d31f46ee4d5943c69609c4f/fixture.txt"), "utf8"))
      .toBe("fixture asset\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
