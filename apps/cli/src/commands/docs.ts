import { readdir, writeFile, readFile, mkdir, stat, unlink, rename, rm } from "node:fs/promises";
import { FSWatcher, watch, existsSync } from "node:fs";
import { join, basename, extname, dirname, relative, resolve } from "node:path";
import {
  ERROR_CODES,
  OutputOptions,
  ensureDir,
  fail,
  getActiveProfile,
  getFlag,
  getLogger,
  hasFlag,
  loadConfig,
  output,
  readTextFile,
  resolveDefaults,
  slugify,
  writeTextFile,
  // New template system
  GlobalTemplateStorage,
  ProfileTemplateStorage,
  SpaceTemplateStorage,
  TemplateResolver,
  TemplateEngine,
} from "@atlcli/core";
import {
  ConfluenceClient,
  type ConfluenceFolder,
  type ConversionOptions,
  hashContent,
  markdownToStorage,
  normalizeMarkdown,
  resolveConflicts,
  storageToMarkdown,
  replaceAttachmentPaths,
  extractAttachmentRefs,
  isImageFile,
  // Local storage
  findAtlcliDir,
  getAtlcliPath,
  initAtlcliDir,
  isInitialized,
  readConfig,
  readState,
  writeState,
  updatePageState,
  getPageByPath,
  getPageById,
  computeSyncState as computeSyncStateFromHashes,
  readBaseContent,
  writeBaseContent,
  slugifyTitle,
  generateUniqueFilename,
  getRelativePath,
  AtlcliConfig,
  AtlcliState,
  PageState,
  SyncState as CoreSyncState,
  // Attachments
  getAttachmentsDirName,
  updateAttachmentState,
  removeAttachmentState,
  getPageAttachments,
  writeAttachmentBase,
  deleteAttachmentBase,
  computeAttachmentSyncState,
  AttachmentState,
  AttachmentInfo,
  LARGE_FILE_THRESHOLD,
  formatFileSize,
  generateConflictFilename,
  // Frontmatter
  parseFrontmatter,
  addFrontmatter,
  stripFrontmatter,
  extractTitleFromMarkdown,
  AtlcliFrontmatter,
  // Hierarchy
  computeFilePath,
  buildPathMap,
  moveFile,
  hasPageMoved,
  PageHierarchyInfo,
  // Index pattern migration
  detectSiblingPatternMigrations,
  migrateSiblingToIndex,
  // Scope
  parseScope,
  buildCqlFromScope,
  scopeToString,
  SyncScope,
  // Config v2
  initAtlcliDirV2,
  getConfigScope,
  isConfigV2,
  ConfigScope,
  // Diff
  generateDiff,
  formatDiffWithColors,
  formatDiffSummary,
  // Ignore
  loadIgnorePatterns,
  shouldIgnore,
  IgnoreResult,
  // Comments
  getCommentsFilePath,
  writeCommentsFile,
  PageComments,
  // Validation
  validateFile,
  validateDirectory,
  validateFolders,
  formatValidationReport,
  ValidationResult,
  // Link storage
  storePageLinksBatch,
  // Link change detection
  detectLinkChangesBatch,
  type LinkChangeResult,
  // User and contributor handling
  checkUsersFromPull,
  createContributorRecords,
  fetchAllContributorsForPages,
  type UserCheckOptions,
  // Sync database
  createSyncDb,
  hasSyncDb,
  createPageRecord,
  // Editor version tracking
  setPageEditorVersion,
  getAllEditorVersions,
  type EditorVersion,
} from "@atlcli/confluence";
import type { Ignore } from "@atlcli/confluence";
import { handleSync, syncHelp } from "./sync.js";

/** Sync state for bidirectional sync tracking */
export type SyncState = "synced" | "local-modified" | "remote-modified" | "conflict";

/** Enhanced metadata structure for bidirectional sync */
export interface EnhancedMeta {
  id: string;
  title: string;
  spaceKey: string;
  version: number;
  lastSyncedAt: string;
  localHash: string;
  remoteHash: string;
  baseHash: string;
  syncState: SyncState;
}

/** Legacy metadata structure for backwards compatibility */
interface LegacyMeta {
  id?: string;
  title?: string;
  spaceKey?: string;
  version?: number;
}

/**
 * Format a date as a human-readable time ago string.
 * Used for user cache age display.
 */
function formatTimeAgo(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMinutes = Math.floor(diffMs / (1000 * 60));

  if (diffDays > 0) {
    return diffDays === 1 ? "1 day ago" : `${diffDays} days ago`;
  } else if (diffHours > 0) {
    return diffHours === 1 ? "1 hour ago" : `${diffHours} hours ago`;
  } else if (diffMinutes > 0) {
    return diffMinutes === 1 ? "1 minute ago" : `${diffMinutes} minutes ago`;
  } else {
    return "just now";
  }
}

/**
 * Check if a path is inside the atlcli source tree.
 * Used to warn about stale test data that might interfere with operations.
 */
function isInsideAtlcliSourceTree(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  // Check for common atlcli source tree patterns
  return (
    normalized.includes("/atlcli/apps/") ||
    normalized.includes("/atlcli/packages/") ||
    // Also catch the root if someone puts .atlcli directly in the project
    /\/atlcli\/?$/.test(normalized)
  );
}

/**
 * Find .atlcli directory with warning for source tree pollution.
 * Wraps findAtlcliDir to warn when .atlcli is found inside atlcli source tree.
 */
function findAtlcliDirWithWarning(
  startPath: string,
  opts: OutputOptions
): string | null {
  const atlcliDir = findAtlcliDir(startPath);
  if (atlcliDir && isInsideAtlcliSourceTree(atlcliDir) && !opts.json) {
    output(`Warning: Found .atlcli inside atlcli source tree: ${atlcliDir}`, opts);
    output(`This may be stale test data. Consider removing it or specifying an explicit path.`, opts);
  }
  return atlcliDir;
}

export async function handleDocs(args: string[], flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  // Show help if --help or -h flag is set
  if (hasFlag(flags, "help") || hasFlag(flags, "h")) {
    output(docsHelp(), opts);
    return;
  }

  const sub = args[0];
  switch (sub) {
    case "init":
      await handleInit(args.slice(1), flags, opts);
      return;
    case "pull":
      await handlePull(args.slice(1), flags, opts);
      return;
    case "push":
      await handlePush(args.slice(1), flags, opts);
      return;
    case "add":
      await handleAdd(args.slice(1), flags, opts);
      return;
    case "watch":
      await handleWatch(args.slice(1), flags, opts);
      return;
    case "sync":
      await handleSync(args.slice(1), flags, opts);
      return;
    case "status":
      await handleStatus(args.slice(1), flags, opts);
      return;
    case "resolve":
      await handleResolve(args.slice(1), flags, opts);
      return;
    case "diff":
      await handleDocsDiff(args.slice(1), flags, opts);
      return;
    case "check":
      await handleCheck(args.slice(1), flags, opts);
      return;
    case "convert":
      await handleDocsConvert(args.slice(1), flags, opts);
      return;
    default:
      output(docsHelp(), opts);
      return;
  }
}

type ClientWithDefaults = {
  client: ConfluenceClient;
  defaults: { project?: string; space?: string; board?: number };
};

