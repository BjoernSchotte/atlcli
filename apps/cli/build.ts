#!/usr/bin/env bun
/**
 * Build script for atlcli CLI.
 * Injects version from package.json at compile time.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read version from root package.json
const rootPkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8"));
const version = rootPkg.version;

// Build with version injected
const args = [
  "build",
  "src/index.ts",
  "--outdir",
  "../../dist",
  "--target",
  "bun",
  `--define`,
  `__ATLCLI_VERSION__="${version}"`,
];

// Add minify flag if requested
if (process.argv.includes("--minify")) {
  args.push("--minify");
}

console.log(`Building atlcli v${version}...`);

const proc = Bun.spawn(["bun", ...args], {
  cwd: __dirname,
  stdio: ["inherit", "inherit", "inherit"],
});

const exitCode = await proc.exited;
process.exit(exitCode);
