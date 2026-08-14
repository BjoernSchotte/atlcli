import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildLiveReleaseProof } from "./build-live-release-proof";
import { canonicalJson } from "../release-artifacts";

const sha = "a".repeat(40);
const tag = "dev-20260813.12.1-aaaaaaaa";
const runId = 123;
const assetNames = [
  "atlcli-darwin-arm64.tar.gz", "atlcli-darwin-x64.tar.gz", "atlcli-linux-arm64.tar.gz",
  "atlcli-linux-x64.tar.gz", "atlcli-windows-x64.zip", `atlcli-extension-chrome-mv3-${tag}.zip`,
  "build-metadata.json", "checksums.txt", "security-attestation.json", "source-eligibility.json",
].sort();

function fixture() {
  const root = join(tmpdir(), `atlcli-live-proof-${crypto.randomUUID()}`);
  mkdirSync(join(root, "extension"), { recursive: true });
  const metadata = {
    schema: "atlcli.build-metadata/v1" as const, channel: "dev" as const, rootVersion: "0.17.2", sourceSha: sha,
    releaseTag: tag, buildId: tag, run: { id: runId, attempt: 1, event: "workflow_dispatch" as const, createdAt: "2026-08-13T00:00:00Z" },
    toolchain: { bun: "1.3.14", wxt: "0.20.27", runnerOs: "Linux" }, lockfileSha256: "b".repeat(64),
    artifacts: [{ name: "atlcli-linux-x64.tar.gz", size: 1, sha256: "f".repeat(64) }],
    extension: { contentTreeSha256: "c".repeat(64) },
  };
  const eligibility = {
    schema: "atlcli.source-eligibility/v1" as const, decision: "eligible" as const, degraded: false, sourceSha: sha,
    policyVersion: "atlcli.dev-release-eligibility/v1", workflow: { runId: 99, runAttempt: 1, conclusion: "success" as const },
    requiredJob: { conclusion: "success" as const },
  };
  for (const name of assetNames) writeFileSync(join(root, name), name);
  writeFileSync(join(root, "extension.atlcli-release-extraction-v1"), "owned by atlcli release verifier\n");
  writeFileSync(join(root, "build-metadata.json"), canonicalJson(metadata));
  writeFileSync(join(root, "source-eligibility.json"), canonicalJson(eligibility));
  writeFileSync(join(root, "extension", "manifest.json"), JSON.stringify({ version: "0.17.2.12" }));
  const assets = assetNames.map((name) => {
    const bytes = readFileSync(join(root, name));
    return { name, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const releaseInfo = { channel: "dev" as const, sourceSha: sha, buildId: tag, releaseTag: tag };
  const nativeTargets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-x64"];
  const brewTargets = nativeTargets.slice(0, 4);
  const pointer = { schema: "atlcli.homebrew-dev-pointer/v1" as const, tag, sourceSha: sha };
  const formulaText = "formula";
  const attestation = {
    verificationResult: {
      signature: { certificate: { subjectAlternativeName: "https://dotcom.releases.github.com" } },
      statement: {
        predicateType: "https://in-toto.io/attestation/release/v0.2",
        predicate: { repository: "BjoernSchotte/atlcli", tag },
        subject: [
          { uri: `pkg:github/BjoernSchotte/atlcli@${tag}`, digest: { sha1: sha } },
          ...assets.map(({ name, sha256 }) => ({ name, digest: { sha256 } })),
        ],
      },
      verifiedTimestamps: [{ timestamp: "2026-08-13T00:30:00Z", type: "TimestampAuthority", uri: "timestamp.githubapp.com" }],
    },
  };
  return {
    root, metadata, eligibility, assets, releaseInfo, pointer, formulaText,
    input: {
      releaseDir: root,
      releaseVerification: { schema: "atlcli.release-verification/v1" as const, sourceSha: sha, channel: "dev" as const, buildId: tag, releaseTag: tag, verifiedArtifacts: metadata.artifacts, extension: { contentTreeSha256: "c".repeat(64), outputScan: "success" as const, entryCount: 1 } },
      releaseReceipt: { schema: "atlcli.github-release-transaction/v1" as const, operation: "verify-published" as const, releaseUrl: "https://github.com/BjoernSchotte/atlcli/releases/tag/x", tag, sourceSha: sha, draft: false as const, prerelease: true as const, makeLatest: false as const, immutable: true as const, assets, stableLatestBefore: "v0.17.2", stableLatestAfter: "v0.17.2", run: { id: runId, attempt: 1 } },
      eligibility,
      releaseRun: { databaseId: runId, attempt: 1, event: "workflow_dispatch" as const, headSha: sha, url: "https://github.com/BjoernSchotte/atlcli/actions/runs/123", conclusion: "success" as const, jobs: ["Download and consume every draft asset", "Verify public prerelease and stable latest isolation", "Publish and verify isolated Homebrew dev formula"].map((name) => ({ name, conclusion: "success" })) },
      githubReleaseAttestation: structuredClone(attestation),
      githubAssetAttestation: structuredClone(attestation),
      nativeReceipts: nativeTargets.map((target) => ({ schema: "atlcli.native-cli-verification/v1" as const, target, runner: { platform: target.split("-")[0]!, arch: target.split("-")[1]! }, releaseInfo })),
      homebrewDispatch: { schema: "atlcli.homebrew-dev-dispatch/v1" as const, workflow: { id: 8, attempt: 1, url: "https://github.com/BjoernSchotte/homebrew-tap/actions/runs/8", conclusion: "success" as const }, tapCommit: "d".repeat(40), formulaSha256: createHash("sha256").update(formulaText).digest("hex"), pointer },
      homebrewNativeReceipts: brewTargets.map((target) => ({ schema: "atlcli.homebrew-dev-native-verification/v1" as const, target, rubyPlatform: target.startsWith("darwin") ? "darwin" : "linux", hostCpu: target.endsWith("arm64") ? "arm64" : "x86_64", releaseInfo })),
      pointerText: canonicalJson(pointer), formulaText, recordedAt: "2026-08-13T01:00:00Z",
    },
  };
}

describe("live release proof builder", () => {
  it("binds all public release and Homebrew consumer receipts into one proof", () => {
    const proof = buildLiveReleaseProof(fixture().input) as any;
    expect(proof.schema).toBe("atlcli.dev-release-live-proof/v1");
    expect(proof.assets).toHaveLength(10);
    expect(Object.keys(proof.homebrew.nativeMatrix)).toHaveLength(4);
    expect(proof.release.attestation.assetCount).toBe(10);
    expect(proof.tests.githubBuildMetadataAssetAttestation).toBe("success");
    expect(Object.keys(proof.extension.packedChromiumSuites)).toEqual(["worker", "jobs", "research", "rovo", "palette"]);
    const schema = JSON.parse(readFileSync("specs/dev-release-channel/evidence/schemas/live-release-proof.schema.json", "utf8"));
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    expect(validate(proof), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects a mismatched Homebrew pointer", () => {
    const f = fixture();
    f.input.homebrewDispatch.pointer.sourceSha = "e".repeat(40);
    expect(() => buildLiveReleaseProof(f.input)).toThrow("Homebrew publication identity mismatch");
  });

  it("rejects a missing native platform proof", () => {
    const f = fixture();
    f.input.nativeReceipts.pop();
    expect(() => buildLiveReleaseProof(f.input)).toThrow("native CLI target contract mismatch");
  });

  it("rejects an artifact verifier receipt that is not bound to build metadata", () => {
    const f = fixture();
    f.input.releaseVerification.verifiedArtifacts = [];
    expect(() => buildLiveReleaseProof(f.input)).toThrow("downloaded artifact verifier receipt differs");
  });

  it("rejects an attestation for a different source commit", () => {
    const f = fixture();
    const source = f.input.githubReleaseAttestation.verificationResult.statement.subject[0] as { digest: { sha1: string } };
    source.digest.sha1 = "e".repeat(40);
    expect(() => buildLiveReleaseProof(f.input)).toThrow("GitHub release attestation identity mismatch");
  });

  it("rejects an attestation whose asset digest differs from the downloaded bytes", () => {
    const f = fixture();
    const subject = f.input.githubAssetAttestation.verificationResult.statement.subject.find(
      (candidate): candidate is { name: string; digest: { sha256: string } } => "name" in candidate && candidate.name === "build-metadata.json",
    )!;
    subject.digest.sha256 = "e".repeat(64);
    expect(() => buildLiveReleaseProof(f.input)).toThrow("GitHub release attestation asset inventory mismatch");
  });
});
