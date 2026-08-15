#!/usr/bin/env bun
/**
 * Nightly **recovery** sweeper for live E2E residue (spec 011 "E2E resource
 * discipline").
 *
 * This is not the primary cleanup mechanism. Every E2E test deletes what it
 * created in a `finally` block ({@link withE2eResources} in `./resources.ts`),
 * so the tenant is already clean after a normal run. This script exists for the
 * abnormal ones: a crashed process, a killed CI job, a machine that went away
 * mid-test.
 *
 * ## Safety design
 *
 * The sweeper deletes real customer-visible content, so it is built to be
 * *structurally* incapable of deleting anything it cannot prove it owns. Four
 * independent gates, each covered by a test in `./cleanup.test.ts`:
 *
 *  1. **Marker required.** A resource is only ever a deletion target if it
 *     carries the `atlcli-e2e-run-id` property. The name is not evidence.
 *     Enforced in the type system: {@link planSweep} only ever emits
 *     {@link SweepTarget}s, whose `runId` is a required `string`, and
 *     {@link executeSweep} accepts nothing else — an unmarked
 *     {@link SweepCandidate} cannot be passed to the deleter without a type
 *     error, and {@link assertSweepable} re-runs every gate at the delete site.
 *  2. **TTL honored.** Resources younger than 24 h are never touched, so a
 *     currently-running E2E is never swept out from under itself. `--ttl-hours`
 *     can raise this but never lower it below {@link MIN_TTL_HOURS}.
 *  3. **Dry-run by default.** Without `--force` the script only prints what it
 *     *would* delete and performs zero deletions.
 *  4. **Scope locked.** Only space `DOCSY` and project `ATLCLI`, hardcoded with
 *     no CLI override; records from any other scope are dropped by the planner.
 *
 * Plus a **max-delete circuit breaker** ({@link DEFAULT_MAX_DELETES}): if the
 * plan selects more than that, the whole sweep aborts fail-closed with a
 * non-zero exit and *zero* deletions, rather than letting a bad query quietly
 * empty the space. `--max-deletes` can lower it but never raise it.
 *
 * What protects the deliberately retained DOCSY fixtures (the DOCX feature zoo,
 * the spec-005 logo/image page, the "M1 Abnahme …" set) is the **naming gate**:
 * their titles do not parse as `atlcli-e2e-<feature>-<timestamp>`, so they are
 * rejected even if something stamps a valid-looking marker on them. That is a
 * structural property of their names, not the contingent fact that they happen
 * to be unmarked today.
 *
 * Note what is NOT covered: `--profile` selects the *tenant*. The DOCSY/ATLCLI
 * lock constrains which space and project get swept, not which site.
 *
 * @example
 * ```bash
 * bun apps/cli/src/e2e/cleanup.ts              # dry run — lists, deletes nothing
 * bun apps/cli/src/e2e/cleanup.ts --force      # actually deletes
 * ```
 *
 * @module
 */

import { getActiveProfile, loadConfig, type Config, type Profile } from "@atlcli/core";
import {
  E2E_PROJECT_KEY,
  E2E_SPACE_KEY,
  E2E_TTL_MS,
  parseE2eTitle,
  type E2eConfluencePort,
  type E2eIssueRecord,
  type E2eJiraPort,
  type E2ePageRecord,
} from "./resources.js";

/**
 * Max resources a single sweep may delete before it aborts fail-closed.
 *
 * Also the hard ceiling: `--max-deletes` may lower it, never raise it.
 */
export const DEFAULT_MAX_DELETES = 50;

/** Floor for `--ttl-hours`. The TTL gate can be widened but never switched off. */
export const MIN_TTL_HOURS = 1;

/** Default profile the sweeper authenticates with. */
export const DEFAULT_PROFILE = "mayflower";

/** A resource the sweeper is *considering*. `runId` may be absent — that is the point. */
export interface SweepCandidate {
  /** Confluence page ID or Jira issue key. */
  id: string;
  /** Page title or issue summary. */
  name: string;
  /** Confluence space key or Jira project key. */
  scope: string;
  /** Value of the ownership marker property, if the resource carries one. */
  runId?: string;
}

