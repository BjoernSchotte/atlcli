import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  digestPublicationJsonV1,
  validatePublicationOutputPathV1,
  type PublicationOutputProfileV1,
  type StaticPublicationManifestV1,
} from "@atlcli/web-publish";
import type { AstroBuildInventoryV1 } from "./manifest.js";

export interface VerifyAstroStaticPublicationOutputOptionsV1 {
  manifest: StaticPublicationManifestV1;
  inventory: AstroBuildInventoryV1;
  outputDirectory: string;
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

async function assertHtmlReferences(
  outputRoot: string,
  htmlPath: string,
  html: string,
  files: ReadonlyMap<string, string>,
  profile: PublicationOutputProfileV1,
  base: string,
): Promise<{ links: number; anchors: number }> {
  if (/\b(?:on[a-z]+)\s*=/iu.test(html)) fail(`event-handler attribute in '${htmlPath}'`);
  if (/javascript\s*:/iu.test(html)) fail(`javascript URL in '${htmlPath}'`);
  if (/<\s*(?:iframe|object|embed)\b/iu.test(html)) fail(`active-content element in '${htmlPath}'`);
  const sourceUrl = outputUrl(htmlPath, profile, base);
  const source = new URL(sourceUrl, "https://atlcli.invalid");
  const references = [
    ...html.matchAll(/\b(href|src|action)=["']([^"']+)["']/giu),
    ...html.matchAll(/\b(srcset)=["']([^"']+)["']/giu),
  ].flatMap((match) => {
    const kind = match[1]!.toLowerCase();
    const values = kind === "srcset" ? match[2]!.split(",") : [match[2]!];
    return values.map((value) => ({ kind, value: value.trim().split(/\s+/u)[0]! }));
  });
  let links = 0;
  let anchors = 0;
  const cache = new Map<string, string>();
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
    if (target.origin !== "https://atlcli.invalid") {
      if (kind === "src" || kind === "srcset" || kind === "action") fail(`external resource/action '${value}' in '${htmlPath}'`);
      continue;
    }
    const prefix = basePrefix(base);
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
      let targetHtml = cache.get(targetPath);
      if (targetHtml === undefined) {
        targetHtml = await readFile(resolve(outputRoot, targetPath), "utf8");
        cache.set(targetPath, targetHtml);
      }
      const idPattern = new RegExp(`(?:id|name)=["']${escapeRegExp(fragment)}["']`, "u");
      if (!idPattern.test(targetHtml)) fail(`missing fragment '#${fragment}' in '${value}'`);
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
  const seoRecords = [...records.values()].filter((entry) => /(?:^|\/)(?:sitemap[^/]*\.xml|robots\.txt|[^/]+\.xml)$/u.test(entry.path)).sort((left, right) => left.path.localeCompare(right.path));
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
  const seoRecords = [...records.values()].filter((entry) => /(?:^|\/)(?:sitemap[^/]*\.xml|robots\.txt|[^/]+\.xml)$/u.test(entry.path)).sort((left, right) => left.path.localeCompare(right.path));
  if (await digestPublicationJsonV1(seoRecords) !== manifest.seo.digest) fail("SEO artifact digest mismatch");
  const pageIds = new Set(manifest.pages.map((entry) => entry.sourceId));
  if (manifest.search.indexedSourceIds.length !== pageIds.size || manifest.search.indexedSourceIds.some((sourceId) => !pageIds.has(sourceId))) {
    fail("Pagefind source declaration does not match publication pages");
  }
  const { buildDigest: _buildDigest, ...manifestIdentity } = manifest;
  if (await digestPublicationJsonV1(manifestIdentity) !== manifest.buildDigest) fail("manifest build digest mismatch");
  if (!manifest.verification.valid || manifest.verification.issues.length > 0) fail("manifest is not valid");

  let checkedLinks = 0;
  let checkedAnchors = 0;
  for (const [path, absolute] of files) {
    if (!path.endsWith(".html")) continue;
    const html = await readFile(absolute, "utf8");
    if (manifest.analytics.provider === "none" && /(?:data-atlcli-analytics|atlcli:analytics-csp|atlcli:analytics-privacy)/iu.test(html)) fail(`analytics marker in disabled build '${path}'`);
    if (manifest.analytics.provider === "plausible") {
      if (!/data-atlcli-analytics="plausible"/iu.test(html)) fail(`analytics marker missing in enabled build '${path}'`);
      if (!/atlcli:analytics-csp/iu.test(html)) fail(`analytics CSP declaration missing in '${path}'`);
      if (!/default-src\s+'self'/iu.test(html) || !/script-src\s+'self'/iu.test(html) || !/object-src\s+'none'/iu.test(html)) {
        fail(`analytics CSP is not self-contained in '${path}'`);
      }
      const escapedOrigin = escapeRegExp(manifest.analytics.endpointOrigin);
      if (!new RegExp(`connect-src[^<]*${escapedOrigin}`, "iu").test(html)) fail(`analytics CSP endpoint is missing in '${path}'`);
    }
    if (manifest.editLinks.provider === "none" && /(?:data-atlcli-edit-link|data-confluence-edit-link)/iu.test(html)) fail(`edit-link marker in disabled build '${path}'`);
    if (manifest.editLinks.provider === "confluence" && manifest.editLinks.includedSourceIds.length > 0 && !/(?:data-atlcli-edit-link|data-confluence-edit-link)/iu.test(html)) {
      fail(`edit-link marker missing in enabled build '${path}'`);
    }
    if (/api\.atlassian\.com|\/wiki\/rest\//iu.test(html)) fail(`private Confluence URL in '${path}'`);
    if (/(?:\.atlcli\/|(?:^|[\/"'])(?:bundles|cache|staging)\/|(?:publication|current|build-inventory)\.json)/iu.test(html)) fail(`bundle-internal reference in '${path}'`);
    const result = await assertHtmlReferences(resolve(options.outputDirectory), path, html, files, manifest.outputProfile, basePrefix(manifest.base));
    checkedLinks += result.links;
    checkedAnchors += result.anchors;
  }
  return { checkedFiles: records.size, checkedLinks, checkedAnchors, outputFiles: files.size };
}
