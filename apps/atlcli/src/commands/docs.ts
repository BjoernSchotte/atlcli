import { readdir } from "node:fs/promises";
import { FSWatcher, watch } from "node:fs";
import { join, basename, extname, dirname, relative } from "node:path";
import {
  ConfluenceClient,
  ERROR_CODES,
  OutputOptions,
  ensureDir,
  fail,
  getActiveProfile,
  getFlag,
  hasFlag,
  hashContent,
  loadConfig,
  markdownToStorage,
  normalizeMarkdown,
  output,
  readTextFile,
  resolveConflicts,
  slugify,
  storageToMarkdown,
  writeTextFile,
  // New imports for local storage
  findAtlcliDir,
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
  // Frontmatter
  parseFrontmatter,
  addFrontmatter,
  stripFrontmatter,
  extractTitleFromMarkdown,
  AtlcliFrontmatter,
} from "@atlcli/core";
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

export async function handleDocs(args: string[], flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
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
    default:
      output(docsHelp(), opts);
      return;
  }
}

async function getClient(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<ConfluenceClient> {
  const config = await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(config, profileName);
  if (!profile) {
    fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.", { profile: profileName });
  }
  return new ConfluenceClient(profile);
}

/**
 * Initialize a directory for Confluence sync.
 * Creates .atlcli/ with config.json, state.json, and cache/ directory.
 */
async function handleInit(args: string[], flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const dir = args[0] || ".";
  const space = getFlag(flags, "space");

  if (!space) {
    fail(opts, 1, ERROR_CODES.USAGE, "--space is required.");
  }

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

  await ensureDir(dir);
  await initAtlcliDir(dir, {
    space,
    baseUrl: profile.baseUrl,
    profile: profile.name,
    settings: {
      autoCreatePages: false,
      preserveHierarchy: true,
      defaultParentId: null,
    },
  });

  output(
    opts.json
      ? { schemaVersion: "1", initialized: true, dir, space }
      : `Initialized ${dir}/.atlcli/ for space ${space}`,
    opts
  );
}

async function handlePull(args: string[], flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const outDir = args[0] || getFlag(flags, "out") || ".";
  const limit = Number(getFlag(flags, "limit") ?? 50);
  const force = hasFlag(flags, "force");

  // Check if directory is initialized
  let space = getFlag(flags, "space");
  let atlcliDir = findAtlcliDir(outDir);

  if (atlcliDir) {
    // Use config from .atlcli/
    const dirConfig = await readConfig(atlcliDir);
    space = space || dirConfig.space;
  } else if (!space) {
    fail(opts, 1, ERROR_CODES.USAGE, "--space is required (or run 'docs init' first).");
  }

  const cql = getFlag(flags, "cql") ?? `space=${space} and type=page`;
  const client = await getClient(flags, opts);
  const pages = await client.searchPages(cql, Number.isNaN(limit) ? 50 : limit);

  // If not initialized, auto-init
  if (!atlcliDir) {
    const appConfig = await loadConfig();
    const profileName = getFlag(flags, "profile");
    const profile = getActiveProfile(appConfig, profileName);
    if (profile) {
      await ensureDir(outDir);
      await initAtlcliDir(outDir, {
        space: space!,
        baseUrl: profile.baseUrl,
        profile: profile.name,
      });
      atlcliDir = outDir;
    }
  }

  await ensureDir(outDir);
  const state = atlcliDir ? await readState(atlcliDir) : null;
  const existingPaths = state ? new Set(Object.keys(state.pathIndex)) : new Set<string>();

  let pulled = 0;
  let skipped = 0;

  for (const page of pages) {
    const detail = await client.getPage(page.id);
    const markdown = storageToMarkdown(detail.storage);
    const normalizedMd = normalizeMarkdown(markdown);
    const contentHash = hashContent(normalizedMd);

    // Check if we already have this page
    const existingState = state?.pages[detail.id];
    if (existingState && !force) {
      // Check if local has modifications
      const localPath = join(atlcliDir!, existingState.path);
      try {
        const localContent = await readTextFile(localPath);
        const { content: localWithoutFrontmatter } = parseFrontmatter(localContent);
        const localHash = hashContent(normalizeMarkdown(localWithoutFrontmatter));

        if (localHash !== existingState.baseHash) {
          // Local has modifications, skip unless --force
          output(`Skipping ${existingState.path} (local modifications, use --force)`, opts);
          skipped++;
          continue;
        }
      } catch {
        // File doesn't exist, will be re-created
      }
    }

    // Generate clean filename
    const baseName = slugifyTitle(detail.title) || "page";
    let fileName: string;
    let relativePath: string;

    if (existingState) {
      // Keep existing path
      relativePath = existingState.path;
      fileName = basename(relativePath);
    } else {
      // Generate new unique filename
      fileName = generateUniqueFilename(outDir, baseName, existingPaths);
      relativePath = fileName;
      existingPaths.add(relativePath);
    }

    const filePath = join(outDir, relativePath);

    // Add frontmatter with page ID
    const frontmatter: AtlcliFrontmatter = {
      id: detail.id,
      title: detail.title,
    };
    const contentWithFrontmatter = addFrontmatter(markdown, frontmatter);

    await ensureDir(dirname(filePath));
    await writeTextFile(filePath, contentWithFrontmatter);

    // Update state and cache
    if (state && atlcliDir) {
      updatePageState(state, detail.id, {
        path: relativePath,
        title: detail.title,
        spaceKey: detail.spaceKey ?? space!,
        version: detail.version ?? 1,
        lastSyncedAt: new Date().toISOString(),
        localHash: contentHash,
        remoteHash: contentHash,
        baseHash: contentHash,
        syncState: "synced",
        parentId: null,
      });

      // Write base content for 3-way merge (without frontmatter)
      await writeBaseContent(atlcliDir, detail.id, normalizedMd);
    }

    pulled++;
  }

  // Save state
  if (state && atlcliDir) {
    state.lastSync = new Date().toISOString();
    await writeState(atlcliDir, state);
  }

  output(
    {
      schemaVersion: "1",
      results: { pulled, skipped, outDir },
      note: "Files now use frontmatter for page ID. State saved to .atlcli/",
    },
    opts
  );
}

async function handlePush(args: string[], flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const dir = args[0] ?? getFlag(flags, "dir") ?? ".";
  const client = await getClient(flags, opts);
  const files = await collectMarkdownFiles(dir);

  // Check for .atlcli directory
  const atlcliDir = findAtlcliDir(dir);
  let space = getFlag(flags, "space");
  let state: AtlcliState | undefined;

  if (atlcliDir) {
    const dirConfig = await readConfig(atlcliDir);
    space = space || dirConfig.space;
    state = await readState(atlcliDir);
  }

  let updated = 0;
  let created = 0;
  let skipped = 0;

  for (const filePath of files) {
    const result = await pushFile({ client, filePath, space, opts, atlcliDir: atlcliDir || undefined, state });
    if (result === "updated") updated += 1;
    else if (result === "created") created += 1;
    else skipped += 1;
  }

  // Save state if we have one
  if (state && atlcliDir) {
    state.lastSync = new Date().toISOString();
    await writeState(atlcliDir, state);
  }

  output(
    {
      schemaVersion: "1",
      results: { updated, created, skipped },
      note: "Frontmatter stripped before push. State saved to .atlcli/",
    },
    opts
  );
}

/**
 * Add a local file to Confluence tracking.
 * Creates the page in Confluence and adds frontmatter to the local file.
 */
async function handleAdd(args: string[], flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const filePath = args[0];
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
  const client = await getClient(flags, opts);

  // Read file content
  const content = await readTextFile(filePath);
  const { frontmatter: existingFrontmatter, content: markdownContent } = parseFrontmatter(content);

  // Check if already tracked
  if (existingFrontmatter?.id) {
    fail(opts, 1, ERROR_CODES.USAGE, `File already tracked with page ID: ${existingFrontmatter.id}`);
  }

  // Get title: --title flag > H1 heading > filename
  let title = getFlag(flags, "title");
  if (!title) {
    title = extractTitleFromMarkdown(markdownContent);
  }
  if (!title) {
    title = titleFromFilename(filePath);
  }

  // Get parent page ID if specified
  const parentId = getFlag(flags, "parent");

  // Get space (from flag or config)
  const space = getFlag(flags, "space") || dirConfig.space;

  // Convert to storage format (strip frontmatter if any)
  const storage = markdownToStorage(markdownContent);

  // Create page in Confluence
  const page = await client.createPage({
    spaceKey: space,
    title,
    storage,
    parentId: parentId || dirConfig.settings?.defaultParentId || undefined,
  });

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
  });

  await writeState(atlcliDir, state);

  // Write base content for 3-way merge
  await writeBaseContent(atlcliDir, page.id, normalizedMd);

  output(
    opts.json
      ? { schemaVersion: "1", added: true, pageId: page.id, title: page.title, path: relativePath }
      : `Added ${relativePath} as page "${page.title}" (ID: ${page.id})`,
    opts
  );
}

