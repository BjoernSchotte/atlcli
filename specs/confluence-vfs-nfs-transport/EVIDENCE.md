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


## Slice 33 — reuse comment listings within the metadata freshness window

Slice 32's macOS WebDAV warm workload repeatedly fetched six comment documents
solely to determine their exact file sizes. Comment reads now reuse the existing
attachment-listing cache mechanism: concurrent request sharing, expiry after
successful completion using the configured metadata TTL (default 60 seconds),
256 retained page listings per kind, and immediate eviction of failed requests.
The cache belongs to the current VFS instance and is not persisted. Rendering
still uses the current page node. This bounds retained listing count, not total
comment payload bytes; it does not complete the overall memory-bound acceptance.

Three regressions cover concurrent and sequential reads, external comment
changes at the exact TTL boundary, transient failure recovery, and eviction
after 256 pages. Existing attachment expiry/write-invalidation coverage passes
through the shared implementation. The NFS directory regression again proves
zero additional backend requests for an immediate repeated listing.

Validation: 384 relevant core/adapter/HTTP tests / 1,192 assertions on macOS;
56 targeted tests / 340 assertions on Linux; typecheck passed. Both hosts ran
five cold and warm native mounts per transport with exact full-file comparison.
All twenty warm phases across the two hosts made zero backend requests; this
is now an executable assertion in the benchmark. Mac WebDAV cold requests were
46, NFS 64; Linux WebDAV 82, NFS 64. No wall-time improvement is claimed from
these runs, which overlapped other validation. The checked-in Slice 32 raw
measurements remain the earlier baseline, not measurements of this cache fix.
Linux live DOCSY RO lifecycle also passed all five cases / 61 assertions.

