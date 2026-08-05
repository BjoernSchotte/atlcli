import { tool, type DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod/v4";
import {
  createResearchPtcTools,
  type ResearchPtcDiagnosticV1,
  type ResearchPtcToolOptions,
} from "../agent-tools.js";
import type { ResearchCapabilityBroker } from "../broker.js";
import {
  BOUND_ENTITY_READ_CAPABILITY_ID_V1,
  BOUND_ENTITY_READ_INPUT_SCHEMA_V1,
  type BoundEntityReadOutputV1,
} from "../capability-contracts.js";
import type { ResearchProduct } from "../contracts.js";

interface ChatPtcToolOptionsV1 extends Omit<ResearchPtcToolOptions, "onResult"> {
  exactContextProducts?: readonly ResearchProduct[];
  searchProducts?: readonly ResearchProduct[];
  onResult?: (
    tool: typeof BOUND_ENTITY_READ_CAPABILITY_ID_V1,
    result: unknown,
    callId: string,
  ) => void | Promise<void>;
}

const boundReadInputSchema = z.object({
  anchorRef: z.string().max(220),
}).strict();

function sourceLabel(result: BoundEntityReadOutputV1): string {
  const identity = result.source.issueKey ??
    (result.source.contentId ? `Confluence ${result.source.contentId}` : result.source.sourceId);
  return [identity, result.source.title].filter(Boolean).join(": ").slice(0, 240);
}

/** Chat tool surface: direct exact reads plus discovery only where still authorized. */
export function createChatPtcToolsV1(
  broker: ResearchCapabilityBroker,
  options: ChatPtcToolOptionsV1 = {},
): DynamicStructuredTool[] {
  let sequence = 0;
  const now = options.now ?? Date.now;
  const direct = tool(async (input) => {
    const callId = `${BOUND_ENTITY_READ_CAPABILITY_ID_V1}:${++sequence}`;
    const startedAt = now();
    options.onDiagnostic?.({
      callId,
      tool: BOUND_ENTITY_READ_CAPABILITY_ID_V1,
      inputKind: "detail",
      outcome: "started",
      inputKeys: ["anchorRef"],
    });
    try {
      const result = await broker.readExactAnchor({
        schema: BOUND_ENTITY_READ_INPUT_SCHEMA_V1,
        ...input,
      });
      const serialized = JSON.stringify(result);
      await options.onResult?.(BOUND_ENTITY_READ_CAPABILITY_ID_V1, result, callId);
      options.onDiagnostic?.({
        callId,
        tool: BOUND_ENTITY_READ_CAPABILITY_ID_V1,
        inputKind: "detail",
        outcome: "success",
        durationMs: Math.max(0, now() - startedAt),
        itemCount: 1,
        itemLabels: [sourceLabel(result)],
        resultBytes: new TextEncoder().encode(serialized).byteLength,
        truncated: result.content.truncated,
      });
      return serialized;
    } catch (error) {
      options.onDiagnostic?.({
        callId,
        tool: BOUND_ENTITY_READ_CAPABILITY_ID_V1,
        inputKind: "detail",
        outcome: "error",
        durationMs: Math.max(0, now() - startedAt),
        errorCode: typeof error === "object" && error !== null && "code" in error &&
          typeof error.code === "string" ? error.code : "unknown",
        inputKeys: ["anchorRef"],
      });
      throw error;
    }
  }, {
    name: "atlassian_bound_read",
    description:
      "Read exactly one host-bound Jira issue or Confluence page by its opaque anchorRef. This bypasses search and ranking and cannot accept a raw ID, key, URL, tenant, project, or space.",
    schema: boundReadInputSchema,
  });

  const exact = new Set(options.exactContextProducts ?? []);
  const searchable = new Set(options.searchProducts ?? ["jira", "confluence"]);
  const researchOptions: ResearchPtcToolOptions = {
    ...(options.onDiagnostic
      ? { onDiagnostic: options.onDiagnostic as (diagnostic: ResearchPtcDiagnosticV1) => void }
      : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  const discovery = createResearchPtcTools(broker, researchOptions).filter((candidate) => {
    if ((!searchable.has("jira") || exact.has("jira")) &&
        ["jira_issue_search", "jira_issue_get"].includes(candidate.name)) {
      return false;
    }
    if ((!searchable.has("confluence") || exact.has("confluence")) &&
        ["wiki_search", "wiki_page_get"].includes(candidate.name)) {
      return false;
    }
    return true;
  });
  const hasSearch = discovery.some((candidate) =>
    candidate.name === "jira_issue_search" || candidate.name === "wiki_search"
  );
  return [direct, ...discovery.filter((candidate) =>
    hasSearch || candidate.name !== "research_candidate_rank"
  )];
}
