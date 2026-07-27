import { describe, expect, test } from "bun:test";
import type { ExportJobSnapshotV1 } from "@atlcli/export-jobs";
import { classifyFailedPdfJob } from "./export-pdf.js";

function failed(message: string): Pick<ExportJobSnapshotV1, "state" | "error"> {
  return {
    state: "failed",
    error: {
      code: "executor.failed",
      message,
      category: "unknown",
      retryable: false,
      stage: "fetch",
      occurredAt: 1,
    },
  };
}

describe("durable PDF job failure classification", () => {
  test("preserves auth and remote exit codes from redacted Confluence failures", () => {
    expect(
      classifyFailedPdfJob(
        {
          state: "failed",
          error: {
            ...failed("redacted").error!,
            code: "confluence-source-resolution-failed",
            category: "auth",
          },
        }
      )
    ).toMatchObject({
      exitCode: 3,
      issue: {
        code: "confluence-source-resolution-failed",
        phase: "fetch",
      },
    });
    expect(
      classifyFailedPdfJob({
        state: "failed",
        error: {
          ...failed("redacted").error!,
          code: "confluence-source-resolution-failed",
          category: "source",
        },
      })
    ).toMatchObject({
      exitCode: 4,
      issue: {
        code: "confluence-source-resolution-failed",
        phase: "fetch",
      },
    });
  });

  test("does not misclassify an executor or compiler failure as remote", () => {
    expect(classifyFailedPdfJob(failed("Typst compile failed"))).toMatchObject({
      exitCode: 5,
      issue: { code: "executor.failed", phase: "fetch" },
    });
  });

  test("keeps cancellation on the documented exit code", () => {
    expect(classifyFailedPdfJob({ state: "cancelled" })).toMatchObject({
      exitCode: 130,
      issue: { code: "cancelled" },
    });
  });
});
