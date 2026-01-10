import { readdir } from "node:fs/promises";
import { FSWatcher, watch } from "node:fs";
import { join, basename, extname } from "node:path";
import {
  ConfluenceClient,
  SyncScope,
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
  slugify,
  storageToMarkdown,
  writeTextFile,
  ConfluencePoller,
  threeWayMerge,
  hasConflictMarkers,
  resolveConflicts,
  WebhookServer,
  WebhookPayload,
} from "@atlcli/core";

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
  webhookPort?: number;
  webhookUrl?: string;
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
  // Parse scope
  const pageId = getFlag(flags, "page-id");
  const ancestorId = getFlag(flags, "ancestor");
  const spaceKey = getFlag(flags, "space");

  let scope: SyncScope;
  if (pageId) {
    scope = { type: "page", pageId };
  } else if (ancestorId) {
    scope = { type: "tree", ancestorId };
  } else if (spaceKey) {
    scope = { type: "space", spaceKey };
  } else {
    fail(opts, 1, ERROR_CODES.USAGE, "One of --page-id, --ancestor, or --space is required.");
    return;
  }

  const webhookPortStr = getFlag(flags, "webhook-port");
  const syncOpts: SyncOptions = {
    dir: args[0] ?? getFlag(flags, "dir") ?? "./docs",
    scope,
    pollIntervalMs: Number(getFlag(flags, "poll-interval") ?? 30000),
    onConflict: (getFlag(flags, "on-conflict") as any) ?? "merge",
    dryRun: hasFlag(flags, "dry-run"),
    noWatch: hasFlag(flags, "no-watch"),
    noPoll: hasFlag(flags, "no-poll"),
    json: opts.json,
    webhookPort: webhookPortStr ? Number(webhookPortStr) : undefined,
    webhookUrl: getFlag(flags, "webhook-url"),
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

  constructor(client: ConfluenceClient, opts: SyncOptions, outputOpts: OutputOptions) {
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

    // Get all pages in scope
    const pages = await this.client.getAllPages({ scope: this.opts.scope });
    this.emit({ type: "status", message: `Found ${pages.length} pages in scope` });

    // Load existing local files
    const existingFiles = await this.collectMarkdownFiles(this.opts.dir);
    for (const filePath of existingFiles) {
      const meta = await this.readMeta(filePath);
      if (meta?.id) {
        this.fileToMeta.set(filePath, meta as EnhancedMeta);
        this.idToFile.set(meta.id, filePath);
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

    // Start file watcher
    if (!this.opts.noWatch) {
      this.watchers = await this.createWatchers(this.opts.dir, (filePath) => {
        if (extname(filePath).toLowerCase() !== ".md") return;
        if (filePath.endsWith(".base")) return;
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

  /** Pull a page from Confluence */
  private async pullPage(pageId: string, existingFile?: string): Promise<void> {
    try {
      const page = await this.client.getPage(pageId);
      const markdown = storageToMarkdown(page.storage);

      const filePath = existingFile ?? join(
        this.opts.dir,
        `${page.id}__${slugify(page.title) || "page"}.md`
      );

      if (this.opts.dryRun) {
        this.emit({
          type: "pull",
          message: `Would pull: ${page.title}`,
          file: filePath,
          pageId: page.id,
        });
        return;
      }

      await writeTextFile(filePath, markdown);

      // Create enhanced metadata
      const meta = createEnhancedMeta({
        id: page.id,
        title: page.title,
        spaceKey: page.spaceKey ?? "",
        version: page.version ?? 1,
        localContent: markdown,
        remoteContent: markdown,
      });

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
      const meta = await this.readMeta(filePath);
      const localContent = await readTextFile(filePath);

      // Check for conflict markers
      if (hasConflictMarkers(localContent)) {
        this.emit({
          type: "conflict",
          message: `File has unresolved conflicts: ${filePath}`,
          file: filePath,
        });
        return;
      }

      const storage = markdownToStorage(localContent);

      if (meta?.id) {
        // Update existing page
        const current = await this.client.getPage(meta.id);

        // Check if remote changed since last sync
        if (meta.version && current.version && current.version > meta.version) {
          // Remote changed - need merge
          await this.mergeChanges(meta.id, filePath, localContent, meta as EnhancedMeta);
          return;
        }

        if (this.opts.dryRun) {
          this.emit({
            type: "push",
            message: `Would push: ${filePath}`,
            file: filePath,
            pageId: meta.id,
          });
          return;
        }

        const version = (current.version ?? 1) + 1;
        const page = await this.client.updatePage({
          id: meta.id,
          title: meta.title ?? current.title,
          storage,
          version,
        });

        // Update metadata
        const newMeta = createEnhancedMeta({
          id: page.id,
          title: page.title,
          spaceKey: page.spaceKey ?? (meta as any).spaceKey ?? "",
          version: page.version ?? version,
          localContent,
          remoteContent: localContent,
        });

        await this.writeMeta(filePath, newMeta);
        await writeBase(filePath, localContent);
        this.fileToMeta.set(filePath, newMeta);

        this.emit({
          type: "push",
          message: `Pushed: ${page.title}`,
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

Scope options (one required):
  --page-id <id>        Sync single page by ID
  --ancestor <id>       Sync page tree under parent ID
  --space <key>         Sync entire space

Behavior options:
  --poll-interval <ms>  Polling interval in ms (default: 30000)
  --no-poll             Disable polling (local watch only)
  --no-watch            Disable local file watching (poll only)
  --on-conflict <mode>  Conflict handling: merge|local|remote (default: merge)
  --flat                Flat file structure (no subdirs)
  --dry-run             Show what would sync without changes
  --json                JSON output for scripting
  --profile <name>      Use specific auth profile

Webhook options (optional, for real-time updates):
  --webhook-port <port> Start webhook server on port
  --webhook-url <url>   Public URL to register with Confluence

Examples:
  atlcli docs sync ./docs --space DEV
  atlcli docs sync ./docs --ancestor 12345 --poll-interval 10000
  atlcli docs sync ./page.md --page-id 12345
  atlcli docs sync ./docs --space DEV --webhook-port 3000 --webhook-url https://example.com/webhook
`;
}
