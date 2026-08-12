import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleReleaseBundle } from "./assemble-release-bundle";
import { CLI_TARGETS, cliAssetName } from "./release-artifacts";
import { deterministicZip } from "./release-archive";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const created: string[] = [];

async function fixture(channel: "stable" | "dev") {
  const directory = mkdtempSync(join(tmpdir(), "atlcli-bundle-assembly-"));
  const inputs = mkdtempSync(join(tmpdir(), "atlcli-bundle-inputs-"));
  created.push(directory, inputs);
  for (const target of CLI_TARGETS) {
    writeFileSync(join(directory, cliAssetName(target)), `fixture-${target}`);
  }
  const buildId = channel === "stable" ? "v0.17.2" : "dev-20260812.418.2-01234567";
  const manifest = {
    manifest_version: 3,
    name: "atlcli",
    version: channel === "stable" ? "0.17.2" : "0.17.2.418",
    version_name:
      channel === "stable" ? "0.17.2-stable" : "0.17.2-dev.20260812.418.2-01234567",
    background: { service_worker: "background.js", type: "module" },
  };
  const extension = await deterministicZip([
    { path: "background.js", bytes: Buffer.from("export {};\n"), mode: 0o644 },
    { path: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest)), mode: 0o644 },
  ]);
  writeFileSync(join(directory, `atlcli-extension-chrome-mv3-${buildId}.zip`), extension);
  const security = join(inputs, "security-attestation.json");
  writeFileSync(security, JSON.stringify({ commit: SHA }));
  const eligibility = join(inputs, "source-eligibility.json");
  writeFileSync(eligibility, JSON.stringify({ sourceSha: SHA }));
  const lockfile = join(inputs, "fixture.lock");
  writeFileSync(lockfile, "lockfile\n");
  return { directory, buildId, security, eligibility, lockfile };
}

afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("release bundle assembly", () => {
  test("assembles the stable bundle without claiming dev source eligibility", async () => {
    const input = await fixture("stable");
    const receipt = await assembleReleaseBundle({
      directory: input.directory,
      channel: "stable",
      rootVersion: "0.17.2",
      sourceSha: SHA,
      sourceRef: "refs/tags/v0.17.2",
      createdAt: "2026-08-12T02:17:45Z",
      runId: 99,
      runNumber: 418,
      runAttempt: 2,
      event: "push",
      expectedBuildId: input.buildId,
      securityAttestationPath: input.security,
      lockfilePath: input.lockfile,
      runnerOs: "fixture",
      bunVersion: "1.3.14",
      wxtVersion: "0.20.27",
      verifyExtensionRuntime: false,
    });
    const metadata = JSON.parse(readFileSync(join(input.directory, "build-metadata.json"), "utf8"));
    expect(receipt.identity.releaseTag).toBe("v0.17.2");
    expect(receipt.assets).toHaveLength(7);
    expect(metadata.sourceEligibilitySha256).toBeNull();
    expect(readFileSync(join(input.directory, "checksums.txt"), "utf8")).toContain(
      "security-attestation.json",
    );
  });

  test("requires and binds the eligibility receipt only for dev", async () => {
    const input = await fixture("dev");
    await expect(
      assembleReleaseBundle({
        directory: input.directory,
        channel: "dev",
        rootVersion: "0.17.2",
        sourceSha: SHA,
        sourceRef: "refs/heads/main",
        createdAt: "2026-08-12T02:17:45Z",
        runId: 99,
        runNumber: 418,
        runAttempt: 2,
        event: "workflow_dispatch",
        expectedBuildId: input.buildId,
        securityAttestationPath: input.security,
        lockfilePath: input.lockfile,
        wxtVersion: "0.20.27",
        verifyExtensionRuntime: false,
      }),
    ).rejects.toThrow("requires a source eligibility receipt");

    const receipt = await assembleReleaseBundle({
      directory: input.directory,
      channel: "dev",
      rootVersion: "0.17.2",
      sourceSha: SHA,
      sourceRef: "refs/heads/main",
      createdAt: "2026-08-12T02:17:45Z",
      runId: 99,
      runNumber: 418,
      runAttempt: 2,
      event: "workflow_dispatch",
      expectedBuildId: input.buildId,
      securityAttestationPath: input.security,
      sourceEligibilityPath: input.eligibility,
      lockfilePath: input.lockfile,
      wxtVersion: "0.20.27",
      verifyExtensionRuntime: false,
    });
    const metadata = JSON.parse(readFileSync(join(input.directory, "build-metadata.json"), "utf8"));
    expect(receipt.assets).toHaveLength(8);
    expect(metadata.sourceEligibilitySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("fails closed on an unexpected payload or mismatched build ID", async () => {
    const extra = await fixture("stable");
    writeFileSync(join(extra.directory, "unexpected.zip"), "nope");
    await expect(
      assembleReleaseBundle({
        directory: extra.directory,
        channel: "stable",
        rootVersion: "0.17.2",
        sourceSha: SHA,
        sourceRef: "refs/tags/v0.17.2",
        createdAt: "2026-08-12T02:17:45Z",
        runId: 1,
        runNumber: 1,
        runAttempt: 1,
        event: "push",
        expectedBuildId: "v0.17.2",
        securityAttestationPath: extra.security,
        lockfilePath: extra.lockfile,
        wxtVersion: "0.20.27",
        verifyExtensionRuntime: false,
      }),
    ).rejects.toThrow("payload contract mismatch");

    const mismatch = await fixture("stable");
    await expect(
      assembleReleaseBundle({
        directory: mismatch.directory,
        channel: "stable",
        rootVersion: "0.17.2",
        sourceSha: SHA,
        sourceRef: "refs/tags/v0.17.2",
        createdAt: "2026-08-12T02:17:45Z",
        runId: 1,
        runNumber: 1,
        runAttempt: 1,
        event: "push",
        expectedBuildId: "v0.17.3",
        securityAttestationPath: mismatch.security,
        lockfilePath: mismatch.lockfile,
        wxtVersion: "0.20.27",
        verifyExtensionRuntime: false,
      }),
    ).rejects.toThrow("does not match expected");
  });
});