async function getClient(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<ConfluenceClient>;
async function getClient(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
  withDefaults: true
): Promise<ClientWithDefaults>;
async function getClient(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
  withDefaults?: boolean
): Promise<ConfluenceClient | ClientWithDefaults> {
  const config = await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(config, profileName);
  if (!profile) {
    fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.", { profile: profileName });
  }
  const client = new ConfluenceClient(profile);
  if (withDefaults) {
    return { client, defaults: resolveDefaults(config, profile) };
  }
  return client;
}

/** Build ConversionOptions from profile baseUrl */
function buildConversionOptions(baseUrl?: string): ConversionOptions {
  return {
    baseUrl,
    emitWarnings: true,
    onWarning: (msg) => console.warn(msg),
  };
}

/**
 * Initialize a directory for Confluence sync.
 * Creates .atlcli/ with config.json, state.json, and cache/ directory.
 */
async function handleInit(args: string[], flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const dir = args[0] || ".";

  if (isInitialized(dir)) {
    fail(opts, 1, ERROR_CODES.USAGE, `Directory already initialized: ${dir}/.atlcli/`);
  }

  // Get profile info for baseUrl
  const appConfig = await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(appConfig, profileName);
  if (!profile) {
    fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.", { profile: profileName });
  }

  // Parse scope from flags
  const parsedScope = parseScope(flags);
  let scope: ConfigScope;
  let space: string | undefined = getFlag(flags, "space") ?? appConfig.defaults?.space;

  if (parsedScope) {
    // Convert SyncScope to ConfigScope
    switch (parsedScope.scope.type) {
      case "page":
        scope = { type: "page", pageId: parsedScope.scope.pageId };
        break;
      case "tree":
        scope = { type: "tree", ancestorId: parsedScope.scope.ancestorId };
        break;
      case "space":
        scope = { type: "space" };
        space = parsedScope.scope.spaceKey;
        break;
    }
  } else if (space) {
    // Only --space provided (or default)
    scope = { type: "space" };
  } else {
    fail(opts, 1, ERROR_CODES.USAGE, "--space, --page-id, or --ancestor is required (or set defaults.space in config).");
  }

  // Auto-detect space from page/ancestor if not provided
  if (!space && (scope.type === "page" || scope.type === "tree")) {
    const client = await getClient(flags, opts);
    const pageId = scope.type === "page" ? scope.pageId : scope.ancestorId;
    const pageInfo = await client.getPage(pageId);
    space = pageInfo.spaceKey;
    if (!opts.json) {
      output(`Auto-detected space: ${space}`, opts);
    }
  }

  if (!space) {
    fail(opts, 1, ERROR_CODES.USAGE, "Could not determine space. Specify --space explicitly.");
  }

  await ensureDir(dir);
  await initAtlcliDirV2(dir, {
    scope,
    space,
    baseUrl: profile.baseUrl,
    profile: profile.name,
    settings: {
      autoCreatePages: false,
      preserveHierarchy: true,
      defaultParentId: null,
    },
  });

  // Build scope description for output
  let scopeDesc: string;
  switch (scope.type) {
    case "page":
      scopeDesc = `page ${scope.pageId}`;
      break;
    case "tree":
      scopeDesc = `tree under ${scope.ancestorId}`;
      break;
    case "space":
      scopeDesc = `space ${space}`;
      break;
  }

  output(
    opts.json
      ? { schemaVersion: "2", initialized: true, dir, scope, space }
      : `Initialized ${dir}/.atlcli/ for ${scopeDesc}`,
    opts
  );
}

async function handlePull(args: string[], flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const outDirArg = args[0] || getFlag(flags, "out") || ".";
  const outDir = resolve(outDirArg); // Resolve to absolute path
  const limit = Number(getFlag(flags, "limit") ?? 50);
  const force = hasFlag(flags, "force");
  const labelFilter = getFlag(flags, "label");

  // Phase 2: User and contributor flags
  const skipUserCheck = hasFlag(flags, "skip-user-check");
  const refreshUsers = hasFlag(flags, "refresh-users");
  const fetchContributors = hasFlag(flags, "fetch-contributors");

  // Check if directory is initialized
  let atlcliDir = findAtlcliDirWithWarning(outDir, opts);
  let dirConfig: AtlcliConfig | null = null;

  if (atlcliDir) {
    dirConfig = await readConfig(atlcliDir);
  }

  // Parse scope from flags
  const parsedScope = parseScope(flags);
  let scope: SyncScope;
  let space: string | undefined;

  if (parsedScope) {
    scope = parsedScope.scope;
    space = parsedScope.spaceKey;
  } else if (dirConfig) {
    // Use scope from config
    const configScope = getConfigScope(dirConfig);
    space = dirConfig.space;

    // Convert ConfigScope to SyncScope
    switch (configScope.type) {
      case "page":
        scope = { type: "page", pageId: configScope.pageId };
        break;
      case "tree":
        scope = { type: "tree", ancestorId: configScope.ancestorId };
        break;
      case "space":
        scope = { type: "space", spaceKey: space };
        break;
    }
  } else {
    fail(opts, 1, ERROR_CODES.USAGE, "--space, --page-id, or --ancestor is required (or run 'docs init' first).");
  }

  const client = await getClient(flags, opts);

  // For single page or tree scope without space, auto-detect space from page
  if (!space && (scope.type === "page" || scope.type === "tree")) {
    const pageId = scope.type === "page" ? scope.pageId : scope.ancestorId;
    const pageInfo = await client.getPage(pageId);
    space = pageInfo.spaceKey;
    if (!opts.json) {
      output(`Auto-detected space: ${space}`, opts);
    }
  }

  // Fetch pages based on scope
  let pages: { id: string; title: string }[];
  let cql = buildCqlFromScope(scope);

  // Add label filter if specified
  if (labelFilter) {
    if (cql) {
      cql += ` AND label = "${labelFilter}"`;
    } else if (scope.type === "page") {
      // For single page with label filter, we'll check after fetch
      // and skip if page doesn't have the label
    }
  }

  if (cql) {
    // Tree or space scope: use CQL search
    pages = await client.searchPages(cql, Number.isNaN(limit) ? 50 : limit);
  } else {
    // Single page scope: direct fetch
    const pageId = (scope as { type: "page"; pageId: string }).pageId;
    const page = await client.getPage(pageId);

    // If label filter is specified for single page, verify it has the label
    if (labelFilter) {
      const labels = await client.getLabels(pageId);
      if (!labels.some((l) => l.name === labelFilter)) {
        if (!opts.json) {
          output(`Page ${page.title} does not have label "${labelFilter}", skipping.`, opts);
        }
        output({
          schemaVersion: "1",
          results: { pulled: 0, skipped: 1, moved: 0, outDir, attachments: 0 },
          note: `Page does not have label "${labelFilter}".`,
        }, opts);
        return;
      }
    }

    pages = [{ id: page.id, title: page.title }];
  }

  if (!opts.json) {
    output(`Pulling ${pages.length} page(s) from ${scopeToString(scope)}...`, opts);
  }

  // If not initialized, auto-init
  if (!atlcliDir && space) {
    const appConfig = await loadConfig();
    const profileName = getFlag(flags, "profile");
    const profile = getActiveProfile(appConfig, profileName);
    if (profile) {
      await ensureDir(outDir);
      await initAtlcliDir(outDir, {
        space,
        baseUrl: profile.baseUrl,
        profile: profile.name,
      });
      atlcliDir = outDir;
    }
  }

  await ensureDir(outDir);
  const state = atlcliDir ? await readState(atlcliDir) : null;
  const existingPaths = state ? new Set(Object.keys(state.pathIndex)) : new Set<string>();

  // Fetch full page details with ancestors
  const pageDetails: Array<{
    id: string;
    title: string;
    storage: string;
    version: number;
    spaceKey: string;
    parentId: string | null;
    ancestors: { id: string; title: string }[];
    createdBy?: { accountId?: string; displayName?: string };
    modifiedBy?: { accountId?: string; displayName?: string };
    created?: string;
    modified?: string;
    editorVersion?: "v2" | "v1" | null;
  }> = [];

  const totalPages = pages.length;
  const progressInterval = Math.max(1, Math.floor(totalPages / 10)); // Log every 10%

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];

    // Log progress every 10% (or every page if small set)
    if (!opts.json && totalPages > 10 && (i + 1) % progressInterval === 0) {
      output(`Fetching page details... ${i + 1}/${totalPages}`, opts);
    }

    // Use getPageDetails to include user information for Phase 2
    try {
      const detail = await client.getPageDetails(page.id);
      pageDetails.push({
        id: detail.id,
        title: detail.title,
        storage: detail.storage,
        version: detail.version ?? 1,
        spaceKey: detail.spaceKey ?? space!,
        parentId: detail.parentId ?? null,
        ancestors: detail.ancestors ?? [],
        createdBy: detail.createdBy,
        modifiedBy: detail.modifiedBy,
        created: detail.created,
        modified: detail.modified,
        editorVersion: detail.editorVersion,
      });
    } catch (err) {
      // Skip pages that are inaccessible (404 = deleted/trashed/no permission)
      const is404 = err instanceof Error && err.message.includes("404");
      if (is404) {
        if (!opts.json) {
          output(`Skipping inaccessible page ${page.id} (may be deleted or moved to trash)`, opts);
        }
        continue;
      }
      throw err; // Re-throw other errors
    }
  }

  // Detect and fetch folders (Confluence Cloud feature)
  // Folders are detected by checking if page parents are not in the page set
  let folders: ConfluenceFolder[] = [];
  const pageIdSet = new Set(pageDetails.map((p) => p.id));
  const potentialFolderIds = new Set<string>();

  // Collect parent IDs that might be folders (not in page set)
  for (const page of pageDetails) {
    if (page.parentId && !pageIdSet.has(page.parentId)) {
      potentialFolderIds.add(page.parentId);
    }
    // Also check ancestors
    for (const ancestor of page.ancestors) {
      if (!pageIdSet.has(ancestor.id)) {
        potentialFolderIds.add(ancestor.id);
      }
    }
  }

  // Fetch folder details for potential folder IDs
  if (potentialFolderIds.size > 0) {
    for (const folderId of potentialFolderIds) {
      try {
        const folder = await client.getFolder(folderId);
        folders.push(folder);
      } catch {
        // Not a folder or not accessible - skip
      }
    }
  }

  // Also check for folder children of pages (empty folders wouldn't be detected above)
  // This catches folders nested under pages that have no page children yet
  // Performance optimization: Only scan if < 100 pages to avoid N+1 queries
  const folderIdSet = new Set(folders.map((f) => f.id));
  const EMPTY_FOLDER_SCAN_THRESHOLD = 100;

  if (pageDetails.length < EMPTY_FOLDER_SCAN_THRESHOLD) {
    for (const page of pageDetails) {
      try {
        const children = await client.getPageDirectChildren(page.id);
        for (const child of children) {
          if (child.type === "folder" && !folderIdSet.has(child.id)) {
            // Found a folder child - fetch full details
            try {
              const folder = await client.getFolder(child.id);
              folders.push(folder);
              folderIdSet.add(folder.id);
            } catch {
              // Skip if can't fetch folder details
            }
          }
        }
      } catch {
        // Skip if can't fetch children (might be permission issue)
      }
    }
  }

  // Also check for nested folders (folder inside folder)
  // Recursively check folder children until no new folders found
  let foldersToCheck = [...folders];
  while (foldersToCheck.length > 0) {
    const newFolders: ConfluenceFolder[] = [];
    for (const folder of foldersToCheck) {
      try {
        const children = await client.getFolderChildren(folder.id);
        for (const child of children) {
          if (child.type === "folder" && !folderIdSet.has(child.id)) {
            try {
              const nestedFolder = await client.getFolder(child.id);
              folders.push(nestedFolder);
              folderIdSet.add(nestedFolder.id);
              newFolders.push(nestedFolder);
            } catch {
              // Skip if can't fetch folder details
            }
          }
        }
      } catch {
        // Skip if can't fetch children
      }
    }
    foldersToCheck = newFolders; // Continue with newly found folders
  }

  if (folders.length > 0 && !opts.json) {
    output(`Found ${folders.length} folder(s) in hierarchy`, opts);
  }

  // Build set of parent IDs to determine which items have children
  const parentIds = new Set<string>();
  for (const page of pageDetails) {
    if (page.parentId) {
      parentIds.add(page.parentId);
    }
  }
  for (const folder of folders) {
    if (folder.parentId) {
      parentIds.add(folder.parentId);
    }
  }

  // Build maps for ancestor lookup
  const pageAncestorsMap = new Map<string, string[]>();
  for (const page of pageDetails) {
    pageAncestorsMap.set(page.id, page.ancestors.map((a) => a.id));
  }
  const folderMap = new Map<string, ConfluenceFolder>();
  for (const folder of folders) {
    folderMap.set(folder.id, folder);
  }

  // Compute ancestors for folders based on their parent (recursive for nested folders)
  const computeFolderAncestors = (folder: ConfluenceFolder, visited = new Set<string>()): string[] => {
    if (!folder.parentId) return [];

    // Prevent infinite loops
    if (visited.has(folder.id)) return [];
    visited.add(folder.id);

    // If parent is a page, use its ancestors + parent ID
    const parentPageAncestors = pageAncestorsMap.get(folder.parentId);
    if (parentPageAncestors) {
      return [...parentPageAncestors, folder.parentId];
    }

    // If parent is a folder, recursively get its ancestors
    const parentFolder = folderMap.get(folder.parentId);
    if (parentFolder) {
      return [...computeFolderAncestors(parentFolder, visited), folder.parentId];
    }

    // Unknown parent (possibly space root or not fetched)
    return [folder.parentId];
  };

  // Build hierarchy info for path computation
  // Include both pages and folders
  const hierarchyPages: PageHierarchyInfo[] = [
    // Pages
    ...pageDetails.map((p) => ({
      id: p.id,
      title: p.title,
      parentId: p.parentId,
      ancestors: p.ancestors.map((a) => a.id),
      contentType: "page" as const,
      hasChildren: parentIds.has(p.id),
    })),
    // Folders (always have hasChildren behavior for index.md pattern)
    ...folders.map((f) => ({
      id: f.id,
      title: f.title,
      parentId: f.parentId,
      ancestors: computeFolderAncestors(f),
      contentType: "folder" as const,
      hasChildren: true, // Folders always use index.md pattern
    })),
  ];

  // Build ancestor title map (include all ancestors)
  const ancestorTitles = new Map<string, string>();
  for (const page of pageDetails) {
    ancestorTitles.set(page.id, page.title);
    for (const ancestor of page.ancestors) {
      ancestorTitles.set(ancestor.id, ancestor.title);
    }
  }
  for (const folder of folders) {
    ancestorTitles.set(folder.id, folder.title);
  }

  // Detect space home page for flattening hierarchy
  // When syncing a space, find the root page (the one with no ancestors)
  let homePageId: string | undefined;
  if (scope.type === "space" && pageDetails.length > 0) {
    const homePage = pageDetails.find((p) => !p.parentId && p.ancestors.length === 0);
    if (homePage) {
      homePageId = homePage.id;
      if (!opts.json) {
        output(`Using "${homePage.title}" as space home page (children will be at root level)`, opts);
      }
    }
  }

  // Run sibling-to-index pattern migration if needed
  // This converts existing `page.md` + `page/` to `page/index.md`
  // IMPORTANT: Scan actual file system, not stored paths (they may be out of sync)
  if (atlcliDir) {
    // Scan actual .md files on disk
    const actualFilePaths = new Set<string>();
    const scanDir = async (dir: string, prefix: string = "") => {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith(".")) continue; // Skip hidden files/dirs
          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            await scanDir(join(dir, entry.name), relativePath);
          } else if (entry.name.endsWith(".md")) {
            actualFilePaths.add(relativePath);
          }
        }
      } catch {
        // Ignore errors (directory may not exist)
      }
    };
    await scanDir(outDir);

    if (actualFilePaths.size > 0) {
      const migrations = detectSiblingPatternMigrations(actualFilePaths);
      if (migrations.length > 0) {
        if (!opts.json) {
          output(`Migrating ${migrations.length} file(s) to index pattern...`, opts);
        }
        for (const { oldPath, newPath } of migrations) {
          try {
            await migrateSiblingToIndex(outDir, oldPath);
            // Update existingPaths set (for path computation)
            existingPaths.delete(oldPath);
            existingPaths.add(newPath);
            // Update state if we have it
            if (state) {
              // Find the page ID for this path
              const pageId = state.pathIndex[oldPath];
              if (pageId && state.pages[pageId]) {
                state.pages[pageId].path = newPath;
                delete state.pathIndex[oldPath];
                state.pathIndex[newPath] = pageId;
              }
            }
            if (!opts.json) {
              output(`  Migrated: ${oldPath} → ${newPath}`, opts);
            }
          } catch (err) {
            if (!opts.json) {
              output(`  Warning: Could not migrate ${oldPath}: ${err}`, opts);
            }
          }
        }
      }
    }
  }

  // Compute nested paths
  const pathMap = buildPathMap(hierarchyPages, {
    existingPaths,
    rootAncestorId: homePageId,
  });

  let pulled = 0;
  let skipped = 0;
  let moved = 0;

  // Check if attachments are enabled (default: true)
  const pullAttachments = !hasFlag(flags, "no-attachments");
  let attachmentsPulled = 0;

  // Check if comments should be pulled
  const pullComments = hasFlag(flags, "comments");
  let commentsPulled = 0;

  // Build conversion options using baseUrl from dirConfig
  const conversionOptions = buildConversionOptions(dirConfig?.baseUrl);

  for (const detail of pageDetails) {
    // Convert storage to markdown, then apply page-specific attachment paths
    const rawMarkdown = storageToMarkdown(detail.storage, conversionOptions);
    const ancestorIds = detail.ancestors.map((a) => a.id);

    // Get computed path for this page
    const computed = pathMap.get(detail.id);
    if (!computed) {
      output(`Warning: Could not compute path for page ${detail.id}`, opts);
      skipped++;
      continue;
    }

    // Check if we already have this page
    const existingState = state?.pages[detail.id];
    let relativePath = computed.relativePath;

    if (existingState) {
      // Check if page has moved in Confluence
      const oldAncestors = existingState.ancestors ?? [];
      if (hasPageMoved(oldAncestors, ancestorIds)) {
        // Page has moved - move the local file
        if (atlcliDir) {
          try {
            await moveFile(atlcliDir, existingState.path, relativePath);
            if (!opts.json) {
              output(`Moved ${existingState.path} -> ${relativePath}`, opts);
            }
            moved++;
            getLogger().sync({
              eventType: "status",
              file: relativePath,
              pageId: detail.id,
              title: `Moved from ${existingState.path}`,
              details: { oldPath: existingState.path, newPath: relativePath },
            });
          } catch (err) {
            // File might not exist, just use new path
          }
        }
      } else {
        // Keep existing path if not moved
        relativePath = existingState.path;
      }

      // Check if local has modifications
      if (!force) {
        const localPath = join(atlcliDir!, relativePath);
        try {
          const localContent = await readTextFile(localPath);
          const { content: localWithoutFrontmatter } = parseFrontmatter(localContent);
          const localHash = hashContent(normalizeMarkdown(localWithoutFrontmatter));

          if (localHash !== existingState.baseHash) {
            // Local has modifications, skip unless --force
            output(`Skipping ${relativePath} (local modifications, use --force)`, opts);
            skipped++;
            getLogger().sync({
              eventType: "status",
              file: relativePath,
              pageId: detail.id,
              title: `Skipped: local modifications`,
            });
            continue;
          }
        } catch {
          // File doesn't exist, will be re-created
        }
      }
    }

    const filePath = join(outDir, relativePath);
    const pageFilename = basename(relativePath);
    const pageDir = dirname(filePath);

    // Fetch and download attachments if enabled
    let attachments: AttachmentInfo[] = [];
    if (pullAttachments) {
      try {
        attachments = await client.listAttachments(detail.id);
      } catch (err) {
        // Log warning but don't fail the pull
        if (!opts.json) {
          output(`Warning: Could not fetch attachments for ${relativePath}`, opts);
        }
      }

      if (attachments.length > 0) {
        // Create attachments directory
        const attachmentsDir = join(pageDir, getAttachmentsDirName(pageFilename));
        await mkdir(attachmentsDir, { recursive: true });

        for (const attachment of attachments) {
          // Skip attachments with empty or invalid filenames
          if (!attachment.filename) {
            continue;
          }

          // Warn about large files
          if (attachment.fileSize >= LARGE_FILE_THRESHOLD && !opts.json) {
            output(`Warning: Large attachment ${attachment.filename} (${formatFileSize(attachment.fileSize)})`, opts);
          }

          try {
            const data = await client.downloadAttachment(attachment);
            const attachmentPath = join(attachmentsDir, attachment.filename);
            const remoteHash = hashContent(data.toString("base64"));

            // Check for conflict with local changes
            const existingAttState = state?.pages[detail.id]?.attachments?.[attachment.id];
            if (existingAttState && existsSync(attachmentPath)) {
              // Read local file to get current hash
              const localData = await readFile(attachmentPath);
              const localHash = hashContent(localData.toString("base64"));

              const syncState = computeAttachmentSyncState(
                localHash,
                remoteHash,
                existingAttState.baseHash
              );

              if (syncState === "conflict") {
                // Both local and remote changed - save remote as conflict file
                const conflictFilename = generateConflictFilename(attachment.filename);
                const conflictPath = join(attachmentsDir, conflictFilename);
                await writeFile(conflictPath, data);

                if (!opts.json) {
                  output(`Conflict: ${attachment.filename} - saved remote as ${conflictFilename}`, opts);
                }

                // Update state to mark as conflict
                if (state) {
                  updateAttachmentState(state, detail.id, attachment.id, {
                    remoteHash,
                    syncState: "conflict",
                    lastSyncedAt: new Date().toISOString(),
                  });
                }
                continue; // Don't overwrite local file
              }
            }

            // No conflict - write normally
            await writeFile(attachmentPath, data);
            attachmentsPulled++;
          } catch (err) {
            if (!opts.json) {
              output(`Warning: Could not download attachment ${attachment.filename}`, opts);
            }
          }
        }

        // Check for deleted attachments (were in state but not in remote list)
        const existingState = state?.pages[detail.id];
        if (state && existingState?.attachments && atlcliDir) {
          const remoteFilenames = new Set(attachments.map((a) => a.filename));

          for (const [attId, attState] of Object.entries(existingState.attachments)) {
            if (!remoteFilenames.has(attState.filename)) {
              // Attachment was deleted in Confluence - delete local file
              const localAttPath = join(attachmentsDir, attState.filename);
              try {
                await unlink(localAttPath);
                removeAttachmentState(state, detail.id, attId);
                await deleteAttachmentBase(atlcliDir, detail.id, attId, extname(attState.filename));
                if (!opts.json) {
                  output(`Deleted ${attState.filename} (removed from Confluence)`, opts);
                }
              } catch {
                // File may not exist, continue
              }
            }
          }
        }
      }
    }

    // Apply page-specific attachment paths to markdown
    const markdown = replaceAttachmentPaths(rawMarkdown, pageFilename);
    const normalizedMd = normalizeMarkdown(markdown);
    const contentHash = hashContent(normalizedMd);

    // Add frontmatter with page ID
    const frontmatter: AtlcliFrontmatter = {
      id: detail.id,
      title: detail.title,
    };
    const contentWithFrontmatter = addFrontmatter(markdown, frontmatter);

    await ensureDir(pageDir);
    await writeTextFile(filePath, contentWithFrontmatter);

    // Update state and cache
    if (state && atlcliDir) {
      updatePageState(state, detail.id, {
        path: relativePath,
        title: detail.title,
        spaceKey: detail.spaceKey,
        version: detail.version,
        lastSyncedAt: new Date().toISOString(),
        localHash: contentHash,
        remoteHash: contentHash,
        baseHash: contentHash,
        syncState: "synced",
        parentId: detail.parentId,
        ancestors: ancestorIds,
        hasAttachments: attachments.length > 0,
      });

      // Update attachment state
      for (const attachment of attachments) {
        try {
          const attachmentPath = join(pageDir, getAttachmentsDirName(pageFilename), attachment.filename);
          const attachmentData = await readFile(attachmentPath);
          const attachmentHash = hashContent(attachmentData.toString("base64"));

          updateAttachmentState(state, detail.id, attachment.id, {
            attachmentId: attachment.id,
            filename: attachment.filename,
            localPath: join(getAttachmentsDirName(pageFilename), attachment.filename),
            mediaType: attachment.mediaType,
            fileSize: attachment.fileSize,
            version: attachment.version,
            localHash: attachmentHash,
            remoteHash: attachmentHash,
            baseHash: attachmentHash,
            lastSyncedAt: new Date().toISOString(),
            syncState: "synced",
          });

          // Write base content for conflict detection
          await writeAttachmentBase(
            atlcliDir,
            detail.id,
            attachment.id,
            extname(attachment.filename),
            attachmentData
          );
        } catch (err) {
          // Attachment state update failed, continue
        }
      }

      // Write base content for 3-way merge (without frontmatter)
      await writeBaseContent(atlcliDir, detail.id, normalizedMd);
    }

    // Pull comments if enabled
    if (pullComments) {
      try {
        const comments = await client.getAllComments(detail.id);
        if (comments.footerComments.length > 0 || comments.inlineComments.length > 0) {
          const commentsPath = getCommentsFilePath(filePath);
          await writeCommentsFile(commentsPath, comments);
          commentsPulled++;
          if (!opts.json) {
            const total = comments.footerComments.length + comments.inlineComments.length;
            output(`  Saved ${total} comment(s) to ${basename(commentsPath)}`, opts);
          }
        }
      } catch (err) {
        // Log warning but don't fail the pull
        if (!opts.json) {
          output(`Warning: Could not fetch comments for ${relativePath}`, opts);
        }
      }
    }

    pulled++;

    // Log sync event
    getLogger().sync({
      eventType: "pull",
      file: relativePath,
      pageId: detail.id,
      title: detail.title,
    });
  }

  // Write folder index.md files
  let foldersPulled = 0;
  let foldersRenamed = 0;
  for (const folder of folders) {
    const computed = pathMap.get(folder.id);
    if (!computed) continue;

    const folderPath = join(outDir, computed.relativePath);
    const folderDir = dirname(folderPath);

    // Check if folder was renamed (title changed, not just path computation difference)
    const existingFolderState = state?.pages[folder.id];
    const titleChanged = existingFolderState && existingFolderState.title !== folder.title;

    // Determine the path to use:
    // - If title changed and computed path differs: use computed path (rename)
    // - If folder exists and title unchanged: preserve existing path
    // - Otherwise: use computed path (new folder)
    let folderRelativePath = computed.relativePath;

    if (titleChanged && existingFolderState.path !== computed.relativePath) {
      // Folder title changed - move entire directory to new slug
      const oldFolderDir = dirname(join(outDir, existingFolderState.path));
      const newFolderDir = folderDir;

      if (existsSync(oldFolderDir) && oldFolderDir !== newFolderDir) {
        try {
          // Ensure parent of new location exists
          await ensureDir(dirname(newFolderDir));
          // Move entire folder directory
          await rename(oldFolderDir, newFolderDir);
          if (!opts.json) {
            output(`Renamed folder: ${dirname(existingFolderState.path)} → ${dirname(computed.relativePath)}`, opts);
          }
          foldersRenamed++;

          // Update paths for all child pages in state
          if (state) {
            const oldDirPrefix = dirname(existingFolderState.path) + "/";
            const newDirPrefix = dirname(computed.relativePath) + "/";
            for (const pageId of Object.keys(state.pages)) {
              const pageState = state.pages[pageId];
              if (pageState.path.startsWith(oldDirPrefix)) {
                const newPath = newDirPrefix + pageState.path.slice(oldDirPrefix.length);
                delete state.pathIndex[pageState.path];
                pageState.path = newPath;
                state.pathIndex[newPath] = pageId;
              }
            }
          }
        } catch (err) {
          if (!opts.json) {
            output(`Warning: Could not rename folder directory: ${err}`, opts);
          }
        }
      }
    } else if (existingFolderState && !titleChanged) {
      // Folder exists and title unchanged - preserve existing path
      folderRelativePath = existingFolderState.path;
    }

    // Recompute folderPath and folderDir based on final path
    const finalFolderPath = join(outDir, folderRelativePath);
    const finalFolderDir = dirname(finalFolderPath);

    // Create folder frontmatter (type: folder indicates no content body)
    const folderFrontmatter: AtlcliFrontmatter = {
      id: folder.id,
      title: folder.title,
      type: "folder",
    };

    // Folder index.md has only frontmatter, no content body
    const folderContent = addFrontmatter("", folderFrontmatter);

    await ensureDir(finalFolderDir);
    await writeTextFile(finalFolderPath, folderContent);

    // Update state for folder
    if (state && atlcliDir) {
      updatePageState(state, folder.id, {
        path: folderRelativePath,
        title: folder.title,
        spaceKey: space!,
        version: 1,
        lastSyncedAt: new Date().toISOString(),
        localHash: hashContent(""),
        remoteHash: hashContent(""),
        baseHash: hashContent(""),
        syncState: "synced",
        parentId: folder.parentId,
        ancestors: [],
        hasAttachments: false,
      });

      // Write empty base content for folder
      await writeBaseContent(atlcliDir, folder.id, "");
    }

    foldersPulled++;

    // Log sync event for folder
    getLogger().sync({
      eventType: "pull",
      file: folderRelativePath,
      pageId: folder.id,
      title: folder.title,
      details: { type: "folder" },
    });
  }

  // Save state
  if (state && atlcliDir) {
    state.lastSync = new Date().toISOString();
    await writeState(atlcliDir, state);

    // Extract and store links from all pulled pages (Phase 1 link graph population)
    // Uses batch operation for efficiency - only runs if sync.db exists
    const linksData = pageDetails.map((p) => ({ pageId: p.id, storage: p.storage }));
    await storePageLinksBatch(atlcliDir, linksData);

    // Phase 2: User and contributor handling
    // Open adapter once for all Phase 2 operations
    const { createSyncDb } = await import("@atlcli/confluence");
    const adapter = await createSyncDb(getAtlcliPath(atlcliDir), { autoMigrate: false });
    try {
      // Upsert all pages to sync.db (populates last_modified for stale detection)
      for (const detail of pageDetails) {
        const computed = pathMap.get(detail.id);
        if (!computed) continue;

        const pageRecord = createPageRecord({
          pageId: detail.id,
          path: computed.relativePath,
          title: detail.title,
          spaceKey: detail.spaceKey,
          version: detail.version,
          lastSyncedAt: new Date().toISOString(),
          localHash: hashContent(normalizeMarkdown(replaceAttachmentPaths(
            storageToMarkdown(detail.storage, buildConversionOptions(dirConfig?.baseUrl)),
            basename(computed.relativePath, ".md")
          ))),
          remoteHash: hashContent(normalizeMarkdown(replaceAttachmentPaths(
            storageToMarkdown(detail.storage, buildConversionOptions(dirConfig?.baseUrl)),
            basename(computed.relativePath, ".md")
          ))),
          baseHash: hashContent(normalizeMarkdown(replaceAttachmentPaths(
            storageToMarkdown(detail.storage, buildConversionOptions(dirConfig?.baseUrl)),
            basename(computed.relativePath, ".md")
          ))),
          syncState: "synced",
          parentId: detail.parentId,
          ancestors: detail.ancestors.map((a) => a.id),
          hasAttachments: false, // Updated later if attachments exist
          createdBy: detail.createdBy?.accountId ?? null,
          createdAt: detail.created ?? new Date().toISOString(),
          lastModifiedBy: detail.modifiedBy?.accountId ?? null,
          lastModified: detail.modified ?? null,
          contentStatus: "current",
          versionCount: detail.version,
        });
        await adapter.upsertPage(pageRecord);
      }

      // Upsert folder records to sync.db
      for (const folder of folders) {
        const computed = pathMap.get(folder.id);
        if (!computed) continue;

        const folderRecord = createPageRecord({
          pageId: folder.id,
          path: computed.relativePath,
          title: folder.title,
          spaceKey: space!,
          version: 1,
          lastSyncedAt: new Date().toISOString(),
          localHash: hashContent(""),
          remoteHash: hashContent(""),
          baseHash: hashContent(""),
          syncState: "synced",
          parentId: folder.parentId,
          ancestors: [],
          hasAttachments: false,
          contentType: "folder",
          createdBy: null,
          createdAt: folder.createdAt ?? new Date().toISOString(),
          lastModifiedBy: null,
          lastModified: null,
          contentStatus: "current",
          versionCount: 1,
        });
        await adapter.upsertPage(folderRecord);
      }

      // Store editor versions for pulled pages (after pages exist in DB)
      for (const detail of pageDetails) {
        // Use editorVersion from page details if available (fetched in same request)
        if (detail.editorVersion !== undefined) {
          await setPageEditorVersion(atlcliDir!, detail.id, detail.editorVersion);
        } else {
          // Fallback: fetch separately (for backward compatibility with older API)
          try {
            const editorVersion = await client.getEditorVersion(detail.id);
            await setPageEditorVersion(atlcliDir!, detail.id, editorVersion);
          } catch (err) {
            // Log error but don't fail pull - editor version is not critical
            getLogger().sync({
              eventType: "error",
              pageId: detail.id,
              title: detail.title,
              message: "Failed to fetch editor version",
              details: { error: err instanceof Error ? err.message : String(err) },
            });
          }
        }
      }

      // Check user statuses (respects TTL caching)
      // Use type assertion since checkUsersFromPull handles optional values via optional chaining
      const userCheckOpts: UserCheckOptions = {
        skipUserCheck,
        refreshUsers,
      };
      const userCheckResult = await checkUsersFromPull(
        pageDetails as import("@atlcli/confluence").ConfluencePageDetails[],
        client,
        adapter,
        userCheckOpts
      );

      if (!opts.json && userCheckResult.checked > 0) {
        output(`Checked ${userCheckResult.checked} user(s)`, opts);
      }

      // Populate contributors table (default: creator + last modifier)
      // This uses data already in pageDetails, no extra API calls
      for (const page of pageDetails) {
        const contributors = createContributorRecords(
          page as import("@atlcli/confluence").ConfluencePageDetails,
          page.id
        );
        if (contributors.length > 0) {
          await adapter.setPageContributors(page.id, contributors);
        }
      }

      // Fetch full contributor history if requested (requires additional API calls)
      if (fetchContributors) {
        if (!opts.json) {
          output(`Fetching full contributor history...`, opts);
        }
        const contributorResults = await fetchAllContributorsForPages(
          pageDetails.map((p) => p.id),
          client,
          { concurrency: 3 }
        );

        // Store full contributor data in database
        for (const [pageId, result] of contributorResults) {
          if (result.contributors.length > 0) {
            await adapter.setPageContributors(pageId, result.contributors);
          }
        }

        if (!opts.json) {
          const totalContributors = Array.from(contributorResults.values())
            .reduce((sum, r) => sum + r.contributors.length, 0);
          output(`Found ${totalContributors} contributor(s) across ${contributorResults.size} page(s)`, opts);
        }
      }
    } finally {
      await adapter.close();
    }
  }

  const pullResults: Record<string, unknown> = { pulled, skipped, moved, outDir };
  if (foldersPulled > 0) {
    pullResults.folders = foldersPulled;
  }
  if (pullAttachments && attachmentsPulled > 0) {
    pullResults.attachments = attachmentsPulled;
  }
  if (pullComments && commentsPulled > 0) {
    pullResults.comments = commentsPulled;
  }

  // Post-pull audit summary (if enabled and audit feature is available)
  if (atlcliDir && !opts.json) {
    const globalConfig = await loadConfig();
    const postPullAuditEnabled = globalConfig.sync?.postPullAuditSummary;
    const auditFeatureEnabled = globalConfig.flags?.audit === true;

    if (postPullAuditEnabled && auditFeatureEnabled) {
      const atlcliPath = getAtlcliPath(atlcliDir);
      if (hasSyncDb(atlcliPath)) {
        try {
          const adapter = await createSyncDb(atlcliPath, { autoMigrate: false });
          const orphanedPages = await adapter.getOrphanedPages();
          const brokenLinks = await adapter.getBrokenLinks();
          const oldestCheck = await adapter.getOldestUserCheck();
          await adapter.close();

          const cacheAgeStr = oldestCheck ? ` (user status as of ${formatTimeAgo(oldestCheck)})` : "";
          output(`[AUDIT] ${orphanedPages.length} orphaned pages, ${brokenLinks.length} broken links${cacheAgeStr}`, opts);
          if (orphanedPages.length > 0 || brokenLinks.length > 0) {
            output(`        Run 'atlcli audit wiki --all' for details`, opts);
          }
        } catch {
          // Ignore errors - audit summary is optional
        }
      }
    }
  }

  output(
    {
      schemaVersion: "1",
      results: pullResults,
      note: "Files use nested directory structure matching Confluence hierarchy.",
    },
    opts
  );
}

