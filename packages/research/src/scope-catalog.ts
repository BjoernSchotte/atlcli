import {
  ResearchContractError,
  type ResearchProduct,
} from "./contracts.js";
import type {
  ResearchScopeCandidateV1,
  ResearchScopeEntityKindV1,
} from "./scope-discovery.js";

export const RESEARCH_SCOPE_CATALOG_CAPABILITY_IDS = [
  "jira.project.search",
  "wiki.space.search",
  "atlassian.reference.resolve",
] as const;

export type ResearchScopeCatalogCapabilityId =
  (typeof RESEARCH_SCOPE_CATALOG_CAPABILITY_IDS)[number];

export const RESEARCH_SCOPE_CATALOG_SCHEMAS = {
  "jira.project.search": {
    input: "atlcli.ptc/jira.project.search.input/v1",
    output: "atlcli.ptc/jira.project.search.output/v1",
  },
  "wiki.space.search": {
    input: "atlcli.ptc/wiki.space.search.input/v1",
    output: "atlcli.ptc/wiki.space.search.output/v1",
  },
  "atlassian.reference.resolve": {
    input: "atlcli.ptc/atlassian.reference.resolve.input/v1",
    output: "atlcli.ptc/atlassian.reference.resolve.output/v1",
  },
} as const;

export interface ResearchScopeCatalogIntentV1 {
  schema: string;
  product: ResearchProduct;
  entityKind: "project" | "space";
  normalizedQuery?: string;
  includeArchived: boolean;
  cursorRef?: string;
  maxCandidates: number;
}

export interface ResearchReferenceResolveIntentV1 {
  schema: string;
  reference: string;
  expectedTenantOrigin: string;
  expectedKinds: ResearchScopeEntityKindV1[];
}

export interface ResearchScopeCatalogPageV1 {
  schema: string;
  candidates: ResearchScopeCandidateV1[];
  nextCursorRef?: string;
  truncated: boolean;
}

export interface ResearchReferenceResolveOutputV1 {
  schema: string;
  candidate?: ResearchScopeCandidateV1;
  unavailable: boolean;
}

function invalid(message: string): never {
  throw new ResearchContractError("invalid-request", message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid(`${label} contains unknown fields.`);
}

function safeText(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalid(`${label} must be a string.`);
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (normalized.length > maximum) invalid(`${label} is too long.`);
  return normalized || undefined;
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid(`${label} must be a positive integer.`);
  return Math.min(value, maximum);
}

function expectedSchema(capability: ResearchScopeCatalogCapabilityId): string {
  return RESEARCH_SCOPE_CATALOG_SCHEMAS[capability].input;
}

export function decodeResearchScopeCatalogIntentV1(
  capability: "jira.project.search" | "wiki.space.search",
  value: unknown,
  maximumPageSize: number
): ResearchScopeCatalogIntentV1 {
  const input = record(value, `${capability} input`);
  exactKeys(input, ["schema", "product", "entityKind", "normalizedQuery", "includeArchived", "cursorRef", "maxCandidates"], `${capability} input`);
  if (input.schema !== expectedSchema(capability)) invalid(`Unsupported ${capability} input schema.`);
  const expectedProduct = capability === "jira.project.search" ? "jira" : "confluence";
  const expectedKind = capability === "jira.project.search" ? "project" : "space";
  if (input.product !== expectedProduct || input.entityKind !== expectedKind) invalid(`${capability} product/entity kind is invalid.`);
  if (typeof input.includeArchived !== "boolean") invalid("includeArchived must be boolean.");
  const normalizedQuery = safeText(input.normalizedQuery, "normalizedQuery", 200);
  let cursorRef: string | undefined;
  if (input.cursorRef !== undefined) {
    if (typeof input.cursorRef !== "string" || !/^research-scope-cursor:[A-Za-z0-9-]{1,200}$/.test(input.cursorRef)) invalid("Scope catalog cursor is invalid.");
    cursorRef = input.cursorRef;
  }
  const maxCandidates = positiveInteger(input.maxCandidates ?? maximumPageSize, "maxCandidates", maximumPageSize);
  return {
    schema: expectedSchema(capability),
    product: expectedProduct,
    entityKind: expectedKind,
    ...(normalizedQuery ? { normalizedQuery } : {}),
    includeArchived: input.includeArchived,
    ...(cursorRef ? { cursorRef } : {}),
    maxCandidates,
  };
}

export function decodeResearchReferenceResolveIntentV1(value: unknown): ResearchReferenceResolveIntentV1 {
  const input = record(value, "atlassian.reference.resolve input");
  exactKeys(input, ["schema", "reference", "expectedTenantOrigin", "expectedKinds"], "reference resolve input");
  if (input.schema !== expectedSchema("atlassian.reference.resolve")) invalid("Unsupported reference resolve input schema.");
  const reference = safeText(input.reference, "reference", 2_000);
  const origin = safeText(input.expectedTenantOrigin, "expectedTenantOrigin", 255);
  if (!reference || !origin) invalid("reference and expectedTenantOrigin are required.");
  if (!Array.isArray(input.expectedKinds) || input.expectedKinds.length === 0 || input.expectedKinds.length > 4) invalid("expectedKinds must be a bounded list.");
  const expectedKinds = input.expectedKinds.map((kind) => {
    if (kind !== "project" && kind !== "space" && kind !== "issue" && kind !== "page") invalid("expectedKinds contains an invalid entity kind.");
    return kind;
  });
  return { schema: expectedSchema("atlassian.reference.resolve"), reference, expectedTenantOrigin: origin, expectedKinds };
}
