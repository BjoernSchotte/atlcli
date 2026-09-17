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
crates/toolchains if they are not cached. The release workflow packages the native
helper with the CLI; end users do not compile it. The offline `--version` JSON reports
helper package, protocol, OS and architecture and starts no listener.

The output contains the executable, nfsserve's BSD license, `THIRD-PARTY-nfs.html`
and a build manifest with binary/notices/source-tree/Cargo-lock digests, Git
revision/dirty status and toolchain. The notices include the target-filtered locked
Cargo graph (including build dependencies), its license/copyright files, and the
pinned Rust standard-library notices. Missing texts or new license expressions
fail the build pending review; Unicode's additional license is mandatory.
The manifest identifies the actual local tree even for an uncommitted build.
This is provenance, not a signature or a byte-reproducibility certification.

Native target mapping covers macOS arm64/x64 and Linux arm64/x64 (GNU libc).
Native release-helper and packaged RO/RW mounts passed on all four architectures
in [CI run 35261770483](https://github.com/BjoernSchotte/atlcli/actions/runs/35261770483),
including shell installer and real Homebrew installation, formula tests and
compiled CLI lifecycle checks. The Linux baseline is GNU libc 2.35. The Homebrew
formula update is prepared in [tap draft PR #1](https://github.com/BjoernSchotte/homebrew-tap/pull/1).
These are review bundles; no release or tap merge is performed by this feature
work. Windows continues to use WebDAV.

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
The tested Linux baseline is Ubuntu 22.04 / GNU libc 2.35 for both architectures;
musl and older libc versions are outside this initial matrix.

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
Legacy single-binary archives remain accepted for older releases. The shared
release workflow now builds native companions on the four declared Unix runners
and passes them into this builder; Windows retains its CLI-only archive. Draft
NFS CI also builds/extracts review archives, runs both offline version commands,
and uses the extracted helper for kernel tests. The shell installer is exercised
against that archive on every native lane. Each lane also installs the review
bundle through the prepared Homebrew formula in an isolated temporary tap,
executes its tests and repeats the compiled CLI lifecycle through that install.

## Compiled CLI acceptance

Place `atlcli-confluence-nfs` next to a compiled `atlcli`. Without
`ATLCLI_NFS_HELPER`, the mount command discovers this companion automatically.
The credential-free smoke test mounts against a local Confluence stand-in,
reads Unicode, rejects writes in RO, publishes RW saves and verifies signal,
busy-mount, explicit-unmount and helper-loss cleanup. It also creates a plain
Markdown page with Vim, verifies the original filename remains an alias, and
exports pending durable bytes after helper loss:

```sh
ATLCLI_VFS_TEST_BINARY=/path/to/extracted/atlcli ATLCLI_NFS_KERNEL=1 \
  bun run test apps/cli/src/e2e/wiki-sh-built.e2e.test.ts
```

All four native CI lanes run this against their extracted review archive.
The helper override is cleared inside the test to verify adjacent discovery.
It also copies the CLI into an isolated directory and verifies shell startup
with absent/unusable helpers and WebDAV without a companion. WebDAV uses a native
mount on macOS and HTTP on Linux; these cases use no tenant credentials.

For the live DOCSY lifecycle test of an extracted local bundle:

```sh
env -u ATLCLI_NFS_TEST_HELPER -u ATLCLI_NFS_HELPER \
  ATLCLI_NFS_TEST_CLI=/path/to/extracted/atlcli ATLCLI_NFS_CLI_E2E=1 \
  bun run test apps/cli/src/e2e/wiki-nfs-cli.e2e.test.ts
```

This requires the local mayflower profile and native NFS mount privileges.
The test covers normal, busy, explicit and helper-crash shutdown and cleans up
its own mounts. The `rw-save` case creates, updates and deletes an owned DOCSY
fixture; `combined` only reads DOCSY and mayflower through their separate roots.
Keep the companion and CLI on the same bridge protocol version.

## Related documents

- [Protocol patches and upstream license provenance](vendor/nfsserve/PATCHES.md)
- [Implementation and acceptance plan](../../specs/confluence-vfs-nfs-transport/PLAN.md)
- [Recorded evidence](../../specs/confluence-vfs-nfs-transport/EVIDENCE.md)


Filehandles contain a 128-bit per-process session token from the operating
system's `/dev/urandom` and the numeric object ID. The helper overrides
nfsserve's timestamp-based handle conversion; a foreign session returns STALE
before invoking Bun. Legacy 16-byte handles also return STALE. Other malformed
lengths return BADHANDLE. Failure to read the random source aborts startup before
binding. This is restart isolation, not local-user authentication; remount after
restarting the helper. No new dependency or persistent token is needed.


The public experimental `--transport nfs --mode rw` path uses the Bun-side
NfsJournal. WRITE/COMMIT acknowledge durable local bytes; valid snapshots publish
automatically after the 500 ms quiet window. Intermediate versions are possible
for delayed multipart saves. `--sync-writes` is rejected for NFS. Plain new
Markdown files need no frontmatter and retain their original path as a virtual
alias after publication. See the [VFS guide](../../docs/agents/confluence-vfs.md)
for publication status, conflicts, recovery export and opt-in trash.
Its default logical limits are 256 MiB of staged/intent bytes, 64 MiB per file,
and 4,096 files; IDs and paths are limited to 256 and 4,096 UTF-8 bytes. Existing
recovered records remain readable when limits are reduced. Unresolved publication
errors survive subsequent local edits until a publication is confirmed.

SQLite uses DELETE rollback journaling, synchronous=EXTRA and fullfsync=ON.
The database page limit defaults to 2 × the logical byte quota + 8 KiB per
allowed file + 1 MiB of schema/rounding allowance (545 MiB with defaults).
SQLite rejects database growth beyond that limit transactionally. One
transaction's rollback journal temporarily needs additional disk space for
original pages and journal headers; the limit is **not** a total filesystem-byte
quota. Rollback journaling avoids accumulation of old WAL transactions pinned
by readers. Successful commits remove the rollback journal.

Reopening an existing larger database preserves it and adopts its current page
count as the minimum ceiling, rather than truncating acknowledged data. Old WAL
databases are recovered and converted by SQLite; a reader preventing conversion
causes startup to fail. The maximum-page setting is applied on every open.
Tests cover database-full rollback, repeated updates, SIGKILL after commit,
SIGKILL during an uncommitted transaction, and migration of a committed WAL left
by SIGKILL. These process-crash tests do not simulate power loss or faulty disks.
