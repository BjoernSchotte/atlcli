import { Buffer } from "node:buffer";
import { Profile, getLogger, generateRequestId, redactSensitive } from "@atlcli/core";
import type {
  JiraProject,
  JiraIssue,
  JiraIssueType,
  JiraSearchResults,
  JiraTransition,
  JiraComment,
  JiraWorklog,
  JiraUser,
  JiraSprint,
  JiraEpic,
  JiraField,
  JiraFilter,
  JiraFilterPermission,
  JiraAttachment,
  CreateIssueInput,
  UpdateIssueInput,
  TransitionIssueInput,
  CreateFilterInput,
  UpdateFilterInput,
  BulkCreateResult,
  AdfDocument,
} from "./types.js";

export type { JiraTransition, JiraSprint, JiraWorklog, JiraEpic, JiraField, JiraFilter, JiraFilterPermission, JiraAttachment } from "./types.js";

/**
 * Jira REST API client for Cloud (v3) and Server (v2).
 *
 * Uses @atlcli/core auth - same credentials work for Confluence and Jira.
 */
export class JiraClient {
  private baseUrl: string;
  private authHeader: string;
  private maxRetries = 3;
  private baseDelayMs = 1000;
  private isCloud: boolean;

  constructor(profile: Profile) {
    this.baseUrl = profile.baseUrl.replace(/\/+$/, "");
    this.isCloud = this.baseUrl.includes(".atlassian.net");

    if (profile.auth.type !== "apiToken") {
      throw new Error("OAuth is not implemented yet. Use API token auth.");
    }
    const email = profile.auth.email ?? "";
    const token = profile.auth.token ?? "";
    const encoded = Buffer.from(`${email}:${token}`).toString("base64");
    this.authHeader = `Basic ${encoded}`;
  }

  /** API version path - v3 for Cloud, v2 for Server */
  private get apiPath(): string {
    return this.isCloud ? "/rest/api/3" : "/rest/api/2";
  }

  /** Agile API path */
  private get agilePath(): string {
    return "/rest/agile/1.0";
  }

  /** Sleep utility for rate limiting */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Core request helper for Jira REST API.
   */
  private async request<T = unknown>(
    path: string,
    options: {
      method?: string;
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      apiBase?: string; // Override API base path
    } = {}
  ): Promise<T> {
    const apiBase = options.apiBase ?? this.apiPath;
    const url = new URL(`${this.baseUrl}${apiBase}${path}`);

    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }

    const logger = getLogger();
    const requestId = generateRequestId();
    const method = options.method ?? "GET";
    const startTime = Date.now();

    // Log request
    logger.api("request", {
      requestId,
      method,
      url: url.toString(),
      path,
      headers: redactSensitive({
        Authorization: this.authHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
      }),
      body: options.body ? redactSensitive(options.body) : undefined,
    });

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const res = await fetch(url.toString(), {
        method,
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
        const error = new Error(`Rate limited by Jira API after ${this.maxRetries} retries`);
        logger.api("response", {
          requestId,
          status: res.status,
          statusText: "Too Many Requests",
          durationMs: Date.now() - startTime,
          error: error.message,
        });
        throw error;
      }

      // Handle 204 No Content
      if (res.status === 204) {
        logger.api("response", {
          requestId,
          status: res.status,
          statusText: res.statusText,
          durationMs: Date.now() - startTime,
        });
        return {} as T;
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
        lastError = new Error(`Jira API error (${res.status}): ${message}`);

        // Retry on server errors (5xx)
        if (res.status >= 500 && attempt < this.maxRetries) {
          await this.sleep(this.baseDelayMs * Math.pow(2, attempt));
          continue;
        }
        logger.api("response", {
          requestId,
          status: res.status,
          statusText: res.statusText,
          body: redactSensitive(data),
          durationMs: Date.now() - startTime,
          error: lastError.message,
        });
        throw lastError;
      }

      // Log successful response
      logger.api("response", {
        requestId,
        status: res.status,
        statusText: res.statusText,
        body: redactSensitive(data),
        durationMs: Date.now() - startTime,
      });

      return data as T;
    }

