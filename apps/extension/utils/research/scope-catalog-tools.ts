import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod/v4";
import {
  RESEARCH_SCOPE_CATALOG_SCHEMAS,
  type ResearchScopeCatalogCapabilityId,
} from "@atlcli/research/scope-catalog";
import { ResearchScopeCatalogBroker } from "@atlcli/research/scope-catalog-broker";

export const RESEARCH_SCOPE_CATALOG_TOOL_NAMES = {
  "jira.project.search": "jira_project_search",
  "wiki.space.search": "wiki_space_search",
  "atlassian.reference.resolve": "atlassian_reference_resolve",
} as const;

export interface ResearchScopeCatalogPtcOptions {
  tenantOrigin: string;
}

const searchSchema = z
  .object({
    query: z.string().max(200).optional(),
    includeArchived: z.boolean().optional(),
    cursor: z.string().max(220).optional(),
    maxCandidates: z.number().int().positive().max(100).optional(),
  })
  .strict();

const referenceSchema = z
  .object({
    reference: z.string().url().max(2_000),
    expectedKinds: z
      .array(z.enum(["project", "space", "issue", "page"]))
      .min(1)
      .max(4),
  })
  .strict();

function normalizeQuery(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function invokeCatalog(
  broker: ResearchScopeCatalogBroker,
  capability: ResearchScopeCatalogCapabilityId,
  input: Record<string, unknown>,
  tenantOrigin: string,
): Promise<unknown> {
  if (capability === "atlassian.reference.resolve") {
    return broker.invoke(capability, {
      schema: RESEARCH_SCOPE_CATALOG_SCHEMAS[capability].input,
      reference: input.reference,
      expectedKinds: input.expectedKinds,
      expectedTenantOrigin: tenantOrigin,
    });
  }
  return broker.invoke(capability, {
    schema: RESEARCH_SCOPE_CATALOG_SCHEMAS[capability].input,
    product: capability === "jira.project.search" ? "jira" : "confluence",
    entityKind: capability === "jira.project.search" ? "project" : "space",
    ...(normalizeQuery(typeof input.query === "string" ? input.query : undefined)
      ? { normalizedQuery: normalizeQuery(input.query as string) }
      : {}),
    includeArchived: input.includeArchived === true,
    ...(typeof input.cursor === "string" ? { cursorRef: input.cursor } : {}),
    ...(typeof input.maxCandidates === "number" ? { maxCandidates: input.maxCandidates } : {}),
  });
}

/**
 * PTC-only scope discovery tools. The model sees friendly arguments; this
 * host-owned adapter supplies schema IDs and the active tenant origin before
 * invoking the broker. No raw REST/GraphQL operation is exposed to QuickJS.
 */
export function createResearchScopeCatalogPtcTools(
  broker: ResearchScopeCatalogBroker,
  options: ResearchScopeCatalogPtcOptions,
): StructuredToolInterface[] {
  const searchTool = (
    capability: "jira.project.search" | "wiki.space.search",
    description: string,
  ) =>
    tool(
      async (input) => JSON.stringify(await invokeCatalog(broker, capability, input, options.tenantOrigin)),
      {
        name: RESEARCH_SCOPE_CATALOG_TOOL_NAMES[capability],
        description,
        schema: searchSchema,
      },
    );

  return [
    searchTool(
      "jira.project.search",
      "Read-only search of Jira projects visible in the active tenant. Continue only with the returned opaque cursor.",
    ),
    searchTool(
      "wiki.space.search",
      "Read-only search of Confluence spaces visible in the active tenant. Continue only with the returned opaque cursor.",
    ),
    tool(
      async (input) =>
        JSON.stringify(await invokeCatalog(broker, "atlassian.reference.resolve", input, options.tenantOrigin)),
      {
        name: RESEARCH_SCOPE_CATALOG_TOOL_NAMES["atlassian.reference.resolve"],
        description:
          "Resolve one exact, tenant-bound Jira or Confluence URL to a read-only scope candidate. Foreign URLs are unavailable.",
        schema: referenceSchema,
      },
    ),
  ];
}
