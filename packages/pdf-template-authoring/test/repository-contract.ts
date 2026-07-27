import { expect, test } from "bun:test";
import {
  TEMPLATE_DECISION_STATE_SCHEMA_V1,
  TemplateProjectGenerationConflictError,
  type TemplateDecisionStateV1,
  type TemplateProjectRepository,
} from "../src/index.browser.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function decisions(
  value: string,
  preview = value
): TemplateDecisionStateV1 {
  return {
    schema: TEMPLATE_DECISION_STATE_SCHEMA_V1,
    decisions: [
      {
        id: `override:${value}`,
        kind: "override",
        target: "branding.organizationName",
        value,
      },
    ],
    preview: {
      designReviewDigest: preview,
      compatibilityProofDigest: preview,
    },
  };
}

/**
 * Shared behavioral contract for browser-memory and directory repositories.
 * This module depends only on the host-neutral authoring package.
 */
export function templateProjectRepositoryContract(
  createRepository: () => Promise<TemplateProjectRepository>
): void {
  test("supports immutable read, optimistic commit, history, preview, and undo", async () => {
    const repository = await createRepository();
    const firstDecisions = decisions("first");
    const first = await repository.commit({
      projectId: "contract-project",
      expectedGeneration: null,
      analysisDigest: HASH_A,
      decisions: firstDecisions,
      snapshotDigest: HASH_A,
      privateIntake: { source: "private-one" },
    });
    expect(await repository.read("contract-project")).toEqual(first);

    await expect(
      repository.commit({
        projectId: "contract-project",
        expectedGeneration: null,
        analysisDigest: HASH_A,
        decisions: decisions("conflict"),
      })
    ).rejects.toBeInstanceOf(TemplateProjectGenerationConflictError);

    const second = await repository.commit({
      projectId: "contract-project",
      expectedGeneration: first.generation,
      analysisDigest: HASH_B,
      decisions: decisions("second"),
      snapshotDigest: HASH_B,
    });
    expect(second.parentGeneration).toBe(first.generation);
    expect((await repository.listHistory("contract-project")).map(
      ({ generation }) => generation
    )).toEqual([first.generation, second.generation]);

    const previewBytes = new TextEncoder().encode("preview");
    const previewDigest =
      "5975cf1bba432391c94667f5886225f69377c0aa8b9fa21fddfb21c89bcf9092";
    await repository.putPreview("contract-project", {
      generation: second.generation,
      purpose: "design-review",
      snapshotDigest: HASH_B,
      digest: previewDigest,
      mediaType: "application/pdf",
      byteLength: previewBytes.byteLength,
      pageCount: 1,
      regions: [{ page: 1, region: "summary" }],
      output: { kind: "bytes", bytes: previewBytes },
    });
    expect(
      await repository.getPreview(
        "contract-project",
        second.generation,
        "design-review"
      )
    ).toMatchObject({
      generation: second.generation,
      digest: previewDigest,
      snapshotDigest: HASH_B,
    });

    const undone = await repository.undo({
      projectId: "contract-project",
      expectedGeneration: second.generation,
      targetGeneration: first.generation,
    });
    expect(undone.generation).not.toBe(first.generation);
    expect(undone.generation).not.toBe(second.generation);
    expect(undone.parentGeneration).toBe(second.generation);
    expect(undone.analysisDigest).toBe(second.analysisDigest);
    expect(undone.decisions.decisions).toEqual(firstDecisions.decisions);
    expect(undone.decisions.preview).toEqual({});
    expect(await repository.getPreview(
      "contract-project",
      second.generation,
      "design-review"
    )).toBeDefined();
    expect((await repository.listHistory("contract-project")).map(
      ({ generation }) => generation
    )).toEqual([first.generation, second.generation, undone.generation]);
  });
}
