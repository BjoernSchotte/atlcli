import {
  lstat,
  mkdir,
  readFile,
  readdir,
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
  PublicationRetentionPolicyV1,
  PublicationRouteRecordV1,
  StaticPublicationManifestV1,
} from "./contracts.js";
import {
  assertPublicationBundleReferencesV1,
  digestPublicationBundleV1,
  digestPublicationPageV1,
  digestPublicationRefreshPlanV1,
} from "./digests.js";
import {
  DEFAULT_PUBLICATION_CACHE_ASSET_BYTES_V1,
  DEFAULT_PUBLICATION_CACHE_PAGE_BYTES_V1,
} from "./node-cache.js";
import { validatePublicationOutputPathV1 } from "./routes.js";
import {
  parsePublicationBundleV1,
  parsePublicationPageV1,
  parsePublicationRefreshPlanV1,
  parseStaticPublicationManifestV1,
} from "./schema.js";

const CURRENT_SCHEMA_V1 = "atlcli.publication-current/1" as const;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const ACTIVATION_LOCK_SCHEMA_V1 = "atlcli.publication-activation-lock/1" as const;
const DEFAULT_ACTIVATION_LOCK_TTL_MS_V1 = 30_000;
const DEFAULT_ACTIVATION_LOCK_POLL_MS_V1 = 10;
const DEFAULT_ACTIVATION_LOCK_TIMEOUT_MS_V1 = 30_000;

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
  /** Bounded local lease wait for the final active-pointer transition. */
  activationLockTimeoutMs?: number;
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
  | "activation-lock-timeout"
  | "activation-lock-lost"
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

export interface NodePublicationRetentionRequestV1 {
  /** Absolute project-owned publication workspace. */
  workspaceDirectory: string;
  retention: PublicationRetentionPolicyV1;
  /** Injectable clock (milliseconds since epoch) for deterministic sweeps. */
  now: number;
  maxPageBytes?: number;
  maxAssetBytes?: number;
}

export interface NodePublicationRetentionResultV1 {
  retainedBundleDigests: readonly string[];
  retainedBuildDigests: readonly string[];
  removedBundleDigests: readonly string[];
  removedBuildDigests: readonly string[];
}

interface CurrentPublicationPointerV1 {
  schema: typeof CURRENT_SCHEMA_V1;
  bundleDigest: string;
}

interface ActivationLockOwnerV1 {
  schema: typeof ACTIVATION_LOCK_SCHEMA_V1;
  nonce: string;
  acquiredAt: number;
  expiresAt: number;
}

interface ActivationLockLeaseV1 {
  assertOwned(): Promise<void>;
  release(): Promise<void>;
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

async function assertRealDirectory(path: string): Promise<void> {
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    fail("unsafe-path", "publication workspace directories must be real directories, not symlinks");
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

async function delay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  abortIfNeeded(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new NodePublicationBundleErrorV1("aborted", "publication bundle materialization was cancelled"));
    }, { once: true });
  });
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

function parseActivationLockOwner(value: unknown): ActivationLockOwnerV1 | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const acquiredAt = candidate.acquiredAt;
  const expiresAt = candidate.expiresAt;
  if (
    candidate.schema !== ACTIVATION_LOCK_SCHEMA_V1 ||
    typeof candidate.nonce !== "string" || !/^[a-f0-9-]{36}$/u.test(candidate.nonce) ||
    typeof acquiredAt !== "number" || !Number.isSafeInteger(acquiredAt) ||
    typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) ||
    expiresAt <= acquiredAt ||
    Object.keys(candidate).some((key) => !["schema", "nonce", "acquiredAt", "expiresAt"].includes(key))
  ) return undefined;
  return {
    schema: ACTIVATION_LOCK_SCHEMA_V1,
    nonce: candidate.nonce,
    acquiredAt,
    expiresAt,
  };
}

