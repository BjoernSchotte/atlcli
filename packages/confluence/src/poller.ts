import { ConfluenceClient, SyncScope, PageChangeInfo } from "./client.js";

/** Event emitted when polling detects changes */
export interface PollChangeEvent {
  type: "changed" | "created" | "deleted";
  contentType: "page" | "folder";
  pageId: string;
  title: string;
  version: number;
  previousVersion?: number;
}

/** Polling state for tracking known pages and folders */
export interface PollerState {
  lastPollAt: string;
  knownPages: Map<string, { version: number; title: string }>;
  knownFolders: Map<string, { version: number; title: string }>;
}

/** Callback for handling poll events */
export type PollEventHandler = (event: PollChangeEvent) => void | Promise<void>;

/**
 * Confluence Poller - detects remote changes at configurable intervals.
 * Supports three scopes: single page, page tree, whole space.
 * Tracks both pages and folders.
 */
export class ConfluencePoller {
  private client: ConfluenceClient;
  private scope: SyncScope;
  private intervalMs: number;
  private state: PollerState;
  private timer: NodeJS.Timeout | null = null;
  private handlers: Set<PollEventHandler> = new Set();
  private isPolling = false;

  constructor(params: {
    client: ConfluenceClient;
    scope: SyncScope;
    intervalMs?: number;
  }) {
    this.client = params.client;
    this.scope = params.scope;
    this.intervalMs = params.intervalMs ?? 30000;
    this.state = {
      lastPollAt: new Date().toISOString(),
      knownPages: new Map(),
      knownFolders: new Map(),
    };
  }

  /** Register a handler for poll events */
  on(handler: PollEventHandler): void {
    this.handlers.add(handler);
  }

  /** Remove a handler */
  off(handler: PollEventHandler): void {
    this.handlers.delete(handler);
  }

  /** Emit an event to all handlers */
  private async emit(event: PollChangeEvent): Promise<void> {
    for (const handler of this.handlers) {
      await handler(event);
    }
  }

  /** Initialize state with current pages and folders (call before starting) */
  async initialize(): Promise<void> {
    // Initialize pages
    const pages = await this.client.getAllPages({ scope: this.scope });
    this.state.knownPages.clear();
    for (const page of pages) {
      this.state.knownPages.set(page.id, {
        version: page.version,
        title: page.title,
      });
    }

    // Initialize folders (for space and tree scopes)
    this.state.knownFolders.clear();
    if (this.scope.type !== "page") {
      const folders = await this.client.getAllFoldersWithVersions({ scope: this.scope });
      for (const folder of folders) {
        this.state.knownFolders.set(folder.id, {
          version: folder.version,
          title: folder.title,
        });
      }
    }

    this.state.lastPollAt = new Date().toISOString();
  }

  /** Start polling at the configured interval */
  start(): void {
    if (this.timer) return;

    this.timer = setInterval(async () => {
      if (this.isPolling) return; // Skip if previous poll still running
      await this.poll();
    }, this.intervalMs);

    // Run initial poll immediately
    this.poll();
  }

