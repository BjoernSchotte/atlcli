# VFS release validation — 2026-09-16

Environment: macOS 26.4 arm64, Bun 1.3.14. Startup comparison source snapshot `c925eb47`,
compared with pre-feature merge base `26179842`. Both source trees were
materialized with `git archive` into temporary directories, with workspace
package links resolving inside their own tree and identical installed third-party
dependencies, fonts and vendor runtime assets. No release was published.

## Compiled artifact

The final macOS arm64 executable was rebuilt on 2026-09-16 from the current
worktree (`a2751f47` plus the then-uncommitted WebDAV/delete fixes), separately
from the earlier startup baseline. It passes all **9 tests / 33 assertions** in
`apps/cli/src/e2e/wiki-sh-built.e2e.test.ts`: listing, reading, grep, write refusal,
JSON, exit codes, extra commands, maintenance and help. This exercises a real
local HTTP server and the compiled executable, not source imports. The strengthened
JSON checks require positive request counts and zero rate-limit responses.

The same final executable also performed a **live read-only DOCSY listing**
using mayflower: **876 ms**, **4 HTTP requests**, **0 rate-limit responses**,
**0 prefetched page bodies**, exit 0. Its temporary cache was removed; only
aggregate evidence was retained. No release or installation was performed.

Reproduce on native macOS arm64 or Linux x64, setting the matching target:

```bash
bun install
bun run fonts:ensure
bun build apps/cli/src/index.ts --compile --conditions=development \
  --target bun-linux-x64 --define '__ATLCLI_VERSION__="0.17.2"' \
  --outfile /tmp/atlcli-vfs
ATLCLI_VFS_TEST_BINARY=/tmp/atlcli-vfs \
  bun run test ./apps/cli/src/e2e/wiki-sh-built.e2e.test.ts
```

For a read-only tenant listing on the Linux host, with the mayflower profile
configured on that host:

```bash
/tmp/atlcli-vfs wiki sh --profile mayflower --space DOCSY --mode ro -c 'ls'
```

The existing artifact builder uses the same compilation target and development
resolution flags, plus complete release identity defines. The probe is not a
publishable release artifact.

## Native macOS mount performance

`bun --conditions=development scripts/vfs-mount-perf.ts` mounts a synthetic
500-page backend using the native macOS WebDAV client and always unmounts it.
The assertions verify exact listed file sizes, a warm listing below one second,
and exactly 100 matching Markdown pages. The successful run measured:

| Operation | Time | Backend method calls | Body reads |
| --- | ---: | ---: | ---: |
| Native `ls -R`, 500 pages in five sections | 2,012 ms | 2,535 | 506 |
| Warm native `ls`, section with 100 pages | 10 ms | 1 | 0 |
| Native `grep -r --include=_index.md`, 100 pages | 296 ms | 202 | 0 |

The walk loads 500 page bodies, five section bodies and the homepage for exact
file lengths. The subsequent grep reuses those bodies. Calls include version
and metadata probes. This is a local synthetic backend, **not Cloud request latency**;
these counts expose the cost of exhaustive native traversal. Native grep cannot
use the shell's CQL planner. Finder listing and TextEdit save were separately
verified against DOCSY; timed large-corpus Finder rendering remains unmeasured.

## Startup and size gate

Startup uses `--version`, alternating A/B then B/A order over 14 rounds,
with the first two rounds discarded; values are medians of the remaining 12.
Two runs of the fully isolated trees produced:

| Run | Baseline | VFS | Increase |
| --- | ---: | ---: | ---: |
| First | 424.37 ms | 512.10 ms | 87.73 ms |
| Repeat | 427.16 ms | 525.82 ms | 98.67 ms |

The first run overlapped the artifact smoke test. This development machine has
other active workloads; these are observed startup costs, not a stable benchmark
of dedicated release hardware. Earlier shared-dependency probes were around
71 ms; the isolated-source numbers above are the stronger baseline comparison.
Every run exceeds the 15 ms decision-11 gate.

Compiled size: **142,241,378 → 146,815,202 bytes**, an increase of
**4,573,824 bytes / 3.22%**. Both artifact size thresholds pass.

The user explicitly accepted the startup overhead for now. The embedded shell
therefore remains in the core as an accepted deviation from the optional-plugin
remedy; the measured startup gate is recorded as **failed/accepted**, not passed.

## Homebrew

