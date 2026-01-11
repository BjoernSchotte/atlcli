import { readdir, writeFile, unlink } from "node:fs/promises";
import { FSWatcher, watch } from "node:fs";
import { join, basename, extname, dirname } from "node:path";
import {
  ERROR_CODES,
  OutputOptions,
  ensureDir,
  fail,
  getActiveProfile,
  getFlag,
  hasFlag,
  loadConfig,
  output,
  readTextFile,
  slugify,
  writeTextFile,
} from "@atlcli/core";
import {
  ConfluenceClient,
  SyncScope,
  ConfluencePoller,
  hashContent,
  markdownToStorage,
  normalizeMarkdown,
  storageToMarkdown,
  threeWayMerge,
  hasConflictMarkers,
  resolveConflicts,
  WebhookServer,
  WebhookPayload,
  parseFrontmatter,
  addFrontmatter,
  AtlcliFrontmatter,
  // Config
  findAtlcliDir,
  readConfig,
  getConfigScope,
  isConfigV2,
  ConfigScope,
  // Hierarchy
  computeFilePath,
  buildPathMap,
  hasPageMoved,
  moveFile,
  PageHierarchyInfo,
  slugifyTitle,
  // Scope
  parseScope,
  scopeToString,
  // Ignore
  loadIgnorePatterns,
  shouldIgnore,
} from "@atlcli/confluence";
import type { Ignore } from "ignore";

import {
  EnhancedMeta,
  SyncState,
  createEnhancedMeta,
  computeSyncState,
  readBase,
  writeBase,
} from "./docs.js";

/** Sync daemon options */
interface SyncOptions {
  dir: string;
  scope: SyncScope;
  pollIntervalMs: number;
  onConflict: "merge" | "local" | "remote" | "prompt";
  dryRun: boolean;
  noWatch: boolean;
  noPoll: boolean;
  json: boolean;
  autoCreate: boolean;
  webhookPort?: number;
  webhookUrl?: string;
  labelFilter?: string;
}

/** Sync event for output */
interface SyncEvent {
  type: "pull" | "push" | "conflict" | "error" | "status";
  file?: string;
  pageId?: string;
  message: string;
  details?: Record<string, unknown>;
}

