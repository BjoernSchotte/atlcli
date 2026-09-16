# NFS transport implementation evidence

## Slice 1: bounded private pipe framing

Implemented the shared wire format in Bun and Rust: four-byte big-endian payload
length, UTF-8 JSON, 8 MiB maximum. Readers reject invalid lengths before body
allocation, detect truncated headers/bodies and sanitize malformed payload
errors. Bun consumes frames through an async generator without pulling ahead of
the consumer. Rust output serialization has a bounded writer. Cargo.lock pins
the Rust dependency graph.

Validation on macOS, 2026-09-16:

- `bun run test apps/cli/src/vfs/nfs-framing.test.ts`: 6 passed, 74 assertions.
- `cargo test --manifest-path packages/confluence-nfs/Cargo.toml`: 3 passed.
- `bun run typecheck`: 4 tasks passed.
- `ATLCLI_WIKI_MOUNT_E2E=1 bun run test apps/cli/src/e2e/wiki-mount-live.e2e.test.ts`:
  3 live DOCSY WebDAV tests passed, including create/delete cleanup; 4 native
  kernel tests intentionally skipped in this protocol-only regression run.

This is framing coverage, not yet an end-to-end Bun/Rust or NFS protocol proof.
The mount adapter, handshake, lifecycle, durable writes and packaging are still
outstanding. WP1 remains unchecked until native feasibility is demonstrated.

Environment: local Rust 1.92 toolchain available; authorized Linux test host was
unreachable during this slice. Linux acceptance remains outstanding and must be
retried; no results are inferred from local tests.

Upstream inspection found `nfsserve` 0.11.0 available. Its WRITE handler returns
FILE_SYNC and COMMIT is not implemented. NFS provides no general close event;
COMMIT is not proof of application-document completion. The user-facing choice
between locally durable automatic snapshot publication and explicit publication
is pending. Read-only implementation can proceed independently.

## Slice 2: native read-only prototype

Pinned `nfsserve` 0.11.0 and implemented a Rust loopback NFSv3 listener with a
bounded 32-call pipe bridge to the existing Bun VFS. Added versioned RO handshake,
startup timeout, EOF teardown and explicit helper lifetime. The adapter projects
single/multi-space roots, validates filenames and export boundaries, reports
exact byte sizes, and implements bounded reads and paginated directory replies.
No CLI flag exposes this prototype yet; all mutations return ROFS.

Validation on 2026-09-16:

- macOS arm64: 12 Bun tests, 250 assertions, including actual NFS RPC and a native
  DOCSY mount/read/unmount; zero failures. Native `mount_nfs` worked without sudo.
- Linux x64: helper built with `cargo build --locked`; 2 DOCSY wire/native tests,
  17 assertions passed. Native mount used the existing NFS client and sudo.
- Rust framing tests: 3 passed with the expanded locked dependency graph.
- Both native tests compared complete returned bytes with the authoritative VFS
  body and rejected a wire-level write with NFS3ERR_ROFS. Tests used RO throughout.
- Linux initially reported busy unmount immediately after Bun's convenience
  `readFile`. Explicit `open`/awaited `close` before unmount passed; the prior
  test mount was removed through normal unmount, not forced/lazy detach.
- Test processes and native mount directories were cleaned up. The existing
  user mounts were not changed.

Reproduce after building the helper (set the absolute platform-specific path):

```bash
cargo build --locked --manifest-path packages/confluence-nfs/Cargo.toml
ATLCLI_NFS_TEST_HELPER="$PWD/packages/confluence-nfs/target/debug/atlcli-confluence-nfs" \
  ATLCLI_NFS_KERNEL=1 ATLCLI_NFS_LIVE=1 \
  bun run test apps/cli/src/vfs/nfs-bridge.test.ts
```

Without `ATLCLI_NFS_LIVE=1`, the same wire/native test uses synthetic VFS data.
Without `ATLCLI_NFS_KERNEL=1`, it does not attach a kernel mount. Ordinary unit
runs skip the helper integration unless `ATLCLI_NFS_TEST_HELPER` is supplied;
mandatory helper CI is still part of WP5.

Remaining limits: CLI/state integration, recovery and failure tests, identity
changes/deletion, directory mutation while paginating, version-consistent read
snapshots, full indexer safeguards, actual native multi-space and large corpus
proof, editor writes, packaging and comparisons remain open. WP1 also still
requires the pending RW publication decision; these tests do not establish full
filesystem parity or performance advantage.

