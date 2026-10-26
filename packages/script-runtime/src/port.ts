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
  jiraTransitionIssue(key: string, transition: string, options?: TransitionOptions): Promise<void>;
  /**
   * Best effort: takes a transition available right now whose target status
   * (or name) is `status`; with none, changes nothing and says so.
   */
  jiraSetStatus(key: string, status: string, options?: TransitionOptions): Promise<{ moved: boolean; transition?: string }>;
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
  /** The page's storage XHTML as stored (lossless copies), with its `atlcli.*` content properties. */
  confluenceGetPageStorage?(id: string, options: { signal?: AbortSignal }): Promise<ConfluencePageStorageView>;
  /** Direct child pages. */
  confluenceChildren?(id: string, options: { signal?: AbortSignal }): Promise<ConfluencePageRef[]>;
  /** Copies an attachment's bytes host-side (they never enter the sandbox or the plan). */
  confluenceCopyAttachment?(attachmentId: string, sourcePageId: string, toPageId: string): Promise<{ id: string }>;
  confluenceUpdatePage(input: ConfluenceUpdateInput): Promise<{ id: string; version: number }>;
  confluenceAddLabels(pageId: string, labels: string[]): Promise<void>;
  confluenceRemoveLabels(pageId: string, labels: string[]): Promise<void>;
  /** Footer comments with their replies. */
  confluenceComments(pageId: string, options: { signal?: AbortSignal }): Promise<ConfluenceCommentView[]>;
  confluenceAddComment(pageId: string, markdown: string): Promise<{ id: string }>;
  confluenceMovePage(id: string, parentId: string): Promise<{ id: string; version: number }>;
  /** Moves the page to the space's trash. */
  confluenceDeletePage(id: string): Promise<void>;
  /** Archives the page (it leaves the page tree, stays readable). */
  confluenceArchivePage?(id: string): Promise<void>;
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
  /** Transitions available now, with their target status. Optional; without it `jira.transitions` fails. */
  jiraTransitions?(key: string, options: { signal?: AbortSignal }): Promise<JiraTransitionView[]>;
  /** Field changes from the issue's changelog, oldest first. */
  jiraHistory?(key: string, options: { fields?: string[]; signal?: AbortSignal }): Promise<JiraChangeView[]>;
  jiraWatchers?(key: string, options: { signal?: AbortSignal }): Promise<JiraWatcherView[]>;
  jiraAddWatcher?(key: string, user: JiraUserRef): Promise<void>;
  jiraRemoveWatcher?(key: string, user: JiraUserRef): Promise<void>;
  /** Jira sends the e-mail (`/issue/{key}/notify`); users are already resolved. */
  jiraNotify?(key: string, input: JiraNotifyInput): Promise<void>;
  /**
   * Read-only REST escape hatch (`atlcli.jira.rest`): GET a site-relative Jira
   * path such as `/rest/api/3/field`, JSON back. Optional; without it the verb fails.
   */
  jiraRest?(path: string, options: { query?: RestQuery; signal?: AbortSignal }): Promise<unknown>;
  /** As jiraRest, relative to the Confluence base: `/rest/api/…` or `/api/v2/…`. */
  confluenceRest?(path: string, options: { query?: RestQuery; signal?: AbortSignal }): Promise<unknown>;
  /** Writing REST escape hatch (`atlcli.jira.request`); same path rules as jiraRest. JSON (or null) back. */
  jiraRequest?(method: RestWriteMethod, path: string, options: { body?: unknown; query?: RestQuery }): Promise<unknown>;
  /** As jiraRequest, relative to the Confluence base. */
  confluenceRequest?(method: RestWriteMethod, path: string, options: { body?: unknown; query?: RestQuery }): Promise<unknown>;

  jiraComments?(key: string, options: { signal?: AbortSignal }): Promise<JiraCommentView[]>;
  /** A string is Markdown; `{ raw }` is sent unchanged. */
  jiraUpdateComment?(key: string, id: string, body: string | { raw: unknown }): Promise<void>;
  jiraDeleteComment?(key: string, id: string): Promise<void>;
  jiraWorklogs?(key: string, options: { signal?: AbortSignal }): Promise<JiraWorklogView[]>;
  jiraAddWorklog?(key: string, input: JiraWorklogInput): Promise<{ id: string }>;
  jiraVersions?(project: string, options: { signal?: AbortSignal }): Promise<JiraVersionView[]>;
  jiraGetVersion?(id: string, options: { signal?: AbortSignal }): Promise<JiraVersionView>;
  jiraCreateVersion?(input: JiraVersionInput & { project: string; name: string }): Promise<{ id: string }>;
  jiraUpdateVersion?(id: string, input: JiraVersionInput): Promise<void>;
  jiraComponents?(project: string, options: { signal?: AbortSignal }): Promise<JiraComponentView[]>;
  jiraGetComponent?(id: string, options: { signal?: AbortSignal }): Promise<JiraComponentView>;
  jiraCreateComponent?(input: JiraComponentInput & { project: string; name: string }): Promise<{ id: string }>;
  jiraUpdateComponent?(id: string, input: JiraComponentInput): Promise<void>;
  /** Ranks `keys` (in this order) right before or after another issue. */
  jiraRank?(keys: string[], position: { before: string } | { after: string }): Promise<void>;
  jiraDeleteIssue?(key: string, options: { subtasks?: boolean }): Promise<void>;
  /** Copies an issue (summary, description, type, labels; components and parent within a project). */
  jiraCloneIssue?(key: string, input: JiraCloneInput): Promise<{ id: string; key: string }>;
  jiraLinks?(key: string, options: { signal?: AbortSignal }): Promise<JiraIssueLinkView[]>;
  jiraDeleteLink?(id: string): Promise<void>;
  jiraFields?(options: { signal?: AbortSignal }): Promise<JiraFieldView[]>;
  /** Active and inactive users matching `query` (name or email), as Jira finds them. */
  jiraUsers?(query: string, options: { signal?: AbortSignal }): Promise<JiraUserView[]>;
  jiraAttachments?(key: string, options: { signal?: AbortSignal }): Promise<JiraAttachmentListView[]>;

  /** Content properties by key. */
  confluenceProperties?(pageId: string, options: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
  confluenceSetProperty?(pageId: string, key: string, value: unknown): Promise<void>;
  confluenceDeleteProperty?(pageId: string, key: string): Promise<void>;
  confluenceRestrictions?(pageId: string, options: { signal?: AbortSignal }): Promise<ConfluenceRestrictionsView>;
  /** Replaces the given operations' restrictions; an operation left out stays as it is. */
  confluenceSetRestrictions?(pageId: string, input: Partial<ConfluenceRestrictionsView>): Promise<void>;
  /** Newest first. */
  confluenceVersions?(pageId: string, options: { signal?: AbortSignal }): Promise<ConfluenceVersionView[]>;
  confluenceSpaces?(options: { type?: "global" | "personal"; cursor?: string; limit: number; signal?: AbortSignal }): Promise<{
    results: ConfluenceSpaceView[];
    nextCursor?: string;
  }>;
  confluenceInlineComments?(pageId: string, options: { signal?: AbortSignal }): Promise<ConfluenceInlineCommentView[]>;
  confluenceCreateBlogPost?(input: { spaceKey: string; title: string; markdown: string }): Promise<{ id: string; version: number }>;

  /**
   * One HTTP request to an external service, redirects not followed (the
   * runtime re-checks each Location against the grants). `url` and headers
   * already carry resolved secrets. Hosts refuse private addresses.
   */
  httpFetch?(request: HttpRequestInput, options: { signal?: AbortSignal }): Promise<HttpResponseView>;
  /** Value of a secret (`ATLCLI_SECRET_<NAME>` on the CLI); undefined when unset. */
  secret?(name: string): string | undefined;
  /** Local files, relative to the host's working directory; paths passed `checkLocalPath`. */
  fileRead?(path: string, options: { encoding: "utf8" | "base64" }): Promise<string>;
  fileList?(path: string): Promise<LocalFileView[]>;
  fileWrite?(path: string, content: string, options: { encoding: "utf8" | "base64" }): Promise<{ path: string; bytes: number }>;
  /** Script state between runs: one JSON store per script name. */
  stateGet?(store: string, key: string): Promise<unknown>;
  /** `undefined` deletes the key. */
  stateSet?(store: string, key: string, value: unknown): Promise<void>;

  /**
   * Renders a template with the host's engine (atlcli.render); may be async
   * (the CLI loads its Jinja sandbox on first use). Throws
   * an Error named "RenderError" for --strict warnings or an output limit.
   * Optional; without it atlcli.render fails.
   */
  render?(input: unknown, options: RenderInput): RenderOutput | Promise<RenderOutput>;
}