export async function handleSync(
  args: string[],
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<void> {
  // Show help if requested
  if (hasFlag(flags, "help") || hasFlag(flags, "h")) {
    output(syncHelp(), opts);
    return;
  }

  // Parse scope from flags or config
  const parsedScope = parseScope(flags);
  let scope: SyncScope;
  let resolvedSpaceKey: string | undefined;

  // Get directory path first to check for config
  const dir = args[0] ?? getFlag(flags, "dir") ?? "./docs";

  if (parsedScope) {
    // Use scope from flags
    scope = parsedScope.scope;
    resolvedSpaceKey = parsedScope.spaceKey;
  } else {
    // Try to read scope from .atlcli config
    const atlcliRoot = findAtlcliDir(dir);
    if (atlcliRoot) {
      try {
        const dirConfig = await readConfig(atlcliRoot);
        const configScope = getConfigScope(dirConfig);
        resolvedSpaceKey = dirConfig.space;

        // Convert ConfigScope to SyncScope
        if (configScope.type === "page") {
          scope = { type: "page", pageId: configScope.pageId };
        } else if (configScope.type === "tree") {
          scope = { type: "tree", ancestorId: configScope.ancestorId };
        } else {
          scope = { type: "space", spaceKey: resolvedSpaceKey };
        }
      } catch {
        fail(opts, 1, ERROR_CODES.USAGE, "One of --page-id, --ancestor, or --space is required (no valid config found).");
        return;
      }
    } else {
      fail(opts, 1, ERROR_CODES.USAGE, "One of --page-id, --ancestor, or --space is required.");
      return;
    }
  }

  const webhookPortStr = getFlag(flags, "webhook-port");
  const labelFilter = getFlag(flags, "label");
  const syncOpts: SyncOptions = {
    dir,
    scope,
    pollIntervalMs: Number(getFlag(flags, "poll-interval") ?? 30000),
    onConflict: (getFlag(flags, "on-conflict") as any) ?? "merge",
    dryRun: hasFlag(flags, "dry-run"),
    noWatch: hasFlag(flags, "no-watch"),
    noPoll: hasFlag(flags, "no-poll"),
    json: opts.json,
    autoCreate: hasFlag(flags, "auto-create"),
    webhookPort: webhookPortStr ? Number(webhookPortStr) : undefined,
    webhookUrl: getFlag(flags, "webhook-url"),
    labelFilter,
  };

  const config = await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(config, profileName);
  if (!profile) {
    fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.");
    return;
  }

  const client = new ConfluenceClient(profile);
  await ensureDir(syncOpts.dir);

  // Create sync engine
  const engine = new SyncEngine(client, syncOpts, opts);

  // Initial sync
  await engine.initialSync();

  // Start daemon
  if (!syncOpts.dryRun) {
    await engine.start();
  }
}

/**
 * Main sync engine that coordinates file watching, polling, and merging.
 */
class SyncEngine {
  private client: ConfluenceClient;
  private opts: SyncOptions;
  private outputOpts: OutputOptions;
  private poller: ConfluencePoller | null = null;
  private webhookServer: WebhookServer | null = null;
  private watchers: FSWatcher[] = [];
  private fileToMeta: Map<string, EnhancedMeta> = new Map();
  private idToFile: Map<string, string> = new Map();
  private pushQueue: Set<string> = new Set();
  private pushTimer: NodeJS.Timeout | null = null;
  private debounceMs = 500;
  private lockFilePath: string;
  private ignore: Ignore | null = null;

  constructor(client: ConfluenceClient, opts: SyncOptions, outputOpts: OutputOptions) {
    this.lockFilePath = join(opts.dir, ".atlcli", ".sync.lock");
    this.client = client;
    this.opts = opts;
    this.outputOpts = outputOpts;
  }

  /** Emit a sync event to output */
  private emit(event: SyncEvent): void {
    if (this.outputOpts.json) {
      process.stdout.write(JSON.stringify({ schemaVersion: "1", ...event }) + "\n");
    } else {
      const prefix = event.type === "error" ? "ERROR" : event.type.toUpperCase();
      output(`[${prefix}] ${event.message}`, this.outputOpts);
    }
  }

  /** Initial sync - pull all pages and establish baseline */
  async initialSync(): Promise<void> {
    this.emit({ type: "status", message: "Starting initial sync..." });

    // Get all pages in scope, optionally filtered by label
    let pages: { id: string; title: string; version: number; spaceKey?: string }[];

    if (this.opts.labelFilter) {
      // Use label-filtered search
      if (this.opts.scope.type === "space") {
        pages = await this.client.getPagesByLabel(this.opts.labelFilter, {
          spaceKey: this.opts.scope.spaceKey,
        });
      } else if (this.opts.scope.type === "tree") {
        // For tree scope with label, get all pages in tree then filter by label
        const allPages = await this.client.getAllPages({ scope: this.opts.scope });
        pages = [];
        for (const page of allPages) {
          const labels = await this.client.getLabels(page.id);
          if (labels.some((l) => l.name === this.opts.labelFilter)) {
            pages.push(page);
          }
        }
      } else {
        // Single page scope - check if page has the label
        const pageId = this.opts.scope.pageId;
        const labels = await this.client.getLabels(pageId);
        if (labels.some((l) => l.name === this.opts.labelFilter)) {
          pages = await this.client.getAllPages({ scope: this.opts.scope });
        } else {
          this.emit({
            type: "status",
            message: `Page does not have label "${this.opts.labelFilter}", skipping.`,
          });
          pages = [];
        }
      }
    } else {
      pages = await this.client.getAllPages({ scope: this.opts.scope });
    }

    this.emit({ type: "status", message: `Found ${pages.length} pages in scope` });

    // Load existing local files - check both .meta.json and frontmatter
    const existingFiles = await this.collectMarkdownFiles(this.opts.dir);
    for (const filePath of existingFiles) {
      // First try .meta.json
      let meta = await this.readMeta(filePath);
      let pageId = meta?.id;

      // If no meta, check frontmatter
      if (!pageId) {
        try {
          const content = await readTextFile(filePath);
          const { frontmatter } = parseFrontmatter(content);
          if (frontmatter?.id) {
            pageId = frontmatter.id;
            // Create a minimal meta from frontmatter
            meta = {
              id: frontmatter.id,
              title: frontmatter.title || basename(filePath, ".md"),
              spaceKey: "",
              version: 0, // Unknown version - will check remote
              lastSyncedAt: "",
              localHash: "",
              remoteHash: "",
              baseHash: "",
              syncState: "synced",
            };
          }
        } catch {
          // File read error, skip
        }
      }

      if (pageId && meta) {
        this.fileToMeta.set(filePath, meta as EnhancedMeta);
        this.idToFile.set(pageId, filePath);
      }
    }

    // Sync each page
    for (const pageInfo of pages) {
      const existingFile = this.idToFile.get(pageInfo.id);

      if (existingFile) {
        // Check for changes
        const meta = this.fileToMeta.get(existingFile);
        if (meta && pageInfo.version > meta.version) {
          // Remote has newer version - pull
          await this.pullPage(pageInfo.id, existingFile);
        }
      } else {
        // New page - create local file
        await this.pullPage(pageInfo.id);
      }
    }

    this.emit({ type: "status", message: "Initial sync complete" });
  }

  /** Start the sync daemon */
  async start(): Promise<void> {
    // Load ignore patterns
    const ignoreResult = await loadIgnorePatterns(this.opts.dir);
    this.ignore = ignoreResult.ignore;

    // Create lockfile to signal sync daemon is running
    // This is used by plugin-git to skip auto-push when sync is active
    await this.createLockFile();

    const webhookEnabled = !!this.opts.webhookPort;
    this.emit({
      type: "status",
      message: `Sync daemon started (poll: ${this.opts.noPoll ? "disabled" : this.opts.pollIntervalMs + "ms"}, watch: ${this.opts.noWatch ? "disabled" : "enabled"}, webhook: ${webhookEnabled ? "port " + this.opts.webhookPort : "disabled"})`,
    });

    // Start webhook server if configured
    if (this.opts.webhookPort) {
      // Build filter based on scope
      const filterPageIds = this.opts.scope.type === "page"
        ? new Set([this.opts.scope.pageId])
        : undefined;
      const filterSpaceKeys = this.opts.scope.type === "space"
        ? new Set([this.opts.scope.spaceKey])
        : undefined;

      this.webhookServer = new WebhookServer({
        port: this.opts.webhookPort,
        filterPageIds,
        filterSpaceKeys,
      });

      this.webhookServer.on(async (payload: WebhookPayload) => {
        if (!payload.page) return;

        this.emit({
          type: "status",
          message: `Webhook received: ${payload.eventType} for ${payload.page.title}`,
          details: { pageId: payload.page.id, event: payload.eventType },
        });

        const file = this.idToFile.get(payload.page.id);

        if (payload.eventType === "page_updated" || payload.eventType === "page_created") {
          await this.handleRemoteChange(payload.page.id, file);
        } else if (payload.eventType === "page_removed" || payload.eventType === "page_trashed") {
          if (file) {
            this.emit({
              type: "status",
              message: `Remote page deleted: ${payload.page.title}`,
              details: { pageId: payload.page.id, file },
            });
          }
        }
      });

      this.webhookServer.start();
      this.emit({
        type: "status",
        message: `Webhook server listening on http://localhost:${this.opts.webhookPort}/webhook`,
      });

      // Register webhook with Confluence if URL provided
      if (this.opts.webhookUrl) {
        try {
          const registration = await this.client.registerWebhook({
            name: "atlcli-sync",
            url: this.opts.webhookUrl,
            events: ["page_created", "page_updated", "page_removed", "page_trashed"],
          });
          this.emit({
            type: "status",
            message: `Webhook registered with Confluence: ${registration.id}`,
          });
        } catch (err) {
          this.emit({
            type: "error",
            message: `Failed to register webhook: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    // Start poller
    if (!this.opts.noPoll) {
      this.poller = new ConfluencePoller({
        client: this.client,
        scope: this.opts.scope,
        intervalMs: this.opts.pollIntervalMs,
      });

      this.poller.on(async (event) => {
        const file = this.idToFile.get(event.pageId);
        if (event.type === "changed" || event.type === "created") {
          await this.handleRemoteChange(event.pageId, file);
        } else if (event.type === "deleted" && file) {
          this.emit({
            type: "status",
            message: `Remote page deleted: ${event.title}`,
            details: { pageId: event.pageId, file },
          });
        }
      });

      await this.poller.initialize();
      this.poller.start();
    }

    // Start file watcher with hash-based change detection
    if (!this.opts.noWatch) {
      this.watchers = await this.createWatchers(this.opts.dir, async (filePath) => {
        if (extname(filePath).toLowerCase() !== ".md") return;
        if (filePath.endsWith(".base")) return;

        // Skip ignored files
        if (this.ignore) {
          const relativePath = filePath.replace(this.opts.dir + "/", "");
          if (shouldIgnore(this.ignore, relativePath)) return;
        }

        // Hash-based detection: only push if content actually changed
        const hasChanged = await this.hasContentChanged(filePath);
        if (!hasChanged) return;

        this.schedulePush(filePath);
      });
    }

    // Handle shutdown
    process.on("SIGINT", () => this.stop());
    process.on("SIGTERM", () => this.stop());
  }

  /** Stop the sync daemon */
  stop(): void {
    this.emit({ type: "status", message: "Stopping sync daemon..." });

    // Remove lockfile
    this.removeLockFile();

    if (this.webhookServer) {
      this.webhookServer.stop();
    }

    if (this.poller) {
      this.poller.stop();
    }

    for (const watcher of this.watchers) {
      watcher.close();
    }

    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
    }

    process.exit(0);
  }

  /** Create lockfile to signal sync daemon is running */
  private async createLockFile(): Promise<void> {
    try {
      const lockData = JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
      });
      await writeFile(this.lockFilePath, lockData);
    } catch {
      // Ignore errors - lockfile is optional
    }
  }

  /** Remove lockfile on shutdown */
  private removeLockFile(): void {
    try {
      // Use sync version to ensure it runs during process exit
      const { unlinkSync } = require("node:fs");
      unlinkSync(this.lockFilePath);
    } catch {
      // Ignore errors - file may not exist
    }
  }

  /** Handle a remote change detected by polling */
  private async handleRemoteChange(pageId: string, existingFile?: string): Promise<void> {
    if (existingFile) {
      const meta = this.fileToMeta.get(existingFile);
      const localContent = await readTextFile(existingFile);

      if (meta) {
        const syncState = computeSyncState({
          localContent,
          meta,
          remoteVersion: undefined, // Will be fetched
        });

        if (syncState === "local-modified") {
          // Both changed - need merge
          await this.mergeChanges(pageId, existingFile, localContent, meta);
        } else {
          // Only remote changed - pull
          await this.pullPage(pageId, existingFile);
        }
      } else {
        await this.pullPage(pageId, existingFile);
      }
    } else {
      // New page
      await this.pullPage(pageId);
    }
  }

  /** Pull a page from Confluence using nested hierarchy paths */
  private async pullPage(pageId: string, existingFile?: string): Promise<void> {
    try {
      const page = await this.client.getPage(pageId);
      const markdown = storageToMarkdown(page.storage);

      // Get page ancestors for hierarchy-based path
      const ancestors = page.ancestors || [];
      const ancestorIds = ancestors.map((a) => a.id);

      // Build ancestor title map for path computation
      const ancestorTitles = new Map<string, string>();
      for (const ancestor of ancestors) {
        ancestorTitles.set(ancestor.id, ancestor.title);
      }

      // Compute nested path based on hierarchy
      const pageInfo: PageHierarchyInfo = {
        id: page.id,
        title: page.title,
        parentId: page.parentId ?? null,
        ancestors: ancestorIds,
      };

      // Get existing paths to avoid collisions
      const existingPaths = new Set<string>();
      for (const [file, _meta] of this.fileToMeta) {
        const relativePath = file.startsWith(this.opts.dir)
          ? file.slice(this.opts.dir.length + 1)
          : file;
        existingPaths.add(relativePath);
      }

      const computed = computeFilePath(pageInfo, ancestorTitles, existingPaths);
      let filePath = join(this.opts.dir, computed.relativePath);

      // Check if page has moved (existing file but different path)
      if (existingFile && existingFile !== filePath) {
        // Page moved in Confluence - check if ancestors changed
        const existingMeta = this.fileToMeta.get(existingFile);
        if (existingMeta && "ancestors" in existingMeta) {
          const oldAncestors = (existingMeta as any).ancestors || [];
          if (hasPageMoved(oldAncestors, ancestorIds)) {
            if (!this.opts.dryRun) {
              // Get relative paths for moveFile (it expects relative paths)
              const oldRelPath = existingFile.startsWith(this.opts.dir + "/")
                ? existingFile.slice(this.opts.dir.length + 1)
                : existingFile;

              // Move the local file to match new hierarchy
              await moveFile(this.opts.dir, oldRelPath, computed.relativePath);
              // Also move .meta.json and .base files
              await moveFile(this.opts.dir, `${oldRelPath}.meta.json`, `${computed.relativePath}.meta.json`).catch(() => {});
              await moveFile(this.opts.dir, `${oldRelPath}.base`, `${computed.relativePath}.base`).catch(() => {});

              this.emit({
                type: "status",
                message: `Moved: ${existingFile} → ${filePath}`,
                file: filePath,
                pageId: page.id,
              });
            } else {
              this.emit({
                type: "status",
                message: `Would move: ${existingFile} → ${filePath}`,
                file: filePath,
                pageId: page.id,
              });
            }

            // Update internal tracking
            this.fileToMeta.delete(existingFile);
            this.idToFile.set(page.id, filePath);
          }
        }
      } else if (existingFile) {
        // Use existing file path if no move detected
        filePath = existingFile;
      }

      if (this.opts.dryRun) {
        this.emit({
          type: "pull",
          message: `Would pull: ${page.title}`,
          file: filePath,
          pageId: page.id,
        });
        return;
      }

      // Ensure directory exists for nested path
      const dir = dirname(filePath);
      await ensureDir(dir);

      // Add frontmatter with page ID and title
      const frontmatter: AtlcliFrontmatter = {
        id: page.id,
        title: page.title,
      };
      const contentWithFrontmatter = addFrontmatter(markdown, frontmatter);
      await writeTextFile(filePath, contentWithFrontmatter);

      // Create enhanced metadata with ancestors
      const meta = createEnhancedMeta({
        id: page.id,
        title: page.title,
        spaceKey: page.spaceKey ?? "",
        version: page.version ?? 1,
        localContent: markdown,
        remoteContent: markdown,
      });
      // Add ancestors to meta for move detection
      (meta as any).ancestors = ancestorIds;
      (meta as any).parentId = page.parentId ?? null;

      await this.writeMeta(filePath, meta);
      await writeBase(filePath, markdown);

      this.fileToMeta.set(filePath, meta);
      this.idToFile.set(page.id, filePath);

      this.emit({
        type: "pull",
        message: `Pulled: ${page.title}`,
        file: filePath,
        pageId: page.id,
      });
    } catch (err) {
      this.emit({
        type: "error",
        message: `Failed to pull page ${pageId}: ${err instanceof Error ? err.message : String(err)}`,
        pageId,
      });
    }
  }

  /** Check if file content has changed from last synced state (hash-based) */
  private async hasContentChanged(filePath: string): Promise<boolean> {
    try {
      const content = await readTextFile(filePath);
      const { content: markdownContent } = parseFrontmatter(content);
      const currentHash = hashContent(normalizeMarkdown(markdownContent));

      // Check against stored localHash in metadata
      const meta = this.fileToMeta.get(filePath);
      if (!meta) {
        // No metadata = new file or untracked, treat as changed
        return true;
      }

      // Only changed if hash differs
      return currentHash !== meta.localHash;
    } catch {
      // File read error, skip
      return false;
    }
  }

  /** Schedule a push (debounced) */
  private schedulePush(filePath: string): void {
    this.pushQueue.add(filePath);
    if (this.pushTimer) return;

    this.pushTimer = setTimeout(async () => {
      const files = Array.from(this.pushQueue);
      this.pushQueue.clear();
      this.pushTimer = null;

      for (const file of files) {
        await this.pushFile(file);
      }
    }, this.debounceMs);
  }

  /** Push a local file to Confluence */
  private async pushFile(filePath: string): Promise<void> {
    try {
      let meta = await this.readMeta(filePath);
      const localContent = await readTextFile(filePath);

      // Parse frontmatter to get page ID and clean content
      const { frontmatter, content: markdownContent } = parseFrontmatter(localContent);

      // Get page ID from meta or frontmatter
      const pageId = meta?.id || frontmatter?.id;

      // Check for conflict markers
      if (hasConflictMarkers(markdownContent)) {
        this.emit({
          type: "conflict",
          message: `File has unresolved conflicts: ${filePath}`,
          file: filePath,
        });
        return;
      }

      // Convert markdown (without frontmatter) to storage format
      const storage = markdownToStorage(markdownContent);

      if (pageId) {
        // Create minimal meta if we only have frontmatter
        if (!meta && frontmatter) {
          meta = {
            id: frontmatter.id!,
            title: frontmatter.title || basename(filePath, ".md"),
            spaceKey: "",
            version: 0,
            lastSyncedAt: "",
            localHash: "",
            remoteHash: "",
            baseHash: "",
            syncState: "synced",
          };
        }
        // Update existing page
        const current = await this.client.getPage(pageId);

        // Check if remote changed since last sync
        if (meta!.version && current.version && current.version > meta!.version) {
          // Remote changed - need merge
          await this.mergeChanges(pageId, filePath, markdownContent, meta as EnhancedMeta);
          return;
        }

        if (this.opts.dryRun) {
          this.emit({
            type: "push",
            message: `Would push: ${filePath}`,
            file: filePath,
            pageId,
          });
          return;
        }

        const version = (current.version ?? 1) + 1;
        const page = await this.client.updatePage({
          id: pageId,
          title: meta!.title ?? current.title,
          storage,
          version,
        });

        // Update metadata
        const newMeta = createEnhancedMeta({
          id: page.id,
          title: page.title,
          spaceKey: page.spaceKey ?? (meta as any).spaceKey ?? "",
          version: page.version ?? version,
          localContent: markdownContent,
          remoteContent: markdownContent,
        });

        await this.writeMeta(filePath, newMeta);
        await writeBase(filePath, markdownContent);
        this.fileToMeta.set(filePath, newMeta);

        this.emit({
          type: "push",
          message: `Pushed: ${page.title}`,
          file: filePath,
          pageId: page.id,
        });
      } else if (this.opts.autoCreate) {
        // Auto-create new page for untracked file
        const title = frontmatter?.title || basename(filePath, ".md").replace(/-/g, " ");

        // Get space key from scope
        let spaceKey: string;
        if (this.opts.scope.type === "space") {
          spaceKey = this.opts.scope.spaceKey;
        } else if (this.opts.scope.type === "tree") {
          // Get space from ancestor page
          const ancestor = await this.client.getPage(this.opts.scope.ancestorId);
          spaceKey = ancestor.spaceKey ?? "";
        } else {
          // Single page scope - get space from that page
          const refPage = await this.client.getPage(this.opts.scope.pageId);
          spaceKey = refPage.spaceKey ?? "";
        }

        if (this.opts.dryRun) {
          this.emit({
            type: "push",
            message: `Would create: ${title} in space ${spaceKey}`,
            file: filePath,
          });
          return;
        }

        // Create the page
        const parentId = this.opts.scope.type === "tree" ? this.opts.scope.ancestorId : undefined;
        const page = await this.client.createPage({
          spaceKey,
          title,
          storage,
          parentId,
        });

        // Add frontmatter to local file
        const newFrontmatter: AtlcliFrontmatter = { id: page.id, title: page.title };
        const contentWithFrontmatter = addFrontmatter(markdownContent, newFrontmatter);
        await writeTextFile(filePath, contentWithFrontmatter);

        // Create metadata
        const newMeta = createEnhancedMeta({
          id: page.id,
          title: page.title,
          spaceKey: page.spaceKey ?? spaceKey,
          version: page.version ?? 1,
          localContent: markdownContent,
          remoteContent: markdownContent,
        });

        await this.writeMeta(filePath, newMeta);
        await writeBase(filePath, markdownContent);
        this.fileToMeta.set(filePath, newMeta);
        this.idToFile.set(page.id, filePath);

        this.emit({
          type: "push",
          message: `Created: ${page.title} (ID: ${page.id})`,
          file: filePath,
          pageId: page.id,
        });
      } else {
        // Skip files without metadata (not tracked)
        this.emit({
          type: "status",
          message: `Skipping untracked file: ${filePath}`,
          file: filePath,
        });
      }
    } catch (err) {
      this.emit({
        type: "error",
        message: `Failed to push ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        file: filePath,
      });
    }
  }

  /** Merge local and remote changes */
  private async mergeChanges(
    pageId: string,
    filePath: string,
    localContent: string,
    meta: EnhancedMeta
  ): Promise<void> {
    try {
      // Get remote content
      const remotePage = await this.client.getPage(pageId);
      const remoteContent = storageToMarkdown(remotePage.storage);

      // Get base content
      const baseContent = await readBase(filePath);
      if (!baseContent) {
        // No base - can't do three-way merge, treat as conflict
        this.emit({
          type: "conflict",
          message: `No base version for merge: ${filePath}`,
          file: filePath,
          pageId,
        });
        return;
      }

      // Perform three-way merge
      const result = threeWayMerge(baseContent, localContent, remoteContent);

      if (result.success) {
        // Auto-merge succeeded
        if (this.opts.dryRun) {
          this.emit({
            type: "status",
            message: `Would auto-merge: ${filePath}`,
            file: filePath,
            pageId,
          });
          return;
        }

        await writeTextFile(filePath, result.content);

        // Push merged content
        const storage = markdownToStorage(result.content);
        const version = (remotePage.version ?? 1) + 1;
        const page = await this.client.updatePage({
          id: pageId,
          title: meta.title,
          storage,
          version,
        });

        // Update metadata
        const newMeta = createEnhancedMeta({
          id: page.id,
          title: page.title,
          spaceKey: page.spaceKey ?? meta.spaceKey,
          version: page.version ?? version,
          localContent: result.content,
          remoteContent: result.content,
        });

        await this.writeMeta(filePath, newMeta);
        await writeBase(filePath, result.content);
        this.fileToMeta.set(filePath, newMeta);

        this.emit({
          type: "push",
          message: `Auto-merged and pushed: ${meta.title}`,
          file: filePath,
          pageId,
        });
      } else {
        // Merge has conflicts
        if (this.opts.onConflict === "local") {
          // Use local version
          await this.pushFile(filePath);
        } else if (this.opts.onConflict === "remote") {
          // Use remote version
          await this.pullPage(pageId, filePath);
        } else {
          // Write conflict markers
          if (!this.opts.dryRun) {
            await writeTextFile(filePath, result.content);

            // Update metadata to conflict state
            const conflictMeta: EnhancedMeta = {
              ...meta,
              syncState: "conflict",
            };
            await this.writeMeta(filePath, conflictMeta);
            this.fileToMeta.set(filePath, conflictMeta);
          }

          this.emit({
            type: "conflict",
            message: `Merge conflict (${result.conflictCount} regions): ${filePath}`,
            file: filePath,
            pageId,
            details: { conflictCount: result.conflictCount },
          });
        }
      }
    } catch (err) {
      this.emit({
        type: "error",
        message: `Merge failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        file: filePath,
        pageId,
      });
    }
  }

  // Helper methods

  private async readMeta(path: string): Promise<EnhancedMeta | null> {
    try {
      const raw = await readTextFile(`${path}.meta.json`);
      return JSON.parse(raw) as EnhancedMeta;
    } catch {
      return null;
    }
  }

  private async writeMeta(path: string, meta: EnhancedMeta): Promise<void> {
    await writeTextFile(`${path}.meta.json`, JSON.stringify(meta, null, 2));
  }

  private async collectMarkdownFiles(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const results: string[] = [];

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        // Check if path should be ignored
        if (this.ignore) {
          const relativePath = fullPath.replace(this.opts.dir + "/", "");
          if (shouldIgnore(this.ignore, relativePath)) {
            continue;
          }
        }

        if (entry.isDirectory()) {
          results.push(...(await this.collectMarkdownFiles(fullPath)));
        } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md" && !entry.name.endsWith(".base")) {
          results.push(fullPath);
        }
      }

      return results;
    } catch {
      return [];
    }
  }

  private async createWatchers(
    dir: string,
    onChange: (filePath: string) => void
  ): Promise<FSWatcher[]> {
    const watchers: FSWatcher[] = [];
    const dirs = await this.collectDirs(dir);

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

  private async collectDirs(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const results = [dir];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = join(dir, entry.name);

        // Skip ignored directories
        if (this.ignore) {
          const relativePath = fullPath.replace(this.opts.dir + "/", "");
          if (shouldIgnore(this.ignore, relativePath)) continue;
        }

        results.push(...(await this.collectDirs(fullPath)));
      }

      return results;
    } catch {
      return [dir];
    }
  }
}

export function syncHelp(): string {
  return `atlcli docs sync <dir> [options]

Start bidirectional sync daemon for Confluence pages.

Scope options (uses .atlcli/config.json scope if not specified):
  --page-id <id>        Sync single page by ID
  --ancestor <id>       Sync page tree under parent ID
  --space <key>         Sync entire space

Filter options:
  --label <label>       Only sync pages with this label

Behavior options:
  --poll-interval <ms>  Polling interval in ms (default: 30000)
  --no-poll             Disable polling (local watch only)
  --no-watch            Disable local file watching (poll only)
  --on-conflict <mode>  Conflict handling: merge|local|remote (default: merge)
  --auto-create         Auto-create Confluence pages for new local files
  --dry-run             Show what would sync without changes
  --json                JSON output for scripting
  --profile <name>      Use specific auth profile

Webhook options (optional, for real-time updates):
  --webhook-port <port> Start webhook server on port
  --webhook-url <url>   Public URL to register with Confluence

Examples:
  # Sync using scope from .atlcli/config.json
  atlcli docs sync ./docs

  # Sync with explicit scope
  atlcli docs sync ./docs --space DEV
  atlcli docs sync ./docs --ancestor 12345 --poll-interval 10000
  atlcli docs sync ./docs --page-id 12345

  # Sync only pages with a specific label
  atlcli docs sync ./docs --space DEV --label architecture

  # Sync with auto-create for new local files
  atlcli docs sync ./docs --space DEV --auto-create

  # Sync with webhook for real-time updates
  atlcli docs sync ./docs --space DEV --webhook-port 3000 --webhook-url https://example.com/webhook
`;
}
