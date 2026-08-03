import { tool, type DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod/v4";
import type { ResearchCapabilityBroker } from "./broker.js";
import {
  RESEARCH_CAPABILITY_SCHEMAS,
  RESEARCH_LANGCHAIN_TOOL_NAMES,
} from "./capability-contracts.js";
import type { ResearchToolId } from "./contracts.js";
import type { ResearchGraphCapabilityV1 } from "./graph.js";

const searchInputSchema = (toolId: "jira.issue.search" | "wiki.search") =>
  z.union([
    z
      .object({
        query: z
          .object({
            text: z.string().max(500).optional(),
            labels: z.array(z.string().max(255)).min(1).max(8).optional(),
            ...(toolId === "wiki.search"
              ? { ancestorId: z.string().max(128).optional() }
              : {}),
          })
          .strict(),
        pageSize: z.number().int().positive().optional(),
      })
      .strict(),
    z
      .object({
        cursor: z.string().max(220),
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

const getInputSchema = () =>
  z
    .object({
      entityRef: z.string().max(220),
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
  tool: ResearchGraphCapabilityV1;
  inputKind: "search" | "continuation" | "detail" | "reference" | "ranking";
  outcome: "started" | "success" | "error";
  durationMs?: number;
  itemCount?: number;
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
  ) => void | Promise<void>;
  now?: () => number;
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
      const record =
        typeof input === "object" && input !== null ? input : {};
      const nestedCursor =
        "query" in record &&
        typeof record.query === "object" &&
        record.query !== null &&
        "cursor" in record.query &&
        typeof record.query.cursor === "string"
          ? record.query.cursor
          : undefined;
      const result = await broker.invoke(id, {
        ...(nestedCursor ? { cursor: nestedCursor } : record),
        schema: RESEARCH_CAPABILITY_SCHEMAS[id].input,
      });
      const serialized = jsonResult(result);
      await options.onResult?.(id, result, callId);
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
          "Read one Jira issue previously returned by jiraIssueSearch. Parse the returned JSON string. entityRef is opaque.",
        schema: getInputSchema(),
      }),
    tool(async (input) => invoke("wiki.search", input), {
        name: RESEARCH_LANGCHAIN_TOOL_NAMES["wiki.search"],
        description:
          "Search Confluence pages inside the host-bound space and date scope. query supports text, exact conjunctive labels, and one numeric ancestorId; it never accepts raw CQL. Parse the returned JSON string. Continue only with page.nextCursor.",
        schema: searchInputSchema("wiki.search"),
      }),
    tool(async (input) => invoke("wiki.page.get", input), {
        name: RESEARCH_LANGCHAIN_TOOL_NAMES["wiki.page.get"],
        description:
          "Read one Confluence page previously returned by wikiSearch. Parse the returned JSON string. entityRef is opaque.",
        schema: getInputSchema(),
      }),
    tool(async (input) => invoke("research.candidate.rank", input), {
        name: RESEARCH_LANGCHAIN_TOOL_NAMES["research.candidate.rank"],
        description:
          "Rank opaque Jira or Confluence candidates previously returned by a scoped search. Detail reads require a reference returned by this tool.",
        schema: candidateRankInputSchema(),
      }),
  ];
}
