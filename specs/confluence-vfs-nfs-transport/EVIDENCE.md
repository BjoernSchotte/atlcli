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

## Slice 13: deterministic companion archives and compiled discovery proof

The existing TAR writer now accepts one or multiple regular files, sorts their
normalized names and rejects duplicate/unsafe paths. A bounded multi-entry
inspector verifies checksums, body bounds, padding, duplicate names and exact end
blocks, rejecting links and prefixes. The existing single-binary wrapper retains
its exact-one-entry contract for release callers; this slice does not silently
relax the current release allowlist. Archive tests include empty and 513-byte
files and executable modes as well as malformed archive rejection.

Native Bun CLI binaries were built on macOS arm64 and Linux x64 and packed with
the native helper, its manifest and nfsserve license. Both platform system `tar`
implementations extracted byte-identical files; CLI --version and helper --version
ran from the extracted directories. The CLI lifecycle test now accepts
ATLCLI_NFS_TEST_CLI and can deliberately omit the helper override, proving adjacent
companion discovery. Linux passed all four compiled live-DOCSY lifecycle cases:
signal, busy directory, explicit unmount and helper crash. With archive regressions,
22 tests / 113 assertions passed. macOS passed 18 archive regressions plus two
native synthetic mounts using the extracted helper. Typecheck passed.

macOS compiled live CLI proof remains blocked by the missing local mayflower
profile (checked without exposing config contents); credentials were not changed.
Release build assembly/allowlist, installers, Homebrew and remaining architecture/
libc/license acceptance still need integration. No published release was changed.

## Slice 14: companion admission in the actual release builder

`release-artifacts.ts build --nfs-helpers <root>` now loads each Unix target's
companion directory and validates exact filenames, helper digest, source commit,
protocol identity, ELF/Mach-O architecture and required license presence before
compiling the CLI. A missing option value fails rather than silently omitting the
helper. The release verifier also validates these companions inside TAR archives.
Historical single-binary archives and Windows remain supported. Dirty helper
artifacts are review-only: dry-run builds can admit them, publication verification
cannot. This is not a signed supply-chain attestation.

Both local native hosts built actual dry-run release archives via this integrated
path, not a separate packaging script. Linux's extracted CLI found its companion
without an environment override and passed all four live DOCSY lifecycle tests
(44 assertions). macOS's extracted CLI and helper version probes and two synthetic
native mounts passed. Packaging tests cover all target headers plus tampered
checksum, wrong source, wrong architecture, wrong protocol and full-bundle source
mismatch. Typecheck passed. Production workflow defaults, installers/Homebrew,
all-architecture native execution and complete dependency notices remain open.

## Slice 15: restore mergeability after parallel Mermaid delivery

