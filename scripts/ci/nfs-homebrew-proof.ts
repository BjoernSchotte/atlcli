/** Install a native review archive using the companion-aware tap's real install/test methods. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [archiveArg, formulaArg] = process.argv.slice(2);
assert(archiveArg && formulaArg, "Pass the native archive and pinned tap Formula/atlcli.rb");
const archive = resolve(archiveArg);
const source = readFileSync(formulaArg, "utf8");
const env = { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_INSTALL_CLEANUP: "1",
  HOMEBREW_NO_ANALYTICS: "1", HOMEBREW_DEVELOPER: "1",
  HOMEBREW_GIT_NAME: "atlcli acceptance", HOMEBREW_GIT_EMAIL: "acceptance@example.invalid" };
const run = (command: string, args: string[]) => execFileSync(command, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
assert(!existsSync(join(run("brew", ["--cellar"]), "atlcli-nfs-proof")), "Do not replace an existing proof installation");
const scratch = mkdtempSync(join(tmpdir(), "atlcli-brew-proof-"));
const tap = `atlcli/nfs-proof-${process.pid}`;
const name = `${tap}/atlcli-nfs-proof`;
const tapPath = join(run("brew", ["--repository"]), "Library/Taps/atlcli", `homebrew-nfs-proof-${process.pid}`);
assert(!existsSync(tapPath), "Do not replace an existing test tap");
let installing = false;
try {
  // This archive is produced and verified by the release builder in the same job.
  run("tar", ["-xzf", archive, "-C", scratch]);
  const version = /^atlcli v(\S+)/.exec(run(join(scratch, "atlcli"), ["--version"]))?.[1];
  assert(version, "Native CLI must identify its version");
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  const formula = source.replace("class Atlcli < Formula", "class AtlcliNfsProof < Formula")
    .replace(/^  version .*$/m, `  version ${JSON.stringify(version)}`)
    .replace(/^\s+url .*$/gm, `      url ${JSON.stringify(pathToFileURL(archive).href)}`)
    .replace(/^\s+sha256 .*$/gm, `      sha256 "${digest}"`)
    .replace(/^  conflicts_with .*$/m, '  keg_only "Isolated native acceptance fixture"');
  assert(formula !== source && formula.includes("class AtlcliNfsProof < Formula"));
  assert.equal(formula.slice(formula.indexOf("  def install")), source.slice(source.indexOf("  def install")),
    "The real install and test methods must remain unchanged");
  run("brew", ["tap-new", tap]);
  writeFileSync(join(run("brew", ["--repository", tap]), "Formula/atlcli-nfs-proof.rb"), formula);
  installing = true;
  run("brew", ["install", "--build-from-source", name]);
  run("brew", ["test", name]);
  const prefix = run("brew", ["--prefix", name]);
  assert(run(join(prefix, "bin/atlcli-confluence-nfs"), ["--version"]).includes("atlcli-confluence-nfs"));
  assert(readFileSync(join(prefix, "share/atlcli-nfs-proof/THIRD-PARTY-nfs.html"), "utf8").includes("Rust Standard Library"));
  execFileSync(process.execPath, ["run", "test", "apps/cli/src/e2e/wiki-sh-built.e2e.test.ts"], {
    env: { ...env, ATLCLI_VFS_TEST_BINARY: join(prefix, "bin/atlcli"), ATLCLI_NFS_KERNEL: "1" }, stdio: "inherit",
  });
  console.log(`Homebrew native proof passed: ${process.platform}-${process.arch}, CLI ${version}`);
} finally {
  try { if (installing) run("brew", ["uninstall", "--force", name]); }
  finally {
    try { if (existsSync(tapPath)) run("brew", ["untap", tap]); }
    finally { rmSync(scratch, { recursive: true, force: true }); }
  }
}