/**
 * A candidate that has passed every gate.
 *
 * The required `runId` is load-bearing: it is what makes it impossible to hand
 * an unmarked resource to {@link executeSweep}.
 */
export interface SweepTarget extends SweepCandidate {
  runId: string;
}

/** Why a candidate was not selected. Ordered by the check that rejected it. */
export type SweepSkipReason = "wrong-scope" | "name-mismatch" | "no-marker" | "within-ttl";

export interface SweepSkip {
  candidate: SweepCandidate;
  reason: SweepSkipReason;
}

export interface SweepPlan {
  kind: "page" | "issue";
  scope: string;
  targets: SweepTarget[];
  skipped: SweepSkip[];
  maxDeletes: number;
  /** True when `targets` exceeded `maxDeletes`. The sweep must then delete nothing. */
  circuitBreakerTripped: boolean;
  /**
   * The gate inputs this plan was built with, carried so the executor can
   * independently re-verify every target immediately before deleting it
   * (see {@link assertSweepable}) instead of trusting the plan it was handed.
   */
  now: number;
  ttlMs: number;
}

export interface PlanSweepOptions {
  /** The one scope this sweep is allowed to touch. */
  scope: string;
  /** Current time in ms since epoch. */
  now: number;
  ttlMs?: number;
  maxDeletes?: number;
}

/** Project a Confluence page record onto the scope-agnostic candidate shape. */
export function toPageCandidate(page: E2ePageRecord): SweepCandidate {
  return { id: page.id, name: page.title, scope: page.spaceKey, runId: page.runId };
}

/** Project a Jira issue record onto the scope-agnostic candidate shape. */
export function toIssueCandidate(issue: E2eIssueRecord): SweepCandidate {
  return { id: issue.key, name: issue.summary, scope: issue.projectKey, runId: issue.runId };
}

/**
 * Decide whether a single candidate may be deleted.
 *
 * @returns The reason it may not, or `null` when every gate passes.
 */
export function classifyCandidate(
  candidate: SweepCandidate,
  options: { scope: string; now: number; ttlMs: number }
): SweepSkipReason | null {
  // Gate 4 — scope lock. An unknown/absent scope fails closed.
  if (candidate.scope !== options.scope) return "wrong-scope";

  // Naming convention. Human-authored titles stop here.
  const parsed = parseE2eTitle(candidate.name);
  if (!parsed) return "name-mismatch";

  // Gate 1 — the ownership marker. The only actual proof of ownership.
  if (typeof candidate.runId !== "string" || candidate.runId.trim() === "") return "no-marker";

  // Gate 2 — TTL. Never delete a resource a live run may still be using.
  // "older than the TTL" is strict: at exactly the TTL the resource is still
  // protected, so the boundary rounds towards keeping content.
  const ageMs = options.now - parsed.timestampSeconds * 1000;
  if (ageMs <= options.ttlMs) return "within-ttl";

  return null;
}

/**
 * Turn a candidate list into a deletion plan.
 *
 * Pure: no IO, fully unit-testable, and the only way to produce a
 * {@link SweepTarget}.
 */
export function planSweep(
  kind: "page" | "issue",
  candidates: SweepCandidate[],
  options: PlanSweepOptions
): SweepPlan {
  const ttlMs = options.ttlMs ?? E2E_TTL_MS;
  const maxDeletes = options.maxDeletes ?? DEFAULT_MAX_DELETES;

  const targets: SweepTarget[] = [];
  const skipped: SweepSkip[] = [];

  for (const candidate of candidates) {
    const reason = classifyCandidate(candidate, { scope: options.scope, now: options.now, ttlMs });
    if (reason) {
      skipped.push({ candidate, reason });
      continue;
    }
    // Safe: `classifyCandidate` returning null proves runId is a non-empty string.
    targets.push({ ...candidate, runId: candidate.runId as string });
  }

  return {
    kind,
    scope: options.scope,
    targets,
    skipped,
    maxDeletes,
    circuitBreakerTripped: targets.length > maxDeletes,
    now: options.now,
    ttlMs,
  };
}

