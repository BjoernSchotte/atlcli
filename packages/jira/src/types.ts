/**
 * Jira API types for atlcli.
 *
 * Based on Jira Cloud REST API v3:
 * https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/
 */

// ============ User Types ============

/** Jira user (Cloud uses accountId, Server uses username) */
export interface JiraUser {
  /** Account ID (Cloud) - opaque string */
  accountId?: string;
  /** Username (Server/DC only) */
  name?: string;
  /** Display name */
  displayName: string;
  /** Email address (if visible) */
  emailAddress?: string;
  /** Avatar URLs */
  avatarUrls?: Record<string, string>;
  /** Whether user is active */
  active?: boolean;
}

// ============ Project Types ============

/** Jira project */
export interface JiraProject {
  /** Project ID */
  id: string;
  /** Project key (e.g., "PROJ") */
  key: string;
  /** Project name */
  name: string;
  /** Project description */
  description?: string;
  /** Project lead */
  lead?: JiraUser;
  /** Project URL */
  url?: string;
  /** Project type: software, service_desk, business */
  projectTypeKey?: string;
  /** Project style: classic, next-gen */
  style?: string;
  /** Avatar URLs */
  avatarUrls?: Record<string, string>;
  /** Whether the project is simplified (next-gen) */
  simplified?: boolean;
}

/** Project category */
export interface JiraProjectCategory {
  id: string;
  name: string;
  description?: string;
}

/** Project component */
export interface JiraComponent {
  id: string;
  name: string;
  description?: string;
  lead?: JiraUser;
  assigneeType?: string;
}

/** Project version/release */
export interface JiraVersion {
  id: string;
  name: string;
  description?: string;
  released?: boolean;
  releaseDate?: string;
  startDate?: string;
  archived?: boolean;
}

// ============ Issue Types ============

/** Issue type definition */
export interface JiraIssueType {
  id: string;
  name: string;
  description?: string;
  /** Whether this is a subtask type */
  subtask: boolean;
  /** Icon URL */
  iconUrl?: string;
  /** Hierarchy level: -1 (subtask), 0 (standard), 1 (epic) */
  hierarchyLevel?: number;
}

/** Issue priority */
export interface JiraPriority {
  id: string;
  name: string;
  description?: string;
  iconUrl?: string;
}

/** Issue status */
export interface JiraStatus {
  id: string;
  name: string;
  description?: string;
  /** Status category: new, indeterminate, done */
  statusCategory?: {
    id: number;
    key: string;
    name: string;
    colorName?: string;
  };
}

/** Issue resolution */
export interface JiraResolution {
  id: string;
  name: string;
  description?: string;
}

/** Issue link type */
export interface JiraIssueLinkType {
  id: string;
  name: string;
  inward: string;
  outward: string;
}

/** Issue link */
export interface JiraIssueLink {
  id: string;
  type: JiraIssueLinkType;
  inwardIssue?: JiraIssueRef;
  outwardIssue?: JiraIssueRef;
}

/** Minimal issue reference */
export interface JiraIssueRef {
  id: string;
  key: string;
  fields?: {
    summary?: string;
    status?: JiraStatus;
    issuetype?: JiraIssueType;
  };
}

/** Issue transition */
export interface JiraTransition {
  id: string;
  name: string;
  to: JiraStatus;
  /** Fields available/required during transition */
  fields?: Record<string, JiraTransitionField>;
}

/** Field in a transition */
export interface JiraTransitionField {
  required: boolean;
  name: string;
  fieldId: string;
  allowedValues?: unknown[];
}

