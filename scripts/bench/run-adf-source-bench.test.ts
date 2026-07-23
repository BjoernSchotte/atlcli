import { describe, expect, it } from "bun:test";
import {
  assertAdfSourceParity,
  type AdfSourceScenarioRecord,
} from "./run-adf-source-bench.js";

function scenario(
  scope: "page" | "tree" | "space",
  representation: "adf-primary" | "storage-primary",
  pages: number,
): AdfSourceScenarioRecord {
  const adf = representation === "adf-primary";
  const storageRequests = pages;
  const adfRequests = adf ? pages : 0;
  const navigation = scope === "page" ? 0 : pages * 2;
  const homepage = scope === "space" ? 1 : 0;
  const totalRequests = storageRequests + adfRequests + navigation + 1 + homepage;
  return {
    scope,
    representation,
    pages,
    repeat: 1,
    processRepeat: 1,
    sourceSamplesMs: [1],
    sourceMedianMs: 1,
    requests: {
      adfBodyRequests: adfRequests,
      storageBodyRequests: storageRequests,
      navigationRequests: navigation,
      versionRequests: 1,
      spaceHomepageRequests: homepage,
      adfBodyBytes: adf ? 200 * pages : 0,
      storageBodyBytes: 100 * pages,
      totalRequests,
      totalBodyBytes: (adf ? 300 : 100) * pages,
      requestsPerPage: totalRequests / pages,
      bodyRequestsPerPage: adf ? 2 : 1,
    },
    rawBlockCount: pages * 10,
    composedBlockCount: pages * 11,
    noteCount: adf ? pages : 0,
    complete: true,
    docx: { bytes: 1000, sha256: "docx", hashMethod: "normalized-docx-parts-sha256", ms: 1 },
    pdf: { bytes: 2000, sha256: "pdf", hashMethod: "raw-sha256", ms: 1 },
    processMs: 3,
    peakRssBytes: 100,
    rssMethod: "bsd-time-l",
  };
}

describe("ADF source benchmark parity gate", () => {
  it("accepts exact blocks/artifacts and the expected one-request-per-page overhead", () => {
    const scenarios = (["page", "tree", "space"] as const).flatMap((scope) => {
      const pages = scope === "page" ? 1 : 8;
      return [scenario(scope, "storage-primary", pages), scenario(scope, "adf-primary", pages)];
    });
    expect(assertAdfSourceParity(scenarios)).toEqual([
      { scope: "page", pages: 1, addedRequestsPerPage: 1, docxArtifactIdentical: true, pdfByteIdentical: true, blocksIdentical: true, adfNoteCount: 1, storageNoteCount: 0, addedBodyBytesPerPage: 200, sourceMedianRatio: 1, sourceWallBudgetMs: 3, sourceWallWithinBudget: true, peakRssAddedBytes: 0, peakRssBudgetBytes: 33554432, peakRssWithinBudget: true },
      { scope: "tree", pages: 8, addedRequestsPerPage: 1, docxArtifactIdentical: true, pdfByteIdentical: true, blocksIdentical: true, adfNoteCount: 8, storageNoteCount: 0, addedBodyBytesPerPage: 200, sourceMedianRatio: 1, sourceWallBudgetMs: 3, sourceWallWithinBudget: true, peakRssAddedBytes: 0, peakRssBudgetBytes: 33554432, peakRssWithinBudget: true },
      { scope: "space", pages: 8, addedRequestsPerPage: 1, docxArtifactIdentical: true, pdfByteIdentical: true, blocksIdentical: true, adfNoteCount: 8, storageNoteCount: 0, addedBodyBytesPerPage: 200, sourceMedianRatio: 1, sourceWallBudgetMs: 3, sourceWallWithinBudget: true, peakRssAddedBytes: 0, peakRssBudgetBytes: 33554432, peakRssWithinBudget: true },
    ]);
  });

  it("fails closed on request or artifact drift", () => {
    const storage = scenario("page", "storage-primary", 1);
    const adf = scenario("page", "adf-primary", 1);
    adf.pdf.sha256 = "different";
    expect(() => assertAdfSourceParity([
      storage,
      adf,
      scenario("tree", "storage-primary", 1),
      scenario("tree", "adf-primary", 1),
      scenario("space", "storage-primary", 1),
      scenario("space", "adf-primary", 1),
    ])).toThrow(/parity or rollout budgets/);
  });

  it("fails closed on source wall-time budget drift", () => {
    const scenarios = (["page", "tree", "space"] as const).flatMap((scope) => {
      const pages = scope === "page" ? 1 : 8;
      return [scenario(scope, "storage-primary", pages), scenario(scope, "adf-primary", pages)];
    });
    scenarios[1]!.sourceMedianMs = 4;
    expect(() => assertAdfSourceParity(scenarios)).toThrow(/rollout budgets/);
  });
});