  /** Stop polling */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Perform a single poll */
  async poll(): Promise<PollChangeEvent[]> {
    if (this.isPolling) return [];
    this.isPolling = true;

    const events: PollChangeEvent[] = [];

    try {
      // Poll for page changes
      const pages = await this.client.getPagesSince({
        scope: this.scope,
        since: this.state.lastPollAt,
      });

      const currentPageIds = new Set<string>();

      for (const page of pages) {
        currentPageIds.add(page.id);
        const known = this.state.knownPages.get(page.id);

        if (!known) {
          // New page
          const event: PollChangeEvent = {
            type: "created",
            contentType: "page",
            pageId: page.id,
            title: page.title,
            version: page.version,
          };
          events.push(event);
          await this.emit(event);
        } else if (page.version > known.version) {
          // Updated page
          const event: PollChangeEvent = {
            type: "changed",
            contentType: "page",
            pageId: page.id,
            title: page.title,
            version: page.version,
            previousVersion: known.version,
          };
          events.push(event);
          await this.emit(event);
        }

        // Update known state
        this.state.knownPages.set(page.id, {
          version: page.version,
          title: page.title,
        });
      }

      // For space/tree scope, check for deleted pages and poll folders
      if (this.scope.type !== "page") {
        // Check for deleted pages
        const allPages = await this.client.getAllPages({ scope: this.scope });
        const allPageIds = new Set(allPages.map((p) => p.id));

        for (const [id, info] of this.state.knownPages) {
          if (!allPageIds.has(id)) {
            const event: PollChangeEvent = {
              type: "deleted",
              contentType: "page",
              pageId: id,
              title: info.title,
              version: info.version,
            };
            events.push(event);
            await this.emit(event);
            this.state.knownPages.delete(id);
          }
        }

        // Poll for folder changes
        const folders = await this.client.getAllFoldersWithVersions({ scope: this.scope });
        const currentFolderIds = new Set<string>();

        for (const folder of folders) {
          currentFolderIds.add(folder.id);
          const known = this.state.knownFolders.get(folder.id);

          if (!known) {
            // New folder
            const event: PollChangeEvent = {
              type: "created",
              contentType: "folder",
              pageId: folder.id,
              title: folder.title,
              version: folder.version,
            };
            events.push(event);
            await this.emit(event);
          } else if (folder.version > known.version) {
            // Updated folder (renamed)
            const event: PollChangeEvent = {
              type: "changed",
              contentType: "folder",
              pageId: folder.id,
              title: folder.title,
              version: folder.version,
              previousVersion: known.version,
            };
            events.push(event);
            await this.emit(event);
          }

          // Update known state
          this.state.knownFolders.set(folder.id, {
            version: folder.version,
            title: folder.title,
          });
        }

        // Check for deleted folders
        for (const [id, info] of this.state.knownFolders) {
          if (!currentFolderIds.has(id)) {
            const event: PollChangeEvent = {
              type: "deleted",
              contentType: "folder",
              pageId: id,
              title: info.title,
              version: info.version,
            };
            events.push(event);
            await this.emit(event);
            this.state.knownFolders.delete(id);
          }
        }
      }

      this.state.lastPollAt = new Date().toISOString();
    } finally {
      this.isPolling = false;
    }

    return events;
  }

  /** Get current poller state */
  getState(): PollerState {
    return {
      lastPollAt: this.state.lastPollAt,
      knownPages: new Map(this.state.knownPages),
      knownFolders: new Map(this.state.knownFolders),
    };
  }

  /** Update interval without restarting */
  setInterval(ms: number): void {
    this.intervalMs = ms;
    if (this.timer) {
      this.stop();
      this.start();
    }
  }

  /** Check if poller is running */
  isRunning(): boolean {
    return this.timer !== null;
  }
}

/**
 * Create a poller for a single page (most efficient).
 */
export function createPagePoller(
  client: ConfluenceClient,
  pageId: string,
  intervalMs?: number
): ConfluencePoller {
  return new ConfluencePoller({
    client,
    scope: { type: "page", pageId },
    intervalMs,
  });
}

/**
 * Create a poller for a page tree.
 */
export function createTreePoller(
  client: ConfluenceClient,
  ancestorId: string,
  intervalMs?: number
): ConfluencePoller {
  return new ConfluencePoller({
    client,
    scope: { type: "tree", ancestorId },
    intervalMs,
  });
}

/**
 * Create a poller for an entire space.
 */
export function createSpacePoller(
  client: ConfluenceClient,
  spaceKey: string,
  intervalMs?: number
): ConfluencePoller {
  return new ConfluencePoller({
    client,
    scope: { type: "space", spaceKey },
    intervalMs,
  });
}