async function handleWatch(args: string[], flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const dir = args[0] ?? getFlag(flags, "dir") ?? "./docs";
  const space = getFlag(flags, "space");
  const debounceMs = Number(getFlag(flags, "debounce") ?? 500);
  const client = await getClient(flags, opts);

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
          const result = await pushFile({ client, filePath: file, space, opts });
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
}): Promise<PushResult> {
  const { client, filePath, space, opts, atlcliDir, state } = params;

  // Read file and parse frontmatter
  const rawContent = await readTextFile(filePath);
  const { frontmatter, content: markdownContent } = parseFrontmatter(rawContent);

  // Also check legacy .meta.json
  const legacyMeta = await readMeta(filePath);

  // Get page ID from frontmatter or legacy meta
  const pageId = frontmatter?.id || legacyMeta?.id;

  // Strip frontmatter before converting to storage format
  const storage = markdownToStorage(markdownContent);

  if (pageId) {
    // Update existing page
    const current = await client.getPage(pageId);
    const title = frontmatter?.title || legacyMeta?.title || current.title;
    const version = (current.version ?? 1) + 1;
    const page = await client.updatePage({ id: pageId, title, storage, version });

    // Update state if available
    if (atlcliDir && state) {
      const relativePath = getRelativePath(atlcliDir, filePath);
      const normalizedMd = normalizeMarkdown(markdownContent);
      const contentHash = hashContent(normalizedMd);

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
        parentId: null,
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
    return "updated";
  }

  // No page ID - skip (use 'docs add' to create new pages)
  const targetSpace = legacyMeta?.spaceKey ?? space;
  if (!targetSpace) {
    return "skipped";
  }

  // For backwards compatibility, still create if legacy meta exists with space
  const title = legacyMeta?.title ?? titleFromFilename(filePath);
  const page = await client.createPage({ spaceKey: targetSpace, title, storage });

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
      parentId: null,
    });

    await writeBaseContent(atlcliDir, page.id, normalizedMd);
  }

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

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    // Skip .atlcli directory and other hidden directories
    if (entry.name.startsWith(".")) {
      continue;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectMarkdownFiles(fullPath)));
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

