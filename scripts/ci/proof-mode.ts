/**
 * Pure policy for selecting and validating the amount of CI proof a run owes.
 *
 * A pull-request event is not authoritative after it has been queued. Callers
 * must provide a freshly fetched pull-request snapshot both when selecting the
 * proof mode and before accepting a run as merge-ready. Missing or malformed
 * state is a contract failure; it must never silently select the cheap lane.
 */

import { appendFile } from "node:fs/promises";

export type ProofEventName =
  | "pull_request"
  | "push"
  | "schedule"
  | "workflow_dispatch"
  | "merge_group";

export type ProofMode = "draft-fast" | "superseded" | "required";
export type AggregateStatusName = ProofMode;

export interface PullRequestEventInput {
  number: unknown;
  draft: unknown;
}

export interface PullRequestSnapshotInput {
  number: unknown;
  headSha: unknown;
  draft: unknown;
}

export interface SelectProofModeInput {
  eventName: unknown;
  eventHeadSha: unknown;
  eventPullRequest?: unknown;
  currentPullRequest?: unknown;
}

export interface ProofModeDecision {
  eventName: ProofEventName;
  eventHeadSha: string;
  validatedHeadSha: string;
  pullRequestNumber: number | null;
  mode: ProofMode;
  aggregateStatusName: AggregateStatusName;
  reason:
    | "verified-draft"
    | "verified-ready"
    | "head-superseded"
    | "draft-state-disagrees"
    | "non-pr-full-proof";
}

export interface AggregateProofInput {
  name: unknown;
  conclusion: unknown;
}

export interface ValidatedAggregateProof {
  mode: ProofMode;
  statusName: AggregateStatusName;
  conclusion: "success";
}

export interface ValidateMergeReadyInput {
  decision: ProofModeDecision;
  aggregate: AggregateProofInput;
  currentPullRequest?: unknown;
}

export interface MergeReadyProof {
  eventName: "pull_request" | "merge_group";
  headSha: string;
  pullRequestNumber: number | null;
  aggregateStatusName: "required";
  mergeReady: true;
}

interface PullRequestEvent {
  number: number;
  draft: boolean;
}

interface PullRequestSnapshot extends PullRequestEvent {
  headSha: string;
}

const EVENT_NAMES = new Set<ProofEventName>([
  "pull_request",
  "push",
  "schedule",
  "workflow_dispatch",
  "merge_group",
]);
const STATUS_NAMES = new Set<AggregateStatusName>([
  "draft-fast",
  "superseded",
  "required",
]);
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export class ProofModeContractError extends Error {
  override readonly name = "ProofModeContractError";
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProofModeContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function eventName(value: unknown): ProofEventName {
  if (typeof value !== "string" || !EVENT_NAMES.has(value as ProofEventName)) {
    throw new ProofModeContractError(`unsupported proof event: ${String(value)}`);
  }
  return value as ProofEventName;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw new ProofModeContractError(`${label} must be a 40-character commit SHA`);
  }
  return value.toLowerCase();
}

function pullRequestNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ProofModeContractError(`${label} must be a positive integer`);
  }
  return value;
}

function draft(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new ProofModeContractError(`${label} must be a boolean`);
  }
  return value;
}

function parsePullRequestEvent(value: unknown): PullRequestEvent {
  const input = record(value, "event pull request");
  return {
    number: pullRequestNumber(input.number, "event pull request number"),
    draft: draft(input.draft, "event pull request draft state"),
  };
}

function parsePullRequestSnapshot(value: unknown, label: string): PullRequestSnapshot {
  const input = record(value, label);
  return {
    number: pullRequestNumber(input.number, `${label} number`),
    headSha: sha(input.headSha, `${label} head SHA`),
    draft: draft(input.draft, `${label} draft state`),
  };
}

/** Selects exactly one stable aggregate status for a CI run. */
export function selectProofMode(input: SelectProofModeInput): ProofModeDecision {
  const name = eventName(input.eventName);
  const eventHeadSha = sha(input.eventHeadSha, "event head SHA");

  if (name !== "pull_request") {
    return {
      eventName: name,
      eventHeadSha,
      validatedHeadSha: eventHeadSha,
      pullRequestNumber: null,
      mode: "required",
      aggregateStatusName: "required",
      reason: "non-pr-full-proof",
    };
  }

  const eventPr = parsePullRequestEvent(input.eventPullRequest);
  const currentPr = parsePullRequestSnapshot(input.currentPullRequest, "current pull request");
  if (eventPr.number !== currentPr.number) {
    throw new ProofModeContractError(
      `current pull request number ${currentPr.number} does not match event pull request ${eventPr.number}`,
    );
  }

  if (eventHeadSha !== currentPr.headSha) {
    return {
      eventName: name,
      eventHeadSha,
      validatedHeadSha: currentPr.headSha,
      pullRequestNumber: eventPr.number,
      mode: "superseded",
      aggregateStatusName: "superseded",
      reason: "head-superseded",
    };
  }

  if (eventPr.draft && currentPr.draft) {
    return {
      eventName: name,
      eventHeadSha,
      validatedHeadSha: currentPr.headSha,
      pullRequestNumber: eventPr.number,
      mode: "draft-fast",
      aggregateStatusName: "draft-fast",
      reason: "verified-draft",
    };
  }

  const draftStateDisagrees = eventPr.draft !== currentPr.draft;
  return {
    eventName: name,
    eventHeadSha,
    validatedHeadSha: currentPr.headSha,
    pullRequestNumber: eventPr.number,
    mode: "required",
    aggregateStatusName: "required",
    reason: draftStateDisagrees ? "draft-state-disagrees" : "verified-ready",
  };
}

