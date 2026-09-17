# NFS acceptance checkpoint

This is a working audit of PLAN.md, not acceptance of the feature. The complete
read/write objective remains open. Source checkpoint: da25dabe (Slices 1–44).
[EVIDENCE.md](EVIDENCE.md) contains commands, host boundaries and detailed results.

## Requirements and remaining proof

| Plan requirement | Current evidence | Still required |
| --- | --- | --- |
| Optional transport, unchanged WebDAV default, experimental NFS, no runtime downloads | mount-transport tests; wiki-mount handler; helper discovery/handshake tests | Final CLI/help audit including every incompatible option and side-effect-free rejection |
| Single-space root and combined-space roots | Native macOS synthetic and Linux live RO tests | Repeat with final RW-enabled artifact; combined live spaces remain RO |
| Versioned private bridge, loopback, credentials stay in Bun | Framing/handshake tests, helper env isolation, vendor limits; Slice 48 handle cap and bounded directory signatures | Final bounds audit of all maps/caches; fault-inject response-write and dispatch deadlines |
| Byte ranges, exact UTF-8 sizes, EOF, attachments | Adapter plus real-wire/native byte tests, long binary and Unicode fixture | Immutable multi-READ snapshot contract and adversarial concurrent-version proof |
| Stable page/folder/attachment/generated-view identities | Slices 23–28 and 41–43; real-wire rename/move tests | Final identity/collision audit including convenience aliases and concurrent mutation races |
| Directory pagination and changing-directory cookies | READDIR and READDIRPLUS wire tests with independent client mutation | Final native-kernel concurrent-directory mutation acceptance |
| Metadata/body consistency and external/negative visibility | Slice 39 direct-read TTL fix and real-kernel post-TTL test; Slices 43–44 historic timestamps/cache migration; Slices 46–47 generated-file attributes and native same-size comment visibility | Broader live visibility timing |
| Durable staged ranges, truncate, quotas, isolation and crash recovery | Journal tests including SIGKILL, full DB rollback and legacy WAL recovery | Namespace journal, NFS WRITE/SETATTR/COMMIT integration and fault injection at every acknowledgement boundary |
| Complete-document publication boundary | Feasibility findings: NFSv3 has no universal close notification | Concrete publication decision; implementation must not infer completion from idle time alone |
| Read-your-writes, validation, optimistic conflicts, replay reconciliation | Journal retains immutable intents and newer local bytes | Connect staged reads and mutations to bridge/core; reconciliation and pending/recovery CLI; no duplicate remote publication |
| CREATE/RENAME/REMOVE and editor replacement saves | Existing WebDAV behavior tested; NFS still returns ROFS | Implement/test NFS namespace operations with stable page IDs, temporary files and opt-in trash |
| Local locks, honest capabilities, unsupported operations | Native flock/lockf RO probes; macOS locallocks/Linux nolock; metadata error mapping | RW editor lock behavior and final protocol capability audit |
| Signals, busy mount, explicit unmount, helper/parent death, stale recovery | Linux live CLI lifecycle covers five cases; macOS native helper/kernel tests | Full macOS CLI lifecycle; pending-write shutdown and recovery once RW exists |
| Indexer safeguards and request accounting | Shared markers and distinct-file sweep hint (Slices 37–38) | Complete transport request accounting and resource-bound acceptance |
| Native Vim/Linux and TextEdit/macOS writes with API verification | Not achieved; RO guard remains enabled | Synthetic DOCSY create/update/editor save/rename/trash; stable IDs, complete bytes and cleanup |
| Four-platform companion binaries and archive/installer | Native four-platform CI; source/extracted helper and archive validation | Compiled CLI mount execution in every declared environment, remaining Homebrew architecture proof |
| Shell without helper, no CQL behavior changes | Full source shell suites and built-bundle smoke tests | Final packaged smoke matrix with helper absent/wrong and offline startup |
| Comparative performance, five cold/warm runs | Slice 32 baseline and Slice 39 rerun on both hosts; zero warm API calls | Protocol counts, all downloaded bytes, peak RSS, Glow scan/startup, editor-save visibility and shutdown timing; resolve >10% review triggers |
| Tests, build, docs, required CI, go/no-go recommendation | Current local build and regression checkpoint below | Final regression/CI, user-facing docs and explicit experimental go/no-go after all correctness gates |

## Decisions still awaiting an answer

These questions were presented earlier and have not been treated as accepted
merely because work continued:

1. **Publication:** may an editor save be durably local until an explicit publish,
   or is automatic remote publication required despite NFS lacking a generic
   document-completion event? A journal alone cannot decide this.
2. **Read snapshots:** accept coherent individual READ replies on live handles,
   or expose immutable version snapshots to guarantee consistency across an
   arbitrary series of READ calls? The latter changes the live-handle contract.

Neither question prevents independent test/packaging/resource work. Neither
permits silently shrinking the objective to a read-only feature.

## Current local verification

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
