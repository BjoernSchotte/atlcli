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

## Related documents

- [Protocol patches and upstream license provenance](vendor/nfsserve/PATCHES.md)
- [Implementation and acceptance plan](../../specs/confluence-vfs-nfs-transport/PLAN.md)
- [Recorded evidence](../../specs/confluence-vfs-nfs-transport/EVIDENCE.md)