    throw lastError ?? new Error("Request failed after retries");
  }

  // ============ Myself ============

  /**
   * Get the current user.
   *
   * GET /rest/api/3/myself
   */
  async getCurrentUser(): Promise<JiraUser> {
    return this.request<JiraUser>("/myself");
  }

  // ============ Project Operations ============

  /**
   * List all projects accessible to the user.
   *
   * GET /rest/api/3/project/search
   */
  async listProjects(options: {
    startAt?: number;
    maxResults?: number;
    orderBy?: string;
    query?: string;
    typeKey?: string;
    expand?: string;
  } = {}): Promise<{ values: JiraProject[]; total: number }> {
    const data = await this.request<{
      values: JiraProject[];
      total: number;
      startAt: number;
      maxResults: number;
    }>("/project/search", {
      query: {
        startAt: options.startAt,
        maxResults: options.maxResults ?? 50,
        orderBy: options.orderBy,
        query: options.query,
        typeKey: options.typeKey,
        expand: options.expand,
      },
    });

    return {
      values: data.values.map((p) => this.parseProject(p)),
      total: data.total,
    };
  }

  /**
   * Get a project by key or ID.
   *
   * GET /rest/api/3/project/{projectIdOrKey}
   */
  async getProject(keyOrId: string): Promise<JiraProject> {
    const data = await this.request<JiraProject>(`/project/${keyOrId}`, {
      query: { expand: "description,lead,issueTypes" },
    });
    return this.parseProject(data);
  }

  /**
   * Create a new project.
   *
   * POST /rest/api/3/project
   */
  async createProject(params: {
    key: string;
    name: string;
    projectTypeKey: "software" | "service_desk" | "business";
    projectTemplateKey?: string;
    description?: string;
    leadAccountId?: string;
    url?: string;
    assigneeType?: "PROJECT_LEAD" | "UNASSIGNED";
  }): Promise<JiraProject> {
    const data = await this.request<JiraProject>("/project", {
      method: "POST",
      body: params,
    });
    return this.parseProject(data);
  }

  /**
   * Get issue types for a project.
   *
   * GET /rest/api/3/project/{projectIdOrKey}/statuses
   * (Alternative: use project with expand=issueTypes)
   */
  async getProjectIssueTypes(keyOrId: string): Promise<JiraIssueType[]> {
    const project = await this.request<{ issueTypes?: JiraIssueType[] }>(
      `/project/${keyOrId}`,
      { query: { expand: "issueTypes" } }
    );
    return project.issueTypes ?? [];
  }

  private parseProject(data: any): JiraProject {
    return {
      id: data.id,
      key: data.key,
      name: data.name,
      description: data.description,
      lead: data.lead,
      url: data.self,
      projectTypeKey: data.projectTypeKey,
      style: data.style,
      avatarUrls: data.avatarUrls,
      simplified: data.simplified,
    };
  }

  // ============ Component Operations ============

  /**
   * Get all components for a project.
   *
   * GET /rest/api/3/project/{projectIdOrKey}/components
   */
  async getProjectComponents(projectKeyOrId: string): Promise<JiraComponent[]> {
    return this.request<JiraComponent[]>(`/project/${projectKeyOrId}/components`);
  }

  /**
   * Get a component by ID.
   *
   * GET /rest/api/3/component/{id}
   */
  async getComponent(id: string): Promise<JiraComponent> {
    return this.request<JiraComponent>(`/component/${id}`);
  }

  /**
   * Create a component.
   *
   * POST /rest/api/3/component
   */
  async createComponent(input: {
    project: string;
    name: string;
    description?: string;
    leadAccountId?: string;
  }): Promise<JiraComponent> {
    return this.request<JiraComponent>("/component", {
      method: "POST",
      body: input,
    });
  }

  /**
   * Update a component.
   *
   * PUT /rest/api/3/component/{id}
   */
  async updateComponent(
    id: string,
    input: {
      name?: string;
      description?: string;
      leadAccountId?: string;
    }
  ): Promise<JiraComponent> {
    return this.request<JiraComponent>(`/component/${id}`, {
      method: "PUT",
      body: input,
    });
  }

  /**
   * Delete a component.
   *
   * DELETE /rest/api/3/component/{id}
   */
  async deleteComponent(id: string): Promise<void> {
    await this.request(`/component/${id}`, { method: "DELETE" });
  }

  // ============ Version Operations ============

  /**
   * Get all versions for a project.
   *
   * GET /rest/api/3/project/{projectIdOrKey}/versions
   */
  async getProjectVersions(projectKeyOrId: string): Promise<JiraVersion[]> {
    return this.request<JiraVersion[]>(`/project/${projectKeyOrId}/versions`);
  }

  /**
   * Get a version by ID.
   *
   * GET /rest/api/3/version/{id}
   */
  async getVersion(id: string): Promise<JiraVersion> {
    return this.request<JiraVersion>(`/version/${id}`);
  }

  /**
   * Create a version.
   *
   * POST /rest/api/3/version
   */
  async createVersion(input: {
    projectId: string;
    name: string;
    description?: string;
    startDate?: string;
    releaseDate?: string;
  }): Promise<JiraVersion> {
    return this.request<JiraVersion>("/version", {
      method: "POST",
      body: input,
    });
  }

  /**
   * Update a version.
   *
   * PUT /rest/api/3/version/{id}
   */
  async updateVersion(
    id: string,
    input: {
      name?: string;
      description?: string;
      startDate?: string;
      releaseDate?: string;
      released?: boolean;
      archived?: boolean;
    }
  ): Promise<JiraVersion> {
    return this.request<JiraVersion>(`/version/${id}`, {
      method: "PUT",
      body: input,
    });
  }

  /**
   * Delete a version.
   *
   * DELETE /rest/api/3/version/{id}
   */
  async deleteVersion(id: string): Promise<void> {
    await this.request(`/version/${id}`, { method: "DELETE" });
  }

  // ============ Field Operations ============

  /**
   * Get all fields in the Jira instance.
   * Useful for detecting custom fields like story points.
   *
   * GET /rest/api/3/field
   */
  async getFields(): Promise<JiraField[]> {
    return this.request<JiraField[]>("/field");
  }

  /**
   * Detect the story points field by searching field names.
   * Returns the field ID (e.g., "customfield_10016") or null if not found.
   */
  async detectStoryPointsField(): Promise<string | null> {
    const fields = await this.getFields();
    const storyPointsField = fields.find(
      (f) =>
        f.name.toLowerCase().includes("story point") ||
        f.name.toLowerCase() === "points" ||
        f.name.toLowerCase() === "estimation"
    );
    return storyPointsField?.id || null;
  }

  // ============ Filter Operations ============

  /**
   * List/search saved filters.
   *
   * GET /rest/api/3/filter/search
   */
  async listFilters(
    options: {
      filterName?: string;
      startAt?: number;
      maxResults?: number;
      expand?: string;
      favourite?: boolean;
    } = {}
  ): Promise<{ values: JiraFilter[]; total: number }> {
    const query: Record<string, string | number | boolean> = {};
    if (options.filterName) query.filterName = options.filterName;
    if (options.startAt !== undefined) query.startAt = options.startAt;
    if (options.maxResults !== undefined) query.maxResults = options.maxResults;
    if (options.expand) query.expand = options.expand;

    const data = await this.request<{
      values: JiraFilter[];
      total: number;
      startAt: number;
      maxResults: number;
      isLast: boolean;
    }>("/filter/search", { query });

    return { values: data.values, total: data.total };
  }

  /**
   * Get my favourite filters.
   *
   * GET /rest/api/3/filter/favourite
   */
  async getFavouriteFilters(): Promise<JiraFilter[]> {
    return this.request<JiraFilter[]>("/filter/favourite");
  }

  /**
   * Get a filter by ID.
   *
   * GET /rest/api/3/filter/{id}
   */
  async getFilter(
    id: string,
    options: { expand?: string } = {}
  ): Promise<JiraFilter> {
    const query: Record<string, string> = {};
    if (options.expand) query.expand = options.expand;

    return this.request<JiraFilter>(`/filter/${id}`, { query });
  }

  /**
   * Create a new filter.
   *
   * POST /rest/api/3/filter
   */
  async createFilter(input: CreateFilterInput): Promise<JiraFilter> {
    return this.request<JiraFilter>("/filter", {
      method: "POST",
      body: input,
    });
  }

  /**
   * Update a filter.
   *
   * PUT /rest/api/3/filter/{id}
   */
  async updateFilter(
    id: string,
    input: UpdateFilterInput
  ): Promise<JiraFilter> {
    return this.request<JiraFilter>(`/filter/${id}`, {
      method: "PUT",
      body: input,
    });
  }

  /**
   * Delete a filter.
   *
   * DELETE /rest/api/3/filter/{id}
   */
  async deleteFilter(id: string): Promise<void> {
    await this.request(`/filter/${id}`, {
      method: "DELETE",
    });
  }

  /**
   * Add a share permission to a filter.
   *
   * POST /rest/api/3/filter/{id}/permission
   */
  async addFilterPermission(
    id: string,
    permission: {
      type: "global" | "project" | "group" | "user";
      projectId?: string;
      groupname?: string;
      accountId?: string;
    }
  ): Promise<JiraFilterPermission> {
    return this.request<JiraFilterPermission>(`/filter/${id}/permission`, {
      method: "POST",
      body: permission,
    });
  }

  /**
   * Get filter share permissions.
   *
   * GET /rest/api/3/filter/{id}/permission
   */
  async getFilterPermissions(id: string): Promise<JiraFilterPermission[]> {
    return this.request<JiraFilterPermission[]>(`/filter/${id}/permission`);
  }

  /**
   * Delete a filter share permission.
   *
   * DELETE /rest/api/3/filter/{id}/permission/{permissionId}
   */
  async deleteFilterPermission(
    filterId: string,
    permissionId: number
  ): Promise<void> {
    await this.request(`/filter/${filterId}/permission/${permissionId}`, {
      method: "DELETE",
    });
  }

  // ============ Issue Operations ============

  /**
   * Get an issue by key or ID.
   *
   * GET /rest/api/3/issue/{issueIdOrKey}
   */
  async getIssue(
    keyOrId: string,
    options: {
      fields?: string[];
      expand?: string;
    } = {}
  ): Promise<JiraIssue> {
    const query: Record<string, string | undefined> = {};
    if (options.fields) {
      query.fields = options.fields.join(",");
    }
    if (options.expand) {
      query.expand = options.expand;
    }

    return this.request<JiraIssue>(`/issue/${keyOrId}`, { query });
  }

  /**
   * Create a new issue.
   *
   * POST /rest/api/3/issue
   */
  async createIssue(input: CreateIssueInput): Promise<JiraIssue> {
    const data = await this.request<{ id: string; key: string; self: string }>(
      "/issue",
      {
        method: "POST",
        body: input,
      }
    );

    // Fetch the full issue to return
    return this.getIssue(data.key);
  }

  /**
   * Create multiple issues at once.
   *
   * POST /rest/api/3/issue/bulk
   * Max 1000 issues per request.
   */
  async createIssuesBulk(issues: CreateIssueInput[]): Promise<BulkCreateResult> {
    return this.request<BulkCreateResult>("/issue/bulk", {
      method: "POST",
      body: { issueUpdates: issues },
    });
  }

  /**
   * Update an issue.
   *
   * PUT /rest/api/3/issue/{issueIdOrKey}
   */
  async updateIssue(
    keyOrId: string,
    input: UpdateIssueInput,
    options: { notifyUsers?: boolean } = {}
  ): Promise<void> {
    await this.request(`/issue/${keyOrId}`, {
      method: "PUT",
      query: { notifyUsers: options.notifyUsers },
      body: input,
    });
  }

  /**
   * Delete an issue.
   *
   * DELETE /rest/api/3/issue/{issueIdOrKey}
   */
  async deleteIssue(
    keyOrId: string,
    options: { deleteSubtasks?: boolean } = {}
  ): Promise<void> {
    await this.request(`/issue/${keyOrId}`, {
      method: "DELETE",
      query: { deleteSubtasks: options.deleteSubtasks ?? false },
    });
  }

  /**
   * Get available transitions for an issue.
   *
   * GET /rest/api/3/issue/{issueIdOrKey}/transitions
   */
  async getTransitions(keyOrId: string): Promise<JiraTransition[]> {
    const data = await this.request<{ transitions: JiraTransition[] }>(
      `/issue/${keyOrId}/transitions`
    );
    return data.transitions;
  }

  /**
   * Transition an issue to a new status.
   *
   * POST /rest/api/3/issue/{issueIdOrKey}/transitions
   */
  async transitionIssue(
    keyOrId: string,
    input: TransitionIssueInput
  ): Promise<void> {
    await this.request(`/issue/${keyOrId}/transitions`, {
      method: "POST",
      body: input,
    });
  }

  /**
   * Assign an issue to a user.
   *
   * PUT /rest/api/3/issue/{issueIdOrKey}/assignee
   */
  async assignIssue(
    keyOrId: string,
    assignee: { accountId: string } | { name: string } | null
  ): Promise<void> {
    await this.request(`/issue/${keyOrId}/assignee`, {
      method: "PUT",
      body: assignee ?? { accountId: null },
    });
  }

  // ============ Search (JQL) ============

  /**
   * Search for issues using JQL.
   *
   * POST /rest/api/3/search (supports longer JQL queries)
   */
  async search(
    jql: string,
    options: {
      maxResults?: number;
      fields?: string[];
      expand?: string;
      nextPageToken?: string;
    } = {}
  ): Promise<JiraSearchResults> {
    // Use the new /search/jql endpoint as /search is deprecated (410)
    // See: https://developer.atlassian.com/changelog/#CHANGE-2046
    // Note: New endpoint uses nextPageToken for pagination, not startAt
    // Default fields is just "id", use "*navigable" for all navigable fields
    const fields = options.fields ?? ["*navigable"];

    const result = await this.request<{
      issues: JiraIssue[];
      nextPageToken?: string;
      total?: number;
    }>("/search/jql", {
      method: "POST",
      body: {
        jql,
        maxResults: options.maxResults ?? 50,
        fields,
        expand: options.expand,
        nextPageToken: options.nextPageToken,
      },
    });

    return {
      issues: result.issues,
      startAt: 0, // Deprecated, use nextPageToken
      maxResults: options.maxResults ?? 50,
      total: result.total ?? result.issues.length,
      nextPageToken: result.nextPageToken,
    };
  }

  /**
   * Search with GET (for simpler queries).
   * Note: Uses /search/jql endpoint as /search is deprecated.
   */
  async searchGet(
    jql: string,
    options: {
      maxResults?: number;
      fields?: string;
    } = {}
  ): Promise<JiraSearchResults> {
    const result = await this.request<{
      issues: JiraIssue[];
      nextPageToken?: string;
      total?: number;
    }>("/search/jql", {
      query: {
        jql,
        maxResults: options.maxResults ?? 50,
        fields: options.fields ?? "*navigable",
      },
    });

    return {
      issues: result.issues,
      startAt: 0,
      maxResults: options.maxResults ?? 50,
      total: result.total ?? result.issues.length,
      nextPageToken: result.nextPageToken,
    };
  }

  // ============ Comments ============

  /**
   * Get comments for an issue.
   *
   * GET /rest/api/3/issue/{issueIdOrKey}/comment
   */
  async getComments(
    keyOrId: string,
    options: { startAt?: number; maxResults?: number } = {}
  ): Promise<{ comments: JiraComment[]; total: number }> {
    return this.request<{ comments: JiraComment[]; total: number }>(
      `/issue/${keyOrId}/comment`,
      {
        query: {
          startAt: options.startAt,
          maxResults: options.maxResults ?? 50,
        },
      }
    );
  }

  /**
   * Add a comment to an issue.
   *
   * POST /rest/api/3/issue/{issueIdOrKey}/comment
   */
  async addComment(
    keyOrId: string,
    body: AdfDocument | string
  ): Promise<JiraComment> {
    const commentBody = typeof body === "string" ? this.textToAdf(body) : body;

    return this.request<JiraComment>(`/issue/${keyOrId}/comment`, {
      method: "POST",
      body: { body: commentBody },
    });
  }

  // ============ Worklogs ============

  /**
   * Get worklogs for an issue.
   *
   * GET /rest/api/3/issue/{issueIdOrKey}/worklog
   */
  async getWorklogs(
    keyOrId: string,
    options: { startAt?: number; maxResults?: number } = {}
  ): Promise<{ worklogs: JiraWorklog[]; total: number }> {
    return this.request<{ worklogs: JiraWorklog[]; total: number }>(
      `/issue/${keyOrId}/worklog`,
      {
        query: {
          startAt: options.startAt,
          maxResults: options.maxResults ?? 50,
        },
      }
    );
  }

  /**
   * Get a specific worklog by ID.
   *
   * GET /rest/api/3/issue/{issueIdOrKey}/worklog/{worklogId}
   */
  async getWorklog(keyOrId: string, worklogId: string): Promise<JiraWorklog> {
    return this.request<JiraWorklog>(`/issue/${keyOrId}/worklog/${worklogId}`);
  }

  /**
   * Add a worklog to an issue.
   *
   * POST /rest/api/3/issue/{issueIdOrKey}/worklog
   *
   * @param keyOrId - Issue key or ID
   * @param timeSpentSeconds - Time spent in seconds
   * @param options - Optional started date, comment, etc.
   */
  async addWorklog(
    keyOrId: string,
    timeSpentSeconds: number,
    options: {
      started?: string; // ISO 8601 format
      comment?: string;
      adjustEstimate?: "auto" | "leave" | "manual" | "new";
      newEstimate?: string;
      reduceBy?: string;
    } = {}
  ): Promise<JiraWorklog> {
    const body: Record<string, unknown> = {
      timeSpentSeconds,
    };

    if (options.started) {
      body.started = options.started;
    }

    if (options.comment) {
      body.comment = this.textToAdf(options.comment);
    }

    return this.request<JiraWorklog>(`/issue/${keyOrId}/worklog`, {
      method: "POST",
      query: {
        adjustEstimate: options.adjustEstimate,
        newEstimate: options.newEstimate,
        reduceBy: options.reduceBy,
      },
      body,
    });
  }

  /**
   * Update a worklog.
   *
   * PUT /rest/api/3/issue/{issueIdOrKey}/worklog/{worklogId}
   */
  async updateWorklog(
    keyOrId: string,
    worklogId: string,
    updates: {
      timeSpentSeconds?: number;
      started?: string;
      comment?: string;
    }
  ): Promise<JiraWorklog> {
    const body: Record<string, unknown> = {};

    if (updates.timeSpentSeconds !== undefined) {
      body.timeSpentSeconds = updates.timeSpentSeconds;
    }

    if (updates.started) {
      body.started = updates.started;
    }

    if (updates.comment) {
      body.comment = this.textToAdf(updates.comment);
    }

    return this.request<JiraWorklog>(
      `/issue/${keyOrId}/worklog/${worklogId}`,
      {
        method: "PUT",
        body,
      }
    );
  }

  /**
   * Delete a worklog.
   *
   * DELETE /rest/api/3/issue/{issueIdOrKey}/worklog/{worklogId}
   */
  async deleteWorklog(
    keyOrId: string,
    worklogId: string,
    options: {
      adjustEstimate?: "auto" | "leave" | "manual" | "new";
      newEstimate?: string;
      increaseBy?: string;
    } = {}
  ): Promise<void> {
    await this.request(`/issue/${keyOrId}/worklog/${worklogId}`, {
      method: "DELETE",
      query: {
        adjustEstimate: options.adjustEstimate,
        newEstimate: options.newEstimate,
        increaseBy: options.increaseBy,
      },
    });
  }

  // ============ Labels ============

  /**
   * Add labels to an issue.
   */
  async addLabels(keyOrId: string, labels: string[]): Promise<void> {
    await this.updateIssue(keyOrId, {
      update: {
        labels: labels.map((label) => ({ add: label })),
      },
    });
  }

  /**
   * Remove labels from an issue.
   */
  async removeLabels(keyOrId: string, labels: string[]): Promise<void> {
    await this.updateIssue(keyOrId, {
      update: {
        labels: labels.map((label) => ({ remove: label })),
      },
    });
  }

  // ============ Issue Links ============

  /**
   * Create a link between two issues.
   *
   * POST /rest/api/3/issueLink
   */
  async createIssueLink(params: {
    type: { name: string } | { id: string };
    inwardIssue: { key: string } | { id: string };
    outwardIssue: { key: string } | { id: string };
    comment?: { body: AdfDocument | string };
  }): Promise<void> {
    await this.request("/issueLink", {
      method: "POST",
      body: params,
    });
  }

  /**
   * Delete an issue link.
   *
   * DELETE /rest/api/3/issueLink/{linkId}
   */
  async deleteIssueLink(linkId: string): Promise<void> {
    await this.request(`/issueLink/${linkId}`, { method: "DELETE" });
  }

  /**
   * Get all issue link types.
   *
   * GET /rest/api/3/issueLinkType
   */
  async getIssueLinkTypes(): Promise<{ issueLinkTypes: Array<{ id: string; name: string; inward: string; outward: string }> }> {
    return this.request("/issueLinkType");
  }

  // ============ Agile (Board/Sprint) ============

  /**
   * List all boards.
   *
   * GET /rest/agile/1.0/board
   */
  async listBoards(options: {
    startAt?: number;
    maxResults?: number;
    type?: "scrum" | "kanban" | "simple";
    name?: string;
    projectKeyOrId?: string;
  } = {}): Promise<{ values: Array<{ id: number; name: string; type: string }>; total: number }> {
    return this.request("/board", {
      apiBase: this.agilePath,
      query: {
        startAt: options.startAt,
        maxResults: options.maxResults ?? 50,
        type: options.type,
        name: options.name,
        projectKeyOrId: options.projectKeyOrId,
      },
    });
  }

  /**
   * Get a board by ID.
   *
   * GET /rest/agile/1.0/board/{boardId}
   */
  async getBoard(boardId: number): Promise<{ id: number; name: string; type: string; location?: { projectKey?: string } }> {
    return this.request(`/board/${boardId}`, { apiBase: this.agilePath });
  }

  /**
   * List sprints for a board.
   *
   * GET /rest/agile/1.0/board/{boardId}/sprint
   */
  async listSprints(
    boardId: number,
    options: {
      startAt?: number;
      maxResults?: number;
      state?: "future" | "active" | "closed";
    } = {}
  ): Promise<{ values: Array<{ id: number; name: string; state: string; startDate?: string; endDate?: string }>; total: number }> {
    return this.request(`/board/${boardId}/sprint`, {
      apiBase: this.agilePath,
      query: {
        startAt: options.startAt,
        maxResults: options.maxResults ?? 50,
        state: options.state,
      },
    });
  }

  /**
   * Get backlog issues for a board.
   *
   * GET /rest/agile/1.0/board/{boardId}/backlog
   */
  async getBoardBacklog(
    boardId: number,
    options: {
      startAt?: number;
      maxResults?: number;
      jql?: string;
      fields?: string[];
    } = {}
  ): Promise<JiraSearchResults> {
    return this.request(`/board/${boardId}/backlog`, {
      apiBase: this.agilePath,
      query: {
        startAt: options.startAt,
        maxResults: options.maxResults ?? 50,
        jql: options.jql,
        fields: options.fields?.join(","),
      },
    });
  }

  /**
   * Get issues for a board (all issues on the board).
   *
   * GET /rest/agile/1.0/board/{boardId}/issue
   */
  async getBoardIssues(
    boardId: number,
    options: {
      startAt?: number;
      maxResults?: number;
      jql?: string;
      fields?: string[];
    } = {}
  ): Promise<JiraSearchResults> {
    return this.request(`/board/${boardId}/issue`, {
      apiBase: this.agilePath,
      query: {
        startAt: options.startAt,
        maxResults: options.maxResults ?? 50,
        jql: options.jql,
        fields: options.fields?.join(","),
      },
    });
  }

  /**
   * Create a sprint.
   *
   * POST /rest/agile/1.0/sprint
   */
  async createSprint(params: {
    name: string;
    originBoardId: number;
    startDate?: string;
    endDate?: string;
    goal?: string;
  }): Promise<JiraSprint> {
    return this.request("/sprint", {
      apiBase: this.agilePath,
      method: "POST",
      body: params,
    });
  }

  /**
   * Get a sprint by ID.
   *
   * GET /rest/agile/1.0/sprint/{sprintId}
   */
  async getSprint(sprintId: number): Promise<JiraSprint> {
    return this.request(`/sprint/${sprintId}`, { apiBase: this.agilePath });
  }

  /**
   * Update a sprint.
   *
   * PUT /rest/agile/1.0/sprint/{sprintId}
   */
  async updateSprint(
    sprintId: number,
    params: {
      name?: string;
      state?: "future" | "active" | "closed";
      startDate?: string;
      endDate?: string;
      completeDate?: string;
      goal?: string;
    }
  ): Promise<JiraSprint> {
    return this.request(`/sprint/${sprintId}`, {
      apiBase: this.agilePath,
      method: "PUT",
      body: params,
    });
  }

  /**
   * Start a sprint (transition from future to active).
   *
   * POST /rest/agile/1.0/sprint/{sprintId}
   */
  async startSprint(
    sprintId: number,
    params: {
      startDate?: string;
      endDate?: string;
      goal?: string;
    } = {}
  ): Promise<JiraSprint> {
    return this.updateSprint(sprintId, {
      ...params,
      state: "active",
    });
  }

  /**
   * Close/complete a sprint (transition from active to closed).
   *
   * POST /rest/agile/1.0/sprint/{sprintId}
   */
  async closeSprint(sprintId: number, completeDate?: string): Promise<JiraSprint> {
    return this.updateSprint(sprintId, {
      state: "closed",
      completeDate: completeDate ?? new Date().toISOString(),
    });
  }

  /**
   * Delete a sprint.
   *
   * DELETE /rest/agile/1.0/sprint/{sprintId}
   */
  async deleteSprint(sprintId: number): Promise<void> {
    await this.request(`/sprint/${sprintId}`, {
      apiBase: this.agilePath,
      method: "DELETE",
    });
  }

  /**
   * Get issues in a sprint.
   *
   * GET /rest/agile/1.0/sprint/{sprintId}/issue
   */
  async getSprintIssues(
    sprintId: number,
    options: {
      startAt?: number;
      maxResults?: number;
      jql?: string;
      fields?: string[];
    } = {}
  ): Promise<JiraSearchResults> {
    return this.request(`/sprint/${sprintId}/issue`, {
      apiBase: this.agilePath,
      query: {
        startAt: options.startAt,
        maxResults: options.maxResults ?? 50,
        jql: options.jql,
        fields: options.fields?.join(","),
      },
    });
  }

  /**
   * Move issues to a sprint.
   *
   * POST /rest/agile/1.0/sprint/{sprintId}/issue
   */
  async moveIssuesToSprint(
    sprintId: number,
    issues: string[]
  ): Promise<void> {
    await this.request(`/sprint/${sprintId}/issue`, {
      apiBase: this.agilePath,
      method: "POST",
      body: { issues },
    });
  }

  /**
   * Move issues to backlog (remove from sprint).
   *
   * POST /rest/agile/1.0/backlog/issue
   */
  async moveIssuesToBacklog(issues: string[]): Promise<void> {
    await this.request("/backlog/issue", {
      apiBase: this.agilePath,
      method: "POST",
      body: { issues },
    });
  }

  // ============ Epic Operations ============

  /**
   * Get issues in an epic.
   *
   * GET /rest/agile/1.0/epic/{epicIdOrKey}/issue
   */
  async getEpicIssues(
    epicKeyOrId: string,
    options: { startAt?: number; maxResults?: number } = {}
  ): Promise<JiraSearchResults> {
    return this.request(`/epic/${epicKeyOrId}/issue`, {
      apiBase: this.agilePath,
      query: {
        startAt: options.startAt,
        maxResults: options.maxResults ?? 50,
      },
    });
  }

  /**
   * Move issues to an epic.
   *
   * POST /rest/agile/1.0/epic/{epicIdOrKey}/issue
   */
  async moveIssuesToEpic(epicKeyOrId: string, issues: string[]): Promise<void> {
    await this.request(`/epic/${epicKeyOrId}/issue`, {
      apiBase: this.agilePath,
      method: "POST",
      body: { issues },
    });
  }

  /**
   * Remove issues from epic (move to "none" epic).
   *
   * POST /rest/agile/1.0/epic/none/issue
   */
  async removeIssuesFromEpic(issues: string[]): Promise<void> {
    await this.request("/epic/none/issue", {
      apiBase: this.agilePath,
      method: "POST",
      body: { issues },
    });
  }

  /**
   * List epics for a board.
   *
   * GET /rest/agile/1.0/board/{boardId}/epic
   */
  async listBoardEpics(
    boardId: number,
    options: { startAt?: number; maxResults?: number; done?: boolean } = {}
  ): Promise<{ values: JiraEpic[]; total: number }> {
    return this.request(`/board/${boardId}/epic`, {
      apiBase: this.agilePath,
      query: {
        startAt: options.startAt,
        maxResults: options.maxResults ?? 50,
        done: options.done,
      },
    });
  }

  // ============ Attachment Operations ============

  /**
   * Get attachments for an issue.
   *
   * GET /rest/api/3/issue/{keyOrId}?fields=attachment
   */
  async getIssueAttachments(keyOrId: string): Promise<JiraAttachment[]> {
    const issue = await this.request<{ fields: { attachment?: JiraAttachment[] } }>(
      `/issue/${keyOrId}`,
      { query: { fields: "attachment" } }
    );
    return issue.fields.attachment ?? [];
  }

  /**
   * Download an attachment's binary content.
   *
   * Fetches the content URL directly (not through API path).
   */
  async downloadAttachment(contentUrl: string): Promise<Buffer> {
    const logger = getLogger();
    const requestId = generateRequestId();
    const startTime = Date.now();

    logger.api("request", {
      requestId,
      method: "GET",
      url: redactSensitive(contentUrl),
      path: "/attachment/content",
    });

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const res = await fetch(contentUrl, {
          method: "GET",
          headers: {
            Authorization: this.authHeader,
          },
        });

        if (res.status === 429) {
          const retryAfter = res.headers.get("Retry-After");
          const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : this.baseDelayMs * Math.pow(2, attempt);
          logger.api("rate-limited", { requestId, retryAfter: delay });
          await this.sleep(delay);
          continue;
        }

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`Attachment download failed (${res.status}): ${errorText}`);
        }

        const arrayBuffer = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        logger.api("response", {
          requestId,
          status: res.status,
          duration: Date.now() - startTime,
          size: buffer.length,
        });

        return buffer;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.maxRetries - 1) {
          const delay = this.baseDelayMs * Math.pow(2, attempt);
          await this.sleep(delay);
        }
      }
    }

    throw lastError ?? new Error("Attachment download failed");
  }

  /**
   * Upload an attachment to an issue.
   *
   * POST /rest/api/3/issue/{keyOrId}/attachments
   * Uses multipart/form-data.
   */
  async uploadAttachment(
    keyOrId: string,
    filename: string,
    data: Buffer
  ): Promise<JiraAttachment[]> {
    const logger = getLogger();
    const requestId = generateRequestId();
    const url = `${this.baseUrl}${this.apiPath}/issue/${keyOrId}/attachments`;
    const startTime = Date.now();

    logger.api("request", {
      requestId,
      method: "POST",
      url: redactSensitive(url),
      path: `/issue/${keyOrId}/attachments`,
    });

    // Create FormData with file
    const formData = new FormData();
    const blob = new Blob([data]);
    formData.append("file", blob, filename);

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: this.authHeader,
            "X-Atlassian-Token": "no-check", // Required for attachment uploads
          },
          body: formData,
        });

        if (res.status === 429) {
          const retryAfter = res.headers.get("Retry-After");
          const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : this.baseDelayMs * Math.pow(2, attempt);
          logger.api("rate-limited", { requestId, retryAfter: delay });
          await this.sleep(delay);
          continue;
        }

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`Attachment upload failed (${res.status}): ${errorText}`);
        }

        const attachments = await res.json() as JiraAttachment[];

        logger.api("response", {
          requestId,
          status: res.status,
          duration: Date.now() - startTime,
        });

        return attachments;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.maxRetries - 1) {
          const delay = this.baseDelayMs * Math.pow(2, attempt);
          await this.sleep(delay);
        }
      }
    }

    throw lastError ?? new Error("Attachment upload failed");
  }

  // ============ Watcher Operations ============

  /**
   * Get watchers for an issue.
   *
   * GET /rest/api/3/issue/{keyOrId}/watchers
   */
  async getWatchers(keyOrId: string): Promise<{
    watchers: JiraUser[];
    watchCount: number;
    isWatching: boolean;
  }> {
    const result = await this.request<{
      watchers: JiraUser[];
      watchCount: number;
      isWatching: boolean;
    }>(`/issue/${keyOrId}/watchers`);
    return result;
  }

  /**
   * Add a watcher to an issue.
   *
   * POST /rest/api/3/issue/{keyOrId}/watchers
   * Body is just the accountId as a quoted string.
   */
  async addWatcher(keyOrId: string, accountId: string): Promise<void> {
    await this.request(`/issue/${keyOrId}/watchers`, {
      method: "POST",
      body: accountId, // Just the accountId string, not an object
    });
  }

  /**
   * Remove a watcher from an issue.
   *
   * DELETE /rest/api/3/issue/{keyOrId}/watchers?accountId={accountId}
   */
  async removeWatcher(keyOrId: string, accountId: string): Promise<void> {
    await this.request(`/issue/${keyOrId}/watchers`, {
      method: "DELETE",
      query: { accountId },
    });
  }

  // ============ Webhook Operations ============

  /**
   * Register webhooks with Jira.
   *
   * POST /rest/api/3/webhook
   */
  async registerWebhooks(webhooks: Array<{
    jqlFilter: string;
    events: string[];
  }>, url: string): Promise<{
    webhookRegistrationResult: Array<{
      createdWebhookId?: number;
      errors?: string[];
    }>;
  }> {
    return this.request("/webhook", {
      method: "POST",
      body: {
        url,
        webhooks,
      },
    });
  }

  /**
   * Get list of registered webhooks.
   *
   * GET /rest/api/3/webhook
   */
  async getWebhooks(startAt = 0, maxResults = 100): Promise<{
    values: Array<{
      id: number;
      jqlFilter: string;
      fieldIdsFilter?: string[];
      issuePropertyKeysFilter?: string[];
      events: string[];
      expirationDate?: string;
    }>;
    startAt: number;
    maxResults: number;
    total: number;
  }> {
    return this.request("/webhook", {
      query: { startAt, maxResults },
    });
  }

  /**
   * Delete webhooks by ID.
   *
   * DELETE /rest/api/3/webhook
   */
  async deleteWebhooks(webhookIds: number[]): Promise<void> {
    await this.request("/webhook", {
      method: "DELETE",
      body: { webhookIds },
    });
  }

  /**
   * Refresh webhook expiration.
   *
   * PUT /rest/api/3/webhook/refresh
   */
  async refreshWebhooks(webhookIds: number[]): Promise<{
    expirationDate: string;
  }> {
    return this.request("/webhook/refresh", {
      method: "PUT",
      body: { webhookIds },
    });
  }

  // ============ Helpers ============

  /**
   * Convert plain text to ADF (Atlassian Document Format).
   */
  textToAdf(text: string): AdfDocument {
    return {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text,
            },
          ],
        },
      ],
    };
  }

  /**
   * Convert ADF to plain text (basic extraction).
   */
  adfToText(adf: AdfDocument | string | null | undefined): string {
    if (!adf) return "";
    if (typeof adf === "string") return adf;

    const extractText = (nodes: AdfNode[] | undefined): string => {
      if (!nodes) return "";
      return nodes
        .map((node) => {
          if (node.text) return node.text;
          if (node.content) return extractText(node.content);
          return "";
        })
        .join("");
    };

    return extractText(adf.content);
  }
}

// Re-export types
export type { AdfDocument, AdfNode } from "./types.js";
