import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deterministicTarGz } from "./release-archive.js";

const installer = resolve(import.meta.dir, "../public/install.sh");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "atlcli-installer-"));
  const mockBin = join(root, "mock-bin");
  mkdirSync(mockBin);
  // Exercise the real installer and system tar without contacting a release server.
  writeFileSync(join(mockBin, "curl"), `#!/bin/bash
if [ "$1" = -fsSL ] && [ "$2" = -o ]; then
  cp "$INSTALL_FIXTURE/archive.tar.gz" "$3"
else
  cat "$INSTALL_FIXTURE/checksums.txt"
fi
`, { mode: 0o755 });
  const installDir = join(root, "install with spaces");
  const env = { ...process.env, HOME: root, SHELL: "", ATLCLI_INSTALL: installDir,
    INSTALL_FIXTURE: root, PATH: `${mockBin}:${process.env.PATH}` };
  return { root, bin: join(installDir, "bin"), env,
    archive(bytes: Uint8Array, checksum?: string) {
      writeFileSync(join(root, "archive.tar.gz"), bytes);
      const digest = checksum ?? createHash("sha256").update(bytes).digest("hex");
      writeFileSync(join(root, "checksums.txt"), `${digest}  atlcli-${process.platform}-${process.arch}.tar.gz\n`);
    },
    run: () => spawnSync("bash", [installer, "v-test"], { env, encoding: "utf8" }),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
const cli = { path: "atlcli", bytes: Buffer.from("#!/bin/sh\nprintf 'test CLI\\n'\n"), mode: 0o755 };
const companion = ["atlcli-confluence-nfs", "LICENSE-nfsserve", "THIRD-PARTY-nfs.html", "nfs-helper-build.json"]
  .map((path) => ({ path, bytes: Buffer.from(path === "atlcli-confluence-nfs" ? "#!/bin/sh\nprintf 'test helper\\n'\n" : "fixture"), mode: 0o644 }));

test("installer carries the companion and removes it on a CLI-only downgrade", () => {
  const f = fixture();
  try {
    f.archive(deterministicTarGz([cli, ...companion]));
    const installed = f.run();
    expect(installed.status, installed.stderr).toBe(0);
    expect(spawnSync(join(f.bin, "atlcli-confluence-nfs"), { encoding: "utf8" }).stdout).toBe("test helper\n");
    expect(readFileSync(join(f.bin, "THIRD-PARTY-nfs.html"), "utf8")).toBe("fixture");
    writeFileSync(join(f.bin, "keep-user-file"), "keep");
    f.archive(deterministicTarGz(cli));
    expect(f.run().status).toBe(0);
    for (const entry of companion) expect(existsSync(join(f.bin, entry.path))).toBe(false);
    expect(readFileSync(join(f.bin, "keep-user-file"), "utf8")).toBe("keep");
  } finally { f.close(); }
});

test("installer rejects missing or corrupt checksums and unexpected files before replacing the CLI", () => {
  const f = fixture();
  try {
    f.archive(deterministicTarGz(cli));
    expect(f.run().status).toBe(0);
    for (const checksum of ["", "0".repeat(64)]) {
      f.archive(deterministicTarGz(cli), checksum);
      expect(f.run().status).not.toBe(0);
      expect(readFileSync(join(f.bin, "atlcli"))).toEqual(cli.bytes);
    }
    f.archive(deterministicTarGz([cli, { path: "unwanted", bytes: Buffer.from("no"), mode: 0o644 }]));
    expect(f.run().status).not.toBe(0);
    expect(existsSync(join(f.bin, "unwanted"))).toBe(false);
    symlinkSync(join(f.root, "outside"), join(f.root, "atlcli"));
    const archive = join(f.root, "link.tar.gz");
    expect(spawnSync("tar", ["-czf", archive, "-C", f.root, "atlcli"]).status).toBe(0);
    f.archive(readFileSync(archive));
    expect(f.run().status).not.toBe(0);
    expect(readFileSync(join(f.bin, "atlcli"))).toEqual(cli.bytes);
  } finally { f.close(); }
});

test.skipIf(!process.env.ATLCLI_INSTALL_TEST_ARCHIVE)("installs the actual native CLI bundle offline", () => {
  const f = fixture();
  try {
    f.archive(readFileSync(process.env.ATLCLI_INSTALL_TEST_ARCHIVE!));
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    for (const name of ["atlcli", "atlcli-confluence-nfs"]) {
      const version = spawnSync(join(f.bin, name), ["--version"], { env: f.env, encoding: "utf8" });
      expect(version.status, version.stderr).toBe(0);
    }
    expect(readFileSync(join(f.bin, "THIRD-PARTY-nfs.html"), "utf8")).toContain("Rust Standard Library");
  } finally { f.close(); }
}, 30_000);
