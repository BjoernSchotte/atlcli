import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  digestPublicationJsonV1,
  trustedConfluenceEditUrlV1,
  validatePublicationOutputPathV1,
  type PublicationBundleEditLinksV1,
  type PublicationOutputProfileV1,
  type StaticPublicationManifestV1,
} from "@atlcli/web-publish";
import { scanHtmlV1 } from "./html-scan.js";
import type { AstroBuildInventoryV1 } from "./manifest.js";

export interface VerifyAstroStaticPublicationOutputOptionsV1 {
  manifest: StaticPublicationManifestV1;
  inventory: AstroBuildInventoryV1;
  outputDirectory: string;
  /** The active bundle's frozen edit links; when given, each page's edit action must be exactly its frozen URL. */
  editLinks?: PublicationBundleEditLinksV1;
}

export interface VerifiedAstroStaticPublicationOutputV1 {
  checkedFiles: number;
  checkedLinks: number;
  checkedAnchors: number;
  outputFiles: number;
}

interface OutputRecordV1 {
  path: string;
  sha256: string;
  byteLength: number;
}

function fail(message: string): never {
  throw new TypeError(`Astro publication output verification failed: ${message}`);
}

function assertOutputRecord(value: OutputRecordV1): void {
  if (
    validatePublicationOutputPathV1(value.path) !== value.path ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 0
  ) {
    fail(`invalid inventory integrity record for '${value.path}'`);
  }
}

function inventoryRecords(inventory: AstroBuildInventoryV1): Map<string, OutputRecordV1> {
  if (inventory.schema !== "atlcli.astro-build-inventory/1" || typeof inventory.bundleDigest !== "string") {
    fail("invalid private Astro build inventory");
  }
  const records = new Map<string, OutputRecordV1>();
  for (const value of inventory.output) {
    const record = value as OutputRecordV1;
    assertOutputRecord(record);
    if (records.has(record.path)) fail(`duplicate inventory output '${record.path}'`);
    records.set(record.path, record);
  }
  return records;
}

async function walkOutput(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      const path = relative(root, absolute).replaceAll("\\", "/");
      if (entry.isSymbolicLink()) fail(`symlink output entry '${path}'`);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        files.set(path, absolute);
      } else {
        fail(`non-regular output entry '${path}'`);
      }
    }
  }
  const state = await lstat(root);
  if (state.isSymbolicLink() || !state.isDirectory()) fail("output root is not a real directory");
  await walk(root);
  return files;
}

async function assertFileDigest(path: string, expected: OutputRecordV1): Promise<void> {
  const state = await lstat(path);
  if (state.isSymbolicLink() || !state.isFile()) fail(`'${expected.path}' is not a regular file`);
  const bytes = await readFile(path);
  if (bytes.byteLength !== expected.byteLength) fail(`byte length mismatch for '${expected.path}'`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expected.sha256) fail(`digest mismatch for '${expected.path}'`);
}

function basePrefix(base: string): string {
  if (base === "/") return "";
  if (!base.startsWith("/") || base.endsWith("/") || base.includes("//") || base.includes("\\") || base.includes("?") || base.includes("#")) {
    fail(`unsafe manifest base '${base}'`);
  }
  return base;
}

