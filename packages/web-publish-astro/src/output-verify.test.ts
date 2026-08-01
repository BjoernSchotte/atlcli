import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PublicationBuildRequestV1 } from "@atlcli/web-publish";
import { createAstroStaticPublicationManifestV1 } from "./manifest.js";
import { digestPublicationJsonV1 } from "@atlcli/web-publish";
import { verifyAstroStaticPublicationOutputV1 } from "./output-verify.js";

function record(path: string, bytes: Uint8Array): { path: string; sha256: string; byteLength: number } {
  return { path, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength };
}

async function fixture(): Promise<{
  root: string;
  inventory: { schema: "atlcli.astro-build-inventory/1"; bundleDigest: string; pages: { kind: "page"; sourceId: string; route: string; pathname: string }[]; output: ReturnType<typeof record>[] };
  request: PublicationBuildRequestV1;
}> {
  const root = await mkdtemp(join(tmpdir(), "atlcli-astro-verify-"));
  const html = Buffer.from('<main><h1 id="intro">Guide</h1><a href="#intro">Self</a><a href="https://example.test/download?name=foo,bar">CSV</a><img src="/docs/assets/hash/image.png" /></main>');
  const image = Buffer.from("image");
  await mkdir(join(root, "publish", "guide"), { recursive: true });
  await mkdir(join(root, "assets", "hash"), { recursive: true });
  await writeFile(join(root, "publish", "guide", "index.html"), html);
  await writeFile(join(root, "assets", "hash", "image.png"), image);
  const inventory = {
    schema: "atlcli.astro-build-inventory/1" as const,
    bundleDigest: "bundle",
    pages: [{ kind: "page" as const, sourceId: "guide", route: "/guide/", pathname: "publish/guide/" }],
    output: [record("publish/guide/index.html", html), record("assets/hash/image.png", image)],
  };
  const request = {
    bundle: {
      schema: "atlcli.publication-bundle/1",
      bundleDigest: "bundle",
      createdBy: { name: "atlcli", version: "0.1.0" },
      sourceSnapshot: { sourceDigest: "source", complete: true, deletionAuthority: "complete-scan", rootIds: ["guide"], pages: [] },
      sourcePolicyDigest: "policy", complete: true, rootIds: ["guide"],
      pages: [{ sourceId: "guide", path: "pages/guide.json", pageDigest: "page" }],
      routes: [{ sourceId: "guide", route: "/guide/", state: "active", assignedBy: "generated", previousRoutes: [] }],
      assets: [{ assetId: "image", path: "assets/hash/image.png", sha256: inventory.output[1]!.sha256, byteLength: image.byteLength, mediaType: "image/png", disposition: "inline" }],
      issues: [],
    },
    project: { builder: { base: "/docs", outputProfile: "directory" }, analytics: { provider: "none" }, search: { languages: ["en"] }, editLink: { provider: "none" } },
    projectDigest: "project", configDigest: "config", lockfileDigest: "lock",
  } as unknown as PublicationBuildRequestV1;
  return { root, inventory, request };
}

test("verifies every inventoried output, ownership, internal URL, and anchor", async () => {
  const fixtureValue = await fixture();
  try {
    const manifest = await createAstroStaticPublicationManifestV1({
      request: fixtureValue.request,
      inventory: fixtureValue.inventory,
      builderVersion: "0.1.0",
      astroVersion: "7.1.6",
      experience: { id: "test", version: "1", digest: "experience" },
    });
    await expect(verifyAstroStaticPublicationOutputV1({ manifest, inventory: fixtureValue.inventory, outputDirectory: fixtureValue.root })).resolves.toMatchObject({
      checkedFiles: 2,
      checkedLinks: 2,
      checkedAnchors: 1,
      outputFiles: 2,
    });
  } finally {
    await rm(fixtureValue.root, { recursive: true, force: true });
  }
});

test("rejects unowned and symlinked output entries", async () => {
  const fixtureValue = await fixture();
  try {
    const manifest = await createAstroStaticPublicationManifestV1({
      request: fixtureValue.request,
      inventory: fixtureValue.inventory,
      builderVersion: "0.1.0",
      astroVersion: "7.1.6",
      experience: { id: "test", version: "1", digest: "experience" },
    });
    await writeFile(join(fixtureValue.root, "unexpected.txt"), "no");
    await expect(verifyAstroStaticPublicationOutputV1({ manifest, inventory: fixtureValue.inventory, outputDirectory: fixtureValue.root })).rejects.toThrow("file count");
    await rm(join(fixtureValue.root, "unexpected.txt"));
    await symlink(join(fixtureValue.root, "assets", "hash", "image.png"), join(fixtureValue.root, "assets", "hash", "link.png"));
    await expect(verifyAstroStaticPublicationOutputV1({ manifest, inventory: fixtureValue.inventory, outputDirectory: fixtureValue.root })).rejects.toThrow("symlink");
  } finally {
    await rm(fixtureValue.root, { recursive: true, force: true });
  }
});

