import {
  ResearchContractError,
  type ResearchToolId,
} from "./contracts.js";

/**
 * Versioned read-only capability contracts shared by every research host.
 */

export const RESEARCH_CAPABILITY_SCHEMAS = {
  "jira.issue.search": {
    input: "atlcli.ptc/jira.issue.search.input/v1",
    output: "atlcli.ptc/jira.issue.search.output/v1",
  },
  "jira.issue.get": {
    input: "atlcli.ptc/jira.issue.get.input/v1",
    output: "atlcli.ptc/jira.issue.get.output/v1",
  },
  "wiki.search": {
    input: "atlcli.ptc/wiki.search.input/v1",
    output: "atlcli.ptc/wiki.search.output/v1",
  },
  "wiki.page.get": {
    input: "atlcli.ptc/wiki.page.get.input/v1",
    output: "atlcli.ptc/wiki.page.get.output/v1",
  },
  "research.candidate.rank": {
    input: "atlcli.ptc/research.candidate.rank.input/v1",
    output: "atlcli.ptc/research.candidate.rank.output/v1",
  },
} as const;

export const RESEARCH_LANGCHAIN_TOOL_NAMES: Record<ResearchToolId, string> = {
  "jira.issue.search": "jira_issue_search",
  "jira.issue.get": "jira_issue_get",
  "wiki.search": "wiki_search",
  "wiki.page.get": "wiki_page_get",
  "research.candidate.rank": "research_candidate_rank",
};

export interface ResearchSearchQueryV1 {
  text?: string;
  /**
   * Exact labels to require. Multiple labels are conjunctive: every returned
   * item must carry every requested label. The host compiles this intent; the
   * model never receives JQL or CQL.
   */
  labels?: string[];
  /**
   * A Confluence page ID whose descendants may be searched. This is not
   * meaningful for Jira and is rejected for the Jira capability.
   */
  ancestorId?: string;
  /**
   * A Confluence page ID whose direct children may be searched. It is mutually
   * exclusive with ancestorId so the model cannot create ambiguous traversal
   * semantics; the host keeps the original space and time bounds in either
   * case.
   */
  parentId?: string;
}

export type ResearchSearchInputV1 =
  | {
      schema: string;
      query: ResearchSearchQueryV1;
      pageSize?: number;
    }
  | {
      schema: string;
      cursor: string;
    };

export interface ResearchGetInputV1 {
  schema: string;
  entityRef: string;
  /**
   * Confluence only. The host may make one separately bounded inline-comment
   * sidecar read for this already-ranked page. It never changes the page
   * identity, scope, or opaque entity reference.
   */
  includeComments?: boolean;
}

export type ResearchTerminationCode =
  | "index-exhausted"
  | "item-limit"
  | "page-limit"
  | "http-limit"
  | "response-byte-limit";

export interface ResearchBudgetSnapshotV1 {
  ptcRemaining: number;
  httpAttemptsRemaining: number;
  responseBytesRemaining: number;
}

export interface ResearchEntitySummaryV1 {
  sourceId: string;
  entityRef: string;
  product: "jira" | "confluence";
  title: string;
  url: string;
  issueKey?: string;
  contentId?: string;
  projectKey?: string;
  spaceKey?: string;
  updatedAt?: string;
  excerpt?: string;
}

export interface ResearchSearchOutputV1 {
  schema: string;
  items: ResearchEntitySummaryV1[];
  page: {
    nextCursor?: string;
    complete: boolean;
    termination?: ResearchTerminationCode;
  };
  budget: ResearchBudgetSnapshotV1;
}

export interface BoundedContentProjectionV1 {
  text: string;
  linkTargets: string[];
  truncated: boolean;
  inputBytes: number;
}

export interface ResearchGetOutputV1 {
  schema: string;
  source: Omit<ResearchEntitySummaryV1, "entityRef" | "excerpt">;
  content: BoundedContentProjectionV1;
  /** Exact opposite-product links observed in verified detail content. */
  relatedAnchors?: BoundEntityAnchorV1[];
  budget: ResearchBudgetSnapshotV1;
}

