import { describe, expect, test } from "bun:test";
import type { ExportJobSnapshotV1 } from "@atlcli/export-jobs";
import {
  classifyConfluenceSourceError,
  classifyFailedExportJob,
} from "./export-report.js";

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

describe("durable export job failure classification", () => {
  test("classifies source errors before the resolver redacts their details", () => {
    expect(classifyConfluenceSourceError({ status: 401 })).toBe("authentication");
    expect(classifyConfluenceSourceError({ statusCode: 403 })).toBe("authentication");
    expect(classifyConfluenceSourceError({ status: 404 })).toBe("not-found");
    expect(classifyConfluenceSourceError(new Error("socket closed"))).toBe("unknown");
  });

  test("preserves auth and remote exit codes from redacted Confluence failures", () => {
    expect(
      classifyFailedExportJob(
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
      classifyFailedExportJob({
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
    expect(classifyFailedExportJob(failed("Typst compile failed"))).toMatchObject({
      exitCode: 5,
      issue: { code: "executor.failed", phase: "fetch" },
    });
  });

  test("keeps cancellation on the documented exit code", () => {
    expect(classifyFailedExportJob({ state: "cancelled" })).toMatchObject({
      exitCode: 130,
      issue: { code: "cancelled" },
    });
  });
});
