# NFS acceptance checkpoint

This is a working audit of PLAN.md, not final acceptance. Public experimental
RO/RW is enabled. Native packaged lifecycle, Homebrew consumption and companion
checks passed on all four declared platforms in run 35261770483; Slice 165
records the final release-helper comparison. The full required-CI rerun and
requirement-by-requirement audit remain open. Historical checkpoints below do
not override newer evidence.
[EVIDENCE.md](EVIDENCE.md) contains commands, host boundaries and detailed results.

## Requirements and remaining proof

Audit at Slice 169. Evidence references are specific test sources and recorded
native executions; skipped opt-in cases are not counted as passed. The final
CI gate remains open, including confirmation of the Intel storage-test issue.

| Plan requirement | Inspected implementation and executable proof | Status |
| --- | --- | --- |
| CLI contract and unchanged default | `wiki-mount.ts`, mount/transport tests; Slice 163 public RO/RW, opt-in trash and early NFS `--sync-writes` rejection | Verified; WebDAV stays default, NFS explicit/experimental |
| Single and combined roots | `nfs-bridge.test.ts` native single/combined cases; Slice 168 macOS 7/666; Slice 167 compiled Linux combined LIVE 1/14, Slice 163 single-root LIVE | Verified; MAYFLOWER only read |
| Exact bytes, ranges, EOF and attachments | `nfs-filesystem.test.ts`, real-wire/native `nfs-bridge.test.ts`; Slice 168 exact-byte/attachment repeat | Verified |
| Immutable versions and live-path freshness | split-UTF8 wire and native snapshot cases, external-change/negative-cache probes; Slices 39, 43–47, 62, 93, 168 | Verified; normal paths can change between READs |
| Handles and namespace identity | filesystem tests cover page/body/directory/attachment identities, rename/reparent, alias promotion, exclusive replay, deleted handles and concurrent replacement; Slices 103, 131–136, 149–155 | Verified; deleted handles become ESTALE, no open-unlink lifetime promise |
| Pagination and changing directories | pinned vendor READDIR/READDIRPLUS patches, wire small-budget/cookie tests and native open-cursor mutation; Slices 57, 161, 168 | Verified; changed views restart via BAD_COOKIE |
| Link/export confinement, RO, honest capabilities | filesystem and wire traversal/foreign-handle/RO tests, homepage protection, unsupported metadata/hardlink/device errors; Slices 48, 56, 136, 153 | Verified |
| Bridge framing and bounded resources | `nfs-framing.ts`, `nfs-bridge.ts`, Rust `main.rs`, vendor TCP/replay code, malformed-frame/deadline/backpressure tests; bounds audit below | Verified |
| Durable WRITE/SETATTR/COMMIT, quotas and crash recovery | exact finite boundary matrix in [DURABILITY.md](DURABILITY.md), SQLite transactions/sync ordering, SIGKILL and real APFS/ext4 faults | Local and previous four-platform proof passed; final Intel confirmation pending |
| Automatic publication, debounce and retry | `nfs-publisher.ts` and tests: 500 ms quiet window, serialized snapshots, newer writes retained, five transient retries with backoff/jitter and Retry-After; Slices 71, 96, 156, 163 | Verified; intermediate valid versions accepted |
| Read-your-writes and remote uncertainty | staged-byte reads, merge/conflict tests, positive CREATE/UPDATE/MOVE/TRASH reconciliation; [DURABILITY.md](DURABILITY.md) | Verified semantics; Intel duplicate-call observation remains under final CI confirmation |
| New plain files, stable aliases and temporary files | native Vim new-file cases, original-path repeated saves, backup/replacement/restart tests; Slices 103, 111, 114–117, 163 | Verified on NFS and WebDAV |
| Editor matrix | actual Vim both OSes (103/111/163), VS Code macOS (113) and Linux (137), TextEdit macOS (112), both transports; synthetic API identity/version checks | Verified; historical GUI runs, current compiled Vim repeat; no claim of fresh GUI runs on every documentation commit |
| Directory create/move/retitle and opt-in trash | native and wire MKDIR, same/cross-space page/folder moves, intermediate recovery and guarded trash; Slices 108–109, 131–136, 149–155, 157 | Verified; recursive deletion is explicitly non-atomic, never purge |
| Local locking | native RO and RW flock/lockf contention/release on both hosts; Slice 145 | Verified; macOS locallocks/Linux nolock, no cross-client lock service |
| Signals, busy mounts, explicit detach and helper/parent death | compiled RO/RW lifecycle including pending-byte recovery; Slice 163; all four native packaged/Homebrew jobs passed in run 35261770483 | Verified prior artifact; current full CI still running |
| Credentials, loopback and process ownership | empty helper environment/private inherited pipes, loopback-only listener, state identity checks, orphan/busy preservation and helper restart tests | Verified; loopback is not local-user authentication |
| Indexer safeguards and accounting | shared shield names, distinct-file sweep hint; RPC counter before dispatch; synthetic API payload ledger assertions in final benchmark | Verified; no automatic protection against arbitrary recursive scans |
| Distribution and supply chain | pinned Rust/Cargo/vendor, license/checksum/protocol/architecture verifiers; native source, archive, shell installer and actual Homebrew execution on four platforms | Verified run 35261770483; no release/tap merge requested or performed |
| Missing helper, offline startup and Windows rejection | compiled absent/unusable-helper shell/WebDAV cases, offline version and local installer fixtures; platform rejection tests | Verified; Windows native NFS outside scope |
| Performance matrix | Slice 165: 80 records per host, four workloads, five cold/warm repetitions, numeric medians/ranges, API/payload/RSS/protocol metrics and >10% review | Verified; [PERFORMANCE.md](PERFORMANCE.md), no universal NFS speed claim |
| Regression/build/docs/CI and final go/no-go | Slice 163 local 771/4005 plus 35-task build; Slice 164 API/closure checks; Slice 166 actual Chrome 6/6; current guides/help and helper README | Full required CI and final go/no-go still pending |