function outputUrl(path: string, profile: PublicationOutputProfileV1, base: string): string {
  const isRoot = path === "index.html";
  const stem = isRoot ? "" : path.replace(/\/index\.html$/u, "").replace(/\.html$/u, "");
  const suffix = profile === "directory" && (isRoot || path.endsWith("/index.html"))
    ? (stem === "" ? "/" : `/${stem}/`)
    : `/${stem}`;
  return `${base === "/" ? "" : base}${suffix}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function outputCandidates(pathname: string, profile: PublicationOutputProfileV1): readonly string[] {
  const relativePath = pathname.replace(/^\/+/, "");
  if (relativePath === "") return ["index.html"];
  if (relativePath.endsWith("/")) {
    const stem = relativePath.slice(0, -1);
    return profile === "directory" ? [`${stem}/index.html`, `${stem}.html`] : [`${stem}.html`, `${stem}/index.html`];
  }
  return [relativePath, `${relativePath}/index.html`, `${relativePath}.html`];
}

/** Attributes whose URL a browser loads or navigates to; each is resolved against the owned output. */
const REFERENCE_ATTRIBUTES: Readonly<Record<string, "href" | "src" | "action" | "srcset">> = {
  href: "href", "xlink:href": "href", src: "src", poster: "src", action: "action", formaction: "action", srcset: "srcset",
};
/** Further attributes that can carry a script URL (legacy URL attributes and SVG animation targets). */
const SCRIPT_URL_ATTRIBUTES = new Set([
  ...Object.keys(REFERENCE_ATTRIBUTES), "data", "ping", "background", "cite", "longdesc", "manifest", "codebase", "values", "to", "from", "by",
]);
const ACTIVE_CONTENT_ELEMENTS = new Set(["iframe", "object", "embed"]);
/** The digest- and id-keyed private workspace layout; a plain `/cache/` or `/bundles/` route is ordinary content. */
const WORKSPACE_REFERENCE = /\.atlcli\/|(?:bundles|builds)\/[a-f0-9]{64}|staging\/[a-f0-9]{8}-[a-f0-9]{4}-|(?:^|[\/"'\s=])(?:publication|current|build-inventory)\.json/iu;

interface HtmlMarkupV1 {
  references: readonly { kind: "href" | "src" | "action" | "srcset"; value: string }[];
  /** Every tag with its attributes plus script bodies; page text is excluded. */
  markup: string;
  /** `markup` without the reference attributes, whose targets are verified by ownership instead. */
  nonReferenceMarkup: string;
}

/**
 * Reject active markup and split the rest into what later checks need. Only
 * real elements and attributes count: page text or inline code that merely
 * mentions `onclick=` or `javascript:` is content, not markup.
 */
function inspectHtmlMarkup(htmlPath: string, html: string): HtmlMarkupV1 {
  const scanned = scanHtmlV1(html);
  const references: { kind: "href" | "src" | "action" | "srcset"; value: string }[] = [];
  const markup: string[] = [];
  const nonReferenceMarkup: string[] = [];
  for (const tag of scanned.tags) {
    if (ACTIVE_CONTENT_ELEMENTS.has(tag.name)) fail(`active-content element in '${htmlPath}'`);
    markup.push(`<${tag.name}`);
    nonReferenceMarkup.push(`<${tag.name}`);
    for (const [name, value] of tag.attributes) {
      if (/^on[a-z]+$/u.test(name)) fail(`event-handler attribute in '${htmlPath}'`);
      const serialized = ` ${name}="${value}"`;
      markup.push(serialized);
      const kind = REFERENCE_ATTRIBUTES[name];
      if (kind === undefined) nonReferenceMarkup.push(serialized);
      else references.push({ kind, value });
      if (
        (SCRIPT_URL_ATTRIBUTES.has(name) || (name === "content" && tag.attributes.has("http-equiv"))) &&
        // A browser ignores whitespace and control characters inside a scheme.
        /(?:^|[;,=])javascript:/iu.test(value.replace(/[\u0000-\u0020]/gu, ""))
      ) {
        fail(`javascript URL in '${htmlPath}'`);
      }
    }
  }
  for (const script of scanned.scripts) {
    markup.push(script);
    nonReferenceMarkup.push(script);
  }
  return { references, markup: markup.join("\n"), nonReferenceMarkup: nonReferenceMarkup.join("\n") };
}

async function assertHtmlReferences(
  outputRoot: string,
  htmlPath: string,
  attributes: HtmlMarkupV1["references"],
  files: ReadonlyMap<string, string>,
  profile: PublicationOutputProfileV1,
  base: string,
  anchorIds: Map<string, ReadonlySet<string>>,
): Promise<{ links: number; anchors: number }> {
  const sourceUrl = outputUrl(htmlPath, profile, base);
  const source = new URL(sourceUrl, "https://atlcli.invalid");
  const references = attributes.flatMap(({ kind, value }) => {
    const values = kind === "srcset" ? value.split(",") : [value];
    return values.map((entry) => ({ kind, value: entry.trim().split(/\s+/u)[0]! }));
  });
  let links = 0;
  let anchors = 0;
  for (const reference of references) {
    const { kind, value } = reference;
    if (value === "" || value === "#") continue;
    if (/^data:/iu.test(value)) fail(`data URL in '${htmlPath}'`);
    if (/^(?:mailto|tel):/iu.test(value)) continue;
    let target: URL;
    try {
      target = new URL(value, source);
    } catch {
      fail(`invalid URL '${value}' in '${htmlPath}'`);
    }
    if (target.protocol === "javascript:") fail(`javascript URL in '${htmlPath}'`);
    if (target.protocol === "file:") fail(`local file URL '${value}' in '${htmlPath}'`);
    if (target.origin !== "https://atlcli.invalid") {
      if (kind === "src" || kind === "srcset" || kind === "action") fail(`external resource/action '${value}' in '${htmlPath}'`);
      continue;
    }
    // The caller validates and normalizes the manifest base once. Re-validating
    // the normalized root base would turn `"/"` into `""` and reject the
    // legitimate root URL profile.
    const prefix = base;
    if (prefix !== "" && target.pathname !== prefix && !target.pathname.startsWith(`${prefix}/`)) {
      fail(`internal URL escapes base '${value}' in '${htmlPath}'`);
    }
    const pathname = prefix === "" ? target.pathname : target.pathname.slice(prefix.length);
    const candidates = outputCandidates(pathname, profile);
    const targetPath = candidates.find((candidate) => files.has(candidate));
    if (targetPath === undefined) fail(`unowned internal URL '${value}' in '${htmlPath}'`);
    links += 1;
    if (target.hash.length > 1) {
      const fragment = decodeURIComponent(target.hash.slice(1));
      if (fragment.length > 200 || /[\u0000-\u001f\u007f]/u.test(fragment)) fail(`unsafe fragment in '${value}'`);
      let ids = anchorIds.get(targetPath);
      if (ids === undefined) {
        ids = new Set(scanHtmlV1(await readFile(resolve(outputRoot, targetPath), "utf8")).tags.flatMap((tag) =>
          [tag.attributes.get("id"), tag.attributes.get("name")].filter((id): id is string => id !== undefined)));
        anchorIds.set(targetPath, ids);
      }
      if (!ids.has(fragment)) fail(`missing fragment '#${fragment}' in '${value}'`);
      anchors += 1;
    }
  }
  return { links, anchors };
}

function assertManifestReferences(
  manifest: StaticPublicationManifestV1,
  records: ReadonlyMap<string, OutputRecordV1>,
): void {
  const referenced = [
    ...manifest.pages.map((entry) => ({ path: entry.outputPath, sha256: entry.sha256, byteLength: entry.byteLength })),
    ...manifest.assets.map((entry) => ({ path: entry.outputPath, sha256: entry.sha256, byteLength: entry.byteLength })),
    ...manifest.search.files,
  ];
  for (const entry of referenced) {
    const record = records.get(entry.path);
    if (record === undefined || record.sha256 !== entry.sha256 || record.byteLength !== entry.byteLength) {
      fail(`manifest/inventory mismatch for '${entry.path}'`);
    }
  }
  const searchRecords = [...records.values()].filter((entry) => entry.path.startsWith("pagefind/")).sort((left, right) => left.path.localeCompare(right.path));
  if (manifest.search.files.length !== searchRecords.length || manifest.search.digest === "") fail("invalid Pagefind inventory declaration");
  if (manifest.seo.digest === "") fail("invalid SEO inventory declaration");
  if (manifest.verification.checkedPages !== manifest.pages.length || manifest.verification.checkedAssets !== manifest.assets.length) {
    fail("manifest verification counts do not match the owned publication records");
  }
  const pageIds = new Set(manifest.pages.map((entry) => entry.sourceId));
  const editIncluded = new Set(manifest.editLinks.includedSourceIds);
  const editOmitted = new Set(manifest.editLinks.omittedSourceIds);
  if (editIncluded.size !== manifest.editLinks.includedSourceIds.length || editOmitted.size !== manifest.editLinks.omittedSourceIds.length) {
    fail("manifest edit-link source declarations contain duplicates");
  }
  for (const sourceId of [...editIncluded, ...editOmitted]) {
    if (!pageIds.has(sourceId)) fail(`manifest edit-link declaration references unknown page '${sourceId}'`);
  }
  if ([...editIncluded].some((sourceId) => editOmitted.has(sourceId)) || editIncluded.size + editOmitted.size !== pageIds.size) {
    fail("manifest edit-link source declarations are not a complete partition");
  }
  if (manifest.editLinks.provider === "none" && editIncluded.size > 0) {
    fail("manifest declares included edit links while the provider is disabled");
  }
  if (editIncluded.size > 0 && manifest.editLinks.origin === undefined) {
    fail("manifest declares included edit links without their trusted origin");
  }
}

const EDIT_LINK_MARKERS = ["data-atlcli-edit-link", "data-confluence-edit-link"] as const;

/**
 * An edit action is the one sanctioned link to the private source site. It
 * must be an anchor to the manifest's trusted Confluence origin, on a page
 * the manifest declares it for, and nowhere a page is declared without one.
 */
function assertEditLinks(
  manifest: StaticPublicationManifestV1,
  path: string,
  html: string,
  declaredBySourcePage: ReadonlyMap<string, boolean>,
  frozenHrefByPage: ReadonlyMap<string, string> | undefined,
): void {
  const marked = scanHtmlV1(html).tags.filter((tag) => EDIT_LINK_MARKERS.some((marker) => tag.attributes.has(marker)));
  const declared = declaredBySourcePage.get(path);
  if (marked.length > 0 && (manifest.editLinks.provider === "none" || declared === false)) {
    fail(`edit-link marker in ${manifest.editLinks.provider === "none" ? "disabled build" : "page without a declared edit link"} '${path}'`);
  }
  if (declared === true && marked.length === 0) fail(`edit-link marker missing in enabled build '${path}'`);
  for (const tag of marked) {
    const href = tag.attributes.get("href");
    if (tag.name !== "a" || trustedConfluenceEditUrlV1(href, manifest.editLinks.origin ?? "") === undefined) {
      fail(`edit link outside the trusted Confluence origin in '${path}'`);
    }
    if (frozenHrefByPage !== undefined && declared === true && href !== frozenHrefByPage.get(path)) {
      fail(`edit link differs from the bundle's provider URL in '${path}'`);
    }
  }
}

