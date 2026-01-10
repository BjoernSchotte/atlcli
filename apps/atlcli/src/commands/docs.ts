import { readdir } from "node:fs/promises";
import { FSWatcher, watch } from "node:fs";
import { join, basename, extname } from "node:path";
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
    case "pull":
      await handlePull(flags, opts);
      return;
    case "push":
      await handlePush(args.slice(1), flags, opts);
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

async function handlePull(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const space = getFlag(flags, "space");
  if (!space) {
    fail(opts, 1, ERROR_CODES.USAGE, "--space is required.");
  }
  const outDir = getFlag(flags, "out") ?? "./docs";
  const limit = Number(getFlag(flags, "limit") ?? 50);
  const cql = getFlag(flags, "cql") ?? `space=${space} and type=page`;

  const client = await getClient(flags, opts);
  const pages = await client.searchPages(cql, Number.isNaN(limit) ? 50 : limit);
  await ensureDir(outDir);

  let pulled = 0;
  for (const page of pages) {
    const detail = await client.getPage(page.id);
    const markdown = storageToMarkdown(detail.storage);
    const fileName = `${detail.id}__${slugify(detail.title) || "page"}.md`;
    const filePath = join(outDir, fileName);
    await writeTextFile(filePath, markdown);
    await writeMeta(filePath, {
      id: detail.id,
      title: detail.title,
      spaceKey: detail.spaceKey ?? space,
      version: detail.version ?? 1,
    });
    pulled += 1;
  }

  output(
    {
      schemaVersion: "1",
      results: {
        pulled,
        outDir,
      },
      note: "Markdown conversion supports GFM (tables, task lists, code). Confluence macros may not round-trip.",
    },
    opts
  );
}

async function handlePush(args: string[], flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const dir = args[0] ?? getFlag(flags, "dir") ?? "./docs";
  const space = getFlag(flags, "space");
  const client = await getClient(flags, opts);
  const files = await collectMarkdownFiles(dir);

  let updated = 0;
  let created = 0;
  let skipped = 0;

  for (const filePath of files) {
    const result = await pushFile({ client, filePath, space, opts });
    if (result === "updated") updated += 1;
    else if (result === "created") created += 1;
    else skipped += 1;
  }

  output(
    {
      schemaVersion: "1",
      results: { updated, created, skipped },
      note: "Markdown conversion supports GFM (tables, task lists, code). Confluence macros may not round-trip.",
    },
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
}): Promise<PushResult> {
  const { client, filePath, space, opts } = params;
  const meta = await readMeta(filePath);
  const markdown = await readTextFile(filePath);
  const storage = markdownToStorage(markdown);

  if (meta?.id) {
    const current = await client.getPage(meta.id);
    const title = meta.title || current.title;
    const version = (current.version ?? 1) + 1;
    const page = await client.updatePage({ id: meta.id, title, storage, version });
    await writeMeta(filePath, {
      id: page.id,
      title: page.title,
      spaceKey: page.spaceKey ?? meta.spaceKey ?? space,
      version: page.version ?? version,
    });
    return "updated";
  }

  const targetSpace = meta?.spaceKey ?? space;
  if (!targetSpace) {
    return "skipped";
  }

  const title = meta?.title ?? titleFromFilename(filePath);
  const page = await client.createPage({ spaceKey: targetSpace, title, storage });
  await writeMeta(filePath, {
    id: page.id,
    title: page.title,
    spaceKey: page.spaceKey ?? targetSpace,
    version: page.version ?? 1,
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

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
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
  const dir = args[0] ?? getFlag(flags, "dir") ?? "./docs";
  const files = await collectMarkdownFiles(dir);

  const stats = {
    synced: 0,
    localModified: 0,
    remoteModified: 0,
    conflict: 0,
    untracked: 0,
  };

  const conflicts: { file: string; id?: string }[] = [];

  for (const filePath of files) {
    const meta = await readMeta(filePath);
    if (!meta) {
      stats.untracked++;
      continue;
    }

    if (isEnhancedMeta(meta)) {
      switch (meta.syncState) {
        case "synced":
          stats.synced++;
          break;
        case "local-modified":
          stats.localModified++;
          break;
        case "remote-modified":
          stats.remoteModified++;
          break;
        case "conflict":
          stats.conflict++;
          conflicts.push({ file: filePath, id: meta.id });
          break;
      }
    } else {
      // Legacy metadata - assume synced
      stats.synced++;
    }
  }

  if (opts.json) {
    output({
      schemaVersion: "1",
      dir,
      stats,
      conflicts,
    }, opts);
  } else {
    output(`Sync status for ${dir}:\n`, opts);
    output(`  synced:          ${stats.synced} files`, opts);
    output(`  local-modified:  ${stats.localModified} files`, opts);
    output(`  remote-modified: ${stats.remoteModified} files`, opts);
    output(`  conflict:        ${stats.conflict} files`, opts);
    output(`  untracked:       ${stats.untracked} files`, opts);

    if (conflicts.length > 0) {
      output(`\nConflicts:`, opts);
      for (const c of conflicts) {
        output(`  ${c.file}`, opts);
      }
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
  pull --space <key> [--out <dir>] [--limit <n>] [--cql <query>]
  push <dir> [--space <key>]
  watch <dir> [--space <key>] [--debounce <ms>]
  sync <dir> --space <key> [--poll-interval <ms>]  (bidirectional)
  status [dir]                                      (show sync state)
  resolve <file> --accept local|remote|merged       (resolve conflicts)

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output (watch/sync emit JSON lines)

For sync command options: atlcli docs sync --help
`;
}
