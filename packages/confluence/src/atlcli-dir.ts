/**
 * .atlcli/ directory management for atlcli.
 *
 * Handles the sidecar directory structure:
 * .atlcli/
 * ├── config.json    # Space/project configuration
 * ├── state.json     # Sync state for all tracked pages
 * └── cache/         # Base versions for 3-way merge
 */

import { join, dirname, relative, resolve } from "path";
import { existsSync } from "fs";
import { mkdir, readFile, writeFile, unlink } from "fs/promises";

const ATLCLI_DIR = ".atlcli";
const CONFIG_FILE = "config.json";
const STATE_FILE = "state.json";
const CACHE_DIR = "cache";

/** Threshold for large file warnings (10MB) */
export const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024;

/**
 * Check if a file size exceeds the large file threshold.
 */
export function isLargeFile(sizeBytes: number): boolean {
  return sizeBytes >= LARGE_FILE_THRESHOLD;
}

/**
 * Format file size for human-readable output.
 */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${bytes}B`;
}

/**
 * Generate a conflict filename by adding -conflict before the extension.
 * Example: diagram.png -> diagram-conflict.png
 */
export function generateConflictFilename(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot === -1) {
    return `${filename}-conflict`;
  }
  return `${filename.slice(0, lastDot)}-conflict${filename.slice(lastDot)}`;
}

/** Scope configuration for partial sync */
export type ConfigScope =
  | { type: "page"; pageId: string }
  | { type: "tree"; ancestorId: string }
  | { type: "space" }; // spaceKey is stored in top-level space field

/** Configuration for a directory synced with Confluence (v1 - legacy) */
export interface AtlcliConfigV1 {
  schemaVersion: 1;
  space: string;
  baseUrl: string;
  profile?: string;
  settings?: {
    autoCreatePages?: boolean;
    preserveHierarchy?: boolean;
    defaultParentId?: string | null;
  };
}

/** Configuration for a directory synced with Confluence (v2 - with scope) */
export interface AtlcliConfigV2 {
  schemaVersion: 2;
  /** Sync scope - what to pull/push */
  scope: ConfigScope;
  /** Space key (always required, may be auto-detected) */
  space: string;
  baseUrl: string;
  profile?: string;
  settings?: {
    autoCreatePages?: boolean;
    preserveHierarchy?: boolean;
    defaultParentId?: string | null;
  };
}

/** Configuration for a directory synced with Confluence */
export type AtlcliConfig = AtlcliConfigV1 | AtlcliConfigV2;

/** Sync state for a single attachment */
export interface AttachmentState {
  /** Attachment ID from Confluence */
  attachmentId: string;
  /** Original filename (as stored in Confluence) */
  filename: string;
  /** Local path relative to page's attachment directory */
  localPath: string;
  /** Media type (e.g., "image/png", "application/pdf") */
  mediaType: string;
  /** File size in bytes */
  fileSize: number;
  /** Confluence attachment version number */
  version: number;
  /** SHA-256 hash of local file content */
  localHash: string;
  /** SHA-256 hash of remote file content at last sync */
  remoteHash: string;
  /** SHA-256 hash of base version (for conflict detection) */
  baseHash: string;
  /** ISO timestamp of last sync */
  lastSyncedAt: string;
  /** Current sync state */
  syncState: SyncState;
}

/** Sync state for a single page */
export interface PageState {
  path: string;
  title: string;
  spaceKey: string;
  version: number;
  lastSyncedAt: string;
  localHash: string;
  remoteHash: string;
  baseHash: string;
  syncState: SyncState;
  parentId: string | null;
  /** Ancestor IDs from root to parent (for hierarchy tracking) */
  ancestors: string[];
  /** Attachment metadata for this page (keyed by attachmentId) */
  attachments?: Record<string, AttachmentState>;
  /** Flag if page has any attachments (for quick filtering) */
  hasAttachments?: boolean;
}

/** Possible sync states for a page */
export type SyncState =
  | "synced"
  | "local-modified"
  | "remote-modified"
  | "conflict"
  | "untracked";

/** State for all tracked pages in a directory */
export interface AtlcliState {
  schemaVersion: 1;
  lastSync: string | null;
  pages: Record<string, PageState>;
  pathIndex: Record<string, string>;
}

/**
 * Find the .atlcli directory starting from a path and walking up.
 * Returns the directory containing .atlcli/, or null if not found.
 */
export function findAtlcliDir(startPath: string): string | null {
  let current = resolve(startPath);

  while (true) {
    const atlcliPath = join(current, ATLCLI_DIR);
    if (existsSync(atlcliPath)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      // Reached filesystem root
      break;
    }
    current = parent;
  }

  return null;
}

/**
 * Check if a directory is initialized with .atlcli/
 */
export function isInitialized(dir: string): boolean {
  return existsSync(join(dir, ATLCLI_DIR, CONFIG_FILE));
}

/** Options for initializing a directory */
export interface InitOptions {
  scope: ConfigScope;
  space: string;
  baseUrl: string;
  profile?: string;
  settings?: {
    autoCreatePages?: boolean;
    preserveHierarchy?: boolean;
    defaultParentId?: string | null;
  };
}

/**
 * Initialize a directory for Confluence sync.
 * Creates .atlcli/ with config.json, state.json, and cache/ directory.
 *
 * @deprecated Use initAtlcliDirV2 for new code
 */
export async function initAtlcliDir(
  dir: string,
  config: Omit<AtlcliConfigV1, "schemaVersion">
): Promise<void> {
  const atlcliPath = join(dir, ATLCLI_DIR);
  const cachePath = join(atlcliPath, CACHE_DIR);

  // Create directories
  await mkdir(cachePath, { recursive: true });

  // Write config (v1 for backwards compatibility)
  const fullConfig: AtlcliConfigV1 = {
    schemaVersion: 1,
    ...config,
  };
  await writeFile(
    join(atlcliPath, CONFIG_FILE),
    JSON.stringify(fullConfig, null, 2) + "\n"
  );

  // Write empty state
  const emptyState: AtlcliState = {
    schemaVersion: 1,
    lastSync: null,
    pages: {},
    pathIndex: {},
  };
  await writeFile(
    join(atlcliPath, STATE_FILE),
    JSON.stringify(emptyState, null, 2) + "\n"
  );
}

/**
 * Initialize a directory for Confluence sync with v2 config (scope support).
 * Creates .atlcli/ with config.json, state.json, and cache/ directory.
 */
export async function initAtlcliDirV2(
  dir: string,
  options: InitOptions
): Promise<void> {
  const atlcliPath = join(dir, ATLCLI_DIR);
  const cachePath = join(atlcliPath, CACHE_DIR);

  // Create directories
  await mkdir(cachePath, { recursive: true });

  // Write v2 config
  const fullConfig: AtlcliConfigV2 = {
    schemaVersion: 2,
    scope: options.scope,
    space: options.space,
    baseUrl: options.baseUrl,
    profile: options.profile,
    settings: options.settings,
  };
  await writeFile(
    join(atlcliPath, CONFIG_FILE),
    JSON.stringify(fullConfig, null, 2) + "\n"
  );

  // Write empty state
  const emptyState: AtlcliState = {
    schemaVersion: 1,
    lastSync: null,
    pages: {},
    pathIndex: {},
  };
  await writeFile(
    join(atlcliPath, STATE_FILE),
    JSON.stringify(emptyState, null, 2) + "\n"
  );
}

/**
 * Read configuration from .atlcli/config.json
 */
export async function readConfig(dir: string): Promise<AtlcliConfig> {
  const configPath = join(dir, ATLCLI_DIR, CONFIG_FILE);
  const content = await readFile(configPath, "utf-8");
  return JSON.parse(content) as AtlcliConfig;
}

/**
 * Write configuration to .atlcli/config.json
 */
export async function writeConfig(
  dir: string,
  config: AtlcliConfig
): Promise<void> {
  const configPath = join(dir, ATLCLI_DIR, CONFIG_FILE);
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Check if config is v2 (has scope field).
 */
export function isConfigV2(config: AtlcliConfig): config is AtlcliConfigV2 {
  return config.schemaVersion === 2;
}

/**
 * Get the scope from config, converting v1 to scope format.
 */
export function getConfigScope(config: AtlcliConfig): ConfigScope {
  if (isConfigV2(config)) {
    return config.scope;
  }
  // v1 config: implicit space scope
  return { type: "space" };
}

/**
 * Migrate v1 config to v2 format.
 */
export function migrateConfigToV2(config: AtlcliConfigV1): AtlcliConfigV2 {
  return {
    schemaVersion: 2,
    scope: { type: "space" },
    space: config.space,
    baseUrl: config.baseUrl,
    profile: config.profile,
    settings: config.settings,
  };
}

/**
 * Read state from .atlcli/state.json
 */
export async function readState(dir: string): Promise<AtlcliState> {
  const statePath = join(dir, ATLCLI_DIR, STATE_FILE);
  try {
    const content = await readFile(statePath, "utf-8");
    return JSON.parse(content) as AtlcliState;
  } catch {
    // Return empty state if file doesn't exist
    return {
      schemaVersion: 1,
      lastSync: null,
      pages: {},
      pathIndex: {},
    };
  }
}

/**
 * Write state to .atlcli/state.json
 */
export async function writeState(
  dir: string,
  state: AtlcliState
): Promise<void> {
  const statePath = join(dir, ATLCLI_DIR, STATE_FILE);
  await writeFile(statePath, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Update state for a single page.
 * Automatically updates the pathIndex.
 */
export function updatePageState(
  state: AtlcliState,
  pageId: string,
  update: Partial<PageState>
): void {
  const existing = state.pages[pageId];

  // Remove old path from index if path is changing
  if (existing?.path && update.path && existing.path !== update.path) {
    delete state.pathIndex[existing.path];
  }

  // Update or create page state
  state.pages[pageId] = {
    ...existing,
    ...update,
  } as PageState;

  // Update path index
  const path = update.path || existing?.path;
  if (path) {
    state.pathIndex[path] = pageId;
  }
}

/**
 * Remove a page from state.
 */
export function removePageState(state: AtlcliState, pageId: string): void {
  const existing = state.pages[pageId];
  if (existing?.path) {
    delete state.pathIndex[existing.path];
  }
  delete state.pages[pageId];
}

/**
 * Get page state by file path (relative to root).
 */
export function getPageByPath(
  state: AtlcliState,
  path: string
): PageState | null {
  const pageId = state.pathIndex[path];
  if (!pageId) return null;
  return state.pages[pageId] || null;
}

/**
 * Get page state by page ID.
 */
export function getPageById(
  state: AtlcliState,
  pageId: string
): PageState | null {
  return state.pages[pageId] || null;
}

/**
 * Compute sync state based on hashes.
 */
export function computeSyncState(
  localHash: string,
  remoteHash: string,
  baseHash: string
): SyncState {
  const localChanged = localHash !== baseHash;
  const remoteChanged = remoteHash !== baseHash;

  if (!localChanged && !remoteChanged) {
    return "synced";
  }
  if (localChanged && !remoteChanged) {
    return "local-modified";
  }
  if (!localChanged && remoteChanged) {
    return "remote-modified";
  }
  // Both changed
  if (localHash === remoteHash) {
    // Same changes on both sides
    return "synced";
  }
  return "conflict";
}

/**
 * Read base content from cache for 3-way merge.
 */
export async function readBaseContent(
  dir: string,
  pageId: string
): Promise<string | null> {
  const cachePath = join(dir, ATLCLI_DIR, CACHE_DIR, `${pageId}.md`);
  try {
    return await readFile(cachePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Write base content to cache for 3-way merge.
 */
export async function writeBaseContent(
  dir: string,
  pageId: string,
  content: string
): Promise<void> {
  const cachePath = join(dir, ATLCLI_DIR, CACHE_DIR, `${pageId}.md`);
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, content);
}

/**
 * Delete base content from cache.
 */
export async function deleteBaseContent(
  dir: string,
  pageId: string
): Promise<void> {
  const cachePath = join(dir, ATLCLI_DIR, CACHE_DIR, `${pageId}.md`);
  try {
    await unlink(cachePath);
  } catch {
    // Ignore if file doesn't exist
  }
}

/**
 * Convert a page title to a clean filename (slug).
 */
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // Replace non-alphanumeric with dash
    .replace(/^-+|-+$/g, "") // Trim leading/trailing dashes
    .substring(0, 100); // Limit length
}

/**
 * Generate a unique filename in a directory.
 * If the base name exists, appends -2, -3, etc.
 */
export function generateUniqueFilename(
  dir: string,
  baseName: string,
  existingPaths: Set<string>
): string {
  let candidate = `${baseName}.md`;
  let counter = 2;

  while (existingPaths.has(candidate) || existsSync(join(dir, candidate))) {
    candidate = `${baseName}-${counter}.md`;
    counter++;
  }

  return candidate;
}

/**
 * Get relative path from root directory.
 */
export function getRelativePath(rootDir: string, filePath: string): string {
  return relative(rootDir, filePath);
}

// ============ Attachment State Functions ============

/**
 * Update attachment state for a page.
 */
export function updateAttachmentState(
  state: AtlcliState,
  pageId: string,
  attachmentId: string,
  update: Partial<AttachmentState>
): void {
  const page = state.pages[pageId];
  if (!page) return;

  if (!page.attachments) {
    page.attachments = {};
  }

  page.attachments[attachmentId] = {
    ...page.attachments[attachmentId],
    ...update,
  } as AttachmentState;

  page.hasAttachments = Object.keys(page.attachments).length > 0;
}

/**
 * Remove attachment from state.
 */
export function removeAttachmentState(
  state: AtlcliState,
  pageId: string,
  attachmentId: string
): void {
  const page = state.pages[pageId];
  if (!page?.attachments) return;

  delete page.attachments[attachmentId];
  page.hasAttachments = Object.keys(page.attachments).length > 0;
}

/**
 * Get attachment state by ID.
 */
export function getAttachmentById(
  state: AtlcliState,
  pageId: string,
  attachmentId: string
): AttachmentState | null {
  return state.pages[pageId]?.attachments?.[attachmentId] ?? null;
}

/**
 * Get all attachments for a page.
 */
export function getPageAttachments(
  state: AtlcliState,
  pageId: string
): AttachmentState[] {
  const attachments = state.pages[pageId]?.attachments;
  return attachments ? Object.values(attachments) : [];
}

/**
 * Compute sync state for an attachment based on hashes.
 * Works the same as page sync state computation.
 */
export function computeAttachmentSyncState(
  localHash: string | null,
  remoteHash: string | null,
  baseHash: string
): SyncState {
  // Handle deletion cases
  if (localHash === null && remoteHash === null) {
    return "synced"; // Both deleted
  }
  if (localHash === null) {
    return "remote-modified"; // Deleted locally, exists remotely
  }
  if (remoteHash === null) {
    return "local-modified"; // Deleted remotely, exists locally
  }

  // Normal comparison (same as page sync state)
  return computeSyncState(localHash, remoteHash, baseHash);
}

// ============ Attachment Cache Functions ============

const ATTACHMENTS_CACHE_DIR = "attachments";

/**
 * Read attachment base content from cache.
 */
export async function readAttachmentBase(
  dir: string,
  pageId: string,
  attachmentId: string,
  extension: string
): Promise<Buffer | null> {
  const cachePath = join(
    dir,
    ATLCLI_DIR,
    CACHE_DIR,
    ATTACHMENTS_CACHE_DIR,
    pageId,
    `${attachmentId}${extension}`
  );
  try {
    return await readFile(cachePath);
  } catch {
    return null;
  }
}

/**
 * Write attachment base content to cache.
 */
export async function writeAttachmentBase(
  dir: string,
  pageId: string,
  attachmentId: string,
  extension: string,
  content: Buffer
): Promise<void> {
  const cacheDir = join(
    dir,
    ATLCLI_DIR,
    CACHE_DIR,
    ATTACHMENTS_CACHE_DIR,
    pageId
  );
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(cacheDir, `${attachmentId}${extension}`), content);
}

/**
 * Delete attachment base content from cache.
 */
export async function deleteAttachmentBase(
  dir: string,
  pageId: string,
  attachmentId: string,
  extension: string
): Promise<void> {
  const cachePath = join(
    dir,
    ATLCLI_DIR,
    CACHE_DIR,
    ATTACHMENTS_CACHE_DIR,
    pageId,
    `${attachmentId}${extension}`
  );
  try {
    await unlink(cachePath);
  } catch {
    // Ignore if file doesn't exist
  }
}

/**
 * Get the attachments directory name for a page file.
 * For "page.md", returns "page.attachments"
 */
export function getAttachmentsDirName(pageFilename: string): string {
  const baseName = pageFilename.replace(/\.md$/, "");
  return `${baseName}.attachments`;
}

/**
 * Compute the attachments directory path for a page.
 */
export function getAttachmentsDir(pageDir: string, pageFilename: string): string {
  return join(pageDir, getAttachmentsDirName(pageFilename));
}