GitHub stopped scheduling PR runs after the base branch advanced to eb94264b
(PR #204). The conflicting edit was only the tail of docs/agents/confluence-vfs.md:
the NFS notes and Mermaid section are both retained. The complete main commit,
including converter and VFS round-trip tests, is merged without replacing either
feature. 74 converter/write-back/NFS filesystem tests passed (321 assertions),
plus native macOS synthetic and Linux live single/combined read proofs and
typecheck. A fresh remote PR run must confirm mergeability after this push.

## Slice 16: four-architecture native CI matrix

Expanded required NFS proof to Linux x64/arm64 on Ubuntu 22.04 and macOS arm64/x64
on macos-14/macos-15-intel. Runner platform/architecture must match the matrix
before building. Each lane compiles its own release helper with Rust 1.92.0 and
runs the existing synthetic native-mount, wire, resource-limit and journal tests.
Successful lanes upload the build manifest and measured OS/glibc version as
short-lived evidence. No live credentials enter these jobs.

55 CI routing/policy tests passed (634 assertions). The preceding main merge is
now reported MERGEABLE by GitHub, resolving the missing CI trigger. Native results
for the new matrix remain pending until the pushed workflow executes; local
macOS arm64/Linux x64 evidence does not substitute for the two additional lanes.

## Related documents

- [Implementation plan](PLAN.md)
- [Existing mount live evidence](../confluence-virtual-filesystem/LIVE-RESULTS.md)


## Slice 17 — native matrix results and dependency notices

The four native jobs of [CI run 35153148522](https://github.com/BjoernSchotte/atlcli/actions/runs/35153148522)
passed at `f8dbd9c6`. Downloaded runtime records prove Linux x64/arm64 with
glibc 2.35, macOS arm64 14.8.9 and macOS x64 15.7.9. Each lane built and
kernel-mounted the native release helper, with synthetic credentials and no
live Confluence secrets. This proves helper coverage, not packaged CLI/installers
on all four platforms.

The native helper builder now emits `THIRD-PARTY-nfs.html`, containing license
and copyright texts from the target-filtered locked Cargo graph, build
dependencies included, plus Rust 1.92.0 standard-library notices and its MIT/Apache
texts. Previously only nfsserve's BSD license was included. New license expressions,
missing texts and missing additional Unicode terms fail the build for review.
The companion manifest hashes these notices and release admission rejects missing
or altered notices. Collection is offline after the locked native build.

Validation: packaging/archive checks, typecheck, actual native helper builds on
macOS arm64 and Linux x64. Both generated helpers passed the native single-space
and multi-space read tests (2 tests / 5 assertions per host); Linux used the live
mayflower profile, macOS used synthetic fixtures because its live profile is
unavailable. All live operations were read-only. No release was published.
The production distribution workflow and installers remain outstanding.


## Slice 18 — native companions in the release workflow

The shared release-artifact workflow now builds each Unix CLI archive on its
native runner, builds the pinned NFS helper from the same exact source SHA, and
passes the verified companion directory to the existing deterministic archive
builder. Windows remains a cross-built CLI-only ZIP on Ubuntu. Each Unix build
extracts its own archive and runs both offline version commands. Existing
SHA-bound security, bundle assembly and publication gates are retained.

Draft NFS CI exercises the same archive builder in dry-run mode on all four
native runners and mounts the helper extracted from the archive, rather than a
separate build output. This does not trigger a release. Policy tests protect the
native target mapping, companion inclusion and archive consumption.

Local validation: 55 CI policy/classification tests, typecheck, actual review
archives built and extracted on macOS arm64 and Linux x64; both offline version
commands pass. The extracted macOS helper passes two native synthetic mount
checks. The extracted Linux CLI exercises its adjacent helper automatically
against live DOCSY through the four lifecycle E2E scenarios. The Linux checkout
is the pre-existing test tree with copied implementation files, so its dry-run
receipt is not a claim of a clean PR-head release. The new four-platform archive
CI results remain to be inspected after this push; no installer or release was
published.


## Slice 19 — installer acceptance and clean-runner archive fix

CI run 35154223316 exposed a missing prerequisite in the new native archive test:
all four fresh runners failed CLI compilation because PDF font assets were absent.
The NFS workflow now runs the existing pinned `fonts:ensure` provisioning before
the archive builder; a policy assertion protects that order. This was not an NFS
protocol failure. Four-platform archive acceptance is still pending the new run.

The public shell installer now stages and checks the expected flat regular-file
set before replacing executables. It installs the matching helper/notices and
removes only known companion files on a CLI-only downgrade. Missing, malformed,
duplicate or mismatched checksums stop installation; missing checksum tooling
also fails instead of silently bypassing verification. Unexpected archive members
and symlinks are rejected before altering installed files.

Three executable installer tests / 23 assertions passed on both macOS arm64 and
Linux x64. They exercised upgrade/downgrade, a path containing spaces, preservation
of unrelated files, rejected checksums/members/symlinks, and installation plus
offline execution of both binaries from actual locally built native CLI archives.
The test replaces only the download command and uses the real installer/system
tar in a temporary home. Native NFS CI now runs this installer proof on its own
built archive. CI policy tests and typecheck passed. Homebrew's separate tap still
installs only `atlcli` and needs a companion-aware change; no tap was published.


## Slice 20 — four-platform archive acceptance and Homebrew companion

[CI run 35154749493](https://github.com/BjoernSchotte/atlcli/actions/runs/35154749493)
is green at `64ce27d8`. All four native jobs built and extracted the CLI/helper
archive, executed both binaries offline, exercised the real shell installer,
and passed protocol/native mount tests with synthetic data. This closes the
clean-runner font failure recorded in slice 19.

The Homebrew code is in a separate repository. [Tap draft PR #1](https://github.com/BjoernSchotte/homebrew-tap/pull/1)
(`94b7a0c`, preceded by `22ee27d`) updates both checked-in channel formulas and the
dev formula generator. Each installs the optional helper next to the CLI and its
license/build records in pkgshare. CLI-only archives remain supported; no version,
release URL or checksum was changed. The generated dev formula cannot regress to
installing only the CLI. Nine Ruby tests / 91 assertions and both syntax checks
pass, including actual execution of all three install methods with both fixture
layouts. A strict brew audit also found and fixed the stable formula's existing
platform/conflict declaration ordering.

Actual isolated Homebrew installs from locally built native archives passed on
macOS arm64 and Linux x64, including brew test and helper/license checks. The Mac
installed helper passed two native synthetic export tests. The Linux installed CLI,
invoked via its Homebrew opt symlink without a helper override, passed all four
live DOCSY lifecycle tests (44 assertions). Thus adjacent-helper discovery also
works through the Homebrew path. The existing macOS atlcli 0.17.1 link was retained;
the proof formula used a separate name and was kept unlinked/keg-only. Temporary
proof formulas and taps were removed on both hosts. No release or tap merge ran.
Homebrew install proof on macOS x64/Linux arm64 remains unverified.

Operational note: the first Linux brew install triggered Homebrew's default
cleanup of old package versions and download caches. This was unintended; later
commands disabled automatic cleanup. The test-enabled Linux Homebrew developer
mode was switched off during cleanup. No user CLI was unlinked or replaced.


## Slice 21 — preserve existing page handles after reparenting

A failing regression showed that an open page/body NFS handle became ESTALE after
reparenting unless a caller first looked up the new name. The adapter now reuses
the core's scoped `.by-id` resolution when an old page path disappears. It validates
the relocated identity and export membership before updating the stored path.
It probes only selected spaces, never recursively walks the export. Page directory
and body handles remain distinct and stable; `..` resolves the current parent.
Missing/out-of-export pages expire normally. Temporary errors retain the handle
for retry and a redirected foreign-space target is rejected.

Validation: 47 filesystem/core-view tests (286 assertions), including a regression
observed failing before the fix. A real Rust/TCP test moves a synthetic page in the
backend, refreshes the old parent, then READs the original opaque handle before
any lookup at the destination; it also compares directory/body handle bytes after
relocation. This and both native mount cases passed on Mac (3 tests / 24 assertions)
and Linux (with the relocation unit cases, 6 tests / 35 assertions). Linux native
mounts used live DOCSY and combined read-only spaces; the wire move used fixtures.

The new opt-in live test `ATLCLI_NFS_MOVE_E2E=1 bun run test
apps/cli/src/e2e/wiki-nfs-move.e2e.test.ts` passed on Linux (1 test / 6 assertions).
It creates two synthetic DOCSY pages, opens handles, moves one via the real API,
checks the API parent, then reads through the old handle and verifies identity.
Both created pages are deleted in finally; the test completed cleanup successfully.
No MAYFLOWER content was changed. Typecheck passed.

This slice covers page/body relocation. Folder and attachment-view relocation,
consistent version snapshots and measured external-change visibility remain WP3
work; the full WP3 checkbox stays open.


## Slice 22 — attachment metadata without content downloads

A new regression failed before the fix: NFS READDIRPLUS/getattr downloaded a full
attachment despite the core already reporting an exact size from metadata. The
adapter now uses that exact attachment size and retains body materialization for
Markdown/generated content whose size is unknown. No new cache was introduced.

The fixture is 1 MiB + 29 bytes, including UTF-8 bytes crossing the 1 MiB boundary.
Tests assert zero attachment downloads for listing/stat, correct byte size and EOF,
full byte equality across ranges, and exactly one backend download after two full
reads. Native kernel tests perform opendir/stat/readFile twice on the same fixture.
These passed on macOS (3 native tests / 13 assertions) and Linux (attachment unit
plus native tests: 4 tests / 25 assertions). Linux's other two mounts used the live
DOCSY and combined RO spaces; the large attachment case is explicitly synthetic.
All 12 filesystem tests / 201 assertions and typecheck pass. No live attachments
were created or changed by this slice. External-version snapshot consistency
remains open and is not inferred from cached repeated-read success.


## Slice 23 — do not mix separately obtained attributes into READ

The wire regression observed two body materializations per READ before the fix.
The vendored handler called GETATTR before its independent READ, so an intervening
refresh could pair attributes and bytes from different versions. It now omits the
optional post-operation attributes. A regression asserts one body read and decodes
the resulting wire layout; GETATTR still reports exact attributes independently.

Validation: all ten bridge tests (246 assertions) passed on both macOS and Linux,
including malformed RPCs, connection limits, the real 60-second stalled-client
timeout, directory pagination and three native kernel mounts. macOS used synthetic
fixtures; Linux used live DOCSY and DOCSY + mayflower read-only mounts, with the
large attachment case synthetic on both hosts. Every test mount detached normally.
Filesystem tests: 12 pass / 201 assertions. Rust: 3 tests pass; clippy with warnings
denied and repository typecheck pass. No live data was modified.

This is a bounded correction to READ response coherence, not multi-request
snapshot acceptance. Clients may issue additional GETATTR requests when READ
omits attributes; no performance improvement is claimed without comparative
measurements. Returning matching attributes atomically with bytes remains the
upgrade path. The snapshot and document-publication decisions remain open.


## Slice 24 — attachment handles follow their owning page

A failing regression reproduced ESTALE for a previously opened attachment after
its page moved. Attachment entries now retain their parent handle and basename;
on a missing old path they resolve through that parent and recheck both identity
and export scope. The attachment directory uses its page-scoped ID rather than
its old path. The implementation reuses page-handle relocation and never scans
the export. Out-of-export moves expire the attachment and directory handles.

All 13 filesystem tests (208 assertions) passed on macOS and Linux. The real
Rust/TCP relocation test now reads an old attachment handle before looking up
the moved page and checks byte equality and unchanged opaque handles. That test
and three native mount cases passed on both hosts (4 tests / 48 assertions).
Linux DOCSY and combined-space mounts used the live profile read-only; relocation
and large attachment data were synthetic. All test mounts detached normally.
Repository typecheck passed. No live content was modified.

This covers attachments following a moved page. Folder relocation and attachment
renames/moves independent of the owning page remain separate identity work.


## Slice 25 — preserve relocated subtrees when listings refresh out of order

A new regression failed because a node discovered under its new parent remained
in its old parent's cached child list. Refreshing that old directory could then
forget the relocated node and all loaded descendants. The shared TreeIndex.upsert
now detaches a changed parent association when recording the new metadata. It
retains the node's loaded subtree and performs no additional API requests. Both
page and folder fixtures cover destination-first refresh, cached old-parent
listing, subsequent old-parent refresh and retained descendant metadata.

The complete VFS core suite passed: 331 tests / 824 assertions. The initial
sandbox run could not bind its HTTP contract-test listener; the same suite
passed with the required local-network permission. Typecheck passed. Native
macOS and Linux NFS move/mount tests passed (4 tests / 48 assertions per host).
Linux's single/combined-space mounts were live and RO; synthetic fixtures
covered the wire move and large attachment.

The live DOCSY move test now also moves its synthetic page back, observing the
destination before the old parent, and verifies API parent metadata, retained
index state, readable bytes and stable handles. It passed on Linux (1 test /
11 assertions) and deleted both test pages. No MAYFLOWER writes occurred.

Folder resolution by ID when the destination has not yet been observed remains
open; this slice fixes a shared index prerequisite rather than claiming complete
folder-handle recovery.


## Slice 26 — recover moved folder directory handles by identity

The NFS adapter can now recover a folder directory handle before any lookup of
its destination. A narrow shared-core folderPath operation uses existing folder
and ancestor metadata endpoints, checks the selected space, bounds/rejects
cyclic ancestry, and rejects an inconsistent parent chain with EAGAIN. The
adapter still checks the resolved node identity and export scope. No body or
whole-space listing is requested by this recovery. Offline missing paths remain
unrecoverable; generated folder-file handles are separate unfinished work.

The live test initially exposed numeric v1 space IDs versus string v2 space IDs.
The comparison now normalizes their representation, rejects missing IDs, and
retains the space boundary. A regression covers matching and foreign IDs.
The actual folder ancestor endpoint was verified using a temporary folder under
a synthetic DOCSY page, then moving that page and resolving the old folder
handle. All fixtures were deleted, including after the initial failed attempts.

Validation: 347 core/NFS filesystem tests, 1,043 assertions; repository typecheck.
The real Rust wire test also retains a nested folder handle after moving its
ancestor. That test plus three native mount cases passed on macOS and Linux
(4 tests / 56 assertions each). Linux's expanded DOCSY live move test passed
(1 test / 13 assertions), including API metadata and exact canonical folder path.
macOS used synthetic data; Linux single/combined native mounts used live RO
spaces. All mounts detached normally. No MAYFLOWER content was modified.


## Slice 27 — generated folder metadata follows its owner

The folder directory survived relocation, but an already opened `_index.md`
metadata handle did not. The new regression failed with ESTALE before the fix.
Numeric object metadata IDs now keep object identity and reuse the same parent
handle recovery as attachments. Space-wide generated views retain their
path-qualified identities. The test reads the old metadata handle before any
lookup at the new location, checks unchanged identity and rejects access after
the owning folder moves outside the selected export.

Validation: 16 filesystem tests / 222 assertions on macOS and Linux. The wire
relocation test checks full metadata-byte equality and unchanged opaque handles;
it and three native kernel mount cases passed on both hosts (4 tests / 64
assertions). macOS used fixtures; Linux single/combined mounts used live RO
spaces. Typecheck passed. The expanded Linux DOCSY live move test reads the
existing generated metadata handle after moving its ancestor, verifies its
identity, and cleans up the temporary folder and both pages.

This slice does not claim stable handles for every generated view, independent
attachment renames, or the still-open read snapshot/publication contracts.


## Slice 28 — parent crash, orphan retention and regular recovery

The CLI lifecycle test now kills the actual recorded parent PID with SIGKILL,
waits for the helper process identity to disappear, verifies that the still
attached volume and mount record are retained with status orphaned and
serverAlive=false, then runs the public unmount command. It asserts normal
detachment and removal of state. The test touches only its own isolated DOCSY
read-only mount, without forced/lazy unmount or signalling unrelated processes.

All five source-CLI lifecycle cases passed live on Linux: normal signal, busy
mount retry, explicit unmount, helper crash and parent crash (5 tests / 61
assertions). No production change was needed for this previously uncovered
case. Typecheck passed. All test mounts and local test directories were cleaned.

A real-helper regression also closes the parent pipe after readiness, both at
a frame boundary and during a header. The helper exits without a timeout kill.
The failure suite passed on macOS and Linux (5 tests / 14 assertions each).
This proves the pipe-loss mechanism on both systems; it does not substitute for
a complete native macOS CLI parent-crash/remount acceptance test, which remains
open while the local mayflower profile is unavailable. Pending-write crash
recovery remains part of the uncompleted RW gate.


## Slice 29 — clock-independent handle generations

The pinned library's default filehandle generation is the startup wall-clock
time in milliseconds. Equal timestamps (including clock reuse) can therefore
reuse a generation. The helper now overrides the existing handle conversion
hooks with a 128-bit per-process token read from /dev/urandom, followed by the
object ID. It refuses foreign sessions before any Bun/VFS request, reports
STALE for legacy timestamp handles, and BADHANDLE for malformed lengths. The
server cookie identity also derives from the session token. Random-source
failure aborts startup before the listener binds. No dependency was added.

A deterministic Rust regression failed with the default conversion and passes
with separate session identities even when numeric object IDs are reused. It
also covers legacy and malformed handles. A real TCP test stops one helper,
starts another, rejects the old root for GETATTR and READ with STALE, asserts
zero VFS stat calls for those requests, and accepts the new root. This proves
RPC-level remount behavior; it is not a native application-held-descriptor test.

Four Rust tests passed on macOS and Linux. The complete bridge suite passed on
both hosts (11 tests / 289 assertions), including three native mount cases,
read pagination and stalled-client deadlines. Linux single/combined mounts
were live RO; macOS and large attachments used synthetic fixtures. Clippy with
warnings denied and repository typecheck passed. No live content was modified.


## Slice 30 — preserve journal uncertainty and bound empty-file admission

A new regression reproduced that truncate/write cleared REMOTE_RESULT_UNKNOWN
while its previous publication intent remained unresolved. Local edits now
preserve that warning; completing the matching publication clears it while
newer bytes remain pending. The test closes/reopens the database and verifies
both byte images, the old intent revision and warning persistence.

The byte quota alone allowed unlimited empty records and arbitrarily large
metadata. Admission now also enforces a configurable file-count cap (default
4,096), 256-byte IDs and 4,096-byte paths, rejecting NULs. Existing recovered
records remain accessible and are never replaced by readmission, even when
reopened with a smaller limit. Tests cover zero-byte files, UTF-8 metadata
limits, rejected admission and preserved acknowledged bytes. This bounds logical
records, not the database/WAL's physical storage; that RW acceptance item stays
open. No schema migration or dependency was added.

All seven journal tests passed on macOS and Linux (44 assertions each), including
SIGKILL recovery. Typecheck passed. Linux's five live DOCSY RO CLI lifecycle
cases also passed (61 assertions); those are regression evidence for the
existing mount, not proof of journal-backed remote publication. NFS remains RO.


## Slice 31 — stop enumerating unopened children for directory-entry attributes

Benchmark preparation found an avoidable hierarchy fan-out: readdir obtained
each child entry's attributes through getattr, which refreshed that child's
listing. A root with four page children therefore made five hierarchy requests
instead of one. The failing request-count regression records that exact result.
Entry attributes now use already observed directory metadata without listing
its contents. Explicit GETATTR of a directory retains its listing refresh for
cookie validation; this is not a claim that every metadata call is body-free.

The corrected cold fixture performs one hierarchy request, leaves all four
children unloaded, and performs no extra API requests for a warm repeat. Opening
one child then performs exactly one additional hierarchy request. Real Rust/TCP
pagination tests for both READDIR and READDIRPLUS verify one hierarchy request
and all 32 child directories still unloaded, alongside unchanged pagination
and BAD_COOKIE behavior.

Validation on macOS and Linux: 17 filesystem tests / 233 assertions, plus both
pagination procedures and three native mount cases (5 tests / 197 assertions).
Linux single/combined mounts used live RO spaces; macOS and attachment fixtures
were synthetic. Typecheck passed and mounts detached normally. No live content
was changed. Comparative WebDAV/NFS wall-time, byte and RSS measurements remain
open; request-count reduction alone is not a speed claim.


## Slice 32 — homepage side objects and native read comparison

A native benchmark exposed a shared VFS listing bug: homepage attachments,
versions and comments resolved directly but were absent from the space listing.
After refreshing that listing, macOS WebDAV reported ENOENT for an attachment
that it had just read; Linux davfs2 refused its initial open. The space listing
now includes those homepage side objects. HTTP regression coverage checks two
root listings, attachment discovery and exact Unicode content. The shell also
benefits from the corrected listing.

Both hosts completed five fresh mounts per transport, with cold and immediate
warm workloads: six directory listings, all 26 page bodies and a 1,300,000-byte
Unicode attachment. Every file was byte-compared against the core VFS outside
the timed region. Mounts were detached normally. Reproduce with:

```sh
ATLCLI_NFS_TEST_HELPER="$PWD/packages/confluence-nfs/target/debug/atlcli-confluence-nfs" \
bun --conditions=development scripts/bench/run-vfs-mount.ts /tmp/mount-benchmark.json
```

The Linux host requires passwordless sudo for mount/umount and installed davfs2
and NFS client tools. The davfs cache is private to the synthetic test run; its
permissions accommodate the system davfs daemon. Do not reuse that fixture
cache setup for tenant data.

| Host | Transport | Cold median ms | Warm median ms | Cold API calls | Warm API calls |
| --- | --- | ---: | ---: | ---: | ---: |
| macOS arm64 | WebDAV | 49.6 | 10.2 | 46–47 | 6 |
| macOS arm64 | NFS | 82.7 | 3.1 | 64 | 0 |
| Linux x64 | WebDAV | 75.6 | 9.4 | 82 | 0 |
| Linux x64 | NFS | 106.7 | 23.0 | 64 | 0 |

Raw synthetic measurements: [macOS](benchmark-mac.json),
[Linux](benchmark-linux.json). Startup is measured separately and includes VFS
initialization. Backend is in-process without network latency; these are not
live Confluence latency estimates. Payload bytes count page storage and
attachment downloads, excluding comments, metadata and HTTP overhead. RSS is a
final sample, not peak; VFS calls are not wire-request counts. Workload uses
128 KiB positional reads. These results do not cover Glow, editor saves or
publication, and do not fulfill the complete performance acceptance gate.

The greater-than-10% review threshold is triggered: NFS is slower cold on both
hosts and warm on Linux. Mac NFS cold enumeration makes 25 hierarchy calls vs
WebDAV's six; NFS directory GETATTR refreshes listings for cookie coherence.
Mac WebDAV warm requests are six getAllComments calls for exact file sizes.
Exposing the homepage comments view also adds one comment refresh to repeated
core NFS listings; the hierarchy regression now checks that distinction rather
than asserting zero requests across all virtual views. These costs remain
follow-up work, not a claim of a performance win.

Validation: 381 core/adapter/HTTP tests, 1,182 assertions; typecheck passed.
Linux live DOCSY read-only CLI lifecycle passed all five cases / 61 assertions
(signal, busy, explicit detach, helper crash, parent crash). Native benchmark
fixtures were synthetic on both hosts; no live content was changed.
