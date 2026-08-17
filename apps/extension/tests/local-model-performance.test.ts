import { describe, expect, test } from "bun:test";
import {
  appendLocalGemmaPerformanceSamplesV1,
  evaluateLocalGemmaPerformanceRatchetV1,
  LOCAL_GEMMA_PERFORMANCE_HISTORY_LIMIT_V1,
  LOCAL_GEMMA_PERFORMANCE_HISTORY_PATH_V1,
  parseLocalGemmaPerformanceHistoryV1,
  summarizeLocalGemmaPerformanceV1,
  type LocalGemmaPerformanceSampleV1,
} from "../utils/local-model/performance.js";
import { BROWSER_CHAT_CALLER_PATH_WORKER_V1 } from "../utils/local-model/caller-path.js";

function sampleV1(
  index: number,
  runtimeState: "cold" | "warm" = "warm",
  totalMs = 1_000 + index,
  firstPreviewMs = 500 + index,
): LocalGemmaPerformanceSampleV1 {
  return {
    callerPath: BROWSER_CHAT_CALLER_PATH_WORKER_V1,
    requestId: `request-${index}`,
    recordedAt: new Date(index * 1_000).toISOString(),
    inputTokens: 1_000 + index,
    outputTokens: 100 + index,
    timing: {
      runtimeState,
      requiredToolName: "ChatAnswerDraftV2",
      queuedMs: 2,
      runtimeLoadMs: runtimeState === "cold" ? 200 : 0,
      tokenizeMs: 10,
      firstTokenMs: 200,
      firstPreviewMs,
      firstPreviewOutputTokens: 12,
      generationMs: 800,
      totalMs,
    },
  };
}

describe("local Gemma performance receipts", () => {
  test("persists only bounded metadata samples", async () => {
    const files = new Map<string, string>();
    const workspace = {
      readFile: async (path: string) => files.get(path),
      writeFile: async (path: string, contents: string) => {
        files.set(path, contents);
      },
    };
    await appendLocalGemmaPerformanceSamplesV1({
      workspace,
      samples: Array.from({ length: 45 }, (_, index) => sampleV1(index)),
    });
    const serialized = files.get(LOCAL_GEMMA_PERFORMANCE_HISTORY_PATH_V1);
    expect(serialized).toBeDefined();
    expect(serialized).not.toContain("question");
    expect(serialized).not.toContain("markdown");
    const history = parseLocalGemmaPerformanceHistoryV1(serialized);
    expect(history.samples).toHaveLength(LOCAL_GEMMA_PERFORMANCE_HISTORY_LIMIT_V1);
    expect(history.samples[0]?.requestId).toBe("request-5");
    expect(history.samples.at(-1)?.requestId).toBe("request-44");
  });

  test("does not persist a direct model or adapter harness as an acceptance sample", async () => {
    const files = new Map<string, string>();
    const directSample = { ...sampleV1(1), callerPath: undefined };
    await appendLocalGemmaPerformanceSamplesV1({
      workspace: {
        readFile: async (path) => files.get(path),
        writeFile: async (path, contents) => {
          files.set(path, contents);
        },
      },
      samples: [directSample],
    });

    expect(parseLocalGemmaPerformanceHistoryV1(
      files.get(LOCAL_GEMMA_PERFORMANCE_HISTORY_PATH_V1),
    ).samples).toEqual([]);
  });

  test("summarizes cold and warm samples separately with medians", () => {
    const samples = [
      sampleV1(0, "cold", 9_000, 3_000),
      sampleV1(1, "warm", 1_000, 400),
      sampleV1(2, "warm", 3_000, 800),
      sampleV1(3, "warm", 2_000, 600),
    ];
    expect(summarizeLocalGemmaPerformanceV1(samples, "cold")).toEqual({
      samples: 1,
      medianFirstPreviewMs: 3_000,
      medianTotalMs: 9_000,
    });
    expect(summarizeLocalGemmaPerformanceV1(samples, "warm")).toEqual({
      samples: 3,
      medianFirstPreviewMs: 600,
      medianTotalMs: 2_000,
    });
  });

  test("fails the ratchet when warm preview or total medians regress", () => {
    const before = [0, 1, 2].map((index) => sampleV1(index, "warm", 1_000, 500));
    const after = [3, 4, 5].map((index) => sampleV1(index, "warm", 1_060, 531));
    expect(evaluateLocalGemmaPerformanceRatchetV1({ before, after })).toEqual({
      passed: false,
      reasons: ["median-total-regressed", "median-first-preview-regressed"],
    });
  });

  test("requires enough warm samples before declaring a pass", () => {
    const before = [sampleV1(0), sampleV1(1)];
    const after = [sampleV1(2), sampleV1(3), sampleV1(4)];
    expect(evaluateLocalGemmaPerformanceRatchetV1({ before, after })).toEqual({
      passed: false,
      reasons: ["before-warm-samples"],
    });
  });
});