export const BOUND_ENTITY_READ_CAPABILITY_ID_V1 = "atlassian.bound.read" as const;
export const BOUND_ENTITY_READ_INPUT_SCHEMA_V1 =
  "atlcli.ptc/atlassian.bound.read.input/v1" as const;
export const BOUND_ENTITY_READ_OUTPUT_SCHEMA_V1 =
  "atlcli.ptc/atlassian.bound.read.output/v1" as const;
export const BOUND_ENTITY_SECTION_READ_CAPABILITY_ID_V1 =
  "atlassian.bound.section.read" as const;
export const BOUND_ENTITY_SECTION_READ_INPUT_SCHEMA_V1 =
  "atlcli.ptc/atlassian.bound.section.read.input/v1" as const;
export const BOUND_ENTITY_SECTION_READ_OUTPUT_SCHEMA_V1 =
  "atlcli.ptc/atlassian.bound.section.read.output/v1" as const;

/** Body-free, host-issued handle for one already authorized exact entity. */
export interface BoundEntityAnchorV1 {
  anchorRef: string;
  product: "jira" | "confluence";
  entityKind: "issue" | "page";
  name: string;
}

export interface BoundEntityReadInputV1 {
  schema: typeof BOUND_ENTITY_READ_INPUT_SCHEMA_V1;
  anchorRef: string;
}

export interface BoundEntityReadOutputV1 {
  schema: typeof BOUND_ENTITY_READ_OUTPUT_SCHEMA_V1;
  source: Omit<ResearchEntitySummaryV1, "entityRef" | "excerpt">;
  content: BoundedContentProjectionV1;
  /** Exact links observed in the verified body; still usable only by opaque ref. */
  relatedAnchors: BoundEntityAnchorV1[];
  /** Present for a navigable Confluence page; contains no section bodies. */
  document?: BoundDocumentOutlineV1;
  budget: ResearchBudgetSnapshotV1;
}

export interface BoundDocumentSectionOutlineV1 {
  sectionRef: string;
  sectionId: string;
  heading: string;
  level: number;
  order: number;
  contentBytes: number;
  metadata: {
    macroNames: string[];
    macroCount: number;
    macrosTruncated: boolean;
    linkCount: number;
    linksTruncated: boolean;
    jiraIssueKeys: string[];
    structures: BoundDocumentStructureSummaryV1;
  };
}

export interface BoundDocumentStructureSummaryV1 {
  tables: number;
  expands: number;
  jiraMacros: number;
  smartLinks: number;
  excerpts: number;
  includes: number;
  unresolvedIncludes: number;
  unsupportedMacros: number;
}

export type BoundDocumentCoverageIssueV1 =
  | "source_limit"
  | "parse_budget"
  | "outline_limit"
  | "projection_limit"
  | "unresolved_include"
  | "unsupported_structure";

export interface BoundDocumentOutlineV1 {
  snapshot: {
    sourceId: string;
    representation: "storage";
    sourceVersion: number;
    captureRef: string;
  };
  coverageIssues: BoundDocumentCoverageIssueV1[];
  sourceTruncated: boolean;
  outlineTruncated: boolean;
  projectionTruncated: boolean;
  genuinelyEmpty: boolean;
  totalSections: number;
  unreadSections: number;
  sections: BoundDocumentSectionOutlineV1[];
}

export interface BoundEntitySectionReadInputV1 {
  schema: typeof BOUND_ENTITY_SECTION_READ_INPUT_SCHEMA_V1;
  sectionRef: string;
}

export interface BoundEntitySectionReadOutputV1 {
  schema: typeof BOUND_ENTITY_SECTION_READ_OUTPUT_SCHEMA_V1;
  source: Omit<ResearchEntitySummaryV1, "entityRef" | "excerpt">;
  section: Omit<BoundDocumentSectionOutlineV1, "sectionRef" | "metadata">;
  content: BoundedContentProjectionV1;
  support: {
    sectionId: string;
    start: number;
    end: number;
    evidenceId?: string;
  };
  coverage: {
    snapshot: BoundDocumentOutlineV1["snapshot"];
    issues: BoundDocumentCoverageIssueV1[];
    sourceTruncated: boolean;
    outlineTruncated: boolean;
    projectionTruncated: boolean;
    unreadSections: number;
    completeDocumentRead: boolean;
  };
  relatedAnchors: BoundEntityAnchorV1[];
  budget: ResearchBudgetSnapshotV1;
}