/** Verify a built Astro directory against the private inventory and public manifest. */
export async function verifyAstroStaticPublicationOutputV1(
  options: VerifyAstroStaticPublicationOutputOptionsV1,
): Promise<VerifiedAstroStaticPublicationOutputV1> {
  const { manifest, inventory } = options;
  if (inventory.bundleDigest !== manifest.bundleDigest) fail("inventory belongs to another bundle");
  const records = inventoryRecords(inventory);
  const files = await walkOutput(resolve(options.outputDirectory));
  if (files.size !== records.size) fail(`output file count ${files.size} differs from inventory ${records.size}`);
  for (const path of files.keys()) {
    if (!records.has(path)) fail(`unowned output file '${path}'`);
  }
  for (const [path, record] of records) await assertFileDigest(files.get(path)!, record);
  assertManifestReferences(manifest, records);
  const searchRecords = [...records.values()].filter((entry) => entry.path.startsWith("pagefind/")).sort((left, right) => left.path.localeCompare(right.path));
  if (await digestPublicationJsonV1(searchRecords) !== manifest.search.digest) fail("Pagefind digest mismatch");
  // The manifest digests SEO artifacts in inventory order; `records` keeps
  // that order, so do not re-sort (a locale sort disagrees on case and `_`).
  const seoRecords = [...records.values()].filter((entry) => /(?:^|\/)(?:sitemap[^/]*\.xml|robots\.txt|[^/]+\.xml)$/u.test(entry.path));
  if (await digestPublicationJsonV1(seoRecords) !== manifest.seo.digest) fail("SEO artifact digest mismatch");
  const pageIds = new Set(manifest.pages.map((entry) => entry.sourceId));
  if (manifest.search.indexedSourceIds.length !== pageIds.size || manifest.search.indexedSourceIds.some((sourceId) => !pageIds.has(sourceId))) {
    fail("Pagefind source declaration does not match publication pages");
  }
  const { buildDigest: _buildDigest, ...manifestIdentity } = manifest;
  if (await digestPublicationJsonV1(manifestIdentity) !== manifest.buildDigest) fail("manifest build digest mismatch");
  if (!manifest.verification.valid || manifest.verification.issues.length > 0) fail("manifest is not valid");

  const editIncluded = new Set(manifest.editLinks.includedSourceIds);
  const editLinkDeclaredByPage = new Map(manifest.pages.map((entry) => [entry.outputPath, editIncluded.has(entry.sourceId)]));
  const frozenHrefBySourceId = options.editLinks === undefined ? undefined : new Map(options.editLinks.links.map((link) => [link.sourceId, link.href]));
  const frozenHrefByPage = frozenHrefBySourceId === undefined ? undefined : new Map(manifest.pages.flatMap((entry) => {
    const href = frozenHrefBySourceId.get(entry.sourceId);
    return href === undefined ? [] : [[entry.outputPath, href] as const];
  }));
  let checkedLinks = 0;
  let checkedAnchors = 0;
  const anchorIds = new Map<string, ReadonlySet<string>>();
  for (const [path, absolute] of files) {
    if (!path.endsWith(".html")) continue;
    const html = await readFile(absolute, "utf8");
    const { references, markup, nonReferenceMarkup } = inspectHtmlMarkup(path, html);
    if (manifest.analytics.provider === "none" && /(?:data-atlcli-analytics|atlcli:analytics-csp|atlcli:analytics-privacy)/iu.test(markup)) fail(`analytics marker in disabled build '${path}'`);
    if (manifest.analytics.provider === "plausible") {
      if (!/data-atlcli-analytics="plausible"/iu.test(markup)) fail(`analytics marker missing in enabled build '${path}'`);
      if (!/atlcli:analytics-csp/iu.test(markup)) fail(`analytics CSP declaration missing in '${path}'`);
      if (!/default-src\s+'self'/iu.test(markup) || !/script-src\s+'self'/iu.test(markup) || !/object-src\s+'none'/iu.test(markup)) {
        fail(`analytics CSP is not self-contained in '${path}'`);
      }
      const escapedOrigin = escapeRegExp(manifest.analytics.endpointOrigin);
      if (!new RegExp(`connect-src[^<]*${escapedOrigin}`, "iu").test(markup)) fail(`analytics CSP endpoint is missing in '${path}'`);
    }
    assertEditLinks(manifest, path, html, editLinkDeclaredByPage, frozenHrefByPage);
    if (/api\.atlassian\.com|\/wiki\/rest\//iu.test(markup)) fail(`private Confluence URL in '${path}'`);
    // Links and resources are excluded here: the ownership check below proves
    // that each internal one resolves to an inventoried output file.
    if (WORKSPACE_REFERENCE.test(nonReferenceMarkup)) fail(`bundle-internal reference in '${path}'`);
    const result = await assertHtmlReferences(resolve(options.outputDirectory), path, references, files, manifest.outputProfile, basePrefix(manifest.base), anchorIds);
    checkedLinks += result.links;
    checkedAnchors += result.anchors;
  }
  return { checkedFiles: records.size, checkedLinks, checkedAnchors, outputFiles: files.size };
}