async function handlePush(args: string[], flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const pathArg = args[0] ?? getFlag(flags, "dir") ?? ".";
  const pageIdFlag = getFlag(flags, "page-id");
  const client = await getClient(flags, opts);

  // Determine if pushing single file, by page ID, or directory
  let files: string[];
  let atlcliDir: string | null;
  let isSingleFile = false;

  if (pageIdFlag) {
    // Push by page ID - find the file in state
    atlcliDir = findAtlcliDirWithWarning(pathArg, opts);
    if (!atlcliDir) {
      fail(opts, 1, ERROR_CODES.USAGE, "Not in an initialized directory. Run 'docs init' first.");
    }
    const state = await readState(atlcliDir);
    const pageState = state.pages[pageIdFlag];
    if (!pageState) {
      fail(opts, 1, ERROR_CODES.USAGE, `Page ${pageIdFlag} not found in state. Pull it first or use file path.`);
    }
    files = [join(atlcliDir, pageState.path)];
    isSingleFile = true;
  } else if (pathArg.endsWith(".md")) {
    // Single file push
    files = [resolve(pathArg)];
    atlcliDir = findAtlcliDirWithWarning(dirname(pathArg), opts);
    isSingleFile = true;
  } else {
    // Directory push - collect all markdown files, respecting ignore patterns
    atlcliDir = findAtlcliDirWithWarning(pathArg, opts);
    const ignoreResult = await loadIgnorePatterns(atlcliDir ?? pathArg);
    files = await collectMarkdownFiles(pathArg, {
      ignore: ignoreResult.ignore,
      rootDir: atlcliDir ?? pathArg,
    });
  }

  const globalConfig = await loadConfig();
  let space = getFlag(flags, "space");
  let state: AtlcliState | undefined;
  let dirConfig: AtlcliConfig | null = null;

  if (atlcliDir) {
    dirConfig = await readConfig(atlcliDir);
    space = space || dirConfig.space || globalConfig.global?.space;
    state = await readState(atlcliDir);
  } else {
    space = space || globalConfig.global?.space;
  }

  // Run validation if --validate flag is set
  if (hasFlag(flags, "validate") && atlcliDir) {
    const strict = hasFlag(flags, "strict");
    const result = await validateDirectory(atlcliDir, state ?? null, atlcliDir, {
      checkBrokenLinks: true,
      checkMacroSyntax: true,
      checkPageSize: true,
      maxPageSizeKb: 500,
    });

    if (!result.passed) {
      output(formatValidationReport(result), opts);
      fail(opts, 1, ERROR_CODES.VALIDATION, "Validation failed - push aborted");
    }

    if (result.totalWarnings > 0) {
      output(formatValidationReport(result), opts);
      if (strict) {
        fail(opts, 1, ERROR_CODES.VALIDATION, "Validation failed (strict mode: warnings are errors) - push aborted");
      }
      if (!opts.json) {
        output("Proceeding with push despite warnings...\n", opts);
      }
    }
  }

  // Phase 3: Auto-create folder index.md files for directories without them
  let foldersAutoCreated = 0;
  const autoCreateFolders = !hasFlag(flags, "no-auto-create-folders");
  if (!isSingleFile && atlcliDir && autoCreateFolders) {
    const dirsNeedingIndex = new Set<string>();

    // Scan all files to find directories that need folder index.md
    for (const filePath of files) {
      let dir = dirname(filePath);
      const atlcliDirResolved = resolve(atlcliDir);

      while (dir !== atlcliDirResolved && dir !== "/" && dir !== ".") {
        const indexPath = join(dir, "index.md");

        if (!existsSync(indexPath)) {
          // No index.md at all - needs folder creation
          dirsNeedingIndex.add(dir);
        } else {
          // Check if existing index.md is a folder type
          try {
            const content = await readTextFile(indexPath);
            const parsed = parseFrontmatter(content);
            if (parsed && parsed.frontmatter?.type === "folder") {
              // It's already a folder - don't need to create, but check parents
              dir = dirname(dir);
              continue;
            }
            // It's a page index (or no frontmatter), don't create folder here
            break;
          } catch {
            // Can't read file - skip
            break;
          }
        }
        dir = dirname(dir);
      }
    }

    // Sort directories by depth (shallowest first) so parent folders are created before children
    const sortedDirs = [...dirsNeedingIndex].sort(
      (a, b) => a.split("/").length - b.split("/").length
    );

    // Create missing folder index.md files
    for (const dir of sortedDirs) {
      const dirName = basename(dir);
      // Convert directory name to title (kebab-case to Title Case)
      const title = dirName
        .split(/[-_]/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");

      const indexPath = join(dir, "index.md");
      const content = `---
atlcli:
  title: "${title}"
  type: "folder"
---

`;
      await writeTextFile(indexPath, content);

      // Add to files list so it gets pushed
      files.push(indexPath);
      foldersAutoCreated++;

      if (!opts.json) {
        output(`Auto-created folder: ${relative(atlcliDir, indexPath)}`, opts);
      }
    }

    // Sort files so folder index.md files come first, then by depth (shallower first)
    files.sort((a, b) => {
      const aIsIndex = basename(a) === "index.md";
      const bIsIndex = basename(b) === "index.md";

      // Indexes first
      if (aIsIndex && !bIsIndex) return -1;
      if (!aIsIndex && bIsIndex) return 1;

      // Then by depth (shallower first) - ensures parent folders created before children
      return a.split("/").length - b.split("/").length;
    });
  }

  let updated = 0;
  let created = 0;
  let skipped = 0;

  for (const filePath of files) {
    const result = await pushFile({ client, filePath, space, opts, atlcliDir: atlcliDir || undefined, state, baseUrl: dirConfig?.baseUrl, legacyEditor: hasFlag(flags, "legacy-editor") });
    if (result === "updated") updated += 1;
    else if (result === "created") created += 1;
    else skipped += 1;
  }

  // Check for deleted folders (in state but index.md removed locally)
  let foldersDeleted = 0;
  if (state && atlcliDir && !isSingleFile) {
    const deletedFolders: { id: string; title: string; path: string }[] = [];

    for (const [pageId, pageState] of Object.entries(state.pages)) {
      if (pageState.contentType === "folder") {
        // Check if folder's index.md still exists
        const folderPath = join(atlcliDir, pageState.path);
        if (!existsSync(folderPath)) {
          deletedFolders.push({ id: pageId, title: pageState.title, path: pageState.path });
        }
      }
    }

    if (deletedFolders.length > 0) {
      // Check for --delete-folders flag
      const deleteConfirmed = hasFlag(flags, "delete-folders");

      for (const folder of deletedFolders) {
        if (deleteConfirmed) {
          try {
            await client.deleteFolder(folder.id);
            if (!opts.json) {
              output(`Deleted folder: ${folder.title} (${folder.id})`, opts);
            }
            // Remove from state
            delete state.pages[folder.id];
            delete state.pathIndex[folder.path];
            foldersDeleted++;
          } catch (err: any) {
            if (!opts.json) {
              output(`Warning: Could not delete folder "${folder.title}": ${err.message}`, opts);
            }
          }
        } else {
          if (!opts.json) {
            output(`Skipping folder deletion: "${folder.title}" (use --delete-folders to confirm)`, opts);
          }
        }
      }
    }
  }

  // Save state if we have one
  if (state && atlcliDir) {
    state.lastSync = new Date().toISOString();
    await writeState(atlcliDir, state);
  }

  if (isSingleFile && files.length === 1) {
    // Single file output
    const result = updated > 0 ? "updated" : created > 0 ? "created" : "skipped";
    output(
      opts.json
        ? { schemaVersion: "1", file: files[0], result }
        : `${basename(files[0])}: ${result}`,
      opts
    );
  } else {
    const results: Record<string, number> = { updated, created, skipped };
    if (foldersDeleted > 0) {
      results.foldersDeleted = foldersDeleted;
    }
    output(
      {
        schemaVersion: "1",
        results,
        note: "Frontmatter stripped before push. State saved to .atlcli/",
      },
      opts
    );
  }
}

/**
 * Add a local file to Confluence tracking.
 * Creates the page in Confluence and adds frontmatter to the local file.
 */
async function handleAdd(args: string[], flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const filePath = args[0];
  const templateName = getFlag(flags, "template");

  if (!filePath) {
    fail(opts, 1, ERROR_CODES.USAGE, "File path is required.");
  }

  // Find .atlcli directory
  const atlcliDir = findAtlcliDir(dirname(filePath));
  if (!atlcliDir) {
    fail(opts, 1, ERROR_CODES.USAGE, "Not in an initialized directory. Run 'docs init' first.");
  }

  const dirConfig = await readConfig(atlcliDir);
  const state = await readState(atlcliDir);
  const globalConfig = await loadConfig();
  const client = await getClient(flags, opts);

  // Read file content
  const content = await readTextFile(filePath);
  const { frontmatter: existingFrontmatter, content: rawMarkdownContent } = parseFrontmatter(content);

  // Check if already tracked
  if (existingFrontmatter?.id) {
    fail(opts, 1, ERROR_CODES.USAGE, `File already tracked with page ID: ${existingFrontmatter.id}`);
  }

  // Get title: --title flag > H1 heading > filename
  let title = getFlag(flags, "title");
  if (!title) {
    title = extractTitleFromMarkdown(rawMarkdownContent) ?? undefined;
  }
  if (!title) {
    title = titleFromFilename(filePath);
  }

  // Get parent page ID if specified
  const parentId = getFlag(flags, "parent");

  // Get space (from flag, dir config, or global defaults)
  const space = getFlag(flags, "space") || dirConfig.space || globalConfig.global?.space;
  if (!space) {
    fail(opts, 1, ERROR_CODES.USAGE, "Space is required. Use --space or set in config.");
  }

  // Apply template if specified
  let markdownContent = rawMarkdownContent;
  let labels: string[] | undefined;

  if (templateName) {
    // Create template resolver
    const activeProfile = getActiveProfile(globalConfig);

    const global = new GlobalTemplateStorage();
    const profile = activeProfile?.name ? new ProfileTemplateStorage(activeProfile.name) : undefined;
    const spaceStorage = space ? new SpaceTemplateStorage(space, atlcliDir) : undefined;
    const resolver = new TemplateResolver(global, profile, spaceStorage);

    const template = await resolver.resolve(templateName);
    if (!template) {
      fail(opts, 1, ERROR_CODES.USAGE, `Template "${templateName}" not found.`);
    }

    const targetParentId = parentId ?? template.metadata.target?.parent;

    // Parse --var flags
    const variables = parseVarFlags(flags);

    // Apply defaults
    for (const v of template.metadata.variables ?? []) {
      if (!(v.name in variables) && v.default !== undefined) {
        variables[v.name] = v.default;
      }
    }

    // Build builtins context for rendering
    const builtins: Record<string, unknown> = {
      user: activeProfile?.name,
      space,
      profile: activeProfile?.name,
      title,
      parentId: targetParentId,
    };

    // Render template
    const engine = new TemplateEngine();
    const rendered = engine.render(template, { variables, builtins });
    markdownContent = rendered.content;
    labels = template.metadata.labels;
  }

  // Convert to storage format (strip frontmatter if any)
  const conversionOptions = buildConversionOptions(dirConfig?.baseUrl);
  const storage = markdownToStorage(markdownContent, conversionOptions);

  // Create page in Confluence
  const page = await client.createPage({
    spaceKey: space,
    title,
    storage,
    parentId: parentId || dirConfig.settings?.defaultParentId || undefined,
  });

  // Set editor version to v2 (new editor) by default, unless --legacy-editor flag is set
  if (!hasFlag(flags, "legacy-editor")) {
    try {
      await client.setEditorVersion(page.id, "v2");
    } catch {
      // Silently ignore - editor version is not critical
    }
  }

  // Add labels if template specified them
  if (labels && labels.length > 0) {
    await client.addLabels(page.id, labels);
  }

  // Add frontmatter to file
  const frontmatter: AtlcliFrontmatter = {
    id: page.id,
    title: page.title,
  };
  const contentWithFrontmatter = addFrontmatter(markdownContent, frontmatter);
  await writeTextFile(filePath, contentWithFrontmatter);

  // Update state
  const relativePath = getRelativePath(atlcliDir, filePath);
  const normalizedMd = normalizeMarkdown(markdownContent);
  const contentHash = hashContent(normalizedMd);

  // Get ancestors from the created page
  const ancestorIds = page.ancestors?.map((a) => a.id) ?? [];

  updatePageState(state, page.id, {
    path: relativePath,
    title: page.title,
    spaceKey: page.spaceKey ?? space,
    version: page.version ?? 1,
    lastSyncedAt: new Date().toISOString(),
    localHash: contentHash,
    remoteHash: contentHash,
    baseHash: contentHash,
    syncState: "synced",
    parentId: parentId || null,
    ancestors: ancestorIds,
  });

  await writeState(atlcliDir, state);

  // Write base content for 3-way merge
  await writeBaseContent(atlcliDir, page.id, normalizedMd);

  // Log sync event
  getLogger().sync({
    eventType: "push",
    file: relativePath,
    pageId: page.id,
    title: page.title,
    details: { created: true, viaAdd: true },
  });

  output(
    opts.json
      ? { schemaVersion: "1", added: true, pageId: page.id, title: page.title, path: relativePath }
      : `Added ${relativePath} as page "${page.title}" (ID: ${page.id})`,
    opts
  );
}

async function handleWatch(args: string[], flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const { client, defaults } = await getClient(flags, opts, true);
  const dir = args[0] ?? getFlag(flags, "dir") ?? "./docs";
  const space = getFlag(flags, "space") ?? defaults.space;
  const debounceMs = Number(getFlag(flags, "debounce") ?? 500);
  const atlcliDir = findAtlcliDirWithWarning(dir, opts);
  const dirConfig = atlcliDir ? await readConfig(atlcliDir) : null;

  if (!opts.json) {
    output(`Watching ${dir} for Markdown changes...`, opts);
  } else {
    output({ schemaVersion: "1", status: "watching", dir, debounceMs }, opts);
  }

  const watchers = await createWatchers(dir, (filePath) => {
    if (extname(filePath).toLowerCase() !== ".md") return;
    schedulePush(filePath);
  });

  let timer: NodeJS.Timeout | null = null;
  const queue = new Set<string>();

  function schedulePush(filePath: string): void {
    queue.add(filePath);
    if (timer) return;
    timer = setTimeout(async () => {
      const batch = Array.from(queue);
      queue.clear();
      timer = null;

      for (const file of batch) {
        try {
          const result = await pushFile({ client, filePath: file, space, opts, baseUrl: dirConfig?.baseUrl });
          const payload = { schemaVersion: "1", file, result };
          if (opts.json) {
            process.stdout.write(`${JSON.stringify(payload)}\n`);
          } else {
            output(`Updated ${file} (${result})`, opts);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const payload = { schemaVersion: "1", file, result: "error", message };
          if (opts.json) {
            process.stdout.write(`${JSON.stringify(payload)}\n`);
          } else {
            output(`Error updating ${file}: ${message}`, opts);
          }
        }
      }
    }, Number.isNaN(debounceMs) ? 500 : debounceMs);
  }

  process.on("SIGINT", () => {
    for (const watcher of watchers) {
      watcher.close();
    }
    process.exit(0);
  });
}

type PushResult = "updated" | "created" | "skipped";

async function pushFile(params: {
  client: ConfluenceClient;
  filePath: string;
  space?: string;
  opts: OutputOptions;
  atlcliDir?: string;
  state?: AtlcliState;
  baseUrl?: string;
  legacyEditor?: boolean;
}): Promise<PushResult> {
  const { client, filePath, space, opts, atlcliDir, state, baseUrl, legacyEditor } = params;

  // Read file and parse frontmatter
  const rawContent = await readTextFile(filePath);
  const { frontmatter, content: markdownContent } = parseFrontmatter(rawContent);

  // Also check legacy .meta.json
  const legacyMeta = await readMeta(filePath);

  // Get page ID from frontmatter or legacy meta
  const pageId = frontmatter?.id || legacyMeta?.id;

  // Handle folder files (type: folder in frontmatter)
  if (frontmatter?.type === "folder") {
    const relativePath = atlcliDir ? getRelativePath(atlcliDir, filePath) : basename(filePath);
    const dirName = basename(dirname(filePath));
    // Derive title from directory name if not in frontmatter
    const titleFromDir = dirName
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

    if (!pageId) {
      // NEW FOLDER: Create folder in Confluence
      const folderTitle = frontmatter.title || titleFromDir;

      if (!space) {
        if (!opts.json) {
          output(`Error: Cannot create folder - no space specified`, opts);
        }
        return "skipped";
      }

      // Determine parent folder/page ID from directory structure
      // Walk up the directory tree to find parent
      const parentDir = dirname(dirname(filePath)); // Go up from folder/index.md
      let parentFolderId: string | undefined;

      // Check if parent directory has an index.md with folder type
      const parentIndexPath = join(parentDir, "index.md");
      if (existsSync(parentIndexPath)) {
        try {
          const parentContent = await readTextFile(parentIndexPath);
          const { frontmatter: parentFrontmatter } = parseFrontmatter(parentContent);
          if (parentFrontmatter?.id) {
            parentFolderId = parentFrontmatter.id;
          }
        } catch {
          // Parent index doesn't exist or can't be read
        }
      }

      // Get space ID for folder creation
      const spaceInfo = await client.getSpace(space);

      try {
        const newFolder = await client.createFolder({
          spaceId: spaceInfo.id,
          title: folderTitle,
          parentFolderId,
        });

        if (!opts.json) {
          output(`Created folder: ${folderTitle} (${newFolder.id})`, opts);
        }

        // Update frontmatter with new folder ID
        const updatedFrontmatter: AtlcliFrontmatter = {
          ...frontmatter,
          id: newFolder.id,
          title: newFolder.title,
        };
        const updatedContent = addFrontmatter("", updatedFrontmatter);
        await writeTextFile(filePath, updatedContent);

        // Update state
        if (state && atlcliDir) {
          updatePageState(state, newFolder.id, {
            path: relativePath,
            title: newFolder.title,
            spaceKey: space,
            version: 1,
            lastSyncedAt: new Date().toISOString(),
            localHash: hashContent(""),
            remoteHash: hashContent(""),
            baseHash: hashContent(""),
            syncState: "synced",
            parentId: parentFolderId ?? null,
            ancestors: [],
            hasAttachments: false,
            contentType: "folder",
          });
          await writeBaseContent(atlcliDir, newFolder.id, "");
        }

        return "created";
      } catch (err: any) {
        if (!opts.json) {
          output(`Error creating folder: ${err.message}`, opts);
        }
        return "skipped";
      }
    }

    // EXISTING FOLDER: Check for rename
    const existingFolderState = state?.pages[pageId];

    // Use directory name as title if path changed (folder was renamed locally)
    let newTitle = frontmatter.title;
    if (existingFolderState && existingFolderState.path !== relativePath) {
      // Directory was renamed - use directory name as new title (unless frontmatter was manually changed)
      if (frontmatter.title === existingFolderState.title) {
        newTitle = titleFromDir;
      }
    }

    if (newTitle && newTitle !== existingFolderState?.title) {
      // Confluence API doesn't support folder rename (returns 501)
      // User must rename in Confluence UI, then pull
      if (!opts.json) {
        const folderUrl = `${client.getInstanceUrl()}/wiki/spaces/${space}/folder/${pageId}`;
        output(`Warning: Folder rename not supported by Confluence API. Rename "${existingFolderState?.title}" in Confluence UI, then pull: ${folderUrl}`, opts);
      }
      return "skipped";
    }

    // Folder exists and hasn't changed - skip
    return "skipped";
  }

  // Strip frontmatter before converting to storage format
  const conversionOptions = buildConversionOptions(baseUrl);
  const storage = markdownToStorage(markdownContent, conversionOptions);

  // Check for attachment references and upload them
  const pageFilename = basename(filePath);
  const pageDir = dirname(filePath);
  const attachmentRefs = extractAttachmentRefs(markdownContent);
  const attachmentsDir = join(pageDir, getAttachmentsDirName(pageFilename));

  if (pageId) {
    // Upload attachments before updating the page
    if (attachmentRefs.length > 0) {
      // Get existing attachments from Confluence
      let existingAttachments: AttachmentInfo[] = [];
      try {
        existingAttachments = await client.listAttachments(pageId);
      } catch {
        // Page might not have any attachments yet
      }
      const existingByName = new Map(existingAttachments.map((a) => [a.filename, a]));

      // Get existing attachment state for change detection
      const existingPageState = state?.pages[pageId];
      const attachmentStates = existingPageState?.attachments || {};

      for (const filename of attachmentRefs) {
        const localPath = join(attachmentsDir, filename);
        try {
          const data = await readFile(localPath);
          const localHash = hashContent(data.toString("base64"));
          const existing = existingByName.get(filename);

          // Warn about large files
          if (data.length >= LARGE_FILE_THRESHOLD && !opts.json) {
            output(`Warning: Large attachment ${filename} (${formatFileSize(data.length)})`, opts);
          }

          // Find attachment state by filename
          const attachmentEntry = Object.values(attachmentStates).find(
            (a) => a.filename === filename
          );

          // Skip upload if unchanged (same hash as base) AND exists on remote
          // If attachment was deleted from Confluence, we need to re-upload
          if (attachmentEntry && localHash === attachmentEntry.baseHash && existing) {
            continue;
          }

          if (existing) {
            // Update existing attachment
            await client.updateAttachment({
              attachmentId: existing.id,
              pageId,
              filename,
              data,
            });

            // Update attachment state after successful upload
            if (state && attachmentEntry) {
              updateAttachmentState(state, pageId, existing.id, {
                localHash,
                remoteHash: localHash,
                baseHash: localHash,
                lastSyncedAt: new Date().toISOString(),
                syncState: "synced",
              });
            }
          } else {
            // Upload new attachment
            const newAttachment = await client.uploadAttachment({
              pageId,
              filename,
              data,
            });

            // Add new attachment to state
            if (state && newAttachment) {
              updateAttachmentState(state, pageId, newAttachment.id, {
                attachmentId: newAttachment.id,
                filename: newAttachment.filename,
                localPath: filename,
                mediaType: newAttachment.mediaType,
                fileSize: newAttachment.fileSize,
                version: newAttachment.version,
                localHash,
                remoteHash: localHash,
                baseHash: localHash,
                lastSyncedAt: new Date().toISOString(),
                syncState: "synced",
              });
            }
          }
        } catch (err) {
          if (!opts.json) {
            output(`Warning: Could not upload attachment ${filename}`, opts);
          }
        }
      }

      // Check for locally deleted attachments (in state but file doesn't exist)
      const pageState = state?.pages[pageId];
      if (state && pageState?.attachments && atlcliDir) {
        const referencedFiles = new Set(attachmentRefs);

        for (const [attId, attState] of Object.entries(pageState.attachments)) {
          const localAttPath = join(attachmentsDir, attState.filename);

          // If file doesn't exist locally AND not referenced in markdown, delete from Confluence
          if (!existsSync(localAttPath) && !referencedFiles.has(attState.filename)) {
            try {
              await client.deleteAttachment(attId);
              removeAttachmentState(state, pageId, attId);
              await deleteAttachmentBase(atlcliDir, pageId, attId, extname(attState.filename));
              if (!opts.json) {
                output(`Deleted ${attState.filename} from Confluence`, opts);
              }
            } catch (err) {
              if (!opts.json) {
                output(`Warning: Could not delete attachment ${attState.filename}`, opts);
              }
            }
          }
        }
      }
    }

    // Check if page was moved to a different location (directory changed)
    // Skip move detection for folder index files (they're handled separately)
    const relativePath = atlcliDir ? getRelativePath(atlcliDir, filePath) : basename(filePath);
    const existingPageState = state?.pages[pageId];
    let pageMoved = false;
    let newParentId: string | null = null;

    // Skip move detection if this is a folder (contentType === "folder")
    const isFolder = existingPageState?.contentType === "folder";

    if (existingPageState && atlcliDir && !isFolder) {
      const oldDir = dirname(existingPageState.path);
      const newDir = dirname(relativePath);

      if (oldDir !== newDir) {
        // Page directory changed - determine new parent
        // Check if new directory has a parent index.md with a folder/page ID
        const parentIndexPath = join(atlcliDir, newDir, "index.md");
        if (existsSync(parentIndexPath)) {
          try {
            const parentContent = await readTextFile(parentIndexPath);
            const { frontmatter: parentFrontmatter } = parseFrontmatter(parentContent);
            if (parentFrontmatter?.id) {
              newParentId = parentFrontmatter.id;
            }
          } catch {
            // Can't read parent index
          }
        }

        // Move the page in Confluence
        if (newParentId) {
          try {
            // Check if new parent is a folder or page
            const parentState = state?.pages[newParentId];
            if (parentState?.contentType === "folder") {
              await client.movePageToFolder(pageId, newParentId);
            } else {
              // Move under a page
              await client.movePage(pageId, newParentId);
            }
            pageMoved = true;
            if (!opts.json) {
              output(`Moved page to ${newDir}/`, opts);
            }
          } catch (err: any) {
            if (!opts.json) {
              output(`Warning: Could not move page: ${err.message}`, opts);
            }
          }
        } else if (newDir === ".") {
          // Moved to root - find space home page as parent
          // For now, just warn - moving to root requires knowing the home page ID
          if (!opts.json) {
            output(`Warning: Moving page to root not yet supported. Move in Confluence UI.`, opts);
          }
        }
      }
    }

    // Update existing page
    const current = await client.getPage(pageId);
    const title = frontmatter?.title || legacyMeta?.title || current.title;
    const version = (current.version ?? 1) + 1;
    const page = await client.updatePage({ id: pageId, title, storage, version });

    // Update state if available
    if (atlcliDir && state) {
      const normalizedMd = normalizeMarkdown(markdownContent);
      const contentHash = hashContent(normalizedMd);

      // Update ancestors if page was moved
      let ancestors = existingPageState?.ancestors ?? [];
      let parentId = existingPageState?.parentId ?? null;
      if (pageMoved && newParentId) {
        // Get new parent's ancestors and add parent to chain
        const newParentState = state.pages[newParentId];
        if (newParentState) {
          ancestors = [...(newParentState.ancestors ?? []), newParentId];
          parentId = newParentId;
        }
      }

      updatePageState(state, page.id, {
        path: relativePath,
        title: page.title,
        spaceKey: page.spaceKey ?? space ?? "",
        version: page.version ?? version,
        lastSyncedAt: new Date().toISOString(),
        localHash: contentHash,
        remoteHash: contentHash,
        baseHash: contentHash,
        syncState: "synced",
        parentId,
        ancestors,
      });

      await writeBaseContent(atlcliDir, page.id, normalizedMd);
    } else {
      // Fall back to legacy meta
      await writeMeta(filePath, {
        id: page.id,
        title: page.title,
        spaceKey: page.spaceKey ?? legacyMeta?.spaceKey ?? space,
        version: page.version ?? version,
      });
    }

    // Log sync event
    getLogger().sync({
      eventType: "push",
      file: atlcliDir ? getRelativePath(atlcliDir, filePath) : basename(filePath),
      pageId: page.id,
      title: page.title,
    });

    return "updated";
  }

  // No page ID - skip (use 'docs add' to create new pages)
  const targetSpace = legacyMeta?.spaceKey ?? space;
  if (!targetSpace) {
    return "skipped";
  }

  // For backwards compatibility, still create if legacy meta exists with space
  const title = legacyMeta?.title ?? titleFromFilename(filePath);

  // Determine parent folder ID from directory structure
  let parentId: string | undefined;
  const newPageDir = dirname(filePath);
  const parentIndexPath = join(newPageDir, "index.md");
  if (existsSync(parentIndexPath)) {
    try {
      const parentContent = await readTextFile(parentIndexPath);
      const { frontmatter: parentFrontmatter } = parseFrontmatter(parentContent);
      // Only use as parent if it's a folder type with an ID
      if (parentFrontmatter?.type === "folder" && parentFrontmatter.id) {
        parentId = parentFrontmatter.id;
      }
    } catch {
      // Parent index doesn't exist or can't be read
    }
  }

  const page = await client.createPage({ spaceKey: targetSpace, title, storage, parentId });

  // Set editor version to v2 (new editor) by default, unless --legacy-editor flag is set
  if (!legacyEditor) {
    try {
      await client.setEditorVersion(page.id, "v2");
    } catch {
      // Silently ignore - editor version is not critical
    }
  }

  // Upload attachments after creating the page
  if (attachmentRefs.length > 0) {
    for (const filename of attachmentRefs) {
      const localPath = join(attachmentsDir, filename);
      try {
        const data = await readFile(localPath);
        await client.uploadAttachment({
          pageId: page.id,
          filename,
          data,
        });
      } catch (err) {
        if (!opts.json) {
          output(`Warning: Could not upload attachment ${filename}`, opts);
        }
      }
    }
  }

  // Add frontmatter to file
  const newFrontmatter: AtlcliFrontmatter = {
    id: page.id,
    title: page.title,
  };
  const contentWithFrontmatter = addFrontmatter(markdownContent, newFrontmatter);
  await writeTextFile(filePath, contentWithFrontmatter);

  // Update state if available
  if (atlcliDir && state) {
    const relativePath = getRelativePath(atlcliDir, filePath);
    const normalizedMd = normalizeMarkdown(markdownContent);
    const contentHash = hashContent(normalizedMd);

    // Get ancestors from created page
    const ancestorIds = page.ancestors?.map((a) => a.id) ?? [];

    updatePageState(state, page.id, {
      path: relativePath,
      title: page.title,
      spaceKey: page.spaceKey ?? targetSpace,
      version: page.version ?? 1,
      lastSyncedAt: new Date().toISOString(),
      localHash: contentHash,
      remoteHash: contentHash,
      baseHash: contentHash,
      syncState: "synced",
      parentId: page.parentId ?? null,
      ancestors: ancestorIds,
    });

    await writeBaseContent(atlcliDir, page.id, normalizedMd);
  }

  // Log sync event
  getLogger().sync({
    eventType: "push",
    file: atlcliDir ? getRelativePath(atlcliDir, filePath) : basename(filePath),
    pageId: page.id,
    title: page.title,
    details: { created: true },
  });

  return "created";
}

/**
 * Reads metadata from .meta.json file.
 * Supports both legacy and enhanced metadata formats.
 */
async function readMeta(path: string): Promise<EnhancedMeta | LegacyMeta | null> {
  try {
    const raw = await readTextFile(`${path}.meta.json`);
    return JSON.parse(raw) as EnhancedMeta | LegacyMeta;
  } catch {
    return null;
  }
}

/**
 * Writes enhanced metadata to .meta.json file.
 */
async function writeMeta(path: string, meta: EnhancedMeta | LegacyMeta): Promise<void> {
  await writeTextFile(`${path}.meta.json`, JSON.stringify(meta, null, 2));
}

/**
 * Reads base content from .base file (used for three-way merge).
 */
export async function readBase(mdPath: string): Promise<string | null> {
  try {
    return await readTextFile(`${mdPath}.base`);
  } catch {
    return null;
  }
}

/**
 * Writes base content to .base file.
 */
export async function writeBase(mdPath: string, content: string): Promise<void> {
  await writeTextFile(`${mdPath}.base`, content);
}

/**
 * Checks if metadata is in enhanced format (has sync fields).
 */
function isEnhancedMeta(meta: EnhancedMeta | LegacyMeta | null): meta is EnhancedMeta {
  return meta !== null && "syncState" in meta && "localHash" in meta;
}

/**
 * Creates enhanced metadata from current state.
 */
export function createEnhancedMeta(params: {
  id: string;
  title: string;
  spaceKey: string;
  version: number;
  localContent: string;
  remoteContent: string;
}): EnhancedMeta {
  const normalizedLocal = normalizeMarkdown(params.localContent);
  const normalizedRemote = normalizeMarkdown(params.remoteContent);
  const localHash = hashContent(normalizedLocal);
  const remoteHash = hashContent(normalizedRemote);

  return {
    id: params.id,
    title: params.title,
    spaceKey: params.spaceKey,
    version: params.version,
    lastSyncedAt: new Date().toISOString(),
    localHash,
    remoteHash,
    baseHash: remoteHash, // Base is remote at sync time
    syncState: "synced",
  };
}

/**
 * Computes the current sync state based on local and remote hashes.
 */
export function computeSyncState(params: {
  localContent: string;
  meta: EnhancedMeta;
  remoteVersion?: number;
  remoteContent?: string;
}): SyncState {
  const { localContent, meta, remoteVersion, remoteContent } = params;

  const normalizedLocal = normalizeMarkdown(localContent);
  const currentLocalHash = hashContent(normalizedLocal);

  // Check if local has changed since last sync
  const localChanged = currentLocalHash !== meta.localHash;

  // Check if remote has changed (by version or content hash)
  let remoteChanged = false;
  if (remoteVersion !== undefined && remoteVersion > meta.version) {
    remoteChanged = true;
  } else if (remoteContent !== undefined) {
    const normalizedRemote = normalizeMarkdown(remoteContent);
    const currentRemoteHash = hashContent(normalizedRemote);
    remoteChanged = currentRemoteHash !== meta.remoteHash;
  }

  if (localChanged && remoteChanged) {
    return "conflict";
  }
  if (localChanged) {
    return "local-modified";
  }
  if (remoteChanged) {
    return "remote-modified";
  }
  return "synced";
}

async function collectMarkdownFiles(
  dir: string,
  options?: { ignore?: Ignore; rootDir?: string }
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  const { ignore: ig, rootDir = dir } = options ?? {};

  for (const entry of entries) {
    // Skip .atlcli directory and other hidden directories
    if (entry.name.startsWith(".")) {
      continue;
    }
    const fullPath = join(dir, entry.name);

    // Check if path should be ignored
    if (ig) {
      const relativePath = relative(rootDir, fullPath);
      if (shouldIgnore(ig, relativePath)) {
        continue;
      }
    }

    if (entry.isDirectory()) {
      results.push(...(await collectMarkdownFiles(fullPath, { ignore: ig, rootDir })));
      continue;
    }
    if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      results.push(fullPath);
    }
  }

  return results;
}

async function createWatchers(dir: string, onChange: (filePath: string) => void): Promise<FSWatcher[]> {
  const watchers: FSWatcher[] = [];
  const dirs = await collectDirs(dir);

  for (const folder of dirs) {
    const watcher = watch(folder, { persistent: true });
    watcher.on("change", (_event, filename) => {
      if (!filename) return;
      const fullPath = join(folder, String(filename));
      onChange(fullPath);
    });
    watchers.push(watcher);
  }

  return watchers;
}

async function collectDirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results = [dir];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = join(dir, entry.name);
    results.push(...(await collectDirs(fullPath)));
  }

  return results;
}

