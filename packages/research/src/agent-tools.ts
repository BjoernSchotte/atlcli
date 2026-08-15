import { tool, type DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod/v4";
import type { ResearchCapabilityBroker } from "./broker.js";
import {
  RESEARCH_CAPABILITY_SCHEMAS,
  RESEARCH_LANGCHAIN_TOOL_NAMES,
} from "./capability-contracts.js";
import {
  ResearchContractError,
  type ResearchCapabilityEventToolIdV1,
  type ResearchToolId,
} from "./contracts.js";
import type { ResearchGraphCapabilityV1 } from "./graph.js";

const searchInputSchema = (toolId: "jira.issue.search" | "wiki.search") => {
  const scopeHint = toolId === "jira.issue.search"
    ? {
        project: z.string().max(255).optional(),
        projectKey: z.string().max(255).optional(),
      }
    : {
        space: z.string().max(255).optional(),
        spaceKey: z.string().max(255).optional(),
      };
  return z.union([
    // Model-facing ergonomic alias. The host immediately normalizes this to
    // the canonical typed { query: { text } } capability input below; it does
    // not permit JQL/CQL, tenant, or cursor injection. A redundant project or
    // space hint is accepted only when it matches the host-bound scope.
    z
      .object({
        query: z.string().max(500),
        pageSize: z.number().int().positive().optional(),
        ...scopeHint,
      })
      .strict(),
    z
      .object({
        query: z
          .object({
            text: z.string().max(500).optional(),
            labels: z.array(z.string().max(255)).min(1).max(8).optional(),
            ...(toolId === "wiki.search"
              ? {
                  ancestorId: z.string().max(128).optional(),
                  parentId: z.string().max(128).optional(),
                }
              : {}),
          })
          .strict(),
        pageSize: z.number().int().positive().optional(),
        ...scopeHint,
      })
      .strict(),
    z
      .object({
        cursor: z.string().max(220),
        query: z.union([
          z.string().max(500),
          z.object({
            text: z.string().max(500).optional(),
            labels: z.array(z.string().max(255)).min(1).max(8).optional(),
          }).strict(),
        ]).optional(),
        ...scopeHint,
      })
      .strict(),
    // Sonnet sometimes preserves the first call's `query` wrapper while
    // paginating. Accept that shape at the model boundary, then normalize it
    // to the same host-owned opaque cursor contract before broker validation.
    z
      .object({
        query: z
          .object({
            text: z.string().max(500).optional(),
            labels: z.array(z.string().max(255)).min(1).max(8).optional(),
            cursor: z.string().max(220),
          })
          .strict(),
      })
      .strict(),
  ]);
};

const getInputSchema = (toolId: "jira.issue.get" | "wiki.page.get") =>
  z
    .object({
      entityRef: z.string().max(220),
      ...(toolId === "wiki.page.get" ? { includeComments: z.boolean().optional() } : {}),
    })
    .strict();

const candidateRankInputSchema = () =>
  z.object({
    product: z.enum(["jira", "confluence"]),
    entityRefs: z.array(z.string().max(220)).min(1).max(100),
  }).strict();

function jsonResult(value: unknown): string {
  return JSON.stringify(value);
}

export interface ResearchPtcDiagnosticV1 {
  callId: string;
  tool: ResearchCapabilityEventToolIdV1;
  inputKind: "search" | "continuation" | "detail" | "reference" | "ranking";
  outcome: "started" | "success" | "error";
  durationMs?: number;
  itemCount?: number;
  itemLabels?: string[];
  complete?: boolean;
  termination?: string;
  resultBytes?: number;
  truncated?: boolean;
  errorCode?: string;
  inputKeys?: string[];
  queryKeys?: string[];
}

export interface ResearchPtcToolOptions {
  onDiagnostic?: (diagnostic: ResearchPtcDiagnosticV1) => void;
  /**
   * Host-only result observation. It runs before the success diagnostic so a
   * durable host can retain an allowlisted result projection before QuickJS
   * receives the serialized value.
   */
  onResult?: (
    tool: ResearchGraphCapabilityV1,
    result: unknown,
    callId: string,
    input?: unknown,
  ) => void | Promise<void>;
  /** Host-only preflight after ergonomic input normalization, before broker IO. */
  beforeInvoke?: (
    tool: ResearchGraphCapabilityV1,
    input: unknown,
    callId: string,
    inputKind: ResearchPtcDiagnosticV1["inputKind"],
  ) => void | Promise<void>;
  now?: () => number;
  /** Host-bound keys used only to validate redundant model scope hints. */
  boundProjectKeys?: readonly string[];
  /** Host-bound keys used only to validate redundant model scope hints. */
  boundSpaceKeys?: readonly string[];
  /** Reject a second unique initial query while replaying an identical result. */
  singleInitialQuery?: boolean;
}

function inputKind(
  input: unknown
): ResearchPtcDiagnosticV1["inputKind"] {
  if (typeof input === "object" && input !== null) {
    if ("cursor" in input) return "continuation";
    if (
      "query" in input &&
      typeof input.query === "object" &&
      input.query !== null &&
      "cursor" in input.query
    ) {
      return "continuation";
    }
    if ("entityRef" in input) return "detail";
    if ("entityRefs" in input) return "ranking";
  }
  return "search";
}

export function createResearchPtcTools(
  broker: ResearchCapabilityBroker,
  options: ResearchPtcToolOptions = {}
): DynamicStructuredTool[] {
  let callSequence = 0;
  const labelByEntityRef = new Map<string, string>();
  const initialSearchByTool = new Map<ResearchToolId, {
    fingerprint: string;
    result: unknown;
  }>();
  const now = options.now ?? Date.now;
  const invoke = async (
    id: ResearchToolId,
    input: unknown
  ): Promise<string> => {
    const kind = inputKind(input);
    const callId = `${id}:${++callSequence}`;
    const startedAt = now();
    const inputKeys = typeof input === "object" && input !== null
      ? Object.keys(input).sort()
      : [];
    const queryKeys = typeof input === "object" &&
      input !== null &&
      "query" in input &&
      typeof input.query === "object" &&
      input.query !== null
      ? Object.keys(input.query).sort()
      : [];
    options.onDiagnostic?.({
      callId,
      tool: id,
      inputKind: kind,
      outcome: "started",
      inputKeys,
      queryKeys,
    });
    try {
      const record: Record<string, unknown> =
        typeof input === "object" && input !== null
          ? input as Record<string, unknown>
          : {};
      const scopeHints = id === "jira.issue.search"
        ? [record.project, record.projectKey].filter((value) => value !== undefined)
        : id === "wiki.search"
          ? [record.space, record.spaceKey].filter((value) => value !== undefined)
          : [];
      const allowedScopeHints = id === "jira.issue.search"
        ? options.boundProjectKeys
        : id === "wiki.search"
          ? options.boundSpaceKeys
          : undefined;
      if (scopeHints.some((scopeHint) =>
        typeof scopeHint !== "string" || !allowedScopeHints?.includes(scopeHint)
      )) {
        throw new ResearchContractError(
          "access-denied",
          "The redundant search scope hint does not match a host-bound scope.",
        );
      }
      const {
        project: _project,
        projectKey: _projectKey,
        space: _space,
        spaceKey: _spaceKey,
        ...recordWithoutScopeHint
      } = record;
      const normalizedRecord = "query" in record && typeof record.query === "string"
        ? {
            ...recordWithoutScopeHint,
            query: { text: record.query },
          }
        : recordWithoutScopeHint;
      const nestedCursor =
        "query" in normalizedRecord &&
        typeof normalizedRecord.query === "object" &&
        normalizedRecord.query !== null &&
        "cursor" in normalizedRecord.query &&
        typeof normalizedRecord.query.cursor === "string"
          ? normalizedRecord.query.cursor
          : undefined;
      const topCursor = "cursor" in normalizedRecord &&
        typeof normalizedRecord.cursor === "string"
          ? normalizedRecord.cursor
          : undefined;
      const brokerInput = topCursor || nestedCursor
        ? { cursor: topCursor ?? nestedCursor }
        : normalizedRecord;
      const initialSearch = options.singleInitialQuery &&
        (id === "jira.issue.search" || id === "wiki.search") &&
        kind === "search";
      const fingerprint = initialSearch ? JSON.stringify(brokerInput) : undefined;
      const remembered = initialSearch ? initialSearchByTool.get(id) : undefined;
      if (remembered && remembered.fingerprint !== fingerprint) {
        throw new ResearchContractError(
          "limit-exceeded",
          "This bounded reader already used its single initial search query.",
        );
      }
      await options.beforeInvoke?.(id, brokerInput, callId, kind);
      const result = remembered
        ? structuredClone(remembered.result)
        : await broker.invoke(id, {
            ...brokerInput,
            schema: RESEARCH_CAPABILITY_SCHEMAS[id].input,
          });
      if (initialSearch && fingerprint && !remembered) {
        initialSearchByTool.set(id, {
          fingerprint,
          result: structuredClone(result),
        });
      }
      const serialized = jsonResult(result);
      await options.onResult?.(id, result, callId, brokerInput);
      const resultItems = typeof result === "object" && result !== null &&
        "items" in result && Array.isArray(result.items)
        ? result.items
        : [];
      const itemLabels = resultItems.flatMap((candidate): string[] => {
        if (!candidate || typeof candidate !== "object") return [];
        const item = candidate as Record<string, unknown>;
        const entityRef = typeof item.entityRef === "string" ? item.entityRef : undefined;
        const remembered = entityRef ? labelByEntityRef.get(entityRef) : undefined;
        const title = typeof item.title === "string" ? item.title.replace(/\s+/g, " ").trim() : "";
        const key = typeof item.issueKey === "string"
          ? item.issueKey
          : typeof item.contentId === "string"
            ? `Confluence ${item.contentId}`
            : typeof item.sourceId === "string"
              ? item.sourceId
              : "";
        const observed = [key, title].filter(Boolean).join(": ").slice(0, 240);
        const label = remembered || observed;
        if (entityRef && label) labelByEntityRef.set(entityRef, label);
        return label ? [label] : [];
      }).slice(0, 12);
      const page =
        typeof result === "object" && result !== null && "page" in result
          ? result.page
          : undefined;
      options.onDiagnostic?.({
        callId,
        tool: id,
        inputKind: kind,
        outcome: "success",
        durationMs: Math.max(0, now() - startedAt),
        ...(typeof result === "object" &&
        result !== null &&
        "items" in result &&
        Array.isArray(result.items)
          ? { itemCount: result.items.length }
          : {}),
        ...(itemLabels.length > 0 ? { itemLabels } : {}),
        ...(typeof page === "object" &&
        page !== null &&
        "complete" in page &&
        typeof page.complete === "boolean"
          ? { complete: page.complete }
          : {}),
        ...(typeof page === "object" &&
        page !== null &&
        "termination" in page &&
        typeof page.termination === "string"
          ? { termination: page.termination }
          : {}),
        resultBytes: new TextEncoder().encode(serialized).byteLength,
        ...(typeof result === "object" &&
        result !== null &&
        "content" in result &&
        typeof result.content === "object" &&
        result.content !== null &&
        "truncated" in result.content &&
        typeof result.content.truncated === "boolean"
          ? { truncated: result.content.truncated }
          : {}),
      });
      return serialized;
    } catch (error) {
      options.onDiagnostic?.({
        callId,
        tool: id,
        inputKind: kind,
        outcome: "error",
        durationMs: Math.max(0, now() - startedAt),
        inputKeys,
        queryKeys,
        errorCode:
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : error instanceof Error
              ? error.name
              : "unknown",
      });
      throw error;
    }
  };
  return [
    tool(async (input) => invoke("jira.issue.search", input), {
        name: RESEARCH_LANGCHAIN_TOOL_NAMES["jira.issue.search"],
        description:
          "Search Jira issues inside the host-bound project and date scope. query supports text and exact conjunctive labels; it never accepts raw JQL. Parse the returned JSON string. Continue only with page.nextCursor.",
        schema: searchInputSchema("jira.issue.search"),
      }),
    tool(async (input) => invoke("jira.issue.get", input), {
        name: RESEARCH_LANGCHAIN_TOOL_NAMES["jira.issue.get"],
        description:
          "Read one Jira issue using only an opaque entityRef returned by researchCandidateRank. A raw jiraIssueSearch entityRef is not admitted and will fail.",
        schema: getInputSchema("jira.issue.get"),
      }),
    tool(async (input) => invoke("wiki.search", input), {
        name: RESEARCH_LANGCHAIN_TOOL_NAMES["wiki.search"],
        description:
          "Search Confluence pages inside the host-bound space and date scope. query supports text, exact conjunctive labels, one numeric ancestorId (descendants), or one numeric parentId (direct children); it never accepts raw CQL. Parse the returned JSON string. Continue only with page.nextCursor.",
        schema: searchInputSchema("wiki.search"),
      }),
    tool(async (input) => invoke("wiki.page.get", input), {
        name: RESEARCH_LANGCHAIN_TOOL_NAMES["wiki.page.get"],
        description:
          "Read one Confluence page using only an opaque entityRef returned by researchCandidateRank. A raw wikiSearch entityRef is not admitted and will fail. Set includeComments only when bounded inline-comment evidence is materially needed; the host caps that sidecar and reports partiality.",
        schema: getInputSchema("wiki.page.get"),
      }),
    tool(async (input) => invoke("research.candidate.rank", input), {
        name: RESEARCH_LANGCHAIN_TOOL_NAMES["research.candidate.rank"],
        description:
          "Required bridge between search and detail reads. Collect page.items[].entityRef from jiraIssueSearch or wikiSearch, call this tool with { product: 'jira' | 'confluence', entityRefs }, then pass only returned items[].entityRef to jiraIssueGet or wikiPageGet.",
        schema: candidateRankInputSchema(),
      }),
  ];
}
