# CI Speedup

Status: **Implemented**, 2026-10-20. Config in this PR; NFS deadlines in #241;
docs/config routing in #240.

Planning baseline: commit `4cefd888`

Directory: `specs/ci-speedup`

## Summary decision

A full PR run took **12.5 min** (median) to the `required` gate, and up to
18 min when the Intel macOS runner queued. The repository is public, so
runner minutes are free and only wall time matters. That makes more
parallelism free, and long serial waits are the thing to remove. Target: no
single job above ~4–5 min on a PR.

## Evidence (4 green full runs, 2026-10-20)

| Job | Median | Driver |
|---|---|---|
| NFS macOS 14 / 15-Intel | 12–15 min | `setup-homebrew` 297 s; mount tests 245 s; Intel queue up to 164 s |
| NFS Ubuntu x64/ARM | 7–8 min | mount tests 236 s |
| Linux Bun tests general-1 | 6 min | shard imbalance (others 3–4 min); duration snapshot covered 624/771 files |
| Raster normalizer ×2 | 5.5 min | paired RSS gate 228 s |
| Typecheck/build/contracts | 4.9 min → **1.6 min** | already fixed by TS 7 (#239): typecheck 65→13 s, build 108→21 s |

The mount-test time was the production NFS connection deadlines waited out in
real time: read 60 s, write 30 s (+35 s sleep), dispatch 120 s (≥118 s
asserted).

## Measures

| # | Measure | Where | Expected effect |
|---|---|---|---|
| 1 | Tests shorten helper deadlines (only within 100 ms..=production) | #241 | −3.5–4 min on all 4 NFS jobs |
| 2 | Skip `setup-homebrew` on macOS (Homebrew is preinstalled on PATH) | `reusable-nfs.yml` | −~5 min on macOS NFS |
| 3 | ~~Intel macOS NFS only off pull requests~~ | — | superseded by stage 2 (no native platform jobs on PRs) |
| 4 | 6 general test shards (`general-6x1`) + refreshed duration snapshot (median of 3 runs, 757/771 files) | `test-lanes.ts`, `reusable-quality.yml`, `test-duration-snapshot.json` | general shards ~6 min → ~2–2.5 min |
| 5 | ~~Raster RSS: PR runs pinned Chromium only~~ | — | superseded by stage 2 (raster runs on main only, both browsers) |
| 6 | Split typecheck job | — | dropped: TS 7 already cut it to 97 s |
| — | Narrow routing for docs-only workflow, `.gitignore`, CI test files | #240 | docs/config PRs skip platform gates |

Expected PR critical path after all measures: **~4–5 min**, bounded by the
NFS Linux/macOS jobs (~3–4 min) and the pdf-typst test shard (~3 min).

## Stage 2: PR fast lane (native platform proof after merge)

The measures above still left a ~5.5 min raster job and ~3 min NFS jobs on
every PR. GitHub merge queue is not available for user-owned repositories
(`BjoernSchotte/atlcli`). So the operator turned off "Require branches to be
up to date before merging" on 2026-10-20 (`strict: false`). That removes the
BEHIND → update-branch → full rerun cycle.

- `changes` emits `platformProof = github.event_name != 'pull_request'`.
- `nfs-helper` (4 OSes), `pdf-cli-macos`, `pdf-sink-windows` and the raster
  RSS ratchet run only when `platformProof` is true: main pushes,
  schedules and manual runs.
- The `required` aggregate selects those gates via `platform_selected`.
  They must be **skipped** on PRs and **succeed** on main. Policy tests
  simulate both directions.
- Linux lanes stay PR gates: typecheck/build/contracts, 6+1 test shards,
  consumer smoke, docs, Astro platform and Linux browser evidence.
- This supersedes measures 3 and 5. The Intel-only-off-PR input and the
  PR-only single-browser raster matrix were removed again. On main, all 4
  NFS targets and both browsers run as before.

Trade-off: a native-platform regression surfaces on main after merge, not
on the PR. It must be fixed forward or reverted. A merge queue would move
that check before the merge if the repository moves to an organization.

Expected PR critical path: **~3–3.5 min**. The bound is the Linux
browser-evidence chain (assets 65 s → evidence ~140 s), the pdf-typst shard
(~3.4 min) and consumer smoke (~3 min).

## Coverage kept

- All four NFS targets still run on `main` pushes and every non-PR event.
- `current-cft-stable` raster drift still runs on `main` and schedules.
- Production NFS deadlines (60/120/30 s) are pinned by Rust unit tests, and
  overrides can only shorten them.
- Policy tests (`workflow-policy.test.ts`, `test-lanes.test.ts`) pin every
  rule above, so a later edit cannot silently drop coverage.

## Verification

- `bun run test scripts/ci`: all pass, including new tests for the
  PR/main NFS and raster split, Linux-only Homebrew setup, and 6-shard
  planning.
- After merge: compare the first green PR run's `ci-timing` artifact
  against this baseline. Refresh `test-duration-snapshot.json` from fresh
  `ci-timing` artifacts when shard times drift apart again.

## Open follow-ups

- If NFS jobs remain the critical path, run the native read-only mount
  tests and the Homebrew installer proof as separate parallel jobs.
- Automate snapshot refresh from the telemetry artifact. Today it is a
  manual median merge of `timingSnapshot` across recent runs.
