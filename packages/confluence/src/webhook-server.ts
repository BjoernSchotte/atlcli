import { createHmac, timingSafeEqual } from "node:crypto";

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
  /**
   * Shared secret. When set, every event must carry either
   * `X-Hub-Signature: sha256=<HMAC-SHA256 of the body>` (Confluence Data Center
   * webhooks) or `Authorization: Bearer <secret>` (senders that cannot sign,
   * such as an automation rule's web request).
   */
  secret?: string;
  /**
   * Interface to bind. Default `127.0.0.1`. Anything but a loopback address
   * needs a `secret`: {@link WebhookServer.start} throws otherwise.
   */
  hostname?: string;
  filterPageIds?: Set<string>; // Only process events for these pages
  filterSpaceKeys?: Set<string>; // Only process events for these spaces
}

/** Whether `hostname` only accepts connections from this machine. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
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
      hostname: options.hostname ?? "127.0.0.1",
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

    // Without a secret every caller is trusted, so only this machine may call.
    if (!this.options.secret && !isLoopbackHost(this.options.hostname!)) {
      throw new Error(
        `Webhook server refuses to bind ${this.options.hostname} without a secret; only a loopback address is allowed.`
      );
    }

    const self = this;

    this.server = Bun.serve({
      port: this.options.port,
      hostname: this.options.hostname,
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
    const bound = this.options.hostname!;
    const host = isLoopbackHost(bound) ? (bound.includes(":") ? `[${bound}]` : bound) : "localhost";
    return `http://${host}:${this.server.port}${this.options.path}`;
  }

  /** Handle incoming webhook request */
  private async handleWebhook(req: Request): Promise<Response> {
    try {
      const body = await req.text();

      if (this.options.secret && !this.authenticated(body, req.headers)) {
        return new Response("Invalid signature", { status: 401 });
      }

      // Parse payload. JSON that is not an object (null, an array, a number) is
      // as unusable as text that does not parse.
      let payload: WebhookPayload | null = null;
      try {
        payload = JSON.parse(body) as WebhookPayload | null;
      } catch {
        // rejected below
      }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
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

  /** A matching body signature, or the secret itself as a bearer token. */
  private authenticated(body: string, headers: Headers): boolean {
    const secret = this.options.secret!;
    const signature = headers.get("X-Hub-Signature");
    if (signature !== null) {
      const expected = createHmac("sha256", secret).update(body).digest("hex");
      return safeEqual(signature, `sha256=${expected}`);
    }
    const authorization = headers.get("Authorization");
    return authorization !== null && safeEqual(authorization, `Bearer ${secret}`);
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
