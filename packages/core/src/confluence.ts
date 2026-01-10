import { Buffer } from "node:buffer";
import { Profile } from "./config.js";

export type ConfluencePage = {
  id: string;
  title: string;
  url?: string;
  version?: number;
  spaceKey?: string;
};

export type ConfluenceSearchResult = {
  id: string;
  title: string;
  url?: string;
  spaceKey?: string;
  version?: number;
  lastModified?: string;
};

/** Sync scope type for polling */
export type SyncScope =
  | { type: "page"; pageId: string }
  | { type: "tree"; ancestorId: string }
  | { type: "space"; spaceKey: string };

/** Page change info for polling */
export interface PageChangeInfo {
  id: string;
  title: string;
  version: number;
  lastModified?: string;
  spaceKey?: string;
}

export class ConfluenceClient {
  private baseUrl: string;
  private authHeader: string;
  private maxRetries = 3;
  private baseDelayMs = 1000;

  constructor(profile: Profile) {
    this.baseUrl = profile.baseUrl.replace(/\/+$/, "");
    if (profile.auth.type !== "apiToken") {
      throw new Error("OAuth is not implemented yet. Use --api-token.");
    }
    const email = profile.auth.email ?? "";
    const token = profile.auth.token ?? "";
    const encoded = Buffer.from(`${email}:${token}`).toString("base64");
    this.authHeader = `Basic ${encoded}`;
  }

  /** Sleep utility for rate limiting */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async request(
    path: string,
    options: {
      method?: string;
      query?: Record<string, string | number | undefined>;
      body?: unknown;
    } = {}
  ): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/wiki/rest/api${path}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const res = await fetch(url.toString(), {
        method: options.method ?? "GET",
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });

      // Handle rate limiting (429)
      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After");
        const delayMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : this.baseDelayMs * Math.pow(2, attempt);