## Slice 3: CLI transport selection and shutdown

Added `--transport webdav|nfs` (default WebDAV), explicit helper discovery,
platform/client checks, current RO-only gating and platform mount commands.
NFS state records carry transport, helper PID and parent process identity;
records without a transport are treated as WebDAV. State writes use atomic
replacement. Linux reports listening until the user attaches the volume; status
checks consult the actual mount table. Dead-server records are retained while
their volume is attached. Explicit unmount signals only an identity-verified PID.

Unexpected helper exit attempts normal unmount; busy mounts preserve the parent
and state for recovery. macOS detection resolves only the local parent path:
synchronous realpath of the mounted directory can deadlock with the same Bun
process that serves NFS. The native CLI regression caught this and the initial
test mount was cleaned up through normal unmount.

Validation:

- 20 transport/platform/state tests passed (51 assertions).
- Real source CLI DOCSY mount, read, SIGTERM, unmount and state cleanup passed on
  macOS (8 assertions) and Linux (10 assertions, including explicit attachment).
- Three consecutive macOS reruns passed after fixing the synchronous lookup.
- Typecheck passed, 4 tasks. Updated CLI help and feature/agent documentation.

The CLI lifecycle test lives at `apps/cli/src/e2e/wiki-nfs-cli.e2e.test.ts` and
requires `ATLCLI_NFS_CLI_E2E=1` plus `ATLCLI_NFS_TEST_HELPER`. It performs RO-only
live DOCSY access and cleans up its own mount/cache. Full busy/crash/legacy-state
fault coverage, compiled distribution, snapshots and RW remain outstanding;
WP2 is not fully checked off by this happy-path proof.

## Slice 4: lifecycle failure coverage

Mount status now checks saved parent/helper process identities and reports an
attached volume with a dead server as orphaned. A reused PID cannot make a stale
record look healthy. Unexpected helper death yields a nonzero CLI exit after
normal cleanup, rather than reporting a successful session.

New real-process tests cover missing executables, incompatible handshake
version/mode/port, early EOF, malformed frames and helper exit after readiness.
All test helpers are terminated; failures occur before VFS access. Together with
the mount-state regression suite: 23 tests passed, 49 assertions.

Linux native DOCSY CLI tests passed for normal SIGTERM, a busy mount held by a
separate process, explicit unmount and SIGKILL of the test's own NFS helper:
4 passed, 44 assertions. Busy detach preserves the serving process and state;
retry after releasing the holder succeeds. Helper crash detaches normally and
removes the record, with exit status 1. No forced/lazy unmount was used.

The corresponding new macOS live cases are not yet certified: the current local
configuration no longer contains the previously available mayflower profile.
No configuration was overwritten to bypass this. Earlier macOS evidence remains
valid for the exact earlier slices; it does not cover these new fault cases.
Typecheck passed. Parent-crash, alias-path unmount and remaining recovery gates
are still open.

## Slice 5: required native helper CI

CI now routes NFS dependencies to a reusable Linux/macOS proof job, including
draft PRs. The aggregate requires success whenever NFS is selected and rejects
failure or an unexpected skip. Documentation-only and unrelated CLI edits avoid
this job; global/CI changes select it conservatively.

The job installs Rust 1.92.0, uses the locked dependency graph, runs rustfmt,
Clippy with warnings denied, Rust tests and an actual helper build. Bun tests
then exercise IPC, failure paths and a native read-only kernel mount against
synthetic VFS data. No Atlassian credentials or live tenant data enter CI.

Local validation: 54 CI routing/policy tests passed (620 assertions), Clippy and
rustfmt passed, and all 19 tests in the planned native job passed on macOS
(274 assertions). Typecheck passed. GitHub runner execution is checked after
pushing this workflow; local success alone is not remote CI certification.

## Slice 6: durable staging foundation

Added a non-evictable SQLite staging journal separate from BodyCache, using WAL,
FULL synchronous writes and macOS fullfsync. Admission is scoped to an explicit
profile/export identity. Byte-range edits, truncation, sparse extension and a
publication snapshot are committed transactionally. Database files are private.

An in-flight publication retains its original bytes/base version across restart.
Completing revision R advances the remote base version without overwriting or
clearing a newer staged R+1. Ambiguous/failing publication preserves both the
intent and bytes. Payload quotas reject additional data without modifying the
last acknowledged image; they do not claim to bound SQLite/WAL physical overhead.

