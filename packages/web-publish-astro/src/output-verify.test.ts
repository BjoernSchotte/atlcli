import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PublicationBuildRequestV1 } from "@atlcli/web-publish";
import { createAstroStaticPublicationManifestV1 } from "./manifest.js";
import { verifyAstroStaticPublicationOutputV1 } from "./output-verify.js";

function record(path: string, bytes: Uint8Array): { path: string; sha256: string; byteLength: number } {
  return { path, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength };
}

async function fixture(): Promise<{
  root: string;
  inventory: { schema: "atlcli.astro-build-inventory/1"; bundleDigest: string; pages: { kind: "page"; sourceId: string; route: string; pathname: string }[]; projectPages?: { kind: "project"; pathname: string }[]; output: ReturnType<typeof record>[] };
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

test("verifies the SEO digest for mixed-case and underscore artifact names", async () => {
  const fixtureValue = await fixture();
  try {
    // Code-unit order, as the integration writes it; a locale sort differs.
    for (const name of ["Zeta.xml", "_feed.xml", "alpha.xml", "robots.txt"]) {
      const bytes = Buffer.from(name);
      await writeFile(join(fixtureValue.root, name), bytes);
      fixtureValue.inventory.output.push(record(name, bytes));
    }
    const manifest = await createAstroStaticPublicationManifestV1({
      request: fixtureValue.request,
      inventory: fixtureValue.inventory,
      builderVersion: "0.1.0",
      astroVersion: "7.1.6",
      experience: { id: "test", version: "1", digest: "experience" },
    });
    await expect(verifyAstroStaticPublicationOutputV1({ manifest, inventory: fixtureValue.inventory, outputDirectory: fixtureValue.root })).resolves.toMatchObject({
      outputFiles: 6,
    });
  } finally {
    await rm(fixtureValue.root, { recursive: true, force: true });
  }
});

test("verifies the root-base URL profile without double-normalizing '/'", async () => {
  const fixtureValue = await fixture();
  const htmlPath = join(fixtureValue.root, "publish", "guide", "index.html");
  const html = Buffer.from((await readFile(htmlPath, "utf8")).replaceAll("/docs/", "/"));
  await writeFile(htmlPath, html);
  const inventory = {
    ...fixtureValue.inventory,
    output: fixtureValue.inventory.output.map((entry) => entry.path === "publish/guide/index.html" ? record(entry.path, html) : entry),
  };
  const request = {
    ...fixtureValue.request,
    project: { ...fixtureValue.request.project, builder: { base: "/", outputProfile: "directory" } },
  } as PublicationBuildRequestV1;
  try {
    const manifest = await createAstroStaticPublicationManifestV1({
      request,
      inventory,
      builderVersion: "0.1.0",
      astroVersion: "7.1.6",
      experience: { id: "test", version: "1", digest: "experience" },
    });
    await expect(verifyAstroStaticPublicationOutputV1({ manifest, inventory, outputDirectory: fixtureValue.root })).resolves.toMatchObject({
      checkedFiles: 2,
      checkedLinks: 2,
      checkedAnchors: 1,
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

async function verifyGuideHtml(payload: string): Promise<unknown> {
  const fixtureValue = await fixture();
  try {
    const bytes = Buffer.from(payload);
    await writeFile(join(fixtureValue.root, "publish", "guide", "index.html"), bytes);
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
    return await verifyAstroStaticPublicationOutputV1({ manifest, inventory, outputDirectory: fixtureValue.root });
  } finally {
    await rm(fixtureValue.root, { recursive: true, force: true });
  }
}

const IMAGE = '<img src="/docs/assets/hash/image.png">';

test.each([
  ["iframe", '<iframe src="/docs/private"></iframe>', "active-content"],
  ["upper-case embed", "<EMBED src=x>", "active-content"],
  ["private Confluence link", '<a href="https://example.atlassian.net/wiki/rest/api">private</a>', "private Confluence"],
  ["private Confluence data attribute", '<p data-source="https://api.atlassian.com/ex/confluence">x</p>', "private Confluence"],
  ["workspace link", '<a href="/bundles/secret/publication.json">bundle</a>', "internal URL escapes base"],
  ["unowned workspace link", '<a href="/docs/cache/pages/x.json">cache</a>', "unowned internal URL"],
  ["workspace path in a data attribute", `<p data-bundle="/work/bundles/${"a".repeat(64)}/pages/guide.json">x</p>`, "bundle-internal"],
  ["workspace file in a script", '<script>const source = "/work/publication.json";</script>', "bundle-internal"],
  ["workspace directory in a data attribute", '<p data-root=".atlcli/publish/site">x</p>', "bundle-internal"],
  ["local file link", '<a href="file:///work/.atlcli/publish/site/current.json">x</a>', "local file URL"],
  ["disabled analytics marker", '<meta name="atlcli:analytics-csp" content="no">', "analytics marker"],
  ["quoted event handler", '<img src="/docs/assets/hash/image.png" onerror="alert(1)">', "event-handler"],
  ["unquoted upper-case event handler", "<svg ONLOAD=alert(1)></svg>", "event-handler"],
  ["event handler after a slash", "<img/onerror=alert(1) src=/docs/assets/hash/image.png>", "event-handler"],
  ["event handler after a quoted greater-than", '<a title=">" onclick="alert(1)" href="#intro">x</a><h1 id="intro">x</h1>', "event-handler"],
  ["event handler behind an early-closed comment", "<!--><img onerror=alert(1) src=/docs/assets/hash/image.png>-->", "event-handler"],
  ["event handler in SVG script content", "<svg><script><img onerror=alert(1) src=/docs/assets/hash/image.png></script></svg>", "event-handler"],
  ["javascript link", '<a href="javascript:alert(1)">x</a>', "javascript URL"],
  ["javascript link with entities and whitespace", '<a href=" &#106;ava&Tab;script&colon;alert(1)">x</a>', "javascript URL"],
  ["javascript form action", '<form action="javascript:alert(1)"></form>', "javascript URL"],
  ["javascript SVG animation target", '<svg><a><animate attributeName="href" values="javascript:alert(1)"></animate></a></svg>', "javascript URL"],
  ["javascript meta refresh", '<meta http-equiv="refresh" content="0; url=javascript:alert(1)">', "javascript URL"],
  ["text that only looks like an anchor", '<a href="#intro">x</a><p>id="intro"</p>', "missing fragment"],
] as const)("rejects %s", async (_name, payload, expected) => {
  await expect(verifyGuideHtml(`<main>${payload}</main>`)).rejects.toThrow(expected);
});

test.each([
  ["event-handler syntax in inline code", "<p>Set <code>onclick=</code> or write onload = init in the template.</p>"],
  ["escaped markup examples", "<pre>&lt;iframe src=x&gt; &lt;img onerror=alert(1)&gt;</pre>"],
  ["javascript: in text and text attributes", '<p title="JavaScript: The Good Parts">javascript:void(0) is discouraged.</p>'],
  ["page titled after the scheme", '<meta name="description" content="JavaScript: an introduction"><title>javascript: basics</title>'],
  ["workspace words in text", "<p>The bundles/ and cache/ folders hold publication.json; see /wiki/rest/api and api.atlassian.com.</p>"],
  ["structured data for a /cache/ route", '<script type="application/ld+json">{"url":"https://docs.example.test/docs/cache/"}</script><meta property="og:url" content="https://docs.example.test/docs/staging/">'],
  ["inline script with comparison operators", "<script>for (let i = 0; i<n; i++) { const once = true; el.onclick = run; }</script>"],
  ["marker names in text", "<p>data-atlcli-analytics and data-atlcli-edit-link are attributes.</p>"],
  ["comment mentioning handlers", "<!-- <img onerror=alert(1)> -->"],
] as const)("accepts %s", async (_name, payload) => {
  await expect(verifyGuideHtml(`<main>${payload}${IMAGE}</main>`)).resolves.toMatchObject({ checkedFiles: 2 });
});

test("accepts links to owned /cache/, /bundles/ and /staging/ routes", async () => {
  const fixtureValue = await fixture();
  try {
    const guide = Buffer.from(`<main><a href="/docs/cache/">Cache</a><a href="../bundles/">Bundles</a><a href="/docs/staging/#top">Staging</a>${IMAGE}</main>`);
    await writeFile(join(fixtureValue.root, "publish", "guide", "index.html"), guide);
    const inventory = {
      ...fixtureValue.inventory,
      output: fixtureValue.inventory.output.map((entry) => entry.path === "publish/guide/index.html" ? record(entry.path, guide) : entry),
    };
    for (const route of ["cache", "bundles", "staging"]) {
      const bytes = Buffer.from(`<main><h1 id="top">${route}</h1></main>`);
      const directory = route === "bundles" ? join(fixtureValue.root, "publish", route) : join(fixtureValue.root, route);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "index.html"), bytes);
      inventory.output.push(record(route === "bundles" ? "publish/bundles/index.html" : `${route}/index.html`, bytes));
      inventory.projectPages = [...(inventory.projectPages ?? []), { kind: "project" as const, pathname: route === "bundles" ? "publish/bundles/" : `${route}/` }];
    }
    const manifest = await createAstroStaticPublicationManifestV1({
      request: fixtureValue.request,
      inventory,
      builderVersion: "0.1.0",
      astroVersion: "7.1.6",
      experience: { id: "test", version: "1", digest: "experience" },
    });
    await expect(verifyAstroStaticPublicationOutputV1({ manifest, inventory, outputDirectory: fixtureValue.root })).resolves.toMatchObject({
      checkedLinks: 4,
      checkedAnchors: 1,
    });
  } finally {
    await rm(fixtureValue.root, { recursive: true, force: true });
  }
});

const EDIT_ORIGIN = "https://confluence.example.test";
const EDIT_HREF = `${EDIT_ORIGIN}/wiki/pages/resumedraft.action?draftId=1`;
const EDIT_POLICY = { provider: "confluence", label: "Edit in Confluence", placement: "page-actions", visibility: "all", fallback: "open-page" } as const;

/** Verify the guide page's HTML for a bundle that froze `links` under an enabled edit-link policy. */
async function verifyEditLinkHtml(
  payload: string,
  links: readonly { sourceId: string; href: string }[],
  options: { analytics?: boolean; exact?: boolean } = {},
): Promise<unknown> {
  const fixtureValue = await fixture();
  try {
    const html = Buffer.from(payload);
    await writeFile(join(fixtureValue.root, "publish", "guide", "index.html"), html);
    const inventory = {
      ...fixtureValue.inventory,
      output: fixtureValue.inventory.output.map((entry) => entry.path === "publish/guide/index.html" ? record(entry.path, html) : entry),
    };
    const editLinks = { origin: EDIT_ORIGIN, label: EDIT_POLICY.label, placement: EDIT_POLICY.placement, fallback: EDIT_POLICY.fallback, links };
    const request = {
      ...fixtureValue.request,
      bundle: { ...fixtureValue.request.bundle, editLinks },
      project: {
        ...fixtureValue.request.project,
        ...(options.analytics ? { analytics: { provider: "plausible", endpoint: "https://stats.example.test/api/event", siteDomain: "docs.example.test", pageviews: true, events: [], respectDoNotTrack: true, searchTerms: false } } : {}),
        editLink: EDIT_POLICY,
      },
    } as PublicationBuildRequestV1;
    const manifest = await createAstroStaticPublicationManifestV1({
      request,
      inventory,
      builderVersion: "0.1.0",
      astroVersion: "7.1.6",
      experience: { id: "test", version: "1", digest: "experience" },
    });
    return await verifyAstroStaticPublicationOutputV1({ manifest, inventory, outputDirectory: fixtureValue.root, ...(options.exact ? { editLinks } : {}) });
  } finally {
    await rm(fixtureValue.root, { recursive: true, force: true });
  }
}

const editAnchor = (href: string): string => `<main><a href="${href}" rel="external" data-atlcli-edit-link data-pagefind-ignore>Edit in Confluence</a></main>`;
const GUIDE_LINK = [{ sourceId: "guide", href: EDIT_HREF }] as const;

test("accepts enabled analytics and the frozen provider-returned edit action", async () => {
  const html = [
    `<meta name="atlcli:analytics-csp" content="default-src 'self'; script-src 'self'; connect-src 'self' https://stats.example.test; object-src 'none'; base-uri 'none'">`,
    `<meta name="atlcli:analytics-privacy" content='{"excluded":["query","fragment","search-terms"]}'>`,
    `<script data-atlcli-analytics="plausible">location.origin+location.pathname;credentials:"omit"</script>`,
    editAnchor(EDIT_HREF),
  ].join("");
  await expect(verifyEditLinkHtml(html, GUIDE_LINK, { analytics: true, exact: true })).resolves.toMatchObject({ checkedFiles: 2 });
});

test.each([
  ["a declared page without its edit action", "<main>Guide</main>", GUIDE_LINK, "edit-link marker missing"],
  ["an edit action on a page declared without one", editAnchor(EDIT_HREF), [], "page without a declared edit link"],
  ["an edit action on another origin", editAnchor("https://evil.example.test/wiki/pages/1"), GUIDE_LINK, "outside the trusted Confluence origin"],
  ["an http edit action", editAnchor("http://confluence.example.test/wiki/pages/1"), GUIDE_LINK, "outside the trusted Confluence origin"],
  ["an edit action carrying credentials", editAnchor("https://user:secret@confluence.example.test/wiki/pages/1"), GUIDE_LINK, "outside the trusted Confluence origin"],
  ["a marker on a non-link element", `<main data-atlcli-edit-link><a href="${EDIT_HREF}">Edit</a></main>`, GUIDE_LINK, "outside the trusted Confluence origin"],
  ["an edit action to a private Confluence API route", editAnchor(`${EDIT_ORIGIN}/wiki/rest/api/content/1`), GUIDE_LINK, "outside the trusted Confluence origin"],
  ["a private Confluence URL beside a valid edit action", `${editAnchor(EDIT_HREF)}<a href="${EDIT_ORIGIN}/wiki/rest/api/content/1">raw</a>`, GUIDE_LINK, "private Confluence"],
] as const)("rejects %s", async (_name, payload, links, expected) => {
  await expect(verifyEditLinkHtml(payload, links)).rejects.toThrow(expected);
});

test("with the active bundle, an edit action must be exactly the page's frozen provider URL", async () => {
  const other = editAnchor(`${EDIT_ORIGIN}/wiki/pages/resumedraft.action?draftId=2`);
  await expect(verifyEditLinkHtml(other, GUIDE_LINK)).resolves.toMatchObject({ checkedFiles: 2 });
  await expect(verifyEditLinkHtml(other, GUIDE_LINK, { exact: true })).rejects.toThrow("differs from the bundle's provider URL");
});

test("a disabled build may not carry an edit action, and a changed policy may not build a stale bundle", async () => {
  await expect(verifyGuideHtml(editAnchor(EDIT_HREF))).rejects.toThrow("edit-link marker in disabled build");
  const fixtureValue = await fixture();
  try {
    const stale = { ...fixtureValue.request, bundle: { ...fixtureValue.request.bundle, editLinks: { origin: EDIT_ORIGIN, label: "Edit", placement: "page-actions", fallback: "omit", links: GUIDE_LINK } } } as PublicationBuildRequestV1;
    await expect(createAstroStaticPublicationManifestV1({ request: stale, inventory: fixtureValue.inventory, builderVersion: "0.1.0", astroVersion: "7.1.6", experience: { id: "test", version: "1", digest: "experience" } }))
      .rejects.toThrow("different edit-link policy");
  } finally {
    await rm(fixtureValue.root, { recursive: true, force: true });
  }
});
