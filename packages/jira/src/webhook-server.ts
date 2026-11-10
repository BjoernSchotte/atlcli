/**
 * Jira Webhook Server using Bun's built-in HTTP server.
 *
 * Receives webhook events from Jira and emits them for processing.
 */
import { createHmac } from "node:crypto";
// Namespace import: a named import of timingSafeEqual breaks browser-target
// builds of the barrel (the polyfill lacks it), which the build gate measures.
import * as nodeCrypto from "node:crypto";
import type { Server } from "bun";
import { isLoopbackHost } from "@atlcli/core/internal";

/** Largest request body the server reads (1 MiB); Bun answers 413 beyond it. */
const MAX_BODY_BYTES = 1 << 20;

/** Jira webhook event types */
export type JiraWebhookEventType =
  | "jira:issue_created"
  | "jira:issue_updated"
  | "jira:issue_deleted"
  | "comment_created"
  | "comment_updated"
  | "comment_deleted"
  | "attachment_created"
  | "attachment_deleted"
  | "issuelink_created"
  | "issuelink_deleted"
  | "worklog_created"
  | "worklog_updated"
  | "worklog_deleted"
  | "sprint_created"
  | "sprint_updated"
  | "sprint_started"
  | "sprint_closed"
  | "sprint_deleted"
  | "board_created"
  | "board_updated"
  | "board_deleted";

/** Jira webhook payload */
export interface JiraWebhookPayload {
  timestamp: number;
  webhookEvent: JiraWebhookEventType;
  issue?: {
    id: string;
    key: string;
    fields: {
      summary: string;
      status: { name: string };
      issuetype: { name: string };
      priority?: { name: string };
      assignee?: { displayName: string; accountId: string } | null;
      project: { key: string; name: string };
    };
  };
  comment?: {
    id: string;
    author: { displayName: string; accountId: string };
    body: string;
    created: string;
    updated: string;
  };
  changelog?: {
    id: string;
    items: Array<{
      field: string;
      fromString: string | null;
      toString: string | null;
    }>;
  };
  user?: {
    accountId: string;
    displayName: string;
  };
  sprint?: {
    id: number;
    name: string;
    state: string;
  };
}

/** Webhook handler function */
export type JiraWebhookHandler = (payload: JiraWebhookPayload) => void | Promise<void>;

/** Webhook server options */
export interface JiraWebhookServerOptions {
  port: number;
  path?: string;
  /** Shared secret. When set, every event must carry `X-Hub-Signature: sha256=<HMAC-SHA256 of the body>`. */
  secret?: string;
  /**
   * Interface to bind. Default `127.0.0.1`. Anything but a loopback address
   * needs a `secret`: {@link JiraWebhookServer.start} throws otherwise.
   */
  hostname?: string;
  filterProjects?: Set<string>;
  filterEvents?: Set<string>;
}

/**
 * Jira Webhook Server.
 *
 * Starts a local HTTP server to receive webhook events from Jira.
 */
export class JiraWebhookServer {
  private server: Server<unknown> | null = null;
  private handlers: Set<JiraWebhookHandler> = new Set();
  private options: Required<Omit<JiraWebhookServerOptions, "secret" | "filterProjects" | "filterEvents">> &
    Pick<JiraWebhookServerOptions, "secret" | "filterProjects" | "filterEvents">;

  constructor(options: JiraWebhookServerOptions) {
    this.options = {
      port: options.port,
      path: options.path ?? "/webhook",
      secret: options.secret,
      hostname: options.hostname ?? "127.0.0.1",
      filterProjects: options.filterProjects,
      filterEvents: options.filterEvents,
    };
  }

  /** Register an event handler */
  on(handler: JiraWebhookHandler): void {
    this.handlers.add(handler);
  }

  /** Remove an event handler */
  off(handler: JiraWebhookHandler): void {
    this.handlers.delete(handler);
  }

