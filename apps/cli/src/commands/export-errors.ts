/**
 * Pure mapping from tree/space-export errors to structured CLI failures
 * (spec 002, CLI task — A5 report/exit-code contract).
 *
 * TOTAL over every error class, present and future: each typed error from
 * `@atlcli/confluence` maps to a stable machine code and exit code, and any
 * unknown error maps to a generic structured failure. The handler feeds the
 * result straight into `fail()`, so under `--json` stdout always carries exactly
 * one JSON document — no error class can leak through to a plain-text
 * `main().catch()` path.
 *
 * Pure: no IO, no `process`. Fully unit-testable.
 */
import {
  AssetBudgetExceededError,
  ExportCompletenessError,
  LabelFilterError,
  PaginationLoopError,
  SpaceHomepageError,
  TreeLimitExceededError,
} from "@atlcli/confluence";
import { ERROR_CODES } from "@atlcli/core";

/** Everything `fail()` needs: exit code, machine code, message, details. */
export interface MappedExportError {
  exitCode: number;
  errCode: string;
  message: string;
  details: Record<string, unknown>;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Map any error thrown on the tree/space export path to a structured failure.
 * Never throws, never returns undefined — the catch-all branch guarantees the
 * single-JSON-document contract holds for unexpected errors too.
 */
export function mapTreeExportError(error: unknown): MappedExportError {
  if (error instanceof SpaceHomepageError) {
    // Runtime/API-state condition (the space simply has no classic homepage),
    // not a flag mistake — API, not USAGE.
    return {
      exitCode: 1,
      errCode: ERROR_CODES.API,
      message: error.message,
      details: { code: "space-homepage-missing", spaceKey: error.spaceKey },
    };
  }
  if (error instanceof TreeLimitExceededError) {
    return {
      exitCode: 1,
      errCode: ERROR_CODES.VALIDATION,
      message: error.message,
      details: { code: error.code, limit: error.limit },
    };
  }
  if (error instanceof LabelFilterError) {
    return {
      exitCode: 1,
      errCode: ERROR_CODES.VALIDATION,
      message: error.message,
      details: { code: error.code },
    };
  }
  if (error instanceof ExportCompletenessError) {
    return {
      exitCode: 1,
      errCode: ERROR_CODES.API,
      message: error.message,
      details: {
        code: error.code,
        affected: error.affected.map((a) => ({ id: a.id, title: a.title })),
      },
    };
  }
  if (error instanceof AssetBudgetExceededError) {
    return {
      exitCode: 1,
      errCode: ERROR_CODES.VALIDATION,
      message: error.message,
      details: {
        code: "asset-budget-exceeded",
        totalBytes: error.totalBytes,
        limitBytes: error.limitBytes,
        offenders: error.offenders.map((o) => ({ ...o })),
      },
    };
  }
  if (error instanceof PaginationLoopError) {
    return {
      exitCode: 1,
      errCode: ERROR_CODES.API,
      message:
        `${error.message} This usually indicates a Confluence server pagination bug; ` +
        `re-run, and report the issue if it persists.`,
      details: { code: error.code, token: error.token },
    };
  }
  if (isAbortError(error)) {
    return {
      exitCode: 130,
      errCode: ERROR_CODES.IO,
      message: "Export cancelled.",
      details: { code: "cancelled" },
    };
  }
  // Catch-all: any unexpected error still becomes ONE structured document.
  const message = error instanceof Error ? error.message : String(error);
  return {
    exitCode: 1,
    errCode: ERROR_CODES.API,
    message: `Export failed: ${message}`,
    details: {
      code: "unexpected-error",
      ...(error instanceof Error ? { name: error.name } : {}),
    },
  };
}
