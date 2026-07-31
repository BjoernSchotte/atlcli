/**
 * Host-neutral contracts for atlcli read-only research.
 *
 * No model, Chrome, REST client, or interpreter type belongs in this module.
 * The portable screen and every productive/test host communicate through these
 * JSON-safe versioned shapes.
 */

export const RESEARCH_REQUEST_SCHEMA_V1 = "atlcli.research-request/v1" as const;
export const RESEARCH_REPORT_SCHEMA_V1 = "atlcli.research-report/v1" as const;

export const RESEARCH_TOOL_IDS = [
  "jira.issue.search",
  "jira.issue.get",
  "wiki.search",
  "wiki.page.get",
] as const;

export type ResearchToolId = (typeof RESEARCH_TOOL_IDS)[number];
export type ResearchProvider = "rest" | "agg";
export type ResearchProduct = "jira" | "confluence";

export interface ResearchTimeWindowV1 {
  from?: string;
  to?: string;
}

export interface ResearchScopeV1 {
  siteOrigin: string;
  jiraProjectKeys: string[];
  confluenceSpaceKeys: string[];
  timeWindow?: ResearchTimeWindowV1;
}

export interface ResearchLimitsV1 {
  pageSize: number;
  maxSearchPagesPerProduct: number;
  maxItemsPerProduct: number;
  maxDetailItemsPerProduct: number;
  maxBodyCharsPerItem: number;
  maxPtcCalls: number;
  maxHttpCalls: number;
  maxConcurrentCalls: number;
  maxPtcInputBytes: number;
  maxPtcOutputBytes: number;
  maxTotalResponseBytes: number;
  maxInterpreterMemoryBytes: number;
  maxInterpreterMs: number;
  maxModelInputTokens: number;
  maxModelOutputTokens: number;
  maxReportChars: number;
  maxRunMs: number;
}

export const DEFAULT_RESEARCH_LIMITS_V1: Readonly<ResearchLimitsV1> = {
  pageSize: 25,
  maxSearchPagesPerProduct: 5,
  maxItemsPerProduct: 100,
  maxDetailItemsPerProduct: 20,
  maxBodyCharsPerItem: 12_000,
  maxPtcCalls: 32,
  maxHttpCalls: 64,
  maxConcurrentCalls: 4,
  maxPtcInputBytes: 32_000,
  maxPtcOutputBytes: 128_000,
  maxTotalResponseBytes: 8_000_000,
  maxInterpreterMemoryBytes: 64_000_000,
  maxInterpreterMs: 10_000,
  maxModelInputTokens: 80_000,
  maxModelOutputTokens: 8_000,
  maxReportChars: 24_000,
  maxRunMs: 120_000,
};

export interface ResearchRequestV1 {
  schema: typeof RESEARCH_REQUEST_SCHEMA_V1;
  question: string;
  scope: ResearchScopeV1;
  limits: ResearchLimitsV1;
  wikiProvider: ResearchProvider;
}

export interface ResearchSourceReferenceV1 {
  id: string;
  product: ResearchProduct;
  title: string;
  url: string;
  issueKey?: string;
  contentId?: string;
  projectKey?: string;
  spaceKey?: string;
  excerpt?: string;
  updatedAt?: string;
}

export interface ResearchFindingV1 {
  id: string;
  classification: "fact" | "inference";
  summary: string;
  detail?: string;
  sourceIds: string[];
}

export interface AtlassianRelationshipV1 {
  id: string;
  classification: "verified" | "hypothesis";
  jiraIssueKey: string;
  confluenceContentId: string;
  summary: string;
  sourceIds: string[];
}

export interface ResearchRunCountsV1 {
  ptcCalls: number;
  httpCalls: number;
  jiraItems: number;
  confluenceItems: number;
}