/**
 * Re-run **every** gate against a target immediately before it is deleted.
 *
 * The type system already stops an unmarked candidate from reaching the
 * deleter, and in the shipped flow `runSweep` always builds its plan through
 * {@link planSweep}. This is the last line of defence for the case neither
 * covers: a caller hand-assembling a `SweepTarget` (or casting one together)
 * and passing it to {@link executeSweep} directly.
 *
 * Deliberately a full re-classification rather than a marker check. Checking
 * only the marker would let a forged `runId` on an off-convention name — a
 * deliberately retained fixture, say — through the final gate, which is exactly
 * the claim this module's header makes about being structurally incapable of
 * deleting content it does not own.
 */
export function assertSweepable(
  target: SweepTarget,
  options: { scope: string; now: number; ttlMs: number }
): void {
  const reason = classifyCandidate(target, options);
  if (reason) {
    throw new Error(
      `Refusing to delete ${target.id} ("${target.name}"): ${reason}. ` +
        "The sweeper only deletes resources that pass every gate at the moment of deletion."
    );
  }
}

export interface SweepExecution {
  /** Empty on a dry run. */
  deleted: string[];
  /** Populated on a dry run: what `--force` would have removed. */
  wouldDelete: string[];
  failures: Array<{ id: string; error: string }>;
  aborted: boolean;
}

/**
 * Execute (or, without `force`, merely report) a plan.
 *
 * A tripped circuit breaker aborts before the first deletion — not after the
 * 50th. Nothing is deleted at all.
 */