export type RestQuery = Record<string, string | number | boolean>;
export type RestWriteMethod = "POST" | "PUT" | "PATCH" | "DELETE";

export interface JiraCommentView {
  id: string;
  author?: { accountId?: string; displayName?: string };
  created?: string;
  updated?: string;
  markdown: string;
}

export interface JiraWorklogView {
  id: string;
  author?: { accountId?: string; displayName?: string };
  started: string;
  timeSpentSeconds: number;
  markdown?: string;
}

export interface JiraWorklogInput {
  /** Seconds, already parsed from "1h 30m". */
  timeSpentSeconds: number;
  started?: string;
  /** Markdown. */
  comment?: string;
}

export interface JiraVersionView {
  id: string;
  name: string;
  /** Project key. */
  project?: string;
  description?: string;
  released: boolean;
  archived: boolean;
  startDate?: string;
  releaseDate?: string;
}

export interface JiraVersionInput {
  name?: string;
  description?: string;
  startDate?: string;
  releaseDate?: string;
  released?: boolean;
  archived?: boolean;
}

export interface JiraComponentView {
  id: string;
  name: string;
  /** Project key. */
  project?: string;
  description?: string;
  lead?: { accountId?: string; displayName?: string };
}

export interface JiraComponentInput {
  name?: string;
  description?: string;
  /** Resolved user. */
  lead?: JiraUserRef;
}