The local tap formula resolves the correct macOS arm64 `v0.17.2` artifact and
checksum, installs `atlcli`, and tests `atlcli version --json`.
That exact command succeeds against the newly compiled executable.
`brew test atlcli` was attempted but refuses because installed `0.17.1` is older
than the formula's `0.17.2`; the user's installed CLI was not upgraded.
Thus formula inspection and equivalent executable smoke pass; the actual
Homebrew install/test lifecycle remains unverified for this PR.

## Platform and identity boundaries

- Native Linux x64 is now verified on the user's homelab: the user confirmed
  interactive source and compiled shells; compiled artifact tests passed with
  **9 tests / 33 assertions** (6.85 s). Kernel 6.17.0-23-generic and davfs2 1.7.1
  reproduced `EINVAL` on directory reads with the default 16 KiB FUSE buffer,
  despite HTTP PROPFIND returning 207. Backing up the system davfs2 config,
  setting `buf_size 64`, and remounting read-only fixed it. Native root listing:
  4 ms; DOCSY listing: 38 entries in 143 ms, repeated in 1 ms. One 545-byte page
  read matched direct WebDAV GET byte-for-byte (combined check 134 ms).
  The existing read-only mount/server were left running for the user.
  No wiki content or credentials were retained. Native Linux Vim save is verified; GUI editor-specific safe-save remains unverified. Earlier arm64-emulated Linux failures
  were environmental and are superseded by these native results.
- Windows is unavailable; WebClient and Windows indexing remain untested.
- Only the mayflower profile exists. The live two-identity permission test
  cannot run without a second identity; fake-client cache-isolation tests are
  separate evidence, not a substitute. The user accepted this interim boundary.

## Single-space and multi-space mount roots

Native `ls` checks on macOS and Linux passed for both layouts: DOCSY alone
mounts `/DOCSY/` and exposes `_index.md` and page directories directly;
DOCSY plus mayflower mounts `/` and exposes both space directories. Both
multi-space probes were read-only. The macOS DOCSY kernel E2E passed seven
tests, including creation, update, readback and cleanup of synthetic pages.
Space-root listings retain the Spotlight exclusion files.

## Native Linux cold-read truncation and edit regression

The original estimated 4,096-byte PROPFIND size caused davfs2 to truncate a
cold mounted read while direct GET returned all 14,415 bytes. The user approved
exact WebDAV sizes even when this loads listed file bodies; shell stat/listing
remains metadata-only. `scripts/vfs-linux-live.ts` creates one synthetic DOCSY
page and tests a cold native read before any direct GET, exact stat size,
byte equality with HTTP, a native filesystem edit, and independent API readback
after unmount drains davfs2 uploads. It passed with **39,855 bytes** and preserved
all **1,200** synthetic Unicode text repetitions plus the edited end marker.
The page, temporary server, mount and VFS cache were cleaned up. macOS native
read/write E2E also passed again (7 tests / 17 assertions).

## Linux Vim save

The native read/write harness now also invokes installed Vim with its default
save/backup behaviour (`vim -Nu NONE -n -es`, substitute, write and quit).
The edited 39,855-byte fixture retained all 1,200 repeated text segments and
the updated end marker; independent Confluence API readback passed after
unmount flushed uploads. Immediately after the save, davfs2 briefly exposed
stale zero-length inode metadata; full native readback was correct after
**1,014 ms**, within the harness's explicit three-second refresh bound.
No data was lost. The synthetic page and temporary mount/cache were removed.

## Linux shutdown

Native davfs2 verification passed: a separate process held its working directory
inside a read-only DOCSY mount; Ctrl-C preserved the busy mount and server.
After releasing that process, a second Ctrl-C unmounted and exited with code 0.
Shutdown tries ordinary umount then noninteractive sudo; failure keeps the
server and mount state available rather than stranding a dead filesystem.

## Final repository checks

After the production fixes: `bun run test` reports **9,008 pass, 40 skip, zero
failures**, 44,544 assertions and six snapshots across 746 files (468.98 s).
Skipped tests include opt-in live/platform gates; their separate evidence and
remaining boundaries are listed above. `bun run typecheck` passes all four
tasks; `bun run build` passes all 35 tasks. The synthetic native mount probe
was also executed successfully and cleaned up.

## Related evidence

See [LIVE-RESULTS.md](./LIVE-RESULTS.md), [EVIDENCE.md](./EVIDENCE.md), and
[PLAN.md](./PLAN.md). This report supersedes historical claims that no macOS
compiled-binary verification exists.
