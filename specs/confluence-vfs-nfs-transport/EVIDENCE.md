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

## Slice 81 — native TextEdit exposes safe-save directory requirement

A real macOS TextEdit window opened `_index.md` through the native NFS mount
against an isolated synthetic DOCSY backend. The UI displayed the complete
frontmatter and baseline. Appending a test paragraph and pressing Command-S
failed; closing the modified document also triggered an automatic-save failure.
The backend stayed at version 1 with zero updates and an empty pending queue.
This is a failed acceptance test, not editor compatibility evidence.

Temporary helper diagnostics identified the first refused operation as MKDIR
for a sibling safe-save directory named `_index.md.sb-<suffix>`. The helper
currently returns ROFS for MKDIR, producing TextEdit's misleading read-only
volume message even though ordinary file writes work on this mount. A separate
experiment returning NOTSUPP for MKDIR changed the message to a generic save
failure; it did not cause TextEdit to fall back successfully. Both experimental
changes and diagnostic logging were removed, and the original helper rebuilt.

The next implementation requirement is durable local temporary directories,
including child file lookup/creation, replacement into the original page and
cleanup. These directories must remain local, share journal resource limits,
respect export/mode restrictions, and never create Confluence pages merely
because the editor stages a save. Further operations after MKDIR remain
unobserved until that first blocker is implemented; do not assume it is the
only missing operation.

Only synthetic edits were discarded through the UI. Each test document closed
and each owned mount unmounted normally; all three harness runs exited cleanly.
No user document or editor preference was changed. The successful VS Code
(Slice 72) and Vim (Slice 80) tests do not cover this TextEdit save strategy.

Linux real-DOCSY native save regression still passes (one test, 18 assertions),
including fixture cleanup. All four typecheck tasks and diff whitespace checks
passed. This slice changes evidence only; it does not mark TextEdit accepted.


## Slice 82 — durable local editor directory trees

Journal schema 6 distinguishes local files and directories while migrating all
existing local entries as files. Directories share the existing entry/database
quotas and never enter publication. Tree rename preserves descendant identities
and exclusive-create verifiers in one transaction. Nonempty removal, type
mismatches, recursive self-moves and byte writes to directories fail without
losing the acknowledged tree. Page replacement accepts file bytes only.

The filesystem projection now exposes directory attributes, children, parent
lookups, rename and empty-directory removal. Recovered directories remain
read-only in RO exports; generated views and export boundaries remain guarded.
Open descendant handles survive directory rename. Directory modes constrain
namespace changes. No extra Confluence pages are created for local staging.

- Journal/projection: 66 tests / 1,018 assertions passed on macOS and Linux.
- SIGKILL recovery now verifies a local directory and its child bytes too.
- Schema-five migration retains file identity, content and exclusive replay.
- Linux live DOCSY save regression: one test / 18 assertions, with cleanup.
- macOS native kernel save regression: one test / 25 assertions, with cleanup.
- Typecheck: all four tasks passed.

MKDIR/RMDIR wire hooks are still pending; TextEdit acceptance remains open.
This slice supplies the durable storage/projection that those hooks require.


## Slice 83 — native MKDIR and distinct RMDIR semantics

Bridge protocol 9 connects MKDIR and RMDIR to the durable local namespace.
The vendored server now forwards MKDIR attributes and distinguishes RMDIR from
REMOVE. Requested mode is committed atomically with directory creation;
unsupported attribute combinations fail before mutation. RO exports stay RO.

Native macOS and Linux both create a private 0700 directory, create/write/fsync
and read a child, reject removal while nonempty, then unlink the child and
remove the directory. RPC regression tests cover type errors, duplicate MKDIR,
unsupported modes, stale removed handles, and RO rejection. Each host passed
both focused tests (50 assertions total). Linux real-DOCSY save E2E passed all
18 assertions and cleaned up its page/mount. The journal/projection/framing
suites passed 72 tests / 1,092 assertions; Rust tests (six), clippy with warnings
as errors and all four typecheck tasks passed.

A fresh TextEdit UI attempt still failed to save, including on close; its
synthetic backend remained at version 1 with zero updates/pending records.
The local staging namespace was empty afterwards. This establishes another
unsupported save operation remains, but does not identify which one; the next
UI diagnostic must capture that operation. The test document was discarded
and the owned mount unmounted normally. TextEdit acceptance remains open.

Full macOS RPC regression also passed: 19 tests / 592 assertions, including
60-second read, blocked-reader and 120-second dispatch deadline checks.


## Slice 84 — normal and guarded CREATE

A synthetic TextEdit operation trace identified normal CREATE with mode 0644,
no size, ownership or timestamp attributes as the next refused operation.
Bridge protocol 10 now supports UNCHECKED/GUARDED creation with initial mode and
optional size. The guarded flag reaches the transactional journal instead of
using the vendored server's racy separate existence lookup. New files and initial
attributes/size commit atomically; failures roll back the entire creation.
Existing regular files retain identity and bytes when size is omitted. Explicit
size applies truncation without changing the page ID. Existing permissions,
generated views, RO mode and export confinement remain enforced.

- Native macOS/Linux plus focused RPC CREATE tests: two / 42 assertions per host.
  The native test now uses ordinary open-for-write creation inside its temporary
  directory, instead of exclusive creation only.
- Journal/projection suites: 67 / 1,026 assertions on both hosts, including failed
  creation rollback. Additional projection coverage checks original-page identity,
  read-only local modes, generated views and confinement (nine assertions).
- Linux real DOCSY save: 18 assertions, with fixture cleanup. Typecheck and clippy
  with warnings as errors passed.

