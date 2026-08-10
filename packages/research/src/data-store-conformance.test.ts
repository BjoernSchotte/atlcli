import { describe, expect, test } from "bun:test";
import { verifyResearchDataStoreConformanceV1 } from "./data-store-conformance.js";
import { createMemoryResearchWorkspace } from "./workspace.js";

describe("research private data stores", () => {
  test("passes the reusable evidence, claim, and outline publication conformance suite", async () => {
    await expect(verifyResearchDataStoreConformanceV1({
      create() {
        return {
          evidence: createMemoryResearchWorkspace(),
          claims: createMemoryResearchWorkspace(),
          outline: createMemoryResearchWorkspace(),
        };
      },
    })).resolves.toEqual({
      evidencePublicationAtomicity: "passed",
      claimPublicationAtomicity: "passed",
      outlinePublicationAtomicity: "passed",
      spanAndBindingValidation: "passed",
      evidenceDrivenInvalidation: "passed",
      retentionDeletion: "passed",
    });
  });
});
