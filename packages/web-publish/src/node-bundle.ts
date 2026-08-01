import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  PublicationAssetEntryV1,
  PublicationAssetPolicyV1,
  PublicationBundleV1,
  PublicationIssueV1,
  PublicationPageV1,
  PublicationPageEntryV1,
  PublicationRefreshPlanV1,
  PublicationRouteRecordV1,
} from "./contracts.js";
import {
  assertPublicationBundleReferencesV1,
  digestPublicationBundleV1,
  digestPublicationPageV1,
  digestPublicationRefreshPlanV1,
} from "./digests.js";
import { validatePublicationOutputPathV1 } from "./routes.js";
import { parsePublicationBundleV1, parsePublicationPageV1, parsePublicationRefreshPlanV1 } from "./schema.js";

const CURRENT_SCHEMA_V1 = "atlcli.publication-current/1" as const;
const SHA256_HEX = /^[a-f0-9]{64}$/u;

export interface PublicationBundleAssetBytesV1 {
  entry: PublicationAssetEntryV1;
  bytes: Uint8Array;
}

/**
 * All input is already normalized and materialized. This Node-only writer has
 * no Confluence or renderer dependency: it verifies the complete graph, writes
 * an immutable bundle in a private staging root, then changes the active
 * pointer only after successful promotion.
 */
export interface NodePublicationBundleMaterializationRequestV1 {
  /** Absolute project-owned publication workspace. */
  workspaceDirectory: string;
  refreshPlan: PublicationRefreshPlanV1;
  createdBy: PublicationBundleV1["createdBy"];
  sourcePolicyDigest: string;
  rootIds: readonly string[];
  pages: readonly PublicationPageV1[];
  routes: readonly PublicationRouteRecordV1[];
  assets: readonly PublicationBundleAssetBytesV1[];
  issues?: readonly PublicationIssueV1[];
  assetPolicy: Pick<PublicationAssetPolicyV1, "maxAssetBytes" | "maxTotalBytes">;
  /** Optimistic active-pointer precondition, checked before and at promotion. */
  expectedActiveBundleDigest?: string;
  signal?: AbortSignal;
}

export interface NodePublicationBundleMaterializationResultV1 {
  bundle: PublicationBundleV1;
  bundleDirectory: string;
  activated: true;
}

export type NodePublicationBundleErrorCodeV1 =
  | "invalid-request"
  | "unsafe-path"
  | "invalid-refresh-plan"
  | "incomplete-refresh-plan"
  | "invalid-page-digest"
  | "invalid-asset"
  | "asset-budget-exceeded"
  | "active-bundle-mismatch"
  | "corrupt-existing-bundle"
  | "aborted";

export class NodePublicationBundleErrorV1 extends Error {
  constructor(
    public readonly code: NodePublicationBundleErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "NodePublicationBundleErrorV1";
  }
}

interface CurrentPublicationPointerV1 {
  schema: typeof CURRENT_SCHEMA_V1;
  bundleDigest: string;
}

function fail(code: NodePublicationBundleErrorCodeV1, message: string): never {
  throw new NodePublicationBundleErrorV1(code, message);
}

function requirePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("invalid-request", `${label} must be a positive safe integer`);
  }
  return value;
}

