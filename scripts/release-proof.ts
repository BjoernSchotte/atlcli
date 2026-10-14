import { $ } from "bun";
import { assertCalverVersion } from "./release-version.js";

interface ProofRun {
  headSha: string;
  headBranch: string;
  event: string;
  status: string;
  conclusion: string | null;
  jobs: { name: string; status: string; conclusion: string | null }[];
}

export function releaseProofBranch(version: string, sourceSha: string): string {
  assertCalverVersion(version);
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error("Release proof requires a full source SHA");
  return `codex/release-${version}-${sourceSha.slice(0, 8)}`;
}

export function assertReleaseProof(sourceSha: string, branch: string, run: ProofRun): void {
  const required = run.jobs.filter((job) => job.name === "required");
  if (run.headSha !== sourceSha || run.headBranch !== branch || run.event !== "workflow_dispatch" ||
    run.status !== "completed" || !["success", "failure"].includes(run.conclusion ?? "") ||
    required.length !== 1 || required[0]!.status !== "completed" || required[0]!.conclusion !== "success") {
    throw new Error("Release commit does not have completed exact-SHA required CI proof");
  }
}

/** Prove the new version/changelog commit before the protected main+tag push. */
export async function proveReleaseCommit(version: string, sourceSha: string, cwd = process.cwd()): Promise<void> {
  const repository = "BjoernSchotte/atlcli";
  const branch = releaseProofBranch(version, sourceSha);
  console.log(`Proving release commit ${sourceSha} on ${branch}...`);
  await $`git -C ${cwd} push origin ${`${sourceSha}:refs/heads/${branch}`}`;
  const previous = await $`gh run list --repo ${repository} --workflow ci.yml --branch ${branch} --commit ${sourceSha} --event workflow_dispatch --limit 10 --json databaseId`.json() as { databaseId: number }[];
  const previousIds = new Set(previous.map((run) => run.databaseId));
  await $`gh workflow run ci.yml --repo ${repository} --ref ${branch}`;

  let runId: number | undefined;
  for (let attempt = 0; attempt < 45 && runId === undefined; attempt++) {
    const runs = await $`gh run list --repo ${repository} --workflow ci.yml --branch ${branch} --commit ${sourceSha} --event workflow_dispatch --limit 10 --json databaseId`.json() as { databaseId: number }[];
    runId = runs.find((run) => !previousIds.has(run.databaseId))?.databaseId;
    if (runId === undefined) await Bun.sleep(2000);
  }
  if (runId === undefined) throw new Error(`CI dispatch was not observed; inspect preparation branch ${branch}`);
  // Advisory jobs may fail: the named required gate owns the release decision.
  await $`gh run watch ${runId} --repo ${repository} --exit-status --interval 30`.nothrow();
  const proof = await $`gh run view ${runId} --repo ${repository} --json headSha,headBranch,event,status,conclusion,jobs`.json() as ProofRun;
  assertReleaseProof(sourceSha, branch, proof);
  console.log(`  Exact-SHA required CI passed (run ${runId})`);
}