function parseVarFlags(flags: Record<string, string | boolean | string[]>): Record<string, unknown> {
  const vars: Record<string, unknown> = {};

  // Check for --var.name=value format
  for (const [key, value] of Object.entries(flags)) {
    if (key.startsWith("var.") && typeof value === "string") {
      vars[key.slice(4)] = value;
    }
  }

  // Handle --var key=value (supports multiple --var flags)
  const varFlag = flags["var"];
  const varValues = Array.isArray(varFlag) ? varFlag : typeof varFlag === "string" ? [varFlag] : [];
  for (const v of varValues) {
    const eqIdx = v.indexOf("=");
    if (eqIdx > 0) {
      vars[v.slice(0, eqIdx)] = v.slice(eqIdx + 1);
    }
  }

  return vars;
}

function titleFromFilename(path: string): string {
  const file = basename(path, extname(path));
  const cleaned = file.replace(/^[0-9]+__/, "");
  return cleaned.replace(/[-_]+/g, " ").trim() || "Untitled";
}

/**
 * Show sync status of all tracked files.
 */
async function handleStatus(args: string[], flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const dir = args[0] ?? getFlag(flags, "dir") ?? ".";
  const checkLinks = hasFlag(flags, "links");

  // Check for .atlcli directory
  const atlcliDir = findAtlcliDirWithWarning(dir, opts);
  const state = atlcliDir ? await readState(atlcliDir) : null;

  // Get user cache age from sync.db if available
  let userCacheAge: string | null = null;
  if (atlcliDir) {
    const atlcliPath = getAtlcliPath(atlcliDir);
    if (hasSyncDb(atlcliPath)) {
      try {
        const adapter = await createSyncDb(atlcliPath, { autoMigrate: false });
        const oldestCheck = await adapter.getOldestUserCheck();
        if (oldestCheck) {
          userCacheAge = formatTimeAgo(oldestCheck);
        }
        await adapter.close();
      } catch {
        // Ignore errors - cache age is optional
      }
    }
  }

  // Load ignore patterns and collect files
  const ignoreResult = await loadIgnorePatterns(atlcliDir ?? dir);
  const files = await collectMarkdownFiles(dir, {
    ignore: ignoreResult.ignore,
    rootDir: atlcliDir ?? dir,
  });

  const stats = {
    synced: 0,
    localModified: 0,
    remoteModified: 0,
    conflict: 0,
    untracked: 0,
  };

  const conflicts: { file: string; id?: string }[] = [];
  const modified: { file: string; type: string }[] = [];
  const untracked: string[] = [];

  // Collect file data for link change detection
  const trackedFiles: Array<{ filePath: string; pageId: string; markdownContent: string }> = [];

  for (const filePath of files) {
    const relativePath = atlcliDir ? getRelativePath(atlcliDir, filePath) : filePath;

    // Check frontmatter first
    const content = await readTextFile(filePath);
    const { frontmatter, content: markdownContent } = parseFrontmatter(content);

    // Get page state from state.json or legacy meta
    let pageState: PageState | null = null;
    if (state && frontmatter?.id) {
      pageState = getPageById(state, frontmatter.id);
    }

    if (!frontmatter?.id && !pageState) {
      // Check legacy meta
      const legacyMeta = await readMeta(filePath);
      if (legacyMeta?.id) {
        // Legacy tracked file
        stats.synced++;
        continue;
      }
      stats.untracked++;
      untracked.push(relativePath);
      continue;
    }

    // Collect tracked files for link change detection
    if (checkLinks && frontmatter?.id) {
      trackedFiles.push({ filePath, pageId: frontmatter.id, markdownContent });
    }

    if (pageState) {
      // Compute current sync state by comparing hashes
      const normalizedMd = normalizeMarkdown(markdownContent);
      const currentLocalHash = hashContent(normalizedMd);

      let currentState: CoreSyncState;
      if (pageState.syncState === "conflict") {
        currentState = "conflict";
      } else if (currentLocalHash !== pageState.baseHash) {
        currentState = "local-modified";
      } else {
        currentState = pageState.syncState;
      }

      switch (currentState) {
        case "synced":
          stats.synced++;
          break;
        case "local-modified":
          stats.localModified++;
          modified.push({ file: relativePath, type: "local changes" });
          break;
        case "remote-modified":
          stats.remoteModified++;
          modified.push({ file: relativePath, type: "remote changes" });
          break;
        case "conflict":
          stats.conflict++;
          conflicts.push({ file: relativePath, id: frontmatter?.id });
          break;
      }
    } else if (frontmatter?.id) {
      // Has frontmatter but no state - assume synced
      stats.synced++;
    }
  }

  // Detect link changes if --links flag is set
  let linkChanges: LinkChangeResult[] = [];
  if (checkLinks && atlcliDir && trackedFiles.length > 0) {
    linkChanges = await detectLinkChangesBatch(atlcliDir, trackedFiles);
  }

  // Compute link stats
  const linkStats = {
    filesWithChanges: linkChanges.filter((l) => l.hasChanges).length,
    filesWithBrokenLinks: linkChanges.filter((l) => l.broken.length > 0).length,
    totalAdded: linkChanges.reduce((sum, l) => sum + l.added.length, 0),
    totalRemoved: linkChanges.reduce((sum, l) => sum + l.removed.length, 0),
    totalBroken: linkChanges.reduce((sum, l) => sum + l.broken.length, 0),
  };

  // Count folders from state
  let folderCount = 0;
  if (state) {
    for (const pageState of Object.values(state.pages)) {
      if (pageState.contentType === "folder") {
        folderCount++;
      }
    }
  }

  // Get editor format stats
  const editorStats = { v2: 0, v1: 0, unknown: 0 };
  const legacyPages: Array<{ path: string; id: string; title: string }> = [];
  if (atlcliDir) {
    const editorVersions = await getAllEditorVersions(atlcliDir);
    for (const [pageId, version] of editorVersions) {
      const pageState = state?.pages[pageId];
      if (!pageState || pageState.contentType === "folder") continue;

      if (version === "v2") {
        editorStats.v2++;
      } else if (version === "v1") {
        editorStats.v1++;
        legacyPages.push({ path: pageState.path, id: pageId, title: pageState.title });
      } else {
        editorStats.unknown++;
        legacyPages.push({ path: pageState.path, id: pageId, title: pageState.title });
      }
    }
  }

  if (opts.json) {
    const result: Record<string, unknown> = {
      schemaVersion: "1",
      dir,
      stats,
      folderCount,
      editorFormat: editorStats,
      legacyPages: legacyPages.length > 0 ? legacyPages : undefined,
      conflicts,
      modified,
      untracked,
      lastSync: state?.lastSync,
      userCacheAge: userCacheAge,
      ignorePatterns: {
        hasAtlcliIgnore: ignoreResult.hasAtlcliIgnore,
        hasGitIgnore: ignoreResult.hasGitIgnore,
      },
    };

    // Include link changes if --links flag was used
    if (checkLinks) {
      result.linkStats = linkStats;
      result.linkChanges = linkChanges.map((l) => ({
        file: l.filePath,
        pageId: l.pageId,
        added: l.added.map((a) => ({ target: a.target, resolvedPageId: a.resolvedPageId })),
        removed: l.removed.map((r) => ({ targetPageId: r.targetPageId, targetPath: r.targetPath })),
        broken: l.broken.map((b) => ({ target: b.target, line: b.line })),
      }));
    }

    output(result, opts);
  } else {
    output(`Sync status for ${dir}:\n`, opts);
    output(`  synced:          ${stats.synced} files`, opts);
    output(`  local-modified:  ${stats.localModified} files`, opts);
    output(`  remote-modified: ${stats.remoteModified} files`, opts);
    output(`  conflict:        ${stats.conflict} files`, opts);
    output(`  untracked:       ${stats.untracked} files`, opts);
    output(`  folders:         ${folderCount}`, opts);

    // Editor format stats
    const totalEditorPages = editorStats.v2 + editorStats.v1 + editorStats.unknown;
    if (totalEditorPages > 0) {
      output(`\nEditor format:`, opts);
      output(`  new editor (v2):    ${editorStats.v2} pages`, opts);
      output(`  legacy editor (v1): ${editorStats.v1} pages`, opts);
      output(`  unknown:            ${editorStats.unknown} pages`, opts);

      if (legacyPages.length > 0 && legacyPages.length <= 10) {
        output(`\nLegacy/unknown editor pages:`, opts);
        for (const p of legacyPages) {
          output(`  ${p.path}`, opts);
        }
      } else if (legacyPages.length > 10) {
        output(`\nLegacy/unknown editor: ${legacyPages.length} pages (use --json for full list)`, opts);
      }
    }

    if (state?.lastSync) {
      output(`\nLast sync: ${state.lastSync}`, opts);
    }

    if (userCacheAge) {
      output(`User status: cached (as of ${userCacheAge})`, opts);
    }

    if (modified.length > 0) {
      output(`\nModified:`, opts);
      for (const m of modified) {
        output(`  ${m.file} (${m.type})`, opts);
      }
    }

    if (conflicts.length > 0) {
      output(`\nConflicts:`, opts);
      for (const c of conflicts) {
        output(`  ${c.file}`, opts);
      }
    }

    if (untracked.length > 0 && untracked.length <= 10) {
      output(`\nUntracked:`, opts);
      for (const u of untracked) {
        output(`  ${u}`, opts);
      }
    } else if (untracked.length > 10) {
      output(`\nUntracked: ${untracked.length} files (use --json for full list)`, opts);
    }

    // Show link changes if --links flag was used
    if (checkLinks) {
      output(`\nLink analysis:`, opts);
      output(`  files with link changes: ${linkStats.filesWithChanges}`, opts);
      output(`  files with broken links: ${linkStats.filesWithBrokenLinks}`, opts);

      if (linkStats.totalAdded > 0 || linkStats.totalRemoved > 0) {
        output(`  links added:   ${linkStats.totalAdded}`, opts);
        output(`  links removed: ${linkStats.totalRemoved}`, opts);
      }

      if (linkStats.totalBroken > 0) {
        output(`  broken links:  ${linkStats.totalBroken}`, opts);
      }

      // Show details for files with changes or broken links
      for (const change of linkChanges) {
        if (change.hasChanges || change.broken.length > 0) {
          output(`\n  ${change.filePath}:`, opts);
          for (const added of change.added) {
            output(`    + ${added.target}`, opts);
          }
          for (const removed of change.removed) {
            output(`    - ${removed.targetPath || removed.targetPageId}`, opts);
          }
          for (const broken of change.broken) {
            output(`    ! broken: ${broken.target} (line ${broken.line})`, opts);
          }
        }
      }
    }
  }
}

