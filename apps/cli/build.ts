#!/usr/bin/env bun
/**
 * Build script for atlcli CLI.
 * Injects version from package.json at compile time.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { materializeQuickJsCliRuntimeAsset } from "./build-assets.js";
import { releaseInfoBunDefineArgs, resolveBuildReleaseInfo } from "./build-release-info.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read version from root package.json
const rootPkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8"));
const version = rootPkg.version;
const gitSha = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
  cwd: join(__dirname, "../.."),
  stderr: "pipe",
});
const releaseInfo = resolveBuildReleaseInfo({
  environment: process.env,
  rootVersion: version,
  gitSha: gitSha.exitCode === 0 ? gitSha.stdout.toString().trim() : "unknown",
});

// Build with version injected
const args = [
  "build",
  "src/index.ts",
  "--outdir",
  "../../dist",
  "--target",
  "bun",
  // Bundle from workspace sources: `@atlcli/*` exports resolve their
  // `development` condition to `src/*.ts` (spec 009), so this build does not
  // depend on the packages' `dist/` output existing.
  "--conditions=development",
  ...releaseInfoBunDefineArgs(releaseInfo),
];

// Add minify flag if requested
if (process.argv.includes("--minify")) {
  args.push("--minify");
}

console.log(`Building atlcli ${releaseInfo.version} (${releaseInfo.channel}, ${releaseInfo.buildId})...`);

const proc = Bun.spawn(["bun", ...args], {
  cwd: __dirname,
  stdio: ["inherit", "inherit", "inherit"],
});

const exitCode = await proc.exited;
if (exitCode === 0) {
  const asset = await materializeQuickJsCliRuntimeAsset({
    outputDirectory: join(__dirname, "../../dist"),
  });
  console.log(`Materialized QuickJS runtime: ${asset}`);
}
process.exit(exitCode);