export interface ResearchRunUsageV1 {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ResearchRunSummaryV1 {
  model: string;
  wikiProvider: ResearchProvider;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  complete: boolean;
  counts: ResearchRunCountsV1;
  usage?: ResearchRunUsageV1;
  warnings: string[];
}

export interface ResearchReportV1 {
  schema: typeof RESEARCH_REPORT_SCHEMA_V1;
  title: string;
  question: string;
  scope: ResearchScopeV1;
  executiveSummary: string;
  findings: ResearchFindingV1[];
  relationships: AtlassianRelationshipV1[];
  limitations: string[];
  sources: ResearchSourceReferenceV1[];
  run: ResearchRunSummaryV1;
  markdown: string;
}

export type ResearchProgressPhase =
  | "preparing"
  | "researching"
  | "rendering"
  | "complete";

export interface ResearchProgressV1 {
  phase: ResearchProgressPhase;
  message: string;
  completedCalls: number;
  maxCalls: number;
}

export type ResearchErrorCode =
  | "invalid-request"
  | "missing-key"
  | "invalid-key"
  | "not-atlassian"
  | "not-authenticated"
  | "access-denied"
  | "rate-limited"
  | "provider-error"
  | "limit-exceeded"
  | "cancelled"
  | "invalid-report"
  | "unknown";

export class ResearchContractError extends Error {
  readonly code: ResearchErrorCode;

  constructor(code: ResearchErrorCode, message: string) {
    super(message);
    this.name = "ResearchContractError";
    this.code = code;
  }
}

export interface ResearchRunOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ResearchProgressV1) => void;
}

/**
 * The only research surface visible to the portable React application.
 *
 * Credential methods deliberately do not return a key. A host may remember it
 * for the current browser session, but the app can only ask whether one exists.
 */
export interface ResearchPort {
  hasApiKey(): Promise<boolean>;
  setApiKey(apiKey: string): Promise<void>;
  clearApiKey(): Promise<void>;
  run(request: ResearchRequestV1, options?: ResearchRunOptions): Promise<ResearchReportV1>;
  copyMarkdown(markdown: string): Promise<void>;
  downloadMarkdown(markdown: string, filename: string): Promise<void>;
}

const LIMIT_BOUNDS: {
  [K in keyof ResearchLimitsV1]: readonly [minimum: number, maximum: number];
} = {
  pageSize: [1, 50],
  maxSearchPagesPerProduct: [1, 10],
  maxItemsPerProduct: [1, 250],
  maxDetailItemsPerProduct: [1, 50],
  maxBodyCharsPerItem: [256, 50_000],
  maxPtcCalls: [4, 128],
  maxHttpCalls: [4, 256],
  maxConcurrentCalls: [1, 8],
  maxPtcInputBytes: [1_000, 256_000],
  maxPtcOutputBytes: [1_000, 1_000_000],
  maxTotalResponseBytes: [100_000, 50_000_000],
  maxInterpreterMemoryBytes: [8_000_000, 256_000_000],
  maxInterpreterMs: [500, 60_000],
  maxModelInputTokens: [1_000, 200_000],
  maxModelOutputTokens: [1_000, 32_000],
  maxReportChars: [1_000, 100_000],
  maxRunMs: [5_000, 10 * 60_000],
};

