#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  readReleaseTree,
  releaseTreeDigest,
  writeDeterministicZip,
} from "../../../scripts/release-archive.js";
import { resolveExtensionReleaseContext } from "../release-context.js";

export interface PackagedExtensionReceipt {
  channel: "stable" | "dev" | "source";
  sourceSha: string;
  buildId: string;
  version: string;
  versionName: string;
  artifactName: string;
  artifactPath: string;
  artifactSize: number;
  artifactSha256: string;
  contentTreeSha256: string;
  fileCount: number;
}

export async function packagePrebuiltExtension(input: {
  inputDirectory: string;
  outputDirectory?: string;
  artifactPath?: string;
  environment: NodeJS.ProcessEnv;
}): Promise<PackagedExtensionReceipt> {
  if ((input.outputDirectory === undefined) === (input.artifactPath === undefined)) {
    throw new Error("provide exactly one of outputDirectory or artifactPath");
  }
  const context = resolveExtensionReleaseContext(input.environment);
  const entries = readReleaseTree(input.inputDirectory);
  if (entries.length === 0) throw new Error("extension output is empty");
  const manifestEntry = entries.find((entry) => entry.path === "manifest.json");
  if (!manifestEntry) throw new Error("extension output has no root manifest.json");
  const manifest = JSON.parse(new TextDecoder().decode(manifestEntry.bytes)) as {
    version?: string;
    version_name?: string;
  };
  if (manifest.version !== context.version || manifest.version_name !== context.versionName) {
    throw new Error(
      `built manifest identity mismatch: expected ${context.version}/${context.versionName}, ` +
        `got ${String(manifest.version)}/${String(manifest.version_name)}`,
    );
  }

  const artifactPath = input.artifactPath === undefined
    ? join(resolve(input.outputDirectory!), context.artifactName)
    : resolve(input.artifactPath);
  if (basename(artifactPath) !== context.artifactName) {
    throw new Error(
      `WXT artifact name mismatch: expected ${context.artifactName}, got ${basename(artifactPath)}`,
    );
  }
  mkdirSync(resolve(artifactPath, ".."), { recursive: true });
  await writeDeterministicZip(artifactPath, entries);
  const bytes = readFileSync(artifactPath);
  return {
    channel: context.channel,
    sourceSha: context.sourceSha,
    buildId: context.buildId,
    version: context.version,
    versionName: context.versionName,
    artifactName: context.artifactName,
    artifactPath,
    artifactSize: bytes.byteLength,
    artifactSha256: createHash("sha256").update(bytes).digest("hex"),
    contentTreeSha256: releaseTreeDigest(entries),
    fileCount: entries.length,
  };
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (import.meta.main) {
  const extensionRoot = resolve(import.meta.dir, "..");
  const receipt = await packagePrebuiltExtension({
    inputDirectory: resolve(argValue("--input") ?? join(extensionRoot, ".output", "chrome-mv3")),
    outputDirectory: resolve(argValue("--output") ?? join(extensionRoot, ".output")),
    environment: process.env,
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}