function titleFromFilename(path: string): string {
  const file = basename(path, extname(path));
  const cleaned = file.replace(/^[0-9]+__/, "");
  return cleaned.replace(/[-_]+/g, " ").trim() || "Untitled";
}

/**
 * Show sync status of all tracked files.
 */
async function handleStatus(args: string[], flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const dir = args[0] ?? getFlag(flags, "dir") ?? ".";
  const files = await collectMarkdownFiles(dir);

  // Check for .atlcli directory
  const atlcliDir = findAtlcliDir(dir);
  const state = atlcliDir ? await readState(atlcliDir) : null;

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

  if (opts.json) {
    output({
      schemaVersion: "1",
      dir,
      stats,
      conflicts,
      modified,
      untracked,
      lastSync: state?.lastSync,
    }, opts);
  } else {
    output(`Sync status for ${dir}:\n`, opts);
    output(`  synced:          ${stats.synced} files`, opts);
    output(`  local-modified:  ${stats.localModified} files`, opts);
    output(`  remote-modified: ${stats.remoteModified} files`, opts);
    output(`  conflict:        ${stats.conflict} files`, opts);
    output(`  untracked:       ${stats.untracked} files`, opts);

    if (state?.lastSync) {
      output(`\nLast sync: ${state.lastSync}`, opts);
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
  }
}

/**
 * Resolve conflicts in a file.
 */
async function handleResolve(args: string[], flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
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
  output("Run 'atlcli docs push' to push the resolved version.", opts);
}

function docsHelp(): string {
  return `atlcli docs <command>

Commands:
  init <dir> --space <key>                          Initialize directory for sync
  pull [dir] [--space <key>] [--limit <n>] [--cql] [--force]
  push [dir] [--space <key>]
  add <file> [--title <t>] [--parent <id>]          Add file to Confluence
  watch <dir> [--space <key>] [--debounce <ms>]
  sync <dir> --space <key> [--poll-interval <ms>]   Bidirectional sync
  status [dir]                                       Show sync state
  resolve <file> --accept local|remote|merged        Resolve conflicts

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output (watch/sync emit JSON lines)

Files use YAML frontmatter for page ID. State is stored in .atlcli/ directory.

For sync command options: atlcli docs sync --help
`;
}
