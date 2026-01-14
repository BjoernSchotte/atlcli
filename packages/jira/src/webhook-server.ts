/**
 * Jira Webhook Server using Bun's built-in HTTP server.
 *
 * Receives webhook events from Jira and emits them for processing.
 */
import { createHmac } from "node:crypto";
import type { Server } from "bun";

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
  secret?: string;
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

    const self = this;

    this.server = Bun.serve({
      port: this.options.port,
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

  /** Get server port */
  getPort(): number {
    return this.options.port;
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

      const payload = JSON.parse(body) as JiraWebhookPayload;

      // Filter by project if configured
      if (this.options.filterProjects && payload.issue) {
        const projectKey = payload.issue.fields.project.key;
        if (!this.options.filterProjects.has(projectKey)) {
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

    // Constant-time comparison to prevent timing attacks
    const expectedStr = `sha256=${expected}`;
    if (expectedStr.length !== signature.length) return false;

    let result = 0;
    for (let i = 0; i < expectedStr.length; i++) {
      result |= expectedStr.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return result === 0;
  }
}

/** Format webhook event for display */
export function formatWebhookEvent(payload: JiraWebhookPayload): string {
  const timestamp = new Date(payload.timestamp).toISOString();
  const event = payload.webhookEvent;

  if (payload.issue) {
    const issue = payload.issue;
    const key = issue.key;
    const summary = issue.fields.summary;
    const status = issue.fields.status.name;

    if (event === "jira:issue_created") {
      return `[${timestamp}] CREATED: ${key} - ${summary}`;
    } else if (event === "jira:issue_updated") {
      const changes = payload.changelog?.items
        .map((i) => `${i.field}: ${i.fromString || "(none)"} → ${i.toString || "(none)"}`)
        .join(", ");
      return `[${timestamp}] UPDATED: ${key} - ${summary} (${changes || status})`;
    } else if (event === "jira:issue_deleted") {
      return `[${timestamp}] DELETED: ${key} - ${summary}`;
    }
  }

  if (payload.comment && payload.issue) {
    const key = payload.issue.key;
    const author = payload.comment.author.displayName;
    if (event === "comment_created") {
      return `[${timestamp}] COMMENT: ${key} - New comment by ${author}`;
    } else if (event === "comment_updated") {
      return `[${timestamp}] COMMENT: ${key} - Comment updated by ${author}`;
    } else if (event === "comment_deleted") {
      return `[${timestamp}] COMMENT: ${key} - Comment deleted`;
    }
  }

  if (payload.sprint) {
    const sprint = payload.sprint;
    return `[${timestamp}] SPRINT: ${sprint.name} - ${event.replace("sprint_", "")}`;
  }

  return `[${timestamp}] ${event}`;
}
