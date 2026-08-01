type JsonSchema = Record<string, unknown>;

const boundedString = (maxLength: number): JsonSchema => ({ type: "string", maxLength });
const boundedStringArray = (maxItems: number, maxLength = 240): JsonSchema => ({
  type: "array",
  maxItems,
  items: boundedString(maxLength),
});
const closedObject = (
  title: string,
  properties: Record<string, JsonSchema>,
  required: readonly string[],
): JsonSchema => ({
  title,
  type: "object",
  additionalProperties: false,
  required: [...required],
  properties,
});
const boundedObjectArray = (maxItems: number, items: JsonSchema): JsonSchema => ({
  type: "array",
  maxItems,
  items,
});

const gapSchema = closedObject(
  "ResearchGapV1",
  {
    id: boundedString(160),
    summary: boundedString(600),
    targetId: boundedString(160),
    sourceIds: boundedStringArray(12),
  },
  ["id", "summary", "sourceIds"],
);

const followUpSchema = closedObject(
  "ResearchFollowUpProposalV1",
  {
    id: boundedString(160),
    objective: boundedString(1_000),
    reasonCode: {
      type: "string",
      enum: ["coverage_gap", "contradiction", "negative_claim", "stale_or_truncated"],
    },
    sourceIds: boundedStringArray(12),
  },
  ["id", "objective", "reasonCode", "sourceIds"],
);

export const RESEARCH_PACKET_BODY_JSON_SCHEMA_V1: Record<string, unknown> = closedObject(
  "ResearchPacketBodyV1",
  {
    schema: { const: "atlcli.research-packet-body/v1" },
    answeredQuestion: boundedString(2_000),
    sourceIds: boundedStringArray(64),
    findingCandidates: boundedObjectArray(
      24,
      closedObject(
        "ResearchFindingCandidateV1",
        {
          id: boundedString(160),
          classification: { type: "string", enum: ["fact", "inference"] },
          summary: boundedString(800),
          sourceIds: boundedStringArray(12),
        },
        ["id", "classification", "summary", "sourceIds"],
      ),
    ),
    relationshipCandidates: boundedObjectArray(
      24,
      closedObject(
        "ResearchRelationshipCandidateV1",
        {
          id: boundedString(160),
          classification: { type: "string", enum: ["verified", "hypothesis"] },
          jiraIssueKey: boundedString(80),
          confluenceContentId: boundedString(120),
          summary: boundedString(800),
          sourceIds: boundedStringArray(12),
        },
        ["id", "classification", "jiraIssueKey", "confluenceContentId", "summary", "sourceIds"],
      ),
    ),
    gaps: boundedObjectArray(16, gapSchema),
    proposedFollowUps: boundedObjectArray(3, followUpSchema),
    coverageLimits: boundedStringArray(16),
    abstentionReason: boundedString(1_000),
  },
  [
    "schema",
    "answeredQuestion",
    "sourceIds",
    "findingCandidates",
    "relationshipCandidates",
    "gaps",
    "proposedFollowUps",
    "coverageLimits",
  ],
);

export const RESEARCH_RECONCILIATION_BODY_JSON_SCHEMA_V1: Record<string, unknown> = closedObject(
  "ReconciliationBodyV1",
  {
    schema: { const: "atlcli.reconciliation-body/v1" },
    defects: boundedObjectArray(
      16,
      closedObject(
        "ResearchReconciliationDefectV1",
        {
          id: boundedString(160),
          severity: { type: "string", enum: ["blocking", "important", "minor"] },
          target: closedObject(
            "ResearchReconciliationTargetV1",
            {
              kind: {
                type: "string",
                enum: ["finding", "relationship", "claim", "section", "node", "coverage"],
              },
              id: boundedString(160),
            },
            ["kind", "id"],
          ),
          code: {
            type: "string",
            enum: ["unsupported", "contradicted", "missing_coverage", "overstated", "instruction_mismatch", "duplicate", "stale"],
          },
          references: boundedObjectArray(
            16,
            closedObject(
              "ResearchSupportRefV1",
              {
                kind: { type: "string", enum: ["source", "evidence"] },
                id: boundedString(200),
              },
              ["kind", "id"],
            ),
          ),
          explanation: boundedString(1_000),
          suggestedAction: {
            type: "string",
            enum: ["accept", "revise", "downgrade", "add_follow_up", "abstain"],
          },
        },
        ["id", "severity", "target", "code", "references", "explanation", "suggestedAction"],
      ),
    ),
    proposedFollowUps: boundedObjectArray(3, followUpSchema),
  },
  ["schema", "defects", "proposedFollowUps"],
);