/**
 * Resolve conflicts in a file.
 */
async function handleResolve(args: string[], flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const filePath = args[0];
  if (!filePath) {
    fail(opts, 1, ERROR_CODES.USAGE, "File path is required.");
  }

  const accept = getFlag(flags, "accept") as "local" | "remote" | "merged" | undefined;

  const content = await readTextFile(filePath);
  const meta = await readMeta(filePath);

  if (!meta) {
    fail(opts, 1, ERROR_CODES.USAGE, "File is not tracked (no metadata).");
  }

  // Check if file has conflict markers
  const hasMarkers = content.includes("<<<<<<< LOCAL") &&
                     content.includes("=======") &&
                     content.includes(">>>>>>> REMOTE");

  if (!hasMarkers) {
    if (isEnhancedMeta(meta) && meta.syncState === "conflict") {
      // No markers but marked as conflict - might have been manually edited
      output("File was marked as conflict but has no conflict markers.", opts);
    } else {
      output("File has no conflicts to resolve.", opts);
    }
    return;
  }

  if (!accept) {
    fail(opts, 1, ERROR_CODES.USAGE, "Specify --accept local|remote|merged");
  }

  if (accept === "merged") {
    // User should have manually resolved - just verify no markers remain
    fail(opts, 1, ERROR_CODES.USAGE, "For 'merged', edit the file to remove conflict markers first.");
  }

  // Resolve by choosing a side
  const resolved = resolveConflicts(content, accept);
  await writeTextFile(filePath, resolved);

  // Update metadata
  if (isEnhancedMeta(meta)) {
    const updatedMeta: EnhancedMeta = {
      ...meta,
      syncState: "local-modified",
      localHash: hashContent(normalizeMarkdown(resolved)),
    };
    await writeMeta(filePath, updatedMeta);
  }

  output(`Resolved conflicts in ${filePath} using ${accept} version.`, opts);
  output("Run 'atlcli wiki docs push' to push the resolved version.", opts);
}

