import { describe, expect, test } from "bun:test";
import { assertReleaseProof, releaseProofBranch } from "./release-proof.js";

const SHA = "a".repeat(40);
const BRANCH = `codex/release-2026.10.1-${SHA.slice(0, 8)}`;
const RUN = {
  headSha: SHA, headBranch: BRANCH, event: "workflow_dispatch", status: "completed", conclusion: "success",
  jobs: [{ name: "required", status: "completed", conclusion: "success" }],
};

describe("protected-main release proof", () => {
  test("uses a commit-bound preparation branch and rejects unsafe identities", () => {
    expect(releaseProofBranch("2026.10.1", SHA)).toBe(BRANCH);
    expect(() => releaseProofBranch("2026.13.1", SHA)).toThrow();
    expect(() => releaseProofBranch("2026.10.1", "main")).toThrow();
  });

  test("accepts only the completed exact-SHA manual CI proof with required success", () => {
    expect(() => assertReleaseProof(SHA, BRANCH, RUN)).not.toThrow();
    for (const partial of [{ headSha: "b".repeat(40) }, { headBranch: "main" },
      { event: "pull_request" }, { status: "in_progress" }, { conclusion: "cancelled" }, { jobs: [] },
      { jobs: [{ name: "required", status: "completed", conclusion: "failure" }] },
      { jobs: [{ name: "required", status: "completed", conclusion: "skipped" }] }]) {
      expect(() => assertReleaseProof(SHA, BRANCH, { ...RUN, ...partial })).toThrow();
    }
    expect(() => assertReleaseProof(SHA, BRANCH, { ...RUN, jobs: [...RUN.jobs, ...RUN.jobs] })).toThrow();
  });

  test("an advisory failure does not override a successful required gate", () => {
    expect(() => assertReleaseProof(SHA, BRANCH, {
      ...RUN, conclusion: "failure", jobs: [...RUN.jobs,
        { name: "Non-required CI timing telemetry", status: "completed", conclusion: "failure" }],
    })).not.toThrow();
  });
});
