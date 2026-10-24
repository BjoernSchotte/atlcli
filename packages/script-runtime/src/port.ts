/**
 * Operations a host supplies to the script runtime. Operation-level rather than
 * raw HTTP: paging, error shapes and Markdown ↔ Storage/ADF conversion stay in
 * the host's existing clients. The CLI implements this over JiraClient and
 * ConfluenceClient; a browser/Forge host over its own bridge.
 *
 * Every value returned must be plain JSON.
 */
export interface ScriptPort {
  jiraSearch(
    jql: string,
    options: { fields?: string[]; pageToken?: string; maxResults: number; signal?: AbortSignal },
  ): Promise<{ issues: JiraIssueView[]; nextPageToken?: string }>;
  jiraGetIssue(key: string, options: { fields?: string[]; signal?: AbortSignal }): Promise<JiraIssueView>;
  /** Names of the transitions currently available for the issue. */
  jiraGetTransitions(key: string, options: { signal?: AbortSignal }): Promise<string[]>;
  jiraCreateIssue(input: JiraCreateInput): Promise<{ id: string; key: string }>;
  jiraUpdateIssue(key: string, input: JiraUpdateInput): Promise<void>;
  jiraTransitionIssue(key: string, transition: string): Promise<void>;
  jiraAddComment(key: string, markdown: string): Promise<{ id: string }>;

  confluenceSearch(
    cql: string,
    options: { cursor?: string; limit: number; signal?: AbortSignal },
  ): Promise<{ results: ConfluencePageRef[]; nextCursor?: string }>;
  confluenceGetPage(id: string, options: { signal?: AbortSignal }): Promise<ConfluencePageView>;
  /** Exact-title lookup within a space; `null` when absent. */
  confluenceFindPage(
    spaceKey: string,
    title: string,
    options: { signal?: AbortSignal },
  ): Promise<{ id: string; version: number } | null>;
  confluenceCreatePage(input: ConfluenceCreateInput): Promise<{ id: string; version: number }>;
  confluenceUpdatePage(input: ConfluenceUpdateInput): Promise<{ id: string; version: number }>;
  confluenceAddLabels(pageId: string, labels: string[]): Promise<void>;
  /**
   * Markdown as `confluenceGetPage` would return it once stored: the host's
   * Markdown → Storage → Markdown round trip. Lets the runtime spot updates
   * that would not change a page.
   */
  confluenceNormalizeMarkdown(markdown: string): string;
}

export interface JiraIssueView {
  id: string;
  key: string;
  /** Raw Jira fields as requested; `updated` is always present (precondition basis). */
  fields: Record<string, unknown> & { updated: string };
}

export interface JiraCreateInput {
  project: string;
  type: string;
  summary: string;
  /** Markdown; the host converts it. */
  description?: string;
  fields?: Record<string, unknown>;
}

export interface JiraUpdateInput {
  summary?: string;
  description?: string;
  fields?: Record<string, unknown>;
}

export interface ConfluencePageRef {
  id: string;
  title: string;
  spaceKey: string;
}

export interface ConfluencePageView extends ConfluencePageRef {
  version: number;
  parentId?: string;
  markdown: string;
}

export interface ConfluenceCreateInput {
  spaceKey: string;
  title: string;
  markdown: string;
  parentId?: string;
}

export interface ConfluenceUpdateInput {
  id: string;
  title: string;
  markdown: string;
  /** Version the update is based on; the host sends version + 1. */
  version: number;
}