async function handleDocsDiff(args: string[], flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const filePath = args[0];
  if (!filePath) {
    fail(opts, 1, ERROR_CODES.USAGE, "File path is required. Usage: atlcli wiki docs diff <file>");
  }

  // Get baseUrl from dirConfig if available
  const atlcliDir = findAtlcliDir(dirname(filePath));
  const dirConfig = atlcliDir ? await readConfig(atlcliDir) : null;
  const conversionOptions = buildConversionOptions(dirConfig?.baseUrl);

  // Check if file exists and read it
  let localContent: string;
  try {
    localContent = await readTextFile(filePath);
  } catch {
    fail(opts, 1, ERROR_CODES.USAGE, `File not found: ${filePath}`);
  }

  // Parse frontmatter to get page ID
  const { frontmatter, content: localMarkdown } = parseFrontmatter(localContent);

  if (!frontmatter?.id) {
    fail(opts, 1, ERROR_CODES.USAGE, "File has no page ID in frontmatter. Is it tracked?");
  }

  const pageId = frontmatter.id;
  const client = await getClient(flags, opts);

  // Handle folders differently - they have no content to diff
  if (frontmatter?.type === "folder") {
    const folder = await client.getFolder(pageId);
    const localTitle = frontmatter.title || "";
    const remoteTitle = folder.title;
    const hasChanges = localTitle !== remoteTitle;

    if (opts.json) {
      output({
        schemaVersion: "1",
        file: filePath,
        pageId,
        title: remoteTitle,
        type: "folder",
        hasChanges,
        localTitle,
        remoteTitle,
      }, opts);
    } else {
      output(`Folder: "${remoteTitle}"`, opts);
      if (hasChanges) {
        output(`  Title mismatch:`, opts);
        output(`    Local:  "${localTitle}"`, opts);
        output(`    Remote: "${remoteTitle}"`, opts);
      } else {
        output(`  No changes (folder has no content to diff)`, opts);
      }
    }
    return;
  }

  // Fetch remote page
  const remotePage = await client.getPage(pageId);
  const remoteMarkdown = storageToMarkdown(remotePage.storage, conversionOptions);

  // Generate diff
  const diff = generateDiff(remoteMarkdown, localMarkdown, {
    oldLabel: `Remote (v${remotePage.version})`,
    newLabel: "Local",
    context: 3,
  });

  if (opts.json) {
    output({
      schemaVersion: "1",
      file: filePath,
      pageId,
      title: remotePage.title,
      remoteVersion: remotePage.version,
      hasChanges: diff.hasChanges,
      additions: diff.additions,
      deletions: diff.deletions,
      unified: diff.unified,
    }, opts);
    return;
  }

  if (!diff.hasChanges) {
    output(`No changes between local file and remote page (v${remotePage.version}).`, opts);
    return;
  }

  // Output colored diff
  output(`\nDiff for "${remotePage.title}"`, opts);
  output(`Comparing Remote (v${remotePage.version}) ↔ Local`, opts);
  output(`${formatDiffSummary(diff)}\n`, opts);
  output(formatDiffWithColors(diff), opts);
}

