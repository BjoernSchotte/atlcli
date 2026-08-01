/**
 * T0 feasibility fixtures for the durable-agent packet contracts.
 *
 * These are intentionally test-owned rather than public domain exports. T3
 * must reproduce their serialized JSON byte-for-byte when it introduces the
 * authoritative typed contracts.
 */
import {
  RESEARCH_PACKET_BODY_JSON_SCHEMA_V1,
  RESEARCH_PACKET_MODEL_BODY_JSON_SCHEMA_V2,
  RESEARCH_RECONCILIATION_BODY_JSON_SCHEMA_V1,
} from "@atlcli/research";

type JsonSchema = Record<string, unknown>;

export const RESEARCH_PACKET_BODY_SCHEMA_V1 = RESEARCH_PACKET_BODY_JSON_SCHEMA_V1;

export const RESEARCH_PACKET_BODY_SCHEMA_V2 = RESEARCH_PACKET_MODEL_BODY_JSON_SCHEMA_V2;

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
