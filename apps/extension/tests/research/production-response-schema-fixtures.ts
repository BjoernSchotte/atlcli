/**
 * T0 feasibility fixtures for the durable-agent packet contracts.
 *
 * These are intentionally test-owned rather than public domain exports. T3
 * must reproduce their serialized JSON byte-for-byte when it introduces the
 * authoritative typed contracts.
 */
import {
  RESEARCH_PACKET_BODY_JSON_SCHEMA_V1,
  RESEARCH_RECONCILIATION_BODY_JSON_SCHEMA_V1,
} from "@atlcli/research";

type JsonSchema = Record<string, unknown>;

const boundedString = (maxLength: number): JsonSchema => ({ type: "string", maxLength });
const boundedStringArray = (maxItems: number, maxLength = 200): JsonSchema => ({
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
    explanation: boundedString(700),
  },
  ["id", "explanation"],
);

const followUpSchema = closedObject(
  "ResearchFollowUpProposalV1",
  {
    id: boundedString(160),
    objective: boundedString(700),
  },
  ["id", "objective"],
);

const packetBaseProperties = (): Record<string, JsonSchema> => ({
  answeredQuestion: boundedString(1_200),
  gaps: boundedObjectArray(12, gapSchema),
  proposedFollowUps: boundedObjectArray(8, followUpSchema),
  coverageLimits: boundedStringArray(12, 600),
  abstentionReason: boundedString(700),
});

export const RESEARCH_PACKET_BODY_SCHEMA_V1 = RESEARCH_PACKET_BODY_JSON_SCHEMA_V1;

export const RESEARCH_PACKET_BODY_SCHEMA_V2 = closedObject(
  "ResearchPacketBodyV2",
  {
    schema: { const: "atlcli.research-packet-body/v2" },
    ...packetBaseProperties(),
    evidence: boundedObjectArray(
      48,
      closedObject(
        "ResearchEvidenceSpanV2",
        {
          evidenceId: boundedString(160),
          chunkId: boundedString(160),
          start: { type: "integer", minimum: 0 },
          end: { type: "integer", minimum: 0 },
        },
        ["evidenceId", "chunkId", "start", "end"],
      ),
    ),
    claimCandidates: boundedObjectArray(
      20,
      closedObject(
        "ResearchClaimCandidateV2",
        {
          id: boundedString(160),
          summary: boundedString(800),
          evidenceIds: boundedStringArray(12),
        },
        ["id", "summary", "evidenceIds"],
      ),
    ),
    contradictions: boundedObjectArray(
      12,
      closedObject(
        "ResearchContradictionCandidateV2",
        {
          id: boundedString(160),
          claimIds: boundedStringArray(8),
          explanation: boundedString(700),
        },
        ["id", "claimIds", "explanation"],
      ),
    ),
    outlineProposals: boundedObjectArray(
      12,
      closedObject(
        "ResearchOutlineProposalV1",
        {
          id: boundedString(160),
          sectionId: boundedString(160),
          title: boundedString(240),
          question: boundedString(700),
          claimIds: boundedStringArray(20),
          evidenceIds: boundedStringArray(32),
          dependsOnSectionIds: boundedStringArray(12),
        },
        [
          "id",
          "sectionId",
          "title",
          "question",
          "claimIds",
          "evidenceIds",
          "dependsOnSectionIds",
        ],
      ),
    ),
  },
  [
    "schema",
    "answeredQuestion",
    "gaps",
    "proposedFollowUps",
    "coverageLimits",
    "evidence",
    "claimCandidates",
    "contradictions",
    "outlineProposals",
  ],
);

export const RECONCILIATION_BODY_SCHEMA_V1 = RESEARCH_RECONCILIATION_BODY_JSON_SCHEMA_V1;

export const PRODUCTION_RESPONSE_SCHEMA_FIXTURES = [
  {
    id: "ResearchPacketBodyV1",
    roles: [
      "focused-researcher",
      "document-distiller",
      "contradiction-verifier",
      "coverage-moderator",
    ],
    schema: RESEARCH_PACKET_BODY_SCHEMA_V1,
  },
  {
    id: "ResearchPacketBodyV2",
    roles: ["outline-planner"],
    schema: RESEARCH_PACKET_BODY_SCHEMA_V2,
  },
  {
    id: "ReconciliationBodyV1",
    roles: ["reconciler"],
    schema: RECONCILIATION_BODY_SCHEMA_V1,
  },
] as const;

export interface ResponseSchemaMetrics {
  serializedBytes: number;
  propertyCount: number;
  nestingDepth: number;
}

export function responseSchemaMetrics(schema: JsonSchema): ResponseSchemaMetrics {
  let propertyCount = 0;
  let nestingDepth = 0;
  const visit = (node: JsonSchema, depth: number): void => {
    nestingDepth = Math.max(nestingDepth, depth);
    const properties = node.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      const propertySchemas = properties as Record<string, unknown>;
      propertyCount += Object.keys(propertySchemas).length;
      for (const value of Object.values(propertySchemas)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          visit(value as JsonSchema, depth + 1);
        }
      }
    }
    const items = node.items;
    if (items && typeof items === "object" && !Array.isArray(items)) {
      visit(items as JsonSchema, depth + 1);
    }
  };
  visit(schema, 0);
  return {
    serializedBytes: new TextEncoder().encode(JSON.stringify(schema)).byteLength,
    propertyCount,
    nestingDepth,
  };
}
