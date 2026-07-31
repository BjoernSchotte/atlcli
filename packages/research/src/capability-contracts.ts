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
} as const;

export const RESEARCH_LANGCHAIN_TOOL_NAMES: Record<ResearchToolId, string> = {
  "jira.issue.search": "jira_issue_search",
  "jira.issue.get": "jira_issue_get",
  "wiki.search": "wiki_search",
  "wiki.page.get": "wiki_page_get",
};

export interface ResearchSearchQueryV1 {
  text?: string;
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
  assertExactKeys(value.query, ["text"], `${tool} query`);
  const text = decodeText(value.query.text);
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
    query: text ? { text } : {},
    ...(pageSize !== undefined ? { pageSize } : {}),
  };
}

export function decodeResearchGetInputV1(
  tool: "jira.issue.get" | "wiki.page.get",
  value: unknown
): ResearchGetInputV1 {
  assertRecord(value, `${tool} input`);
  assertExactKeys(value, ["schema", "entityRef"], `${tool} input`);
  const expectedSchema = RESEARCH_CAPABILITY_SCHEMAS[tool].input;
  if (value.schema !== expectedSchema) invalid(`Unsupported ${tool} input schema.`);
  if (
    typeof value.entityRef !== "string" ||
    !/^research-entity:[A-Za-z0-9-]{1,200}$/.test(value.entityRef)
  ) {
    invalid("Entity reference is invalid.");
  }
  return { schema: expectedSchema, entityRef: value.entityRef };
}