On both macOS and Linux, 5 tests passed (27 assertions), including a child that
acknowledges bytes and an intent then is killed with SIGKILL before recovery.
Tests also cover reverse-order Unicode byte writes, zero-fill extension, version
fencing, scope mismatch and quota failure. This is process-crash recovery proof,
not a hardware power-loss simulation. The tests are added to required NFS CI.

The journal is not yet wired into NFS mutations. Remote publication policy,
rename/create durability and ambiguous API reconciliation remain outstanding;
the mount remains RO. These storage primitives apply to either pending choice
of automatic or explicit publication and do not decide that policy implicitly.

CI follow-up for slice 5: GitHub run 35147632981 completed the native NFS jobs
successfully on ubuntu-latest and macos-14.

## Slice 7: export identities and native multi-space reads

Generated virtual files now include their export path in their NFS identity;
`DOCSY/_space.json` and `mayflower/_space.json` cannot alias the same handle.
Every existing handle rechecks the resolved space, including materialized alias
targets. Deleted or identity-mismatched handles return ESTALE rather than ENOENT.
Synthetic tests verify page/directory IDs survive a rename followed by lookup at
the new path; this does not yet prove old handles survive an external move before
that lookup, so full identity acceptance remains open.

macOS synthetic native mounts and Linux live read-only mounts each passed 10
tests (189 assertions): direct DOCSY root, combined DOCSY/mayflower roots, exact
bytes, scope checks and generated-file separation. Linux initially reported a
transient busy unmount immediately after closing a read; test cleanup now retries
normal unmount for at most one second, without forced/lazy detachment. The repeat
passed and the two leftover test mounts were normally detached. Typecheck passed.

## Slice 8: paginated READDIR protocol correction

An actual TCP regression against the unmodified nfsserve 0.11.0 helper failed:
READDIR (procedure 16) repeated `.by-id` on its second page. READDIRPLUS (17)
passed. The upstream READDIR handler ignored the client's cookie by calling
`readdir_simple`, whose default always starts at zero. The patched handler now
uses the same cookie-aware VFS operation as READDIRPLUS.

The pinned crate source is included under packages/confluence-nfs/vendor/nfsserve,
with original BSD-3-Clause license, crate digest, upstream revision and a short
PATCHES.md. Only nfs_handlers.rs has functional source changes; inherited trailing whitespace
in README.md and src/rpc.rs is normalized. Reply budget
underflow and empty non-EOF replies also return TOOSMALL instead of panicking or
trapping clients in a listing loop. Directory replies are buffered before writing
so an error does not follow an already-sent success header. The adapter limits
returned entries to 256; this is not a claim that all upstream wire allocations
have been audited yet.

The tests enumerate a 32-child synthetic directory across multiple replies for
both procedures, checking every expected name exactly once. They exercise reply
budgets 0, 128, 129 and 256, plus a zero READDIRPLUS directory budget, and then
prove the same server remains usable. These tests run in required native NFS CI.
Final macOS validation: 30 NFS tests, 486 assertions, including kernel mounts.
Final Linux validation: 12 tests, 361 assertions, including live DOCSY and combined
DOCSY/mayflower RO kernel mounts. Rust format/Clippy/tests and typecheck passed.
Concurrent directory mutation/cookie invalidation still needs separate proof;
this slice establishes pagination of an unchanged directory only.

## Slice 9: directory mutation and cookie validation

Directory metadata records a monotonic, mount-local observed-change timestamp
for the sorted name/identity list. Unchanged listings retain the same timestamp.
Both native NFS directory procedures carry the cookie verifier through the Rust
adapter into Bun, where it is compared against the exact metadata list being
paginated. Changed names/identities fail with NFS3ERR_BAD_COOKIE; clients must
restart enumeration. Another client's fresh listing cannot make an old verifier
valid again. This defines explicit invalidation, not a historical snapshot of a
mutating directory. Directory timestamps describe locally observed changes, not
the remote Confluence modification time. No page bodies are needed for them.

The internal bridge version is now 2 so older helpers fail the handshake instead
of silently omitting verifier checks. The pinned crate has one default trait hook
and both handlers call it; all Confluence-specific checking remains in Bun.

