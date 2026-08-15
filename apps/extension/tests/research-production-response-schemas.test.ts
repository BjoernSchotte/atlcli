import { afterEach, describe, expect, test } from "bun:test";
import { ReplSession } from "@langchain/quickjs";
import { characterizeProductionResponseSchemas } from "./research/production-response-schema-characterization.js";

afterEach(() => {
  ReplSession.clearCache();
  ReplSession.resetSharedModule();
});

describe("durable research production response schema feasibility", () => {
  test("admits every exact role schema through native QuickJS task dispatch", async () => {
    const result = await characterizeProductionResponseSchemas("production-schema-bun");

    expect(result.metrics).toEqual({
      ResearchPacketBodyV1: {
        serializedBytes: 2_494,
        propertyCount: 27,
        nestingDepth: 4,
      },
      ResearchPacketBodyV2: {
        serializedBytes: 3_052,
        propertyCount: 32,
        nestingDepth: 5,
      },
      ResearchPacketReferenceModelV2: {
        serializedBytes: 2_463,
        propertyCount: 26,
        nestingDepth: 4,
      },
      ReconciliationBodyV1: {
        serializedBytes: 1_957,
        propertyCount: 19,
        nestingDepth: 5,
      },
    });
    expect(result.admittedRoles).toEqual([
      "contradiction-verifier",
      "coverage-moderator",
      "document-distiller",
      "focused-researcher",
      "outline-planner",
      "reconciler",
    ]);
  });
});