/** Atlassian Document Format (ADF) - rich text for Cloud */
export interface AdfDocument {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

export interface AdfNode {
  type: string;
  content?: AdfNode[];
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

/** Issue fields */
export interface JiraIssueFields {
  summary: string;
  description?: AdfDocument | string | null;
  issuetype: JiraIssueType;
  project: { id: string; key: string; name?: string };
  status: JiraStatus;
  priority?: JiraPriority;
  assignee?: JiraUser | null;
  reporter?: JiraUser;
  creator?: JiraUser;
  created?: string;
  updated?: string;
  resolutiondate?: string;
  resolution?: JiraResolution | null;
  duedate?: string | null;
  labels?: string[];
  components?: JiraComponent[];
  fixVersions?: JiraVersion[];
  versions?: JiraVersion[];
  /** Parent issue (for subtasks or issues in epic) */
  parent?: JiraIssueRef;
  /** Subtasks */
  subtasks?: JiraIssueRef[];
  /** Issue links */
  issuelinks?: JiraIssueLink[];
  /** Time tracking */
  timetracking?: {
    originalEstimate?: string;
    remainingEstimate?: string;
    timeSpent?: string;
    originalEstimateSeconds?: number;
    remainingEstimateSeconds?: number;
    timeSpentSeconds?: number;
  };
  /** Story points (custom field - ID varies per instance) */
  [key: `customfield_${number}`]: unknown;
}

/** Full Jira issue */
export interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: JiraIssueFields;
  /** Changelog (when expanded) */
  changelog?: {
    histories: JiraChangelogEntry[];
  };
}

/** Changelog entry for issue history */
export interface JiraChangelogEntry {
  id: string;
  author: JiraUser;
  created: string;
  items: Array<{
    field: string;
    fieldtype: string;
    from: string | null;
    fromString: string | null;
    to: string | null;
    toString: string | null;
  }>;
}

// ============ Comment Types ============

/** Issue comment */
export interface JiraComment {
  id: string;
  author: JiraUser;
  body: AdfDocument | string;
  created: string;
  updated: string;
  updateAuthor?: JiraUser;
}

// ============ Worklog Types ============

/** Work log entry */
export interface JiraWorklog {
  id: string;
  author: JiraUser;
  updateAuthor?: JiraUser;
  comment?: AdfDocument | string;
  created: string;
  updated: string;
  started: string;
  timeSpent: string;
  timeSpentSeconds: number;
  issueId: string;
}

// ============ Attachment Types ============

/** Issue attachment */
export interface JiraAttachment {
  id: string;
  filename: string;
  author: JiraUser;
  created: string;
  size: number;
  mimeType: string;
  content: string; // Download URL
}

// ============ Agile Types ============

/** Scrum/Kanban board */
export interface JiraBoard {
  id: number;
  name: string;
  type: "scrum" | "kanban" | "simple";
  location?: {
    projectId?: number;
    projectKey?: string;
    projectName?: string;
  };
}

/** Sprint */
export interface JiraSprint {
  id: number;
  name: string;
  state: "future" | "active" | "closed";
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  goal?: string;
  boardId?: number;
}

/** Epic (Agile API) */
export interface JiraEpic {
  id: number;
  key: string;
  name: string;
  summary: string;
  done: boolean;
  color?: {
    key: string;
  };
}

// ============ Search Types ============

/** JQL search results */
export interface JiraSearchResults {
  issues: JiraIssue[];
  /** @deprecated Use nextPageToken for pagination */
  startAt: number;
  maxResults: number;
  total: number;
  /** Token for next page (new pagination model) */
  nextPageToken?: string;
}

// ============ Create/Update Types ============

/** Input for creating an issue */
export interface CreateIssueInput {
  fields: {
    project: { key: string } | { id: string };
    issuetype: { name: string } | { id: string };
    summary: string;
    description?: AdfDocument | string;
    priority?: { name: string } | { id: string };
    assignee?: { accountId: string } | { name: string };
    labels?: string[];
    components?: Array<{ name: string } | { id: string }>;
    fixVersions?: Array<{ name: string } | { id: string }>;
    parent?: { key: string } | { id: string };
    duedate?: string;
    [key: string]: unknown;
  };
}

/** Input for updating an issue */
export interface UpdateIssueInput {
  fields?: Partial<CreateIssueInput["fields"]>;
  update?: Record<string, Array<{ set?: unknown; add?: unknown; remove?: unknown }>>;
}

/** Input for transitioning an issue */
export interface TransitionIssueInput {
  transition: { id: string } | { name: string };
  fields?: Record<string, unknown>;
  update?: Record<string, Array<{ set?: unknown; add?: unknown; remove?: unknown }>>;
}

// ============ Bulk Operation Types ============

/** Bulk create result */
export interface BulkCreateResult {
  issues: Array<{
    id: string;
    key: string;
    self: string;
  }>;
  errors: Array<{
    status: number;
    elementErrors?: {
      errors: Record<string, string>;
      errorMessages: string[];
    };
  }>;
}

/** Bulk operation result for edit/delete */
export interface BulkOperationResult {
  taskId: string;
  status: string;
}

/** Bulk operation summary (for loop-based operations) */
export interface BulkOperationSummary {
  total: number;
  successful: number;
  failed: number;
  errors: Array<{
    key: string;
    error: string;
  }>;
}

// ============ Field Types ============

/** Jira field metadata */
export interface JiraField {
  id: string;
  key?: string;
  name: string;
  custom: boolean;
  orderable?: boolean;
  navigable?: boolean;
  searchable?: boolean;
  clauseNames?: string[];
  schema?: {
    type: string;
    system?: string;
    custom?: string;
    customId?: number;
  };
}

// ============ Analytics Types ============

/** Sprint metrics for analytics */
export interface SprintMetrics {
  sprintId: number;
  sprintName: string;
  state: string;
  startDate?: string;
  endDate?: string;
  completeDate?: string;

  // Points
  committedPoints: number;
  completedPoints: number;

  // Issues
  totalIssues: number;
  completedIssues: number;
  incompleteIssues: number;

  // Scope change
  addedDuringSprint: number;
  removedDuringSprint: number;
  scopeChangePercent: number;

  // Say-do ratio (percentage)
  sayDoRatio: number;
}

/** Burndown data point */
export interface BurndownDataPoint {
  date: string;
  remaining: number;
  ideal: number;
  completed: number;
}

/** Velocity trend data */
export interface VelocityTrend {
  boardId: number;
  boardName: string;
  sprints: Array<{
    id: number;
    name: string;
    velocity: number;
    completedIssues: number;
  }>;
  averageVelocity: number;
  trend: number; // percentage change
}

// ============ Error Types ============

/** Jira API error response */
export interface JiraErrorResponse {
  errorMessages?: string[];
  errors?: Record<string, string>;
  status?: number;
}
