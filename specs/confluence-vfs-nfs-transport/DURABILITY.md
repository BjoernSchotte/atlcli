# Durability boundary acceptance

## Contents

- [Contract](#contract)
- [Executable boundary matrix](#executable-boundary-matrix)
- [Reproduction and evidence](#reproduction-and-evidence)
- [Remaining release gates](#remaining-release-gates)

## Contract

NFS WRITE/COMMIT acknowledge local SQLite-backed staging, not Confluence
publication. The publisher selects valid images after 500 ms quiet and retains
newer writes independently of an in-flight snapshot. Intermediate versions are
accepted. An unknown remote result is reconciled from positive evidence before
another mutation; missing evidence preserves the bytes and unresolved state.

This matrix covers actual persistence/remote-effect boundaries, rather than
requiring an unbounded generic fault audit. It does not claim physical power-cut
validation of the host's hardware cache. SQLite synchronous persistence and
filesystem fsync are the platform contract; process crashes, transaction
rollback, injected sync failures and actual APFS/ext4 exhaustion are tested.

## Executable boundary matrix

Test names below are exact substrings usable with `--test-name-pattern`. Files
are under `apps/cli/src/vfs/`. One row can require several complementary tests.

| Boundary | Test file and name | Required recovered state |
| --- | --- | --- |
| Journal creation / directory sync | `nfs-journal.test.ts`: `syncs the journal directory and every ancestor` | Sync failure prevents a usable journal; descriptors close; reopen syncs ancestors leaf-to-root before accepting writes. |
| Before local transaction commit | `nfs-journal.test.ts`: `crash inside an uncommitted rollback transaction` | SIGKILL rolls back unacknowledged changes and preserves the previous acknowledged image/revision. |
| After acknowledged local commit | `nfs-journal.test.ts`: `recovers an acknowledged write and publication intent after SIGKILL` | Current bytes, frozen publication image, replacement/backup state, verifier and attributes survive independently. |
| Quota / local transaction failure | `nfs-journal.test.ts`: `caps SQLite storage`; `rolls back failed replacement`; `rolls back a page-directory allocation` | No partial replacement/allocation; previous bytes and source identity remain recoverable. |
| Before CREATE intent / remote send | `nfs-publisher.test.ts`: `releases retry history`; `recovers new-page publication after reopening at before-post` | Deleted pre-intent drafts leave no retry history; unsent durable drafts create once after resume. |
| CREATE remote success, before local receipt | `nfs-publisher.test.ts`: `recovers a lost CREATE reply`; `retains ambiguous creation when recovery evidence differs` | Positive marker/history evidence recovers one page without a second POST; insufficient evidence retains the original intent and later bytes. |
| CREATE receipt / promotion | `nfs-journal.test.ts`: `freezes new-page intents`; `promotes confirmed creations atomically`; `keeps a confirmed directory creation recoverable` | Confirmed ID and frozen bytes survive reopen; alias/body/directory promotion is atomic or remains recoverable. |
| UPDATE remote success, before local receipt | `nfs-publisher.test.ts`: `reconciles an ambiguous successful update`; `reconciles a lost update reply after an external addition` | No duplicate version; remote additions and newer staged bytes remain intact. |
| Real disk exhaustion after CREATE/UPDATE | `nfs-storage-faults.test.ts`: `real filesystem ENOSPC following remote success` | After freeing space and reopening, exact staged/frozen bytes survive; one POST or PUT total, no pending/unresolved record after reconciliation. |
| MOVE remote success, before/after local receipt | `nfs-filesystem.test.ts`: `recovers move after remote success and before-receipt`; `recovers move after remote success and after-receipt` | Reopen preserves bytes, confirms target parent, remaps durable path, performs only one remote move. |
| Combined move / retitle intermediate effect | `nfs-filesystem.test.ts`: tests with `after-retitle`, `combined` and `cross selected spaces` | Confirm positive intermediate identity before finishing retitle; retain reservations and never blindly repeat an uncertain reparent. |
| TRASH remote success, before/after local receipt | `nfs-filesystem.test.ts`: `recovers trash after remote success and before-receipt`; `recovers trash after remote success and after-receipt` | Recovery retains the saved image and confirms trash; only one DELETE, never purge. |
| Unknown/denied/conflicting results | `nfs-publisher.test.ts`: `does not automatically retry a publication denied`; `allows correcting a preflight merge conflict`; `keeps unresolved trash` | Keep local bytes and explicit failure/unresolved state; no fallback create or repeated uncertain DELETE. |
| New writes during publication | `nfs-publisher.test.ts`: `serializes automatic follow-up saves`; `automatically drains newer saved bytes` | Frozen snapshot and newer revision remain distinct; follow-up publication drains the newer valid image. |
| Graceful stop before publication | `nfs-publisher.test.ts`: `stops timers without publishing partial work`; `nfs-bridge.test.ts`: `reports preserved recovery data once on shutdown` | Pending bytes remain recoverable and reported; restarting resumes publication, not discarded timers masquerading as success. |
| Helper startup/death ownership | `nfs-bridge-failures.test.ts`: `releases owned journal locks after failed startup, helper death and repeated stop` | Failed/dead helper releases journal ownership; repeat stop is safe. |
| Parent death after wire acknowledgement | `nfs-bridge.test.ts`: `preserves a FILE_SYNC write when the owning Bun process is killed` | Actual wire acknowledgement precedes SIGKILL; journal bytes survive and helper terminates with its parent pipe. |
| Native hard-mount helper death | `nfs-bridge.test.ts`: `recovers durable writes after helper death under a native hard mount` | Saved bytes survive helper loss; replacement helper permits normal detach; stale handles are not redirected to another object. |

## Reproduction and evidence

```sh
ATLCLI_NFS_STORAGE_FAULTS=1 bun run test \
  apps/cli/src/vfs/nfs-filesystem.test.ts \
  apps/cli/src/vfs/nfs-journal.test.ts \
  apps/cli/src/vfs/nfs-publisher.test.ts \
  apps/cli/src/vfs/nfs-bridge-failures.test.ts \
  apps/cli/src/vfs/nfs-storage-faults.test.ts
```

Storage tests create their own 64 MiB volume and never fill the host filesystem.
Linux needs sudo for the owned loop mount; macOS uses an owned APFS image.
Native/wire cases additionally use the matching compiled helper and
`ATLCLI_NFS_KERNEL=1`; see [EVIDENCE.md](EVIDENCE.md) for the separate runs.

Slice 159 reran the five-file suite on macOS and Linux: 207 passed / 1947
assertions each. The optional real-helper test skipped there was run separately
with the parent-kill, native helper-death and shutdown-report probes: four
passed / 43 assertions per host. Typecheck and Linux DOCSY journal-resume LIVE
also passed.

Slice 159 adds the four before/after MOVE/TRASH receipt interruption tests.
These inject a failure at the journal method boundary and reopen the database;
they are not mislabeled as physical disk failures. CREATE/UPDATE disk exhaustion
has the separate real-filesystem proof above.

## Remaining release gates

Slice 163 enables public RW after the documented boundary tests and four-native-
platform correctness run at c4ee457f. It repeats compiled RO/RW lifecycle on
macOS/Linux, including exact recovery export of writes acknowledged immediately
before helper loss. The four-platform artifact matrix passed in run 35261770483. A later Intel
ENOSPC test observed an extra attempted UPDATE without an extra version;
Slice 168 isolates filler-sync ENOSPC from simulated remote reply loss. Final
CI confirmation and the explicit experimental go/no-go remain in [ACCEPTANCE.md](ACCEPTANCE.md). The [plan](PLAN.md) remains
authoritative. Editor and performance evidence is tracked separately.