### Bounds and identity audit

The adapter caps handles at 65,536 and never recycles IDs. One hashed directory
signature is retained per known directory, with 32-operation lookup batches.
Names are limited to 255 UTF-8 bytes, READ/WRITE to 1 MiB and bridge frames to
8 MiB. Rust admits 32 TCP connections, sequential dispatch per connection,
4 MiB records/1,024 fragments, 60/120/30-second read/dispatch/write deadlines,
and 4,096 replay entries cleared when their TCP session ends. Both bridge peers
limit pending operations to 32; Bun serializes reply writes and drains stderr
without retaining a growing log. The helper receives an empty environment.

The journal defaults to 4,096 files, 64 MiB per file and 256 MiB logical staged
bytes, with a 545 MiB SQLite-page ceiling. Temporary rollback-journal disk use is
additional and documented. Statement templates are retained/finalized rather
than allocated per request. Publication has one worker; retry state is retired
with deleted/completed identities. None of these bounds promise successful work
past capacity: explicit errors preserve acknowledged bytes.

The reviewed identity paths distinguish local files/directories, canonical
pages, persistent original-name aliases, backups and promotions. Tests cover
concurrent replacement, stale exclusive-create replay, moved descendants,
foreign scopes and homepage deletion protection. No OS symlink or renamed path
is used as a substitute for Confluence page identity.

### Remaining acceptance gate

Complete required CI on the final product source, including native Intel
storage recovery, then record the final experimental go/no-go and close WP6.
The most recent relevant runs are 35263874754 (Chrome fix) and 35265033528
(filler fault isolation); their live results must be checked before acceptance.
Do not convert configured jobs or earlier green architectures into a claim of
current full CI success.

## Accepted product decisions (2026-09-17)

1. **Publication:** editor saves publish automatically. The user explicitly
   rejected a required `mount publish` step and requested buffering of rapid
   saves before sending the latest state to Confluence. Reuse the existing
   500 ms write-coalescing default, with durable staging, serialized publication
   per document and preservation of newer edits. Retry backoff for API failures
   is separate from this save buffering. The user subsequently explicitly accepted intermediate Confluence versions
   when a valid partial image is followed by delayed writes. The contract is
   validated snapshot publication after a quiet window, not guaranteed detection
   of complete editor documents. No editor integration or manual publish step
   is required. This resolves the former completion-boundary product gate.
2. **Read snapshots:** the user accepted normal paths for the current, refreshable
   state and immutable version paths for guaranteed whole-read snapshots.
   Concurrent changes may become visible between READs on a normal path. Version
   paths must never mix versions, including across cache expiry or eviction.

These decisions do not establish that the implementation has passed RW or
snapshot acceptance. Both still require the executable proof above.

## Historical broad verification (not final acceptance)

On macOS at source da25dabe:

- `bun run build`: all 35 build tasks passed, including the CLI bundle.
- `bun run test packages/confluence-vfs/src apps/cli/src/vfs apps/cli/src/e2e/wiki-sh-built.e2e.test.ts`:
  547 passed, 16 intentionally skipped, 2327 assertions.
- The 16 skipped cases require a native helper/kernel opt-in; they are covered
  separately by native test runs and the NFS CI matrix, not counted as passing
  by this broad command.
- No source or generated tracked file changed during the build/tests.

CI run [35179935477](https://github.com/BjoernSchotte/atlcli/actions/runs/35179935477)
passed on source da25dabe: native NFS jobs completed on macOS arm64/x64 and
Linux arm64/x64, including locked helper tests/builds, companion/archive checks
and synthetic native read-only mounts. Documentation, draft type/policy checks,
privacy checks and the draft-fast gate also passed. Product-quality jobs skipped
by draft policy are not claimed as completed. Compiled CLI mount execution is
still a separate open requirement.

The subsequent local `bun run typecheck` passed all four tasks.

## Slice 141: native directory lookup cost

Removed incidental parent attributes from LOOKUP replies, avoiding a complete
sibling enumeration for each name lookup. Explicit GETATTR/READDIR revision
checks and normal parent/child scope validation remain. Linux's 600-entry fresh
listing fell from 4015.9ms to 500.5ms on the same host; macOS measured 788.5ms.
The 5-second native test budget is unchanged. See EVIDENCE.md for the measured
request breakdown and validation; all four native CI jobs passed on c0169c47 (run 35236587926).