test("rejects active content, private Confluence URLs, bundle references, and disabled analytics", async () => {
  const fixtureValue = await fixture();
  const htmlPath = join(fixtureValue.root, "publish", "guide", "index.html");
  const original = await readFile(htmlPath);
  try {
    for (const [payload, expected] of [
      ["<main><iframe src=\"/docs/private\"></iframe></main>", "active-content"],
      ["<main><a href=\"https://example.atlassian.net/wiki/rest/api\">private</a></main>", "private Confluence"],
      ["<main><a href=\"/bundles/secret/publication.json\">bundle</a></main>", "bundle-internal"],
      ["<main><meta name=\"atlcli:analytics-csp\" content=\"no\"></main>", "analytics marker"],
    ] as const) {
      const bytes = Buffer.from(payload);
      await writeFile(htmlPath, bytes);
      const inventory = {
        ...fixtureValue.inventory,
        output: fixtureValue.inventory.output.map((entry) => entry.path === "publish/guide/index.html" ? record(entry.path, bytes) : entry),
      };
      const manifest = await createAstroStaticPublicationManifestV1({
        request: fixtureValue.request,
        inventory,
        builderVersion: "0.1.0",
        astroVersion: "7.1.6",
        experience: { id: "test", version: "1", digest: "experience" },
      });
      await expect(verifyAstroStaticPublicationOutputV1({ manifest, inventory, outputDirectory: fixtureValue.root })).rejects.toThrow(expected);
    }
  } finally {
    await writeFile(htmlPath, original);
    await rm(fixtureValue.root, { recursive: true, force: true });
  }
});

test("accepts enabled analytics and a provider-returned edit action without indexing private source data", async () => {
  const fixtureValue = await fixture();
  const htmlPath = join(fixtureValue.root, "publish", "guide", "index.html");
  const html = Buffer.from([
    `<meta name="atlcli:analytics-csp" content="default-src 'self'; script-src 'self'; connect-src 'self' https://stats.example.test; object-src 'none'; base-uri 'none'">`,
    `<meta name="atlcli:analytics-privacy" content='{"excluded":["query","fragment","search-terms"]}'>`,
    `<script data-atlcli-analytics="plausible">location.origin+location.pathname;credentials:"omit"</script>`,
    `<main data-atlcli-edit-link><a href="https://tenant.atlassian.net/wiki/spaces/DOCSY/pages/editpage.action?pageId=1">Edit in Confluence</a></main>`,
  ].join(""));
  await writeFile(htmlPath, html);
  const inventory = {
    ...fixtureValue.inventory,
    output: fixtureValue.inventory.output.map((entry) => entry.path === "publish/guide/index.html" ? record(entry.path, html) : entry),
  };
  try {
    const request = {
      ...fixtureValue.request,
      project: {
        ...fixtureValue.request.project,
        analytics: { provider: "plausible", endpoint: "https://stats.example.test/api/event", siteDomain: "docs.example.test", pageviews: true, events: [], respectDoNotTrack: true, searchTerms: false },
        editLink: { provider: "confluence", label: "Edit in Confluence", placement: "page-actions", visibility: "all", fallback: "open-page", publicTenantDisclosureAcknowledged: true },
      },
    } as PublicationBuildRequestV1;
    const baseManifest = await createAstroStaticPublicationManifestV1({
      request,
      inventory,
      builderVersion: "0.1.0",
      astroVersion: "7.1.6",
      experience: { id: "test", version: "1", digest: "experience" },
    });
    const editLinks = { provider: "confluence" as const, includedSourceIds: ["guide"], omittedSourceIds: [] };
    const { buildDigest: _ignored, ...identity } = baseManifest;
    const manifest = { ...baseManifest, editLinks, buildDigest: await digestPublicationJsonV1({ ...identity, editLinks }) };
    await expect(verifyAstroStaticPublicationOutputV1({ manifest, inventory, outputDirectory: fixtureValue.root })).resolves.toMatchObject({ checkedFiles: 2 });
  } finally {
    await rm(fixtureValue.root, { recursive: true, force: true });
  }
});