  /** Start the webhook server */
  start(): void {
    if (this.server) {
      throw new Error("Server is already running");
    }

    // Without a secret every caller is trusted, so only this machine may call.
    if (!this.options.secret && !isLoopbackHost(this.options.hostname)) {
      throw new Error(
        `Webhook server refuses to bind ${this.options.hostname} without a secret; only a loopback address is allowed.`
      );
    }

    const self = this;

    this.server = Bun.serve({
      port: this.options.port,
      hostname: this.options.hostname,
      maxRequestBodySize: MAX_BODY_BYTES,
      async fetch(req) {
        const url = new URL(req.url);

        // Health check endpoint
        if (url.pathname === "/health" && req.method === "GET") {
          return new Response(JSON.stringify({ status: "ok", timestamp: Date.now() }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        // Webhook endpoint
        if (url.pathname === self.options.path && req.method === "POST") {
          // A page in the user's browser can POST form or text bodies to a
          // loopback port without a preflight, but not JSON.
          if (req.headers.get("Content-Type")?.split(";")[0]!.trim().toLowerCase() !== "application/json") {
            return new Response(JSON.stringify({ error: "Unsupported media type" }), {
              status: 415,
              headers: { "Content-Type": "application/json" },
            });
          }
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
    const bound = this.options.hostname;
    const host = isLoopbackHost(bound) ? (bound.includes(":") ? `[${bound}]` : bound) : "localhost";
    return `http://${host}:${this.getPort()}${this.options.path}`;
  }

  /** Get the bound port (the configured one until the server runs; `port: 0` binds a free port) */
  getPort(): number {
    return this.server?.port ?? this.options.port;
  }

  /** Handle incoming webhook request */
  private async handleWebhook(req: Request): Promise<Response> {
    try {
      const body = await req.text();

      // Validate signature if secret is configured
      if (this.options.secret) {
        const signature = req.headers.get("X-Hub-Signature");
        if (!this.validateSignature(body, signature)) {
          return new Response(JSON.stringify({ error: "Invalid signature" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      let payload: JiraWebhookPayload | null = null;
      try {
        payload = JSON.parse(body) as JiraWebhookPayload | null;
      } catch {
        // rejected below, together with JSON that is not an object
      }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Filter by project if configured. An issue without a project key cannot match.
      if (this.options.filterProjects && payload.issue) {
        const projectKey: string | undefined = payload.issue.fields?.project?.key;
        if (projectKey === undefined || !this.options.filterProjects.has(projectKey)) {
          return new Response(JSON.stringify({ status: "filtered", reason: "project" }), {
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      // Filter by event type if configured
      if (this.options.filterEvents && !this.options.filterEvents.has(payload.webhookEvent)) {
        return new Response(JSON.stringify({ status: "filtered", reason: "event" }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Emit to all handlers
      const handlerPromises = Array.from(this.handlers).map(async (handler) => {
        try {
          await handler(payload);
        } catch (err) {
          console.error("Webhook handler error:", err);
        }
      });

      await Promise.all(handlerPromises);

      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("Webhook processing error:", err);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  /** Validate HMAC signature */
  private validateSignature(body: string, signature: string | null): boolean {
    if (!signature || !this.options.secret) return false;

    const expected = createHmac("sha256", this.options.secret)
      .update(body)
      .digest("hex");

    const expectedBuf = Buffer.from(`sha256=${expected}`);
    const signatureBuf = Buffer.from(signature);
    return expectedBuf.length === signatureBuf.length && nodeCrypto.timingSafeEqual(expectedBuf, signatureBuf);
  }
}

/** Request-controlled text must not carry terminal control sequences or forge extra lines. */
function clean(value: unknown): string {
  return String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/** Format webhook event for display */
export function formatWebhookEvent(payload: JiraWebhookPayload): string {
  const timestamp = new Date(payload.timestamp).toISOString();
  const event = clean(payload.webhookEvent);

  if (payload.issue) {
    const issue = payload.issue;
    const key = clean(issue.key);
    const summary = clean(issue.fields?.summary);
    const status = clean(issue.fields?.status?.name);

    if (event === "jira:issue_created") {
      return `[${timestamp}] CREATED: ${key} - ${summary}`;
    } else if (event === "jira:issue_updated") {
      const changes = payload.changelog?.items
        .map((i) => clean(`${i.field}: ${i.fromString || "(none)"} → ${i.toString || "(none)"}`))
        .join(", ");
      return `[${timestamp}] UPDATED: ${key} - ${summary} (${changes || status})`;
    } else if (event === "jira:issue_deleted") {
      return `[${timestamp}] DELETED: ${key} - ${summary}`;
    }
  }

  if (payload.comment && payload.issue) {
    const key = clean(payload.issue.key);
    const author = clean(payload.comment.author?.displayName);
    if (event === "comment_created") {
      return `[${timestamp}] COMMENT: ${key} - New comment by ${author}`;
    } else if (event === "comment_updated") {
      return `[${timestamp}] COMMENT: ${key} - Comment updated by ${author}`;
    } else if (event === "comment_deleted") {
      return `[${timestamp}] COMMENT: ${key} - Comment deleted`;
    }
  }

  if (payload.sprint) {
    return `[${timestamp}] SPRINT: ${clean(payload.sprint.name)} - ${event.replace("sprint_", "")}`;
  }

  return `[${timestamp}] ${event}`;
}
