import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod/v4";
import type { ResearchCapabilityBroker } from "./broker.js";
import {
  RESEARCH_CAPABILITY_SCHEMAS,
  RESEARCH_LANGCHAIN_TOOL_NAMES,
} from "./capability-contracts.js";
import type { ResearchToolId } from "./contracts.js";

const searchInputSchema = () =>
  z.union([
    z
      .object({
        query: z
          .object({
            text: z.string().max(500).optional(),
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

function jsonResult(value: unknown): string {
  return JSON.stringify(value);
}

export interface ResearchPtcDiagnosticV1 {
  tool: ResearchToolId;
  inputKind: "search" | "continuation" | "detail";
  outcome: "success" | "error";
  itemCount?: number;
  complete?: boolean;
  termination?: string;
  errorCode?: string;
  inputKeys?: string[];
  queryKeys?: string[];
}

export interface ResearchPtcToolOptions {
  onDiagnostic?: (diagnostic: ResearchPtcDiagnosticV1) => void;
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
  }
  return "search";
}

export function createResearchPtcTools(
  broker: ResearchCapabilityBroker,
  options: ResearchPtcToolOptions = {}
): StructuredToolInterface[] {
  const invoke = async (
    id: ResearchToolId,
    input: unknown
  ): Promise<string> => {
    const kind = inputKind(input);
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
      const page =
        typeof result === "object" && result !== null && "page" in result
          ? result.page
          : undefined;
      options.onDiagnostic?.({
        tool: id,
        inputKind: kind,
        outcome: "success",
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
      });
      return jsonResult(result);
    } catch (error) {
      options.onDiagnostic?.({
        tool: id,
        inputKind: kind,
        outcome: "error",
        inputKeys:
          typeof input === "object" && input !== null
            ? Object.keys(input).sort()
            : [],
        queryKeys:
          typeof input === "object" &&
          input !== null &&
          "query" in input &&
          typeof input.query === "object" &&
          input.query !== null
            ? Object.keys(input.query).sort()
            : [],
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
          "Search Jira issues inside the host-bound project and date scope. Parse the returned JSON string. Continue only with page.nextCursor.",
        schema: searchInputSchema(),
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
          "Search Confluence pages inside the host-bound space and date scope. Parse the returned JSON string. Continue only with page.nextCursor.",
        schema: searchInputSchema(),
      }),
    tool(async (input) => invoke("wiki.page.get", input), {
        name: RESEARCH_LANGCHAIN_TOOL_NAMES["wiki.page.get"],
        description:
          "Read one Confluence page previously returned by wikiSearch. Parse the returned JSON string. entityRef is opaque.",
        schema: getInputSchema(),
      }),
  ];
}
