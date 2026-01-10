import { ConfluenceClient, SyncScope, PageChangeInfo } from "./client.js";

/** Event emitted when polling detects changes */
export interface PollChangeEvent {
  type: "changed" | "created" | "deleted";
  pageId: string;
  title: string;
  version: number;
  previousVersion?: number;
}

/** Polling state for tracking known pages */
export interface PollerState {
  lastPollAt: string;
  knownPages: Map<string, { version: number; title: string }>;
}

/** Callback for handling poll events */
export type PollEventHandler = (event: PollChangeEvent) => void | Promise<void>;

/**
 * Confluence Poller - detects remote changes at configurable intervals.
 * Supports three scopes: single page, page tree, whole space.
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

  /** Initialize state with current pages (call before starting) */
  async initialize(): Promise<void> {
    const pages = await this.client.getAllPages({ scope: this.scope });
    this.state.knownPages.clear();
    for (const page of pages) {
      this.state.knownPages.set(page.id, {
        version: page.version,
        title: page.title,
      });
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
      const pages = await this.client.getPagesSince({
        scope: this.scope,
        since: this.state.lastPollAt,
      });

      const currentIds = new Set<string>();

      for (const page of pages) {
        currentIds.add(page.id);
        const known = this.state.knownPages.get(page.id);

        if (!known) {
          // New page
          const event: PollChangeEvent = {
            type: "created",
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

      // For space/tree scope, check for deleted pages
      // (Only if we're doing a full poll, not incremental)
      if (this.scope.type !== "page") {
        const allPages = await this.client.getAllPages({ scope: this.scope });
        const allIds = new Set(allPages.map((p) => p.id));

        for (const [id, info] of this.state.knownPages) {
          if (!allIds.has(id)) {
            const event: PollChangeEvent = {
              type: "deleted",
              pageId: id,
              title: info.title,
              version: info.version,
            };
            events.push(event);
            await this.emit(event);
            this.state.knownPages.delete(id);
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