async function handleCheck(args: string[], flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const targetPath = args[0] || ".";
  const strict = hasFlag(flags, "strict");

  // Resolve to absolute path
  const absPath = resolve(targetPath);

  // Find .atlcli directory if it exists
  const atlcliDir = findAtlcliDir(absPath);
  let state: AtlcliState | null = null;

  if (atlcliDir) {
    try {
      state = await readState(atlcliDir);
    } catch {
      // No state file, continue without it
    }
  }

  // Run validation
  const result = await validateDirectory(absPath, state, atlcliDir, {
    checkBrokenLinks: true,
    checkMacroSyntax: true,
    checkPageSize: true,
    maxPageSizeKb: 500,
  });

  // Run folder validation
  const folderIssues = validateFolders(absPath);
  if (folderIssues.length > 0) {
    // Add folder issues to result
    for (const issue of folderIssues) {
      result.totalWarnings++;
      // Find or create file result entry
      let fileResult = result.files.find((f) => f.path === issue.file);
      if (!fileResult) {
        fileResult = {
          path: issue.file,
          issues: [],
          hasErrors: false,
          hasWarnings: false,
        };
        result.files.push(fileResult);
      }
      fileResult.issues.push(issue);
      fileResult.hasWarnings = true;
    }
  }

  // JSON output
  if (opts.json) {
    output({
      schemaVersion: "1",
      passed: result.passed,
      totalErrors: result.totalErrors,
      totalWarnings: result.totalWarnings,
      filesChecked: result.filesChecked,
      filesWithIssues: result.files.filter((f) => f.issues.length > 0).length,
      files: result.files.filter((f) => f.issues.length > 0).map((f) => ({
        path: f.path,
        issues: f.issues,
      })),
    }, opts);
  } else {
    // Human-readable output
    output(formatValidationReport(result), opts);
  }

  // Exit with error if validation failed
  if (!result.passed) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "Validation failed");
  }

  // Exit with error in strict mode if there are warnings
  if (strict && result.totalWarnings > 0) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "Validation failed (strict mode: warnings are errors)");
  }
}

