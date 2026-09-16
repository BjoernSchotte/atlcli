import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NFS_BRIDGE_VERSION } from "../apps/cli/src/vfs/nfs-framing.js";
import { readReleaseTree, releaseTreeDigest } from "./release-archive.js";

const root = resolve(import.meta.dir, "..");
const crate = join(root, "packages/confluence-nfs");

export function nativeNfsTarget(os: string, arch: string): string {
  const targets: Record<string, string> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "linux-x64": "x86_64-unknown-linux-gnu",
  };
  const target = targets[`${os}-${arch}`];
  if (!target) throw new Error(`Unsupported native NFS helper target: ${os}-${arch}`);
  return target;
}

function run(args: string[]): string {
  const result = spawnSync(args[0]!, args.slice(1), { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`NFS build command failed: ${args[0]}\n${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

export function verifyNfsHelperIdentity(value: unknown, os = process.platform as string, arch = process.arch as string): void {
  const expectedOs = os === "darwin" ? "macos" : os;
  const expectedArch = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch;
  const identity = value as Record<string, unknown> | null;
  if (!identity || identity.name !== "atlcli-confluence-nfs" || identity.bridgeVersion !== NFS_BRIDGE_VERSION ||
      identity.os !== expectedOs || identity.arch !== expectedArch || typeof identity.version !== "string") {
    throw new Error("NFS helper identity does not match the CLI protocol and native target");
  }
}

export function buildNfsHelper(output: string): void {
  const target = nativeNfsTarget(process.platform, process.arch);
  const destination = resolve(output);
  if (existsSync(destination) && readdirSync(destination).length) throw new Error("NFS helper output must be empty");
  run(["cargo", "+1.92.0", "build", "--locked", "--release", "--target", target, "--manifest-path", join(crate, "Cargo.toml")]);
  const binary = join(crate, "target", target, "release", "atlcli-confluence-nfs");
  const identity: unknown = JSON.parse(run([binary, "--version"]));
  verifyNfsHelperIdentity(identity);
  const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const sourceEntries = ["src", "vendor"].flatMap((directory) => readReleaseTree(join(crate, directory))
    .map((entry) => ({ ...entry, path: `${directory}/${entry.path}` })));
  for (const path of ["Cargo.toml", "Cargo.lock"]) sourceEntries.push({ path, bytes: readFileSync(join(crate, path)), mode: 0o644 });
  const receipt = {
    schema: "atlcli.nfs-helper-build/v1", target, identity,
    sourceSha: run(["git", "rev-parse", "HEAD"]),
    dirty: run(["git", "status", "--porcelain", "--", "packages/confluence-nfs"]).length > 0,
    sourceTreeSha256: releaseTreeDigest(sourceEntries),
    cargoLockSha256: sha256(readFileSync(join(crate, "Cargo.lock"))),
    binarySha256: sha256(readFileSync(binary)),
    rustc: run(["rustc", "+1.92.0", "--version"]),
  };
  mkdirSync(destination, { recursive: true });
  copyFileSync(binary, join(destination, "atlcli-confluence-nfs"));
  chmodSync(join(destination, "atlcli-confluence-nfs"), 0o755);
  copyFileSync(join(crate, "vendor/nfsserve/LICENSE"), join(destination, "LICENSE-nfsserve"));
  writeFileSync(join(destination, "nfs-helper-build.json"), `${JSON.stringify(receipt, null, 2)}\n`);
}

if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error("Usage: bun scripts/build-nfs-helper.ts <empty-output-directory>");
  buildNfsHelper(process.argv[2]!);
}
