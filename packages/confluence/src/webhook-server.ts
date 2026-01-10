import { createHmac } from "crypto";

/** Confluence webhook event types */
export type WebhookEventType =
  | "page_created"
  | "page_updated"
  | "page_removed"
  | "page_trashed"
  | "page_restored"
  | "page_moved";

/** Confluence webhook payload */
export interface WebhookPayload {
  eventType: WebhookEventType;
  timestamp: string;
  page?: {
    id: string;
    title: string;
    spaceKey: string;
    version: number;
  };
  user?: {
    accountId: string;
    displayName: string;
  };
}

/** Webhook event handler */
export type WebhookHandler = (payload: WebhookPayload) => void | Promise<void>;

/** Webhook server options */
export interface WebhookServerOptions {
  port: number;
  path?: string;
  secret?: string; // For signature validation
  filterPageIds?: Set<string>; // Only process events for these pages
  filterSpaceKeys?: Set<string>; // Only process events for these spaces
}

/**
 * Lightweight HTTP server for receiving Confluence webhooks.
 * Uses Bun's built-in server for zero dependencies.
 */
export class WebhookServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private handlers: Set<WebhookHandler> = new Set();
  private options: WebhookServerOptions;

  constructor(options: WebhookServerOptions) {
    this.options = {
      path: "/webhook",
      ...options,
    };
  }

  /** Register a handler for webhook events */
  on(handler: WebhookHandler): void {
    this.handlers.add(handler);
  }

  /** Remove a handler */
  off(handler: WebhookHandler): void {
    this.handlers.delete(handler);
  }

  /** Start the webhook server */
  start(): void {
    if (this.server) return;

    const self = this;

    this.server = Bun.serve({
      port: this.options.port,
      async fetch(req) {
        const url = new URL(req.url);

        // Health check endpoint
        if (url.pathname === "/health" && req.method === "GET") {
          return new Response(JSON.stringify({ status: "ok" }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        // Webhook endpoint
        if (url.pathname === self.options.path && req.method === "POST") {
          return self.handleWebhook(req);
        }

        return new Response("Not Found", { status: 404 });
      },
    });
  }

  /** Stop the webhook server */
  stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
  }

  /** Check if server is running */
  isRunning(): boolean {
    return this.server !== null;
  }

  /** Get server URL */
  getUrl(): string | null {
    if (!this.server) return null;
    return `http://localhost:${this.options.port}${this.options.path}`;
  }

  /** Handle incoming webhook request */
  private async handleWebhook(req: Request): Promise<Response> {
    try {
      const body = await req.text();

      // Validate signature if secret is configured
      if (this.options.secret) {
        const signature = req.headers.get("X-Hub-Signature");
        if (!this.validateSignature(body, signature)) {
          return new Response("Invalid signature", { status: 401 });
        }
      }

      // Parse payload
      let payload: WebhookPayload;
      try {
        payload = JSON.parse(body) as WebhookPayload;
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      // Filter by page ID if configured
      if (this.options.filterPageIds && payload.page) {
        if (!this.options.filterPageIds.has(payload.page.id)) {
          return new Response(JSON.stringify({ status: "filtered" }), {
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      // Filter by space key if configured
      if (this.options.filterSpaceKeys && payload.page) {
        if (!this.options.filterSpaceKeys.has(payload.page.spaceKey)) {
          return new Response(JSON.stringify({ status: "filtered" }), {
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      // Dispatch to handlers
      for (const handler of this.handlers) {
        try {
          await handler(payload);
        } catch (err) {
          console.error("Webhook handler error:", err);
        }
      }

      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("Webhook processing error:", err);
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  /** Validate webhook signature (HMAC-SHA256) */
  private validateSignature(body: string, signature: string | null): boolean {
    if (!signature || !this.options.secret) return false;

    const expected = createHmac("sha256", this.options.secret)
      .update(body)
      .digest("hex");

    // Constant-time comparison
    const expectedBuf = Buffer.from(`sha256=${expected}`);
    const signatureBuf = Buffer.from(signature);

    if (expectedBuf.length !== signatureBuf.length) return false;

    let result = 0;
    for (let i = 0; i < expectedBuf.length; i++) {
      result |= expectedBuf[i] ^ signatureBuf[i];
    }
    return result === 0;
  }
}

/**
 * Create a webhook server with common defaults.
 */
export function createWebhookServer(
  port: number,
  options?: Partial<WebhookServerOptions>
): WebhookServer {
  return new WebhookServer({ port, ...options });
}