TextEdit no longer reports the same read-only CREATE error, but still reports a
generic save failure. Its synthetic backend stayed unchanged. Further unsupported
save operations remain to diagnose; native TextEdit acceptance is still open.
Temporary diagnostics were removed, the test document closed, and owned mounts
unmounted normally. CREATE semantics were checked against
[RFC 1813 section 3.3.8](https://www.rfc-editor.org/rfc/rfc1813.html#section-3.3.8).


## Slice 85 — native st_mode type bits during safe save

A real synthetic TextEdit trace showed SETATTR mode 33188 (0100644): native
copyfile/chmod included file-type bits alongside permissions. The shared Rust
permission parser now strips only the file-type mask before validating supported
permissions, without changing the actual object type. SETATTR, CREATE and MKDIR
all use it. Setuid/setgid/sticky and unknown high bits remain unsupported.

- Seven Rust tests passed, including type-bit normalization and rejected special
  permissions. Wire tests cover CREATE 0100600, MKDIR 040700, SETATTR 0100600 and
  rejected SETATTR 0104644 with unchanged permissions.
- macOS and Linux: three focused RPC/native tests / 69 assertions each.
- Linux real DOCSY save regression: 18 assertions with cleanup.

After this correction, TextEdit advanced to another refused operation: RENAME
from the original `_index.md` to a temporary `_index.md.sb-...` backup. This is
the still-unimplemented existing-page-to-local-backup rename pattern, not a
failed local-temporary-to-page replacement. It also attempted CREATE of an
AppleDouble `.__index.md` metadata file, currently rejected by mount protection;
its necessity for successful save has not yet been established. TextEdit save
acceptance therefore remains open. Synthetic edits were discarded, mounts
unmounted normally and temporary diagnostics removed.


## Slice 86 — durable backup-rename reservation

Journal schema 7 adds the storage transaction needed for existing-page backup
renames. It snapshots bytes and attributes into a quota-accounted local file and
reserves the original path under the same page ID. Both happen atomically.
Displaced pages are excluded from new publication selection until replacement
clears the reservation. Already persisted intents remain intact; this does not
cancel a network request that was already in flight.

Tests cover restart, SIGKILL, retained backup bytes/attributes, unchanged page ID
and base version, replacement after an existing intent, duplicate displacement,
and complete rollback when the snapshot exceeds quota (including restoration of
an overwritten local backup entry). The reservation is bounded by admitted page
entries and the existing database cap.

- Journal/projection suites: 70 tests / 1,056 assertions on macOS and Linux.
- Native macOS save regression: 28 assertions. Linux real DOCSY: 18 assertions;
  both completed cleanup. All four typecheck tasks passed.

This is the durable-storage slice. The NFS namespace still needs to hide the
vacated path, move existing handles with the backup, bind replacement to the
reserved page, and coordinate publication. Native backup-rename/TextEdit
acceptance remains open until that integration is tested.


## Slice 87 — backup rename, recreation and real editor saves

The projection now hides a vacated page path, moves existing handles to its
local backup, and restores replacements under the original Confluence page ID.
Both temporary-file rename and ordinary/exclusive CREATE can restore the slot.
Schema 8 persists exclusive recreation verifiers across restart without
truncating acknowledged bytes on replay. Replacement invalidates stale verifiers.
The SQLite cap test uses 96 KiB because the extra schema table exceeds its old
64 KiB fixture cap; the oversized-write rollback and physical-cap assertions stay.

- macOS/Linux: 74 journal/projection tests, 1,085 assertions each.
- macOS/Linux native mount: 34 assertions each, including Vim, backup rename,
  recreation, old-handle reads and replacement under the original identity.
  Initially refusing CREATE at the reserved path broke Vim; both CREATE modes
  now have explicit regression coverage.
- Linux real DOCSY automatic save: 18 assertions, disposable fixture cleaned up.
- Publisher regression suite: 12 tests, 63 assertions, covering the trailing
  quiet window, in-flight serialization, restart and invalid-byte repair.
- All four typecheck tasks passed.

Real macOS UI validation used a synthetic backend and the native NFS mount.
TextEdit saved twice successfully (backend versions 1 -> 2 -> 3). Its idle
changes did not autosave during observation, so those are manual safe-save
results only. The version-history warning at close is expected on this volume.

VS Code used a separate temporary workspace with afterDelay autosave (100 ms),
without changing global preferences or trusting the workspace. No Cmd-S was used.
A valid edit automatically produced version 4; three rapid text additions then
produced exactly one further backend update, version 5, containing all additions.
The journal ended with revision/publishedRevision 12/12 and no pending error.
This UI observation proves the complete route; the publisher regression tests
separately prove coalescing of multiple scheduled saves within the quiet window.
Malformed frontmatter caused by UI typing/autoindent was retained locally as
EINVAL without a backend update; replacing it with valid text resumed publication.
Both editor documents/workspaces closed and the owned mount unmounted normally.

This does not close the general document-completion gate: valid partial Markdown
can still outlive a quiet window. Broader unlink/overwrite handle lifetime,
external-change refresh and recovery/status acceptance remain open. Public NFS
RW stays gated. macOS editor results use a fake backend; Linux DOCSY results are
real API checks, not a claim of real-tenant macOS editor coverage.


## Slice 88 — pause publication across backup rename

A queued publisher previously dereferenced a null publication intent when the
journal deliberately excluded a displaced page. It incorrectly recorded
REMOTE_RESULT_UNKNOWN even though no remote write happened. The publisher now
skips displaced/local entries before content validation and handles a null intent.
It rechecks displacement after asynchronous target resolution/rebasing, before
calling the core write operation. Frozen intents stay durable for later replay.

Three regressions cover a timer firing during displacement, invalid displaced
and local bytes, and backup rename during asynchronous path resolution followed
by restored publication. This does not cancel a core write already in flight.

- Linux publisher suite: 15 tests / 80 assertions; real DOCSY save regression:
  18 assertions with cleanup.
- macOS focused publisher/RPC/native save tests: 16 tests / 154 assertions.
- Typecheck: all four tasks passed. Public NFS RW remains gated by the other
  acceptance requirements.


## Slice 89 — exclusive replay identity confinement

A persisted exclusive-CREATE verifier previously accepted the current object at
its saved path without comparing page identities. Replay now shares the page-ID
and resolved-export checks used for backup restoration. A replacement identity
returns ESTALE; a foreign-space resolution returns EACCES. Neither changes the
acknowledged local bytes or sends a remote mutation. A valid retry still returns
the original staged bytes after a projection restart.

The new regression injects changed ID and foreign scope at the core boundary,
then restores the original resolution and proves successful replay. It does not
claim to bypass the core's metadata refresh policy.

- Projection suites: 48 tests / 648 assertions on macOS and Linux.
- Native macOS save: 34 assertions. Linux real DOCSY save: 18 assertions;
  owned mounts and disposable fixture cleaned up.
- All four typecheck tasks passed. Public NFS RW remains gated.


## Slice 90 — durable write status and shutdown recovery notice

The journal exposes bounded counts for pending/failed pages, displaced pages,
local editor entries and unresolved publication intents. A single SQL query
avoids loading staged bodies and includes interrupted replacements excluded from
the publish queue. Counts survive reopening the journal. Categories may overlap:
a displaced page can also have an unresolved intent or failure.

The running bridge exposes this status (null without a journal). Shutdown waits
for serving and in-flight publication, then reports retained recovery data on
stderr using counts only. It does not claim a remote commit or delete the data.
Repeated stop calls share one promise and emit the notice only once.

- Journal suites: 28 tests / 448 assertions on macOS and Linux.
- Real-helper shutdown test verifies preserved bytes, single reporting and no
  content/path disclosure. Together with the native save: 42 assertions per OS.
- Linux DOCSY live automatic save: 18 assertions with cleanup.
- All four typecheck tasks passed.

This provides bridge shutdown reporting, not a completed public recovery CLI.
NFS RW remains gated; listing/recovery command integration and unexpected-death
reporting remain open alongside the broader write acceptance requirements.


## Slice 91 — bounded recovery publication

Startup recovery now enumerates pending IDs without materializing every pending
body. Publication reuses the existing in-order limiter at concurrency one, so
queued pages do not load their staged images while another upload is active.
This deliberately trades multi-page upload throughput for bounded body retention;
no RSS reduction or throughput improvement is claimed without measurement.

Queued jobs recheck shutdown and newer debounce timers before materialization.
Stopping preserves unstarted jobs in the journal. A new edit behind a blocked
upload retains its full quiet window instead of publishing early when the slot
opens. Local entries/displaced pages stay outside the recovery queue; failed page
IDs remain eligible for recovery.

- Linux journal/publisher suites: 46 tests / 550 assertions; real DOCSY save:
  18 assertions, with fixture cleanup.
- macOS initial journal/publisher run: 45 tests / 544 assertions. Final focused
  queue/quiet-window/native save run: six tests / 64 assertions.
- All four typecheck tasks passed.

This bounds publication body concurrency, not the entire VFS cache or helper
memory. The pending recovery CLI and other write gates remain open.


## Slice 92 — refresh clean staged pages

Previously any admitted journal image permanently shadowed newer remote content,
even after successful publication. READ, GETATTR and subsequent staging now
consult the shared VFS body cache for clean page images. Only a strictly newer
version replaces a clean journal image. Dirty pages and local editor files stay
local. Versions are still governed by the existing core freshness policy.

The refresh transaction checks the captured revision, pending intent and backup
reservation before changing bytes. It advances clean revisions together, keeps
the previous editor source for conflict merging, preserves permissions and drops
an obsolete explicit mtime. Quota failures roll back completely. No separate
refresh timer or eager mount scan was added; immutable version views bypass it.

Tests prove external content becomes visible with exact size once core metadata
observes the newer version, then a stale editor save preserves a remote addition.
They also cover stale refresh revisions, dirty images, failed quota, displaced
clean pages and restart preservation. The metadata-observation test explicitly
updates the index; it is not a new measurement of kernel/TTL visibility latency.

- macOS/Linux journal/projection/publisher suites: 96 tests / 1,211 assertions.
- Additional quota/restart regression: six assertions per host.
- Native macOS save: 34 assertions; Linux real DOCSY save: 18 assertions, with
  normal cleanup. All four typecheck tasks passed before the final test-only addition.

Clean-record eviction, the public recovery workflow and remaining full RW gates
are still open. No general multi-editor convergence guarantee is inferred from
one tested stale-editor conflict-merge sequence.


## Slice 93 — native external-update visibility after publication

The live Linux DOCSY test now updates its disposable page through the API after
native NFS/Vim publication, polls the mounted file without invalidating caches,
checks exact byte size and absence of a new publication, then saves an older
editor image with a change in a different paragraph. The API result contains
both the external addition and the new local edit under the original page ID.

With the default 60-second core TTL, the successful run observed the external
addition after 55,968 ms (the TTL had already partly elapsed). This is one
visibility observation, not a latency distribution or an instantaneous-consistency
claim. The full live test passed 26 assertions in about 63 seconds and cleaned
up its mount and page.

An initial variant appended both edits at the end of the document. Visibility
passed after 55,897 ms, but the follow-up remained failed/pending with a retained
intent. Its error code was not captured. That overlapping-edit recovery case
remains open; the passing disjoint-edit test does not substitute for it.

The native synthetic save regression additionally expires core metadata using
its injected clock while retaining real OS caching, then proves mounted bytes,
size and a clean journal. macOS and Linux each passed 37 assertions. This proves
kernel refresh behavior, not real-tenant macOS latency. All four typecheck tasks
passed. ACCEPTANCE.md was reconciled with implemented namespace/editor/status
work; historical broad build/CI results remain explicitly historical.


## Slice 94 — correctable preflight conflicts

New publication intents used to be frozen before local rebase validation. A
conflict detected before any core write therefore left an unsent frozen image
that later corrected editor saves could not replace. Preparation now uses the
current image unless an existing intent already needs reconciliation. Only a
successfully prepared image is persisted immediately before the core write.
Revision comparison prevents persisting a different image if an edit arrived
during asynchronous preparation; the newer image gets another quiet window.

Two regressions prove that a preflight EBUSY sends no update and creates no
intent, then a corrected save succeeds with the remote content preserved; and
that edits during target resolution publish only the newer prepared image.
Lost-response reconciliation regressions remain green: existing intents are
never discarded. Previously persisted ambiguous/failed intents and conflicts
inside the core write still require the pending recovery workflow. This is not
claimed as complete recovery of every case from Slice 93.

- macOS/Linux journal/publisher suites: 50 tests / 575 assertions each.
- Native macOS save/refresh: 37 assertions.
- Linux real DOCSY journal publication/replay/replacement: 13 assertions, fixture
  cleaned up. All four typecheck tasks passed.


## Slice 95 — acknowledge same-version reconciliation

A regression reproduced a real core/journal contract mismatch: after temporary
editor writes return to the original bytes, a stale core index can propose an
already-existing remote version. The core refetches, compares storage, and
correctly returns the current version without creating another one. The journal
previously rejected that equal-version success and left the page pending.

Completion now accepts a confirmed version equal to the frozen base. Versions
below the base and mismatched local revisions remain rejected. Newer local bytes
remain pending when an older image is acknowledged. No optimistic local
no-change shortcut bypasses the authoritative core result.

- Red/green publisher regression exercises the actual core and fake API conflict
  response, not a stubbed successful result.
- macOS/Linux journal/publisher suites: 52 tests / 585 assertions each.
- Native macOS save/refresh: 37 assertions; real Linux DOCSY publication and
  replacement: 13 assertions, fixture cleaned up. All four typecheck tasks passed.

This does not promise every identical editor save avoids a PUT; it ensures a
core-confirmed reconciliation does not become a false pending failure.


## Slice 96 — accepted automatic snapshot publication

User decision (2026-09-17): publish validated snapshots automatically after
500 ms quiet, explicitly accepting intermediate versions when a slow editor
sends further blocks later. This resolves the former universal editor-completion
product gate; NFSv3 WRITE/COMMIT still confirms local durability only. The plan,
acceptance checklist, and user documentation now state this contract.

A regression stages a valid prefix, waits for its automatic publication, then
stages a delayed suffix. It verifies two updates and the final complete content.
This is intended behavior, not a claim that the quiet window detects save end.

- macOS focused regression: 1 test / 7 assertions (rerun with final test name).
- Linux publisher suite: 22 tests / 124 assertions.
- Linux real DOCSY journal publication: 1 test / 13 assertions; fixture cleaned up.
- All four typecheck tasks passed. No runtime behavior changed in this slice.

Public RW lifecycle/recovery, remaining namespace operations, and final platform
and fault gates remain open; acceptance of intermediate versions does not waive
those requirements.


## Slice 97 — drain recovered edits behind an older intent

A red/green regression reproduced a recovery stall: an API update succeeded but
its reply was lost, newer bytes were staged, and the publisher restarted. Resume
reconciled the older intent but never scheduled the already-durable newer image.
Automatic publication now schedules another quiet window after a successful
result if the page remains pending and no newer timer already covers it. Errors
remain retained without introducing an unbounded retry loop; existing timers
are not postponed. The pending-ID query does not materialize page bodies.

The regression verifies automatic convergence to the latest bytes, exactly the
expected remote version, and removal of the reconciled intent without another
editor event. It restarts the publisher against the retained journal; separate
journal tests cover actual process crashes and reopen.

- macOS/Linux journal and publisher suites: 54 tests / 597 assertions each.
- Native macOS existing-page save/refresh test: 37 assertions.
- Linux live DOCSY journal publication/replay/replacement: 13 assertions; test
  page cleaned up. All four typecheck tasks passed.


## Slice 98 — offline recovery inspection and byte export

`wiki mount recovery <journal.sqlite>` lists metadata, including local editor
entries, interrupted replacements and unresolved intents. Selecting an ID and
new output path exports exact current/intent/base bytes. No authentication or
Confluence connection is required. The journal is opened SQLite read-only, never
migrated or created; schema mismatch fails closed. Outputs use exclusive creation
and mode 0600, refusing existing files/symlinks, then fsync the written bytes.

Tests cover distinct binary images, metadata without bodies, byte-identical
journal preservation, displaced pages/local directories, missing images/files,
unsupported schemas, invalid options, existing output/symlink refusal, and actual
source CLI list/export calls. This provides extraction, not automatic conflict
resolution or permission to discard unresolved journal data.

- macOS/Linux recovery and mount command suites: 23 tests / 188 assertions each.
  macOS's first sandbox run could not bind its local test port; the same suite
  passed with the authorized local-network permissions.
- Linux live DOCSY journal publication: 13 assertions; fixture cleaned up.
- All four typecheck tasks passed; final CLI argument validation rerun separately.


## Slice 99 — exclusive journal ownership

A regression proved that two NfsJournal instances could open and mutate the same
journal, allowing independent publishers to race. Startup now acquires SQLite's
exclusive lock before initialization and retains it between transactions. Native
SQLite ownership is released on close or process death, without PID files or
stale-lock cleanup. Lock acquisition statements are executed individually so a
failed BEGIN cannot be masked by a subsequent COMMIT error.

Exclusive locking retains SQLite's rollback sidecar; journal_size_limit=0
truncates it after transactions. Quota tests now verify zero retained sidecar
bytes, preserving the storage bound instead of requiring file absence. Existing
SIGKILL, hot rollback/WAL recovery and database-full rollback tests remain green.
Offline inspection must follow normal mount shutdown because readers cannot
bypass the writer's exclusive lock.

- macOS/Linux journal, publisher and recovery suites: 58 tests / 635 assertions.
- New ownership test exercises same-process and separate-process rejection,
  followed by successful reopen with preserved bytes.
- Native macOS save/refresh: 37 assertions; Linux live DOCSY publication: 13
  assertions with disposable-page cleanup. All four typecheck tasks passed.


## Slice 100 — create-only core publication boundary

New NFS pages require a creation intent that cannot silently turn into an update
when a path becomes occupied. The shared writeFile API now accepts a create-only
condition with the reserved space and parent identity. It rejects occupied paths
(including a successfully created session alias), mismatched parents/exports and
content carrying an existing VFS page ID/version before sending a mutation.
Existing ID-bound updates retain their previous behavior.

- macOS/Linux write-back and NFS publisher suites: 90 tests / 288 assertions each.
- Linux real DOCSY test: 6 assertions; creates an isolated parent/child, refuses
  the wrong parent and repeated creation, verifies unchanged remote content and
  version, then deletes both test pages. All four typecheck tasks passed.

This is a prerequisite, not native NFS new-page acceptance. Durable creation
intents, ambiguous POST recovery, local-to-remote handle promotion and editor
file eligibility remain to be connected. A create-only condition prevents
accidental updates but does not by itself reconcile an unknown create result.


## Slice 101 — durable new-page attempts and receipts

Journal schema 9 adds frozen creation targets and confirmed remote receipts.
The exact first image reuses the existing bounded intents table; subsequent
editor writes remain independently durable. Revision checks prevent freezing an
obsolete preparation. Repeated calls return the same intent and must not be
interpreted by the publisher as permission for a second POST. Confirmed receipts
are idempotent; conflicting revisions/remote IDs are rejected. Namespace removal
or rename of unresolved sources/ancestors is blocked until reconciliation;
ordinary update completion cannot accidentally clear a creation intent.

Recovery lists creation target/parent/receipt metadata and exports the original
intent bytes. It can still inspect schema 8 without modifying it. Writer migration
preserves existing bytes. The user explicitly added plain `vim newpage.md` without
frontmatter on both transports to the acceptance plan.

- macOS/Linux journal, recovery and publisher suites: 62 tests / 659 assertions
  each, followed by the expanded real SIGKILL test (12 assertions each).
- Quota rollback, retained newer bytes, receipt replay/conflicts, namespace guards,
  schema migration and offline image export tested.
- Linux live existing-page DOCSY publication: 13 assertions; fixture cleaned up.
- All four typecheck tasks passed.

This slice does not yet send a native new-page POST or promote its filehandle.
The persisted receipt enables that integration; ambiguous POST reconciliation
and the complete no-frontmatter Vim acceptance remain open.


## Slice 102 — preserve handles and plain Markdown after confirmed creation

Schema 10 atomically promotes a confirmed local creation to its remote page ID,
retaining newer bytes, the published source, permissions and exclusive-create
verifiers. Persistent original-name/local-ID aliases allow subsequent lookups
and existing filehandles to reach that same page, including with a fresh core
session. Alias resolution verifies current page identity and export scope.
Plain Markdown updates are accepted when a durable published source supplies
the merge base; altered explicit page identities remain rejected.

- macOS/Linux filesystem, journal, recovery and publisher suites: 113 tests /
  1340 assertions each. Promotion/reopen, canonical-first and original-name
  lookup, repeated headerless saves and guarded recreation are covered.
- Linux live DOCSY creation/promotion/follow-up: 10 assertions; same page ID,
  version increment, preserved content and cleanup of child/parent verified.
- All four typecheck tasks passed. Schema growth required raising two synthetic
  small database ceilings (128/192 KiB); overflow rollback and retained-storage
  assertions remain enforced, production defaults unchanged.

This tests the projection/core path, not a complete automatic native CREATE or
an editor run. The user requests Vim/VS Code on both OSes and TextEdit on macOS,
for both transports; PLAN.md now names the matrix. Inventory found all three
macOS apps and Linux Vim; code is absent from the Linux SSH PATH and loginctl
listed no graphical session. Linux GUI availability requires further checking.


## Slice 103 — automatic native creation and persistent editor aliases

Visible Markdown drafts now enter the existing quiet-window publisher. Creation
freezes the target and bytes before the guarded POST, persists its receipt, and
promotes the local file to the remote ID. Newer writes remain queued. Unknown
POST outcomes stay recoverable and are not blindly retried. Schema 11 records
backup origin identity so even renamed plain-Markdown backups cannot create pages.
Hidden drafts and swap/backup suffixes are excluded; arbitrary visible temporary
names cannot universally be distinguished from intentional Markdown drafts.

A real Vim replacement exposed alias lookup happening before the displaced-page
check. Reordering that check and resolving reserved aliases by page ID preserves
the same page through backup-and-recreate saves. Atomic replacement of an
unpublished draft now queues its new bytes too. Directory enumeration contains
only the canonical ID-bearing page directory; the old name remains resolvable.

- macOS/Linux affected suites: 117 tests / 1364 assertions each.
- Expanded alias/listing regression: 14 assertions each on both hosts, including
  no duplicate original-name listing and lookup through a fresh core session.
- Native NFS Vim new-page and backup-replacement fixture: 44 assertions on each
  OS. macOS uses a synthetic backend, not the live mayflower profile.
- Linux live DOCSY native NFS test: 31 assertions; actual Vim creates without
  frontmatter and saves again to the same ID with a version increment. Existing
  external refresh was visible after 55,868 ms with the default core TTL. Both
  disposable pages were deleted and the owned mount was normally detached.
- All four typecheck tasks passed. Initial live run reached all 31 assertions
  but failed cleanup of an absent optional Vim backup; cleanup now allows absence.

Public NFS RW mounting remains gated. Automatic ambiguous-create reconciliation,
WebDAV/new-page editor coverage, VS Code/TextEdit new-page coverage, and the
remaining acceptance matrix are still open.


## Slice 104 — report unpublished new pages in recovery status

Pending and failed page counts now include eligible dirty local Markdown drafts,
using the same filename classifier as publication. Hidden editor files and
recorded backups remain excluded. The query reads metadata only; local-entry
counts still include drafts until promotion, as now documented. Counts survive
reopen and clear after confirmed creation without double-counting the promoted ID.

The empty-result metadata join initially retained a statement that prevented
immediate journal reopen under Bun 1.3.14. Explicit finalization fixes it; the
existing close/reopen regression and the new draft-status regression both pass.

- macOS and Linux journal suites: 36 tests / 509 assertions each.
- Linux live DOCSY journal publication: 13 assertions; fixture deleted.
- All four typecheck tasks passed.

This closes the new-page status omission, not the remaining recovery/public RW
or editor-matrix gates.


## Slice 105 — new-page publication across journal/core restart

A three-boundary regression closes and reopens the actual journal and starts a
fresh core cache before publisher resume. Before POST, the latest durable image
creates once. With a confirmed receipt, the original ID is promoted and newer
bytes become its next version without a second create. An unknown POST result
remains failed/recoverable, retaining both frozen and latest images without a
blind retry. These are controlled reopen tests, not new process-kill evidence.

- macOS/Linux full publisher suites: 29 tests / 167 assertions each.
- Linux live DOCSY confirmed-receipt reopen/fresh-core test: five assertions;
  same page ID, next version and latest content verified through the API.
  Disposable child and parent deleted. The synthetic tests additionally count
  POST calls; live verification uses identity/version/content.
- All four typecheck tasks passed.

Automatic resolution of unknown create results, public NFS RW lifecycle, the
full editor matrix and the other acceptance gates remain open.


## Slice 106 — publish CREATE-only empty Markdown documents

Regular and exclusive CREATE now schedule eligible new Markdown files even when
no WRITE follows. The publisher distinguishes unpublished local entries from
clean remote images, so revision zero does not suppress empty-page creation.
Status includes these drafts; restart resume publishes them once. Hidden editor
files and recorded backups retain their exclusions. A pause longer than the quiet
window can produce an empty initial version, explicitly documented under the
accepted intermediate-snapshot contract.

- macOS/Linux journal, filesystem and publisher suites: 118 tests / 1359 assertions
  each, including regular/exclusive empty drafts, verifier replay and resume.
- Actual kernel mounts on each host: 47 assertions each; an exclusive open/close
  without WRITE creates the empty page alongside the existing Vim save probes.
  These native tests use the synthetic backend.
- Linux live DOCSY confirmed-creation restart regression: five assertions; child
  and parent deleted. This live test covers restart, not a live empty CREATE.
- All four typecheck tasks passed.

Remaining public RW, unknown-create reconciliation, broader editor and final
acceptance gates are unchanged.


## Slice 107 — identity-bound core trash prerequisite

The shared rm operation accepts an optional expected root page ID/space. Before
any mutation it rejects another page, space or generated/attachment node. Matching
expectations retain the existing mode/allow-delete safeguards and trash-only API.
Existing callers keep their behavior. This gives the NFS removal path a guard at
the authoritative resolution boundary, rather than trusting an earlier stat.

- macOS/Linux write-back suites: 69 tests / 168 assertions each, including
  wrong-ID/space/generated-target refusal, positive trash and deletion opt-in.
- Linux DOCSY live guard test: four assertions; wrong expectations leave the
  disposable page readable, the matching operation trashes it, and the API
  subsequently returns 404. No purge endpoint is involved.
- All four typecheck tasks passed.

Native NFS remote removal is not enabled by this prerequisite. It still needs
coordination with durable writes and interrupted/ambiguous deletion recovery;
these are mandatory before the public RW gate can open.


## Slice 108 — durable NFS page-body trash and mutation exclusion

Schema 12 persists page-ID/space-bound trash attempts before the API request and
marks confirmed outcomes without discarding the recoverable bytes. Dirty pages,
frozen publication intents, displaced pages and local child drafts block trash.
Later writes (including no-op writes), truncation, metadata changes, backup
renames and local child creation are rejected while reserved. Retrying an unknown
DELETE does not issue another request. Confirmed file/directory handles become
stale; the journal retains a tombstone and the saved bytes.

NFS REMOVE now uses the guarded core trash operation after deletion opt-in.
Export-homepage removal remains protected. Remote RMDIR remains unsupported
(ENOTEMPTY); this is page-body removal, not full recursive directory parity.
Recovery inspection supports schemas 8–12, lists trash identity/completion, and
exports bytes without modifying the journal. New SQLite status/lookup statements
are explicitly finalized so close/reopen releases ownership under Bun 1.3.14.

- macOS/Linux journal, recovery and filesystem suites: 98 tests / 1260 assertions
  each before the final opt-in/local-child additions. The final focused protection
  suite passes five tests / 36 assertions on each host. Combined-export homepage
  protection adds one synthetic test / four assertions on each host.
- Native macOS/Linux NFS write suite: 50 assertions each, including empty CREATE
  followed by unlink and confirmed backend trash (synthetic backend).
- Linux live DOCSY native suite: 33 assertions, covering real Vim create/follow-up
  save and native unlink of the created page. API readback returns 404 after
  trash, parent fixture is cleaned up and the owned mount normally detached.
  External refresh became visible after 55,369 ms at the default core TTL.
- All four typecheck tasks passed.

Automatic uncertain-trash reconciliation, page-tree rename/directory parity,
full overwritten/unlinked handle semantics and the public RW gate remain open.

## Slice 109 — positive trash confirmation after restart

Restart now schedules retained trash intents. A body-free metadata request must
explicitly report `trashed` for the recorded page ID and selected space before
the journal marks the intent complete. No second DELETE is sent. A current page,
404, mismatched identity/space or failed request leaves the intent unresolved and
retains the saved bytes. Cloud space IDs are normalized across the numeric v1
space response and string v2 page response; the live test caught this difference.
The Data Center metadata route has mocked coverage only.

- macOS and Linux: 226 tests / 1121 assertions each across client, VFS write-back,
  NFS journal and publisher suites; no failures.
- Linux live DOCSY: one test / seven assertions. A disposable page is guarded
  against wrong identity/space, trashed, positively confirmed, then its reopened
  journal automatically completes the intent. The test page is left in trash,
  never purged. This test exercises API and journal recovery, not a kernel mount.
- Typecheck: all four tasks passed. Turbo emitted sandbox IO warnings while
  writing cache metadata; TypeScript checks succeeded.

The restart regression proves no repeated DELETE and preservation of recoverable
bytes. Export isolation and negative confirmations have focused coverage. The
[Cloud page API](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/)
supports the explicit status query without requesting a body.
Unknown outcomes lacking positive confirmation still need a recovery decision;
directory parity, full editor acceptance and the public RW gate remain open.

## Slice 110 — reuse original filenames after confirmed trash

The new regression reproduced a real namespace bug: after creating and deleting
`newpage.md`, CREATE of the same name failed with ENOENT because its durable
promotion still redirected registration to the trashed page. `completeTrash` now
atomically retires the promotion and exclusive-CREATE verifier along with recording
completion. Pending/unknown trash retains its alias. The page bytes and tombstone
remain recoverable; old handles cannot mutate the replacement page.

- macOS/Linux journal, filesystem and publisher suites: 128 tests / 1423 assertions
  each. Includes close/reopen, uncertain-versus-confirmed alias retirement, new ID
  allocation, stale-handle rejection and preservation of the deleted page image.
- Native macOS/Linux NFS suites: 53 assertions each. An empty Markdown page is
  published, unlinked, and recreated at the same filename under a different ID.
- Linux native live DOCSY/Vim: 36 assertions, including create, backup-style save,
  unlink and another Vim creation at the original filename. API readback confirms
  the distinct new page ID and content. Fixtures were trashed and the owned mount
  detached normally. The separate external-refresh probe took 55,867 ms at the
  default core TTL; the full test took about 68 seconds.
- All four typecheck tasks passed; diff whitespace validation passed.

This closes the confirmed-trash filename reuse bug. It does not establish full
directory rename/removal parity or complete the remaining editor/fault matrix.

## Slice 111 — native WebDAV Vim new-page saves on both hosts

Added opt-in native WebDAV editor tests (`ATLCLI_WEBDAV_KERNEL=1`) for plain
Markdown creation and three saves, both direct and backup/rename style. These
invoke real Vim and the native macOS WebDAV/Linux davfs2 clients with synthetic
DOCSY content. `backupskip=` explicitly enables Vim backups inside the temporary
fixture directory. Linux uses a private synthetic cache and `delay_upload 0`;
locks remain enabled. The harness detaches normally and reclaims its cache.

The tests exposed two backup defects: `newpage.md~` reached the page-rename path,
and the replacement remained hidden during davfs LOCK after CREATE. Tilde backups
now reuse the existing local editor staging store. Successful CREATE and PUT
clear the pending-backup reservation. Failed writes retain it. HTTP regressions
verify unchanged page title/identity and successful LOCK then PUT without another
page creation. Temporary HTTP diagnosis was removed before commit.

- macOS: 39 tests / 177 assertions across HTTP and native editor suites.
- Linux: 39 tests / 179 assertions (two additional privileged cache cleanup
  checks). Direct-save run about 5.3 s, backup-save run about 3.2 s, including
  normal davfs detach. The original immediate direct-save read sometimes returned
  empty while davfs was completing upload; the final test requires correct
  mounted readback within ten seconds. This is eventual visibility evidence,
  not proof of zero-latency read-your-writes on davfs2.
- Linux live DOCSY: nine assertions for HTTP create, backup MOVE, replacement
  LOCK/PUT, same ID/title and API/body readback. Fixture cleanup ran afterwards.
  This live case is a protocol test; native editor evidence above is synthetic.
- Typecheck: all four tasks passed.

The Vim new-page WebDAV cases are covered on both OSes. VS Code/TextEdit new-page
coverage, remaining NFS namespace/recovery work and final artifact acceptance
remain open.

## Slice 112 — real TextEdit new pages and repeated WebDAV safe-saves

Real macOS TextEdit UI runs created UTF-8 plain-text `.md` documents without
frontmatter on separate native NFS and WebDAV mounts. NFS completed three manual
saves as versions 1, 2 and 3 of one synthetic page, with one CREATE and two UPDATEs;
the journal finished with no pending images. The original filename remained
usable while the listing showed the canonical ID-bearing directory.

WebDAV reproduced a third-save failure. The dependency's MOVE handler interpreted
an absent Overwrite header as false. Native request tracing confirmed TextEdit
omits that header. A before-request normalization now supplies `T` for MOVE only
when the header is absent, as required by
[RFC 4918 section 10.6](https://www.rfc-editor.org/rfc/rfc4918#section-10.6).
Explicit `F` continues to reject an occupied destination with 412 and retains
the draft. No lock or conditional-header checks are bypassed. An alias-listing
experiment did not fix the issue and was removed; directory layout is unchanged.

With the final fix, a fresh TextEdit WebDAV document completed three manual saves
as versions 1, 2 and 3 of the same page (one CREATE, two UPDATEs). Every backend
snapshot contained the expected text. Both successful editor documents closed;
the ordinary macOS version-history notice was confirmed without suppressing it.
All owned mounts detached normally. UI fixtures used a synthetic backend; this
is not real-tenant macOS proof and does not claim TextEdit autosave.

- macOS HTTP/native Vim regression suites: 42 tests / 192 assertions.
- Linux HTTP/native Vim regression suites: 42 tests / 194 assertions, including
  privileged synthetic-cache cleanup checks.
- Linux live DOCSY protocol test: 13 assertions, including a repeated draft MOVE
  without Overwrite, backend text and retained page ID; disposable page cleaned up.
- All four typecheck tasks passed. Temporary diagnostic logging was removed.

VS Code new-page/autosave coverage remains open. Linux has Xvfb and Chromium but
no `code` executable in the inspected PATH; no Linux VS Code run is claimed.
Generic namespace/COPY overwrite parity, NFS recovery and final acceptance also
remain open.

## Slice 113 — native macOS VS Code new-page autosaves

Real VS Code 1.127.0 UI created plain Markdown without frontmatter on separate
native NFS and WebDAV mounts. Disposable synthetic DOCSY backends recorded page
identity, body, versions and API call counts. Workspace-local settings selected
`files.autoSave: afterDelay` and `files.autoSaveDelay: 100`; no global settings
were changed. The workspaces stayed in Restricted Mode.

- NFS: first manual Save As created `code-new.md`, page 700000001, version 1.
  Two subsequent replacements without Cmd-S reached versions 2 and 3, each with
  the expected Unicode body. One CREATE, two UPDATEs, no pending journal images.
  The editor retained the original alias while Explorer showed the ID directory.
- WebDAV: initial Save As created one page but produced version 4 (three UPDATEs).
  The first attempted autosave did not reach the backend; a manual save did.
  The save dialog had opened `/tmp/...` while the workspace folder used
  `/private/tmp/...`. After aligning the workspace folder with `/tmp/...`, two
  more edits without Cmd-S reached versions 6 and 7 with the expected bodies.
  This proves alias continuity and successful autosave, not minimal version churn.
- Both test windows closed and both owned mounts detached normally. The NFS
  harness PID was gone; the WebDAV harness exited 0. No real tenant content was
  used or modified. The separate unused VS Code test-profile process was stopped.

Linux VS Code, macOS real-tenant proof, burst coalescing/version-churn analysis,
COPY overwrite parity, NFS recovery and final acceptance remain open. The COPY
handler was inspected and shares the dependency's MOVE header parser, but its
adapter also delegates to page-copy semantics; no partial header-only fix was
applied or claimed. Typecheck passed all four tasks before this evidence push.

Linux DOCSY HTTP identity/backup/LOCK regression rerun: one pass, 13 assertions,
fixture cleanup completed; four macOS-only native cases skipped on Linux.

## Slice 114 — suppress identical saved-image updates

The shared write-back path previously submitted another UPDATE for every
identical current-version save. A regression first reproduced versions 2 and 3
instead of retaining version 1 for two identical writes through the creation
alias and canonical path. It now skips the UPDATE when the title and exact
converted storage hash equal the cached current image. The check runs inside
per-page serialization and after stale-version routing; differing titles,
content and stale conflict handling retain their existing paths. No additional
body download is needed. This is a comparison against the mount's observed
version, not proof of fresh server state. Storage comparison avoids treating
lossy Markdown equality as proof that the original storage is unchanged.

- macOS write-back + HTTP regressions: 112 passed, 354 assertions.
- macOS full VFS core + native WebDAV/Vim: 353 passed, 951 assertions.
- Linux full VFS core + HTTP + native WebDAV/Vim: 394 passed, 1127 assertions.
- Linux live DOCSY: 17 assertions, including three repeated PUTs retaining the
  backend version, followed by changed-content backup/LOCK/MOVE publication.
  Disposable page cleanup completed; macOS-only cases skipped on Linux.
- Additional no-body-download assertion: focused regression passed (8 assertions).
- Typecheck: four tasks passed. The initial sandboxed HTTP invocation could not
  bind loopback; the authorized native/network rerun passed.

The existing serialization test now starts with a real title edit instead of
an unchanged image, preserving its in-flight update/flush assertions. This fix
removes duplicate saved-image versions; it does not eliminate legitimate empty
CREATE/truncate snapshots or prove optimal editor burst coalescing. Those and
final VS Code/native performance verification remain open.

## Slice 115 — initial creation marker and ambiguous-POST retry boundary

ConfluenceClient.createPage can now include properties in the initial content
POST (`metadata.properties`, each entry wrapping its JSON value). The DOCSY
probe sends a random marker with CREATE, reads it back through the property API
and verifies that the page remains version 1 with its expected body. No separate
property mutation is issued. This validates the Cloud primitive needed to match
an uncertain NFS creation to its original attempt; it is not yet publisher
integration or proof of transactional behavior for every failure mode.

The audit also found that the general REST retry loop repeated CREATE after
HTTP 5xx. createPage now disables those ambiguous server-error retries, while
existing GET retry behavior remains covered. A regression requires exactly one
POST when the response is 503. Rate-limit handling is unchanged.

- Complete client suite on macOS and Linux: 88 passed, 242 assertions each.
- Linux live DOCSY marker probe: three assertions; disposable page cleaned up.
- Typecheck: all four tasks passed. An initial sandboxed client-suite run could
  not bind its loopback servers; the authorized rerun passed.

The initial-POST marker is not yet passed by the VFS/NFS creation intent. Matching
must bind the token to the frozen space/parent/image and reject absent, altered
or ambiguous evidence; no blind repeat of a timed-out POST is acceptable.
Data Center marker support and crash/fault reconciliation remain unverified.
Current official references describe [content properties](https://developer.atlassian.com/cloud/confluence/confluence-entity-properties/);
the create-content operation no longer appears on the current Cloud v1 reference,
so this slice relies on the explicit live probe rather than claiming a currently
documented atomic CREATE guarantee.

## Slice 116 — reconcile an unchanged initial NFS creation after lost reply

NFS now passes its durable random local file identity through the create-only
VFS condition into the initial CREATE property. No journal schema migration is
needed: the existing local ID is unique and persists with the frozen image.
On resume, an uncertain creation performs the existing direct exact-title lookup
(no CQL indexing dependency), requires a single matching result, then checks the
marker and the current page's ID, space, parent, title, version 1 and storage body
against the frozen intent. Only positive agreement records a receipt and promotes
the same local file. No additional POST is issued. Old attempts without a marker,
changed pages and ambiguous/missing results stay pending; no absence is interpreted
as permission to recreate. No Data Center live claim is made.

The first DOCSY fault test identified a stale-directory-index bug: a positively
recovered page was not attached to the already-loaded parent. Recovery now adds
that verified identity before resolving its canonical path. A later run hit the
suite's default five-second network deadline; the bounded live case now allows
30 seconds. Final run completed in about 1.6 seconds.

- Final macOS core/publisher suites: 388 passed, 1131 assertions.
- Final Linux core/publisher suites: 388 passed, 1130 assertions (timer-driven
  polling assertions can differ by one between hosts).
- Earlier core/publisher/journal run: 427 passed on both OSes.
- Regression variants retain frozen bytes and prevent another POST for absent or
  wrong markers, differing body/parent, and a remote page advanced to version 2.
  The matching case uses automatic `resume()` and verifies namespace promotion.
- Linux live DOCSY: six assertions after injected lost reply and journal close /
  reopen, same page ID, exactly one POST, remote version 1 and expected body.
  The disposable page was cleaned up. This is real API/journal evidence, not an
  additional native kernel/editor test.
- Final typecheck: four tasks passed.

Recovery for changed initial pages, confirmed-not-created outcomes and folder
move interruptions still needs explicit handling. Public NFS RW and final
acceptance remain gated; this slice does not complete the full recovery matrix.

## Slice 117 — recover creations after subsequent remote edits

A matching creation marker can now be verified against immutable version 1 when
the current page has advanced. Current identity, space, parent and title must
still match; the historical ID/version/title/storage must prove the frozen
creation image. Recovery records the original version, leaves current remote
content untouched and seeds the confirmed initial image as the merge base for
newer local writes. It does not equate current content with the original intent.

The new regression initially failed because a historical view did not populate
the editable merge-base cache. Explicitly retaining the verified first image
fixes that missing-base conflict. Automatic resume now merges non-overlapping
local and remote edits into version 3, with exactly one original CREATE. Missing
historical proof retains the unpromoted local file and frozen intent.

- macOS core/publisher: 388 passed, 1132 assertions.
- Linux core/publisher: 388 passed, 1131 assertions (timer polling differs).
- Additional missing-history regression: one pass / five assertions on each OS.
- Linux DOCSY, journal close/reopen after injected lost CREATE reply: both the
  unchanged and externally updated variants passed, twelve assertions total.
  The externally updated page remained version 2 with its external content.
  Both disposable pages were cleaned up. No additional native mount test is
  claimed for this recovery-only change.
- Final typecheck: all four tasks passed.

Retitled/moved pages, missing markers, ambiguous matches, absent historical proof
and confirmed-not-created outcomes remain recovery boundaries. Full native/editor,
Data Center and public RW acceptance remain open.

## Slice 118 — Data Center creation-marker reads

The shared property-by-key method used by NFS reconciliation previously always
called Cloud REST v2. It now uses the Data Center v1 content-property resource
when appropriate, preserving the configured context path and encoding the key.
Numeric page identity and dot-segment keys are validated before requests. Only
an exact returned key supplies a value; 404 means absent, while 403 and server
failures propagate. Response bodies use the existing meta-only log policy.
Cloud keeps its existing v2 lookup; property mutation methods are unchanged.

- Full Confluence client suite: 94 passed, 255 assertions on macOS and Linux.
- Coverage includes both endpoint families, a `/confluence` context path, keys
  containing slash/space/question mark, wrong returned keys, invalid identity,
  404/403 and exhausted 500 retries. Tests reuse the immediate retry scheduler.
- Linux DOCSY: both lost-CREATE journal-reopen cases passed, twelve assertions,
  with and without a subsequent external edit; disposable pages cleaned up.
- Typecheck: all four tasks passed.

This closes the known Cloud-only marker-reader implementation gap. It is mocked
Data Center transport evidence, not a live Data Center deployment claim. Full
recovery/namespace/lifecycle and native editor acceptance remain open.

## Slice 119 — bounded automatic publication retry

Namespace inspection confirmed that remote directory renames are still open.
It also exposed an adjacent lifecycle gap: scheduled publication retained bytes
after transient failure but never tried again without a new save or restart.
The publisher now retries EAGAIN failures up to five times, using exponential
backoff from one second plus up to 25% jitter and respecting Retry-After from the
error or its cause. New save events cannot shorten an active retry deadline.
Attempts replay/reconcile the frozen publication intent. Denials, conflicts and
validation errors do not enter this loop; exhausted errors remain durable.
stop() cancels retry timers. Retry timing is session-local, not journal metadata.

- macOS and Linux full publisher suite: 41 passed, 241 assertions each.
- Real-timer regression proves automatic recovery after a transient 503 with
  at least the initial one-second backoff, and no retries after a 403 denial.
- Timer-driven regression checks the initial quiet delay, all five retry ranges,
  Retry-After, exhaustion after six total attempts, and retained pending intent.
- Linux DOCSY: two recovery cases / sixteen assertions. The unchanged case now
  includes a subsequent save with an injected pre-request 503, automatic retry,
  exactly two attempts and backend version/body verification. Pages cleaned up.
- Typecheck: all four tasks passed.

This adds recovery for explicitly transient EAGAIN failures. Generic network
errors currently mapped to EINVAL, remote directory mutations, the wider fault
matrix and final acceptance remain open. No new native-kernel test is claimed.


## Slice 120 — transient network failures enter bounded publication retry

Shared REST-to-VFS error mapping recognizes explicit Bun/Node connection,
reset, timeout and temporary DNS codes, including wrapped fetch causes.
Cancellation, certificate failures and unclassified exceptions remain EINVAL;
cyclic cause chains terminate. This changes classification, not the REST client's
mutation retry behavior. NFS uses the existing frozen-intent reconciliation and
bounded backoff; uncertain CREATE is not blindly repeated.

- macOS refused-loopback probe observed Bun code `ConnectionRefused`.
- macOS/Linux: `bun run test packages/confluence-vfs/src/errors.test.ts
  apps/cli/src/vfs/nfs-publisher.test.ts`: 71 passed / 353 assertions each.
  Real timers cover HTTP and wrapped connection-reset automatic recovery;
  code mapping covers direct/nested failures and nonretryable/cyclic cases.
- Linux DOCSY recovery: 2 passed / 16 assertions, now injecting a pre-request
  ECONNRESET on the first update. Automatic retry verified the final remote
  version/body with two attempts and no second save. Test pages cleaned up.
- `bun run typecheck`: all four tasks passed.

The live network fault is injected before the request, not an OS network outage.
Remote directory mutations, wider fault/editor matrix and final acceptance remain
open. No new native-kernel or Data Center live coverage is claimed.


## Slice 121 — reject unsupported folder retitles before partial moves

The shared rename path treated real Confluence folders as pages. A live probe
using the client's existing updateFolder method also failed: v1 content PUT
returned 501 (folder update validation not implemented). The current official
[folder reference](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-folder/)
only documents create/get/delete. The attempted adapter wiring was removed.

The core now rejects a folder retitle with EROFS before invoking any remote move
or update. In particular, reparent+retitle cannot first move a folder and then
fail at title update. Page-directory rename behavior is unchanged.

- macOS/Linux write-back and client-port tests: 74 passed / 190 assertions each.
  Regression covers same-parent and combined reparent/retitle requests, unchanged
  title/parent and zero page read/update/move calls.
- Linux DOCSY: one test / four assertions proves rejection and unchanged remote
  folder title, parent and identity. Temporary folders from both the initial
  failed probe and final test were deleted in finally blocks.
- Typecheck: all four tasks passed.

This is an honest capability boundary, not implemented folder retitling. Native
NFS page-directory mutation wiring and durable recovery remain open. No new
native-kernel acceptance is claimed.


## Slice 122 — preserve original page titles during directory moves

Shared VFS rename reconstructed the title from its slug even for an unchanged
canonical basename. Moving `API Design` could therefore retitle it to `Api Design`
and issue an unnecessary body GET/update. Comparing the target stem with the
existing canonical name now retains the exact title for a pure move.

- macOS/Linux write-back suite: 75 passed / 203 assertions each. Three regressions
  cover acronym case, Unicode/punctuation and underscores/version punctuation;
  each verifies the new parent, unchanged title, one move and zero body GET/update.
- Linux DOCSY: one passed / three assertions. A real page moved under a disposable
  parent, retaining its original lowercase/hyphenated title and body; server
  ancestors confirm the new parent. Both resources were cleaned up.
- An initial live invocation rejected an invalid test-resource feature slug;
  it was corrected to the standard sweepable name before the successful run.
- Typecheck: all four tasks passed.

This fixes the shared operation required by NFS; native NFS directory mutation
wiring, durable namespace intents and crash recovery remain open. No native
mount acceptance is claimed for this slice.


## Slice 123 — current cross-platform integration checkpoint

Revalidated code at 38f9853f; no implementation changes in this slice.

| Check | macOS | Linux |
| --- | --- | --- |
| `bun run test packages/confluence-vfs/src apps/cli/src/vfs` | 667 pass, 32 skip, 3315 assertions | 667 pass, 32 skip, 3315 assertions |
| Rust helper `cargo test --manifest-path packages/confluence-nfs/Cargo.toml` | 3 library + 4 binary tests pass | 3 library + 4 binary tests pass |
| Full `nfs-bridge.test.ts` + `webdav-editors.test.ts`, native flags enabled | 30 pass, 1 skip, 1356 assertions, 224s | 30 pass, 1 skip, 1358 assertions, 241s |
| Separately enabled native Glow test | 1 pass, 7 assertions | 1 pass, 7 assertions |
| Fresh compiled CLI + `wiki-sh-built.e2e.test.ts` | 9 pass, 33 assertions | 9 pass, 33 assertions |

Native runs set ATLCLI_NFS_TEST_HELPER to each host's existing debug helper,
ATLCLI_NFS_KERNEL=1 and ATLCLI_WEBDAV_KERNEL=1. The skipped Glow case was run
separately with ATLCLI_NFS_GLOW pointing to the installed executable. The tests
cover actual Vim saves over WebDAV, NFS staged writes/fsync/create/replacement,
wire identity and malformed-input handling, real timeout enforcement, single
and multiple fixture spaces, attachments, external changes and version snapshots.
The DOCSY/mayflower dual-space cases use synthetic data, not tenant content.

Fresh CLI binaries were compiled from source with --conditions=development into
/tmp/atlcli-slice123 on each host. macOS cargo needed its absolute ~/.cargo/bin
path because it was absent from PATH; the subsequent test run passed.

Linux real-tenant native publication additionally passed: one test, 36 assertions,
69s, using mayflower authentication and disposable DOCSY pages, with normal
unmount/cleanup. macOS real-tenant authentication is still unavailable.
Typecheck: four tasks passed.

One-run synthetic Glow listing/selected-view times: macOS 66.3/2.3ms, Linux
53.2/15.7ms. These are not the final five-run cold/warm or large-live-space
benchmark. The native directory-change test took 11.25s on Linux versus 1.20s
on macOS; a passing eventual-visibility test does not establish a five-second
visibility guarantee. That latency boundary remains in final performance review.

All final verification runs completed successfully. This checkpoint does not close
native directory mutation implementation, durable namespace recovery, Linux
VS Code/macOS TextEdit autosave coverage, full repository CI/build or final
performance/memory/capability acceptance.


## Slice 124 — avoid repeated parent resolution during NFS enumeration

The 600-entry native test now separates draining its active cursor from a fresh
listing. Before this fix on Linux those phases took 5434ms and 4956ms: the prior
11-second whole-test time was not a direct external-change latency measurement.
Directory enumeration re-resolved and statted its parent for every child. It now
passes the already resolved/listed parent privately to child lookup; filename,
child identity and export-scope checks still run, and batches remain bounded at
32. No new persistent cache or dependency was added.

Regression checks compare parent-stat work with zero and 200 added children,
require every child to be checked, and test bounded/drained backend fan-out on
failure. The existing fan-out test now injects its error at the backend stat
boundary rather than the public lookup wrapper.

- macOS/Linux filesystem suites: 58 passed / 709 assertions each.
- macOS broad core/mount suite: 668 passed, 32 skipped, 3319 assertions.
- Native 600-entry mutation case: macOS and Linux each passed / 613 assertions.
  Final cursor/fresh-list phases: macOS 134/687ms; Linux 3964/4003ms.
  An earlier post-fix Linux sample was 4085/3913ms. These are individual samples,
  not a five-run benchmark. The final Linux whole test fell to 8.1s from 10.5s.
- The native regression now checks actual fresh-list elapsed time <5000ms, so
  one overlong listing cannot pass merely because it eventually returned the
  expected names. This applies after advancing the core TTL clock in the test,
  not as a universal five-second external-edit SLA.
- Linux native DOCSY publication: one pass / 36 assertions, 68s, cleanup complete.
- Typecheck: all four tasks passed.

Remaining work includes native directory mutation wiring/recovery and final
performance, memory, full editor and CLI acceptance. This optimization does not
claim those requirements complete.


## Slice 125 — shared safe RW mount-option construction

The mount-option and command builders now accept explicit ro/rw mode. RO keeps
its existing soft retry behavior; RW selects hard retries. Runtime mode validation
prevents malformed values, and Linux instructions distinguish the writable mount
and need to keep its daemon running until normal unmount.

Both native RW test paths now use this shared builder directly instead of
rewriting a read-only option string. The public CLI RW gate is unchanged: journal
path/ownership, recovery/lifecycle and remaining acceptance must still be wired
before enabling it. Stable NFS replies remain local-durability acknowledgements.

- macOS/Linux mount-transport suites: four passed / 31 assertions each, including
  both platforms, unchanged RO defaults, no soft option in RW and invalid mode.
- macOS/Linux native RW write/fsync/editor replacement test: one passed / 53
  assertions each, using the shared options and normal unmount cleanup.
- Linux native DOCSY automatic publication: one passed / 36 assertions, 68s,
  disposable resources cleaned up.
- Typecheck: all four tasks passed.

Hard-mount behavior after unexpected helper death is not newly certified here;
full RW lifecycle and public activation remain part of the unfinished goal.


## Slice 126 — stable authenticated journal location and startup ownership

Journal location hashes exact profile/account/site identity and sorted unique
export spaces. It lives under cache-dir/nfs-journals, separate from disposable
body-cache databases. Credentials/query/fragment-bearing site URLs and empty or
invalid export identities are rejected. Site trailing slash and export order do
not create a different journal; different identities/exports do.

The CLI NFS branch is prepared to create this journal from the core's verified
runtime identity, pass it to the server and close it after server/publisher stop
or failed startup. Startup output includes its recovery path. The original RW
validation gates remain unchanged; no new public writable mount is advertised.
This lifecycle wiring still needs end-to-end RW CLI activation/fault acceptance.

- macOS journal suite: 41 passed / 551 assertions; CLI suite: 20 / 153.
- Linux combined suites: 61 passed / 704 assertions.
- Regression verifies account/profile/site/export isolation, reordered exports,
  reopened durable bytes, file mode 0600 and invalid identity rejection.
- Linux DOCSY confirmed-create/reopen/fresh-core test uses the new locator:
  one passed / five assertions. Newer local content publishes to the existing
  page after reopening; remote version/body and intent retirement verified.
  Disposable child and parent pages cleaned up.
- Typecheck passed; no claim of a live second-identity test (none available).

Public RW lifecycle, interrupted namespace changes, complete editor matrix and
remaining final acceptance gates remain open.


## Slice 127 — server-owned journal lifecycle under the unchanged CLI gate

The NFS server accepts an owned journal location as an alternative to a borrowed
journal. Its existing startup path and publisher operate on the opened journal;
startup failure closes it, and idempotent stop waits for helper/publisher cleanup
before recording final counts and closing it. Status remains readable afterward.
The CLI prepared RW branch delegates ownership to this shared, directly testable
path. SQLite/journal loading remains lazy for callers that do not own a journal.

The PLAN explicitly requires write-durability acceptance before public RW
activation; that gate was preserved. This slice does not claim an enabled CLI
RW command or full native hard-mount crash recovery.

- macOS/Linux failure + CLI suites: 27 passed / 174 assertions each, including
  real Rust helper pipe-close behavior. New regression seeds durable local bytes,
  simulates missing-helper startup, helper death, concurrent/repeated stop, and
  reopens the database with retained bytes and final recovery counts.
- Linux DOCSY with real Rust helper: one pass / five assertions. Server startup
  resumes an owned journal, publishes one pending image, verifies remote version
  and body, stops, then reopens the journal without pending publications. Page
  cleaned up. This recovery test does not attach an OS volume.
- Typecheck: four tasks passed.

Full public RW activation, hard-mount crash/unmount behavior, namespace mutation
recovery and remaining editor/performance acceptance are still open.


## Slice 128 — native hard-mount helper crash with durable pending writes

A new native regression exercises the owned-journal path on a real RW hard
mount. It writes and fsyncs Markdown, injects a publication denial, verifies the
backend is still at version one, then kills the actual Rust helper. All file
handles have been closed before the kill. The test normally unmounts (no forced
or lazy detachment), stops the server, reopens the journal and checks exact bytes.
A fresh server resumes the pending image, publishes version two and serves it
through a new native mount. Cleanup normally unmounts the new volume.

- macOS: one native test passed / ten assertions, 16.5s total.
- Linux: same test passed / ten assertions, 1.2s total.
- Linux DOCSY owned-journal publication gate: one passed / five assertions,
  temporary page cleaned up.
- Typecheck: all four tasks passed.

This closes a concrete acknowledged-write/helper-death case, not every crash
boundary. It uses a synthetic backend for the native fault injection. It does
not test parent SIGKILL with active writes, OS calls blocked during helper death,
or automatic recovery of interrupted directory moves. The public RW CLI gate
and the full objective remain open.


## Slice 129 — FILE_SYNC survives owning-process SIGKILL

A real-wire regression starts the Bun owner and Rust helper in separate
processes, truncates and writes a Markdown body over NFS, and checks FILE_SYNC
before killing the Bun owner. Publication cannot complete in the injected
backend. The helper exits after its parent pipe closes; reopening the journal
recovers the exact acknowledged bytes. A fresh server resumes publication and
verifies the expected body and version two.

- macOS: one passed / 16 assertions, 669ms.
- Linux: one passed / 16 assertions, 718ms.
- Linux DOCSY owned-journal live gate: one passed / five assertions; temporary
  page cleaned up.
- Typecheck: all four tasks passed.

This is a real NFS protocol test with a synthetic backend, without an OS mount.
It does not establish recovery of blocked kernel calls or guarantee that an
upload was already in flight at the kill. Public RW activation remains gated.


## Slice 130 — directory type checked before draft publication

Renaming a local editor directory to a Markdown-looking name sent its ID to
the publisher. The durable creation guard already prevented a remote page, but
the attempt incorrectly recorded EINVAL against the directory. Publication now
checks the durable local entry type before interpreting its bytes as a draft.
The two regressions exercise the filesystem-to-publisher path with and without
replacement of an empty destination directory, checking stable handles, child
bytes, absence of CREATE/creation intents, and absence of a publication error.

- Both regressions failed before the fix at the journal's file-only guard.
- macOS and Linux filesystem/publisher suites: 102 passed / 969 assertions each.
- Additional error-state assertion: targeted tests passed on both hosts, two
  tests / 16 assertions each.
- Linux DOCSY owned-journal live publication: one passed / five assertions;
  temporary page cleaned up. Typecheck: all four tasks passed.

This fixes local directory handling; remote directory rename/reparent and
namespace recovery remain required before full acceptance.


## Slice 131 — journaled NFS page-directory reparenting

The NFS adapter now moves an existing page directory under another page or
folder in the same space, preserving its canonical basename and immutable ID.
Schema 13 records source/destination paths, parent identities and title before
the remote mutation. Pending local data blocks admission; unresolved moves
reserve both trees against subsequent mutations. Guarded core rename checks
source metadata and target identity. Successful moves update durable cached
paths and retain a bounded receipt. Replay and publisher resume only confirm
fresh remote identity/parent/title; they never blindly repeat a move. Unknown
outcomes remain counted in unresolved recovery state.

The native test keeps a body descriptor open while renaming its directory and
checks readable body content afterward. Core cache invalidation also prevents
stale parent frontmatter; NFS clean images can refresh changed parent metadata
without a version increase, while plain Markdown save bytes keep their existing
semantics. A regression against the broader initial refresh exposed that
distinction and the final implementation restricts same-version refresh to
identified parent changes.

- macOS and Linux: 225 tests / 1779 assertions each across filesystem, journal,
  publisher and core write-back suites. Covers lost reply, repeated RPC, retained
  unknown outcome, pending local data, fresh identity checks and journal reopen.
- Native macOS and Linux RW suite: one passed / 57 assertions each, including
  directory move with an open descriptor and the existing editor-save cases.
- Linux DOCSY adapter-to-API move: one passed / seven assertions; verifies exact
  title, ID-bound handles, body and changed parent. Temporary pages cleaned up.
  Confluence increments metadata/version on the tested live move, so current
  Markdown frontmatter is deliberately not asserted byte-identical.
- Typecheck: all four tasks passed.

Remaining: directory retitles, cross-space moves, actual folder moves/removal,
clean receipt eviction and resolving confirmed-negative move outcomes. Journal
reopen and uncertain-result reconciliation are tested separately here; this is
not a claim of native SIGKILL at every move boundary. Public CLI RW stays gated.


## Slice 132 — journaled real Confluence-folder moves

The existing positional move client successfully moved two disposable DOCSY
folders in a live probe, retaining the source title. Core rename now uses that
endpoint for real folders instead of the page-update endpoint. NFS carries the
page/folder kind through its durable intent and recovery confirmation; folder
checks use fresh folder metadata and compare its numeric space ID to the mounted
space. Unsupported folder retitles still reject before mutation.

Schema 14 migrates existing move intents as pages and persists folder kind.
A cached schema-inspection statement initially caused three reopen tests to
retain a SQLite lock; explicit statement finalization fixes that regression.

- macOS/Linux: 229 tests / 1806 assertions each across filesystem, journal,
  publisher and core write-back suites. Includes lost folder-move reply,
  descendant handle preservation, wrong-space metadata rejection, and migration
  from schema 13 with a pending page move.
- Native macOS/Linux RW suite: one passed / 61 assertions each. Moves a folder
  while a descendant body descriptor stays open, then reads both the old handle
  and new path, alongside existing page/editor-save coverage.
- Linux DOCSY journaled folder-to-folder move: one passed / five assertions;
  verifies ID, parent, title, stable directory handle and cleared intent. Probe
  and test folders were deleted. Typecheck: all four tasks passed.

Remaining namespace work includes page-directory retitles, cross-space moves,
folder removal, parentless root-item coverage, receipt eviction and explicit
resolution of confirmed-negative outcomes. Native SIGKILL during a folder move
is not established by these tests. The public CLI RW gate remains enabled.


## Slice 133 — journaled page-directory retitles and canonical NFS names

NFS now retitles page directories in their current parent when the new name
retains the page ID and uses the canonical slug. The existing move journal
freezes the target title; fresh metadata reconciles lost replies without a
second update. Open directory/body handles retain the same identity. Invalid
ID changes, ID-less names, folder retitles and combined reparent/retitle reject
before a new intent is admitted. Those unsupported cases remain explicit.

The core intentionally resolves by ID even for an old slug. NFS must instead
report only the current directory name, otherwise a native rename can see two
names for the same inode before the operation. Its directory-name check now
uses the canonical name already available in core stat metadata; old handles
relocate by ID while old directory lookups return ENOENT.

- macOS/Linux broad core + NFS filesystem/journal/publisher suites: 514 passed /
  2619 assertions each. Initial sandboxed macOS run could not bind a contract
  test's loopback server; rerun with the existing test permission passed.
- Native RW/editor/retitle plus 600-entry directory mutation: two passed / 678
  assertions on each host. Retitle keeps an open descriptor readable and removes
  the old directory name.
- A duplicate resolve initially regressed Linux fresh listing to 5502ms. Reusing
  stat metadata brought it to 4165ms (4752ms initial cursor); macOS final sample
  was 995ms fresh / 249ms initial cursor. These are individual acceptance runs,
  not the final five-run benchmark.
- Linux DOCSY retitle: one passed / seven assertions; exact new title, unchanged
  parent/body, stable handles, old-name absence and cleared journal verified.
  Test page deleted. Typecheck: all four tasks passed.

A separate DOCSY probe created a folder without an explicit parent: Confluence
assigned a parent and its VFS path was accessible. This does not prove support
for genuinely parentless items. Remaining: ID-less directory aliases, combined
retitle/reparent, cross-space moves, removal/recovery work and final acceptance.
Public CLI NFS RW remains gated.


## Slice 134 — recoverable combined page reparent and retitle

One NFS rename can now move and retitle a page while preserving its ID. Schema
15 stores the original title as well as the desired title. Old records migrate
with an unknown original title rather than guessing from a lossy slug. Source,
intermediate and destination trees remain reserved while the outcome is pending.

RPC replay and publisher resume share one recovery function. It first confirms
the final outcome. Otherwise it only resumes the title step after fresh metadata
positively identifies the original title under the destination parent. It never
repeats an uncertain reparent. The core avoids another version if an in-flight
retitle finishes between the metadata check and body fetch. Existing body changes
are retained; a changed intermediate title leaves the intent unresolved.

- macOS/Linux filesystem, journal, publisher and core write-back suites: 239
  passed / 1879 assertions each before the final extra conflict assertion/test.
- Final targeted combined cases: six passed / 46 assertions on each host,
  including the existing combined-export homepage guard. Covers normal operation,
  interruption after reparent, before retitle and after retitle, an external body
  edit during recovery, and an incompatible external title.
- Journal tests reopen the reserved intermediate state and migrate schema 14;
  these are distinct from native process-kill injection, which remains open.
- Native RW/editor/move suite: one passed / 69 assertions on each host, including
  combined rename and old-path disappearance.
- Linux DOCSY combined operation: one passed / six assertions, with ID, parent,
  title, body and stable handle verified. Both temporary pages deleted.
- Typecheck: all four tasks passed.

Names without IDs, cross-space moves, parentless items, namespace removal and
remaining recovery/resource/editor acceptance still require work. Public NFS RW
remains gated; the overall objective is not accepted.


## Slice 135 — offline recovery for current namespace journals

The offline reader still rejected schemas newer than 12, including journals
written by the current implementation. It now reads schemas 8–15 without a
migration or network request and includes move receipts even when no page image
was staged. Records sharing an ID are merged; namespace-only records report
`hasCurrent: 0` and cannot export invented bytes. Older move schemas retain an
unknown original title. Existing export permissions and exclusive creation stay
unchanged.

- The existing recovery suite reproduced the schema rejection before the fix.
- macOS/Linux broad core and CLI VFS suites: 700 passed, 34 opt-in native/helper
  cases skipped, 3548 assertions on each host. These runs do not claim native
  mount acceptance.
- Recovery tests cover schemas 13, 14 and 15, namespace-only and merged receipts,
  completed folder moves, exact export, source CLI output and byte-for-byte
  unchanged journal files.
- Linux DOCSY combined move/retitle and subsequent offline inspection: one
  passed / seven assertions. Both temporary pages deleted; native macOS cases
  in that file remained explicitly skipped.
- Typecheck: all four tasks passed.

This fixes inspection/export compatibility; it does not implement negative
uncertain-outcome resolution or receipt eviction. Public NFS RW remains gated.


## Slice 136 — fresh space membership before trash

Deletion previously trusted a resolved node's cached space membership, including
the expected-identity path used by NFS. An external move to another space could
therefore leave an old path capable of trashing that page. The shared core now
fetches metadata immediately before each page DELETE and verifies page ID and
space. This covers NFS, WebDAV and shell callers without transport-specific
checks. Metadata failures prevent that DELETE and use existing error mapping.

- Three regression cases failed before the fix: external space change with and
  without an expected identity, and failure to obtain fresh metadata. After the
  fix all reject without issuing DELETE. The other space is synthetic only.
- macOS/Linux broad core and CLI VFS suites: 703 passed, 34 opt-in native/helper
  cases skipped, 3556 assertions each.
- Linux DOCSY guarded trash and restart reconciliation: one passed / seven
  assertions; the disposable page was trashed. Native macOS cases in that file
  were explicitly skipped.
- Typecheck: all four tasks passed.

Each trashed page now costs one metadata request. REST metadata lookup and DELETE
are not atomic: a concurrent move after the check remains possible. Recursive
removal can still partially complete when a later target fails. Namespace
removal semantics and full acceptance remain open; public NFS RW stays gated.


## Slice 137 — native Linux VS Code new-page autosaves

Real VS Code 1.138.0 (`7debcd0e2acdea1c52de81bf9ee1620444407dda`, x64)
ran on ms-s1-max.local under a dedicated Xvfb display. The official Linux archive
was extracted under `/tmp/atlcli-vscode-linux`; no system installation was
performed. A separate user-data/extension directory set afterDelay autosave to
100ms. The window remained in Restricted Mode, with extensions disabled and no
sign-in. The portable Electron sandbox helper was not installed setuid; this
synthetic test process used `--no-sandbox`.

Two private servers used the current source at 4f0cdc28 and disposable synthetic
DOCSY clients. Native mounts used `nfsMountOptionsFor("linux", port, "rw")`
and davfs2 with a private cache, `ask_auth 0`, `delay_upload 0`, and the test user's
UID/GID. Core coalescing was disabled as in the previous editor harness; NFS's
500ms publisher quiet window remained active.

The Electron DevTools connection supplied actual editor keyboard/text input:
open a nonexistent mount `code-new.md`, type plain Markdown, Ctrl-S once, then
Ctrl-A/type a replacement twice without sending Save. No filesystem write
script or editor extension supplied document bytes. The workbench DOM and
backend snapshots were inspected after each step.

- NFS: one CREATE, then two UPDATEs, versions 1/2/3 of page 700000001. Bodies
  were respectively `First`, `Second`, `Third plain Linux page 🐴`. The original
  alias stayed open throughout; the final alias and ID-directory `_index.md`
  both returned the final body. No pending journal publications remained.
- WebDAV: one CREATE and three UPDATEs, versions 2/3/4 after the three user
  edits. The first save incurred an extra version; each subsequent autosave
  added one. All three Unicode bodies matched the editor text, and final reads
  via alias and ID-directory `_index.md` agreed. This is successful editor
  acceptance, not a claim of minimal first-save version churn.
- The test editor exited 0 after closing its window. Both harnesses exited 0
  after normal unmount; davfs2 completed its graceful shutdown. `findmnt` showed
  neither owned mount afterward. The dedicated Xvfb process was stopped.
- No real tenant pages were used or changed. This closes the previously missing
  Linux VS Code synthetic editor case; live-tenant editor evidence remains
  separately scoped. Typecheck: all four tasks passed.

The scratch harness/CDP driver and snapshots remain under the private temporary
test directory for diagnosis. The requested editor matrix now has native
new-page/repeated-save evidence on both OSes, but final packaged-artifact, fault,
performance and live-tenant requirements remain open. Public NFS RW is gated.


## Slice 138 — publish a new WebDAV PUT once

The WebDAV dependency invokes create before opening a new PUT stream. The
adapter previously published an empty page in that callback and updated it
when the stream finished. PUT creation is now request-local until stream final:
its size is zero for that request's storage check, and the existing final-write
path creates the page with its complete body. A weak map avoids retaining ended
request contexts. Other creation methods and editor draft handling are unchanged.

- Tightened HTTP regression failed before the change (version 2 instead of 1).
  It now proves one CREATE, zero UPDATEs, version 1 and no extra versions from
  repeated identical PUTs. A streamed-body test observes no CREATE before final
  bytes and verifies Unicode plus an explicitly empty PUT.
- macOS/Linux broad core and CLI VFS suites: 704 passed, 34 native/helper opt-ins
  skipped, 3565 assertions each. WebDAV HTTP suite alone: 42 passed / 183 asserts.
- Native WebDAV Vim new-page/repeated-save tests with and without backups: two
  passed on each host, 26 assertions on macOS and 28 on Linux (cache ownership
  cleanup adds the Linux assertions). All mounts detached normally.
- Linux DOCSY HTTP PUT/DELETE: one passed / five assertions, now including the
  real page's initial version 1 and expected body. Disposable page trashed.
- Real Linux VS Code repeated with the isolated profile from Slice 137: initial
  save still reached version 2, next autosave version 3 with the same ID. A
  separate traced run showed three core writes: empty, empty, then the actual
  Unicode body. Thus the adapter's within-PUT issue is fixed, but native client
  creation/empty-write semantics still need investigation before claiming
  minimal first-save churn. No real tenant content was used in these GUI runs.
- Test windows closed, both extra harnesses exited 0 after graceful davfs2
  unmount, and the dedicated Xvfb display was stopped. Typecheck passed all four
  tasks, including the final live-test assertions.

Public NFS RW and overall acceptance remain gated.


## Slice 139 — full-build checkpoint and current API reports

Both hosts completed all 35 repository build tasks. The macOS full repository
run finished with 9283 passed, 98 skipped, two failed and 46981 assertions across
760 files. Its only failures were stale public API and closure reports left by
the NFS work. The reports were regenerated from fresh dist and reviewed: the
Confluence additions are optional creation properties, lastModified and trash
status; the experimental VFS additions describe guarded writes, namespace
reconciliation and identity lookup. No stable export was removed. The dedicated
API/closure guard rerun passed all five tests / 14 assertions, including the
guard's negative fixtures. This is a broad run plus a targeted repair check,
not a subsequent all-green full run.

Linux's first full run found older packaging/test sources and Node 20.19.4, which
Astro rejects. That run had 9250 passed, 104 skipped and 24 failed; it is not
current-source acceptance. Changed NFS/package/CI sources and reports were
synchronized after it ended; pre-sync existing files were archived under /tmp.
Two unrelated documentation differences were preserved. The corrected run uses
the already-installed Node 24.12.0 and is still running at this checkpoint.

- macOS Rust helper: all seven unit tests passed with the locked dependency set.
- Linux synchronized Rust helper tests and full rebuild passed before the new
  full test run began.
- Typecheck: all four tasks passed. Linux DOCSY PUT/readback/DELETE: one passed /
  five assertions, with initial version 1 confirmed and temporary page trashed.
- Full tests wrote a generated Starlight inventory and Astro dist-file output;
  those test artifacts were restored/removed and are not included in the commit.

CI run 35232069381 on 1ccd0a9f failed native NFS acceptance. Linux x64 and arm64
returned the correct directory contents but exceeded the 5000ms fresh-listing
budget (7022ms / 6707ms). Both macOS arm64 and Intel hit the 30s timeout in the helper-death recovery
test. These are explicit
open failures, not waived performance or durability gates. Public NFS RW remains
gated. The next work is to diagnose these native failures and finish the aligned
Linux repository run.


## Slice 140 — deterministic journal close and hard-mount recovery

The helper-death test exposed two separate issues. A hard mount can wait for RPC
replies while unmounting after its helper is dead. The test now restores the
journal-backed endpoint at the same port before normal detach/remount. It proves
that an old root handle receives ESTALE from the new helper generation. No
forced/lazy unmount or softened RW retry semantics are used. This remains an
internal recovery path; automatic public CLI RW recovery is not implemented.

Reordering recovery also reliably exposed SQLite writer locks surviving close.
Inspection of the installed Bun implementation showed that Database.query caches
20 statements; later statements are prepared without entering that cache, and
Database.close only finalizes cached statements. The journal now owns its fixed
SQL-template statement map, finalizes every entry, and closes strictly. This
reuses the repository's explicit-statement-lifetime pattern and neither changes
the database schema nor relies on GC to release locks.

- New mixed editor/publication regression failed on the old code with database
  locked and passed with the fix; acknowledged page bytes, local draft and
  interrupted publication intent survive immediate reopen without GC.
- macOS/Linux broad core and CLI VFS suites: 705 passed, 34 opt-in native/helper
  cases skipped, 3568 assertions each.
- Final native hard-mount/helper-death/recovery test: one passed / 13 assertions
  on each host, approximately 4.66s macOS and 1.17s Linux. Confirms persisted
  denied-publication bytes, restored publication at version 2, old-handle ESTALE,
  normal detach and fresh-mount readback. Owned mounts were cleaned up.
- Linux DOCSY owned-journal restart/publication: one passed / five assertions,
  disposable page cleaned up. Typecheck: all four tasks passed.

The aligned Linux full repository rerun from Slice 139 completed with 9278
passed, 104 skipped, one failed and 46926 assertions across 760 files. Its sole
remaining failure was the unrelated 500-action palette p95 benchmark; isolated
rerun passed (one test / 37 assertions, p95 30.67ms). This is a full run plus a
targeted isolation result, not an all-green full rerun after this journal fix.
The Linux native directory-listing CI budget failure remains open. Public NFS RW
and overall acceptance remain gated.


## Slice 141 — avoid quadratic LOOKUP parent enumeration (2026-09-17)

Profiling the synthetic 600-entry Linux mutation test found 956 GETATTR bridge
calls consuming 7529.8ms across both listings, compared with 19 READDIR calls
consuming 431.3ms. LOOKUP requested parent attributes each time; the adapter
computed those by enumerating/registering all siblings. TCP_NODELAY was already
active. The uninstrumented baseline fresh listing took 4015.9ms.

The vendor LOOKUP handler now omits incidental parent post-operation attributes,
consistent with the existing READ approach. Parent and child resolution still
validate identity, type and export scope; explicit GETATTR and READDIR refresh
directory revisions. RFC 1813 section 2.5 allows absent attributes while
encouraging best effort; a client can request them separately. No cache, TTL or
timeout was added or widened. The wire regression fails with the old helper and
checks success, missing/invalid names, no sibling enumeration, and explicit
GETATTR refreshing the parent.

The dispatch-deadline fixture formerly relied on LOOKUP making three sequential
bridge calls. It now uses exclusive CREATE (pre-attributes, creation,
post-attributes), retaining the same three 45-second delays and 120-second
connection deadline. The first full runs reported only this obsolete fixture
failure; all other 30 cases passed on each host (1384 assertions), with Glow
intentionally skipped because no executable was supplied. Native coverage
included RW Vim saves, helper-death recovery, external changes, immutable views,
attachments and single/multi-space roots. Fresh listings were 500.5ms Linux and
788.5ms macOS; a separate Linux probe was 512.6ms. The 5-second budget is unchanged.

Additional checks: adapter 74 passed / 844 assertions; Rust seven passed;
typecheck all four tasks passed; Linux real DOCSY owned-journal restart and
publication one passed / five assertions, disposable page cleaned up.
Overall acceptance and public RW remain gated; four-platform CI must still
confirm the listing improvement.

The updated dispatch-deadline regression passed separately on both hosts:
one test / seven assertions each, disconnecting after 120.01 seconds. This is
full-suite coverage plus the corrected fixture rerun, not a second full-suite
run. Native test mounts were normally detached.


## Slice 142 — CLI helper recovery before normal detach (2026-09-17)

The surviving CLI now finishes the dead helper's publisher/journal lifecycle,
restarts the endpoint once on its original port and updates the stored helper
PID/process identity before requesting normal unmount. Shutdown waits for a
concurrent recovery so an explicit signal cannot leave the replacement behind.
Busy volumes retain the replacement and state until a later normal shutdown.
No forced/lazy detach or unrelated process signalling was added. Parent SIGKILL
and failed restart remain explicit recovery limits; public RW remains gated.

Linux real DOCSY source CLI: all five existing lifecycle cases passed (signal,
busy, explicit unmount, helper crash, parent crash), 64 assertions. Added native
helper-crash-while-busy regression passed separately, 20 assertions: the saved
helper PID changes, its identity is live, its port is unchanged, mount/state
survive the busy detach, and releasing the holder then signalling cleans up.
All tests read DOCSY only. Mount-command unit tests: 20 passed / 153 assertions.
Final typecheck: four tasks passed. macOS native hard-mount recovery is covered
by Slice 141; the public macOS CLI tenant test remains unverified because the
local config has only the acme profile, not mayflower. This is not a claim that
the complete lifecycle/fault acceptance is finished.

Final six-case Linux lifecycle rerun passed together: six tests / 85 assertions,
including verification that the replacement helper is gone after final detach.
No owned test mounts remained. Slice 141 CI Linux jobs are now green: x64 fresh
listing 861.2ms and arm64 799.1ms, each 174 passed / zero failed in the native
suite, without increasing the 5-second limit.

All four native jobs in CI run [35236587926](https://github.com/BjoernSchotte/atlcli/actions/runs/35236587926)
completed successfully on source c0169c47. macOS arm64 measured 772.7ms and Intel
653.2ms; both also passed all 174 native-suite tests. This confirms Slice 141's
listing-budget repair and Slice 140's helper-death test repair across the matrix.
These CI results precede the Slice 142 CLI recovery change; draft-skipped product
quality checks and final compiled-CLI mount acceptance remain open.


## Slice 143 — compiled CLI native mount acceptance in CI (2026-09-17)

Extended the existing built-shell HTTP stand-in with empty comment collections
and a compiled CLI mount case. It clears the helper override, starts the binary,
lets it discover the adjacent companion, mounts through the native kernel,
lists the root, reads Unicode, verifies EROFS on write, then signals the CLI
and verifies normal detach plus state cleanup. Fixture teardown refuses to
recursively remove an attached test mount. No real credentials are used here.
The four native CI lanes now run this case and the existing shell smoke tests
against the actual extracted review archive, after their bridge/kernel suite.

Local development-compiled binaries with adjacent helpers: macOS arm64 ten
passed / 42 assertions; Linux x64 ten passed / 43 assertions. Linux also ran
all six real DOCSY compiled-CLI lifecycle cases: six passed / 85 assertions,
including helper death while busy and parent death. These local binaries are
not claimed as release archives; CI validates that packaging boundary.
Final typecheck passed all four tasks.

The macOS real-tenant lifecycle/editor proof remains open because the local
Mayflower profile is unavailable. Synthetic native tests do not replace that
requirement. Workflow policy tests passed (35 tests / 614 assertions).


## Slice 144 — helper-independent artifacts and native WebDAV RO (2026-09-17)

The compiled smoke suite now copies only the CLI into its own disposable
directory. With no helper, NFS startup fails before creating a mountpoint and
explains the missing executable. Version and shell commands still succeed.
An adjacent executable that exits unsuccessfully likewise does not affect the
shell. A second isolated binary proves WebDAV needs no NFS companion: native
mount/read on macOS, HTTP read/denied PUT on Linux, followed by normal shutdown.
The five-process helper-independence case has a 30-second test timeout; macOS's
cold copied executable exceeded the default five-second aggregate timeout.
This is a correctness test, not a relaxed product performance gate.

The macOS WebDAV check exposed a real RO bug: a filesystem write resolved
successfully into the OS cache despite server-side denial. The platform mount
command now passes `-o rdonly` for RO; explicit RW retains its writable mount.
Linux instructions and fstab examples now carry the selected mode too. The
existing RW live kernel caller passes its mode explicitly. All callers were
reviewed. The compiled native regression failed before the fix and now rejects
writes with EROFS. Local mount_webdav(8) documents the rdonly option.

Validation: macOS and Linux each passed 33 tests / 218 assertions (compiled
artifact smoke plus mount-command tests). Linux DOCSY WebDAV LIVE: two passed /
12 assertions, disposable resources cleaned up. Typecheck: four tasks passed.
The existing four-platform workflow invokes this expanded suite against its
extracted native release review archive; current-slice matrix results remain
pending. macOS real-tenant tests still need the unavailable Mayflower profile.

Slice 143 CI passed the new compiled native mount on all four platforms. The
Intel macOS job then failed two pre-existing multi-command shell smoke cases
on their default five-second aggregate timeout (extra commands and help).
Those two/three-process cases, plus the other two-process cases, now allow
15 seconds; the copied-binary five-process case allows 30 seconds. No listing
or other product performance threshold changed. A fresh matrix must verify
these correctness-test budgets; the old Intel job is not reported as green.


## Slice 145 — native RW advisory locks and gate audit (2026-09-17)

Reused the existing native lock probe for the staged RW mount. With an r+b
file, both flock and POSIX lockf now prove exclusive-lock contention against a
second process, then successful acquisition after unlock. The RO flock/shared
lockf probe remains. Python subprocess deadlines bound accidental NLM waits.
macOS and Linux each passed the native RW save/fsync case and the RO read case:
two tests / 75 assertions. This proves same-host local advisory locks only;
no cross-client lock service or consistency guarantee is added.

The source audit identifies two concrete next durability investigations beyond
these lock checks: a lost successful UPDATE followed by an external edit may
send an unnecessary identical merged PUT; and first-journal ancestor-directory
fsync ordering plus actual filesystem exhaustion after remote success require
stronger evidence than process SIGKILL or SQLite max_page_count tests. Bounded
storage rejection itself meets the cap requirement; clean-record eviction is
an operational improvement, not independently required by the durability gate.
Public RW remains gated pending the full requirements/fault audit.

Linux DOCSY owned-journal restart/publication also passed (one test / five
assertions), with disposable-page cleanup; typecheck passed all four tasks.
Namespace audit against the linked original VFS PLAN confirms ordinary mkdir
publication and cross-space moves as genuine write-parity gaps. Parentless
objects need explicit support without weakening homepage protection. Conversely,
remote RMDIR returning ENOTEMPTY preserves the original recursive-delete guard;
ID-less existing-directory rename is additional convenience beyond the explicit
unchanged-ID retitle contract. These distinctions do not remove the pending
checkpoint entries or enable public RW.

## Slice 146 — replay after a later remote edit (2026-09-17)

The shared write-back path now checks exact storage and title after a successful
three-way merge, avoiding an identical PUT when a lost successful update is
already contained in a newer remote version. It retains storage comparison
rather than relying on potentially lossy Markdown equality.

A publisher regression injects a lost version-2 reply, adds remote content in
version 3, then replays the frozen journal intent. Before the fix it produced
version 4; afterward it preserves version 3 and the remote addition, clears the
intent and pending image, and performs no further publication. Both hosts passed
124 publisher/write-back tests with 484 assertions. Linux DOCSY owned-journal
restart/publication passed one test / five assertions with disposable cleanup.
Typecheck passed all four tasks. Public NFS RW remains gated.

## Slice 147 — journal ancestor-directory persistence (2026-09-17)

After SQLite initializes the journal, startup now fsyncs its real containing
directory and each ancestor through the filesystem root. Resolving the real
path covers symlinked cache locations. The chain is synced on every open, so
existing directories left by a failed startup are not mistaken for durable
entries. Errors close the directory descriptor and database and abort startup
before the mount can acknowledge writes. SQLite EXTRA/fullfsync remains enabled
for journal transactions; see the [SQLite synchronous contract](https://www.sqlite.org/pragma.html#pragma_synchronous).

The regression injects a directory-sync EIO, verifies startup rejection and
descriptor closure, then opens the same database immediately, checks the entire
leaf-to-root sync order and preserves staged bytes across another reopen. This
would fail before the fix. Both macOS and Linux passed 165 journal, publisher
and filesystem tests / 1677 assertions. Linux DOCSY owned-journal publication
passed one test / five assertions with disposable cleanup; typecheck passed
all four tasks. This is ordering/error-path evidence, not an actual power-cut
test. Real filesystem exhaustion after remote success remains a separate gate.

## Slice 148 — real filesystem exhaustion after remote success (2026-09-17)

Added an opt-in publication fault suite that creates its own 64 MiB image:
APFS on macOS, ext4 loop mount on Linux. It verifies the mount has a distinct
device and bounded capacity before filling it. After the synthetic server
accepts CREATE or UPDATE, the test writes until the OS reports ENOSPC; persisting
the publication receipt then fails with SQLITE_FULL. This exercises actual
filesystem exhaustion rather than SQLite max_page_count.

After closing the publisher/core/database and freeing the filler, a fresh
journal/core instance must retain the exact acknowledged Unicode bytes and
frozen intent, reconcile the remote result, clear pending state, and issue no
additional CREATE or UPDATE. Both cases passed on both hosts (two tests /
26 assertions each). Images were normally detached and removed; no owned mount
remained. There is no product change in this slice and no claim of power-cut
or physical-device failure testing.

Run with `ATLCLI_NFS_STORAGE_FAULTS=1 bun run test apps/cli/src/vfs/nfs-storage-faults.test.ts`.
Linux needs passwordless sudo mount/umount and e2fsprogs. The four-platform NFS
workflow now invokes this suite; results for this new matrix step are pending.
Workflow-policy tests: 35 passed / 614 assertions. Typecheck: four tasks passed.
Linux DOCSY owned-journal publication: one passed / five assertions, disposable
resources cleaned up. Public RW remains gated by the remaining requirements.

## Slice 149 — atomic page-directory journal identities (2026-09-17)

Schema 16 extends the existing creation promotion with an optional directory
identity. A page-directory allocation persists the directory and writable
_index.md in one transaction. Promotion retains distinct directory/body aliases
and attributes, preserves newer body edits, and relocates local descendants
atomically. Frozen child creations or path collisions roll back promotion while
retaining the confirmed parent receipt. Confirmed trash retires both aliases
and the directory metadata row without deleting the recoverable page image.

Schema-15 file aliases migrate unchanged; offline recovery now accepts schema
16 without mutating it. Tests cover quota rollback during allocation, restart
before and after promotion, child bytes/path retention, directory-write rejection,
collision rollback, frozen-child guards, separate mode bits and alias retirement.
macOS and Linux each passed 182 journal/publisher/filesystem/recovery tests with
1784 assertions, plus both real ENOSPC cases (26 assertions). Linux DOCSY
owned-journal publication passed one test / five assertions with cleanup;
typecheck passed four tasks.

This slice prepares the durable representation only. The NFS MKDIR adapter,
parent-first publisher scheduling, role-aware handles/alias traversal, native
mkdir/editor verification and DOCSY directory publication are still pending;
ordinary directories are not yet automatically published. Public RW stays gated.

## Slice 150 — parent-first page-directory publication (2026-09-17)

The publisher now recognizes durable _index.md images inside ordinary local
page directories and sends guarded, token-marked creation at the missing
directory path. Existing CREATE receipts, reconciliation and atomic promotion
are reused. If a child is requested first, its ancestors publish first through
the same single worker without awaiting another queued worker task. Parent
quiet-window timers are respected; children are resumed after promotion.

Hidden/editor staging ancestry, backup/temporary suffixes and macOS .sb-
containers do not publish Markdown or directory bodies. Tests cover nested
parent IDs, child-first requests, lost parent replies followed by restart,
pre-publication rename, changes during initial POST, quiet windows and denied
parent creation with retained child bytes and no fallback creation.

macOS and Linux each passed 193 journal/publisher/filesystem/recovery tests /
1837 assertions. New Linux DOCSY LIVE directory + child publication passed
one test / 12 assertions, checking both API parent IDs, initial versions,
Unicode body content and aliases after journal reopen; test pages were deleted
child-first. The first LIVE assertion was corrected to decode Confluence HTML
entities before comparing Unicode. Existing owned-journal LIVE also passed
one test / five assertions. Typecheck: four tasks passed.

Native MKDIR allocation/scheduling and role-aware directory/body handles remain
the next integration slice; no native mkdir completion is claimed here. The
Slice-148 CI run 35242504420 completed Linux arm64 successfully, but the next
push cancelled its other native jobs; this is not an all-platform green run.

## Slice 151 — native MKDIR publication and stable handles (2026-09-17)

NFS MKDIR now atomically allocates an ordinary directory and _index.md, then
schedules the existing publisher. Directory and body promotions resolve to
distinct stable handles; original directory aliases and children survive
promotion and journal reopen. Directory mode/atime/mtime stay separate from the
body. Hidden-to-visible tree rename allocates missing bodies atomically and
schedules publication; quota failure rolls the rename back. Editor staging
containers retain their local-only behavior.

A concurrent parent-publication regression initially failed with ENOENT for a
local child read. pathFor now rechecks the identity after asynchronous parent
validation and resolves its relocated path before proceeding. The test passes.
Native macOS and Linux mounts both prove MKDIR, body/child saves, unchanged open
descriptor inode identities and canonical/original paths (83 assertions in the
RW kernel case on each host). Linux DOCSY native mkdir plus Vim body save passed
one test / 11 assertions, verifying API content, correct parent ID, subsequent
version increase and cleanup of both disposable pages.

The broad six-file runs on each host produced 234 passes, one intentional Glow
skip and one obsolete RMDIR test failure (3284 assertions). Ordinary directories
now contain _index.md, so that wire test was updated to require ENOTEMPTY until
removing the body; its targeted rerun passed on each host (26 assertions). No
remaining failure was observed in these runs. Typecheck passed four tasks.

CI of the preceding publisher slice (run 35244388570) passed Linux x64/arm64 and
macOS arm64. Intel macOS passed CREATE exhaustion but hdiutil reported Resource
busy while creating the second APFS test image; compiled smoke was not reached.
This test-environment failure remains to fix/revalidate. Public RW remains gated
pending remaining namespace, fault, resource and final artifact requirements.

## Slice 152 — reuse the isolated exhaustion-test volume (2026-09-17)

The storage-fault suite now provisions one owned 64 MiB APFS/ext4 image for both
CREATE and UPDATE cases. Each case still uses a separate journal, cache and
synthetic client, closes/reopens its journal after actual ENOSPC and checks
duplicate-free reconciliation. This removes the second hdiutil-create step that
failed with Resource busy in Intel CI; it does not retry or suppress faults.
Both operations log successful verification independently. The volume is
normally detached once after both cases.

macOS APFS and Linux ext4 each passed the combined test (24 assertions); the
two shared device/capacity assertions now run once. No owned test mounts remained.
Linux native DOCSY mkdir/Vim LIVE passed one test / 11 assertions with cleanup.
Typecheck passed four tasks. Intel runner confirmation is still pending on the
new CI run; no all-platform success is claimed from local arm64 evidence.

## Slice 153 — protect the homepage in the shared VFS (2026-09-17)

The parentless-item audit found that the shared rename operation accepted the
homepage's `_index.md` as a move source. The new regression failed on the old
implementation: moving the homepage resolved successfully. Shared rename and
delete now reject that identity before any remote mutation, protecting shell
and mount callers alike. Reading and editing the homepage body remain allowed.

macOS and Linux each passed 159 tests / 1105 assertions across shared write-back
and NFS filesystem tests. Linux DOCSY owned-journal LIVE passed one test / five
assertions and cleaned up its disposable page. Typecheck passed all four tasks.
No destructive homepage operation was attempted against the live tenant.

Parentless items remain open: shared space listing and path resolution currently
start at the homepage and enumerate its children. Removing only the NFS
source-parent check would not make genuine parentless items accessible. Their
listing/resolution and durable move representation require a coordinated change.
This slice does not claim that coverage or remove the public NFS RW gate.


## Slice 154 — journaled cross-space moves and live metadata (2026-09-17)

The internal RW adapter now moves page/folder trees between selected spaces.
The existing durable target path carries the destination space; source space
and parent guards remain explicit. Schema 17 marks the changed receipt semantics
so older writers cannot resume a cross-space receipt as a same-space move.
Lost replies are confirmed in the destination space; a combined page retitle
resumes only after positively observing the moved page with its original title.
No uncertain reparent is blindly retried.

Tests exposed stale cached frontmatter after a space move without a version
change. The shared page store now renders current title/parent/URL over cached
body bytes without downloading that body again. Clean staged images refresh on
URL changes too, and live NFS page attributes track rendered-byte changes even
without a new Confluence version. Immutable version reads stay separate.

- macOS and Linux: 567 tests / 2923 assertions each across all shared VFS tests
  plus NFS filesystem, journal, publisher and offline recovery suites.
- Native NFS RW mounts on macOS/Linux: one test / ten assertions each, moving
  both page and folder subtrees between two synthetic spaces while descendant
  descriptors remain open. Inodes, complete Unicode bytes and destination URLs
  verified after the documented one-second attribute-cache window.
- Restart tests cover lost page/folder move replies and combined page retitle,
  with exactly one positional move. The shared guard rejects an unrecorded
  destination space before mutation. Typecheck passed all four tasks.
- Linux DOCSY owned-journal LIVE: one test / five assertions, disposable page
  cleaned up. Cross-space writes used synthetic backends only; MAYFLOWER was
  not written. No live cross-space proof is claimed.

Parentless items, ID-less existing-directory renames, removal/mutation audits,
remaining durability/resource/artifact gates and final performance acceptance
remain open. Public CLI NFS RW remains gated.


## Slice 155 — Cloud parentless pages and root-preserving rename (2026-09-17)

The shared VFS now lists Cloud pages outside the homepage tree alongside
homepage children. Root listings use the documented body-free
[`GET /spaces/{id}/pages?depth=root`](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/#api-spaces-id-pages-get),
reuse the already resolved space ID, follow short cursor pages, validate source
space/absent parents and cache that level with the existing metadata TTL. This
adds a root-level metadata request (plus pagination), not a full-space scan.
Snapshots retain loaded roots for offline use; an absent homepage is cached too.
Root folders and parentless Data Center pages remain outside this endpoint.

A live test exposed the old canonical-path assumption that every parentless
page was the homepage. Canonical ID links now stop only at the actual homepage
ID, preserving another root's name and the path of its children. In-place
retitles preserve a null parent instead of implicitly moving the page under the
homepage. Moving into a page still selects that parent. The homepage namespace
protection from Slice 153 remains in place.

Journal schema 18 transactionally migrates move receipts to nullable source and
target parents. Existing pending/completed receipts are retained; null target
parents are admitted only for same-directory retitles of parentless sources.
Tests cover migration/reopen, lost move and retitle replies, exactly-once API
calls, stable handles, disappearing roots, offline metadata and no-homepage
spaces. No journal discard or blind reparent retry was introduced.

- Broad macOS/Linux suites: 576 passed / 2985 assertions each across all shared
  VFS tests, the root REST contract and NFS filesystem/journal/publisher/recovery.
  After eliminating the redundant space-ID lookup, the affected root/client/
  resolver suites passed again on each host: 64 tests / 148 assertions.
- Fresh compiled CLI on both hosts: 13 tests / 63 assertions each, including
  native NFS/WebDAV RO mounts, helper-independent shell and a genuinely
  parentless page's body and canonical ID link in the synthetic HTTP fixture.
- Native NFS RW page/folder move probe on both hosts: one test / ten assertions
  each; the page source is now parentless and its descendant descriptor stays
  open across the move.
- Linux DOCSY LIVE: one test / nine assertions. A disposable page created with
  the v2 root-level flag is confirmed parentless, listed, read, retitled without
  a parent change and then reparented through the NFS adapter. IDs/handles and
  cleared move intents verified. Root and destination pages were cleaned up.
  MAYFLOWER was not written. Final typecheck passed all four tasks.

The preceding pushed source 9cb1646a passed all four native CI lanes in
[run 35248483807](https://github.com/BjoernSchotte/atlcli/actions/runs/35248483807),
including APFS/ext4 exhaustion and compiled CLI mount tests. This closes the
previous Intel provisioning revalidation, not the final RW-enabled acceptance.
Draft-skipped product-quality gates are not counted as passing.

## Slice 156: retire publication retry history

A transient failure before a new draft freezes its CREATE intent can leave a
retry scheduled after the draft is deleted. The subsequent no-op publication
now drops retry history for missing journal identities; completed or removed
move receipts also release their history. Pending identities retain their
existing retry budget and backoff.

The regression repeats transient failure, deletion and retry completion three
times and verifies that no retry entries accumulate and no CREATE intent was
frozen. Full publisher suites passed on macOS and Linux: 55 tests / 320
assertions each. Typecheck passed all four tasks. Linux DOCSY LIVE journal
resume/publication passed: one test / five assertions; the four macOS-only
tests were skipped, not claimed as passing. The fixture cleans up its owned
page. Public NFS RW remains gated pending final acceptance.

## Slice 157: native recursive-removal semantics

The native RW test now invokes the system `rm -r` on an owned synthetic leaf
page on both macOS and Linux. It verifies a nonzero exit, confirmed remote
trash of that page, a completed durable trash receipt, and disappearance of
the original directory. Generated comments/version/attachment views remain
protected; removing `_index.md` can still trash the page during a recursive
walk. Recursive deletion is therefore not an atomic operation. User docs now
state this explicitly and recommend targeted body removal. No protection was
weakened to make recursive removal appear successful. Existing adapter tests
cover ESTALE after confirmed trash and reject writes during DELETE.

Both native RW runs passed: one test / 87 assertions per host, also covering
Vim creation/replacement, mkdir publication, moves, locks and byte writes.
Mounts detached normally. Typecheck passed all four tasks. Linux DOCSY LIVE
journal resume passed: one test / five assertions, four host-specific tests
skipped; owned page cleanup completed. This is synthetic native deletion
evidence, not a claim of a real-tenant recursive deletion test.

## Slice 158: comparative editor/Glow metrics and Linux upload latency fix

Extended the existing native comparison to three independently cold workloads:
complete reads, Glow first selection/render and actual Vim saves. Five cold/warm
samples per transport/workload/host yield 60 records per host. API accounting
now includes serialized metadata responses as well as bodies and attachments;
an assertion detects unaccounted successful fixture API calls. These are
synthetic response payload bytes, not HTTP wire traffic. The report records
all numeric medians/ranges, host/client versions and >10% review triggers in
[PERFORMANCE.md](PERFORMANCE.md), with complete extended JSON samples.

The initial Linux matrix exposed davfs2's default ten-second upload delay:
median save-to-API 11,510.5/11,514.1 ms cold/warm. The user rejected that latency.
The CLI now writes an owned, credential-free per-mount davfs configuration with
`delay_upload 0` beside its mount state and includes `conf=` in its printed
mount/fstab instructions. Existing mounts need a normal remount. System-wide
configuration is unchanged; normal VFS coalescing remains configurable and
defaults to 500 ms. Shell paths are quoted using the existing transport helper.

The final Linux five-run matrix uses the same config constant as production:
WebDAV 508.1/501.9 ms and NFS 509.8/505.0 ms median save-to-API cold/warm. Vim's
BufWritePre writes a local timing marker; editor startup is measured separately.
Every save verifies the expected marker and exactly one new API version.
Warm complete reads make zero API calls on both hosts/transports. Cold startup
does not download the whole corpus. Every test mount was normally detached.

Validation: mount/transport suites passed on macOS and Linux, 26 tests / 193
assertions each. Fresh compiled CLI suites passed on macOS (13 / 63) and Linux
(13 / 66); Linux additionally verifies the generated config bytes and printed
`conf=` option. Typecheck passed all four tasks. Linux DOCSY LIVE journal resume
passed (one test / five assertions, four macOS-specific cases skipped); owned
page cleanup completed.

Limits remain explicit: Glow quits after first render, so its asynchronous
background scan is not a fully drained large-directory comparison. No universal
NFS speed claim or public RW acceptance is inferred from these measurements.

## Slice 159: finite durability matrix and MOVE/TRASH receipt boundaries

[DURABILITY.md](DURABILITY.md) maps the concrete local commit, directory fsync,
remote-effect, receipt, promotion, concurrent-write and process-lifecycle
boundaries to executable tests and their required recovered state. It separates
injected method failures from real disk exhaustion and process kill from
physical power-loss claims. The acceptance checkpoint no longer treats
optional clean-record eviction or arbitrary ID-less directory retitles as
unimplemented requirements.

Added four adapter tests: MOVE and TRASH each fail immediately before and
after committing their local completion receipt, after remote success. After
closing/reopening the journal and VFS, recovery preserves the exact saved
image, confirms the target state, clears uncertainty and performs only one
remote mutation total. No product behavior was changed in this slice.

macOS and Linux each passed the filesystem/journal/publisher/bridge-failure/
real-storage-fault suite: 207 tests / 1947 assertions. One helper-opt-in test
was skipped in that command and then covered in a separate helper run with
parent SIGKILL, native hard-mount helper death and shutdown reporting: four
tests / 43 assertions per host. APFS/ext4 exhaustion used owned 64 MiB images;
all native test mounts detached normally. Typecheck passed all four tasks.
Linux DOCSY LIVE journal resume passed (one / five; four host-specific cases
skipped), with owned page cleanup. Public RW and final CLI acceptance remain
open; the finite matrix is not a substitute for those gates.

## Slice 160: compiled CLI lifecycle on both native hosts

The packaged CLI fixture now covers NFS SIGTERM, a cwd-held busy mount with
SIGINT/retry, helper SIGKILL with normal recovery/unmount, helper SIGKILL while
busy, and explicit `wiki mount unmount`. The busy-helper case verifies the
replacement PID and its saved process identity before releasing the owned cwd
holder. Every case verifies normal detach and removal of the mount record.
Cleanup checks every fixture mountpoint before deleting the fixture home.
WebDAV remains tested without a companion.

macOS previously returned false silently when normal unmount failed. It now
prints an actionable message that the server stays running and the user should
close files/leave the directory before retrying Ctrl-C. The compiled busy tests
assert that message and continued server/mount state.

Fresh compiled CLI results: macOS six lifecycle cases / 65 assertions plus
eleven shell/packaging cases / 45 assertions; Linux all 17 / 117. Typecheck
passed four tasks. Linux DOCSY LIVE journal resume passed (one / five, four
host-specific skips) and cleaned its owned page. These CLI lifecycle mounts
are RO; final public RW artifact repetition remains required.

CI review found the earlier Slice 157 Linux failure in recursive deletion:
`rm -r` exited unsuccessfully but had not trashed the fixture. The harness now
uses noninteractive `rm -rf`, avoiding GNU rm write-protection prompts; this
does not bypass the VFS-generated views' EROFS protection. Native RW suites
passed again on both hosts (one / 87 each). Linux CI revalidation is still
required; local passes are not substituted for the failed CI result.

## Slice 161: complete Glow scans and macOS retry timing

Added an explicit `glow-scan` benchmark workload with 602 pages and an expected
602-document TUI count before selecting/rendering. Native resize events force
full redraws rather than interpreting incomplete terminal counter updates;
observation resolution is up to 500 ms. Each workload remains independently
runnable; the default matrix now includes it. First-byte timing includes the
full scan when selection intentionally waits for enumeration. Warm scans assert
no duplicate page/version/attachment body downloads, while recording all
metadata calls and any first-ever version read.

The old macOS NFS options intermittently omitted one page. A temporary Glow
2.1.1 diagnostic build (upstream d37e9887875a2faa4baee6a7d090eb357dd63771)
logged each found synthetic path; an instrumented gitcha walker identified
`fdopendir: operation timed out` on a missing page directory. macOS now supplies
`dumbtimer`, preserving the configured timeout rather than its adaptive
loopback estimate. No third-party code or dependency was added to the product.
Five cold/warm samples for each transport on both hosts now pass with installed,
unmodified Glow binaries and all 602 documents. Raw data and every numeric
metric's median/range are in `benchmark-glow-scan-{mac,linux}.json`.
PERFORMANCE.md explicitly reviews the slower NFS scans; WebDAV remains default.

The Slice 160 `rm -rf` change did not resolve Linux CI: both Linux lanes still
failed the assumption that recursive removal must have reached `_index.md`.
The native test now requires an actual EROFS diagnostic, permits documented
partial failure before the body, then verifies the supported targeted unlink
and exactly one remote DELETE. It does not weaken server mutation guards.
Linux CI must validate this change; the earlier prompt explanation was not
established by the failed run.

Verification: macOS native RW one test / 89 assertions and all seven native
read variants / 666 assertions; Linux native RW one / 89; mount option tests
four / 31 on each host. Typecheck passed four tasks. Linux DOCSY live journal
resume passed one / five assertions with owned resource cleanup (the separate
four macOS-host-only live cases remain skipped). Every owned benchmark/test
mount detached normally. Final RW-enabled artifacts and required CI remain open.

## Slice 162: native Homebrew artifact consumption in CI

The four-platform NFS workflow now sets up Homebrew with the pinned official
setup action, downloads the companion-aware formula at tap PR #1 commit
`94b7a0c121843a4c3d535ea5d82ee8e773d21ab1`, and consumes the native review archive
built in that job. `scripts/ci/nfs-homebrew-proof.ts` changes only release inputs,
class/name and keg-only isolation; it asserts that the real formula's install
and test methods remain byte-for-byte unchanged. It runs `brew test`, verifies
the helper/license, and runs the existing compiled shell/native lifecycle suite
through the installed Homebrew prefix. No public tap or release is changed.
The proof refuses to replace an existing proof keg, disables automatic updates
and cleanup, and removes its own installation and tap in finally blocks.

Local actual review-archive installs passed on macOS arm64 (17 compiled/native
cases / 110 assertions) and Linux x64 (17 / 117). Both uninstalled/untapped their
owned fixtures. These are non-publishable working-tree review archives, not a
release provenance claim: macOS identifies base c4ee457f, while the synced Linux
test checkout identifies its older base bb0d5363. The CI uses its own checked-out
commit and native artifact. Workflow policy passed 35 tests / 614 assertions;
typecheck passed four tasks. Linux DOCSY live journal resume passed with owned
page cleanup. CI proof for the other two architectures remains pending until the
new workflow actually completes; adding a job is not passing that gate.

The first final LIVE attempt timed out in setup at Bun's default 5 seconds,
before the selected test ran. Repeating with `--timeout 30000` passed one test /
five assertions in 6.21 seconds, including cleanup; this does not claim a
five-second network-setup guarantee. The macOS pre-RW source regression passed
749 tests / 3847 assertions, with 37 opt-in cases skipped and separately covered
by their documented native/fault lanes.

CI [35258939951](https://github.com/BjoernSchotte/atlcli/actions/runs/35258939951)
completed successfully at c4ee457f on all four native architectures, including
the corrected Linux recursive-removal test, native reads/writes, real disk-full
recovery and compiled RO lifecycle. The Homebrew CI additions in this slice
were not part of that run; their results are still pending.

## Slice 163: public experimental RW and compiled native publication

After the finite durability gates (Slice 159), native editor evidence, full
four-platform correctness CI at c4ee457f and local broad regression, the CLI
now accepts experimental NFS `--mode rw` and opt-in trash. `--sync-writes`
remains an early validation error: local stable acknowledgements cannot promise
immediate Confluence commits. The NFS publisher owns the 500 ms quiet window;
the underlying VFS coalescer is disabled for this transport to avoid a second
500 ms delay. WebDAV behavior and the RO default remain unchanged.

The compiled CLI fixture now runs signal, busy mount, helper loss, busy helper
loss and explicit unmount in both RO and RW modes. Each RW case changes a page,
verifies staged read-your-writes and exactly one API version. Vim creates a
plain Markdown page without frontmatter, then a second save through the same
alias updates that same ID. Helper-loss cases also acknowledge another write
immediately before SIGKILL and compare exact recovered bytes using the public
`wiki mount recovery` command after shutdown. Tests use synthetic content only.

Actual native review archives installed via Homebrew passed the expanded suite:
macOS arm64 22 tests / 198 assertions; Linux x64 22 / 210. Both runs used
`GIT_CONFIG_GLOBAL=/dev/null`: the Slice 162 Linux CI failure was a missing Git
author during `brew tap-new`, now supplied through process-local Homebrew
identity variables. Partially created owned taps are cleaned too; no global Git
configuration is changed. The previous CI run 35260093556 passed both Mac lanes
and failed both Linux lanes only at that tap-creation step; the corrected
four-platform result remains pending.

The compiled Linux CLI also mounted RW against the real mayflower profile,
read/wrote one ownership-marked DOCSY fixture, verified Unicode Markdown and
exactly one new remote version, detached and deleted the fixture (one test /
15 assertions). The first assertion compared encoded storage HTML directly;
using the existing storage-to-Markdown converter fixed the test comparison.
No existing tenant page or MAYFLOWER page was written. Mac real-tenant
credentials remain unavailable; its compiled editor tests use the HTTP fixture.

CLI/mount-option tests passed 26 / 189. The broader VFS/WebDAV/NFS plus mount
validation run passed 771 tests / 4005 assertions (37 opt-in skips, not counted
as passes). Typecheck passed four tasks and the full
repository build passed 35 tasks. Public RW remains experimental; final
four-platform packaged proof, full required CI and the final go/no-go audit
are still required. The help and both VFS guides describe local-vs-remote
acknowledgement, quiet-window publication, plain-file creation/aliases, pending
recovery, opt-in trash and the rejected synchronous-write promise.

## Slice 164: close full-CI API-report and Chrome recorder gaps

Full workflow-dispatch run 35261770483 on `be093b3c` exposed stale public
API reports for Confluence and the VFS. Regenerated and reviewed both reports:
changes match the already implemented body-free Cloud root listing, nullable
root parents, and guarded cross-space move destination. The required VfsClient
root-listing member is now explicit in the report; custom implementations must
provide it. No runtime behavior changes in this slice.

The non-required system-Chrome lane failed before opening its recorded page
because Playwright ffmpeg was absent. Install only the pinned 1.55.0 recorder;
the lane still uses system Chrome and remains non-required. The workflow policy
regression requires the recorder without installing a substitute Chromium.

Validation: workflow policy 35 tests / 615 assertions; freshly built API and
closure reports 5 / 14; root-page, tree-index and write-back regressions 121 /
334; typecheck all four tasks. The local HTTP regression initially hit sandbox
listen restrictions and passed with local-server permission. Linux compiled
CLI DOCSY RW LIVE repeated successfully (1 / 15, 4.05 seconds whole case),
including owned fixture cleanup. Remote CI verification of the fixes remains
pending the next pushed head. Final release-helper benchmark matrices completed
on both hosts and await the separate performance report update.

## Slice 165: final release-helper comparison

The complete benchmark finished on macOS ARM64 and Linux x64 with release-mode
companions from the Slice 163 source. Committed all 80 records per host and
median/min/max for every numeric metric. Each workload/transport has five
independent cold mounts and immediate warm repeats. The existing harness
asserts full bytes, complete 602-document Glow enumeration, zero API calls for
warm complete reads, no duplicate warm body fetches, single-version editor
saves, and normal detach. No private wiki data is present in these synthetic
results. These are local review builds, not downloaded CI bundles.

PERFORMANCE.md now uses this final matrix and lists every >10% latency/parent
RSS regression trigger. Linux save-to-API medians are WebDAV 508.3/501.9 ms
and NFS 509.4/504.1 ms cold/warm. Full scans retain a substantial macOS NFS
penalty (7.60/5.61 s vs WebDAV 3.51/1.73 s); Linux cold NFS is slower but
warm NFS is faster. WebDAV remains the default; no universal speed claim.

Workflow 35261770483 completed all four native NFS jobs successfully, including
packaged RW lifecycle and Homebrew consumption. Its overall failure came from
the API-report/Chrome setup issues fixed in Slice 164; the replacement full
workflow 35263039655 remains the required-CI gate. Final plan/docs audit remains.

Validation for this documentation slice: checked all 160 records for the exact
five-run cold/warm matrix and recomputed summary statistics from raw values.
Typecheck passed all four tasks; Linux compiled DOCSY RW LIVE passed again
(1 test / 15 assertions, 4.54 seconds whole case), with fixture cleanup.

## Slice 166: ordinary Chrome conformance checks

The follow-up system-Chrome canary reached the Activity case and failed. A real
local Chrome probe confirmed the cause: ordinary Chrome supplies `chrome.app`,
`chrome.csi` and `chrome.loadTimes` without extension APIs. Activity and both
spool cases incorrectly rejected the mere presence of this native object.
They now share a small assertion that still rejects Node globals and extension
runtime/storage/tabs/scripting APIs, while permitting ordinary Chrome. A
regression checks both boundaries and is included in the harness unit command.
The compiled output scanner remains unchanged and strict.

The first corrected Chrome run passed the cases but exposed a console 404;
the Playwright trace identified `/favicon.ico`. An explicit empty data favicon
prevents that incidental request without filtering console errors.

Validation: actual Chrome full harness passed all six tests; the output policy
and environment regression passed 35 tests / 50 assertions; browser output
scan, harness build/typecheck and root typecheck passed. Linux compiled DOCSY
RW LIVE passed again (1 / 15, 4.17 seconds), with owned fixture cleanup. This
fix concerns the pre-existing browser canary, not NFS runtime behavior. Remote
confirmation remains pending a full CI run on this commit.

## Slice 167: compiled combined-space LIVE repeat and current helper docs

Extended the existing compiled/source CLI lifecycle test with a strictly RO
combined-space case. Against the Slice 163 compiled Linux review bundle,
DOCSY and mayflower appeared as separate directories, no flat root `_index.md`
was exposed, both homepage bodies were readable, and normal signal shutdown
removed the mount/state. One test / 14 assertions passed in 2.81 seconds;
no pages were created or changed.

Updated helper README and the plan/checkpoint introduction to reflect enabled
public RW, durable-local vs delayed-remote acknowledgement, plain new-file
aliases, rejected synchronous writes, and four-platform packaged/Homebrew
proof. No release/tap merge is implied. Remaining final acceptance work is
still explicit rather than checking off the plan wholesale.

## Slice 168: repeat native macOS reads and separate filler sync failures

Final release-helper macOS read matrix passed 7 tests / 666 assertions, including
single/combined roots, attachments, external changes, changing directories,
Glow and immutable snapshots. An initial Glow invocation supplied `1` instead
of the executable path; the corrected run used `/opt/homebrew/bin/glow`.

Run 35263039655 failed the macOS Intel storage-fault assertion: two UPDATE calls
but still the expected single remote version. The exact Intel trigger has not
yet been reproduced locally. Ten unmodified APFS repetitions passed (240
assertions). Inspection identified a separate test-boundary flaw: a delayed
ENOSPC from syncing the disposable filler could escape the fake successful HTTP
response, unintentionally changing this test into a lost-reply scenario. Only
that filler ENOSPC is now accepted; other sync failures still escape. A small
injected regression proves both branches. Journal SQLITE_FULL, exact recovered
bytes, one remote mutation call and one version remain mandatory. Product
persistence/reconciliation logic is unchanged; remote confirmation is still
required, not inferred from this test hardening.

Final real APFS and ext4 runs each passed 2 tests / 26 assertions. Root typecheck
passed all four tasks. Linux compiled DOCSY RW LIVE passed with owned cleanup.

## Slice 169: consolidated requirement audit

Replaced obsolete per-row acceptance placeholders with a current mapping of
every plan requirement group to implementation/test sources and named native
evidence. Rechecked framing, pending work/backpressure, handle and replay caps,
journal quotas, publication retries, vendor provenance/patches, identity tests
and the complete editor matrix. Separate historical GUI proof from current
compiled Vim/native repetitions; do not claim a live second identity or macOS
tenant credentials. The durability matrix now records the later Intel test
observation rather than treating an earlier green run as final acceptance.

No runtime changes. Full required CI (including Intel storage recovery) and
explicit final go/no-go remain the only acceptance gate; they are not checked
off by this document. Root typecheck and the Linux compiled combined-space
RO LIVE test are run before committing this audit.