function requireDigest(value: string, label: string): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    fail("invalid-request", `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertInside(root: string, candidate: string): string {
  const absolute = resolve(candidate);
  const pathRelative = relative(root, absolute);
  if (pathRelative === "" || pathRelative.startsWith("..") || isAbsolute(pathRelative)) {
    return fail("unsafe-path", "publication bundle path escapes its configured workspace");
  }
  return absolute;
}

async function ensureRealDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    fail("unsafe-path", "publication bundle directories must be real directories, not symlinks");
  }
}

async function ensureChildDirectory(root: string, path: string): Promise<void> {
  const absolute = assertInside(root, path);
  const segments = relative(root, absolute).split("/");
  let current = root;
  await ensureRealDirectory(current);
  for (const segment of segments) {
    current = join(current, segment);
    await ensureRealDirectory(current);
  }
}

async function assertSameFilesystem(left: string, right: string): Promise<void> {
  const [leftDetails, rightDetails] = await Promise.all([stat(left), stat(right)]);
  if (leftDetails.dev !== rightDetails.dev) {
    fail("unsafe-path", "staging and immutable bundle directories must be on the same filesystem");
  }
}

async function readRegularFile(path: string, maxBytes: number): Promise<Uint8Array | undefined> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) {
      fail("unsafe-path", "publication bundle entries must be regular non-symlink files");
    }
    if (details.size > maxBytes) fail("invalid-request", "publication bundle file exceeds its byte budget");
    const bytes = await readFile(path);
    if (bytes.byteLength > maxBytes) fail("invalid-request", "publication bundle file exceeded its byte budget while reading");
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeNewFile(path: string, bytes: Uint8Array): Promise<void> {
  const details = await lstat(join(path, ".."));
  if (details.isSymbolicLink() || !details.isDirectory()) {
    fail("unsafe-path", "publication bundle parent must be a real directory");
  }
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
}

async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeNewFile(temp, bytes);
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted) fail("aborted", "publication bundle materialization was cancelled");
}

function pagePath(page: PublicationPageV1): string {
  requireDigest(page.pageDigest, "page.pageDigest");
  return validatePublicationOutputPathV1(`pages/${page.pageDigest}.json`);
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) fail("invalid-request", "Web Crypto SubtleCrypto is required for asset digests");
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = new Uint8Array(await subtle.digest("SHA-256", buffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseCurrentPointer(value: unknown): CurrentPublicationPointerV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("corrupt-existing-bundle", "active publication pointer must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schema !== CURRENT_SCHEMA_V1 ||
    typeof candidate.bundleDigest !== "string" ||
    !SHA256_HEX.test(candidate.bundleDigest) ||
    Object.keys(candidate).some((key) => key !== "schema" && key !== "bundleDigest")
  ) {
    return fail("corrupt-existing-bundle", "active publication pointer is invalid");
  }
  return { schema: CURRENT_SCHEMA_V1, bundleDigest: candidate.bundleDigest };
}

async function readCurrentPointer(workspaceDirectory: string): Promise<CurrentPublicationPointerV1 | undefined> {
  const path = assertInside(workspaceDirectory, join(workspaceDirectory, "current.json"));
  const bytes = await readRegularFile(path, 1_024);
  if (bytes === undefined) return undefined;
  try {
    return parseCurrentPointer(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    if (error instanceof NodePublicationBundleErrorV1) throw error;
    return fail("corrupt-existing-bundle", "active publication pointer is invalid JSON");
  }
}

function assertExpectedPointer(
  actual: CurrentPublicationPointerV1 | undefined,
  expected: string | undefined,
): void {
  if (expected !== undefined) requireDigest(expected, "expectedActiveBundleDigest");
  if (expected !== undefined && actual?.bundleDigest !== expected) {
    fail("active-bundle-mismatch", "active publication bundle does not match the expected digest");
  }
}

async function verifyExistingBundle(
  bundleDirectory: string,
  expectedDigest: string,
  maxPageBytes: number,
  maxAssetBytes: number,
): Promise<void> {
  const manifestPath = join(bundleDirectory, "publication.json");
  const manifestBytes = await readRegularFile(manifestPath, maxPageBytes);
  if (manifestBytes === undefined) fail("corrupt-existing-bundle", "existing bundle has no publication manifest");
  let bundle: PublicationBundleV1;
  try {
    bundle = parsePublicationBundleV1(JSON.parse(new TextDecoder().decode(manifestBytes)));
  } catch {
    fail("corrupt-existing-bundle", "existing bundle manifest is invalid");
  }
  if (bundle.bundleDigest !== expectedDigest) {
    fail("corrupt-existing-bundle", "existing bundle directory has a mismatched manifest digest");
  }
  const pages: PublicationPageV1[] = [];
  for (const entry of bundle.pages) {
    const relativePath = validatePublicationOutputPathV1(entry.path);
    const bytes = await readRegularFile(join(bundleDirectory, relativePath), maxPageBytes);
    if (bytes === undefined) fail("corrupt-existing-bundle", "existing bundle has a missing page document");
    try {
      const page = parsePublicationPageV1(JSON.parse(new TextDecoder().decode(bytes)));
      if (page.sourceId !== entry.sourceId || page.pageDigest !== entry.pageDigest) {
        fail("corrupt-existing-bundle", "existing bundle page entry does not match its document");
      }
      if (await digestPublicationPageV1(page) !== page.pageDigest) {
        fail("corrupt-existing-bundle", "existing bundle page digest is invalid");
      }
      pages.push(page);
    } catch (error) {
      if (error instanceof NodePublicationBundleErrorV1) throw error;
      fail("corrupt-existing-bundle", "existing bundle page is invalid");
    }
  }
  for (const asset of bundle.assets) {
    let relativePath: string;
    try {
      relativePath = validatePublicationOutputPathV1(asset.path);
    } catch {
      fail("corrupt-existing-bundle", "existing bundle asset has an unsafe path");
    }
    const bytes = await readRegularFile(join(bundleDirectory, relativePath), maxAssetBytes);
    if (bytes === undefined || bytes.byteLength !== asset.byteLength) {
      fail("corrupt-existing-bundle", "existing bundle asset bytes are missing or have an unexpected length");
    }
    if (await digestBytes(bytes) !== asset.sha256) {
      fail("corrupt-existing-bundle", "existing bundle asset digest is invalid");
    }
  }
  try {
    if (await digestPublicationBundleV1(bundle, pages) !== expectedDigest) {
      fail("corrupt-existing-bundle", "existing bundle digest is invalid");
    }
  } catch (error) {
    if (error instanceof NodePublicationBundleErrorV1) throw error;
    fail("corrupt-existing-bundle", "existing bundle references are invalid");
  }
}

function validateRefreshPlan(refreshPlan: PublicationRefreshPlanV1): Promise<void> {
  return (async () => {
    let parsed: PublicationRefreshPlanV1;
    try {
      parsed = parsePublicationRefreshPlanV1(refreshPlan);
    } catch {
      fail("invalid-refresh-plan", "publication refresh plan violates its schema");
    }
    if (await digestPublicationRefreshPlanV1(parsed) !== parsed.planDigest) {
      fail("invalid-refresh-plan", "publication refresh plan digest is invalid");
    }
    if (!parsed.complete || !parsed.sourceSnapshot.complete) {
      fail("incomplete-refresh-plan", "only a complete authoritative refresh plan may activate a bundle");
    }
  })();
}

function validateInputShape(request: NodePublicationBundleMaterializationRequestV1): void {
  if (!isAbsolute(request.workspaceDirectory)) {
    fail("invalid-request", "workspaceDirectory must be absolute");
  }
  if (request.createdBy.name !== "atlcli" || !request.createdBy.version) {
    fail("invalid-request", "createdBy must identify an atlcli version");
  }
  requireDigest(request.sourcePolicyDigest, "sourcePolicyDigest");
  requirePositiveSafeInteger(request.assetPolicy.maxAssetBytes, "assetPolicy.maxAssetBytes");
  requirePositiveSafeInteger(request.assetPolicy.maxTotalBytes, "assetPolicy.maxTotalBytes");
}

function sourceIdsForIncludedPages(plan: PublicationRefreshPlanV1): Set<string> {
  return new Set(plan.sourceSnapshot.pages.filter((page) => page.state === "included").map((page) => page.sourceId));
}

async function buildBundle(
  request: NodePublicationBundleMaterializationRequestV1,
): Promise<{ bundle: PublicationBundleV1; pages: readonly PublicationPageV1[]; assets: readonly PublicationBundleAssetBytesV1[] }> {
  const includedSourceIds = sourceIdsForIncludedPages(request.refreshPlan);
  const pages: PublicationPageV1[] = [];
  const pageEntries: PublicationPageEntryV1[] = [];
  const seenPageIds = new Set<string>();
  const seenPagePaths = new Set<string>();
  for (const input of request.pages) {
    let page: PublicationPageV1;
    try {
      page = parsePublicationPageV1(input);
    } catch {
      fail("invalid-request", "publication bundle page violates its schema");
    }
    if (!includedSourceIds.has(page.sourceId) || seenPageIds.has(page.sourceId)) {
      fail("invalid-request", "bundle pages must have exactly one included source page");
    }
    if (await digestPublicationPageV1(page) !== page.pageDigest) {
      fail("invalid-page-digest", `page '${page.sourceId}' has an invalid digest`);
    }
    const path = pagePath(page);
    if (seenPagePaths.has(path)) fail("invalid-request", "bundle page paths must be unique");
    seenPageIds.add(page.sourceId);
    seenPagePaths.add(path);
    pages.push(page);
    pageEntries.push({ sourceId: page.sourceId, path, pageDigest: page.pageDigest });
  }
  if (seenPageIds.size !== includedSourceIds.size) {
    fail("invalid-request", "bundle pages do not cover every included source page");
  }

  let totalAssetBytes = 0;
  const assets: PublicationBundleAssetBytesV1[] = [];
  const seenAssetIds = new Set<string>();
  const seenAssetPaths = new Set<string>();
  for (const input of request.assets) {
    const { entry, bytes } = input;
    if (!(bytes instanceof Uint8Array)) fail("invalid-asset", "asset bytes must be Uint8Array");
    if (typeof entry.assetId !== "string" || !entry.assetId || seenAssetIds.has(entry.assetId)) {
      fail("invalid-asset", "bundle asset identifiers must be non-empty and unique");
    }
    const path = validatePublicationOutputPathV1(entry.path);
    if (!path.startsWith("assets/")) fail("invalid-asset", "bundle asset paths must be inside assets/");
    if (seenAssetPaths.has(path)) fail("invalid-asset", "bundle asset paths must be unique");
    requireDigest(entry.sha256, "asset.sha256");
    if (!Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0 || entry.byteLength !== bytes.byteLength) {
      fail("invalid-asset", "asset byteLength must exactly match its materialized bytes");
    }
    if (!entry.mediaType || entry.disposition === "blocked-active-content") {
      fail("invalid-asset", "bundles must not materialize blocked or untyped assets");
    }
    if (bytes.byteLength > request.assetPolicy.maxAssetBytes) {
      fail("asset-budget-exceeded", "asset exceeds publication maxAssetBytes");
    }
    totalAssetBytes += bytes.byteLength;
    if (!Number.isSafeInteger(totalAssetBytes) || totalAssetBytes > request.assetPolicy.maxTotalBytes) {
      fail("asset-budget-exceeded", "assets exceed publication maxTotalBytes");
    }
    if (await digestBytes(bytes) !== entry.sha256) {
      fail("invalid-asset", "asset sha256 does not match materialized bytes");
    }
    seenAssetIds.add(entry.assetId);
    seenAssetPaths.add(path);
    assets.push({ entry: { ...entry, path }, bytes: new Uint8Array(bytes) });
  }

  const provisional: PublicationBundleV1 = {
    schema: "atlcli.publication-bundle/1",
    bundleDigest: "pending",
    createdBy: request.createdBy,
    sourceSnapshot: request.refreshPlan.sourceSnapshot,
    sourcePolicyDigest: request.sourcePolicyDigest,
    complete: true,
    rootIds: [...request.rootIds],
    pages: pageEntries.sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    routes: [...request.routes],
    assets: assets.map(({ entry }) => entry).sort((left, right) => left.assetId.localeCompare(right.assetId)),
    issues: [...(request.issues ?? request.refreshPlan.issues)],
  };
  let bundle: PublicationBundleV1;
  try {
    assertPublicationBundleReferencesV1(provisional, pages);
    bundle = { ...provisional, bundleDigest: await digestPublicationBundleV1(provisional, pages) };
  } catch (error) {
    if (error instanceof NodePublicationBundleErrorV1) throw error;
    fail("invalid-request", `publication bundle references are invalid: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return { bundle, pages, assets };
}

