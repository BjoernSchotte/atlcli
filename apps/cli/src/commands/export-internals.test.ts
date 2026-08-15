import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLED_TEMPLATE_NAME,
  createAssetByteCache,
  loadExportTemplate,
  mightContainMermaid,
  mightReferenceImage,
  prestartPageDependentDeps,
  tokenAssetFetcher,
} from "./export-internals.js";
import { BUNDLED_TEMPLATE_EPOCH, bundledDefaultTemplate } from "@atlcli/export-node";
import { buildDocx, para } from "@atlcli/docx/fixtures";

const tempDirs: string[] = [];

async function testCache() {
  const root = await mkdtemp(join(tmpdir(), "atlcli-export-cache-"));
  tempDirs.push(root);
  const cacheDir = join(root, "assets");
  return { cache: createAssetByteCache("https://example.atlassian.net/wiki", cacheDir), cacheDir };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("export asset cache", () => {
  test("writes a verified envelope and serves a later hit with private permissions", async () => {
    const { cache, cacheDir } = await testCache();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const load = mock(async () => bytes);

    expect(await cache.getOrLoad("attachment:1:v2", load)).toEqual(bytes);
    expect(await cache.getOrLoad("attachment:1:v2", load)).toEqual(bytes);

    expect(load).toHaveBeenCalledTimes(1);
    const encoded = new Uint8Array(await readFile(cache.pathFor("attachment:1:v2")));
    expect(new TextDecoder().decode(encoded.subarray(0, encoded.indexOf(0x0a)))).toMatch(
      /^atlcli-asset-v1 [0-9a-f]{64} 4$/
    );
    expect((await stat(cacheDir)).mode & 0o777).toBe(0o700);
    expect((await stat(cache.pathFor("attachment:1:v2"))).mode & 0o777).toBe(0o600);
  });

  test("treats a non-zero checksum mismatch as a miss and self-heals it", async () => {
    const { cache, cacheDir } = await testCache();
    const original = new Uint8Array([1, 2, 3, 4]);
    await cache.getOrLoad("url:/download/logo?version=1", async () => original);

    const path = cache.pathFor("url:/download/logo?version=1");
    const damaged = new Uint8Array(await readFile(path));
    damaged[damaged.length - 1] ^= 0xff;
    await writeFile(path, damaged);
    await chmod(cacheDir, 0o755);
    await chmod(path, 0o644);

    const replacement = new Uint8Array([9, 8, 7, 6]);
    const reload = mock(async () => replacement);
    expect(await cache.getOrLoad("url:/download/logo?version=1", reload)).toEqual(replacement);
    expect(await cache.getOrLoad("url:/download/logo?version=1", reload)).toEqual(replacement);

    expect(reload).toHaveBeenCalledTimes(1);
    expect((await stat(cacheDir)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("stores a versioned custom logo under only the immutable URL key", async () => {
    const cacheKeys: string[] = [];
    const cache = {
      async getOrLoad(key: string, load: () => Promise<Uint8Array>) {
        cacheKeys.push(key);
        return load();
      },
    };
    const attachment = {
      id: "77",
      filename: "logo.png",
      mediaType: "image/png",
      fileSize: 4,
      version: 3,
      pageId: "42",
      downloadUrl: "/rest/api/content/77/download",
    };
    const client = {
      listAttachments: mock(async () => [attachment]),
      downloadAttachment: mock(async () => new Uint8Array([1, 2, 3, 4])),
    };

    const assets = tokenAssetFetcher(client, cache);
    await assets.fetch({
      url: "/download/attachments/42/logo.png?version=3",
      pageId: "42",
      filename: "logo.png",
    });

    expect(cacheKeys).toEqual(["url:/download/attachments/42/logo.png?version=3"]);
    expect(client.listAttachments).toHaveBeenCalledTimes(1);
    expect(client.downloadAttachment).toHaveBeenCalledTimes(1);
  });
});

describe("export host prefetch", () => {
  test("starts scanned space and homepage deps only after the page yields its key", async () => {
    let resolvePage!: (page: { spaceKey?: string }) => void;
    const pagePromise = new Promise<{ spaceKey?: string }>((resolve) => {
      resolvePage = resolve;
    });
    const getSpaceWithIcon = mock(async () => ({ space: {}, icon: null }));
    const getSpaceHomepageStorage = mock(async () => "");

    prestartPageDependentDeps({
      pagePromise,
      templateDeps: new Set(["space", "spaceLogo", "spaceHomepage"]),
      embedImages: true,
      getSpaceWithIcon,
      getSpaceHomepageStorage,
    });
    expect(getSpaceWithIcon).not.toHaveBeenCalled();
    expect(getSpaceHomepageStorage).not.toHaveBeenCalled();

    resolvePage({ spaceKey: "DOCSY" });
    await pagePromise;
    await Promise.resolve();

    expect(getSpaceWithIcon).toHaveBeenCalledTimes(1);
    expect(getSpaceWithIcon).toHaveBeenCalledWith("DOCSY");
    expect(getSpaceHomepageStorage).toHaveBeenCalledTimes(1);
    expect(getSpaceHomepageStorage).toHaveBeenCalledWith("DOCSY");
  });

  test("does not start a logo-only dependency when image embedding is disabled", async () => {
    const getSpaceWithIcon = mock(async () => ({ space: {}, icon: null }));
    const getSpaceHomepageStorage = mock(async () => "");
    prestartPageDependentDeps({
      pagePromise: Promise.resolve({ spaceKey: "DOCSY" }),
      templateDeps: new Set(["spaceLogo"]),
      embedImages: false,
      getSpaceWithIcon,
      getSpaceHomepageStorage,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(getSpaceWithIcon).not.toHaveBeenCalled();
    expect(getSpaceHomepageStorage).not.toHaveBeenCalled();
  });
});

describe("Mermaid rasterizer gate", () => {
  test("recognizes a Confluence code macro whose language is Mermaid", () => {
    expect(
      mightContainMermaid(
        '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">Mermaid</ac:parameter></ac:structured-macro>'
      )
    ).toBe(true);
  });

  test("does not load the rasterizer for ordinary code or prose mentioning Mermaid", () => {
    expect(
      mightContainMermaid(
        '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">typescript</ac:parameter><ac:plain-text-body>mermaid</ac:plain-text-body></ac:structured-macro>'
      )
    ).toBe(false);
    expect(mightContainMermaid("<p>Mermaid diagrams are useful.</p>")).toBe(false);
  });
});

describe("Image rasterizer gate (spec 006 G4)", () => {
  test("triggers on an ac:image / attachment reference (no mermaid needed)", () => {
    expect(mightReferenceImage('<ac:image><ri:attachment ri:filename="a.svg"/></ac:image>')).toBe(true);
    expect(mightReferenceImage('<p>x</p><ri:attachment ri:filename="b.png"/>')).toBe(true);
  });

  test("does not trigger on prose without any image reference", () => {
    expect(mightReferenceImage("<p>An image is worth a thousand words.</p>")).toBe(false);
  });
});

describe("loadExportTemplate (spec 010 W3-D)", () => {
  test("no path resolves to the bundled default, with an info note naming it", async () => {
    const loaded = await loadExportTemplate(undefined);
    expect(loaded.bytes).toEqual(bundledDefaultTemplate());
    expect(loaded.meta.name).toBe(BUNDLED_TEMPLATE_NAME);
    // The bundled default's only meaningful date is its reproducible-build pin;
    // duplicating that literal here is exactly the drift the shared export avoids.
    expect(loaded.meta.modificationDate).toEqual(BUNDLED_TEMPLATE_EPOCH);
    expect(loaded.notes).toHaveLength(1);
    expect(loaded.notes[0]!.code).toBe("template-default-used");
    // `info`: the export is correct, so this must never fail a --strict build.
    expect(loaded.notes[0]!.level).toBe("info");
  });

  test("a path reads that file and reports no note", async () => {
    const root = await mkdtemp(join(tmpdir(), "atlcli-template-load-"));
    tempDirs.push(root);
    const path = join(root, "corporate.docx");
    const bytes = buildDocx({ body: para("$scroll.content"), date: new Date(0) });
    await writeFile(path, bytes);

    const loaded = await loadExportTemplate(path);
    expect(loaded.bytes).toEqual(bytes);
    expect(loaded.meta.name).toBe("corporate.docx");
    expect(loaded.meta.modificationDate).toEqual((await stat(path)).mtime);
    expect(loaded.notes).toEqual([]);
  });
});
