import { describe, expect, test } from "bun:test";
import {
  AssetBudgetExceededError,
  ExportCompletenessError,
  LabelFilterError,
  PaginationLoopError,
  SpaceHomepageError,
  TreeLimitExceededError,
} from "@atlcli/confluence";
import { ERROR_CODES } from "@atlcli/core";
import { mapTreeExportError } from "./export-errors.js";

/**
 * Pure, table-driven proof that every typed error from @atlcli/confluence maps
 * to a stable machine code + exit code, and that any unknown error maps to a
 * generic structured failure — the "stdout carries exactly one JSON document"
 * contract cannot be broken by an unhandled error class.
 */
describe("mapTreeExportError — typed errors", () => {
  const cases: Array<{
    name: string;
    error: unknown;
    exitCode: number;
    errCode: string;
    detailCode: string;
  }> = [
    {
      name: "SpaceHomepageError → API (runtime state, not usage)",
      error: new SpaceHomepageError("DOCSY"),
      exitCode: 1,
      errCode: ERROR_CODES.API,
      detailCode: "space-homepage-missing",
    },
    {
      name: "TreeLimitExceededError (max-pages) → VALIDATION",
      error: new TreeLimitExceededError("max-pages", 500),
      exitCode: 1,
      errCode: ERROR_CODES.VALIDATION,
      detailCode: "max-pages",
    },
    {
      name: "TreeLimitExceededError (max-folders) → VALIDATION",
      error: new TreeLimitExceededError("max-folders", 200),
      exitCode: 1,
      errCode: ERROR_CODES.VALIDATION,
      detailCode: "max-folders",
    },
    {
      name: "LabelFilterError → VALIDATION",
      error: new LabelFilterError("empty-include-result", "nothing matched"),
      exitCode: 1,
      errCode: ERROR_CODES.VALIDATION,
      detailCode: "empty-include-result",
    },
    {
      name: "ExportCompletenessError → API with affected pages",
      error: new ExportCompletenessError("page-unreadable", [{ id: "1", title: "Secret" }]),
      exitCode: 1,
      errCode: ERROR_CODES.API,
      detailCode: "page-unreadable",
    },
    {
      name: "AssetBudgetExceededError → VALIDATION with offenders",
      error: new AssetBudgetExceededError(
        [{ filename: "huge.png", pageId: "9", sizeBytes: 60_000_000 }],
        60_000_000,
        50_000_000
      ),
      exitCode: 1,
      errCode: ERROR_CODES.VALIDATION,
      detailCode: "asset-budget-exceeded",
    },
    {
      name: "PaginationLoopError → API",
      error: new PaginationLoopError("cursor-abc"),
      exitCode: 1,
      errCode: ERROR_CODES.API,
      detailCode: "pagination-loop",
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const mapped = mapTreeExportError(c.error);
      expect(mapped.exitCode).toBe(c.exitCode);
      expect(mapped.errCode).toBe(c.errCode);
      expect(mapped.details.code).toBe(c.detailCode);
      expect(mapped.message.length).toBeGreaterThan(0);
    });
  }

  test("ExportCompletenessError carries the affected page list", () => {
    const mapped = mapTreeExportError(
      new ExportCompletenessError("subtree-unreadable", [
        { id: "1", title: "A" },
        { id: "2", title: "B" },
      ])
    );
    expect(mapped.details.affected).toEqual([
      { id: "1", title: "A" },
      { id: "2", title: "B" },
    ]);
  });

  test("AssetBudgetExceededError carries the offender list + byte counts", () => {
    const mapped = mapTreeExportError(
      new AssetBudgetExceededError([{ filename: "a.png", sizeBytes: 10 }], 10, 5)
    );
    expect(mapped.details.offenders).toEqual([{ filename: "a.png", sizeBytes: 10 }]);
    expect(mapped.details.totalBytes).toBe(10);
    expect(mapped.details.limitBytes).toBe(5);
  });
});

describe("mapTreeExportError — abort + catch-all", () => {
  test("AbortError (DOMException-style) → exit 130", () => {
    const abort = new Error("The operation was aborted.");
    abort.name = "AbortError";
    const mapped = mapTreeExportError(abort);
    expect(mapped.exitCode).toBe(130);
    expect(mapped.errCode).toBe(ERROR_CODES.IO);
    expect(mapped.details.code).toBe("cancelled");
  });

  test("unknown Error → generic structured failure (never a rethrow)", () => {
    const mapped = mapTreeExportError(new TypeError("boom"));
    expect(mapped.exitCode).toBe(1);
    expect(mapped.errCode).toBe(ERROR_CODES.API);
    expect(mapped.details.code).toBe("unexpected-error");
    expect(mapped.details.name).toBe("TypeError");
    expect(mapped.message).toContain("boom");
  });

  test("non-Error throw (string) → generic structured failure", () => {
    const mapped = mapTreeExportError("catastrophe");
    expect(mapped.exitCode).toBe(1);
    expect(mapped.details.code).toBe("unexpected-error");
    expect(mapped.message).toContain("catastrophe");
  });
});