/**
 * Validates the one aggregate check emitted by the chosen lane. A successful
 * stale or draft aggregate is intentionally not the same as merge readiness.
 */
export function validateAggregateProof(
  decision: ProofModeDecision,
  aggregate: AggregateProofInput,
): ValidatedAggregateProof {
  if (
    typeof aggregate.name !== "string" ||
    !STATUS_NAMES.has(aggregate.name as AggregateStatusName)
  ) {
    throw new ProofModeContractError(`unknown aggregate status: ${String(aggregate.name)}`);
  }
  if (aggregate.name !== decision.aggregateStatusName || aggregate.name !== decision.mode) {
    throw new ProofModeContractError(
      `aggregate status ${aggregate.name} does not match selected proof mode ${decision.mode}`,
    );
  }
  if (aggregate.conclusion !== "success") {
    throw new ProofModeContractError(
      `aggregate status ${aggregate.name} is not successful: ${String(aggregate.conclusion)}`,
    );
  }
  return {
    mode: decision.mode,
    statusName: aggregate.name as AggregateStatusName,
    conclusion: "success",
  };
}

/**
 * Produces a merge-ready receipt only for full proof on the current PR head or
 * for a fully proved merge-group candidate. PR state is fetched and checked a
 * second time to close the race between mode selection and final aggregation.
 */
export function validateMergeReady(input: ValidateMergeReadyInput): MergeReadyProof {
  const aggregate = validateAggregateProof(input.decision, input.aggregate);
  if (aggregate.mode !== "required") {
    throw new ProofModeContractError(
      `${aggregate.statusName} proof is successful but is not merge-ready`,
    );
  }

  if (input.decision.eventName === "merge_group") {
    return {
      eventName: "merge_group",
      headSha: input.decision.validatedHeadSha,
      pullRequestNumber: null,
      aggregateStatusName: "required",
      mergeReady: true,
    };
  }

  if (input.decision.eventName !== "pull_request") {
    throw new ProofModeContractError(
      `${input.decision.eventName} proof is not a merge-ready candidate`,
    );
  }

  const currentPr = parsePullRequestSnapshot(
    input.currentPullRequest,
    "final current pull request",
  );
  if (currentPr.number !== input.decision.pullRequestNumber) {
    throw new ProofModeContractError("final pull request number does not match selected proof");
  }
  if (currentPr.headSha !== input.decision.eventHeadSha) {
    throw new ProofModeContractError("final pull request head has superseded selected proof");
  }
  if (currentPr.draft) {
    throw new ProofModeContractError("final pull request is still a draft");
  }

  return {
    eventName: "pull_request",
    headSha: currentPr.headSha,
    pullRequestNumber: currentPr.number,
    aggregateStatusName: "required",
    mergeReady: true,
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new ProofModeContractError(`${name} is required`);
  }
  return value;
}

function environmentNumber(name: string): unknown {
  const value = requiredEnvironment(name);
  return /^\d+$/.test(value) ? Number(value) : value;
}

function environmentBoolean(name: string): unknown {
  const value = requiredEnvironment(name);
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

async function main(): Promise<void> {
  const ciEventName = requiredEnvironment("CI_EVENT_NAME");
  const pullRequest = ciEventName === "pull_request";
  const decision = selectProofMode({
    eventName: ciEventName,
    eventHeadSha: requiredEnvironment("CI_EVENT_HEAD_SHA"),
    eventPullRequest: pullRequest
      ? {
          number: environmentNumber("CI_EVENT_PR_NUMBER"),
          draft: environmentBoolean("CI_EVENT_PR_DRAFT"),
        }
      : undefined,
    currentPullRequest: pullRequest
      ? {
          number: environmentNumber("CI_CURRENT_PR_NUMBER"),
          headSha: requiredEnvironment("CI_CURRENT_PR_HEAD_SHA"),
          draft: environmentBoolean("CI_CURRENT_PR_DRAFT"),
        }
      : undefined,
  });
  const githubOutput = requiredEnvironment("GITHUB_OUTPUT");
  const outputs = [
    `mode=${decision.mode}`,
    `aggregateStatusName=${decision.aggregateStatusName}`,
    `reason=${decision.reason}`,
    `eventHeadSha=${decision.eventHeadSha}`,
    `validatedHeadSha=${decision.validatedHeadSha}`,
    `pullRequestNumber=${decision.pullRequestNumber ?? ""}`,
  ];
  await appendFile(githubOutput, `${outputs.join("\n")}\n`, "utf8");
}

if (import.meta.main) await main();