export interface ResearchCandidateRankInputV1 {
  schema: string;
  product: "jira" | "confluence";
  entityRefs: string[];
}

export interface ResearchCandidateRankOutputV1 {
  schema: string;
  items: Array<{
    entityRef: string;
    sourceId: string;
    rank: number;
  }>;
  budget: ResearchBudgetSnapshotV1;
}

function invalid(message: string): never {
  throw new ResearchContractError("invalid-request", message);
}

function assertRecord(
  value: unknown,
  label: string
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${label} must be an object.`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) invalid(`${label} contains unknown fields.`);
}

function decodeText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalid("Search text must be a string.");
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (text.length > 500) invalid("Search text is too long.");
  return text || undefined;
}

const RESEARCH_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

function decodeLabels(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    invalid("Search labels must contain between 1 and 8 values.");
  }
  const labels = value.map((label) => {
    if (typeof label !== "string") invalid("Search label must be a string.");
    const normalized = label.trim();
    if (!RESEARCH_LABEL_PATTERN.test(normalized)) {
      invalid("Search label is invalid.");
    }
    return normalized;
  });
  if (new Set(labels).size !== labels.length) {
    invalid("Search labels must be unique.");
  }
  return labels.sort((left, right) => left.localeCompare(right, "en-US"));
}

function decodeConfluencePageId(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[1-9][0-9]{0,127}$/.test(value)) {
    invalid(`Confluence ${label} is invalid.`);
  }
  return value;
}

export function decodeResearchSearchInputV1(
  tool: "jira.issue.search" | "wiki.search",
  value: unknown,
  maximumPageSize: number
): ResearchSearchInputV1 {
  assertRecord(value, `${tool} input`);
  const expectedSchema = RESEARCH_CAPABILITY_SCHEMAS[tool].input;
  if (value.schema !== expectedSchema) invalid(`Unsupported ${tool} input schema.`);

  if ("cursor" in value) {
    assertExactKeys(value, ["schema", "cursor"], `${tool} continuation`);
    if (
      typeof value.cursor !== "string" ||
      !/^research-cursor:[A-Za-z0-9-]{1,200}$/.test(value.cursor)
    ) {
      invalid("Pagination cursor is invalid.");
    }
    return { schema: expectedSchema, cursor: value.cursor };
  }

  assertExactKeys(value, ["schema", "query", "pageSize"], `${tool} search`);
  assertRecord(value.query, `${tool} query`);
  assertExactKeys(
    value.query,
    tool === "jira.issue.search" ? ["text", "labels"] : ["text", "labels", "ancestorId", "parentId"],
    `${tool} query`,
  );
  const text = decodeText(value.query.text);
  const labels = decodeLabels(value.query.labels);
  const ancestorId = tool === "wiki.search"
    ? decodeConfluencePageId(value.query.ancestorId, "ancestor ID")
    : undefined;
  const parentId = tool === "wiki.search"
    ? decodeConfluencePageId(value.query.parentId, "parent ID")
    : undefined;
  if (ancestorId && parentId) {
    invalid("Confluence ancestor and parent filters are mutually exclusive.");
  }
  let pageSize: number | undefined;
  if (value.pageSize !== undefined) {
    if (
      typeof value.pageSize !== "number" ||
      !Number.isSafeInteger(value.pageSize) ||
      value.pageSize < 1
    ) {
      invalid("Search page size is invalid.");
    }
    pageSize = Math.min(value.pageSize, maximumPageSize);
  }
  return {
    schema: expectedSchema,
    query: {
      ...(text ? { text } : {}),
      ...(labels ? { labels } : {}),
      ...(ancestorId ? { ancestorId } : {}),
      ...(parentId ? { parentId } : {}),
    },
    ...(pageSize !== undefined ? { pageSize } : {}),
  };
}

export function decodeResearchGetInputV1(
  tool: "jira.issue.get" | "wiki.page.get",
  value: unknown
): ResearchGetInputV1 {
  assertRecord(value, `${tool} input`);
  assertExactKeys(
    value,
    tool === "wiki.page.get" ? ["schema", "entityRef", "includeComments"] : ["schema", "entityRef"],
    `${tool} input`,
  );
  const expectedSchema = RESEARCH_CAPABILITY_SCHEMAS[tool].input;
  if (value.schema !== expectedSchema) invalid(`Unsupported ${tool} input schema.`);
  if (
    typeof value.entityRef !== "string" ||
    !/^research-entity:[A-Za-z0-9-]{1,200}$/.test(value.entityRef)
  ) {
    invalid("Entity reference is invalid.");
  }
  if (value.includeComments !== undefined && typeof value.includeComments !== "boolean") {
    invalid("Confluence detail includeComments flag is invalid.");
  }
  return {
    schema: expectedSchema,
    entityRef: value.entityRef,
    ...(value.includeComments === true ? { includeComments: true } : {}),
  };
}

export function decodeResearchCandidateRankInputV1(
  value: unknown,
  maximumEntities: number,
): ResearchCandidateRankInputV1 {
  const tool = "research.candidate.rank";
  assertRecord(value, `${tool} input`);
  assertExactKeys(value, ["schema", "product", "entityRefs"], `${tool} input`);
  const expectedSchema = RESEARCH_CAPABILITY_SCHEMAS[tool].input;
  if (value.schema !== expectedSchema) invalid(`Unsupported ${tool} input schema.`);
  if (value.product !== "jira" && value.product !== "confluence") {
    invalid("Candidate-rank product is invalid.");
  }
  if (!Array.isArray(value.entityRefs) || value.entityRefs.length < 1 || value.entityRefs.length > maximumEntities) {
    invalid("Candidate-rank entity references are invalid.");
  }
  const entityRefs = value.entityRefs.map((entityRef) => {
    if (typeof entityRef !== "string" || !/^research-entity:[A-Za-z0-9-]{1,200}$/.test(entityRef)) {
      invalid("Candidate-rank entity reference is invalid.");
    }
    return entityRef;
  });
  if (new Set(entityRefs).size !== entityRefs.length) {
    invalid("Candidate-rank entity references must be unique.");
  }
  return { schema: expectedSchema, product: value.product, entityRefs };
}

export function decodeBoundEntityReadInputV1(value: unknown): BoundEntityReadInputV1 {
  assertRecord(value, `${BOUND_ENTITY_READ_CAPABILITY_ID_V1} input`);
  assertExactKeys(value, ["schema", "anchorRef"], `${BOUND_ENTITY_READ_CAPABILITY_ID_V1} input`);
  if (value.schema !== BOUND_ENTITY_READ_INPUT_SCHEMA_V1) {
    invalid(`Unsupported ${BOUND_ENTITY_READ_CAPABILITY_ID_V1} input schema.`);
  }
  if (
    typeof value.anchorRef !== "string" ||
    !/^research-anchor:[A-Za-z0-9-]{1,200}$/.test(value.anchorRef)
  ) {
    invalid("Bound entity anchor reference is invalid.");
  }
  return { schema: BOUND_ENTITY_READ_INPUT_SCHEMA_V1, anchorRef: value.anchorRef };
}

export function decodeBoundEntitySectionReadInputV1(
  value: unknown,
): BoundEntitySectionReadInputV1 {
  assertRecord(value, "Bound entity section read input");
  assertExactKeys(value, ["schema", "sectionRef"], "Bound entity section read input");
  if (value.schema !== BOUND_ENTITY_SECTION_READ_INPUT_SCHEMA_V1) {
    invalid("Bound entity section read input schema is invalid.");
  }
  if (
    typeof value.sectionRef !== "string" ||
    !/^research-section:[A-Za-z0-9-]{1,200}$/.test(value.sectionRef)
  ) {
    invalid("Bound entity section reference is invalid.");
  }
  return {
    schema: BOUND_ENTITY_SECTION_READ_INPUT_SCHEMA_V1,
    sectionRef: value.sectionRef,
  };
}