/**
 * Materialize and atomically activate a complete, digest-verified bundle.
 * The only destructive cleanup is of this invocation's UUID-named staging
 * root. Therefore every validation error and cancellation leaves current.json
 * and its previously active immutable bundle untouched.
 */
export async function materializeNodePublicationBundleV1(
  request: NodePublicationBundleMaterializationRequestV1,
): Promise<NodePublicationBundleMaterializationResultV1> {
  validateInputShape(request);
  abortIfNeeded(request.signal);
  await validateRefreshPlan(request.refreshPlan);
  abortIfNeeded(request.signal);

  const workspaceDirectory = resolve(request.workspaceDirectory);
  await ensureRealDirectory(workspaceDirectory);
  const stagingDirectory = assertInside(workspaceDirectory, join(workspaceDirectory, "staging"));
  const bundlesDirectory = assertInside(workspaceDirectory, join(workspaceDirectory, "bundles"));
  await ensureChildDirectory(workspaceDirectory, stagingDirectory);
  await ensureChildDirectory(workspaceDirectory, bundlesDirectory);
  await assertSameFilesystem(stagingDirectory, bundlesDirectory);
  assertExpectedPointer(await readCurrentPointer(workspaceDirectory), request.expectedActiveBundleDigest);

  const stageRoot = assertInside(stagingDirectory, join(stagingDirectory, randomUUID()));
  const stageBundleDirectory = assertInside(stageRoot, join(stageRoot, "bundle"));
  try {
    await ensureChildDirectory(workspaceDirectory, stageBundleDirectory);
    const { bundle, pages, assets } = await buildBundle(request);
    abortIfNeeded(request.signal);

    for (const page of pages) {
      const path = assertInside(stageBundleDirectory, join(stageBundleDirectory, pagePath(page)));
      await ensureChildDirectory(stageBundleDirectory, join(path, ".."));
      await writeNewFile(path, new TextEncoder().encode(JSON.stringify(page)));
      abortIfNeeded(request.signal);
    }
    for (const asset of assets) {
      const path = assertInside(stageBundleDirectory, join(stageBundleDirectory, asset.entry.path));
      await ensureChildDirectory(stageBundleDirectory, join(path, ".."));
      await writeNewFile(path, asset.bytes);
      abortIfNeeded(request.signal);
    }
    const manifestPath = assertInside(stageBundleDirectory, join(stageBundleDirectory, "publication.json"));
    await writeNewFile(manifestPath, new TextEncoder().encode(JSON.stringify(bundle)));
    abortIfNeeded(request.signal);

    await verifyExistingBundle(
      stageBundleDirectory,
      bundle.bundleDigest,
      16 * 1024 * 1024,
      request.assetPolicy.maxAssetBytes,
    );
    abortIfNeeded(request.signal);
    const finalDirectory = assertInside(bundlesDirectory, join(bundlesDirectory, bundle.bundleDigest));
    try {
      await lstat(finalDirectory);
      await verifyExistingBundle(
        finalDirectory,
        bundle.bundleDigest,
        16 * 1024 * 1024,
        request.assetPolicy.maxAssetBytes,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await rename(stageBundleDirectory, finalDirectory);
      } else {
        throw error;
      }
    }
    abortIfNeeded(request.signal);
    assertExpectedPointer(await readCurrentPointer(workspaceDirectory), request.expectedActiveBundleDigest);
    const currentPath = assertInside(workspaceDirectory, join(workspaceDirectory, "current.json"));
    await writeAtomic(currentPath, new TextEncoder().encode(JSON.stringify({
      schema: CURRENT_SCHEMA_V1,
      bundleDigest: bundle.bundleDigest,
    } satisfies CurrentPublicationPointerV1)));
    return { bundle, bundleDirectory: finalDirectory, activated: true };
  } finally {
    await rm(stageRoot, { recursive: true, force: true, maxRetries: 1 }).catch(() => undefined);
  }
}
