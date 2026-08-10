# GitHub CI throughput rollout evidence

This file records public or synthetic evidence only. Promotion decisions remain
open until the live sample gates in `PLAN.md` are satisfied.

## Implementation snapshot

- Planning baseline SHA: `9ffbe22e604413226a863064da31dc6981f76ce0`
- PR #139 merge baseline SHA: `5310e90e696697d4f61e0f4c22836e0c826c5b4d`
- Duration-aware topology inventory: 609 eligible test files
- Required topology: `legacy-4-shard` (unchanged)
- Candidate topologies: `general-2x1`, `general-3x1`,
  `general-2x2-workers`
- Browser required topology: `browser-combined-serial` (unchanged)
- System Chrome: scheduled/manual non-required compatibility canary
- Merge queue: workflow trigger ready; repository transfer and queue activation
  remain external and deferred
- PR proof modes: live-state-validated `draft-fast`, `superseded`, and
  merge-ready `required`
- Ready-PR routing: conservative package/capability closures; workflow,
  lockfile, global, unknown, main-push, scheduled, and manual inputs fail open
- Quality DAG: static quality, Bun shards, pinned Astro platforms, and optional
  attestation start independently; the duplicate publishing job and reusable
  aggregate tail are removed
- Floating latest Astro 7: scheduled/manual advisory canary; release tags keep
  the compatibility check blocking

## PR #139 observed bottleneck

The final green PR run
([Actions run 31395422582](https://github.com/BjoernSchotte/atlcli/actions/runs/31395422582))
started classification at 13:55:55 UTC and completed the stable `required`
check at 14:07:51 UTC: 11 minutes 56 seconds from first runner start to green.
It consumed about 42.6 runner-minutes.

The final critical path was structurally serial:

1. static quality completed at 13:58:21;
2. the duplicate Astro publishing job ran until 14:02:22;
3. only then did the Astro platform matrix start;
4. the Windows Astro leg completed at 14:07:37;
5. two aggregate runner jobs followed before telemetry.

The workflow changes in this branch remove that serial publishing/platform
chain, remove the inner aggregate runner, and move floating-latest Astro away
from ordinary PR/main proof. No post-change GitHub timing is claimed yet.

## Local synthetic proof

| Contract | Result |
| --- | --- |
| Bun 1.3.14 exact file-link retry classifier | Passed focused tests |
| Test discovery and path safety | Passed focused tests |
| JUnit parsing, duplicate ownership, and timing aggregation | Passed focused tests |
| Actions queue/runner/wall timing aggregation | Passed focused tests |
| Deterministic LPT lanes and argv-safe runner | Passed focused tests |
| Workflow dependency and non-required telemetry policy | Passed focused tests |
| Security attestation dependency-free policy | Passed focused tests |
| Complete root suite | 7,711 passed, 16 skipped, 0 failed across 611 files (four CI shards) |
| TypeScript typecheck (root, extension, compiler, harness) | Passed |
| Complete build | Passed, 27 Turbo tasks |
| Full Bun/npm/pnpm consumer proof | 12 passed, 0 failed |
| Documentation check/build | Passed, 90 pages built |
| Neutral bundled-Chromium harness | 6 passed, 0 failed |
| Packed MV3 PDF.js worker proof | 2 passed, 0 failed |
| Packed MV3 durable-jobs proof | 24 passed, 0 failed |
| Packed MV3 Rovo visibility proof | 2 passed, 0 failed |
| Browser/Node shape parity | Passed |
| Required local Atlassian E2E | Not run: `ATLCLI_E2E_PAGE_ID` is unavailable |

The checked timing metadata intentionally contains no invented historical file
durations. Until a live JUnit snapshot is reviewed, new and unmeasured files
use the conservative five-second fallback.

## Candidate balance before live timings

The fallback-only planner assigns every current test file once. These estimates
are planning weights, not measured runtimes:

| Topology | General allocation |
| --- | --- |
| `general-2x1` | two nearly equal sequential jobs |
| `general-3x1` | three nearly equal sequential jobs |
| `general-2x2-workers` | two bounded `--parallel=2` groups plus separate serial stateful groups |

Package-contract and PDF/Typst tests are excluded from the general groups.
Poppler is requested only by the owning PDF/Typst group in the comparison
workflow.

## Live evidence still required

No candidate has been promoted. The following evidence must be populated from
public GitHub Actions runs:

- three green same-SHA legacy comparisons for each test topology;
- file and testcase identity equality for every comparison;
- queue time, critical path, and total runner-minutes;
- ten seeded stability probes before considering `--parallel=2`;
- package self-build, artifact fan-out, and co-located comparisons;
- at least 20 representative pull requests or 14 days of zero-miss classifier
  shadow evidence before selective routing;
- browser serial/parallel/split comparisons and distinct runner image evidence;
- draft-to-ready live-state race proof before enabling `draft-fast`;
- ten merge-group equivalence runs after any separately approved queue
  activation.

The repository-required live/read-only Atlassian E2E remains a commit blocker
until the operator supplies the retained private fixture through the local
environment. No customer identifier or credential was copied into this file.

## Promotion status

| Optimization | Status | Reason |
| --- | --- | --- |
| Exact Bun file-link retry | Implemented | Closed signature, one retry maximum |
| Dependency-free security attestation | Implemented | Script imports only `node:` built-ins |
| Successful raw test-log retention reduction | Implemented | JUnit always; raw log only on failure |
| Duration-aware test topology | Measuring | Required lane remains legacy |
| System Chrome neutral harness | Canary only | Cannot replace matched Chromium/MV3 proof |
| Package build reuse | Held | Same-SHA artifact/co-located evidence absent |
| Selective product routing | Implemented, live validation pending | Conservative dependency closures and fail-open overrides are covered locally; post-change PR evidence is still required |
| Draft-fast | Implemented, live validation pending | Live PR head/draft state is checked at selection; ready proof is checked again inside the final aggregate |
| Quality DAG flattening | Implemented | Duplicate publishing proof and reusable aggregate tail removed; pinned Astro platforms run in parallel |
| Pinned PDF font cache | Implemented | Content-addressed per-OS cache; `fonts:ensure` still verifies every restored file |
| Browser branch parallelism | Held | Isolation and ten-run comparison incomplete |
| Merge queue activation | Deferred | External repository ownership decision required |
