import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releasePullRequestReady, releaseProofBranch } from "./release-proof.js";

const SHA = "a".repeat(40);
const PULL = {
  headRefOid: SHA, isDraft: false, state: "OPEN", mergeCommit: null,
  statusCheckRollup: [{ name: "required", status: "COMPLETED", conclusion: "SUCCESS" }],
};

describe("protected-main release proof", () => {
  test("uses a commit-bound preparation branch and rejects unsafe identities", () => {
    expect(releaseProofBranch("2026.10.1", SHA)).toBe(`codex/release-2026.10.1-${SHA.slice(0, 8)}`);
    expect(() => releaseProofBranch("2026.13.1", SHA)).toThrow();
    expect(() => releaseProofBranch("2026.10.1", "main")).toThrow();
  });
  test("requires successful required CI on an unchanged ready release PR", () => {
    expect(releasePullRequestReady(SHA, PULL)).toBe(true);
    expect(releasePullRequestReady(SHA, { ...PULL, statusCheckRollup: [] })).toBe(false);
    expect(releasePullRequestReady(SHA, { ...PULL, statusCheckRollup: [{ name: "required", status: "IN_PROGRESS" }] })).toBe(false);
    for (const partial of [{ headRefOid: "b".repeat(40) }, { isDraft: true }, { state: "CLOSED" },
      { statusCheckRollup: [...PULL.statusCheckRollup, ...PULL.statusCheckRollup] },
      ...["FAILURE", "SKIPPED", "CANCELLED"].map((conclusion) => ({ statusCheckRollup: [{ name: "required", status: "COMPLETED", conclusion }] }))]) {
      expect(() => releasePullRequestReady(SHA, { ...PULL, ...partial })).toThrow();
    }
  });
  test("an advisory failure does not override required success", () => {
    expect(releasePullRequestReady(SHA, { ...PULL, statusCheckRollup: [...PULL.statusCheckRollup,
      { name: "Non-required CI timing telemetry", status: "COMPLETED", conclusion: "FAILURE" }],
    })).toBe(true);
  });

  test("merges through GitHub with the expected head and returns the merge commit to tag", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "atlcli-release-pr-"));
    const run = async (...args: string[]) => {
      const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
      const output = await new Response(proc.stdout).text();
      const error = await new Response(proc.stderr).text();
      if (await proc.exited !== 0) throw new Error(error);
      return output.trim();
    };
    try {
      await run("git", "init", "-b", "main");
      await run("git", "config", "user.email", "release-test@example.invalid");
      await run("git", "config", "user.name", "Release Test");
      await run("git", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "prepared release");
      const sourceSha = await run("git", "rev-parse", "HEAD");
      await run("git", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "protected PR merge");
      const mergeSha = await run("git", "rev-parse", "HEAD");
      await run("git", "init", "--bare", "remote.git");
      await run("git", "remote", "add", "origin", join(cwd, "remote.git"));
      await run("git", "push", "origin", "main");
      const mockBin = join(cwd, "bin");
      await mkdir(mockBin);
      const gh = join(mockBin, "gh");
      await writeFile(gh, `#!/usr/bin/env bun
import { existsSync, appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync("gh-log", JSON.stringify(args) + "\\n");
if (args[1] === "create") console.log("https://github.com/BjoernSchotte/atlcli/pull/999");
else if (args[1] === "merge") {
  if (!args.includes("--merge") || args[args.indexOf("--match-head-commit") + 1] !== ${JSON.stringify(sourceSha)}) process.exit(1);
  writeFileSync("merged", "yes");
} else if (args[1] === "view") console.log(JSON.stringify({
  headRefOid: ${JSON.stringify(sourceSha)}, isDraft: false,
  state: existsSync("merged") ? "MERGED" : "OPEN",
  mergeCommit: existsSync("merged") ? {oid: ${JSON.stringify(mergeSha)}} : null,
  statusCheckRollup: [{name:"required",status:"COMPLETED",conclusion:"SUCCESS"}]
}));
else process.exit(1);
`);
      await chmod(gh, 0o755);
      const proc = Bun.spawn(["bun", "-e", `import { mergeReleaseCommit } from ${JSON.stringify(join(import.meta.dir, "release-proof.ts"))}; console.log("RESULT=" + await mergeReleaseCommit("2026.10.1", ${JSON.stringify(sourceSha)}));`], {
        cwd, env: { ...process.env, PATH: `${mockBin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
      });
      const output = await new Response(proc.stdout).text();
      const error = await new Response(proc.stderr).text();
      expect(await proc.exited, error).toBe(0);
      expect(output).toContain(`RESULT=${mergeSha}`);
      const calls = (await readFile(join(cwd, "gh-log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(calls.map((args) => args[1])).toEqual(["create", "view", "merge", "view"]);
      expect(await run("git", "--git-dir", "remote.git", "rev-parse", `refs/heads/${releaseProofBranch("2026.10.1", sourceSha)}`)).toBe(sourceSha);
      expect(await run("git", "tag", "--list")).toBe("");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
