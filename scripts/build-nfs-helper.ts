import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { NFS_BRIDGE_VERSION } from "../apps/cli/src/vfs/nfs-framing.js";
import { readReleaseTree, releaseTreeDigest, type ReleaseTreeEntry } from "./release-archive.js";

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

export function verifyNfsCompanion(entries: ReleaseTreeEntry[], target: string, sourceSha: string, allowDirty = false): void {
  const [os, arch] = target.split("-");
  if (target !== `${os}-${arch}`) throw new Error("Unsupported NFS target");
  const triple = nativeNfsTarget(os!, arch!);
  const names = entries.map((entry) => entry.path).sort();
  if (JSON.stringify(names) !== JSON.stringify(["LICENSE-nfsserve", "THIRD-PARTY-nfs.html", "atlcli-confluence-nfs", "nfs-helper-build.json"])) {
    throw new Error("Unexpected NFS companion files");
  }
  const file = (name: string) => entries.find((entry) => entry.path === name)!;
  const manifest = file("nfs-helper-build.json");
  const binary = file("atlcli-confluence-nfs");
  if (manifest.bytes.length > 65536 || binary.bytes.length < 32 || binary.bytes.length > 32 * 1024 * 1024 || !(binary.mode & 0o111)) {
    throw new Error("Invalid NFS companion size or executable mode");
  }
  const receipt = JSON.parse(Buffer.from(manifest.bytes).toString("utf8"));
  if (receipt.schema !== "atlcli.nfs-helper-build/v1" || receipt.target !== triple || receipt.sourceSha !== sourceSha ||
      typeof receipt.dirty !== "boolean" || (!allowDirty && receipt.dirty) ||
      !/^[a-f0-9]{64}$/.test(receipt.cargoLockSha256 ?? "") || !/^[a-f0-9]{64}$/.test(receipt.sourceTreeSha256 ?? "")) {
    throw new Error("NFS companion provenance mismatch");
  }
  const notices = file("THIRD-PARTY-nfs.html").bytes;
  if (!notices.length || notices.length > 4 * 1024 * 1024 ||
      createHash("sha256").update(notices).digest("hex") !== receipt.noticesSha256) {
    throw new Error("NFS dependency notices checksum mismatch");
  }
  verifyNfsHelperIdentity(receipt.identity, os, arch);
  if (createHash("sha256").update(binary.bytes).digest("hex") !== receipt.binarySha256) throw new Error("NFS helper checksum mismatch");
  const bytes = Buffer.from(binary.bytes);
  const architectureMatches = os === "linux"
    ? bytes.subarray(0, 6).equals(Buffer.from([0x7f, 69, 76, 70, 2, 1])) && bytes.readUInt16LE(18) === (arch === "arm64" ? 183 : 62)
    : bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === (arch === "arm64" ? 0x0100000c : 0x01000007);
  if (!architectureMatches) throw new Error("NFS helper executable architecture mismatch");
  if (!Buffer.from(file("LICENSE-nfsserve").bytes).toString().includes("Redistribution")) throw new Error("NFS license missing");
}

interface CargoLicenseMetadata {
  packages: { id: string; name: string; version: string; license: string | null; manifest_path: string }[];
  resolve: { root: string; nodes: { id: string }[] };
}

/** Include build dependencies too; no license text is fetched outside locked Cargo sources. */
export function nfsDependencyNotices(metadata: CargoLicenseMetadata, rustDocs: string): string {
  const resolved = new Set(metadata.resolve.nodes.map((node) => node.id));
  const packages = metadata.packages.filter((pkg) => resolved.has(pkg.id) && pkg.id !== metadata.resolve.root)
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, "en"));
  if (!packages.length) throw new Error("Missing NFS dependency license metadata");
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  // Audited expressions in the pinned lockfile; new license terms require review.
  const reviewed = new Set(["MIT", "BSD-3-Clause", "MIT OR Apache-2.0", "Apache-2.0 OR MIT",
    "MIT/Apache-2.0", "Unlicense OR MIT", "Apache-2.0 OR BSL-1.0", "(MIT OR Apache-2.0) AND Unicode-3.0"]);
  const notices = packages.map((pkg) => {
    if (!pkg.license || !reviewed.has(pkg.license)) throw new Error(`Unreviewed NFS license: ${pkg.name}: ${pkg.license}`);
    const directory = dirname(pkg.manifest_path);
    const files = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^(license|copying|unlicense|notice)([-.]|$)/i.test(entry.name))
      .map((entry) => entry.name).sort();
    if (!files.length) throw new Error(`Missing license texts for ${pkg.name}@${pkg.version}`);
    if (pkg.license.includes("AND Unicode-3.0") && !files.includes("LICENSE-UNICODE")) {
      throw new Error(`Missing Unicode license text for ${pkg.name}`);
    }
    const texts = files.map((name) => {
      const text = readFileSync(join(directory, name), "utf8");
      if (!text.trim()) throw new Error(`Empty license text for ${pkg.name}: ${name}`);
      return `${name}\n${text}`;
    });
    return `<h2>${escape(`${pkg.name} ${pkg.version} (${pkg.license})`)}</h2><pre>${escape(texts.join("\n\n"))}</pre>`;
  });
  const rust = readFileSync(join(rustDocs, "COPYRIGHT-library.html"), "utf8");
  if (!rust.includes("</body>")) throw new Error("Missing Rust standard library copyright notices");
  const licenses = ["Apache-2.0.txt", "MIT.txt"].map((name) =>
    `<h2>Rust ${name}</h2><pre>${escape(readFileSync(join(rustDocs, "licenses", name), "utf8"))}</pre>`);
  return rust.replace("</body>", `<h1>atlcli NFS helper Cargo dependencies</h1>\n${notices.join("\n")}\n${licenses.join("\n")}\n</body>`);
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
  const metadata = JSON.parse(run(["cargo", "+1.92.0", "metadata", "--locked", "--offline", "--format-version", "1",
    "--filter-platform", target, "--manifest-path", join(crate, "Cargo.toml")]));
  const notices = nfsDependencyNotices(metadata, join(run(["rustc", "+1.92.0", "--print", "sysroot"]), "share/doc/rust"));
  const receipt = {
    noticesSha256: sha256(Buffer.from(notices)),
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
  writeFileSync(join(destination, "THIRD-PARTY-nfs.html"), notices);
  writeFileSync(join(destination, "nfs-helper-build.json"), `${JSON.stringify(receipt, null, 2)}\n`);
}

if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error("Usage: bun scripts/build-nfs-helper.ts <empty-output-directory>");
  buildNfsHelper(process.argv[2]!);
}
