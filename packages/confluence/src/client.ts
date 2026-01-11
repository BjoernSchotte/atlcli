import { Buffer } from "node:buffer";
import { Profile } from "@atlcli/core";

export type ConfluencePage = {
  id: string;
  title: string;
  url?: string;
  version?: number;
  spaceKey?: string;
  parentId?: string | null;
  ancestors?: { id: string; title: string }[];
};

export type ConfluenceSpace = {
  id: string;
  key: string;
  name: string;
  type: "global" | "personal";
  url?: string;
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

/** Attachment metadata from Confluence API */
export interface AttachmentInfo {
  /** Attachment ID (content ID) */
  id: string;
  /** Filename as stored in Confluence */
  filename: string;
  /** MIME type (e.g., "image/png", "application/pdf") */
  mediaType: string;
  /** File size in bytes */
  fileSize: number;
  /** Version number */
  version: number;
  /** Page ID this attachment belongs to */
  pageId: string;
  /** Download URL (relative to wiki base) */
  downloadUrl: string;
  /** Full webui URL for viewing */
  url?: string;
  /** Comment/description for this version */
  comment?: string;
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
      query: { expand: "body.storage,version,space,ancestors" },
    })) as any;

    // Extract ancestors (array of {id, title} from root to parent)
    const ancestors = Array.isArray(data.ancestors)
      ? data.ancestors.map((a: any) => ({ id: a.id, title: a.title }))
      : [];

    // Parent is the last ancestor
    const parentId = ancestors.length > 0 ? ancestors[ancestors.length - 1].id : null;

    return {
      id: data.id,
      title: data.title,
      url: data._links?.base ? `${data._links.base}${data._links.webui}` : undefined,
      version: data.version?.number,
      spaceKey: data.space?.key,
      parentId,
      ancestors,
      storage: data.body?.storage?.value ?? "",
    };
  }

  /**
   * Get ancestors for a page (from root to parent).
   */
  async getAncestors(pageId: string): Promise<{ id: string; title: string }[]> {
    const data = (await this.request(`/content/${pageId}`, {
      query: { expand: "ancestors" },
    })) as any;

    return Array.isArray(data.ancestors)
      ? data.ancestors.map((a: any) => ({ id: a.id, title: a.title }))
      : [];
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
    parentId?: string;
  }): Promise<ConfluencePage> {
    const body: any = {
      type: "page",
      title: params.title,
      space: { key: params.spaceKey },
      body: {
        storage: {
          value: params.storage,
          representation: "storage",
        },
      },
    };

    // Add parent if specified
    if (params.parentId) {
      body.ancestors = [{ id: params.parentId }];
    }

    const data = (await this.request("/content", {
      method: "POST",
      body,
    })) as any;

    // Extract ancestors from response
    const ancestors = Array.isArray(data.ancestors)
      ? data.ancestors.map((a: any) => ({ id: a.id, title: a.title }))
      : [];
    const parentId = ancestors.length > 0 ? ancestors[ancestors.length - 1].id : null;

    return {
      id: data.id,
      title: data.title,
      url: data._links?.base ? `${data._links.base}${data._links.webui}` : undefined,
      version: data.version?.number,
      spaceKey: data.space?.key,
      parentId,
      ancestors,
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

  // ============ Space Operations ============

  /**
   * Create a new Confluence space.
   */
  async createSpace(params: {
    key: string;
    name: string;
    description?: string;
  }): Promise<ConfluenceSpace> {
    const data = (await this.request("/space", {
      method: "POST",
      body: {
        key: params.key,
        name: params.name,
        description: params.description
          ? {
              plain: {
                value: params.description,
                representation: "plain",
              },
            }
          : undefined,
      },
    })) as any;
    return {
      id: data.id,
      key: data.key,
      name: data.name,
      type: data.type ?? "global",
      url: data._links?.base ? `${data._links.base}${data._links.webui}` : undefined,
    };
  }

  /**
   * List all spaces.
   */
  async listSpaces(limit = 25): Promise<ConfluenceSpace[]> {
    const data = (await this.request("/space", {
      query: { limit },
    })) as any;
    const results = Array.isArray(data.results) ? data.results : [];
    return results.map((item: any) => ({
      id: item.id,
      key: item.key,
      name: item.name,
      type: item.type ?? "global",
      url: item._links?.base ? `${item._links.base}${item._links.webui}` : undefined,
    }));
  }

  /**
   * Get a space by key.
   */
  async getSpace(key: string): Promise<ConfluenceSpace> {
    const data = (await this.request(`/space/${key}`, {})) as any;
    return {
      id: data.id,
      key: data.key,
      name: data.name,
      type: data.type ?? "global",
      url: data._links?.base ? `${data._links.base}${data._links.webui}` : undefined,
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

  // ============ Attachment Operations ============

  /**
   * List attachments for a page.
   *
   * GET /content/{id}/child/attachment
   */
  async listAttachments(
    pageId: string,
    options: { limit?: number } = {}
  ): Promise<AttachmentInfo[]> {
    const data = (await this.request(`/content/${pageId}/child/attachment`, {
      query: {
        expand: "version,metadata.mediaType",
        limit: options.limit ?? 100,
      },
    })) as any;

    const results = Array.isArray(data.results) ? data.results : [];
    return results.map((item: any) => this.parseAttachmentResponse(item, pageId));
  }

  /**
   * Get a single attachment by ID.
   *
   * GET /content/{attachmentId}
   */
  async getAttachment(attachmentId: string): Promise<AttachmentInfo> {
    const data = (await this.request(`/content/${attachmentId}`, {
      query: { expand: "version,container,metadata.mediaType" },
    })) as any;

    return this.parseAttachmentResponse(data, data.container?.id ?? "");
  }

  /**
   * Upload a new attachment to a page.
   *
   * POST /content/{id}/child/attachment
   * Requires multipart/form-data with X-Atlassian-Token: nocheck header.
   */
  async uploadAttachment(params: {
    pageId: string;
    filename: string;
    data: Buffer | Uint8Array;
    mimeType?: string;
    comment?: string;
  }): Promise<AttachmentInfo> {
    const { pageId, filename, data, mimeType, comment } = params;

    const formData = new FormData();
    const blob = new Blob([data], {
      type: mimeType ?? this.detectMimeType(filename),
    });
    formData.append("file", blob, filename);

    if (comment) {
      formData.append("comment", comment);
    }

    const result = await this.requestMultipart(
      `/content/${pageId}/child/attachment`,
      formData
    );

    return this.parseAttachmentResponse(result, pageId);
  }

  /**
   * Update an existing attachment with new data.
   *
   * POST /content/{pageId}/child/attachment/{attachmentId}/data
   */
  async updateAttachment(params: {
    attachmentId: string;
    pageId: string;
    data: Buffer | Uint8Array;
    mimeType?: string;
    comment?: string;
  }): Promise<AttachmentInfo> {
    const { attachmentId, pageId, data, mimeType, comment } = params;

    const formData = new FormData();
    const blob = new Blob([data], {
      type: mimeType ?? "application/octet-stream",
    });
    formData.append("file", blob);

    if (comment) {
      formData.append("comment", comment);
    }

    const result = await this.requestMultipart(
      `/content/${pageId}/child/attachment/${attachmentId}/data`,
      formData
    );

    return this.parseAttachmentResponse(result, pageId);
  }

  /**
   * Delete an attachment.
   *
   * DELETE /content/{attachmentId}
   */
  async deleteAttachment(attachmentId: string): Promise<void> {
    await this.request(`/content/${attachmentId}`, {
      method: "DELETE",
    });
  }

  /**
   * Download attachment binary data.
   *
   * GET {downloadUrl} (relative to wiki base)
   */
  async downloadAttachment(
    attachment: AttachmentInfo | { downloadUrl: string }
  ): Promise<Buffer> {
    return this.requestBinary(attachment.downloadUrl);
  }

  /**
   * Request helper for multipart form data uploads.
   */
  private async requestMultipart(
    path: string,
    formData: FormData
  ): Promise<any> {
    const url = new URL(`${this.baseUrl}/wiki/rest/api${path}`);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          "X-Atlassian-Token": "nocheck",
          // Note: Do NOT set Content-Type - fetch will set it with boundary
        },
        body: formData,
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
        lastError = new Error(`Attachment upload error (${res.status}): ${message}`);

        if (res.status >= 500 && attempt < this.maxRetries) {
          await this.sleep(this.baseDelayMs * Math.pow(2, attempt));
          continue;
        }
        throw lastError;
      }

      return data;
    }

    throw lastError ?? new Error("Upload failed after retries");
  }

  /**
   * Request helper for binary downloads.
   */
  private async requestBinary(downloadPath: string): Promise<Buffer> {
    const url = new URL(`${this.baseUrl}/wiki${downloadPath}`);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: this.authHeader,
        },
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

      if (!res.ok) {
        lastError = new Error(`Download error (${res.status})`);

        if (res.status >= 500 && attempt < this.maxRetries) {
          await this.sleep(this.baseDelayMs * Math.pow(2, attempt));
          continue;
        }
        throw lastError;
      }

      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }

    throw lastError ?? new Error("Download failed after retries");
  }

  /**
   * Parse Confluence attachment API response to AttachmentInfo.
   */
  private parseAttachmentResponse(data: any, pageId: string): AttachmentInfo {
    // Handle both single result and array response (POST returns array)
    const item = Array.isArray(data.results) ? data.results[0] : data;

    return {
      id: item.id,
      filename: item.title,
      mediaType: item.metadata?.mediaType || item.extensions?.mediaType || "application/octet-stream",
      fileSize: item.extensions?.fileSize ?? 0,
      version: item.version?.number ?? 1,
      pageId,
      downloadUrl: item._links?.download ?? "",
      url: item._links?.base ? `${item._links.base}${item._links.webui}` : undefined,
      comment: item.metadata?.comment,
    };
  }

  /**
   * Detect MIME type from filename extension.
   */
  private detectMimeType(filename: string): string {
    const ext = filename.toLowerCase().split(".").pop();
    const mimeTypes: Record<string, string> = {
      // Images
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      svg: "image/svg+xml",
      webp: "image/webp",
      // Documents
      pdf: "application/pdf",
      doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls: "application/vnd.ms-excel",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      // Text
      txt: "text/plain",
      md: "text/markdown",
      json: "application/json",
      xml: "application/xml",
      yaml: "application/x-yaml",
      yml: "application/x-yaml",
      // Archives
      zip: "application/zip",
      tar: "application/x-tar",
      gz: "application/gzip",
    };
    return mimeTypes[ext ?? ""] ?? "application/octet-stream";
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

  // ============ Label Operations ============

  /**
   * Get labels for a page.
   *
   * GET /content/{id}/label
   */
  async getLabels(pageId: string): Promise<LabelInfo[]> {
    const data = (await this.request(`/content/${pageId}/label`, {
      query: { limit: 200 },
    })) as any;

    const results = Array.isArray(data.results) ? data.results : [];
    return results.map((item: any) => ({
      prefix: item.prefix ?? "global",
      name: item.name,
      id: item.id,
    }));
  }

  /**
   * Add one or more labels to a page.
   *
   * POST /content/{id}/label
   */
  async addLabels(pageId: string, labels: string[]): Promise<LabelInfo[]> {
    const body = labels.map((name) => ({
      prefix: "global",
      name,
    }));

    const data = (await this.request(`/content/${pageId}/label`, {
      method: "POST",
      body,
    })) as any;

    const results = Array.isArray(data.results) ? data.results : [];
    return results.map((item: any) => ({
      prefix: item.prefix ?? "global",
      name: item.name,
      id: item.id,
    }));
  }

  /**
   * Remove a label from a page.
   *
   * DELETE /content/{id}/label/{label}
   */
  async removeLabel(pageId: string, label: string): Promise<void> {
    await this.request(`/content/${pageId}/label/${encodeURIComponent(label)}`, {
      method: "DELETE",
    });
  }

  /**
   * Get pages with a specific label.
   *
   * Uses CQL: label = "labelname" [AND space = "SPACEKEY"]
   */
  async getPagesByLabel(
    label: string,
    options: { spaceKey?: string; limit?: number } = {}
  ): Promise<PageChangeInfo[]> {
    const { spaceKey, limit = 100 } = options;

    let cql = `label = "${label}" AND type = page`;
    if (spaceKey) {
      cql += ` AND space = "${spaceKey}"`;
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
}

/** Webhook registration info */
export interface WebhookRegistration {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
}

/** Label info from Confluence API */
export interface LabelInfo {
  /** Label prefix (usually "global" for user-created labels) */
  prefix: string;
  /** Label name */
  name: string;
  /** Label ID */
  id: string;
}
