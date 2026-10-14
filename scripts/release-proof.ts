import { $ } from "bun";
import { assertCalverVersion } from "./release-version.js";

interface ReleasePullRequest {
  headRefOid: string;
  isDraft: boolean;
  state: string;
  mergeCommit: { oid: string } | null;
  statusCheckRollup: { name?: string; status?: string; conclusion?: string }[];
}

export function releaseProofBranch(version: string, sourceSha: string): string {
  assertCalverVersion(version);
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error("Release proof requires a full source SHA");
  return `codex/release-${version}-${sourceSha.slice(0, 8)}`;
}

export function releasePullRequestReady(sourceSha: string, pull: ReleasePullRequest): boolean {
  if (pull.headRefOid !== sourceSha || pull.isDraft || !["OPEN", "MERGED"].includes(pull.state)) {
    throw new Error("Release pull request identity or state changed");
  }
  const required = pull.statusCheckRollup.filter((check) => check.name === "required");
  if (required.length > 1) throw new Error("Ambiguous required release check");
  if (required[0]?.status === "COMPLETED" && required[0].conclusion !== "SUCCESS") {
    throw new Error("Required release CI failed");
  }
  return required.length === 1 && required[0]!.status === "COMPLETED" && required[0]!.conclusion === "SUCCESS";
}

/** Use GitHub's protected merge path, then return the immutable commit to tag. */
export async function mergeReleaseCommit(version: string, sourceSha: string, cwd = process.cwd()): Promise<string> {
  const repository = "BjoernSchotte/atlcli";
  const branch = releaseProofBranch(version, sourceSha);
  await $`git -C ${cwd} push origin ${`${sourceSha}:refs/heads/${branch}`}`;
  const url = (await $`gh pr create --repo ${repository} --base main --head ${branch} --title ${`chore(release): v${version}`} --body ${`Prepare the reviewed v${version} product release and changelog. Merge through required CI before tagging the resulting merge commit.`}`.text()).trim();
  console.log(`Prepared release pull request: ${url}`);
  for (let attempt = 0; attempt < 90; attempt++) {
    const pull = await $`gh pr view ${url} --repo ${repository} --json headRefOid,isDraft,state,mergeCommit,statusCheckRollup`.json() as ReleasePullRequest;
    const ready = releasePullRequestReady(sourceSha, pull);
    if (pull.state === "MERGED") {
      if (!ready || !pull.mergeCommit || !/^[0-9a-f]{40}$/.test(pull.mergeCommit.oid)) {
        throw new Error("Merged release is missing its CI proof or commit identity");
      }
      await $`git -C ${cwd} fetch origin main`;
      await $`git -C ${cwd} merge-base --is-ancestor ${sourceSha} ${pull.mergeCommit.oid}`;
      return pull.mergeCommit.oid;
    }
    if (ready) {
      // GitHub rechecks protection and the expected head at the merge boundary.
      await $`gh pr merge ${url} --repo ${repository} --merge --match-head-commit ${sourceSha}`;
    } else {
      await Bun.sleep(30_000);
    }
  }
  throw new Error(`Release PR did not finish; inspect ${url} before recovery`);
}
