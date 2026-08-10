import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProofModeContractError,
  selectProofMode,
  validateAggregateProof,
  validateMergeReady,
  type PullRequestSnapshotInput,
} from "./proof-mode.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

function pullRequestInput(options: {
  eventDraft: boolean;
  currentDraft?: boolean;
  eventHeadSha?: string;
  currentHeadSha?: string;
  currentPullRequest?: PullRequestSnapshotInput;
}) {
  return {
    eventName: "pull_request",
    eventHeadSha: options.eventHeadSha ?? HEAD_A,
    eventPullRequest: { number: 139, draft: options.eventDraft },
    currentPullRequest: options.currentPullRequest ?? {
      number: 139,
      headSha: options.currentHeadSha ?? HEAD_A,
      draft: options.currentDraft ?? options.eventDraft,
    },
  };
}

describe("CI proof mode", () => {
  test("selects draft-fast only when event and current PR agree on the current draft head", () => {
    expect(selectProofMode(pullRequestInput({ eventDraft: true }))).toMatchObject({
      mode: "draft-fast",
      aggregateStatusName: "draft-fast",
      reason: "verified-draft",
      eventHeadSha: HEAD_A,
      validatedHeadSha: HEAD_A,
      pullRequestNumber: 139,
    });
  });

  test("selects required for a verified ready PR", () => {
    expect(selectProofMode(pullRequestInput({ eventDraft: false }))).toMatchObject({
      mode: "required",
      aggregateStatusName: "required",
      reason: "verified-ready",
    });
  });

  test("classifies an event for an old PR head as superseded", () => {
    expect(
      selectProofMode(
        pullRequestInput({
          eventDraft: false,
          currentHeadSha: HEAD_B,
        }),
      ),
    ).toMatchObject({
      mode: "superseded",
      aggregateStatusName: "superseded",
      reason: "head-superseded",
      eventHeadSha: HEAD_A,
      validatedHeadSha: HEAD_B,
    });
  });

  test("fails closed to required when event and current draft state disagree", () => {
    for (const [eventDraft, currentDraft] of [
      [true, false],
      [false, true],
    ] as const) {
      expect(
        selectProofMode(pullRequestInput({ eventDraft, currentDraft })),
      ).toMatchObject({
        mode: "required",
        aggregateStatusName: "required",
        reason: "draft-state-disagrees",
      });
    }
  });

  test("requires full proof for push, schedule, dispatch, and merge-group events", () => {
    for (const eventName of [
      "push",
      "schedule",
      "workflow_dispatch",
      "merge_group",
    ] as const) {
      expect(
        selectProofMode({ eventName, eventHeadSha: HEAD_A }),
      ).toMatchObject({
        eventName,
        mode: "required",
        aggregateStatusName: "required",
        reason: "non-pr-full-proof",
        validatedHeadSha: HEAD_A,
      });
    }
  });

  test("rejects missing or malformed current PR identity and draft state", () => {
    for (const currentPullRequest of [
      undefined,
      { number: 139, headSha: "short", draft: true },
      { number: 139, headSha: HEAD_A, draft: "true" },
      { number: 140, headSha: HEAD_A, draft: true },
    ]) {
      expect(() =>
        selectProofMode({
          ...pullRequestInput({ eventDraft: true }),
          currentPullRequest,
        }),
      ).toThrow(ProofModeContractError);
    }

    expect(() =>
      selectProofMode({ eventName: "repository_dispatch", eventHeadSha: HEAD_A }),
    ).toThrow("unsupported proof event");
  });

  test("validates the exact aggregate status selected by each mode", () => {
    const draft = selectProofMode(pullRequestInput({ eventDraft: true }));
    const superseded = selectProofMode(
      pullRequestInput({ eventDraft: false, currentHeadSha: HEAD_B }),
    );
    const required = selectProofMode(pullRequestInput({ eventDraft: false }));

    expect(validateAggregateProof(draft, { name: "draft-fast", conclusion: "success" })).toEqual({
      mode: "draft-fast",
      statusName: "draft-fast",
      conclusion: "success",
    });
    expect(
      validateAggregateProof(superseded, { name: "superseded", conclusion: "success" }),
    ).toMatchObject({ mode: "superseded", statusName: "superseded" });
    expect(validateAggregateProof(required, { name: "required", conclusion: "success" })).toMatchObject({
      mode: "required",
      statusName: "required",
    });

    expect(() =>
      validateAggregateProof(draft, { name: "required", conclusion: "success" }),
    ).toThrow("does not match selected proof mode");
    expect(() =>
      validateAggregateProof(required, { name: "required", conclusion: "failure" }),
    ).toThrow("is not successful");
  });

  test("accepts a full successful proof for the same ready PR head as merge-ready", () => {
    const decision = selectProofMode(pullRequestInput({ eventDraft: false }));
    expect(
      validateMergeReady({
        decision,
        aggregate: { name: "required", conclusion: "success" },
        currentPullRequest: { number: 139, headSha: HEAD_A, draft: false },
      }),
    ).toEqual({
      eventName: "pull_request",
      headSha: HEAD_A,
      pullRequestNumber: 139,
      aggregateStatusName: "required",
      mergeReady: true,
    });
  });

  test("rejects draft, superseded, changed-head, re-drafted, and failed proof as merge-ready", () => {
    const draftDecision = selectProofMode(pullRequestInput({ eventDraft: true }));
    const supersededDecision = selectProofMode(
      pullRequestInput({ eventDraft: false, currentHeadSha: HEAD_B }),
    );
    const requiredDecision = selectProofMode(pullRequestInput({ eventDraft: false }));

    expect(() =>
      validateMergeReady({
        decision: draftDecision,
        aggregate: { name: "draft-fast", conclusion: "success" },
      }),
    ).toThrow("is not merge-ready");
    expect(() =>
      validateMergeReady({
        decision: supersededDecision,
        aggregate: { name: "superseded", conclusion: "success" },
      }),
    ).toThrow("is not merge-ready");
    expect(() =>
      validateMergeReady({
        decision: requiredDecision,
        aggregate: { name: "required", conclusion: "success" },
        currentPullRequest: { number: 139, headSha: HEAD_B, draft: false },
      }),
    ).toThrow("head has superseded");
    expect(() =>
      validateMergeReady({
        decision: requiredDecision,
        aggregate: { name: "required", conclusion: "success" },
        currentPullRequest: { number: 139, headSha: HEAD_A, draft: true },
      }),
    ).toThrow("still a draft");
    expect(() =>
      validateMergeReady({
        decision: requiredDecision,
        aggregate: { name: "required", conclusion: "failure" },
        currentPullRequest: { number: 139, headSha: HEAD_A, draft: false },
      }),
    ).toThrow("is not successful");
  });

  test("accepts merge-group required proof but never treats push or dispatch as merge-ready", () => {
    const mergeGroup = selectProofMode({
      eventName: "merge_group",
      eventHeadSha: HEAD_A,
    });
    expect(
      validateMergeReady({
        decision: mergeGroup,
        aggregate: { name: "required", conclusion: "success" },
      }),
    ).toMatchObject({
      eventName: "merge_group",
      headSha: HEAD_A,
      aggregateStatusName: "required",
      mergeReady: true,
    });

    for (const eventName of ["push", "schedule", "workflow_dispatch"] as const) {
      const decision = selectProofMode({ eventName, eventHeadSha: HEAD_A });
      expect(() =>
        validateMergeReady({
          decision,
          aggregate: { name: "required", conclusion: "success" },
        }),
      ).toThrow("is not a merge-ready candidate");
    }
  });

  test("CLI appends validated proof-mode fields to GITHUB_OUTPUT", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlcli-proof-mode-"));
    const outputPath = join(directory, "github-output");
    try {
      const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "proof-mode.ts")], {
        env: {
          ...process.env,
          CI_EVENT_NAME: "pull_request",
          CI_EVENT_HEAD_SHA: HEAD_A,
          CI_EVENT_PR_NUMBER: "139",
          CI_EVENT_PR_DRAFT: "true",
          CI_CURRENT_PR_NUMBER: "139",
          CI_CURRENT_PR_HEAD_SHA: HEAD_A,
          CI_CURRENT_PR_DRAFT: "true",
          GITHUB_OUTPUT: outputPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(await readFile(outputPath, "utf8")).toBe(
        [
          "mode=draft-fast",
          "aggregateStatusName=draft-fast",
          "reason=verified-draft",
          `eventHeadSha=${HEAD_A}`,
          `validatedHeadSha=${HEAD_A}`,
          "pullRequestNumber=139",
          "",
        ].join("\n"),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("CLI exits non-zero instead of accepting malformed live draft state", () => {
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "proof-mode.ts")], {
      env: {
        ...process.env,
        CI_EVENT_NAME: "pull_request",
        CI_EVENT_HEAD_SHA: HEAD_A,
        CI_EVENT_PR_NUMBER: "139",
        CI_EVENT_PR_DRAFT: "true",
        CI_CURRENT_PR_NUMBER: "139",
        CI_CURRENT_PR_HEAD_SHA: HEAD_A,
        CI_CURRENT_PR_DRAFT: "yes",
        GITHUB_OUTPUT: join(tmpdir(), "must-not-be-written-proof-mode-output"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("current pull request draft state must be a boolean");
  });
});