        if (attempt < this.maxRetries) {
          await this.sleep(delayMs);
          continue;
        }
        throw new Error(`Rate limited by Confluence API after ${this.maxRetries} retries`);
      }

      const text = await res.text();
      let data: unknown = text;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }

      if (!res.ok) {
        const message = typeof data === "string" ? data : JSON.stringify(data);
        lastError = new Error(`Confluence API error (${res.status}): ${message}`);

        // Retry on server errors (5xx)
        if (res.status >= 500 && attempt < this.maxRetries) {
          await this.sleep(this.baseDelayMs * Math.pow(2, attempt));
          continue;
        }
        throw lastError;
      }

      return data;
    }

    throw lastError ?? new Error("Request failed after retries");
  }

  async getPage(id: string): Promise<ConfluencePage & { storage: string }> {
    const data = (await this.request(`/content/${id}`, {
      query: { expand: "body.storage,version,space" },
    })) as any;
    return {
      id: data.id,
      title: data.title,
      url: data._links?.base ? `${data._links.base}${data._links.webui}` : undefined,
      version: data.version?.number,
      spaceKey: data.space?.key,
      storage: data.body?.storage?.value ?? "",
    };
  }

  async searchPages(cql: string, limit = 25): Promise<ConfluenceSearchResult[]> {
    const data = (await this.request("/content/search", {
      query: { cql, limit },
    })) as any;
    const results = Array.isArray(data.results) ? data.results : [];
    return results.map((item: any) => ({
      id: item.id,
      title: item.title,
      url: item._links?.base ? `${item._links.base}${item._links.webui}` : undefined,
      spaceKey: item.space?.key,
    }));
  }

  async createPage(params: {
    spaceKey: string;
    title: string;
    storage: string;
  }): Promise<ConfluencePage> {
    const data = (await this.request("/content", {
      method: "POST",
      body: {
        type: "page",
        title: params.title,
        space: { key: params.spaceKey },
        body: {
          storage: {
            value: params.storage,
            representation: "storage",
          },
        },
      },
    })) as any;
    return {
      id: data.id,
      title: data.title,
      url: data._links?.base ? `${data._links.base}${data._links.webui}` : undefined,
      version: data.version?.number,
      spaceKey: data.space?.key,
    };
  }

  async updatePage(params: {
    id: string;
    title: string;
    storage: string;
    version: number;
  }): Promise<ConfluencePage> {
    const data = (await this.request(`/content/${params.id}`, {
      method: "PUT",
      body: {
        id: params.id,
        type: "page",
        title: params.title,
        version: { number: params.version },
        body: {
          storage: {
            value: params.storage,
            representation: "storage",
          },
        },
      },
    })) as any;
    return {
      id: data.id,
      title: data.title,
      url: data._links?.base ? `${data._links.base}${data._links.webui}` : undefined,
      version: data.version?.number,
      spaceKey: data.space?.key,
    };
  }

  /**
   * Get page version info only (lightweight check for polling).
   */
  async getPageVersion(id: string): Promise<PageChangeInfo> {
    const data = (await this.request(`/content/${id}`, {
      query: { expand: "version,space,history.lastUpdated" },
    })) as any;
    return {
      id: data.id,
      title: data.title,
      version: data.version?.number ?? 1,
      lastModified: data.history?.lastUpdated?.when,
      spaceKey: data.space?.key,
    };
  }

  /**
   * Get pages modified since a given date using CQL.
   * Used for efficient polling of spaces or page trees.
   */
  async getPagesSince(params: {
    scope: SyncScope;
    since: string; // ISO date string
    limit?: number;
  }): Promise<PageChangeInfo[]> {
    const { scope, since, limit = 100 } = params;

    // Format date for CQL (YYYY-MM-DD)
    const dateStr = since.split("T")[0];

    let cql: string;
    switch (scope.type) {
      case "page":
        // For single page, just fetch the page directly
        const pageInfo = await this.getPageVersion(scope.pageId);
        return [pageInfo];
      case "tree":
        cql = `ancestor=${scope.ancestorId} AND type=page AND lastModified >= "${dateStr}"`;
        break;
      case "space":
        cql = `space=${scope.spaceKey} AND type=page AND lastModified >= "${dateStr}"`;
        break;
    }

    const data = (await this.request("/content/search", {
      query: { cql, limit, expand: "version,space,history.lastUpdated" },
    })) as any;

    const results = Array.isArray(data.results) ? data.results : [];
    return results.map((item: any) => ({
      id: item.id,
      title: item.title,
      version: item.version?.number ?? 1,
      lastModified: item.history?.lastUpdated?.when,
      spaceKey: item.space?.key,
    }));
  }

  /**
   * Get all pages in a scope (initial sync).
   */
  async getAllPages(params: {
    scope: SyncScope;
    limit?: number;
  }): Promise<PageChangeInfo[]> {
    const { scope, limit = 100 } = params;

    let cql: string;
    switch (scope.type) {
      case "page":
        const pageInfo = await this.getPageVersion(scope.pageId);
        return [pageInfo];
      case "tree":
        cql = `ancestor=${scope.ancestorId} AND type=page`;
        break;
      case "space":
        cql = `space=${scope.spaceKey} AND type=page`;
        break;
    }

    const data = (await this.request("/content/search", {
      query: { cql, limit, expand: "version,space,history.lastUpdated" },
    })) as any;

    const results = Array.isArray(data.results) ? data.results : [];
    return results.map((item: any) => ({
      id: item.id,
      title: item.title,
      version: item.version?.number ?? 1,
      lastModified: item.history?.lastUpdated?.when,
      spaceKey: item.space?.key,
    }));
  }

  /**
   * Fetch multiple pages in parallel with concurrency limit.
   */
  async getPagesBatch(
    ids: string[],
    concurrency = 5
  ): Promise<(ConfluencePage & { storage: string })[]> {
    const results: (ConfluencePage & { storage: string })[] = [];

    for (let i = 0; i < ids.length; i += concurrency) {
      const chunk = ids.slice(i, i + concurrency);
      const pages = await Promise.all(chunk.map((id) => this.getPage(id)));
      results.push(...pages);
    }

    return results;
  }

  // ============ Webhook Management ============

  /**
   * Register a webhook for page events.
   * Note: Requires app/add-on permissions in Confluence.
   */
  async registerWebhook(params: {
    name: string;
    url: string;
    events: string[];
  }): Promise<WebhookRegistration> {
    const data = (await this.webhookRequest("/webhook", {
      method: "POST",
      body: {
        name: params.name,
        url: params.url,
        events: params.events,
        active: true,
      },
    })) as any;

    return {
      id: data.id ?? data.self,
      name: data.name,
      url: data.url,
      events: data.events ?? [],
      active: data.active ?? true,
    };
  }

  /**
   * List all registered webhooks.
   */
  async listWebhooks(): Promise<WebhookRegistration[]> {
    const data = (await this.webhookRequest("/webhook", {})) as any;
    const results = Array.isArray(data) ? data : data.results ?? [];
    return results.map((item: any) => ({
      id: item.id ?? item.self,
      name: item.name,
      url: item.url,
      events: item.events ?? [],
      active: item.active ?? true,
    }));
  }

  /**
   * Delete a webhook by ID.
   */
  async deleteWebhook(webhookId: string): Promise<void> {
    await this.webhookRequest(`/webhook/${webhookId}`, {
      method: "DELETE",
    });
  }

  /**
   * Request helper for webhook API (different base path).
   */
  private async webhookRequest(
    path: string,
    options: {
      method?: string;
      body?: unknown;
    } = {}
  ): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/wiki/rest/webhooks/1.0${path}`);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const res = await fetch(url.toString(), {
        method: options.method ?? "GET",
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });

      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After");
        const delayMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : this.baseDelayMs * Math.pow(2, attempt);

        if (attempt < this.maxRetries) {
          await this.sleep(delayMs);
          continue;
        }
        throw new Error(`Rate limited after ${this.maxRetries} retries`);
      }

      if (res.status === 204) {
        return {}; // No content (DELETE success)
      }

      const text = await res.text();
      let data: unknown = text;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }

      if (!res.ok) {
        const message = typeof data === "string" ? data : JSON.stringify(data);
        lastError = new Error(`Webhook API error (${res.status}): ${message}`);

        if (res.status >= 500 && attempt < this.maxRetries) {
          await this.sleep(this.baseDelayMs * Math.pow(2, attempt));
          continue;
        }
        throw lastError;
      }

      return data;
    }

    throw lastError ?? new Error("Request failed after retries");
  }
}

/** Webhook registration info */
export interface WebhookRegistration {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
}