export interface JiraCloneInput {
  project?: string;
  summary?: string;
  /** Link the clone to its source ("Cloners"); default true. */
  link?: boolean;
  attachments?: boolean;
}

export interface JiraIssueLinkView {
  id: string;
  /** Link type name, e.g. "Blocks". */
  type: string;
  /** How this issue relates: "blocks" (outward) or "is blocked by" (inward). */
  direction: "outward" | "inward";
  phrase: string;
  issue: { key: string; summary?: string; status?: string };
}

export interface JiraFieldView {
  id: string;
  name: string;
  custom: boolean;
  /** Schema type, e.g. "string", "array", "option". */
  type?: string;
}

export interface JiraUserView {
  accountId?: string;
  name?: string;
  displayName?: string;
  email?: string;
  active: boolean;
}

export interface JiraAttachmentListView {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  created?: string;
  author?: string;
}

export interface ConfluenceRestrictionsView {
  read: { accountIds: string[]; groupIds: string[] };
  update: { accountIds: string[]; groupIds: string[] };
}

export interface ConfluenceVersionView {
  number: number;
  when?: string;
  by?: string;
  message?: string;
  minorEdit?: boolean;
}

export interface ConfluenceSpaceView {
  id?: string;
  key: string;
  name: string;
  type: string;
}

export interface ConfluenceInlineCommentView {
  id: string;
  authorId?: string;
  created?: string;
  status?: string;
  /** The page text the comment is anchored to. */
  selection?: string;
  markdown: string;
  replies: ConfluenceInlineCommentView[];
}

export interface HttpRequestInput {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponseView {
  status: number;
  headers: Record<string, string>;
  text: string;
}

export interface LocalFileView {
  name: string;
  type: "file" | "directory";
  size: number;
}

/** Fields set on the transition screen, and a Markdown comment added with it. */
export interface TransitionOptions {
  fields?: Record<string, unknown>;
  comment?: string;
}

export interface JiraTransitionView {
  name: string;
  to: { name: string; category?: string };
}

export interface JiraChangeView {
  at: string;
  author?: string;
  field: string;
  from: string | null;
  to: string | null;
}

export interface JiraWatcherView {
  accountId?: string;
  name?: string;
  displayName?: string;
}

export interface JiraNotifyInput {
  subject: string;
  markdown: string;
  to: {
    users?: JiraUserRef[];
    groups?: string[];
    reporter?: boolean;
    assignee?: boolean;
    watchers?: boolean;
    voters?: boolean;
  };
}

export interface RenderOutput {
  value: unknown;
  warnings: TemplateWarningView[];
}

export interface RenderInput {
  format?: "text" | "adf" | "storage" | "wikimarkup";
  vars: Record<string, unknown>;
  source?: unknown;
  parent?: unknown;
  /** Where, for warnings: "SUP-1 summary". */
  unit: string;
  /** A Jira field kind whose rendered text value is checked (label: no whitespace, …). */
  kind?: "summary" | "label" | "name" | "string" | "number" | "date" | "option";
  /** Frozen clock (ISO) for today/now. */
  now: string;
  strict: boolean;
}

export interface TemplateWarningView {
  code: string;
  message: string;
  unit?: string;
  line?: number;
  column?: number;
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
  /** Markdown, converted by the host; or `storage`, sent unchanged. Exactly one. */
  markdown?: string;
  storage?: string;
  parentId?: string;
  /** Content properties set on the new page, by key. */
  properties?: Record<string, unknown>;
}

export interface ConfluencePageStorageView extends ConfluencePageRef {
  version: number;
  parentId?: string;
  storage: string;
  properties: Record<string, unknown>;
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
