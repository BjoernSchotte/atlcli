import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod/v4";
import type { ResearchCapabilityBroker } from "./broker.js";
import {
  RESEARCH_CAPABILITY_SCHEMAS,
  RESEARCH_LANGCHAIN_TOOL_NAMES,
} from "./capability-contracts.js";

const searchInputSchema = (schema: string) =>
  z
    .object({
      schema: z.literal(schema),
      query: z
        .object({
          text: z.string().max(500).optional(),
        })
        .strict()
        .optional(),
      pageSize: z.number().int().positive().optional(),
      cursor: z.string().max(220).optional(),
    })
    .strict();

const getInputSchema = (schema: string) =>
  z
    .object({
      schema: z.literal(schema),
      entityRef: z.string().max(220),
    })
    .strict();

function jsonResult(value: unknown): string {
  return JSON.stringify(value);
}

export function createResearchPtcTools(
  broker: ResearchCapabilityBroker
): StructuredToolInterface[] {
  return [
    tool(
      async (input) =>
        jsonResult(await broker.invoke("jira.issue.search", input)),
      {
        name: RESEARCH_LANGCHAIN_TOOL_NAMES["jira.issue.search"],
        description:
          "Search Jira issues inside the host-bound project and date scope. Parse the returned JSON string. Continue only with page.nextCursor.",
        schema: searchInputSchema(
          RESEARCH_CAPABILITY_SCHEMAS["jira.issue.search"].input
        ),
      }
    ),
    tool(
      async (input) => jsonResult(await broker.invoke("jira.issue.get", input)),
      {
        name: RESEARCH_LANGCHAIN_TOOL_NAMES["jira.issue.get"],
        description:
          "Read one Jira issue previously returned by jiraIssueSearch. Parse the returned JSON string. entityRef is opaque.",
        schema: getInputSchema(RESEARCH_CAPABILITY_SCHEMAS["jira.issue.get"].input),
      }
    ),
    tool(
      async (input) => jsonResult(await broker.invoke("wiki.search", input)),
      {
        name: RESEARCH_LANGCHAIN_TOOL_NAMES["wiki.search"],
        description:
          "Search Confluence pages inside the host-bound space and date scope. Parse the returned JSON string. Continue only with page.nextCursor.",
        schema: searchInputSchema(RESEARCH_CAPABILITY_SCHEMAS["wiki.search"].input),
      }
    ),
    tool(
      async (input) => jsonResult(await broker.invoke("wiki.page.get", input)),
      {
        name: RESEARCH_LANGCHAIN_TOOL_NAMES["wiki.page.get"],
        description:
          "Read one Confluence page previously returned by wikiSearch. Parse the returned JSON string. entityRef is opaque.",
        schema: getInputSchema(RESEARCH_CAPABILITY_SCHEMAS["wiki.page.get"].input),
      }
    ),
  ];
}
