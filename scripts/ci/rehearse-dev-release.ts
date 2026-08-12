#!/usr/bin/env bun

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assembleReleaseBundle } from "../assemble-release-bundle.js";
import { buildReleaseArtifacts } from "../build-release-artifacts.js";
import {
  canonicalJson,
  createReleaseIdentity,
  type ArtifactDigest,
} from "../release-artifacts.js";
import { verifyReleaseArtifacts } from "../verify-release-artifacts.js";
import { createDevReleaseShadowPlan } from "./dev-release-shadow-plan.js";

function git(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.toString().trim();
}

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function requiredBoolean(args: string[], name: string): boolean {
  const value = argument(args, name);
  if (value !== "true" && value !== "false") throw new Error(`${name} requires true or false`);
  return value === "true";
}

function byName(artifacts: ArtifactDigest[]): Record<string, { size: number; sha256: string }> {
  return Object.fromEntries(
    artifacts.map(({ name, size, sha256 }) => [name, { size, sha256 }]),
  );
}

export interface DevReleaseRehearsalReceipt {
  schema: "atlcli.dev-release-rehearsal/v1";
  authoritativePublishedArtifact: false;
  sourceSha: string;
  buildId: string;
  repeatedBuilds: 2;
  byteIdentical: true;
  publishHomebrew: boolean;
  assets: ArtifactDigest[];
  plannedPublicationMutations: number;
  executedPublicationMutations: 0;
}

export async function rehearseDevRelease(args: string[]): Promise<DevReleaseRehearsalReceipt> {
  if (argument(args, "--channel") !== "dev") throw new Error("rehearsal supports only --channel dev");
  const publishHomebrew = requiredBoolean(args, "--publish-homebrew");
  const sourceSha = argument(args, "--source-sha") ?? git(["rev-parse", "HEAD"]);
  const rootVersion = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
  const createdAt = new Date(
    argument(args, "--timestamp") ?? git(["show", "-s", "--format=%cI", sourceSha]),
  ).toISOString();
  const runNumber = Number(argument(args, "--run-number") ?? "900001");
  const runAttempt = Number(argument(args, "--run-attempt") ?? "1");
  const identity = createReleaseIdentity({
    channel: "dev",
    rootVersion,
    sourceSha,
    sourceReachableFromMain: true,
    timestamp: createdAt,
    runNumber,
    runAttempt,
  });
  const root = mkdtempSync(join(tmpdir(), "atlcli-dev-rehearsal-"));
  try {
    const security = join(root, "security-attestation.json");
    const eligibility = join(root, "source-eligibility.json");
    writeFileSync(security, canonicalJson({
      schema: "atlcli.security-attestation/v1",
      commit: sourceSha,
      date: createdAt,
      veraPdfDigestOk: null,
      veraPdfBaselineDelta: null,
      securityReviewNote: "local shadow fixture; no publication authority",
      m1AcceptanceOk: null,
      checks: [{ field: "local-shadow", status: "ok", detail: "fixture-only rehearsal" }],
    }));
    writeFileSync(eligibility, canonicalJson({
      schema: "atlcli.source-eligibility/v1",
      decision: "eligible",
      reason: "local-shadow-fixture-only",
      degraded: false,
      sourceSha,
      policyVersion: "atlcli.release-eligibility/v1",
      workflow: {
        path: ".github/workflows/ci.yml",
        event: "push",
        branch: "main",
        runId: 1,
        runAttempt: 1,
        status: "completed",
        conclusion: "success",
        url: "https://github.com/BjoernSchotte/atlcli/actions",
      },
      requiredJob: {
        name: "required",
        status: "completed",
        conclusion: "success",
        url: "https://github.com/BjoernSchotte/atlcli/actions",
      },
      advisory: [],
    }));

    const verified = [];
    for (const pass of [1, 2]) {
      const directory = join(root, `bundle-${pass}`);
      await buildReleaseArtifacts({
        identity,
        outputDirectory: directory,
        dryRun: true,
        publishableSource: false,
      });
      rmSync(join(directory, ".atlcli-release-artifacts-v1"));
      await assembleReleaseBundle({
        directory,
        channel: "dev",
        rootVersion,
        sourceSha,
        sourceRef: "refs/heads/main",
        createdAt,
        runId: 900001,
        runNumber,
        runAttempt,
        event: "workflow_dispatch",
        expectedBuildId: identity.buildId,
        securityAttestationPath: security,
        sourceEligibilityPath: eligibility,
        runnerOs: "local-shadow",
      });
      verified.push(await verifyReleaseArtifacts({ directory }));
    }
    if (JSON.stringify(byName(verified[0]!.verifiedArtifacts)) !== JSON.stringify(byName(verified[1]!.verifiedArtifacts))) {
      throw new Error("repeated dev release builds are not byte-identical");
    }

    const assets = verified[0]!.verifiedArtifacts;
    const plan = createDevReleaseShadowPlan({
      sourceSha,
      tag: identity.buildId,
      stableLatestBefore: argument(args, "--stable-latest") ?? `v${rootVersion}`,
      assets: assets.map(({ name, size, sha256 }) => ({ filename: name, size, sha256 })),
      publishHomebrew,
    });
    return {
      schema: "atlcli.dev-release-rehearsal/v1",
      authoritativePublishedArtifact: false,
      sourceSha,
      buildId: identity.buildId,
      repeatedBuilds: 2,
      byteIdentical: true,
      publishHomebrew,
      assets,
      plannedPublicationMutations: plan.plannedPublicationMutations.length,
      executedPublicationMutations: 0,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const receipt = await rehearseDevRelease(process.argv.slice(2));
  const rendered = canonicalJson(receipt);
  const output = argument(process.argv.slice(2), "--out");
  if (output) writeFileSync(resolve(output), rendered);
  else process.stdout.write(rendered);
}
