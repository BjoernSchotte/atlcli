import { describe, expect, test } from "bun:test";
import {
  RESEARCH_SCOPE_MENTION_PROPOSAL_SCHEMA_V1,
  validateResearchScopeMentionProposalsV1,
  type ResearchScopeMentionProposalV1,
} from "./scope-discovery.js";

const origin = "https://example.atlassian.net";
const question = "Compare the Account Management space with the Delivery project.";

function proposal(
  text: string,
  overrides: Partial<ResearchScopeMentionProposalV1> = {},
): ResearchScopeMentionProposalV1 {
  const start = question.indexOf(text);
  return {
    schema: RESEARCH_SCOPE_MENTION_PROPOSAL_SCHEMA_V1,
    id: `mention:${start}`,
    text,
    normalizedText: text.toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
    questionTextRange: { start, end: start + text.length },
    ...overrides,
  };
}

describe("host-verified natural-language scope mentions", () => {
  test("accepts exact non-overlapping question ranges and preserves no extra prose", () => {
    expect(validateResearchScopeMentionProposalsV1({
      question,
      expectedTenantOrigin: origin,
      proposals: [
        proposal("Account Management space", { productHint: "confluence", entityKindHint: "space" }),
        proposal("Delivery project", { productHint: "jira", entityKindHint: "project" }),
      ],
    })).toEqual([
      {
        id: "mention:12",
        productHint: "confluence",
        entityKindHint: "space",
        source: "natural_language",
        text: "Account Management space",
        normalizedText: "account management space",
        questionTextRange: { start: 12, end: 36 },
      },
      {
        id: "mention:46",
        productHint: "jira",
        entityKindHint: "project",
        source: "natural_language",
        text: "Delivery project",
        normalizedText: "delivery project",
        questionTextRange: { start: 46, end: 62 },
      },
    ]);
  });

  test("rejects invented text, normalization drift, duplicate IDs, and overlaps", () => {
    expect(() => validateResearchScopeMentionProposalsV1({
      question,
      expectedTenantOrigin: origin,
      proposals: [proposal("Delivery project", { text: "Invented project" })],
    })).toThrow("exact question range");
    expect(() => validateResearchScopeMentionProposalsV1({
      question,
      expectedTenantOrigin: origin,
      proposals: [proposal("Delivery project", { normalizedText: "another project" })],
    })).toThrow("normalization");
    const first = proposal("Account Management space");
    expect(() => validateResearchScopeMentionProposalsV1({
      question,
      expectedTenantOrigin: origin,
      proposals: [first, proposal("Delivery project", { id: first.id })],
    })).toThrow("duplicated");
    expect(() => validateResearchScopeMentionProposalsV1({
      question,
      expectedTenantOrigin: origin,
      proposals: [
        proposal("Account Management space"),
        proposal("Management space"),
      ],
    })).toThrow("overlap");
  });

  test("accepts only exact current-tenant Jira or Confluence references", () => {
    const jiraReference = `${origin}/browse/DEMO-1`;
    expect(validateResearchScopeMentionProposalsV1({
      question,
      expectedTenantOrigin: origin,
      proposals: [proposal("Delivery project", { exactReference: jiraReference })],
    })[0]).toMatchObject({ source: "exact_link", exactReference: jiraReference });
    expect(() => validateResearchScopeMentionProposalsV1({
      question,
      expectedTenantOrigin: origin,
      proposals: [proposal("Delivery project", { exactReference: "https://foreign.example/browse/DEMO-1" })],
    })).toThrow("outside the current tenant");
    expect(() => validateResearchScopeMentionProposalsV1({
      question,
      expectedTenantOrigin: origin,
      proposals: [proposal("Delivery project", { exactReference: `${origin}/plugins/servlet/unsafe` })],
    })).toThrow("unsupported");
  });

  test("fails before catalog work on excessive or conflicting proposals", () => {
    expect(() => validateResearchScopeMentionProposalsV1({
      question,
      expectedTenantOrigin: origin,
      maxMentions: 1,
      proposals: [proposal("Account Management space"), proposal("Delivery project")],
    })).toThrow("count");
    expect(() => validateResearchScopeMentionProposalsV1({
      question,
      expectedTenantOrigin: origin,
      proposals: [proposal("Delivery project", { productHint: "jira", entityKindHint: "space" })],
    })).toThrow("conflict");
  });
});