The preceding Slice 32 CI run [35161723588](https://github.com/BjoernSchotte/atlcli/actions/runs/35161723588)
completed successfully, including all four native Unix platform lanes. This is
CI evidence for ab059b16, not a claim about the subsequent Slice 33 commit.
Cold hierarchy GETATTR costs, full performance gates and RW acceptance remain
open. All native test mounts detached normally; no live content was changed.


## Slice 34 — GETATTR timestamp follows the materialized current page body

A failing regression demonstrated that cold GETATTR could pair version 2's byte
size with version 1's modification time. The REST client discarded the version
timestamp, and the page store therefore retained the older listing timestamp.
The client now preserves valid v1 version.when / v2 version.createdAt values as
optional lastModified; both individual and bulk body loads propagate it into
the index and generated Markdown without additional API requests.

For current page files and page aliases, NFS obtains modification time from the
same generated bytes used for its exact size, using the existing frontmatter
parser. It does not re-stat mutable metadata after reading. Missing/invalid
version timestamps retain the previous fallback; historic/generated-file
attribute semantics and multi-READ version snapshots are not solved by this
slice. No write support or changed cache freshness is implied.

Coverage includes the initially failing stale-listing/new-body case, a simulated
index change after materialization, bulk-prefetch metadata, REST timestamp
mapping, and seconds/nanoseconds in an actual Rust/TCP GETATTR reply. Validation:
474 relevant client/core/adapter/HTTP tests / 1,479 assertions on macOS;
140 targeted tests / 603 assertions on Linux. Wire suite: macOS 8 tests / 292
assertions (three kernel tests skipped in that invocation), Linux 11 tests / 305
assertions including single-space, combined-space and attachment kernel mounts.
The macOS native benchmark independently passed all five cold/warm mounts per
transport with exact bytes and zero warm backend requests. Linux live DOCSY RO
CLI lifecycle passed five cases / 61 assertions. All test mounts detached;
no live content was changed. Typecheck passed.

Slice 33's [CI run 35162120066](https://github.com/BjoernSchotte/atlcli/actions/runs/35162120066)
also passed all four native Unix lanes. That run predates Slice 34 and is not
proof of the new timestamp change.


## Slice 35 — propagate stale metadata handles and correct PATHCONF limits

Two actual-wire regressions failed against the previous helper. ACCESS returned
NFS3_OK for a deleted object because the vendored handler swallowed getattr's
STALE result; FSSTAT and PATHCONF used the same error-swallowing pattern. All
three now return the original failure status with absent post-op attributes.
The regression checks each error union's status, attribute discriminator and
exact eight-byte body. This affects expired objects within a live session, in
addition to the separately tested stale-session filehandle protection.

PATHCONF also reported name_max=32768 while the Bun adapter already enforced
255 bytes. The reply now reports 255 with no_trunc=true, and oversized names
produce NFS3ERR_NAMETOOLONG rather than INVAL. The real-wire check covers
256-byte ASCII, 128 two-byte Unicode characters, and a legal 255-byte name
returning NOENT rather than a length error. The audited vendor patch notes link
[RFC 1813](https://www.rfc-editor.org/rfc/rfc1813.html) and describe both changes.

Validation: both native hosts passed the full 13-test wire/kernel suite with
332 assertions, covering single DOCSY, combined spaces and complete attachment
reads. Fixtures were synthetic; all mounts detached normally. Rust fmt/clippy
and all four helper tests passed (clippy/tests also on Linux); TypeScript
filesystem tests passed 19 cases / 281 assertions and typecheck passed.
Linux live DOCSY RO lifecycle passed all five cases / 61 assertions without
changing live content.
No RW capability was enabled. Full RW publication, read snapshots and remaining
performance/metadata acceptance are still open.


## Slice 36 — native local advisory lock probes

The previous macOS option nolocks caused flock to fail immediately with ENOTSUP
(errno 45), reproduced in all three native mount cases. The installed
mount_nfs(8) manual distinguishes this from locallocks: the former disables
locking, while the latter handles it in the client's VFS without contacting an
NLM server. The production macOS command, command assertion, kernel fixtures
and benchmark now consistently use locallocks. Linux retains nolock, verified
against its installed nfs(5) documentation and native behavior.

Each kernel fixture now runs a bounded Python stdlib probe in a separate process
while Bun continues serving the mount. It acquires an exclusive nonblocking
flock on the readable Markdown file, proves a second process cannot acquire it,
releases it and proves a new process can acquire it. It also acquires/releases a
shared POSIX record lock. Child operations have two-second deadlines; the whole
probe has a five-second deadline. Python 3 is a native-test prerequisite only,
not a CLI runtime dependency. No writable file descriptor or remote edit is used.

Validation: all three native fixtures passed on macOS and Linux, 16 Bun assertions
per host plus Python assertions. Linux repeated the fixtures with live RO DOCSY
and DOCSY+mayflower exports (the attachment fixture remains synthetic), again
three passes / 16 assertions. All mounts detached normally. Transport command
tests passed three cases / 16 assertions; typecheck passed. No live content was
changed. The new probe also runs in the existing native-platform CI lanes.

These results cover local advisory locks on current read-only mounts. They do
not establish cross-client locking, exclusive POSIX write-lock behavior on an RW
mount, successful editor saving, or safe Confluence publication. The remaining
RW and snapshot gates are unchanged.


## Slice 37 — local indexer markers for NFS volumes

NFS now exposes the existing WebDAV empty indexer marker filenames at the volume
root, plus an empty .fseventsd directory. Their names and desktop-probe rules
are extracted into a shared dependency-free module; existing WebDAV exports
remain compatible. Synthetic NFS entries have distinct session-local handles,
fixed empty contents, correct file/directory errors and normal directory-cookie
validation. Their parent remains the export root. Common desktop metadata probes
at that root fail locally instead of resolving backend paths.

Unit coverage proves zero backend calls for marker LOOKUP/GETATTR/READ, empty
.fseventsd listing, parent traversal and absent desktop files in both single-
and multi-space exports. Root listings include the markers; real page identity,
export scoping and pagination remain covered. Native tests open the empty marker
and enumerate the empty event directory, alongside existing full reads and locks.

Validation: 21 filesystem tests / 337 assertions; both macOS and Linux passed
five pagination/native cases / 232 assertions. Five additional macOS wire
identity/attribute/error cases passed / 107 assertions. WebDAV's 41 adapter and
request-cost tests passed / 147 assertions after extraction. Linux live RO DOCSY
and DOCSY+mayflower native runs passed three cases / 22 assertions (attachment
fixture synthetic). Typecheck passed. All test mounts detached normally and no
live content changed.

These are filesystem marker/probe guarantees, not proof that all OS indexers
honor exclusions. NFS sweep diagnostics/request-accounting parity and the full
performance, snapshot and RW gates remain open.

## Slice 38 — shared distinct-file sweep diagnostics

NFS now passes successful file READs and successful client READDIRs to the same
small detector used by WebDAV. The CLI installs the same stderr callback for
both transports. Internal directory hydration/GETATTR is not a client listing.
Shield reads, invalid ranges and failed reads do not count. Repeated NFS ranges
use object identity and count once within the window.

The existing WebDAV implementation counted calls despite promising distinct
files, retained directory exemptions indefinitely and accumulated reads after
reporting. The shared implementation deduplicates files, expires listing
exemptions after 10 seconds, caps remembered directories at 4096 and clears its
state after its one warning. This remains a heuristic, not crawler prevention
or complete protocol request accounting.

Validation:
- macOS and Linux: each 65 adapter/performance tests, 494 assertions, passed.
  New regressions cover repeated ranges, metadata hydration, marker/failed reads,
  successful versus failed listings, and listing expiry.
- macOS: five real-helper wire/native tests, 232 assertions, passed, including
  single/combined exports and synthetic attachments.
- Linux: three native tests, 22 assertions, passed; DOCSY and DOCSY+mayflower used
  live read-only access; the attachment case used synthetic data.
- Typecheck: all four tasks passed. All test mounts detached normally; no live
  content was modified. The initial sandboxed HTTP run could not bind listeners;
  the authorized outside-sandbox run passed.

RW publication, snapshot decisions and remaining acceptance gates stay open.

## Slice 39 — explicit cache options and external-update visibility

Native synthetic tests on both hosts exposed a shared core bug: reopening a
cached page without relisting its directory kept the old body beyond the
metadata TTL. A core regression reproduced this before the fix. PageStore now
uses the existing requested-page metadata revalidation before a cached read.
Cloud uses the version probe; Data Center fetches a stale requested body.
Within-TTL reads still make no additional API calls.

Production NFS options now set actimeo=1 and disable negative name caching
(macOS nonegnamecache; Linux lookupcache=positive). CLI, native fixtures,
lifecycle fixtures and benchmark reuse the same option builder. The installed
macOS mount_nfs manual documents these options; native mounts accepted and
exercised them on both hosts.

The new native case first reads a page and observes ENOENT for a missing path,
then updates/creates synthetic backend pages and advances only the VFS clock
past its default 60-second TTL. It never forces index refresh or flushes kernel
caches. Both updated full bytes and the formerly absent file become visible
within its five-second deadline. This proves the post-TTL behavior through real
kernel clients, not a live Confluence propagation SLA or a multi-READ snapshot.

Validation:
- macOS core/adapter/WebDAV suite: 404 tests, 1353 assertions, passed before adding
  the second deployment-type case; final PageStore suite: 36 tests, 98 assertions.
- Linux core/transport suite: 339 tests, 859 assertions, passed; final PageStore
  suite also passed all 36 tests / 98 assertions. An initially stale Linux
  resolver test was synchronized after a checksum comparison confirmed it was
  the only differing core source/test file.
- Shell grep planner/parser: 24 tests, 97 assertions, passed.
- macOS native external-change test passed after failing before the fix; the
  existing wire/native cases passed in the preceding run.
- Linux native: four tests, 31 assertions, passed; live DOCSY and combined spaces
  remained strictly read-only, attachment/change cases were synthetic.

Five fresh cold/warm runs per transport and host used
scripts/bench/run-vfs-mount.ts. Wall times below are median [min–max] milliseconds;
API counts are identical across all five runs of each cell:

| Host | Transport | Cold ms | Warm ms | Cold/warm API |
| --- | --- | --- | --- | --- |
| macOS arm64 | WebDAV | 52.2 [49.2–67.3] | 12.0 [9.7–16.3] | 46 / 0 |
| macOS arm64 | NFS | 87.8 [81.2–95.4] | 2.9 [2.6–3.4] | 64 / 0 |
| Linux x64 | WebDAV | 84.8 [81.2–93.4] | 8.0 [7.2–9.4] | 82 / 0 |
| Linux x64 | NFS | 107.9 [103.4–128.3] | 24.0 [20.4–26.8] | 64 / 0 |

No startup body downloads and no warm API calls. Exact bytes passed every run.
The earlier >10% transport regression review remains open: this slice bounds
freshness, not the extra NFS cold directory-GETATTR work or Linux warm overhead.
Timing is synthetic, not production network performance; earlier benchmark
limitations (metadata bytes, protocol counts, RSS peak, Glow/editor timing)
remain. Raw current runs are in /tmp/atlcli-nfs-slice39-{mac,linux}.json on the Mac;
the committed baseline files still describe Slice 32.

Linux live DOCSY CLI lifecycle also passed all five cases / 61 assertions with
the new options (signal, busy, explicit detach, helper and parent crash). Final
typecheck passed all four tasks; test mounts detached normally. No live content
was modified. RW publication and snapshot acceptance remain open.

## Slice 40 — bounded journal database growth and rollback recovery

The journal foundation now uses SQLite DELETE rollback journaling with
synchronous=EXTRA/fullfsync=ON, plus max_page_count on each connection. It has one
synchronous writer and needs no WAL reader/writer concurrency. This avoids the
unbounded historical WAL accumulation possible when readers prevent checkpoints.
A journal_size_limit alone would not solve that problem.

The default database allowance is 2 × logical bytes + 8192 × maximum file count
+ 1 MiB, rounded down to complete SQLite pages (545 MiB at defaults). SQLite
transactionally rejects growth beyond it. Reopening a larger recovered database
keeps its current page count as the minimum limit; never truncate pending data.
A transaction additionally needs its rollback journal (original pages and
headers). This is a bounded database plus transactional journal design, **not**
a promise that the configured logical quota equals total physical disk usage.
No database compaction or eviction of acknowledged records was introduced.

Validation on macOS and Linux: 11 journal tests / 302 assertions passed on each.
They include 80 overwrite/publication cycles without WAL accumulation, a
database-full write that leaves the previous revision intact after reopen,
recovery after an acknowledged commit, SIGKILL during an uncommitted transaction,
and migration from a committed WAL actually left behind by a killed process.
The latter also proves recovery when the newly configured database ceiling is
lower than the recovered data. Typecheck passed all four tasks.
Linux live DOCSY read-only CLI signal/unmount E2E passed (1 test / 10 assertions);
it is regression evidence only, not journal-backed NFS write acceptance.

References checked for this change:
- [SQLite WAL checkpoint starvation](https://www.sqlite.org/wal.html)
- [SQLite synchronous, journal modes and max_page_count](https://www.sqlite.org/pragma.html)

RW bridge integration, namespace journaling and the publication/snapshot
decisions remain open. Process crashes are tested; power failures and faulty
storage are not simulated by these tests.

## Slice 41 — attachment identity across filename changes

Attachment directory entries now carry the backend ID already present in their
metadata response. NFS recovers a missing/replaced attachment path by matching
that ID within the known owner's attachment directory, validating scope and the
resulting stat before using it. A different attachment at the old filename
therefore cannot inherit the original handle. Recovery reuses the listing cache
and fetches no sibling bodies; it does not walk other pages or spaces.

Tests cover rename plus simultaneous old-name reuse, deletion, a temporary
metadata failure followed by recovery, and a move outside the export returning
STALE. The real Rust helper test retains an opaque NFS filehandle across the
rename, reads the original binary payload and confirms distinct handles for the
replacement and original object.

Validation:
- macOS and Linux: each 64 focused VFS/adapter tests, 461 assertions, passed.
- macOS: 396 core/NFS/WebDAV tests, 1331 assertions, passed.
- Both hosts: the real-helper attachment identity test passed (16 assertions);
  four native mount cases passed (31 assertions). Linux used live read-only
  DOCSY and DOCSY+mayflower for the basic cases, synthetic data for changes and
  attachments; macOS used synthetic fixtures.
- Typecheck passed all four tasks. All native mounts detached normally, and no
  live content was modified.

Independent moves to another attachment owner still need scoped ID-to-owner
resolution. Generated-view identities and the broader RW/snapshot acceptance
are not closed by this slice.

## Slice 42 — scoped attachment owner relocation

Independent attachment moves now recover through the existing Confluence
getAttachment metadata endpoint. The core validates the returned identity,
filename and owner ID, checks the owner's freshly fetched space against the
selected space, resolves that owner's path and invalidates its attachment
listing. NFS then validates the resolved identity and updates the handle's
parent/name association. No body is needed for relocation; only a later READ
downloads attachment bytes.

This extends the deliberately narrow VFS client port with the already existing
read-only metadata method and adds a scoped attachmentPath operation. Fresh
owner metadata is mandatory even when the owner was previously cached in the
allowed space. Invalid filenames/IDs fail before path construction; foreign
owners do not yield attachment bytes. Temporary errors remain retryable.

Validation:
- macOS: 398 core/adapter/WebDAV tests, 1343 assertions, passed.
- Linux: 68 focused adapter/virtual-view/client-port tests, 475 assertions, passed.
- Both platforms: five real-helper/native tests, 62 assertions, passed. Wire
  tests move the same opaque handle between owners, then outside the export,
  and verify original bytes, stable ID and STALE respectively. Basic Linux
  native cases use live DOCSY and DOCSY+mayflower read-only; all relocation
  mutations use synthetic fixtures. No live attachment was moved.
- Typecheck passed all four tasks. Native mounts detached normally.

The adapter tests additionally cover relocation between two selected spaces,
a cached owner subsequently moved outside the export, malformed backend paths
and wrong returned attachment IDs. Generated-view identities and the remaining
RW/publication/snapshot acceptance are still separate open work.

## Slice 43 — generated page-view identities and historic timestamps

The existing object-view classification now recognizes the stable IDs for a
page's comments, versions directory and individual historic versions. They
reuse the existing parent-handle recovery instead of baking the current path
into identity. Rename/reparent preserves their handles; moving the owner outside
the export makes them stale. Distinct pages remain distinct views.

Historical Markdown rendering previously inherited the current page timestamp.
It now uses the timestamp supplied for the requested historic version. NFS
GETATTR reads the same materialized historic Markdown for size and timestamp.
An omitted historic timestamp stays omitted; the adapter reports epoch rather
than claiming the current page's modification time.

Validation:
- macOS: 401 core/adapter/WebDAV tests, 1361 assertions, passed.
- Linux: 66 PageStore/adapter tests, 482 assertions, passed.
- macOS and Linux: five real-helper/native tests, 103 assertions, passed,
  including opaque comments/version handles read after their owner moved.
- Typecheck passed all four tasks. Linux basic native cases used live DOCSY
  and DOCSY+mayflower read-only; mutation fixtures and all macOS cases were
  synthetic. All mounts detached normally and no live content was modified.

The regressions check renamed/reparented views, cross-page identity separation,
foreign-owner rejection, historic bytes with a newer current page, and missing
historic timestamps. This does not resolve multi-READ snapshot publication or
the remaining RW/editor acceptance gates.

## Slice 44 — persisted Markdown rendering-format migration

The prior historical timestamp fix could be hidden indefinitely by an existing
(page ID, version) cache row. BodyCache now tags rendered Markdown with a format
revision. Schema migration adds the column transactionally; old rows default to
format zero and cannot satisfy a current read. Requested bodies are refreshed
lazily and replace the old-format row. Attachments, identity and conflict data
are not cleared. An old offline body is a cache miss until read online once.

Within the current rendering format, a page version remains immutable. A
regression also found that reinserting an existing body could evict unrelated
entries unnecessarily: admission now checks the existing row and charges only
additional bytes when replacing an older format. Same-format reinsertion only
updates access time.

Validation:
- macOS: 411 core/NFS/WebDAV/performance tests, 1392 assertions, passed.
- Linux: 55 cache/PageStore tests, 176 assertions, passed.
- Both hosts: four native mount cases, 31 assertions, passed. Linux basic cases
  used live DOCSY and combined-space read-only access; attachments/change cases
  and all macOS cases were synthetic.
- Migration test opens a legacy schema containing Markdown and an attachment,
  verifies the Markdown miss and intact attachment, replaces the old format,
  checks immutability and reopens the database.
- Typecheck passed all four tasks. Native mounts detached normally; no live
  content was modified.

This closes persisted-cache compatibility for the timestamp correction.
RW/publication/snapshot decisions and remaining acceptance work stay open.

## Slice 45 — consolidated acceptance and four-platform CI checkpoint

Source da25dabe passed CI run
[35179935477](https://github.com/BjoernSchotte/atlcli/actions/runs/35179935477).
All four native lanes completed: macOS arm64/x64 and Linux arm64/x64. These
prove helper builds/tests, companion/archive checks and synthetic native RO
mounts; they do not prove compiled-CLI mount lifecycle or RW editor saves.
Draft type/policy, documentation, privacy and draft-fast gates passed. Other
product-quality gates skipped by draft policy remain unclaimed.

Local macOS verification: all 35 build tasks passed; the combined core, mount,
shell and built-shell regression command passed 547 tests with 2327 assertions
(16 opt-in native/helper cases skipped). Typecheck passed all four tasks.
No source changed during this checkpoint.

[ACCEPTANCE.md](ACCEPTANCE.md) maps the plan requirements to evidence and remaining
work. It explicitly retains the full RW goal, unanswered publication/snapshot
choices and independent packaging/resource/performance gates. This is an audit
checkpoint, not feature completion or a release recommendation.

## Slice 46 — mutable generated-file cache attributes

NFS generated files previously inherited page metadata even when their content
changed independently (for example comments). The adapter now fingerprints the
already-materialized bytes and retains an observed-change timestamp on the
existing handle record. Same-size changes advance it; identical bytes and repeat
LOOKUP preserve it. Historic version files keep their actual version timestamps.
No extra body fetch, separate cache or persistent schema is introduced.

Validation on both macOS and Linux: 31 adapter tests, 391 assertions, passed;
four native mount cases, 31 assertions, passed. Linux basic mounts used live DOCSY
and combined spaces read-only; mutation fixtures and macOS mounts were synthetic.
Typecheck passed all four tasks. All native mounts detached normally.
The regression changes same-size generated bytes without updating page metadata
and checks timestamp stability across repeated GETATTR and LOOKUP. This proves
the adapter contract; native comment-change visibility remains a separate gate.

## Slice 47 — native same-size comment-change visibility

The native external-change regression now reads `.comments.md`, replaces a
synthetic comment with an equal-length body without changing the page version,
advances only the core clock beyond its TTL, and reopens through the OS mount.
It verifies complete byte equality, increased kernel-reported mtime and an
unchanged Confluence page version. Expected bytes are derived locally, without
warming the changed VFS body; kernel caches are neither flushed nor bypassed.
The real-time retry ceiling is five seconds.

Both macOS and Linux passed the extended native test (14 assertions each).
All mutations were synthetic; both mounts detached normally. Typecheck passed
all four tasks. This closes native generated-comment visibility for the tested
clients, not the separate arbitrary multi-READ snapshot or RW requirements.

## Slice 48 — bounded NFS handle retention

The adapter caps retained handles at 65,536 including root and volume markers.
New identities fail with ENOSPC at capacity; existing identities remain usable,
with no LRU eviction of valid client handles. Confirmed stale handles release
their identity and directory revision, and IDs remain monotonically allocated.
Directory revisions now store SHA-256 signatures rather than retained serialized
name lists. This bounds adapter entry counts; it is not a claim that every core
cache or temporary listing allocation has a total byte quota.

The regression fills the actual production limit, checks concurrent overflow,
relooks up an existing identity, invalidates one object and verifies admission
without reusing its stale ID. Both macOS and Linux passed 32 adapter tests with
400 assertions, four native cases with 36 assertions and both real-wire
READDIR/READDIRPLUS cases with 210 assertions. Typecheck passed all four tasks.
Linux basic native cases used live DOCSY/combined spaces RO; mutations and Mac
cases were synthetic. Mounts detached normally. User docs describe capacity
errors and now also reflect the already-tested attachment rename recovery.

## Slice 49 — cancellation-safe bridge response tracking

The deadline audit found that dropping a Rust bridge call at an await could
leave its oneshot sender in the pending-response map. Normal responses and the
call's own timeout removed it, but outer dispatch cancellation bypassed those
statements. A scoped Drop guard now removes the record on every exit path.
The existing semaphore permit already follows the same lifetime.

A Rust regression starts an actual bridge call, waits for registration, aborts
its task and checks both an empty pending map and all 32 permits returned.
Both macOS and Linux passed all five Rust tests, Clippy with warnings denied,
and locked helper builds. The freshly built helpers passed four native mount
cases (36 assertions) on each host. Linux basic cases were live RO; other cases
were synthetic. Native mounts detached normally. This directly tests call
cancellation; end-to-end dispatch/write-deadline fault injection remains open.

## Slice 50 — clean-source packaged Linux CLI lifecycle

Source b82673109ecdd4961f7a2f13c02abd0deba33841 was cloned into an isolated
Linux x64 checkout, dependencies installed with the frozen lockfile, and its
native companion built with `build-nfs-helper.ts`. The release-artifact builder
created a dev dry-run archive, which was extracted into a separate directory.
No release was published. The checkout remained clean after the proof.

Archive SHA-256:
`ac13289c6d817b33f6e75c4e3e8546507e673066a72db0ce67c42f90fb7318c1`.
The extracted CLI ran `wiki-nfs-cli.e2e.test.ts` with
`ATLCLI_NFS_CLI_E2E=1` and `ATLCLI_NFS_TEST_CLI` pointing to the executable.
Both helper override variables were explicitly absent, proving adjacent
companion discovery. All five scenarios passed (61 assertions): signal,
busy mount, explicit unmount, helper crash and parent crash/orphan recovery.
The mountpoint included spaces. These were live mayflower-profile DOCSY RO
reads; no wiki content was modified and mounts detached normally.

An initial run from the older copied Linux checkout also passed but carried an
old Git source identity. Only the clean-source repeat above is used as packaged
source-provenance evidence. Compiled CLI lifecycle on macOS and Linux arm64,
plus the separate RW/publication gates, remain open.

The same compiled CLI copied alone into a separate directory also passed
`wiki sh --profile mayflower --space DOCSY --mode ro -c 'test -f _index.md'`
with `ATLCLI_NFS_HELPER` unset and no adjacent helper. Local typecheck passed
all four tasks before the evidence push.

CI run [35181072816](https://github.com/BjoernSchotte/atlcli/actions/runs/35181072816)
passed on b8267310: all four native NFS platforms, draft type/policy,
documentation, privacy and draft-fast gates. Product-quality gates skipped by
draft policy are not claimed as passing. These native lanes include the recent
comment visibility, handle capacity and cancellation regressions.

## Slice 51 — retain capacity during cancelled blocking pipe writes

Rust's blocking stdout writer can outlive the async request that spawned it.
Previously, cancelling that request released its capacity permit immediately,
allowing subsequent requests to enqueue further blocking writers. The permit
now moves into the blocking writer and returns to the response wait only after
the write completes. Dropping the caller cannot bypass the 32-call bound.
Pending-response registration still cleans up immediately on cancellation.

A deterministic fault test holds the writer on a channel, aborts its async
caller, verifies that capacity remains occupied, then releases the writer and
verifies capacity recovery. The existing actual bridge-cancellation test also
checks eventual recovery after its independent stdout write completes.
Both hosts passed all six Rust tests, Clippy with warnings denied and locked
helper builds; freshly built helpers passed four native cases (36 assertions)
per host. Linux basic cases were live DOCSY/combined spaces RO; other cases
were synthetic. All mounts detached normally. The outer TCP dispatch and
response-write deadline probes remain separate open tests.

## Slice 52 — real TCP dispatch deadline fault injection

The protocol test launches the actual helper with a controlled pipe responder.
LOOKUP requires three bridge calls; the responder schedules each response after
45 seconds, below the individual 60-second bridge limit. The cumulative request
therefore reaches the production 120-second dispatch deadline while waiting for
the third response. The TCP connection must close without a reply, and independent
NULL RPCs succeed before and after the timeout. No test-only deadline override is
introduced. Response timers and child processes are cleaned up in all exits.

The test passed on macOS in 120.012 seconds and Linux in 120.017 seconds
(seven assertions each). Typecheck passed all four tasks. This covers the outer
dispatch deadline with real TCP, helper and pipe framing; the separate 30-second
response-write timeout still requires a blocked-reader fault test. No remote wiki
content is involved in this synthetic fault injection.

## Slice 53 — blocked TCP response-reader fault

A real TCP client negotiates a 4 KiB receive buffer and pipelines 32 one-MiB
attachment READs without consuming replies. After 35 seconds it drains queued
data and must observe EOF/reset, proving the blocked response write was closed
before the 60-second idle/read and 120-second dispatch limits. The test checks
that fewer than 32 reads were serviced, fewer than 32 MiB arrived, and separate
NULL RPCs work during and after the stalled connection. No production timeout
or socket tuning is changed. The subprocess is terminated and awaited on all
assertion paths.

Both hosts passed the final test with 12 assertions (macOS 35.071 seconds,
Linux 35.052 seconds). The initial macOS probe rejected a needless 1 MiB receive
buffer enlargement; removing that test-only tuning made the client portable.
Linux's live DOCSY RO signal lifecycle test also passed (10 assertions), with
normal detach, and local typecheck passed all four tasks. Synthetic attachment
bytes are used for the blocked-reader test; no wiki content was modified.

## Slice 54 — validate mount flags before startup side effects

Malformed ports previously fell back to automatic allocation in some cases;
unknown modes could silently use the configured mode. Mount startup now accepts
only explicit `ro|rw` modes and decimal ports from 0 through 65535. Missing flag
values, fractions, negatives, overflow and alternate numeric notation fail
before loading a profile, opening a cache or starting a helper. Explicit NFS
write options are rejected at the same boundary; a configured RW mode remains
checked after profile resolution. Valid WebDAV and NFS behavior is unchanged.

On both hosts the 23 existing mount/transport tests passed (145 assertions).
The final expanded subprocess matrix passed 28 invocations / 112 assertions:
22 invalid option combinations returned validation errors ahead of missing
profile errors; six valid boundary combinations reached authentication instead.
Neither group created its mountpoint or cache. macOS's first broad sandbox run
could not bind the existing local-listener test; the authorized unsandboxed run
passed. All five Linux live DOCSY RO lifecycle cases passed (61 assertions),
with normal/orphan-recovery detach. Final typecheck passed all four tasks.

## Slice 55 — isolated peak-RSS and shutdown benchmarks

The comparison now runs each transport/sample in its own process and records
native `/usr/bin/time` high-water RSS for that process and the NFS helper.
Platform units are normalized to bytes. Peaks cover the whole isolated run,
not individual cold/warm phases; native resource accounting is not an aggregate
of simultaneous process RSS. The helper's final `ps` sample is removed because
the benchmark-only timing wrapper would make that PID misleading. Shutdown time
covers normal detach, server stop and VFS close. Schema is now 2; the checked-in
JSON results replace the older baseline, which remains in Git history.

Five cold/warm runs per transport passed on each host: full byte equality,
zero warm API requests, positive native peak values and normal cleanup.
The coordinator asserts that native peaks cover observed parent RSS. An initial
Bun resourceUsage conversion exposed macOS-specific units; the final data uses
native time output for both processes instead. Final typecheck passed all tasks.

| Host / transport | Cold ms median [range] | Warm ms median [range] | Parent / helper peak MiB median | Shutdown ms median |
| --- | --- | --- | --- | --- |
| macOS WebDAV | 71.2 [67.7–71.7] | 11.8 [11.7–17.7] | 160.59 / 0 | 15.81 |
| macOS NFS | 112.2 [111.0–122.2] | 3.1 [2.9–11.4] | 173.56 / 4.61 | 15.74 |
| Linux WebDAV | 117.0 [84.7–121.1] | 8.0 [5.7–10.8] | 143.50 / 0 | 3156.43 |
| Linux NFS | 136.8 [133.7–147.8] | 23.1 [21.0–24.6] | 143.16 / 4.20 | 39.75 |

NFS startup fetched zero body payload bytes on both hosts. Linux davfs fetched
21 bytes (the visited root page), not the whole space. Cold API counts were
46/64 for WebDAV/NFS on macOS and 82/64 on Linux. Isolating each run also resets
JIT/allocator history, so timings must not be directly compared to the former
shared-process series. This corpus still triggers >10% transport reviews: NFS
is slower cold on both hosts and warm on Linux, faster warm on macOS. It does
not justify a general speed claim. Protocol counts, full HTTP-byte accounting,
Glow/editor timings and the final acceptance recommendation remain open.

## Slice 56 — FSINFO error shape and RO capability audit

The helper already overrides upstream FSINFO and advertises no unsupported
optional capabilities. The audit found a narrower vendor bug: the FSINFO failure
arm omitted mandatory post-operation attributes, so STALE yielded only four
bytes instead of the required eight. It now serializes absent attributes.
ACCESS also removes directory-only LOOKUP permission for regular files.

Real-wire regressions verify exact STALE error arms for ACCESS, FSSTAT, FSINFO
and PATHCONF; FSINFO's zero optional capabilities; READ/LOOKUP for directories
and READ-only for files; ROFS for SETATTR, WRITE, CREATE, MKDIR, SYMLINK, REMOVE,
RMDIR and RENAME; and RPC procedure-unavailable for MKNOD, LINK and COMMIT.
The mutation probes assert zero backend requests. The file ACCESS assertion
failed against the old helper and passed after rebuilding with the correction.

Final macOS and Linux runs each passed six wire/native tests with 90 assertions.
Locked builds and Clippy passed on both hosts; typecheck passed all four tasks.
Linux basic native cases used DOCSY/combined spaces live RO; mutations were
synthetic. All mounts detached normally. RW capabilities remain gated and need
fresh acceptance when the write implementation is enabled.

## Slice 57 — native directory mutation with an open cursor

A synthetic 600-child directory is enumerated through the actual kernel mount.
After reading its first entry, the backend deletes one child, renames another
and inserts a third while the cursor remains open. Only the core clock advances
past its metadata TTL; OS caches are not flushed. A completed cursor must contain
every unaffected entry exactly once. An explicit stale/invalid-cookie-related
I/O error may instead require restart. A subsequent fresh listing must match the
complete updated directory within a five-second visibility retry window.

Both macOS and Linux passed (612 assertions each, including bounded enumeration
checks). Both observed completed cursors without duplicate/unaffected omissions,
and exact fresh listings. The kernel may already have buffered entries before
the mutation; this is native cursor behavior coverage, not a claim that every
RPC occurs after the mutation. Deterministic server BAD_COOKIE rejection remains
covered separately by the READDIR/READDIRPLUS wire tests.

All mutations and mounts in this case were synthetic. Both hosts detached
normally; typecheck passed all four tasks. This adds native directory-change
acceptance without changing the pending RW or multi-READ snapshot contracts.

## Slice 58 — Glow selection through a real terminal and native mount

An opt-in native test launches the installed Glow in a Python stdlib PTY,
opens a synthetic mounted page directory, waits for `_index.md`, selects it
with Enter and verifies the rendered fixture text. The probe has a 15-second
deadline and reaps its own child; native mount cleanup uses the existing test
cleanup. It neither installs Glow nor changes user configuration.

Run the native bridge suite with `ATLCLI_NFS_KERNEL=1`,
`ATLCLI_NFS_TEST_HELPER` pointing to the built helper, and `ATLCLI_NFS_GLOW`
pointing to the installed Glow executable; filter with `--test-name-pattern
'; Glow'`. macOS used `/opt/homebrew/bin/glow` (2.1.1), Linux used
`/home/linuxbrew/.linuxbrew/bin/glow` (3.0.0).

Both hosts passed seven assertions. macOS listed the fixture in 56.0 ms and
rendered the selected document in another 1.6 ms; Linux took 52.1 ms and
17.2 ms respectively. These are single small-directory acceptance observations,
not five-run comparative performance measurements or a large-space scan claim.
All content was synthetic and both mounts detached normally. Typecheck passed
all four tasks. Comparative Glow scanning remains open.

## Slice 59 — byte-identical journal mutation retries

The shared journal mutation path previously incremented its revision even when
a repeated WRITE or same-size TRUNCATE left every byte unchanged. After a
publication acknowledgement, such a retry incorrectly made the file pending
again. The transaction now compares the resulting byte image with the stored
image and preserves its revision, publication state and unresolved error when
they are identical. Actual length/content changes still advance the revision.

The new regression failed against the previous implementation. It verifies
unchanged partial writes and truncation on initial admission, retries while an
ambiguous publication intent exists, and retries after publication plus restart.
Zero extension and subsequent shortening remain real mutations. The existing
storage-reuse stress test now changes bytes on its first iteration too, so every
iteration still exercises an actual publication.

Both macOS and Linux passed all 12 journal tests (316 assertions each), including
SIGKILL, rollback and quota recovery. Typecheck passed all four tasks. macOS
native RO mount cases and the Linux live DOCSY CLI signal lifecycle also passed.
This is byte-image idempotence, not a general solution for delayed/reordered RPCs:
an old write arriving after different newer bytes still needs replay handling in
the eventual RW transport. NFS RW remains disabled and publication/snapshot
decisions remain open.

## Slice 60 — bound directory lookup work, including failed batches

Directory metadata previously used one Promise.all over every entry. A 117-entry
fixture demonstrated 117 simultaneous LOOKUPs, independent of bridge admission
limits. Directory views now resolve names in batches of at most 32. Each batch
settles completely before propagating an error, so retrying a failed directory
request cannot leave its remaining lookups detached in the background. Ordering
and the existing directory identity/cookie calculation are unchanged.

The regression failed against the old implementation and now verifies the
32-lookup maximum, complete duplicate-free pagination of 100 seeded children,
and zero unfinished lookups after an injected immediate failure. The bound is
per directory request, not a global 32-operation bound; the bridge separately
admits at most 32 requests. This does not make core metadata storage or whole
directory materialization constant-size.

Final macOS and Linux adapter suites each passed 33 tests/506 assertions.
READDIR/READDIRPLUS wire pagination and native 600-child directory mutation
passed on both final builds (three tests/822 assertions per host). Earlier runs
in this slice also passed basic native single/combined-space, attachment and
visibility checks, including Linux live DOCSY and mayflower RO. Typecheck passed
all four tasks; mounts detached normally. Comprehensive resource/performance
acceptance remains open.

## Slice 61 — local protocol request counts and refreshed comparison

WebDAV now counts received HTTP requests at the HTTP server. The NFS listener
counts complete received RPC records before dispatch, including mount/NULL,
errors and retries; rejected incomplete/oversized records are excluded. A single
atomic integer retains no request data. Private bridge version 3 adds an explicit
counter query with one outstanding request, a five-second deadline and rejection
on helper exit. Old companions are rejected by the existing version checks.
The benchmark records startup and per-phase deltas, outside its wall-time window.

Schema-3 benchmark artifacts replace the previous series, using five isolated
cold/warm runs per transport and host with the same corpus and byte checks:

| Host / transport | Cold median ms | Warm median ms | Cold protocol requests (range) | Warm protocol requests (range) |
| --- | ---: | ---: | ---: | ---: |
| macOS WebDAV | 74.1 | 12.4 | 64–66 | 6 |
| macOS NFS | 115.3 | 3.3 | 183–186 | 0–16 |
| Linux WebDAV | 115.3 | 9.4 | 80 | 0 |
| Linux NFS | 142.4 | 23.4 | 140 | 54 |

Startup adds two/three WebDAV requests on macOS/Linux and six/eight-to-nine NFS
requests respectively. Warm Confluence API calls remain zero in every sample.
Linux NFS's warm local RPCs, versus WebDAV's local cache hit, identify local work
behind the warm regression; operation-level profiling is still needed to assign
the cost. Neither RPC counts nor these results establish a general speed win.
API metadata/HTTP overhead bytes and Glow/editor comparisons remain open.

Both hosts passed the real-wire NFS counter test, all six Rust tests, locked
builds and Clippy. macOS passed 35 HTTP tests/135 assertions and 26
framing/failure/artifact tests/149 assertions; Linux passed 47 HTTP/framing/failure
tests/226 assertions. The timeout test initially blocked inside Bun's promise
matcher before it could stop the helper; attaching an ordinary rejection handler
before stop fixes the test ordering. Final native macOS mount checks and Linux
live DOCSY CLI signal cleanup passed; all four typecheck tasks passed. Benchmark
mounts detached normally. No live content was stored in benchmark artifacts.

The plan and acceptance record also capture the user's explicit decisions for
automatic buffered saves and immutable version paths alongside live normal paths.
These preferences are resolved; their remaining implementation/proof is not.

## Slice 62 — immutable historical renderings across live changes

The new adversarial adapter test exposed a real snapshot defect: after a move
between exported spaces and removal of cached bytes, the same historical version
rendered a different current-location URL. Current and historical Markdown also
shared a cache key, making the historical representation depend on which path
was read first. Historical Markdown now has a separate `version:<pageId>` cache
namespace and contains version-owned ID/title/version/timestamp metadata only.
Current parent IDs and location URLs are omitted. Both representations remain
under the same disk quota, and page-scoped cache cleanup removes both.

Tests cover both read orders, split-UTF8 ranges with a live version update and
cross-space move between READs, removal/refetch of the cached snapshot, stable
handle/size identity, and current paths returning the changed document. The
actual Rust RPC test checks split historical bytes after the move and forced
cache miss; native macOS/Linux tests keep a descriptor open across the change
and also reopen the historical path under its new owner. Kernel read-ahead may
serve old cached bytes in the native case; the separate wire test deterministically
forces the second server READ after mutation.

macOS core/adapter regression: 374 tests, 1378 assertions passed. The initial
sandboxed run could not bind the contract-test HTTP server; its elevated rerun
passed. Linux focused core/adapter regression: 90 tests, 696 assertions passed.
Both hosts passed the adversarial wire case (28 assertions), native snapshot
case (10 assertions), and existing native mount regressions. Linux live DOCSY
source CLI signal cleanup and all four typecheck tasks passed. All snapshot
mutations were synthetic, all test mounts detached normally.

An old cached current body no longer counts as a cached historical rendering;
visit the historical path online once before offline use. Normal paths remain
live as agreed. This establishes the read-only snapshot contract; RW publication
and repeating these checks against its final implementation remain outstanding.

## Slice 63 — true save debounce and serialized shared publication

Inspection of the existing write-back path found two gaps in the requested save
buffering: its timer ran from the first write rather than the last, and removing
a pending batch before its API request completed allowed a second overlapping
update. Aliases also created separate batches for one page. The shared writer
now keys queues by page ID, waits for the full quiet window after the latest
write, and runs at most one update per page. Explicit flush waits for both queued
and in-flight batches, including writes queued while an earlier request runs.
With coalescing disabled, each write still publishes separately and in order.
Queued updates consult the current index after their predecessor completes,
avoiding a predictably stale version attempt. Existing merge/conflict behavior
is preserved; queue serialization does not silently override stale edits.

Both new timing/concurrency regressions failed against the old implementation.
Tests now cover aliases, a save at 400 ms postponing publication until 900 ms,
blocked API updates, flush lifetime, enabled/disabled bundling, and recovery of
the queue after a rejected update without hiding that rejection.

macOS core/WebDAV/shell regression passed 418 tests/1158 assertions; Linux passed
64 write-back tests/139 assertions. A new real HTTP test on Linux sent two rapid
editor PUTs to a synthetic DOCSY page through the actual Confluence client.
The API confirmed exactly one new version containing only the latest content;
the test deleted its fixture successfully (one test/five assertions). All four
typecheck tasks passed. This validates the shared publication path, not NFS RW:
the durable journal and NFS mutations still need to be connected to it.


## Slice 64 — reconcile already-applied page updates

The shared write-back path now checks the freshly fetched title and complete
storage representation before merging a stale write. If both match the requested
state, it returns the existing version without another PUT. This also works
without a cached merge base. Only outer storage whitespace is ignored: live
Confluence strips the converter's final newline. Markdown equivalence alone is
not accepted, because it could hide storage content lost by conversion.

- macOS and Linux: `bun run test packages/confluence-vfs/src/write-back.test.ts`:
  66 passed, 148 assertions each. Tests cover a successful PUT whose transport
  retry receives 409, missing-base replay, title mismatch, and serialization of
  distinct saves with coalescing enabled and disabled.
- Linux mayflower/DOCSY: `ATLCLI_WIKI_MOUNT_E2E=1 bun run test
  apps/cli/src/e2e/wiki-mount-live.e2e.test.ts --test-name-pattern "coalesces rapid"`:
  one passed, seven assertions. Two rapid HTTP PUTs produce one version; replay
  after base-cache eviction leaves that version unchanged. Synthetic page deleted
  in finally. Four macOS-only kernel cases skipped on this Linux invocation.
- The first live run correctly exposed outer-whitespace normalization; the
  corrected comparison then passed. Typecheck passed all four tasks.

This is shared-core replay reconciliation, not NFS RW acceptance. Journal-to-core
publication, ambiguous merged writes, remote edits after a lost reply, namespace
mutations and native editor saves remain open.


## Slice 65 — journal-to-core publication executor

`NfsPublisher` publishes one immutable journal intent for an existing page via
shared VFS write-back. Concurrent calls for the same page share one operation.
It resolves the current path by page ID within the selected spaces; a new optional
core write precondition verifies resolved page ID and space and prohibits implicit
creation. Read-only policy, conversion and optimistic conflict handling remain
in the core. Newer journal bytes stay pending after the older intent completes.

Invalid UTF-8 or missing/changed frontmatter identity is rejected before freezing
an intent. Failed publication keeps its intent and safe error code; a repeated
call can reconcile an already-applied update. This is an internal executor, not
a manual-publish user workflow and not yet an automatically scheduled NFS writer.
It deliberately retains stale frontmatter and conflict detection; rebasing newer
local revisions after one's own successful publication remains to be connected.

- macOS: core write-back plus publisher tests passed (71 tests); final publisher
  suite including invalid-byte and identity repair checks: six passed, 31 assertions.
- Linux: publisher suite six passed, 31 assertions.
- Linux mayflower/DOCSY live: `ATLCLI_WIKI_MOUNT_E2E=1 bun run test
  apps/cli/src/e2e/wiki-mount-live.e2e.test.ts --test-name-pattern "durable NFS journal"`:
  one passed, five assertions. Journal content reached the API, pending state
  cleared, a second clean invocation made no new version; synthetic page deleted.
  Four macOS-only kernel tests skipped in this Linux invocation.
- `bun run typecheck`: all four tasks passed.

NFS WRITE/SETATTR/COMMIT, completion-boundary scheduling, namespace operations,
recovery lifecycle and native editor acceptance remain open. The production NFS
transport still advertises RO; this executor is not yet wired to its bridge.


## Slice 66 — durable byte staging in the NFS projection

`NfsFilesystem` now accepts an optional journal and exposes byte-range write and
truncate methods for existing writable page bodies. Admission checks the core's
file mode and page identity/version, and reuses the journal's non-evictable SQLite
storage. Writes return after its durable transaction. Read and getattr serve the
same staged byte image, including incomplete UTF-8 during chunk assembly, exact
sizes and stable per-image modification times. Aliases read the same page record.

Without a journal the adapter rejects writes; read-only core files and generated
views remain protected even when a journal is supplied. This is not yet wired to
the helper's WRITE/SETATTR RPCs: the production NFS transport remains read-only.

- macOS and Linux adapter suites: 36 passed, 530 assertions each. New cases cover
  reversed byte-by-byte UTF-8 writes, truncate-to-zero, sparse extension, alias
  reads, exact size, stable mtime, invalid ranges and read-only/generated guards.
- Linux mayflower/DOCSY live publication test now writes and truncates through
  this adapter, checks local read-your-writes and size, then publishes via the
  Slice 65 executor and verifies the API version/content: one passed, seven
  assertions; synthetic page deleted. The four macOS-only kernel tests are skipped
  in that Linux invocation, not claimed as native write acceptance.
- `bun run typecheck`: all four tasks passed; `git diff --check` clean.

Remaining integration includes helper RPCs and error mapping, COMMIT/save-boundary
scheduling, lifecycle of clean admitted records (so later remote edits refresh),
rebasing newer edits, namespace mutations, recovery and native editor saves.


## Slice 67 — real WRITE/SETATTR RPCs backed by the journal

Private bridge version 4 adds bounded canonical-base64 WRITE and size-only
SETATTR forwarding. Passing a journal to the internal server constructor opts
into the helper's `staged-rw` handshake; the user CLI does not enable this mode.
Rust advertises the implemented write transfer limit (1 MiB) and default journal
file limit (64 MiB). Page attributes reflect core writability. Existing directory
and generated-file protections remain enforced in Bun.

Successful WRITE receives FILE_SYNC only after the synchronous durable journal
transaction and post-write attributes complete. That is local durability, not a
Confluence publication acknowledgement. Identical retransmissions retain the
journal revision. Quota exhaustion maps to NFS3ERR_NOSPC; unsupported SETATTR
metadata is rejected before applying an accompanying size change. COMMIT and
namespace operations remain unimplemented and are not claimed as accepted RW.

Verification:

- macOS and Linux: final real TCP/Rust/Bun WRITE/SETATTR test passed with 33
  assertions each: split UTF-8, reordered ranges, exact reads, FILE_SYNC, replay,
  growth, quota rollback, unsupported compound attributes and FSINFO limits.
- Both hosts: immutable snapshot wire regression passed; six Rust tests passed,
  helper builds and clippy with warnings denied passed.
- macOS native RO regression: six passed, 658 assertions; optional Glow skipped.
  Linux native RO plus mutation rejection: seven passed, 693 assertions; optional
  Glow skipped. Single- and multi-space roots, attachments, external changes,
  changing directories and immutable snapshots remain covered.
- macOS adapter/journal/framing suites: 54 passed, 920 assertions. Bridge fault
  suite: five passed, 11 assertions; opt-in real-helper pipe-death test skipped
  in that invocation.
- Linux mayflower/DOCSY journal-publication live test: one passed, seven
  assertions; synthetic page cleaned up. This tests adapter-to-API publication,
  not yet automatic RPC-to-API publication.
- Typecheck: all four tasks passed.

Next requirements remain COMMIT and save-boundary scheduling, clean-record
refresh, newer-edit rebasing, namespace operations, native RW permissions/editor
behavior and lifecycle recovery. Production CLI NFS remains RO until those are
validated; no native RW editor acceptance is claimed here.


## Slice 68 — COMMIT for the all-FILE_SYNC write contract

The vendored NFS dispatcher now implements COMMIT. Since every successful WRITE
already returns FILE_SYNC after durable local storage, COMMIT needs no second
flush or remote request: it validates the handle, regular-file type and offset
arithmetic, returns post-operation attributes and the current WRITE verifier.
Read-only exports return ROFS. This does not identify an editor save boundary or
mean that Confluence has received the document. PATCHES.md records that an
UNSTABLE write implementation would require a real flush hook before shipping.

- macOS and Linux real-wire suites: two selected tests, 80 assertions on each.
  Full-file and ranged COMMIT return the WRITE verifier; stale handles,
  directories and overflow fail; journal revisions and backend update counts
  remain unchanged. Existing READ/WRITE/SETATTR/RO checks in those tests pass.
- Helper builds and `cargo clippy --locked --manifest-path
  packages/confluence-nfs/Cargo.toml -- -D warnings` passed on both hosts.
- `bun run typecheck`: all four tasks passed.
- Linux mayflower/DOCSY journal-publication live regression passed (one test,
  seven assertions), with the synthetic page removed afterward.

Automatic save scheduling, native writable permissions, clean-record lifecycle,
newer-edit rebasing, namespace operations and final native editor acceptance are
still required. Production CLI remains RO; internal staged writes are not yet a
complete RW feature.


## Slice 69 — native writable ownership and Linux truncate semantics

Private bridge version 5 carries the local process UID/GID for staged exports.
Writable regular files therefore belong to the invoking user rather than root;
Rust checks numeric conversion to its u32 ownership fields. Generated files and
read-only core files retain their existing write protection.

A real Linux kernel test exposed SETATTR with `size(0)` plus
`mtime=SET_TO_SERVER_TIME`. The helper now accepts that combination and the
adapter advances mtime after a successful truncate, including unchanged sizes.
Other metadata mutations remain NOTSUPP and are rejected before size changes.
Temporary attribute diagnostics used to find the Linux issue were removed.

- macOS and Linux: native RW mount, WRITE/SETATTR/COMMIT wire regression and RO
  mutation rejection passed together: three tests, 90 assertions per host.
- The new native case mounts a synthetic export with **hard** retry semantics,
  checks local owner/mode, opens an existing page r+, truncates to zero, writes
  reordered Unicode chunks, fsyncs, compares durable journal bytes and native
  reads/size, closes and normally unmounts. It verifies zero remote updates;
  this is local stable-storage proof, not automatic publication acceptance.
- macOS adapter suite: 36 passed, 530 assertions. Both helper builds and clippy
  with warnings denied passed. Typecheck passed all four tasks.
- Linux mayflower/DOCSY adapter-to-publication live regression: one passed,
  seven assertions; synthetic page deleted. No real mayflower-space writes.

The CLI still uses RO mounts. Automatic publication, clean-record refresh,
newer-edit rebasing, editor replacement/namespace operations, recovery and final
native Vim/TextEdit acceptance remain open.


## Slice 70 — rebase saves arriving after an earlier publication

Journal schema 2 retains the source bytes of the last completed publication in a
bounded `bases` table. Completing an intent atomically moves its source into that
table without altering newer local bytes; source storage counts toward the same
journal quota. Schema-one records upgrade without inventing missing history.

For a subsequent save, the publisher merges changes from that retained local
source into the previous published result, then submits against its known server
version. It reuses current cached content when the version matches, otherwise
reads the immutable version path. The shared three-way merge preserves external
additions merged by an earlier publication. Conflicts retain staged bytes and a
safe error. The resulting current publication still uses core optimistic checks.

- macOS and Linux journal/publisher suites: 22 passed, 367 assertions each.
  Coverage includes newer bytes arriving during an in-flight update and then
  publishing successfully, preservation of previously merged external content,
  lost-reply replay of a rebased save, source persistence after reopen, schema-one
  upgrade and source-byte quota accounting.
- Linux mayflower/DOCSY live regression: one passed, nine assertions. The adapter
  stages and publishes two editor images carrying the original version header;
  each produces exactly one successive API version with expected content.
  Synthetic page deleted afterward. No live mayflower-space writes.
- Typecheck passed all four tasks. Existing SQLite-full/SIGKILL/rollback tests
  remain in the passing suite.

The scheduler, complete-save boundary, clean-record refresh, namespace saves and
final native editor/recovery acceptance remain open. Production CLI NFS is still
RO; this step does not enable automatic publication on a user mount.


## Slice 71 — automatic debounced publication through native NFS

The internal journal-enabled NFS server now schedules publication 500 ms after the
latest successful range write or truncate. A newer write resets that page's timer;
a timer waiting on an earlier publication checks that it has not been superseded.
Only one publication per page runs. Startup resumes pending images; stop cancels
idle timers, preserves pending bytes and awaits running publication and bridge
work before the caller can close the journal. Helper death also stops scheduling.
Invalid UTF-8, identity/frontmatter and NUL-filled sparse images remain local with
safe errors; remote failures retain their durable intents.

- macOS and Linux publisher suites: 12 passed, 63 assertions each. New checks
  cover the full trailing quiet window, serialized automatic follow-up saves,
  cancelled shutdown timers, resumed pending images and repaired NUL/sparse images.
- Both hosts: native RW mount plus wire regression passed (two tests, 57
  assertions each). The native test now writes valid page Markdown, fsyncs and
  waits for automatic publication to the synthetic backend; exactly one update.
  Writable test VFS instances disable the inner core debounce to avoid two waits.
- Linux mayflower/DOCSY: `ATLCLI_WIKI_MOUNT_E2E=1 ATLCLI_NFS_KERNEL=1
  ATLCLI_NFS_TEST_HELPER=... bun run test apps/cli/src/e2e/wiki-mount-live.e2e.test.ts
  --test-name-pattern "automatically publishes native NFS"`: one passed, four
  assertions. An actual hard NFS mount writes/fsyncs a synthetic page; without a
  publish command, the real API receives exactly version +1 and expected content.
  Normal unmount and synthetic-page deletion succeeded. Four macOS-only WebDAV
  cases were skipped, not counted as native NFS evidence.
- Typecheck passed all four tasks. Bridge-failure regression: six passed, 17
  assertions, including real-helper pipe closure. Its initial sandboxed run could
  not start the TCP listener; the permitted run outside the sandbox passed.

This establishes the automatic path, not a complete-document boundary: a valid
Markdown prefix can pass validation if a later WRITE is delayed beyond the quiet
window. That plan requirement remains open, as do atomic editor replacement,
clean-record refresh, pending/recovery CLI and final native editor acceptance.
The user CLI remains RO until those remaining gates are satisfied.

## Slice 72 — real VS Code autosave on macOS

VS Code 1.127.0 was exercised through its native UI against the internal staged-RW
NFS hard mount, with a synthetic DOCSY backend and a temporary editor profile.
The profile used `files.autoSave: afterDelay` and `files.autoSaveDelay: 100`.
No manual save or publish command was used for the mounted Markdown document.

- First appended paragraph: backend version 1 → 2, exactly one update.
- Three quick appended lines: version 2 → 3, exactly one further update.
- Another three lines in the same open document: version 3 → 4, exactly one
  further update. All seven appended lines remained present in final storage.
- Durable revisions progressed 2 → 4 → 6; each publication cleared pending
  work. Final error was null. The editor showed no unsaved marker/save error.
- The tested existing-file autosave path succeeded without CREATE/RENAME support.
  This does not establish atomic replacement compatibility for other editors.
- The rapid typing batches may themselves have been coalesced by VS Code; they
  do not independently prove multiple distinct autosaves inside the server's
  500 ms window. The scheduler tests in slice 71 cover that separate property.
- The temporary window and unused isolated test instance were closed; normal
  unmount and server shutdown succeeded. Normal editor settings were unchanged.

This is real macOS editor/kernel evidence with a synthetic remote backend, not
a macOS live-Confluence or Linux-editor claim. Complete-document boundaries,
atomic replacement and the remaining native editor matrix are still open.

Validation: publisher regression suite passed (12 tests, 63 assertions);
typecheck passed all four tasks. `git diff --check` passed.

## Slice 73 — durable local editor namespace

Journal schema 3 adds local editor files with bounded, unique canonical paths and
random identities. Local create/write/rename/remove reuse the existing durable
SQLite transactions and quotas. Local files are excluded from the publication
queue and `beginPublish`, including after restart. An atomic local-to-page byte
replacement preserves the existing page ID/path, base version, unresolved error
and immutable in-flight intent; the newer bytes remain pending independently.
The source removal and byte replacement commit together. Quota/size failure
rolls back both, and replacement needs no extra logical copy of the local bytes.

- macOS: journal tests 17 passed / 361 assertions; publisher tests 12 passed / 63
  assertions. Linux combined: 29 passed / 424 assertions.
- Coverage includes temporary-name isolation, path validation, identity-preserving
  rename, overwrite/remove, file-count/byte quotas, replacement rollback under a
  reduced file-size limit, restart recovery and SIGKILL after acknowledged rename
  and replacement while an older publication intent remains unresolved.
- Linux live mayflower/DOCSY native NFS automatic publication: one passed / four
  assertions; normal unmount and disposable page cleanup succeeded.
- Typecheck: all four tasks passed; diff whitespace check passed.

This is the journal prerequisite. NFS CREATE/RENAME/REMOVE routing, native atomic
editor replacement, backup-handle semantics and completion boundaries remain
open. No new CLI RW availability is claimed by this slice.

## Slice 74 — local editor files in the NFS projection

`NfsFilesystem` now resolves, lists and reads journal-backed local files with
exact sizes and stable identities across local renames. Internal create, remove
and rename methods enforce the core mode guard, selected export, content-parent
kind, filename bounds and protected metadata. Recovered local files cannot be
modified through a read-only core. Generated directories cannot hold temporary
files. Removed/overwritten local handles are retired without ID reuse.

A local-to-page replacement preserves the destination page handle/identity and
returns that page ID for publication scheduling. Writes/truncates of local files
return no publication ID, avoiding temporary-file publication timers. Temporary
names remain in the journal until replacement or explicit local removal.

- macOS and Linux projection + publisher suites: 51 passed / 632 assertions each.
  Final projection suite after handle cleanup: 39 passed / 569 assertions.
- Linux mayflower/DOCSY: projection-to-real-API E2E passed (13 assertions). After
  one ordinary journal publication, a local temporary image replaces `_index.md`;
  the same handle/page ID survives and publication increments the version once.
  Temporary bytes never enter the remote queue before replacement. Test page
  cleanup succeeded. This test calls the projection directly, not NFS RPCs.
- Typecheck and diff whitespace checks passed.

The Rust CREATE/RENAME/REMOVE hooks are not yet connected to these methods.
Native replacement and backup-handle semantics, exclusive-create replay handling,
new-page publication, opt-in trash and the complete-document gate remain open.

## Slice 75 — RENAME and REMOVE over the Rust bridge

Bridge protocol 6 connects the Rust RENAME/REMOVE hooks to the guarded projection.
Renaming a staged local image over a page schedules its automatic publication.
Local renames/removals never send remote deletes; remote page removal and remote
source rename remain explicitly disabled. Invalid UTF-8 names are rejected at
the Rust boundary and projection validation enforces filename/export limits.

- macOS and Linux real-RPC test: one passed / 31 assertions each. A durable local
  fixture is looked up over TCP, renamed locally with the same handle, refused
  when targeting generated metadata, then renamed over the page. The page handle
  survives, the temporary handle becomes stale, and exactly one automatic update
  reaches the synthetic backend. REMOVE retires a local handle but refuses the
  real page without any remote delete.
- macOS native existing-file write/fsync plus WRITE/COMMIT and RO mutation
  regressions: three passed / 92 assertions. Linux live DOCSY native autosave:
  one passed / four assertions, with normal unmount and test-page cleanup.
- Rust build, tests, strict clippy, TypeScript typecheck and whitespace checks
  passed. Both native helpers were rebuilt with protocol 6.

The test deliberately seeds the local file through the journal: CREATE is still
unconnected. Audit found that vendored EXCLUSIVE CREATE does not deserialize or
forward the verifier to its VFS hook. That must be fixed with durable replay
semantics before CREATE/native atomic-editor acceptance. This slice does not
claim that gate or complete-document publication safety.

## Slice 76 — durable EXCLUSIVE CREATE replay

The vendored handler now deserializes the eight-byte EXCLUSIVE CREATE verifier
and forwards it to the VFS hook. Bridge protocol 7 carries its exact hexadecimal
representation to the guarded projection. Journal schema 4 stores the verifier
with the local file in the creation transaction. A matching replay returns the
same identity and current bytes; a different or absent verifier returns EEXIST.
Legacy local records migrate with a null verifier and cannot be mistaken for a
successful exclusive create. Verifiers and acknowledged bytes survive SIGKILL.

- macOS: 58 journal/projection tests passed (938 assertions), followed by the
  expanded SIGKILL test (six assertions). Linux final suites: 58 / 939.
- Both hosts: real CREATE/WRITE/RENAME/REMOVE and RO protection tests passed
  (two tests / 80 assertions). The replacement test now creates its temporary
  file and writes its data over RPC instead of pre-seeding the journal. Repeated
  CREATE retains its handle and bytes; a different verifier and an existing real
  page return EXIST. Exactly one automatic page update follows replacement.
- Linux live native DOCSY autosave regression passed (one / four assertions),
  followed by normal unmount and disposable page cleanup.
- Rust tests (six), strict clippy, TypeScript typecheck and diff checks passed.
  Helpers were rebuilt on both hosts with protocol 7.

UNCHECKED/GUARDED CREATE, native post-create SETATTR/permissions, backup and
open-handle semantics, native atomic-editor testing and the complete-document
publication boundary remain open. CLI RW is still gated.

## Slice 77 — native exclusive creation and durable file attributes

The native macOS probe exposed a real failure after successful EXCLUSIVE CREATE:
it issues SETATTR with mode and server atime/mtime; the old helper rejected that
request and `open(..., "wx")` failed with EIO. Protocol 8 now carries supported
metadata-only SETATTR values. Schema 5 persists mode/atime/mtime independently of
publication revisions. Byte changes advance a stored mtime. Local removal also
removes its metadata. The projection enforces file write bits while allowing a
writable mount to restore permissions; RO core guards remain authoritative.
Content directories advertise writable permissions only in staged RW mode.

- Native macOS and Linux hard mounts now create a private 0600 temporary file,
  write/fsync it, verify its size/mode/recent mtime, and remove it normally.
  Combined native, replacement-RPC and RO protection regressions: three tests /
  95 assertions on each host.
- Journal/projection suites: 60 passed / 952 assertions on each host. Coverage
  includes restart preservation, epoch-zero atime, invalid mode rejection,
  mode-only changes excluded from publication and restoring file permissions.
  Expanded macOS SIGKILL check: seven assertions, including recovered mode/atime.
- Linux live native DOCSY automatic publication passed (one / four assertions),
  with normal unmount and disposable page cleanup. Builds, Rust tests, strict
  clippy, TypeScript typecheck and whitespace validation passed.

Only supported metadata-only mode/server-time SETATTR and existing truncate
forms are accepted. Arbitrary ownership, client-supplied timestamps and combined
size/metadata changes are still refused before mutation. UNCHECKED/GUARDED CREATE,
full native editor replacement/backup sequences and publication completion
boundaries remain open; CLI RW is not enabled by this evidence.

## Slice 78 — native atomic replacement on both kernels and live DOCSY

The native RW regression now exercises the complete closed-temporary-file path:
exclusive create, write, fsync, close, rename over `_index.md`, reopen/read, and
wait for automatic publication. Both macOS and Linux passed (19 assertions each).
The native fixture uses a 4096-byte journal budget because its former 512-byte
fault-test budget correctly rejected the additional temporary image with ENOSPC;
wire quota tests retain their original small limit.

The Linux mayflower/DOCSY E2E repeats replacement against a disposable real page
(ten assertions). Creating/writing the 0600 temporary file leaves the remote
version unchanged. Replacement is immediately readable through the mounted path,
then automatically produces exactly one new version with the complete Unicode
content and the same page ID. Pending work clears, normal unmount succeeds and
the disposable page is deleted. Typecheck and diff checks passed.

This proves the closed-temp-file native save sequence, not arbitrary editor
behavior. Renaming while a descriptor remains open, backup renames, actual
Vim/TextEdit workflows, additional CREATE variants and the document-completion
boundary for in-place writes still require implementation/acceptance.

## Slice 79 — open source descriptors survive replacement

A new regression reproduced ESTALE when writing through a temporary-file handle
immediately after renaming it over the wiki body. The projection had retired the
source handle. It now retains that handle as an alias of the existing page entry,
while preserving the canonical page handle and ID. Both handles read/write the
same staged bytes and retain the existing export/mode checks. Replacement copies
the source file attributes to the page in the same SQLite transaction as its
bytes. Alias handles remain bounded by the existing session handle limit; NFSv3
has no general close notification with which to safely reclaim them early.

- Projection/journal suites: 61 tests passed on macOS and Linux. Additional
  assertions verify private source mode/atime transfer and the unchanged canonical
  page handle. The initial new regression failed with ESTALE before the fix.
- Both native kernels: rename while the temporary descriptor is still open,
  append through that descriptor, fsync, close, and read through the destination.
  Native plus RPC regressions: two tests / 65 assertions on each host.
- Linux real DOCSY: eleven assertions passed. The post-rename append reaches the
  same page in the single automatic replacement publication, pending work clears,
  normal unmount succeeds and the disposable page is deleted.
- Linux also reran the expanded attribute SIGKILL proof (seven assertions).
  Typecheck and diff whitespace checks passed.

This fixes an open-source-descriptor save pattern. Full POSIX unlink semantics
for overwritten destination descriptors, backup sequences, native editor matrix,
additional CREATE variants and complete-document publication remain open.

## Slice 80 — actual Vim save and backup acceptance

Native regressions now invoke the installed Vim in Ex mode to edit and save the
mounted Markdown document. They use `-Nu NONE -i NONE -n` and `nomodeline` to keep
the user's configuration, viminfo and swap files out of this isolated test.
`backupskip=` prevents Vim's default `/tmp` exclusion from silently bypassing the
backup test. `backupdir=.` confines backups to the test mount; `backup` retains the
backup long enough to verify the old bytes and then explicitly remove it.
No `backupcopy` override is supplied: this proves Vim's selected strategy, not
all forced backup-rename strategies or swap-file behavior.

- macOS and Linux native sequence including Vim: one test / 25 assertions each.
  The saved document contains the new text, the backup contains the previous
  text without the new line, and the synthetic remote backend receives the save.
- Linux real DOCSY native E2E: one / 18 assertions. Vim edits a disposable page
  after native replacement; API verification shows the same page ID, exactly one
  additional version and the new Vim text. Backup removal, normal unmount and
  disposable page deletion succeeded.
- The harness verifies local readback as well as remote publication, so editor
  exit code alone cannot pass this test. Typecheck and whitespace checks passed.

TextEdit, swap-file workflows, forced rename backups, additional CREATE variants
and the complete-document publication contract remain separate open gates.
