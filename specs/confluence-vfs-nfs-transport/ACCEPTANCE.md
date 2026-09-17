# NFS acceptance checkpoint

This is a working audit of PLAN.md, not acceptance of the feature. The complete
read/write objective remains open. Implementation evidence reviewed through Slice 104; broad build/CI evidence below
is historical and still requires a final rerun.
[EVIDENCE.md](EVIDENCE.md) contains commands, host boundaries and detailed results.

## Requirements and remaining proof

| Plan requirement | Current evidence | Still required |
| --- | --- | --- |
| Optional transport, unchanged WebDAV default, experimental NFS, no runtime downloads | mount-transport tests; wiki-mount handler; helper discovery/handshake tests; Slice 54 subprocess flag rejection and valid boundaries | Final CLI/help audit including every incompatible option and side-effect-free rejection |
| Single-space root and combined-space roots | Native macOS synthetic and Linux live RO tests | Repeat with final RW-enabled artifact; combined live spaces remain RO |
| Glow directory selection and rendering | Slice 58 PTY probe on native NFS mounts: macOS Glow 2.1.1 and Linux Glow 3.0.0 | Comparative large-directory cold/warm scans; final artifact repeat |
| Versioned private bridge, loopback, credentials stay in Bun | Framing/handshake tests, helper env isolation, vendor limits; Slice 48 handle cap and bounded directory signatures; Slices 52–53 real deadline faults | Final bounds audit of all maps/caches |
| Byte ranges, exact UTF-8 sizes, EOF, attachments | Adapter plus real-wire/native byte tests; Slice 62 split-UTF8 version reads across edits, moves and cache misses on both hosts | Repeat against final RW artifact; live paths intentionally remain refreshable |
| Stable page/folder/attachment/generated-view identities | Slices 23–28 and 41–43; real-wire rename/move tests | Final identity/collision audit including convenience aliases and concurrent mutation races |
| Directory pagination and changing-directory cookies | READDIR and READDIRPLUS wire tests with independent client mutation; Slice 57 native open-cursor mutations on both hosts | Repeat with final RW-enabled artifact |
| Metadata/body consistency and external/negative visibility | Slice 39 direct-read TTL fix and real-kernel post-TTL test; Slices 43–44 historic timestamps/cache migration; Slices 46–47 generated-file attributes and native same-size comment visibility | Slice 93 adds native clean-page refresh after save and Linux live default-TTL timing; broader conflicting-write recovery still required |
| Durable staged ranges, truncate, quotas, isolation and crash recovery | Journal tests including SIGKILL, full DB rollback and legacy WAL recovery; Slices 66–69 add WRITE/SETATTR/COMMIT and native macOS/Linux durable writes | Namespace journal now covers local directories, backups and replay verifiers; fault injection at remaining boundaries still required |
| Automatic snapshot publication boundary | User explicitly accepts intermediate versions after 500 ms quiet; Slice 96 tests a valid prefix followed by a delayed suffix; Slice 71 proves automatic native/live publication | Final artifact/fault matrix; no universal editor-completion guarantee is required or advertised |
| Read-your-writes, validation, optimistic conflicts, replay reconciliation | Slices 65–71 connect staged reads/core publication; Slices 88–89 protect paused publication/replay identity; Slice 92 refreshes clean images and preserves an external addition across a stale-editor save | Broader ambiguous-result and multi-editor faults, clean-record eviction, publication retry/conflict resolution (Slice 98 adds offline inspection/export) |
| CREATE/RENAME/REMOVE and editor replacement saves | Slices 72–89 implement journaled local files/directories, CREATE modes, metadata, backup rename and replacement under original page IDs; Slice 103 automatically creates plain Markdown through native Vim on both OSes, with Linux DOCSY verification | Ambiguous creation reconciliation, WebDAV/new-page editor matrix, tree rename/opt-in trash; full overwritten/unlinked handle lifetime and mutation-race audit |
| Local locks, honest capabilities, unsupported operations | Native flock/lockf RO probes; macOS locallocks/Linux nolock; metadata error mapping; Slice 56 RO capability and mutation wire audit | RW editor lock behavior and capability audit after writes are implemented |
| Signals, busy mount, explicit unmount, helper/parent death, stale recovery | Linux live CLI lifecycle covers five cases; macOS native helper/kernel tests | Slice 90 adds durable status counts and once-only normal-shutdown reporting; Slice 91 bounds restart publication. Still required: public recovery workflow, unexpected-death reporting, full macOS CLI lifecycle |
| Indexer safeguards and request accounting | Shared markers and distinct-file sweep hint (Slices 37–38) | Complete transport request accounting and resource-bound acceptance |
| Native Vim/Linux and TextEdit/macOS writes with API verification | Slice 87 proves native TextEdit manual save and VS Code autosave on macOS with a synthetic backend; native Vim and real DOCSY saves on Linux | Real-tenant macOS editor proof unavailable without profile; create/trash, broader faults and final artifact matrix remain open; public RO guard remains enabled |
| Four-platform companion binaries and archive/installer | Native four-platform CI; source/extracted helper and archive validation; Slice 50 clean-source Linux x64 packaged CLI lifecycle | Compiled CLI mount execution on macOS arm64/x64 and Linux arm64, remaining Homebrew architecture proof |
| Shell without helper, no CQL behavior changes | Full source shell suites and built-bundle smoke tests | Final packaged smoke matrix with helper absent/wrong and offline startup |
| Comparative performance, five cold/warm runs | Slice 61 isolated five-run comparisons on both hosts, native peak RSS, shutdown and protocol counts; zero warm API calls | All downloaded bytes, Glow scan/startup and editor-save visibility; resolve >10% review triggers |
| Tests, build, docs, required CI, go/no-go recommendation | Current local build and regression checkpoint below | Final regression/CI, user-facing docs and explicit experimental go/no-go after all correctness gates |

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
