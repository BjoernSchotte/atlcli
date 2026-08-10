import { describe, expect, test } from "bun:test";
import {
  RESEARCH_DYNAMIC_AGENT_DRAFT_JSON_SCHEMA_V1,
  parseResearchDynamicAgentDraftV1,
} from "./agent-draft.js";

const CLAIM_ID = `claim:${"a".repeat(48)}`;

describe("dynamic V2 research editorial selection", () => {
  test("publishes a closed provider schema while retaining tolerant recovery", () => {
    expect(RESEARCH_DYNAMIC_AGENT_DRAFT_JSON_SCHEMA_V1.additionalProperties).toBe(false);
    expect(parseResearchDynamicAgentDraftV1({
      title: "Recovered",
      selectedClaimIds: [],
      legacyProse: "ignored",
    })).toEqual({ title: "Recovered", selectedClaimIds: [] });
  });

  test("advertises only the title and selected Claim IDs to the final model", () => {
    const schema = RESEARCH_DYNAMIC_AGENT_DRAFT_JSON_SCHEMA_V1 as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      "selectedClaimIds",
      "title",
    ]);
    expect([...(schema.required ?? [])].sort()).toEqual([
      "selectedClaimIds",
      "title",
    ]);
  });

  test("strips legacy prose fields from a recovered draft", () => {
    expect(parseResearchDynamicAgentDraftV1({
      title: "Validated evidence",
      selectedClaimIds: [CLAIM_ID],
      executiveSummary: "Ignored legacy prose.",
      findings: [],
      relationships: [],
      limitations: [],
    })).toEqual({
      title: "Validated evidence",
      selectedClaimIds: [CLAIM_ID],
    });
  });
});