export async function executeSweep(input: {
  plan: SweepPlan;
  force: boolean;
  deleteResource: (target: SweepTarget) => Promise<void>;
  log?: (message: string) => void;
}): Promise<SweepExecution> {
  const { plan, force, deleteResource } = input;
  const log = input.log ?? (() => {});
  const ids = plan.targets.map((t) => t.id);

  if (plan.circuitBreakerTripped) {
    log(
      `ABORT: ${plan.targets.length} ${plan.kind}(s) selected exceeds the max-delete circuit breaker ` +
        `(${plan.maxDeletes}). No resources were deleted. Investigate before re-running.`
    );
    return { deleted: [], wouldDelete: ids, failures: [], aborted: true };
  }

  if (!force) {
    log(`DRY RUN: would delete ${ids.length} ${plan.kind}(s) in ${plan.scope}. Pass --force to delete.`);
    for (const target of plan.targets) {
      log(`  would delete ${plan.kind} ${target.id} "${target.name}" (run ${target.runId})`);
    }
    return { deleted: [], wouldDelete: ids, failures: [], aborted: false };
  }

  const deleted: string[] = [];
  const failures: Array<{ id: string; error: string }> = [];
  for (const target of plan.targets) {
    assertSweepable(target, { scope: plan.scope, now: plan.now, ttlMs: plan.ttlMs });
    try {
      await deleteResource(target);
      deleted.push(target.id);
      log(`deleted ${plan.kind} ${target.id} "${target.name}" (run ${target.runId})`);
    } catch (error) {
      failures.push({ id: target.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { deleted, wouldDelete: [], failures, aborted: false };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface SweeperArgs {
  force: boolean;
  profile: string;
  ttlMs: number;
  maxDeletes: number;
}

/**
 * Parse sweeper flags.
 *
 * Deliberately offers **no** space/project override: the scope lock is not
 * something an operator can widen from the command line.
 *
 * @throws On any unrecognized or malformed argument — fail closed rather than
 *   silently ignoring a typo on a destructive command.
 */
export function parseSweeperArgs(argv: string[]): SweeperArgs {
  const args: SweeperArgs = {
    force: false,
    profile: DEFAULT_PROFILE,
    ttlMs: E2E_TTL_MS,
    maxDeletes: DEFAULT_MAX_DELETES,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--force") {
      args.force = true;
    } else if (arg === "--dry-run") {
      args.force = false;
    } else if (arg === "--profile") {
      const value = argv[++i];
      if (!value) throw new Error("--profile requires a value");
      args.profile = value;
    } else if (arg.startsWith("--profile=")) {
      args.profile = arg.slice("--profile=".length);
    } else if (arg === "--ttl-hours" || arg.startsWith("--ttl-hours=")) {
      const raw = arg.startsWith("--ttl-hours=") ? arg.slice("--ttl-hours=".length) : argv[++i];
      const hours = Number(raw);
      // Floored, not merely non-negative. `--ttl-hours 0` used to disable the
      // TTL gate outright, which would delete a resource a *different*, still
      // running E2E had created seconds earlier — the precise scenario the TTL
      // exists to prevent. The flag may only ever make the sweep more patient.
      if (!Number.isFinite(hours) || hours < MIN_TTL_HOURS) {
        throw new Error(`--ttl-hours must be at least ${MIN_TTL_HOURS} (the TTL gate cannot be disabled), got: ${raw}`);
      }
      args.ttlMs = hours * 60 * 60 * 1000;
    } else if (arg === "--max-deletes" || arg.startsWith("--max-deletes=")) {
      const raw = arg.startsWith("--max-deletes=") ? arg.slice("--max-deletes=".length) : argv[++i];
      const max = Number(raw);
      if (!Number.isInteger(max) || max < 0) throw new Error(`--max-deletes requires a non-negative integer, got: ${raw}`);
      // Clamped in one direction only: lowering the breaker is a legitimate way
      // to be extra careful, raising it defeats the point. Raising it is also
      // the obvious reflex right after seeing an abort — i.e. exactly when the
      // breaker is doing its job and a bad query is the likeliest explanation.
      if (max > DEFAULT_MAX_DELETES) {
        throw new Error(
          `--max-deletes may not exceed the ${DEFAULT_MAX_DELETES}-resource circuit breaker (got ${max}). ` +
            "If a sweep legitimately needs to remove more, run it repeatedly rather than raising the limit."
        );
      }
      args.maxDeletes = max;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

export function sweeperHelp(): string {
  return [
    "Usage: bun apps/cli/src/e2e/cleanup.ts [options]",
    "",
    "Recovery sweeper for live E2E residue. Deletes ONLY resources that carry the",
    `atlcli-e2e-run-id ownership marker, follow the atlcli-e2e-<feature>-<timestamp>`,
    `naming convention, are older than the TTL, and live in space ${E2E_SPACE_KEY} /`,
    `project ${E2E_PROJECT_KEY}. Dry run unless --force is given.`,
    "",
    "Options:",
    "  --force               Actually delete (default: dry run, deletes nothing)",
    `  --profile <name>      Profile to authenticate with (default: ${DEFAULT_PROFILE})`,
    `  --ttl-hours <n>       Minimum resource age before sweeping (default: 24, minimum ${MIN_TTL_HOURS});`,
    "                        may only be raised — the TTL gate cannot be disabled",
    `  --max-deletes <n>     Circuit breaker; abort if more are selected (default and`,
    `                        maximum ${DEFAULT_MAX_DELETES}); may only be lowered`,
    "  --help, -h            Show this help",
    "",
    `WARNING: --profile (and the ATLCLI_BASE_URL fallback) selects the TENANT. The`,
    `${E2E_SPACE_KEY}/${E2E_PROJECT_KEY} name lock constrains which space and project are`,
    "swept, NOT which site — point this at the wrong instance and it will happily",
    `sweep that instance's ${E2E_SPACE_KEY}.`,
  ].join("\n");
}

/**
 * Run a full sweep against the given ports.
 *
 * @returns A process exit code: 0 clean, 1 deletion failures, 2 circuit breaker tripped.
 */
export async function runSweep(input: {
  confluence?: E2eConfluencePort;
  jira?: E2eJiraPort;
  args: Pick<SweeperArgs, "force" | "ttlMs" | "maxDeletes">;
  now?: number;
  log?: (message: string) => void;
}): Promise<number> {
  const log = input.log ?? ((message: string) => console.log(message));
  const now = input.now ?? Date.now();
  const { force, ttlMs, maxDeletes } = input.args;

  const plans: SweepPlan[] = [];
  const deleters = new Map<SweepPlan, (target: SweepTarget) => Promise<void>>();

  if (input.confluence) {
    const pages = await input.confluence.listPages(E2E_SPACE_KEY);
    const plan = planSweep("page", pages.map(toPageCandidate), {
      scope: E2E_SPACE_KEY,
      now,
      ttlMs,
      maxDeletes,
    });
    plans.push(plan);
    deleters.set(plan, (target) => input.confluence!.deletePage(target.id));
  }

  if (input.jira) {
    const issues = await input.jira.listIssues(E2E_PROJECT_KEY);
    const plan = planSweep("issue", issues.map(toIssueCandidate), {
      scope: E2E_PROJECT_KEY,
      now,
      ttlMs,
      maxDeletes,
    });
    plans.push(plan);
    deleters.set(plan, (target) => input.jira!.deleteIssue(target.id));
  }

  for (const plan of plans) {
    const bySkipReason = new Map<SweepSkipReason, number>();
    for (const skip of plan.skipped) {
      bySkipReason.set(skip.reason, (bySkipReason.get(skip.reason) ?? 0) + 1);
    }
    const breakdown = [...bySkipReason.entries()].map(([reason, count]) => `${reason}=${count}`).join(", ");
    log(
      `[${plan.kind}] ${plan.scope}: ${plan.targets.length} sweepable, ${plan.skipped.length} protected` +
        (breakdown ? ` (${breakdown})` : "")
    );
  }

  // Fail closed across the whole sweep: if ANY plan tripped, delete nothing at all.
  if (plans.some((plan) => plan.circuitBreakerTripped)) {
    for (const plan of plans) {
      await executeSweep({ plan, force: false, deleteResource: async () => {}, log });
    }
    log("Circuit breaker tripped — aborting the entire sweep without deleting anything.");
    return 2;
  }

  let failures = 0;
  for (const plan of plans) {
    const result = await executeSweep({
      plan,
      force,
      deleteResource: deleters.get(plan)!,
      log,
    });
    failures += result.failures.length;
    for (const failure of result.failures) {
      log(`FAILED to delete ${plan.kind} ${failure.id}: ${failure.error}`);
    }
  }

  return failures > 0 ? 1 : 0;
}

/**
 * Resolve the profile the sweeper authenticates with.
 *
 * Prefers a configured profile (the local-agent case, profile `mayflower`).
 * Falls back to an ephemeral profile built from `ATLCLI_*` env vars so CI can
 * pass repo secrets straight through the environment instead of writing
 * credentials to `~/.atlcli/config.json` on a shared runner.
 *
 * @returns The profile, or `null` when neither source is configured.
 */
export function resolveSweeperProfile(
  config: Config,
  profileName: string,
  env: Record<string, string | undefined> = process.env
): Profile | null {
  const configured = getActiveProfile(config, profileName);
  if (configured) return configured;

  const baseUrl = env.ATLCLI_BASE_URL?.trim();
  if (!baseUrl) return null;

  const authType = env.ATLCLI_AUTH_TYPE?.trim() === "bearer" ? "bearer" : "apiToken";
  return {
    name: profileName,
    baseUrl,
    // The token itself is read by `resolveToken`, which already prefers
    // ATLCLI_API_TOKEN over anything stored — it is never placed here.
    auth: authType === "bearer" ? { type: "bearer" } : { type: "apiToken", email: env.ATLCLI_EMAIL?.trim() },
  };
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(sweeperHelp());
    return 0;
  }

  let args: SweeperArgs;
  try {
    args = parseSweeperArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(sweeperHelp());
    return 1;
  }

  const config = await loadConfig();
  const profile = resolveSweeperProfile(config, args.profile);
  if (!profile) {
    console.error(
      `Profile '${args.profile}' is not configured, and no ATLCLI_BASE_URL fallback is set. ` +
        "Run `atlcli auth login` or export ATLCLI_BASE_URL / ATLCLI_EMAIL / ATLCLI_API_TOKEN."
    );
    return 1;
  }

  // Imported lazily so the pure planner stays importable (and unit-testable)
  // without dragging in the REST clients.
  const { createConfluencePort, createJiraPort } = await import("./rest-ports.js");

  return runSweep({
    confluence: createConfluencePort(profile),
    jira: createJiraPort(profile),
    args,
  });
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
