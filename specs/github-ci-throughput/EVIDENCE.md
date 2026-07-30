# GitHub CI throughput rollout evidence

This file records public or synthetic evidence only. Promotion decisions remain
open until the live sample gates in `PLAN.md` are satisfied.

## Implementation snapshot

- Planning baseline SHA: `9ffbe22e604413226a863064da31dc6981f76ce0`
- Baseline Bun inventory: 405 test files
- Current implementation inventory: 410 test files
- Required topology: `legacy-4-shard` (unchanged)
- Candidate topologies: `general-2x1`, `general-3x1`,
  `general-2x2-workers`
- Browser required topology: `browser-combined-serial` (unchanged)
- System Chrome: scheduled/manual non-required compatibility canary
- Merge queue: workflow trigger ready; repository transfer and queue activation
  remain external and deferred

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
| Complete root suite | 5,938 passed, 15 skipped, 0 failed across 410 files |
| TypeScript typecheck (root, extension, compiler, harness) | Passed |
| Complete build | Passed, 20 Turbo tasks |
| Full Bun/npm/pnpm consumer proof | 12 passed, 0 failed |
| Documentation check/build | Passed, 78 pages built |
| Neutral bundled-Chromium harness | 6 passed, 0 failed |
| Packed MV3 PDF.js worker proof | 2 passed, 0 failed |
| Packed MV3 durable-jobs proof | 23 passed, 0 failed |
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
| Selective product routing | Held | Shadow graph and observation gate incomplete |
| Draft-fast | Held | Depends on selective routing and live PR-state proof |
| Browser branch parallelism | Held | Isolation and ten-run comparison incomplete |
| Merge queue activation | Deferred | External repository ownership decision required |