function boundedInteger(
  value: unknown,
  fallback: number,
  [minimum, maximum]: readonly [number, number]
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeResearchLimitsV1(value: unknown): ResearchLimitsV1 {
  const source =
    typeof value === "object" && value !== null
      ? (value as Partial<Record<keyof ResearchLimitsV1, unknown>>)
      : {};
  const normalized = {} as ResearchLimitsV1;
  for (const key of Object.keys(DEFAULT_RESEARCH_LIMITS_V1) as (keyof ResearchLimitsV1)[]) {
    normalized[key] = boundedInteger(
      source[key],
      DEFAULT_RESEARCH_LIMITS_V1[key],
      LIMIT_BOUNDS[key]
    );
  }
  normalized.maxDetailItemsPerProduct = Math.min(
    normalized.maxDetailItemsPerProduct,
    normalized.maxItemsPerProduct
  );
  return normalized;
}

function normalizeKeyList(
  values: unknown,
  pattern: RegExp,
  label: string
): string[] {
  if (!Array.isArray(values)) {
    throw new ResearchContractError("invalid-request", `${label} scope must be a list.`);
  }
  const normalized = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
  if (normalized.length === 0) {
    throw new ResearchContractError("invalid-request", `Select at least one ${label}.`);
  }
  if (normalized.length > 20) {
    throw new ResearchContractError("invalid-request", `Select no more than 20 ${label}s.`);
  }
  for (const value of normalized) {
    if (!pattern.test(value)) {
      throw new ResearchContractError("invalid-request", `Invalid ${label}: ${value}`);
    }
  }
  return normalized;
}

function normalizeIsoDate(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ResearchContractError("invalid-request", `${label} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ResearchContractError("invalid-request", `${label} is not a valid date.`);
  }
  return value;
}

export function normalizeResearchScopeV1(value: unknown): ResearchScopeV1 {
  if (typeof value !== "object" || value === null) {
    throw new ResearchContractError("invalid-request", "Research scope is missing.");
  }
  const scope = value as Partial<Record<keyof ResearchScopeV1, unknown>>;
  let url: URL;
  try {
    if (typeof scope.siteOrigin !== "string") throw new Error("missing origin");
    url = new URL(scope.siteOrigin);
  } catch {
    throw new ResearchContractError("not-atlassian", "The active site URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== scope.siteOrigin ||
    !/^[a-z0-9-]+\.atlassian\.net$/i.test(url.hostname)
  ) {
    throw new ResearchContractError(
      "not-atlassian",
      "Research requires an approved Atlassian Cloud site origin."
    );
  }

  const jiraProjectKeys = normalizeKeyList(
    scope.jiraProjectKeys,
    /^[A-Z][A-Z0-9]{1,19}$/,
    "Jira project"
  );
  const confluenceSpaceKeys = normalizeKeyList(
    scope.confluenceSpaceKeys,
    /^[A-Za-z0-9~][A-Za-z0-9._~-]{0,254}$/,
    "Confluence space"
  );
  const timeWindow =
    typeof scope.timeWindow === "object" && scope.timeWindow !== null
      ? (scope.timeWindow as Partial<Record<keyof ResearchTimeWindowV1, unknown>>)
      : {};
  const from = normalizeIsoDate(timeWindow.from, "Start date");
  const to = normalizeIsoDate(timeWindow.to, "End date");
  if (from && to && from > to) {
    throw new ResearchContractError(
      "invalid-request",
      "The start date must not be after the end date."
    );
  }

  return {
    siteOrigin: url.origin,
    jiraProjectKeys,
    confluenceSpaceKeys,
    ...(from || to ? { timeWindow: { ...(from ? { from } : {}), ...(to ? { to } : {}) } } : {}),
  };
}

export function normalizeResearchRequestV1(value: unknown): ResearchRequestV1 {
  if (typeof value !== "object" || value === null) {
    throw new ResearchContractError("invalid-request", "The research request is missing.");
  }
  const request = value as Partial<Record<keyof ResearchRequestV1, unknown>>;
  if (typeof request.question !== "string") {
    throw new ResearchContractError("invalid-request", "The research question is missing.");
  }
  const question = request.question.trim();
  if (question.length < 3 || question.length > 2_000) {
    throw new ResearchContractError(
      "invalid-request",
      "The research question must contain between 3 and 2,000 characters."
    );
  }
  if (request.wikiProvider !== "rest" && request.wikiProvider !== "agg") {
    throw new ResearchContractError("invalid-request", "Unknown Confluence read provider.");
  }
  return {
    schema: RESEARCH_REQUEST_SCHEMA_V1,
    question,
    scope: normalizeResearchScopeV1(request.scope),
    limits: normalizeResearchLimitsV1(request.limits),
    wikiProvider: request.wikiProvider,
  };
}
