/**
 * veraPDF ratchet core (spec 011, PDF/UA). Pure functions over a parsed veraPDF
 * `--format json` report, so the ratchet logic is unit-tested with synthetic
 * payloads even when the veraPDF binary is absent (the binary integration is
 * the separate self-skipping `verapdf.ratchet.test.ts`).
 *
 * The baseline is keyed by `{fixture, ruleId}` and stores `{failureCount,
 * locationsDigest}` — NOT rule id alone, so a rule staying baselined while its
 * failure count RISES on the same fixture (a regression that adds instances
 * without adding a new rule) fails the job, not passes silently. The job fails
 * on any rule failure not in the baseline OR any baselined key whose count
 * increases; it warns when a baselined key starts passing (baseline shrinks
 * monotonically). Baseline changes are reviewed diffs.
 */
import { createHash } from "node:crypto";

export interface RuleFailure {
  fixture: string;
  ruleId: string;
  failureCount: number;
  locationsDigest: string;
}

export interface BaselineEntry {
  failureCount: number;
  locationsDigest: string;
}

/** Baseline keyed by `${fixture}::${ruleId}`. */
export type Baseline = Record<string, BaselineEntry>;

export function baselineKey(fixture: string, ruleId: string): string {
  return `${fixture}::${ruleId}`;
}

function digestLocations(contexts: string[]): string {
  return createHash("sha256").update([...contexts].sort().join("\n")).digest("hex").slice(0, 16);
}

/**
 * Parse veraPDF's `report.jobs[].validationResult[].details.ruleSummaries[]`
 * into failing-rule records for one fixture. Tolerant of shape drift across
 * veraPDF versions: it reads `ruleStatus === "FAILED"`, the `clause`/`testNumber`
 * rule id, `failedChecks`, and the failing checks' `context` locations.
 */
export function parseVeraPdfReport(json: unknown, fixture: string): RuleFailure[] {
  const out: RuleFailure[] = [];
  const report = (json as { report?: unknown }).report ?? json;
  const jobs = ((report as { jobs?: unknown[] }).jobs ?? []) as Array<Record<string, unknown>>;
  for (const job of jobs) {
    const results = ((job.validationResult as unknown[]) ?? []) as Array<Record<string, unknown>>;
    for (const result of results) {
      const details = (result.details ?? {}) as Record<string, unknown>;
      const summaries = ((details.ruleSummaries as unknown[]) ?? []) as Array<Record<string, unknown>>;
      for (const summary of summaries) {
        if (summary.ruleStatus !== "FAILED") continue;
        const clause = String(summary.clause ?? "?");
        const testNumber = String(summary.testNumber ?? "?");
        const ruleId = `${clause}-${testNumber}`;
        const failedChecks = Number(summary.failedChecks ?? 0);
        const checks = ((summary.checks as unknown[]) ?? []) as Array<Record<string, unknown>>;
        const contexts = checks
          .filter((c) => c.status === "FAILED" || c.status === undefined)
          .map((c) => String(c.context ?? ""));
        out.push({
          fixture,
          ruleId,
          failureCount: failedChecks || contexts.length,
          locationsDigest: digestLocations(contexts),
        });
      }
    }
  }
  return out;
}

export interface VeraPdfCompliance {
  compliant: boolean;
  profileNames: string[];
  validationResults: number;
}

/**
 * Parse the high-level compliance verdict while proving the report contains a
 * real validation result. Missing or inconclusive output is a hard error, not
 * success.
 */
export function parseVeraPdfCompliance(json: unknown): VeraPdfCompliance {
  const report = (json as { report?: unknown }).report ?? json;
  const jobs = ((report as { jobs?: unknown[] }).jobs ?? []) as Array<Record<string, unknown>>;
  const results = jobs.flatMap((job) =>
    ((job.validationResult as unknown[]) ?? []) as Array<Record<string, unknown>>
  );
  if (results.length === 0) {
    throw new Error("veraPDF report contains no validation result");
  }
  const verdicts = results.map((result) => result.compliant);
  if (verdicts.some((verdict) => typeof verdict !== "boolean")) {
    throw new Error("veraPDF report contains an inconclusive compliance result");
  }
  return {
    compliant: verdicts.every((verdict) => verdict === true),
    profileNames: results
      .map((result) => result.profileName)
      .filter((value): value is string => typeof value === "string"),
    validationResults: results.length,
  };
}

export interface RatchetResult {
  /** Hard failures — a new rule failure, or a rising count on a baselined rule. */
  failures: string[];
  /** Soft notices — a baselined rule now passing (the baseline should shrink). */
  warnings: string[];
}

/**
 * Compare the current failing rules against the baseline. `canary` failures are
 * handled by the caller (a distinct "veraPDF tool broken" signal) and should be
 * excluded from `current` here.
 */
export function ratchet(current: RuleFailure[], baseline: Baseline): RatchetResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const failure of current) {
    const key = baselineKey(failure.fixture, failure.ruleId);
    seen.add(key);
    const base = baseline[key];
    if (!base) {
      failures.push(
        `new veraPDF failure ${failure.ruleId} on "${failure.fixture}" (${failure.failureCount} instance(s)) is not in the baseline`,
      );
      continue;
    }
    if (failure.failureCount > base.failureCount) {
      failures.push(
        `veraPDF failure ${failure.ruleId} on "${failure.fixture}" rose from ${base.failureCount} to ${failure.failureCount} instance(s)`,
      );
    }
  }

  for (const key of Object.keys(baseline)) {
    if (!seen.has(key)) {
      warnings.push(`baselined veraPDF failure ${key} now passes — shrink the baseline (reviewed diff)`);
    }
  }

  return { failures, warnings };
}