async function readActivationLockOwner(lockDirectory: string): Promise<ActivationLockOwnerV1 | undefined> {
  const ownerPath = assertInside(lockDirectory, join(lockDirectory, "owner.json"));
  const bytes = await readRegularFile(ownerPath, 4_096);
  if (bytes === undefined) return undefined;
  try {
    return parseActivationLockOwner(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return undefined;
  }
}

async function acquireActivationLock(
  workspaceDirectory: string,
  signal: AbortSignal | undefined,
  timeoutMilliseconds: number | undefined,
): Promise<ActivationLockLeaseV1> {
  const timeout = timeoutMilliseconds ?? DEFAULT_ACTIVATION_LOCK_TIMEOUT_MS_V1;
  requirePositiveSafeInteger(timeout, "activationLockTimeoutMs");
  const locksDirectory = assertInside(workspaceDirectory, join(workspaceDirectory, "locks"));
  await ensureChildDirectory(workspaceDirectory, locksDirectory);
  const lockDirectory = assertInside(locksDirectory, join(locksDirectory, "activation.lock"));
  const deadline = Date.now() + timeout;
  for (;;) {
    abortIfNeeded(signal);
    const acquiredAt = Date.now();
    const owner: ActivationLockOwnerV1 = {
      schema: ACTIVATION_LOCK_SCHEMA_V1,
      nonce: randomUUID(),
      acquiredAt,
      expiresAt: acquiredAt + DEFAULT_ACTIVATION_LOCK_TTL_MS_V1,
    };
    let createdLockDirectory = false;
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      createdLockDirectory = true;
      await writeNewFile(
        assertInside(lockDirectory, join(lockDirectory, "owner.json")),
        new TextEncoder().encode(JSON.stringify(owner)),
      );
      let released = false;
      const assertOwned = async (): Promise<void> => {
        if (released || (await readActivationLockOwner(lockDirectory))?.nonce !== owner.nonce) {
          fail("activation-lock-lost", "publication activation lock is no longer owned by this writer");
        }
      };
      return {
        assertOwned,
        async release(): Promise<void> {
          if (released) return;
          await assertOwned();
          const quarantine = assertInside(locksDirectory, join(locksDirectory, `activation.release-${owner.nonce}`));
          await rename(lockDirectory, quarantine);
          released = true;
          await rm(quarantine, { recursive: true, force: false, maxRetries: 1 });
        },
      };
    } catch (error) {
      if (createdLockDirectory) await rm(lockDirectory, { recursive: true, force: true, maxRetries: 1 }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const details = await lstat(lockDirectory);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      fail("unsafe-path", "publication activation lock must be a real directory");
    }
    const current = await readActivationLockOwner(lockDirectory);
    const stale = current === undefined
      ? Date.now() - Math.floor(details.mtimeMs) >= DEFAULT_ACTIVATION_LOCK_TTL_MS_V1
      : current.expiresAt <= Date.now();
    if (stale) {
      const guard = assertInside(lockDirectory, join(lockDirectory, ".reclaim.guard"));
      let ownsGuard = false;
      try {
        await writeNewFile(guard, new Uint8Array());
        ownsGuard = true;
        const guardedOwner = await readActivationLockOwner(lockDirectory);
        if (guardedOwner === undefined || guardedOwner.expiresAt <= Date.now()) {
          const quarantine = assertInside(locksDirectory, join(locksDirectory, `activation.stale-${randomUUID()}`));
          await rename(lockDirectory, quarantine);
          await rm(quarantine, { recursive: true, force: false, maxRetries: 1 });
          continue;
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOENT") throw error;
      } finally {
        if (ownsGuard) await unlink(guard).catch(() => undefined);
      }
    }
    if (Date.now() >= deadline) {
      fail("activation-lock-timeout", "timed out waiting to activate the publication bundle");
    }
    await delay(DEFAULT_ACTIVATION_LOCK_POLL_MS_V1, signal);
  }
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
  if (actual !== undefined && expected === undefined) {
    fail("active-bundle-mismatch", "activating over an existing bundle requires expectedActiveBundleDigest");
  }
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
  const logicalAssets: { entry: PublicationAssetEntryV1; bytes: Uint8Array }[] = [];
  const seenAssetIds = new Set<string>();
  const contentByDigest = new Map<string, { canonicalPath: string; bytes: Uint8Array; mediaType: string }>();
  for (const input of request.assets) {
    const { entry, bytes } = input;
    if (!(bytes instanceof Uint8Array)) fail("invalid-asset", "asset bytes must be Uint8Array");
    if (typeof entry.assetId !== "string" || !entry.assetId || seenAssetIds.has(entry.assetId)) {
      fail("invalid-asset", "bundle asset identifiers must be non-empty and unique");
    }
    const path = validatePublicationOutputPathV1(entry.path);
    requireDigest(entry.sha256, "asset.sha256");
    if (!path.startsWith(`assets/${entry.sha256}/`)) {
      fail("invalid-asset", "bundle asset paths must be content-addressed by their byte digest");
    }
    if (!Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0 || entry.byteLength !== bytes.byteLength) {
      fail("invalid-asset", "asset byteLength must exactly match its materialized bytes");
    }
    if (!entry.mediaType || entry.disposition === "blocked-active-content") {
      fail("invalid-asset", "bundles must not materialize blocked or untyped assets");
    }
    if (entry.downloadName !== undefined) {
      let downloadPath: string;
      try {
        downloadPath = validatePublicationOutputPathV1(`assets/download/${entry.downloadName}`);
      } catch {
        fail("invalid-asset", "asset downloadName must be one safe filename");
      }
      if (downloadPath.split("/").length !== 3) {
        fail("invalid-asset", "asset downloadName must be one safe filename");
      }
    }
    if (bytes.byteLength > request.assetPolicy.maxAssetBytes) {
      fail("asset-budget-exceeded", "asset exceeds publication maxAssetBytes");
    }
    if (await digestBytes(bytes) !== entry.sha256) {
      fail("invalid-asset", "asset sha256 does not match materialized bytes");
    }
    const existingContent = contentByDigest.get(entry.sha256);
    if (existingContent === undefined) {
      totalAssetBytes += bytes.byteLength;
      if (!Number.isSafeInteger(totalAssetBytes) || totalAssetBytes > request.assetPolicy.maxTotalBytes) {
        fail("asset-budget-exceeded", "deduplicated assets exceed publication maxTotalBytes");
      }
      contentByDigest.set(entry.sha256, {
        canonicalPath: path,
        bytes: new Uint8Array(bytes),
        mediaType: entry.mediaType,
      });
    } else {
      if (existingContent.mediaType !== entry.mediaType || existingContent.bytes.byteLength !== bytes.byteLength) {
        fail("invalid-asset", "same asset digest must identify the same bytes and media type");
      }
      for (let index = 0; index < bytes.byteLength; index += 1) {
        if (existingContent.bytes[index] !== bytes[index]) {
          fail("invalid-asset", "same asset digest must identify the same bytes and media type");
        }
      }
      if (path.localeCompare(existingContent.canonicalPath) < 0) {
        existingContent.canonicalPath = path;
      }
    }
    seenAssetIds.add(entry.assetId);
    logicalAssets.push({ entry, bytes: new Uint8Array(bytes) });
  }
  const assets: PublicationBundleAssetBytesV1[] = logicalAssets.map(({ entry, bytes }) => {
    const content = contentByDigest.get(entry.sha256);
    if (content === undefined) throw new Error("unreachable asset content group");
    return { entry: { ...entry, path: content.canonicalPath }, bytes };
  });

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
    const writtenAssetPaths = new Set<string>();
    for (const asset of assets) {
      if (writtenAssetPaths.has(asset.entry.path)) continue;
      const path = assertInside(stageBundleDirectory, join(stageBundleDirectory, asset.entry.path));
      await ensureChildDirectory(stageBundleDirectory, join(path, ".."));
      await writeNewFile(path, asset.bytes);
      writtenAssetPaths.add(asset.entry.path);
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
    const activationLock = await acquireActivationLock(
      workspaceDirectory,
      request.signal,
      request.activationLockTimeoutMs,
    );
    try {
      await activationLock.assertOwned();
      assertExpectedPointer(await readCurrentPointer(workspaceDirectory), request.expectedActiveBundleDigest);
      await activationLock.assertOwned();
      const currentPath = assertInside(workspaceDirectory, join(workspaceDirectory, "current.json"));
      await writeAtomic(currentPath, new TextEncoder().encode(JSON.stringify({
        schema: CURRENT_SCHEMA_V1,
        bundleDigest: bundle.bundleDigest,
      } satisfies CurrentPublicationPointerV1)));
      await activationLock.assertOwned();
    } finally {
      await activationLock.release();
    }
    return { bundle, bundleDirectory: finalDirectory, activated: true };
  } finally {
    await rm(stageRoot, { recursive: true, force: true, maxRetries: 1 }).catch(() => undefined);
  }
}

interface RetainedBundleRecordV1 {
  digest: string;
  directory: string;
  modifiedAt: number;
}

interface RetainedBuildRecordV1 {
  digest: string;
  bundleDigest: string;
  directory: string;
  modifiedAt: number;
}

function compareNewestFirst<T extends { digest: string; modifiedAt: number }>(left: T, right: T): number {
  return right.modifiedAt - left.modifiedAt || left.digest.localeCompare(right.digest);
}

function validateRetentionRequest(request: NodePublicationRetentionRequestV1): {
  workspaceDirectory: string;
  maxPageBytes: number;
  maxAssetBytes: number;
  graceMilliseconds: number;
  now: number;
} {
  if (!isAbsolute(request.workspaceDirectory)) {
    fail("invalid-request", "workspaceDirectory must be absolute");
  }
  requirePositiveSafeInteger(request.retention.bundles, "retention.bundles");
  requirePositiveSafeInteger(request.retention.builds, "retention.builds");
  if (!Number.isSafeInteger(request.retention.graceSeconds) || request.retention.graceSeconds < 0) {
    fail("invalid-request", "retention.graceSeconds must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(request.now) || request.now < 0) {
    fail("invalid-request", "now must be a non-negative safe integer");
  }
  const graceMilliseconds = request.retention.graceSeconds * 1_000;
  if (!Number.isSafeInteger(graceMilliseconds)) {
    fail("invalid-request", "retention grace period is too large");
  }
  return {
    workspaceDirectory: resolve(request.workspaceDirectory),
    maxPageBytes: requirePositiveSafeInteger(request.maxPageBytes ?? DEFAULT_PUBLICATION_CACHE_PAGE_BYTES_V1, "maxPageBytes"),
    maxAssetBytes: requirePositiveSafeInteger(request.maxAssetBytes ?? DEFAULT_PUBLICATION_CACHE_ASSET_BYTES_V1, "maxAssetBytes"),
    graceMilliseconds,
    now: request.now,
  };
}

async function ownedDigestDirectories(
  workspaceDirectory: string,
  root: string,
): Promise<readonly { digest: string; directory: string; modifiedAt: number }[]> {
  try {
    await assertRealDirectory(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries = await readdir(root, { withFileTypes: true });
  const result: { digest: string; directory: string; modifiedAt: number }[] = [];
  for (const entry of entries) {
    if (!SHA256_HEX.test(entry.name)) continue;
    const directory = assertInside(root, join(root, entry.name));
    const details = await lstat(directory);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      fail("unsafe-path", "digest-named publication entries must be real directories, not symlinks");
    }
    result.push({ digest: entry.name, directory, modifiedAt: Math.floor(details.mtimeMs) });
  }
  return result;
}

async function inspectBundlesForRetention(
  workspaceDirectory: string,
  bundlesDirectory: string,
  maxPageBytes: number,
  maxAssetBytes: number,
): Promise<readonly RetainedBundleRecordV1[]> {
  const entries = await ownedDigestDirectories(workspaceDirectory, bundlesDirectory);
  for (const entry of entries) {
    try {
      await verifyExistingBundle(entry.directory, entry.digest, maxPageBytes, maxAssetBytes);
    } catch (error) {
      if (error instanceof NodePublicationBundleErrorV1) throw error;
      fail("corrupt-existing-bundle", "a digest-named publication bundle is invalid; retention is unsafe");
    }
  }
  return entries;
}

async function inspectBuildsForRetention(
  workspaceDirectory: string,
  buildsDirectory: string,
  maxPageBytes: number,
): Promise<readonly RetainedBuildRecordV1[]> {
  const entries = await ownedDigestDirectories(workspaceDirectory, buildsDirectory);
  const builds: RetainedBuildRecordV1[] = [];
  for (const entry of entries) {
    const manifestPath = assertInside(entry.directory, join(entry.directory, "manifest.json"));
    const bytes = await readRegularFile(manifestPath, maxPageBytes);
    if (bytes === undefined) {
      fail("corrupt-existing-bundle", "a digest-named publication build has no manifest; retention is unsafe");
    }
    let manifest: StaticPublicationManifestV1;
    try {
      manifest = parseStaticPublicationManifestV1(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      fail("corrupt-existing-bundle", "a digest-named publication build manifest is invalid; retention is unsafe");
    }
    if (!SHA256_HEX.test(manifest.buildDigest) || manifest.buildDigest !== entry.digest || !SHA256_HEX.test(manifest.bundleDigest)) {
      fail("corrupt-existing-bundle", "a publication build manifest does not match its digest-named directory");
    }
    builds.push({ digest: entry.digest, bundleDigest: manifest.bundleDigest, directory: entry.directory, modifiedAt: entry.modifiedAt });
  }
  return builds;
}

async function removeRecordedDirectory(directory: string): Promise<void> {
  await assertRealDirectory(directory);
  await rm(directory, { recursive: true, force: false, maxRetries: 1 });
}

/**
 * Remove only digest-named, manifest-verified bundle/build directories that are
 * no longer reachable from the active pointer or retained manifests and have
 * exceeded the configured grace period. It never infers ownership from a glob
 * and fails closed before removing anything if a manifest is corrupt.
 */
export async function sweepNodePublicationRetentionV1(
  request: NodePublicationRetentionRequestV1,
): Promise<NodePublicationRetentionResultV1> {
  const options = validateRetentionRequest(request);
  await assertRealDirectory(options.workspaceDirectory);
  const bundlesDirectory = assertInside(options.workspaceDirectory, join(options.workspaceDirectory, "bundles"));
  const buildsDirectory = assertInside(options.workspaceDirectory, join(options.workspaceDirectory, "builds"));
  const bundles = await inspectBundlesForRetention(
    options.workspaceDirectory,
    bundlesDirectory,
    options.maxPageBytes,
    options.maxAssetBytes,
  );
  const builds = await inspectBuildsForRetention(options.workspaceDirectory, buildsDirectory, options.maxPageBytes);
  const active = await readCurrentPointer(options.workspaceDirectory);
  const bundleByDigest = new Map(bundles.map((bundle) => [bundle.digest, bundle]));
  if (active !== undefined && !bundleByDigest.has(active.bundleDigest)) {
    fail("corrupt-existing-bundle", "active publication pointer does not reference a verified immutable bundle");
  }

  const retainedBuilds = [...builds].sort(compareNewestFirst).slice(0, request.retention.builds);
  const retainedBundleDigests = new Set(
    [...bundles].sort(compareNewestFirst).slice(0, request.retention.bundles).map((bundle) => bundle.digest),
  );
  if (active !== undefined) retainedBundleDigests.add(active.bundleDigest);
  for (const build of retainedBuilds) {
    if (!bundleByDigest.has(build.bundleDigest)) {
      fail("corrupt-existing-bundle", "a retained build manifest references a missing immutable bundle");
    }
    retainedBundleDigests.add(build.bundleDigest);
  }

  const isPastGrace = (modifiedAt: number): boolean =>
    options.now >= modifiedAt && options.now - modifiedAt >= options.graceMilliseconds;
  const buildsToRemove = builds.filter((build) =>
    !retainedBuilds.some((retained) => retained.digest === build.digest) && isPastGrace(build.modifiedAt),
  ).sort((left, right) => left.digest.localeCompare(right.digest));
  const bundlesToRemove = bundles.filter((bundle) =>
    !retainedBundleDigests.has(bundle.digest) && isPastGrace(bundle.modifiedAt),
  ).sort((left, right) => left.digest.localeCompare(right.digest));

  for (const build of buildsToRemove) await removeRecordedDirectory(build.directory);
  for (const bundle of bundlesToRemove) await removeRecordedDirectory(bundle.directory);
  return {
    retainedBundleDigests: [...retainedBundleDigests].sort(),
    retainedBuildDigests: retainedBuilds.map((build) => build.digest).sort(),
    removedBundleDigests: bundlesToRemove.map((bundle) => bundle.digest),
    removedBuildDigests: buildsToRemove.map((build) => build.digest),
  };
}