Regression coverage includes rename, insertion and deletion between pages plus
a second enumeration; real TCP tests reject both a bad verifier and a previously
valid verifier after a simulated metadata-list change, for READDIR and READDIRPLUS.
macOS: 31 NFS tests, 503 assertions, including native mounts. Linux live RO tests:
13 tests, 378 assertions with single DOCSY and combined DOCSY/mayflower mounts.
Rust format/build/Clippy and typecheck passed. Actual kernel behavior during a
concurrent remote mutation, complete read snapshots, and freshness/performance
acceptance remain separate outstanding gates.

## Slice 10: bounded RPC records and XDR allocations

The pinned server previously resized vectors directly from untrusted fragment
and XDR lengths. RPC records now have a 4 MiB cumulative cap, checked before
allocation, plus a 1,024-fragment cap including empty fragments. XDR byte vectors
and u32 arrays independently reject more than 4 MiB of decoded payload before
allocation. Existing 1 MiB NFS reads fit within these limits.

Actual TCP tests send an oversized fragment header, a record crossing the limit
across fragments, 1,025 empty fragments, an excessive auth-body length and an
excessive AUTH_UNIX group count. Each connection closes within the test deadline;
a fresh NULL RPC succeeds after each case. A valid fragmented RPC with a split
header still succeeds. macOS synthetic and Linux live-RO runs each passed 14
tests with 389 assertions, including single and combined native mounts.
Typecheck and Rust format/Clippy/tests passed.

These per-record checks do not complete resource-budget acceptance: the upstream
connection count, spawned request tasks, reply queues and slow-client deadlines
still need bounds. No aggregate-memory or denial-of-service-proof claim is made.

## Slice 11: bounded connection work and real slow-client deadline

Removed upstream's per-request detached tasks and unbounded reply channel.
Each admitted TCP connection now reads one bounded record, dispatches it, and
writes its response before reading another. At most 32 connections are admitted;
excess sockets close immediately. Read/idle, handler and reply-write deadlines
are 60, 120 and 30 seconds. The shared transaction table rejects new entries at
4,096 rather than evicting active-session replay history, and disconnect releases
that session's entries. Across-connection replay reconciliation is still a write
journal requirement, not supplied by this table.

Actual wire tests fill all 32 connections, verify overflow rejection, then send
4,097 unique pipelined NULL RPCs: exactly the first 4,096 replies arrive before
capacity closes the socket, and a fresh client still works. A partial header
stalls for the real 60-second deadline on each OS while another client succeeds.
macOS: 60.019 seconds; Linux: 60.009 seconds for that test. Both hosts passed 16
tests / 396 assertions including subsequent native single/combined RO mounts.
Typecheck and Rust format/Clippy/tests passed.

Sequential processing is a deliberate bounded implementation; comparative
benchmarks must assess its impact before performance acceptance. The 30-second
blocked-response and 120-second stalled-handler deadlines are implemented but
not separately fault-injected by this slice. No RW timeout/outcome guarantee is
claimed. Prior GitHub CI runs for 30a2d73b, bb4c5cf0 and c4998729 succeeded;
no run for b70c6ad7 was visible at inspection time.

## Slice 12: native release helper and provenance

A native builder uses pinned Rust 1.92.0, locked Cargo dependencies and an explicit
Rust target. It refuses non-empty output directories, verifies the compiled
helper's offline version/protocol/architecture, and emits an executable copy,
nfsserve license and a provenance manifest. Digests cover executable, Cargo.lock
and actual Rust source/vendor tree; dirty builds are explicitly marked. This
manifest is not signed and is not a full supply-chain attestation.

Release-mode copies built on macOS arm64 and Linux x64 passed 9 targeted tests /
220 assertions per host, including actual kernel mounts, wire pagination and
malformed RPC rejection. Linux native mounts read live DOCSY and DOCSY/mayflower
through profile mayflower. Unit checks cover all four native target mappings,
unsupported platforms, mismatched helper identity and output preservation.
Typecheck, Rust formatting/Clippy and CI routing/policy tests passed.

Required native NFS CI now builds and tests the emitted release-mode copy instead
of only the Cargo debug binary. Helper-builder and archive-library edits select
this gate. CLI release archives still have their old single-binary contract;
archive verification, installer/Homebrew integration, a declared Linux libc
baseline, all architecture runners and complete dependency license notices remain
open. No release or installer mutation was performed.

## Related documents

- [Implementation plan](PLAN.md)
- [Existing mount live evidence](../confluence-virtual-filesystem/LIVE-RESULTS.md)
