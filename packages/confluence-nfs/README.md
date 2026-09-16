# Confluence NFS helper

Experimental loopback NFSv3 adapter. Confluence credentials and conversion stay
in the Bun CLI; the helper speaks the versioned private pipe protocol.

## Native development artifact

Install Rust 1.92.0 and Bun dependencies, then from the repository root:

```sh
bun scripts/build-nfs-helper.ts /tmp/atlcli-nfs-helper
/tmp/atlcli-nfs-helper/atlcli-confluence-nfs --version
ATLCLI_NFS_HELPER=/tmp/atlcli-nfs-helper/atlcli-confluence-nfs \
bun --conditions=development run --cwd apps/cli src/index.ts \
  wiki mount ~/mnt/docsy-nfs --transport nfs --profile mayflower --space DOCSY --mode ro
```

The destination must be empty. The builder uses locked Cargo dependencies and a
native target; it never downloads a helper executable. Compiling may fetch Rust
crates/toolchains if they are not cached. End users will not need a compiler once
release archive integration is complete. The offline `--version` JSON reports
helper package, protocol, OS and architecture and starts no listener.

The output contains the executable, nfsserve's BSD license and a build manifest
with binary/source-tree/Cargo-lock digests, Git revision/dirty status and toolchain.
The manifest identifies the actual local tree even for an uncommitted build.
This is provenance, not a signature or a byte-reproducibility certification.

Native target mapping covers macOS arm64/x64 and Linux arm64/x64 (GNU libc).
Currently verified here: macOS arm64 and Linux x64. The Linux baseline libc,
other architectures, complete third-party notices and CLI archive/installer/
Homebrew integration remain WP5 acceptance work; do not label these artifacts a
complete release bundle. Windows continues to use WebDAV.

## Native CI matrix

Required NFS CI builds and kernel-mounts the release-mode helper on these runners:

| Target | Runner |
| --- | --- |
| Linux x64 GNU | ubuntu-22.04 |
| Linux arm64 GNU | ubuntu-22.04-arm |
| macOS arm64 | macos-14 |
| macOS x64 | macos-15-intel |

Runner architecture is asserted before building. Successful jobs retain the
build manifest and measured OS/glibc version for seven days. These are native
checks, not cross-compilation proxies; a configured lane is not evidence that
it passed. See [GitHub runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Linux release support is being evaluated on Ubuntu 22.04's GNU libc baseline;
musl is outside this initial matrix. Final support claims require runner results.

## Review bundle build

Keep native outputs under `<helpers>/<CLI-target>`, such as
`/tmp/nfs-helpers/darwin-arm64`. The release builder can then include validated
companions without publishing anything:

```sh
bun scripts/build-nfs-helper.ts /tmp/nfs-helpers/darwin-arm64
bun scripts/release-artifacts.ts build --channel dev --dry-run \
  --target darwin-arm64 --skip-extension --nfs-helpers /tmp/nfs-helpers \
  --output /tmp/nfs-review-bundle
```

Use `linux-x64`, `linux-arm64` or `darwin-x64` on the corresponding native host.
Each helper must declare the same source commit as the CLI. Dirty helper builds
are admitted only for review (`--dry-run`); the publication verifier rejects them.
The builder validates exact companion filenames, checksum, bridge version and
ELF/Mach-O architecture. It never executes a supplied foreign-target artifact.
Legacy single-binary archives remain accepted; production workflow adoption and
complete platform/license acceptance are still pending.

## Compiled CLI acceptance

Place `atlcli-confluence-nfs` next to a compiled `atlcli`. Without
`ATLCLI_NFS_HELPER`, the mount command discovers this companion automatically.
For the live DOCSY lifecycle test of an extracted local bundle:

```sh
env -u ATLCLI_NFS_TEST_HELPER -u ATLCLI_NFS_HELPER \
  ATLCLI_NFS_TEST_CLI=/path/to/extracted/atlcli ATLCLI_NFS_CLI_E2E=1 \
  bun run test apps/cli/src/e2e/wiki-nfs-cli.e2e.test.ts
```

This requires the local mayflower profile and native NFS mount privileges.
The test covers normal, busy, explicit and helper-crash shutdown and cleans up
its own mounts. Keep the companion and CLI on the same bridge protocol version.

## Related documents

- [Protocol patches and upstream license provenance](vendor/nfsserve/PATCHES.md)
- [Implementation and acceptance plan](../../specs/confluence-vfs-nfs-transport/PLAN.md)
- [Recorded evidence](../../specs/confluence-vfs-nfs-transport/EVIDENCE.md)
