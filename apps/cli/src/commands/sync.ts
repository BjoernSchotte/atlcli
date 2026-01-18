import { readdir, writeFile, unlink, readFile, mkdir } from "node:fs/promises";
import { FSWatcher, watch, existsSync } from "node:fs";
import { join, basename, extname, dirname } from "node:path";
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
  ConversionOptions,
  threeWayMerge,
  hasConflictMarkers,
  WebhookServer,
  WebhookPayload,
  parseFrontmatter,
  addFrontmatter,
  AtlcliFrontmatter,
  // Config & State
  readConfig,
  getConfigScope,
  initAtlcliDirV2,
  readState,
  writeState,
  updatePageState,
  readBaseContent,
  writeBaseContent,
  AtlcliState,
  PageState,
  SyncState as StateSyncState,
  // Hierarchy
  computeFilePath,
  hasPageMoved,
  moveFile,
  PageHierarchyInfo,
  // Scope
  parseScope,
  // Ignore
  loadIgnorePatterns,
  shouldIgnore,
  // Attachments
  extractAttachmentRefs,
  getAttachmentsDirName,
  AttachmentInfo,
  // Link storage
  storePageLinks,
} from "@atlcli/confluence";
import type { Ignore } from "@atlcli/confluence";

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
  flags: Record<string, string | boolean | string[]>,
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
  const dir = args[0] ?? getFlag(flags, "dir") ?? ".";

  if (parsedScope) {
    // Use scope from flags
    scope = parsedScope.scope;
    resolvedSpaceKey = parsedScope.spaceKey;
  } else {
    // Try to read scope from .atlcli config in target directory
    // Note: Check target dir only, not walking up, to avoid global ~/.atlcli/
    const atlcliConfigPath = join(dir, ".atlcli", "config.json");
    if (existsSync(atlcliConfigPath)) {
      try {
        const dirConfig = await readConfig(dir);
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
  const engine = new SyncEngine(client, syncOpts, opts, profile.baseUrl);

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
  private pushQueue: Set<string> = new Set();
  private pushTimer: NodeJS.Timeout | null = null;
  private debounceMs = 500;
  private lockFilePath: string;
  private ignore: Ignore | null = null;
  // State management
  private state: AtlcliState | null = null;
  private atlcliDir: string = "";
  private spaceKey: string = "";
  private baseUrl: string;
  private homePageId: string | undefined; // Space home page ID for flattening hierarchy

  constructor(client: ConfluenceClient, opts: SyncOptions, outputOpts: OutputOptions, baseUrl: string) {
    this.lockFilePath = join(opts.dir, ".atlcli", ".sync.lock");
    this.client = client;
    this.opts = opts;
    this.outputOpts = outputOpts;
    this.baseUrl = baseUrl;
  }

  /** Get conversion options for markdown/storage conversion */
  private get conversionOptions(): ConversionOptions {
    return {
      baseUrl: this.baseUrl,
      emitWarnings: true,
      onWarning: (msg) => console.warn(msg),
    };
  }

  /** Get file path for a page ID from state */
  private getFileByPageId(pageId: string): string | undefined {
    if (!this.state) return undefined;
    // Reverse lookup: find path that maps to this pageId in pathIndex
    for (const [path, id] of Object.entries(this.state.pathIndex)) {
      if (id === pageId) return path;
    }
    return undefined;
  }

  /** Emit a sync event to output */
  private emit(event: SyncEvent): void {
    // Log the sync event
    const logger = getLogger();
    logger.sync({
      eventType: event.type,
      file: event.file,
      pageId: event.pageId,
      title: event.message,
      details: event.details,
    });

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

    // Auto-initialize .atlcli/ if not present in target directory
    // Note: We check the target dir specifically, NOT walking up the tree,
    // to avoid finding the global ~/.atlcli/ config directory
    const atlcliPath = join(this.opts.dir, ".atlcli");
    if (existsSync(atlcliPath)) {
      this.atlcliDir = this.opts.dir;
    } else {
      // Need to determine space key for initialization
      if (this.opts.scope.type === "space") {
        this.spaceKey = this.opts.scope.spaceKey;
      } else {
        // Fetch from page
        const pageId = this.opts.scope.type === "page"
          ? this.opts.scope.pageId
          : this.opts.scope.ancestorId;
        const page = await this.client.getPage(pageId);
        this.spaceKey = page.spaceKey ?? "";
      }

      this.emit({ type: "status", message: "Initializing .atlcli/ directory..." });
      await initAtlcliDirV2(this.opts.dir, {
        scope: this.opts.scope,
        space: this.spaceKey,
        baseUrl: this.baseUrl,
      });
      this.atlcliDir = this.opts.dir;
    }

    // Load state
    this.state = await readState(this.atlcliDir);
    if (!this.spaceKey) {
      try {
        const config = await readConfig(this.atlcliDir);
        this.spaceKey = config.space;
      } catch {
        // Config may not exist yet
      }
    }

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

    // Detect space home page for flattening hierarchy
    // When syncing a space, find the root page (the one with no ancestors)
    if (this.opts.scope.type === "space" && pages.length > 0) {
      // Find the page that has no parent (space home page)
      for (const page of pages) {
        const fullPage = await this.client.getPage(page.id);
        if (!fullPage.parentId && (!fullPage.ancestors || fullPage.ancestors.length === 0)) {
          this.homePageId = page.id;
          this.emit({
            type: "status",
            message: `Using "${fullPage.title}" as space home page (children will be at root level)`,
          });
          break;
        }
      }
    }

    // Load existing local files and migrate legacy format
    const existingFiles = await this.collectMarkdownFiles(this.opts.dir);
    for (const filePath of existingFiles) {
      const relativePath = this.getRelativePath(filePath);

      // Check if already in state
      let pageId = this.state!.pathIndex[relativePath];

      if (!pageId) {
        // Try legacy .meta.json migration
        const legacyMetaPath = `${filePath}.meta.json`;
        if (existsSync(legacyMetaPath)) {
          try {
            const legacyMeta = JSON.parse(await readTextFile(legacyMetaPath));
            pageId = legacyMeta.id;
            if (pageId) {
              // Migrate to state.json
              updatePageState(this.state!, pageId, {
                path: relativePath,
                title: legacyMeta.title || basename(filePath, ".md"),
                spaceKey: legacyMeta.spaceKey || this.spaceKey,
                version: legacyMeta.version || 0,
                lastSyncedAt: legacyMeta.lastSyncedAt || new Date().toISOString(),
                localHash: legacyMeta.localHash || "",
                remoteHash: legacyMeta.remoteHash || "",
                baseHash: legacyMeta.baseHash || "",
                syncState: (legacyMeta.syncState as StateSyncState) || "synced",
                parentId: legacyMeta.parentId ?? null,
                ancestors: legacyMeta.ancestors || [],
              });
              // Migrate .base file if exists
              const legacyBasePath = `${filePath}.base`;
              if (existsSync(legacyBasePath)) {
                const baseContent = await readTextFile(legacyBasePath);
                await writeBaseContent(this.atlcliDir, pageId, baseContent);
                await unlink(legacyBasePath);
              }
              // Delete legacy meta
              await unlink(legacyMetaPath);
              this.emit({ type: "status", message: `Migrated: ${relativePath}` });
            }
          } catch {
            // Migration failed, continue
          }
        }
      }

      // If still no pageId, check frontmatter
      if (!pageId) {
        try {
          const content = await readTextFile(filePath);
          const { frontmatter } = parseFrontmatter(content);
          if (frontmatter?.id) {
            pageId = frontmatter.id;
            // Add to state
            updatePageState(this.state!, pageId, {
              path: relativePath,
              title: frontmatter.title || basename(filePath, ".md"),
              spaceKey: this.spaceKey,
              version: 0, // Unknown version - will check remote
              lastSyncedAt: "",
              localHash: "",
              remoteHash: "",
              baseHash: "",
              syncState: "synced",
              parentId: null,
              ancestors: [],
            });
          } else if (this.opts.autoCreate) {
            // Auto-create page for untracked file during initial sync
            await this.autoCreatePage(filePath, content, frontmatter);
          }
        } catch {
          // File read error, skip
        }
      }
    }

    // Save migrated state
    await writeState(this.atlcliDir, this.state!);

    // Sync each page
    for (const pageInfo of pages) {
      const pageState = this.state!.pages[pageInfo.id];

      if (pageState) {
        // Check for changes
        if (pageInfo.version > pageState.version) {
          // Remote has newer version - pull
          const existingFile = join(this.opts.dir, pageState.path);
          await this.pullPage(pageInfo.id, existingFile);
        }
      } else {
        // New page - create local file
        await this.pullPage(pageInfo.id);
      }
    }

    this.emit({ type: "status", message: "Initial sync complete" });
  }

  /** Get relative path from absolute path */
  private getRelativePath(filePath: string): string {
    if (filePath.startsWith(this.opts.dir + "/")) {
      return filePath.slice(this.opts.dir.length + 1);
    }
    if (filePath.startsWith(this.opts.dir)) {
      return filePath.slice(this.opts.dir.length);
    }
    return filePath;
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

        const file = this.getFileByPageId(payload.page.id);

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
        const file = this.getFileByPageId(event.pageId);
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
        // Handle attachment file changes
        if (filePath.includes(".attachments/")) {
          // Extract the page file path from the attachment path
          // e.g., ./docs/page.attachments/img.png -> ./docs/page.md
          const match = filePath.match(/(.+)\.attachments\//);
          if (match) {
            const pageFilePath = match[1] + ".md";
            if (existsSync(pageFilePath)) {
              this.schedulePush(pageFilePath);
            }
          }
          return;
        }

        // Handle markdown files
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
    const pageState = this.state?.pages[pageId];

    // Convert relative path to absolute
    const absoluteFile = existingFile ? join(this.opts.dir, existingFile) : undefined;

    if (absoluteFile && pageState) {
      const localContent = await readTextFile(absoluteFile);
      const { content: markdownContent } = parseFrontmatter(localContent);
      const currentHash = hashContent(normalizeMarkdown(markdownContent));

      // Check if local has been modified since last sync
      if (currentHash !== pageState.localHash) {
        // Both changed - need merge
        await this.mergeChanges(pageId, absoluteFile, markdownContent, pageState);
      } else {
        // Only remote changed - pull
        await this.pullPage(pageId, absoluteFile);
      }
    } else if (absoluteFile) {
      await this.pullPage(pageId, absoluteFile);
    } else {
      // New page
      await this.pullPage(pageId);
    }
  }

  /** Pull a page from Confluence using nested hierarchy paths */
  private async pullPage(pageId: string, existingFile?: string): Promise<void> {
    try {
      const page = await this.client.getPage(pageId);
      const markdown = storageToMarkdown(page.storage, this.conversionOptions);

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
      const existingPaths = new Set<string>(Object.keys(this.state?.pathIndex || {}));

      const computed = computeFilePath(pageInfo, ancestorTitles, {
        existingPaths,
        rootAncestorId: this.homePageId,
      });
      let filePath = join(this.opts.dir, computed.relativePath);

      // Check if page has moved (existing file but different path)
      if (existingFile && existingFile !== filePath) {
        // Page moved in Confluence - check if ancestors changed
        const existingState = this.state?.pages[pageId];
        if (existingState?.ancestors) {
          const oldAncestors = existingState.ancestors;
          if (hasPageMoved(oldAncestors, ancestorIds)) {
            if (!this.opts.dryRun) {
              // Get relative paths for moveFile (it expects relative paths)
              const oldRelPath = this.getRelativePath(existingFile);

              // Move the local file to match new hierarchy
              await moveFile(this.opts.dir, oldRelPath, computed.relativePath);

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

      // Compute hash for state
      const contentHash = hashContent(normalizeMarkdown(markdown));
      const relativePath = this.getRelativePath(filePath);

      // Update state
      updatePageState(this.state!, pageId, {
        path: relativePath,
        title: page.title,
        spaceKey: page.spaceKey ?? this.spaceKey,
        version: page.version ?? 1,
        lastSyncedAt: new Date().toISOString(),
        localHash: contentHash,
        remoteHash: contentHash,
        baseHash: contentHash,
        syncState: "synced",
        parentId: page.parentId ?? null,
        ancestors: ancestorIds,
      });

      // Write base content for 3-way merge
      await writeBaseContent(this.atlcliDir, pageId, markdown);

      // Save state
      await writeState(this.atlcliDir, this.state!);

      // Extract and store links from pulled page (Phase 1 link graph population)
      await storePageLinks(this.atlcliDir, pageId, page.storage);

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

      // Check against stored localHash in state
      const relativePath = this.getRelativePath(filePath);
      const pageId = this.state?.pathIndex[relativePath];
      if (!pageId) {
        // No state = new file or untracked, treat as changed
        return true;
      }

      const pageState = this.state?.pages[pageId];
      if (!pageState) {
        return true;
      }

      // Only changed if hash differs
      return currentHash !== pageState.localHash;
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
      const localContent = await readTextFile(filePath);

      // Parse frontmatter to get page ID and clean content
      const { frontmatter, content: markdownContent } = parseFrontmatter(localContent);
      const relativePath = this.getRelativePath(filePath);

      // Get page ID from state or frontmatter
      let pageId = this.state?.pathIndex[relativePath];
      let pageState = pageId ? this.state?.pages[pageId] : undefined;

      // If no state, try frontmatter
      if (!pageId && frontmatter?.id) {
        pageId = frontmatter.id;
      }

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
      const storage = markdownToStorage(markdownContent, this.conversionOptions);

      if (pageId) {
        // Update existing page
        const current = await this.client.getPage(pageId);
        const stateVersion = pageState?.version ?? 0;

        // Check if remote changed since last sync
        if (stateVersion && current.version && current.version > stateVersion) {
          // Remote changed - need merge
          await this.mergeChanges(pageId, filePath, markdownContent, pageState!);
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

        // Upload attachments before updating page
        const attachmentRefs = extractAttachmentRefs(markdownContent);
        if (attachmentRefs.length > 0) {
          const pageFilename = basename(filePath);
          const pageDir = dirname(filePath);
          const attachmentsDir = join(pageDir, getAttachmentsDirName(pageFilename));

          if (existsSync(attachmentsDir)) {
            let existingAttachments: AttachmentInfo[] = [];
            try {
              existingAttachments = await this.client.listAttachments(pageId);
            } catch {
              // Page might not have any attachments yet
            }
            const existingByName = new Map(existingAttachments.map((a) => [a.filename, a]));

            for (const filename of attachmentRefs) {
              const localPath = join(attachmentsDir, filename);
              if (!existsSync(localPath)) continue;

              try {
                const data = await readFile(localPath);
                const existing = existingByName.get(filename);

                if (existing) {
                  await this.client.updateAttachment({
                    attachmentId: existing.id,
                    pageId,
                    filename,
                    data,
                  });
                } else {
                  await this.client.uploadAttachment({
                    pageId,
                    filename,
                    data,
                  });
                }
              } catch (err) {
                this.emit({
                  type: "error",
                  message: `Failed to upload attachment ${filename}`,
                  file: filePath,
                  pageId,
                });
              }
            }
          }
        }

        const version = (current.version ?? 1) + 1;
        const title = pageState?.title ?? frontmatter?.title ?? current.title;
        const page = await this.client.updatePage({
          id: pageId,
          title,
          storage,
          version,
        });

        // Compute hash for state
        const contentHash = hashContent(normalizeMarkdown(markdownContent));

        // Update state
        updatePageState(this.state!, pageId, {
          path: relativePath,
          title: page.title,
          spaceKey: page.spaceKey ?? pageState?.spaceKey ?? this.spaceKey,
          version: page.version ?? version,
          lastSyncedAt: new Date().toISOString(),
          localHash: contentHash,
          remoteHash: contentHash,
          baseHash: contentHash,
          syncState: "synced",
          parentId: pageState?.parentId ?? null,
          ancestors: pageState?.ancestors ?? [],
        });

        // Write base content
        await writeBaseContent(this.atlcliDir, pageId, markdownContent);

        // Save state
        await writeState(this.atlcliDir, this.state!);

        this.emit({
          type: "push",
          message: `Pushed: ${page.title}`,
          file: filePath,
          pageId: page.id,
        });
      } else if (this.opts.autoCreate) {
        // Auto-create new page for untracked file
        const title = frontmatter?.title || basename(filePath, ".md").replace(/-/g, " ");

        // Get space key from scope or stored spaceKey
        let spaceKey = this.spaceKey;
        if (!spaceKey) {
          if (this.opts.scope.type === "space") {
            spaceKey = this.opts.scope.spaceKey;
          } else if (this.opts.scope.type === "tree") {
            const ancestor = await this.client.getPage(this.opts.scope.ancestorId);
            spaceKey = ancestor.spaceKey ?? "";
          } else {
            const refPage = await this.client.getPage(this.opts.scope.pageId);
            spaceKey = refPage.spaceKey ?? "";
          }
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

        // Compute hash for state
        const contentHash = hashContent(normalizeMarkdown(markdownContent));

        // Update state
        updatePageState(this.state!, page.id, {
          path: relativePath,
          title: page.title,
          spaceKey: page.spaceKey ?? spaceKey,
          version: page.version ?? 1,
          lastSyncedAt: new Date().toISOString(),
          localHash: contentHash,
          remoteHash: contentHash,
          baseHash: contentHash,
          syncState: "synced",
          parentId: parentId ?? null,
          ancestors: [],
        });

        // Write base content
        await writeBaseContent(this.atlcliDir, page.id, markdownContent);

        // Save state
        await writeState(this.atlcliDir, this.state!);

        this.emit({
          type: "push",
          message: `Created: ${page.title} (ID: ${page.id})`,
          file: filePath,
          pageId: page.id,
        });
      } else {
        // Skip files without state (not tracked)
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

  /** Auto-create a new Confluence page for an untracked local file */
  private async autoCreatePage(
    filePath: string,
    content: string,
    frontmatter: AtlcliFrontmatter | null
  ): Promise<void> {
    try {
      const { content: markdownContent } = parseFrontmatter(content);
      const title = frontmatter?.title || basename(filePath, ".md").replace(/-/g, " ");
      const relativePath = this.getRelativePath(filePath);

      // Get space key
      let spaceKey = this.spaceKey;
      if (!spaceKey) {
        if (this.opts.scope.type === "space") {
          spaceKey = this.opts.scope.spaceKey;
        } else if (this.opts.scope.type === "tree") {
          const ancestor = await this.client.getPage(this.opts.scope.ancestorId);
          spaceKey = ancestor.spaceKey ?? "";
        } else {
          const refPage = await this.client.getPage(this.opts.scope.pageId);
          spaceKey = refPage.spaceKey ?? "";
        }
      }

      if (this.opts.dryRun) {
        this.emit({
          type: "push",
          message: `Would create: ${title} in space ${spaceKey}`,
          file: filePath,
        });
        return;
      }

      // Convert to storage format
      const storage = markdownToStorage(markdownContent, this.conversionOptions);

      // Determine parent - use home page if syncing a space, or ancestor if syncing a tree
      let parentId: string | undefined;
      if (this.opts.scope.type === "tree") {
        parentId = this.opts.scope.ancestorId;
      } else if (this.homePageId) {
        parentId = this.homePageId;
      }

      // Create the page
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

      // Compute hash for state
      const contentHash = hashContent(normalizeMarkdown(markdownContent));

      // Update state
      updatePageState(this.state!, page.id, {
        path: relativePath,
        title: page.title,
        spaceKey: page.spaceKey ?? spaceKey,
        version: page.version ?? 1,
        lastSyncedAt: new Date().toISOString(),
        localHash: contentHash,
        remoteHash: contentHash,
        baseHash: contentHash,
        syncState: "synced",
        parentId: parentId ?? null,
        ancestors: parentId ? [parentId] : [],
      });

      // Write base content
      await writeBaseContent(this.atlcliDir, page.id, markdownContent);

      // Save state
      await writeState(this.atlcliDir, this.state!);

      this.emit({
        type: "push",
        message: `Created: ${page.title} (ID: ${page.id})`,
        file: filePath,
        pageId: page.id,
      });
    } catch (err) {
      this.emit({
        type: "error",
        message: `Failed to create page for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        file: filePath,
      });
    }
  }

  /** Merge local and remote changes */
  private async mergeChanges(
    pageId: string,
    filePath: string,
    localContent: string,
    pageState: PageState
  ): Promise<void> {
    try {
      // Get remote content
      const remotePage = await this.client.getPage(pageId);
      const remoteContent = storageToMarkdown(remotePage.storage, this.conversionOptions);

      // Get base content from .atlcli/cache/
      const baseContent = await readBaseContent(this.atlcliDir, pageId);
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
        const storage = markdownToStorage(result.content, this.conversionOptions);
        const version = (remotePage.version ?? 1) + 1;
        const page = await this.client.updatePage({
          id: pageId,
          title: pageState.title,
          storage,
          version,
        });

        // Compute hash for state
        const contentHash = hashContent(normalizeMarkdown(result.content));
        const relativePath = this.getRelativePath(filePath);

        // Update state
        updatePageState(this.state!, pageId, {
          path: relativePath,
          title: page.title,
          spaceKey: page.spaceKey ?? pageState.spaceKey,
          version: page.version ?? version,
          lastSyncedAt: new Date().toISOString(),
          localHash: contentHash,
          remoteHash: contentHash,
          baseHash: contentHash,
          syncState: "synced",
          parentId: pageState.parentId,
          ancestors: pageState.ancestors,
        });

        // Write base content
        await writeBaseContent(this.atlcliDir, pageId, result.content);

        // Save state
        await writeState(this.atlcliDir, this.state!);

        this.emit({
          type: "push",
          message: `Auto-merged and pushed: ${pageState.title}`,
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

            // Update state to conflict
            const relativePath = this.getRelativePath(filePath);
            updatePageState(this.state!, pageId, {
              ...pageState,
              path: relativePath,
              syncState: "conflict",
            });
            await writeState(this.atlcliDir, this.state!);
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

  private async collectMarkdownFiles(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const results: string[] = [];

      for (const entry of entries) {
        // Always skip .atlcli directory (contains cache files, not documents)
        if (entry.name === ".atlcli") {
          continue;
        }

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
  return `atlcli wiki docs sync <dir> [options]

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
  atlcli wiki docs sync ./docs

  # Sync with explicit scope
  atlcli wiki docs sync ./docs --space DEV
  atlcli wiki docs sync ./docs --ancestor 12345 --poll-interval 10000
  atlcli wiki docs sync ./docs --page-id 12345

  # Sync only pages with a specific label
  atlcli wiki docs sync ./docs --space DEV --label architecture

  # Sync with auto-create for new local files
  atlcli wiki docs sync ./docs --space DEV --auto-create

  # Sync with webhook for real-time updates
  atlcli wiki docs sync ./docs --space DEV --webhook-port 3000 --webhook-url https://example.com/webhook
`;
}
