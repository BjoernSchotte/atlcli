# Optional NFS transport for Confluence mounts

Status: implementation in progress; WP1 read-only prototype passes native macOS
and Linux DOCSY reads. CLI integration and read/write acceptance remain open.
See [evidence](EVIDENCE.md).
Baseline: PR #202, merged as `8b08ad65` on 2026-09-16.

## Contents

- [Outcome and boundaries](#outcome-and-boundaries)
- [CLI contract](#cli-contract)
- [Architecture and distribution](#architecture-and-distribution)
- [Filesystem semantics](#filesystem-semantics)
- [Writes and durability gate](#writes-and-durability-gate)
- [Lifecycle and security](#lifecycle-and-security)
- [Implementation sequence](#implementation-sequence)
- [Acceptance and performance](#acceptance-and-performance)
- [Open questions](#open-questions)
- [Sources and related documents](#sources-and-related-documents)

## Outcome and boundaries

Add an explicit, experimental NFSv3 mount option on macOS and Linux alongside
WebDAV. WebDAV remains the default and supported fallback selected by the user.
Keep the existing TypeScript Confluence VFS as the authority for page identity,
conversion, permissions, caching, conflicts and API access. Do not port that
logic to Rust or change the VFS shell/CQL search behavior.

Success means native applications can use either transport with documented,
tested semantics. NFS is not presumed faster: measure against WebDAV before
making performance claims. A read-only prototype is an intermediate milestone,
not completion of the read/write scope below.

Out of scope: FUSE, NFSv4, network exports, Windows NFS, automatic transport
fallback, a mandatory system service, fs-safe integration, and Rust in ordinary
WebDAV or shell startup. Normal OS grep cannot use the shell's CQL optimization:
the mount receives file operations rather than the search expression.

## CLI contract

```bash
# Unchanged default; the explicit form is equivalent.
atlcli wiki mount ~/mnt/docsy --profile mayflower --space DOCSY --mode ro
atlcli wiki mount ~/mnt/docsy --profile mayflower --space DOCSY --mode ro --transport webdav

# Experimental native NFS mount.
atlcli wiki mount ~/mnt/docsy-nfs --profile mayflower --space DOCSY --mode ro --transport nfs

# Multiple spaces retain their directories. Both are read-only here.
atlcli wiki mount ~/mnt/wiki-nfs --profile mayflower --space DOCSY,mayflower --mode ro --transport nfs

# Available only after the write-durability acceptance gate passes.
atlcli wiki mount ~/mnt/docsy-nfs --profile mayflower --space DOCSY --mode rw --transport nfs

atlcli wiki mount list
atlcli wiki mount unmount ~/mnt/docsy-nfs
```

- `--transport webdav|nfs`: optional; default `webdav`. Reject unknown values
  before opening the VFS, creating state or starting a helper.
- Initially use a CLI option only, without a new persistent config setting.
- Keep profile, space, mode, cache-dir and deletion opt-in semantics. One space
  exposes its contents at the root; multiple spaces expose space directories.
- `--port` chooses the selected transport's loopback port; zero/omission selects
  an available port. NFS and its mount RPC share the chosen listener if supported
  by the pinned library. Do not start a system-wide portmapper.
- On Windows, `--transport nfs` fails with an actionable WebDAV alternative and
  no startup side effects. Missing helper/client and incompatible helper versions
  fail clearly; never silently switch transport or download an executable.
- Preserve Linux's explicit privileged mount instructions. Generate correctly
  quoted commands, including paths with spaces. On macOS, prove whether the NFS
  mount requires elevation; print instructions if privileges are insufficient.
- Mount JSON/status adds `transport` and accurately distinguishes a listening
  server from an attached volume. Old records without `transport` mean WebDAV.
  Preserve existing WebDAV output fields; NFS adds an export endpoint rather
  than pretending it is an HTTP URL.
- `unmount` discovers the transport from state; no repeated option is required.
  Document incompatible options rather than accepting and ignoring them.

## Architecture and distribution

```text
native application -> OS NFS client -> local Rust helper (nfsserve)
                                           |
                               private framed stdin/stdout RPC
                                           |
                              existing Bun mount process
                                           |
                              ConfluenceVfsImpl -> REST
```

Use a small Rust helper wrapping a pinned `nfsserve` version/revision. The Bun
process owns it and the VFS. The helper implements protocol mechanics, not
Confluence authentication or Markdown conversion. Keep WebDAV's current
in-process adapter. Introduce only the lifecycle functions the two real
transports need; avoid a general plugin framework.

Bridge requirements:

- Private inherited pipes, no second listening bridge port. A versioned startup
  handshake reports protocol version, capabilities and the bound NFS endpoint.
- Request IDs, bounded length-prefixed frames, explicit byte payloads, bounded
  concurrency and backpressure. Diagnostics go to stderr only.
- Map lookup, attributes, directory pagination, byte-range read, and supported
  mutations to the existing VFS. Constrain frame/read/write sizes and staging
  quotas; reject overflow, malformed data and unsupported operations explicitly.
- Pending calls fail when either peer exits. A deadline on a mutation must not
  imply that the remote mutation did not occur; retries need reconciliation.
- Confluence credentials remain in Bun. Do not pass credentials, page bodies or
  inherited unnecessary secrets through helper argv/environment/logs.

Suggested locations: `apps/cli/src/vfs/nfs-bridge.ts` and a focused Rust helper
under `packages/confluence-nfs/`. Extend `wiki-mount.ts` and its tests; keep the
public VFS interface narrow. Reuse existing semantic helpers where appropriate.

Distribution is part of the feature: reproducible locked Cargo builds, license
review, checksums and helper protocol/version matching. Ship/test companion
binaries for macOS arm64/x64 and Linux arm64/x64, with an explicit supported libc
matrix. No Rust compiler required for users, no runtime downloads. CLI release
archives and installer/Homebrew paths must carry and locate the helper; verify
both source development and compiled Bun CLI invocation. Missing artifacts must
not affect WebDAV or shell usage. Add supply-chain checks to CI, not a release
performed by this spec.

## Filesystem semantics

| Operation | Required behavior |
| --- | --- |
| LOOKUP / handles | Identity-based IDs distinguish page directory, Markdown, attachment and generated node; preserve IDs across rename/reparent and never reuse deleted IDs for another object. |
| GETATTR / READDIRPLUS | Exact UTF-8 byte sizes, backed by the existing body cache. Fetch only visited/listed file bodies when needed; shell stat stays metadata-only. |
| READ | Offset/count in bytes, correct EOF, bounded ranges and consistent version snapshot; Unicode may span read boundaries. |
| READDIR | Deterministic pagination and explicit behavior when a directory changes between requests; no silent skipping caused by ID/path ordering or bad cookies. |
| WRITE / SETATTR | Byte-range writes, truncate and extend need the durable staging design below; whole-file VFS writes cannot directly substitute for them. |
| CREATE / RENAME / REMOVE | Preserve existing page identity and deletion safeguards, including editor temporary/backup replacement sequences. Never purge pages. |
| Links / attributes | Keep convenience links within the selected export. Reject unsupported hardlinks, ownership/permission changes and device files honestly. Advertise only supported capabilities. |

NFS attributes and data caches must agree after a write. Define and measure
external-update and negative-cache visibility using explicit mount options and
VFS TTLs; do not promise instantaneous consistency. Never combine bytes from two
page versions in a single logical read snapshot.

Upstream default handles contain a server-start generation. Treat helper restart
as invalidating handles and require remount; expose ESTALE/recovery instructions
rather than silently redirecting old handles. Audit READDIR and READDIRPLUS in
the exact pinned release, not just README claims.

NFS offers no universal close notification. Kernel caching and editor save
patterns differ from WebDAV. Do not carry over its debounce behavior without
proving the corresponding NFS contract.

Do not start an NLM/NSM lock service in this scope. Select and test the correct
macOS/Linux client options for operation without it; include native lock probes
so editors cannot hang waiting for unavailable lock RPCs. Document local-only or
unsupported locks explicitly, with no cross-client locking promise. Existing
optimistic Confluence version checks remain the authority for write conflicts.

## Writes and durability gate

The upstream implementation inspected on 2026-09-16 responds to successful WRITE
with FILE_SYNC, while its VFS write hook receives only ID, offset and bytes.
An in-memory buffer followed by a delayed Confluence PUT cannot satisfy that
acknowledgement. Pin and re-audit this behavior before implementation.

Before enabling `--mode rw`, produce a reviewed decision and executable fault
tests for all of the following:

1. Persist acknowledged byte ranges and metadata in a reconstructable local
   staging journal before promising local stable storage. Include fsync ordering,
   truncate/rename records, bounded disk use, profile/export isolation and restart
   recovery. Reuse existing storage only if it actually provides this contract.
2. Specify when a complete staged Markdown document is published to Confluence.
   Idle time alone does not prove completion. Analyze stable WRITE, COMMIT,
   truncate and atomic rename for real macOS/Linux clients. If the existing
   library hooks cannot express the required boundary, make the smallest audited
   upstream change or stop at an explicitly RO-only experimental milestone.
3. Distinguish durable local saving from successful Confluence publication in
   status, errors and documentation. Local fsync must never be advertised as a
   remote Confluence commit if it is only journal durability. Specify
   `--sync-writes` behavior; reject it until its stronger promise is implementable.
4. Read-your-writes returns staged bytes. Publish only validated complete content
   through existing conversion/version-conflict logic. Preserve page IDs across
   editor backup and replacement renames; temporary files must not become pages.
5. Replayed RPCs must not duplicate creates or updates. Preserve a verifier/session
   identity and reconcile ambiguous remote outcomes before retrying publication.
   Concurrent edits must retain conflict bytes rather than silently overwrite.
6. Never discard pending bytes on API denial, rate limits, network loss, conflict,
   helper crash or journal exhaustion. Surface recovery/pending state. Clean
   shutdown drains publication or reports pending recovery and retains its data.

The implementation decision must select one concrete publication/durability
contract before RW code ships. A journal by itself does not solve the missing
document-completion boundary. Do not present a partial solution as RW acceptance.

## Lifecycle and security

- Bind only to loopback, including the mount protocol; do not expose a LAN server.
  Loopback is not authentication: document access by other local users. NFS
  AUTH_SYS UID/GID claims are not a substitute for authentication or RO checks.
- Export scoping applies to every path, filehandle, parent lookup and link target.
  RO must be enforced in both advertised capabilities and the authoritative core.
- Persist transport, helper PID, parent/session identity and export information
  atomically. Validate process identity before signalling to avoid PID-reuse kills.
  Do not prune a crashed server's record while its volume remains mounted.
- Ctrl-C/SIGTERM and explicit unmount share cleanup: keep both processes serving
  while the OS detaches, finish/preserve pending writes, then stop helper/core and
  remove state. Busy unmount preserves the server and state; no forced/lazy detach
  or interactive sudo prompt by default. Repeated signals must not race cleanup.
- Detect helper/bridge death and report recovery/remount instructions. A killed
  process cannot guarantee automatic unmount: document this limit and test the
  surviving parent's best-effort recovery without killing unrelated processes.
- Test attach failure, port collision, parent death, stale state, missing helper,
  malformed frames and nonresponsive clients. Keep errors bounded and actionable.
- Match the existing mount's indexer safeguards and request accounting. NFS
  does not provide an automatic protection against recursive content scans.

## Implementation sequence

Each slice includes regression tests, relevant live proof, documentation and a
reviewable commit. Push validated slices to the eventual implementation draft PR.
Do not interpret these unchecked tasks as implementation completed by this spec.

- [ ] **WP1 — feasibility:** pin/audit nfsserve, minimal RO bridge on macOS/Linux,
  exact sizes and range reads, native mount/unmount proof. Record library gaps,
  permissions and packaging viability. Complete the RW durability decision above.
- [ ] **WP2 — CLI/lifecycle:** add transport selection, backward-compatible state,
  status and unmount dispatch; test unchanged default, unsupported platforms,
  child failure and busy shutdown. Keep NFS experimental and RO until WP4 passes.
- [ ] **WP3 — read parity:** identities, paginated directories, links/export roots,
  attachments, caches and external-change visibility. Run cold/warm native tests.
- [ ] **WP4 — write parity:** implement the accepted staging/publication contract;
  byte-level/fault tests, real editor saves, API verification and crash recovery.
  Enable RW only after every correctness gate passes.
- [ ] **WP5 — distribution/docs:** build and verify helper artifacts, source and
  compiled CLI behavior, prerequisites, mount examples, limitations and recovery.
  Update the existing VFS feature guide and CLI help; no automatic release.
- [ ] **WP6 — comparative acceptance:** execute the matrix below, record bounded
  performance evidence and publish a go/no-go recommendation for experimental NFS.

## Acceptance and performance

| Layer | Required evidence |
| --- | --- |
| Unit/protocol | CLI parsing, old state, framing limits, error mapping, byte ranges, exact sizes, handles, pagination, readonly enforcement and export confinement. |
| Mutation faults | Truncate plus chunked writes, overlapping/out-of-order ranges, split Unicode, retries, sparse growth/quota failures, fsync/COMMIT, rename replacement, conflicting versions and crash injection around each durability boundary. |
| Native macOS/Linux | Single DOCSY root and DOCSY + mayflower roots; cold/warm ls/stat, hash/byte-length equality for long Unicode Markdown and attachments, less and bounded Glow directory selection. |
| Native writes | Synthetic DOCSY only: create, update, editor save, rename and opt-in trash; Vim on Linux and TextEdit on macOS. Verify full bytes and stable page ID through API; restore/delete fixtures afterwards. |
| Shutdown/recovery | Ctrl-C, SIGTERM, explicit unmount, busy directory, pending writes, helper/parent crash and remount after stale handles. No falsely successful save or lost acknowledged bytes. |
| Packaging | Source and compiled Bun CLI plus packaged helper on declared platforms; wrong/missing helper and offline startup. WebDAV/shell work without helper. |
| Regression | Existing VFS/WebDAV/shell suites, typecheck/build and required CI; no changes to shell CQL behavior or default transport. |

Use profile `mayflower`. MAYFLOWER (configured key `mayflower`) stays strictly
read-only; combined-space live tests are RO. DOCSY writes use synthetic fixtures
and clean up test resources. One available identity suffices for current live
tests; test profile isolation with synthetic credentials/fixtures rather than
claiming a second live-user proof. Windows must prove rejection/fallback guidance;
native Windows NFS testing is outside scope.

Compare both transports against the same fixed synthetic corpus, machine, client
versions, API concurrency and cache conditions. Measure at least five cold/warm
runs separately; report median and range, wall time, time to first listing/byte,
API requests, downloaded bytes, cache hits, helper/parent RSS, and local protocol
requests. Define cache clearing for both kernel and VFS; a warm body cache must
not masquerade as a cold mount. Compare Glow startup and directory scans, complete
reads, editor save-to-API visibility and shutdown latency.

Correctness is mandatory. No full-space body download at mount startup; only
visited/listed files may need exact-size materialization. No API calls for warm
cached body reads within the documented freshness window. Treat more than 10%
median regression or additional Confluence requests in equivalent cases as a
review trigger requiring an explanation before experimental acceptance. A speed
claim needs reproducible results beyond run-to-run variance. Record host-specific
limits; do not infer untested architectures from compilation alone.

## Open questions

No user/product decision blocks starting WP1: explicit transport, default WebDAV,
experimental NFS, macOS/Linux and unchanged shell are agreed.

Engineering questions that WP1 must resolve with evidence:

1. Can the pinned nfsserve hooks implement the chosen durable write/publication
   contract, or is a small upstream patch required? RW remains gated meanwhile.
2. Which macOS elevation/mount options and Linux client cache options give correct
   editor behavior and bounded external-update visibility?
3. Which helper packaging/libc combinations pass native tests, and does measured
   benefit justify maintaining the extra transport?

If feasibility fails, document that outcome and keep WebDAV; do not silently
replace the agreed backend or expand scope into a new filesystem framework.

## Sources and related documents

- [Original VFS plan](../confluence-virtual-filesystem/PLAN.md), especially the
  deferred NFS option, shared core, demand-driven loading and permission model.
- [Existing live evidence](../confluence-virtual-filesystem/LIVE-RESULTS.md).
- [Merged PR #202](https://github.com/BjoernSchotte/atlcli/pull/202).
- [nfsserve repository](https://github.com/huggingface/nfsserve): protocol adapter
  candidate; recheck the selected revision instead of assuming README completeness.
- [Upstream VFS interface](https://github.com/huggingface/nfsserve/blob/main/src/vfs.rs)
  and [NFS handlers](https://github.com/huggingface/nfsserve/blob/main/src/nfs_handlers.rs),
  inspected 2026-09-16; pin immutable references in the WP1 evidence.
- [NFSv3 protocol, RFC 1813](https://www.rfc-editor.org/rfc/rfc1813): authoritative
  WRITE/COMMIT, attributes, handles and error semantics for the implementation.
- [fs-safe copy](https://fs-safe.io/copy.html): local tree cloning, not a mount
  adapter; no dependency on it is needed for this feature.