/**
 * Convert pages to a different editor format.
 * Supports single file, directory (all tracked pages), or by page ID.
 *
 * --to-new-editor     Convert to new editor (v2)
 * --to-legacy-editor  Convert to legacy editor (v1)
 * --dry-run           Show what would be converted without making changes
 * --confirm           Required for bulk operations (directory/space)
 */
async function handleDocsConvert(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const targetPath = args[0] || ".";
  const toNewEditor = hasFlag(flags, "to-new-editor");
  const toLegacyEditor = hasFlag(flags, "to-legacy-editor");
  const dryRun = hasFlag(flags, "dry-run");
  const confirm = hasFlag(flags, "confirm");

  if (!toNewEditor && !toLegacyEditor) {
    fail(opts, 1, ERROR_CODES.USAGE, "Either --to-new-editor or --to-legacy-editor is required.");
  }

  if (toNewEditor && toLegacyEditor) {
    fail(opts, 1, ERROR_CODES.USAGE, "Cannot specify both --to-new-editor and --to-legacy-editor.");
  }

  const targetVersion: "v2" | "v1" = toNewEditor ? "v2" : "v1";
  const client = await getClient(flags, opts);

  // Resolve path
  const absPath = resolve(targetPath);
  const isFile = absPath.endsWith(".md");

  // Find .atlcli directory
  const atlcliDir = findAtlcliDir(isFile ? dirname(absPath) : absPath);
  if (!atlcliDir) {
    fail(opts, 1, ERROR_CODES.USAGE, "Not in an initialized directory. Run 'docs init' first.");
  }

  const state = await readState(atlcliDir);

  // Collect pages to convert
  let pagesToConvert: Array<{ pageId: string; path: string; title: string }> = [];

  if (isFile) {
    // Single file mode
    const content = await readTextFile(absPath);
    const { frontmatter } = parseFrontmatter(content);

    if (!frontmatter?.id) {
      fail(opts, 1, ERROR_CODES.USAGE, "File is not tracked (no page ID in frontmatter).");
    }

    const relativePath = getRelativePath(atlcliDir, absPath);
    const title = frontmatter.title || relativePath;
    pagesToConvert.push({ pageId: frontmatter.id, path: relativePath, title });
  } else {
    // Directory mode - all tracked pages
    if (!confirm && !dryRun) {
      fail(opts, 1, ERROR_CODES.USAGE, "Bulk conversion requires --confirm flag (or use --dry-run to preview).");
    }

    for (const [pageId, pageState] of Object.entries(state.pages)) {
      // Skip folders - they don't have editor format
      if (pageState.contentType === "folder") continue;
      pagesToConvert.push({ pageId, path: pageState.path, title: pageState.title });
    }
  }

  if (pagesToConvert.length === 0) {
    output(
      opts.json
        ? { schemaVersion: "1", converted: 0, skipped: 0, message: "No pages to convert" }
        : "No pages to convert.",
      opts
    );
    return;
  }

  let converted = 0;
  let skipped = 0;
  const results: Array<{ pageId: string; path: string; title: string; status: string; fromVersion?: string | null }> = [];

  for (const page of pagesToConvert) {
    try {
      const currentVersion = await client.getEditorVersion(page.pageId);

      if (currentVersion === targetVersion) {
        skipped++;
        results.push({ pageId: page.pageId, path: page.path, title: page.title, status: "skipped", fromVersion: currentVersion });
        if (!opts.json && !dryRun) {
          output(`  ${page.path}: already in ${targetVersion === "v2" ? "new" : "legacy"} format`, opts);
        }
        continue;
      }

      if (dryRun) {
        results.push({ pageId: page.pageId, path: page.path, title: page.title, status: "would-convert", fromVersion: currentVersion });
        if (!opts.json) {
          output(`  [dry-run] ${page.path}: would convert from ${currentVersion ?? "legacy"} to ${targetVersion}`, opts);
        }
        converted++;
        continue;
      }

      await client.setEditorVersion(page.pageId, targetVersion);

      // Also update local database
      await setPageEditorVersion(atlcliDir, page.pageId, targetVersion);

      converted++;
      results.push({ pageId: page.pageId, path: page.path, title: page.title, status: "converted", fromVersion: currentVersion });
      if (!opts.json) {
        output(`  ${page.path}: converted from ${currentVersion ?? "legacy"} to ${targetVersion}`, opts);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ pageId: page.pageId, path: page.path, title: page.title, status: "error", fromVersion: message });
      if (!opts.json) {
        output(`  ${page.path}: error - ${message}`, opts);
      }
    }
  }

  output(
    opts.json
      ? { schemaVersion: "1", targetVersion, converted, skipped, dryRun, results }
      : `\n${dryRun ? "[dry-run] " : ""}Conversion complete: ${converted} converted, ${skipped} skipped`,
    opts
  );
}

function docsHelp(): string {
  return `atlcli wiki docs <command>

Commands:
  init <dir> [scope options]                        Initialize directory for sync
  pull [dir] [scope options] [--limit <n>] [--force] [--label <l>] [--comments]
  push [dir|file] [--validate] [--delete-folders]   Push changes to Confluence
  add <file> [--title <t>] [--parent <id>]          Add file to Confluence
  watch <dir> [--space <key>] [--debounce <ms>]
  sync <dir> [scope options] [--poll-interval <ms>] [--label <label>]
  status [dir] [--links]                             Show sync state (--links for link analysis)
  resolve <file> --accept local|remote|merged        Resolve conflicts
  diff <file>                                        Compare local vs remote
  check [path] [--strict] [--json]                   Validate markdown files
  convert <path> --to-new-editor [--dry-run]         Convert to new editor (v2)
  convert <path> --to-legacy-editor [--confirm]      Convert to legacy editor (v1)

Scope options (one required for init/pull/sync):
  --page-id <id>     Single page by ID
  --ancestor <id>    Page tree under parent ID
  --space <key>      Entire space

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output (watch/sync emit JSON lines)
  --force            Overwrite local modifications
  --label <label>    Only sync pages with this label
  --comments         Pull page comments to .comments.json files
  --no-attachments   Skip downloading attachments
  --validate         Run validation before push (fail on errors)
  --strict           Treat warnings as errors (for check and --validate)
  --delete-folders   Confirm deletion of folders removed locally (push)
  --no-auto-create-folders  Don't auto-create folders for directories without index.md
  --legacy-editor    Create pages in legacy editor format (default: new editor v2)
  --links            Analyze link changes vs stored links (status command)
  --skip-user-check  Skip user status checks during pull (faster)
  --refresh-users    Force re-check all users regardless of cache TTL
  --fetch-contributors  Fetch full contributor history (extra API calls)
  --to-new-editor    Convert pages to new editor format (v2)
  --to-legacy-editor Convert pages to legacy editor format (v1)
  --confirm          Required for bulk conversion operations
  --dry-run          Preview conversion without making changes

Files use YAML frontmatter for page ID. Directory structure matches Confluence hierarchy.
State is stored in .atlcli/ directory.

Ignore patterns:
  Create .atlcliignore (gitignore syntax) to exclude files from push/status.
  Patterns from .gitignore are also respected (merged with .atlcliignore).

Validation checks:
  - Broken links (target file not found)
  - Links to untracked pages (warning)
  - Unclosed macros (:::info without :::)
  - Page size exceeding 500KB (warning)

Examples:
  atlcli wiki docs init ./docs --space TEAM              Initialize for entire space
  atlcli wiki docs init ./docs --ancestor 12345          Initialize for page tree
  atlcli wiki docs init ./docs --page-id 67890           Initialize for single page
  atlcli wiki docs pull ./docs                           Pull using saved scope
  atlcli wiki docs pull ./docs --ancestor 99999          Override scope for this pull
  atlcli wiki docs pull ./docs --label architecture      Pull only pages with label
  atlcli wiki docs pull ./docs --comments                Pull pages with comments
  atlcli wiki docs push ./docs                           Push all tracked files
  atlcli wiki docs push ./docs/page.md                   Push single file
  atlcli wiki docs push --page-id 12345                  Push by page ID
  atlcli wiki docs push --validate                       Validate before pushing
  atlcli wiki docs push --validate --strict              Fail on warnings too
  atlcli wiki docs diff ./docs/page.md                   Show local vs remote diff
  atlcli wiki docs check ./docs                          Check for broken links
  atlcli wiki docs check ./docs --strict                 Treat warnings as errors
  atlcli wiki docs check ./docs --json                   JSON output for CI/agents
  atlcli wiki docs convert ./docs/page.md --to-new-editor Convert single page
  atlcli wiki docs convert ./docs --to-new-editor --dry-run Preview bulk conversion
  atlcli wiki docs convert ./docs --to-new-editor --confirm Bulk convert directory

For sync command options: atlcli wiki docs sync --help
`;
}
