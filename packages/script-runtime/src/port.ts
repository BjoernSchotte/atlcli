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
    options: { fields?: string[]; properties?: string[]; pageToken?: string; maxResults: number; signal?: AbortSignal },
  ): Promise<{ issues: JiraIssueView[]; nextPageToken?: string }>;
  jiraGetIssue(key: string, options: { fields?: string[]; signal?: AbortSignal }): Promise<JiraIssueView>;
  /** Names of the transitions currently available for the issue. */
  jiraGetTransitions(key: string, options: { signal?: AbortSignal }): Promise<string[]>;
  jiraCreateIssue(input: JiraCreateInput): Promise<{ id: string; key: string }>;
  jiraUpdateIssue(key: string, input: JiraUpdateInput): Promise<void>;
  jiraTransitionIssue(key: string, transition: string): Promise<void>;
  /**
   * Best effort: takes a transition available right now whose target status
   * (or name) is `status`; with none, changes nothing and says so.
   */
  jiraSetStatus(key: string, status: string): Promise<{ moved: boolean; transition?: string }>;
  /** A string is Markdown; `{ raw }` is sent unchanged (ADF on Cloud, wiki markup on Data Center). */
  jiraAddComment(key: string, body: string | { raw: unknown }): Promise<{ id: string }>;
  /** Link types of the site (name plus the outward/inward phrases). */
  jiraLinkTypes(options: { signal?: AbortSignal }): Promise<JiraLinkType[]>;
  /** Creates "`from` <outward phrase> `to`" for the link type named `type`. */
  jiraLinkIssues(input: { type: string; from: string; to: string }): Promise<void>;
  /** Resolves "me", an email, a display name or an account id; throws when unknown or ambiguous. */
  jiraFindUser(query: string, options: { signal?: AbortSignal }): Promise<JiraUserRef>;
  /** `null` unassigns. */
  jiraAssignIssue(key: string, user: JiraUserRef | null): Promise<void>;
  jiraEditLabels(key: string, change: { add?: string[]; remove?: string[] }): Promise<void>;
  jiraAttach(key: string, file: AttachmentInput): Promise<{ id: string }>;
  jiraAttachmentInfo(id: string, options: { signal?: AbortSignal }): Promise<JiraAttachmentView>;
  /** Copies the bytes host-side (they never enter the sandbox or the plan). */
  jiraCopyAttachment(id: string, toKey: string): Promise<{ id: string }>;
  jiraBoards(options: {
    project?: string;
    name?: string;
    startAt: number;
    maxResults: number;
    signal?: AbortSignal;
  }): Promise<{ boards: JiraBoardView[]; next?: number }>;
  jiraGetBoard(id: number, options: { signal?: AbortSignal }): Promise<JiraBoardView>;
  jiraSprints(
    boardId: number,
    options: { state?: JiraSprintState; startAt: number; maxResults: number; signal?: AbortSignal },
  ): Promise<{ sprints: JiraSprintView[]; next?: number }>;
  jiraGetSprint(id: number, options: { signal?: AbortSignal }): Promise<JiraSprintView>;
  jiraCreateSprint(input: JiraSprintInput & { boardId: number; name: string }): Promise<{ id: number }>;
  /** `state: "closed"` completes the sprint now. */
  jiraUpdateSprint(id: number, input: JiraSprintInput & { state?: "active" | "closed" }): Promise<void>;
  jiraMoveToSprint(sprintId: number, keys: string[]): Promise<void>;

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
  confluenceRemoveLabels(pageId: string, labels: string[]): Promise<void>;
  /** Footer comments with their replies. */
  confluenceComments(pageId: string, options: { signal?: AbortSignal }): Promise<ConfluenceCommentView[]>;
  confluenceAddComment(pageId: string, markdown: string): Promise<{ id: string }>;
  confluenceMovePage(id: string, parentId: string): Promise<{ id: string; version: number }>;
  /** Moves the page to the space's trash. */
  confluenceDeletePage(id: string): Promise<void>;
  confluenceAttachments(pageId: string, options: { signal?: AbortSignal }): Promise<ConfluenceAttachmentView[]>;
  /** Uploads, or adds a new version when the page already has an attachment of that name. */
  confluenceAttach(pageId: string, file: AttachmentInput): Promise<{ id: string }>;
  /**
   * Exports a page to a local file. `path` is relative and passed
   * `checkExportPath`; the host decides what it is relative to.
   */
  confluenceExport(input: { pageId: string; format: ExportFormat; path: string }): Promise<{ path: string; bytes: number }>;
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
  /** Issue properties requested by key (`jira.search` `properties`), when set. */
  properties?: Record<string, unknown>;
}

export interface JiraAttachmentView {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
}

export interface JiraCreateInput {
  project: string;
  type: string;
  summary: string;
  /** Markdown; the host converts it. For a lossless copy pass `fields.description` (raw) instead. */
  description?: string;
  fields?: Record<string, unknown>;
  /** Issue properties set on create, by key. */
  properties?: Record<string, unknown>;
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

export interface JiraLinkType {
  name: string;
  /** e.g. "blocks" */
  outward: string;
  /** e.g. "is blocked by" */
  inward: string;
}

/** Cloud identifies users by account id, Data Center by user name. */
export type JiraUserRef = { accountId: string } | { name: string };

export interface AttachmentInput {
  name: string;
  /** Text, or base64 when `encoding` is "base64". */
  content: string;
  encoding: "utf8" | "base64";
}

export interface JiraBoardView {
  id: number;
  name: string;
  type: string;
  projectKey?: string;
}

export type JiraSprintState = "future" | "active" | "closed";

export interface JiraSprintView {
  id: number;
  name: string;
  state: JiraSprintState;
  boardId?: number;
  startDate?: string;
  endDate?: string;
  goal?: string;
}

export interface JiraSprintInput {
  name?: string;
  goal?: string;
  startDate?: string;
  endDate?: string;
}

export interface ConfluenceCommentView {
  id: string;
  authorId?: string;
  created?: string;
  status: string;
  markdown: string;
  replies: ConfluenceCommentView[];
}

export interface ConfluenceAttachmentView {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  version: number;
}

export type ExportFormat = "pdf" | "docx";
