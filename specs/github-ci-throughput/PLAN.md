# GitHub CI throughput and merge-ready latency

- Status: implemented locally; live promotion evidence pending
- Planning baseline: `27d2e95bd90ea0695f5f7442efec807ec1dca155`
  (`main`, 2026-07-30)
- Investigation reference:
  [PR #135](https://github.com/BjoernSchotte/atlcli/pull/135), which
  implemented issue #134
- Primary workflow:
  [final PR #135 revalidation](https://github.com/BjoernSchotte/atlcli/actions/runs/30518558159)

## Goal

Reduce merge-ready CI latency and runner consumption enough to support a
higher number of independent pull requests per day without weakening the
single required branch-protection contract.

The implementation must:

1. keep every currently required correctness, packaging, platform, browser,
   and consumer contract;
2. balance tests by measured duration instead of file count;
3. compare GitHub job fan-out with Bun worker-process parallelism and promote
   the fastest topology that preserves isolation and coverage;
4. avoid rebuilding the same publishable packages in isolated jobs when
   artifact transfer or a producer dependency does not lengthen the critical
   path;
5. give draft pull requests fast feedback and reserve full proof for
   merge-ready commits;
6. run only impact-relevant gates after the selector has proved that it fails
   open safely;
7. keep classifier latency below a defined budget before selective routing is
   promoted;
8. allow no more than one required runner allocation after the final selected
   product proof;
9. keep a full scheduled drift guard and a manual full-run escape hatch;
10. retain Playwright and a Playwright-matched Chromium for packed MV3 tests;
11. keep the stable `required` status name used by branch protection.

This plan changes CI and test orchestration only. It does not change product
behavior.

## Executive decision

Implement the work in evidence-gated stages:

1. add timing and selection observability without skipping any existing gate;
2. eliminate the known Bun file-link flake;
3. replace the four file-count shards with deterministic duration-aware lanes
   and compare two sequential lanes, three sequential lanes, and two
   two-worker lanes on the same timing snapshot;
4. compare a narrow publishable-package artifact fan-out with a co-located
   package-proof topology before choosing the build-reuse design;
5. flatten the required tail and parallelize only independent setup/proof
   steps;
6. shadow a package/dependency-aware change selector before allowing it to
   skip work;
7. split draft feedback from merge-ready proof;
8. optimize browser provisioning after the Linux test critical path has moved;
9. prepare, but do not activate, GitHub merge-queue support until the
   repository ownership requirement is resolved.

Do **not** add shards or workers blindly, purchase larger runners, introduce a
remote Turbo cache, remove Playwright, disable strict branch protection, or add
broad test retries. A third lane and Bun `--parallel=2` are explicit bounded
A/B candidates in this plan; neither is promoted without measured critical
path, queue, runner-minute, isolation, and coverage evidence.

## OSS patterns adopted and bounded

This plan uses current primary-source patterns, but keeps their external
services and repository-scale assumptions optional:

- [Next.js CI](https://github.com/vercel/next.js/blob/canary/.github/workflows/build_and_test.yml)
  freezes a timing artifact for duration-weighted groups and uses one stable
  aggregate. Atlcli adopts the frozen snapshot and timing-based assignment,
  without requiring Next.js's external timing service.
- [pnpm CI](https://github.com/pnpm/pnpm/blob/main/.github/workflows/ci.yml)
  compiles once for artifact consumers, separates producer dependency fronts,
  and keeps one aggregate; its
  [test workflow](https://github.com/pnpm/pnpm/blob/main/.github/workflows/test.yml)
  uses reverse-dependent affected packages and bounded workers. Atlcli adopts
  those candidates only behind fail-open routing and artifact/self-build A/B
  evidence.
- [Playwright primary CI](https://github.com/microsoft/playwright/blob/main/.github/workflows/tests_primary.yml)
  uses measured unequal shard weights and atomic stateful groups. Atlcli mirrors
  weighted ownership and retains serial boundaries for persistent browser and
  real Typst state.
- [Turborepo CI](https://github.com/vercel/turborepo/blob/main/.github/workflows/turborepo-test.yml)
  uses GitHub's native parallel steps for independent setup. Atlcli adopts
  step-level A/B probes but not Turborepo's larger OSS runners or remote cache
  in the initial rollout.
- [Vite CI](https://github.com/vitejs/vite/blob/main/.github/workflows/ci.yml)
  co-locates build-dependent proof where transfer overhead would dominate.
  That is the reason T3 compares co-located package proof with artifact fan-out
  instead of mandating one architecture.

Next.js's mid-stack PR optimizer is a later throughput option only if atlcli
adopts stacked pull requests operationally. It is not part of required proof in
this plan: every PR must still receive a current full merge-ready result before
merge.

## Measured baseline

The values below are from the final PR #135 workflow unless stated otherwise.
They are the baseline against which the implementation is accepted.

| Metric | Baseline |
| --- | ---: |
| Repository test files | 405 |
| Bun test cases | about 5,900 |
| Linux test payloads | 45 s / 135 s / 254 s / 55 s |
| Linux shard job durations | 80 s / 160 s / 299 s / 88 s |
| Last green pre-sync full workflow | 5 min 37 s |
| Final merge-SHA first attempt, red only from consumer flake | 5 min 28 s |
| Final validation including one flaky retry | 7 min 55 s |
| Change-classifier job | about 6 s |
| Browser job | 1 min 55 s |
| Neutral browser E2E payload inside that job | about 24 s |
| Packed MV3 build plus two proof payloads inside that job | about 37 s |
| Consumer smoke | 1 min 51 s before the retry |
| Same-SHA draft-to-ready work discarded in PR #135 | about 10 runner-minutes |

The files were evenly divided, but their runtimes were not:

- shard 1: 102 files, 1,526 tests, about 45 seconds of test payload;
- shard 2: 101 files, 1,541 tests, about 135 seconds;
- shard 3: 101 files, 1,250 tests, about 254 seconds;
- shard 4: 101 files, 1,602 tests, about 55 seconds.

The primary heavy work in shard 3 was:

- the real Typst derivative pipeline in
  `packages/pdf-compiler-browser/src/compiler.test.ts`, about 101 seconds;
- the build plus API report and closure checks in
  `scripts/api-report.test.ts`, about 76 seconds.

Shard 2 separately rebuilt publishable packages in
`scripts/dist-hygiene.test.ts`, about 44 seconds. The static job and consumer
smoke also build overlapping package outputs in separate filesystems.

The final false failure was a Bun `EEXIST` file-link failure while installing
`@atlcli/confluence` in the throwaway consumer. Retrying the identical failed
job succeeded. Earlier PR #135 failures were not CI noise: API, corpus, and
packed MV3 gates caught incomplete product changes and must remain represented.

PR #135 also demonstrated the merge-throughput problem:

1. a complete run passed in 5 minutes 37 seconds;
2. `main` had advanced by one commit;
3. strict up-to-date branch protection required a new merge SHA;
4. every full gate ran again;
5. the consumer flake then forced a targeted rerun.

## Current-state map

| Path | Current responsibility | Relevant constraint |
| --- | --- | --- |
| `.github/workflows/ci.yml` | Event routing, platform/browser jobs, stable `required` aggregate | Every product change selects almost every gate |
| `.github/workflows/reusable-quality.yml` | Static quality, root build, four Bun shards, security attestation | Four shards repeat install, Poppler, and font setup; inner aggregate adds a tail runner |
| `.github/workflows/reusable-consumer-smoke.yml` | Pinned and latest external-consumer matrix | Rebuilds packages, serializes independent consumer contracts, and has no bounded known-flake recovery |
| `.github/workflows/security-attestation.yml` | Exact-SHA attestation on every main push | Installs the full workspace although `attest.ts` imports only Bun/Node built-ins |
| `scripts/ci/classify-changes.ts` | Conservative path classifier | One broad `code` bit covers all `apps/`, `packages/`, and product scripts |
| `scripts/ci/classify-changes.test.ts` | Classifier regression tests | Unknown and workflow paths deliberately fail open |
| `scripts/ci/workflow-policy.test.ts` | Structural CI contract | Protects the stable aggregate and fail-closed skip behavior |
| `package.json` | Root test/typecheck/build commands | Root `test` is not a Turbo task and discovers the whole repository |
| `turbo.json` | Build/typecheck caching and dependencies | No test task exists |
| `scripts/api-report.test.ts` | Builds packages and validates public API reports/closures | Build runs inside a general Bun shard |
| `scripts/dist-hygiene.test.ts` | Builds packages and validates emitted artifacts | Performs a second isolated package build |
| `scripts/consumer-smoke-filelink.ts` | Creates a throwaway `file:` consumer | One un-retried `bun install` can fail with the known Bun `EEXIST` signature |
| `apps/browser-export-harness/playwright.config.ts` | Neutral ordinary-browser contract | Supports `chrome` or `chromium`, currently one worker; CI runs it serially before MV3 proof |
| `apps/extension/tests/jobs/packed/job-recovery.e2e.ts` | Packed MV3 durable-job behavior | Requires persistent extension context and `channel: "chromium"`; its branch is currently serialized after neutral E2E |

The authoritative root test command remains:

```bash
bun run test
```

Never substitute bare `bun test` for the complete repository command. The root
script supplies the `development` export condition required by workspace source
resolution.

## Required invariants

### Correctness and coverage

- Every test file discovered by the repository's Bun test conventions is
  assigned to exactly one required full-proof lane.
- The topology selected for required CI uses a fixed, reviewed worker count.
  It never uses Bun's CPU-count default, and it never enables global
  `--concurrent`.
- Bun process-parallel candidates may run only files proved independent under
  `--parallel=2`, which implies per-file isolation. Stateful/order-sensitive
  groups, package-contract work, and real Typst/PDF proof remain explicit
  serial lanes unless separately isolated.
- A newly added test file is never silently omitted because it lacks historical
  timing data.
- Duplicate and missing assignments fail before any test lane is allowed to
  pass.
- Skipped tests remain visible; pass-count equality is not used as a substitute
  for file/test-case coverage.
- Full scheduled and manual runs remain unfiltered.
- Changes to workflows, dependency/lock files, root TypeScript/Turbo config,
  patches, vendored runtime inputs, CI selection code, or unknown paths fail
  open to the full matrix.
- Product tests keep their existing assertions, timeouts, fixtures, and
  host-specific boundaries. CI optimization must not weaken tests to make them
  faster.

### Required status

- Branch protection continues to require exactly one stable status named
  `required`.
- `required` uses `if: always()` and rejects every selected job that is not
  `success`.
- It accepts `skipped` only when the classifier explicitly marks the
  corresponding gate unselected.
- A ready pull request can never inherit a draft-fast success without a new
  full-proof run.
- Runs classified as Draft or superseded by the final pre-aggregate state check
  use `draft-fast` or `superseded`, never `required`. A run that becomes stale
  after that check may end with a failing `required`, but can never report a
  successful `required`.
- A merge-ready `required` job verifies the current PR head SHA and non-draft
  state through a read-only GitHub API check immediately before reporting
  success. Event payload state alone is not sufficient for this final guard.
- There is at most one required runner job after the slowest selected product
  proof. No `quality-complete -> final-pr-state -> required` runner chain is
  permitted.
- Timing/selection telemetry is a non-required sibling. `required`, draft
  status, and final PR-state proof must never depend on telemetry completion or
  success.
- Strict up-to-date protection remains enabled unless a separately approved
  merge-queue migration replaces the manual update workflow.

### Consumer and publication

- Local consumer tests remain self-contained: without a verified CI build
  manifest they build packages exactly as today.
- CI may reuse a package artifact or verified co-located build only when its
  manifest matches the exact
  workflow SHA, lockfile digest, package list, and expected `dist` files.
- A missing, stale, incomplete, or mismatched build manifest must trigger a
  rebuild or fail; it must never make publication tests vacuous.
- The Bun `EEXIST` retry is limited to the exact known file-link signature,
  recreates the throwaway consumer, and runs at most once.
- No other package-manager, build, resolution, or smoke failure is retried.
- Build reuse is not a correctness goal at the expense of wall time. If the
  complete producer/transfer/consumer chain is slower than the current
  self-contained baseline, retain the faster self-build path and record the
  artifact topology as rejected.

### Browser shapes

- `@playwright/test` remains the browser runner and assertion API.
- Packed MV3 tests continue to use Playwright's matched full Chromium with a
  persistent context. They must not use the GitHub runner's arbitrary system
  Chrome/Chromium executable.
- The neutral browser harness may exercise system Google Chrome only as a
  separately visible compatibility lane until promotion evidence is met.
- Runner Chrome is not treated as a replacement for packed-extension proof.
- Worker count remains one for stateful packed suites until their profile,
  IndexedDB, service-worker, and cache dependencies are explicitly isolated.

### Privacy and security

- Do not copy tokens, customer documents, tenant URLs, page IDs, space IDs,
  account IDs, or derived private artifacts into workflow logs, fixtures,
  timing data, this spec, commits, or PR text.
- Test timing data contains repository-relative test paths and durations only.
- Live Atlassian E2E remains outside GitHub-hosted CI.
- Workflow permissions remain least-privilege. T6 may add
  `pull-requests: read` for current-state validation, and T0 may add
  `actions: read` to the summary job for same-run job timestamps; no write
  token or third-party cache credential is required.

## Non-goals

- changing CLI, DOCX, PDF, extension, Forge-shaped, or browser export behavior;
- reducing test assertions or deleting slow regression coverage;
- replacing Playwright with Selenium, Puppeteer, raw CDP, or shell scripts;
- using system Chrome for packed MV3 extension tests;
- enabling arbitrary retries for unit, browser, package, or platform failures;
- disabling strict branch protection to save builds;
- purchasing larger runners before the software topology is corrected;
- introducing a remote Turbo-cache service or its credentials in this plan;
- automatically transferring the repository to a GitHub organization;
- automatically enabling a merge queue or changing repository settings;
- running live Atlassian credentials in GitHub Actions;
- suppressing the full weekly drift guard;
- forcing artifact fan-out when same-job reuse or the existing self-contained
  path is faster;
- making timing telemetry part of the required dependency graph;
- using Bun's unbounded/default CPU worker count or global `--concurrent`.

## Target modes and gate topology

### Event modes

| Event | Proof mode | Required behavior |
| --- | --- | --- |
| Draft PR opened/synchronized | `draft-fast` | Impact-relevant unit/type checks and docs/media gates |
| PR marked ready | `merge-ready` | Complete selected product proof for the exact merge candidate |
| Non-draft PR synchronized/reopened | `merge-ready` | Complete selected product proof |
| PR converted to draft | `draft-fast` | Cancel superseded full work and return to fast feedback |
| `push` to `main` | `full` | Full unfiltered post-merge evidence until merge-queue equivalence is proven |
| Weekly schedule | `full` | Full unfiltered drift guard and timing refresh |
| `workflow_dispatch` | `full` | Manual escape hatch |
| `merge_group` | `full` | Land inactive support before organization/merge-queue activation |

### Full-proof jobs

The intended full topology is:

1. `changes` computes proof mode, affected packages/capabilities, current
   PR-state validity, and fail-open overrides within a p95 budget of ten
   seconds.
2. One selected package-proof topology owns the package/consumer path. The
   preferred candidates build publishable outputs once through either a narrow
   caller-level artifact producer followed by parallel consumers or a
   co-located job with parallel proof branches. If both are slower, the
   measured self-build baseline remains temporarily authoritative. No topology
   places a full root/private-app build in front of package consumers.
3. `static-quality` performs offline contract checks and typecheck in parallel
   with package proof.
4. Package-contract and consumer contracts start at the earliest verified
   publishable-package boundary. They never wait for the complete reusable
   quality workflow, private app builds, or extension-output checks.
5. `unit-tests` uses the A/B winner among two sequential lanes, three
   sequential lanes, or two lanes with exactly two Bun worker processes. It
   never installs Poppler.
6. `pdf-typst-proof` runs real Typst/PDF tests with only their required fonts
   and Poppler tools.
7. macOS PDF, Windows sink, neutral browser, and packed MV3 gates are selected
   by affected capabilities or by full-run policy.
8. The combined browser topology overlaps neutral and packed-MV3 branches only
   after their profile roots, ports, outputs, and browser state are proved
   independent; otherwise it keeps them serial or uses the measured split-job
   winner.
9. Exactly one aggregate job follows the final selected proof. It performs the
   last live PR-state check itself and uses a mode-dependent name:
   `draft-fast` for draft
   feedback, `superseded` for stale events, and the stable `required` name only
   for merge-ready/full evidence.
10. Telemetry runs as a non-required sibling fan-in and cannot delay or satisfy
    the aggregate.

The measured general payload after package-contract and real-Typst work is
removed is about 269 seconds. Two sequential lanes have a theoretical payload
ceiling of about 135 seconds; three sequential lanes reduce it to about 90
seconds. Two `--parallel=2` lanes may achieve similar or better wall time
without a third GitHub runner, but change file isolation and therefore require
the strongest stability proof. The executor must collect all three candidates
before choosing; the plan does not preselect a winner.

## Performance and safety acceptance gates

Evaluate performance only on successful, non-cancelled, merge-ready product
runs. Keep correctness gates independent from performance gates.

### Promotion gates

| Gate | Required evidence |
| --- | --- |
| Weighted-lane completeness | Three consecutive scheduled/manual comparisons with identical discovered file sets, zero duplicates, and zero missing test cases |
| Lane execution topology | Same-SHA comparisons of two sequential lanes, three sequential lanes, and two `--parallel=2` lanes; winner has zero coverage/isolation differences, lower p50 critical path, and no unacceptable queue/runner-minute regression |
| Weighted-lane balance | For the selected job topology, slowest general unit job no more than 1.5 times the fastest |
| Package-proof topology | At least three same-SHA comparisons of current self-build, narrow artifact fan-out, and co-located proof; promote only a topology that preserves every contract and shortens the complete package/consumer critical path |
| Required tail | Workflow-policy proof and three live runs show at most one required runner allocation after the slowest selected product proof; telemetry is not an ancestor |
| Classifier budget | Over at least 20 representative runs, classifier p95 at most 10 s and every error/unknown input fails open |
| Selective routing | At least 20 representative product PRs or 14 calendar days in shadow mode, zero under-selection findings |
| Consumer retry | Synthetic signature tests pass; exact known failure retries once; every adjacent/nonmatching failure does not retry |
| Step-level parallelism | At least ten comparisons show isolated paths/outputs, identical results, lower critical path, and no more than 10% runner-minute regression |
| System Chrome canary | Nonblocking only in this plan; record ten distinct runner Image Version values, and require a separate Playwright-upgrade/compatibility plan before any promotion |
| Merge queue | Repository is organization-owned, queue is enabled, `merge_group` full proof is green for at least ten merges |

### Outcome targets

| Metric | Target |
| --- | ---: |
| Merge-ready p50 wall time over at least 10 product PRs | at most 3 min 30 s |
| Merge-ready p95 wall time over at least 20 product PRs | at most 5 min |
| Merge-ready stretch p50 after all safe A/B promotions | at most 2 min 30 s |
| Merge-ready stretch p95 after all safe A/B promotions | at most 4 min |
| Slowest required Linux test lane p95 | at most 2 min 45 s |
| Change classifier p95 | at most 10 s |
| Tail from final selected proof completion to aggregate completion p95 | at most 15 s |
| Required runner jobs after the final selected proof | at most 1 |
| Draft-fast p50 wall time | at most 2 min |
| Runner-minute reduction for comparable product PRs | at least 25% |
| Classified infrastructure false failures over 30 merge-ready runs | zero |
| Selective-routing misses | zero |
| Test files omitted or duplicated in a full run | zero |
| Typical targeted product jobs after routing promotion | at most 6 |

Planning hypothesis, not a promotion guarantee: for a PR-135-shaped full run
without abnormal external runner queueing, the combined safe winners should
move merge-ready p50 into roughly 2 minutes 15 seconds to 2 minutes 45 seconds.
T0 evidence replaces this range; the executor must not tune measurements or
weaken gates merely to make the estimate true.

If the correctness promotion gates pass but the performance target does not,
stop and measure job setup, runner queue time, and artifact transfer separately.
The hard p50/p95 targets remain completion gates; the stretch targets guide
topology selection but do not justify a correctness or runner-minute
regression. Do not add shards, workers, caches, or containers based only on
intuition.

## Commands required by the executor

Run all repository tests through the root command:

| Purpose | Command | Expected result |
| --- | --- | --- |
| Focused CI policy | `bun run test scripts/ci/classify-changes.test.ts scripts/ci/workflow-policy.test.ts` | exit 0, all tests pass |
| Timing/lane logic | `bun run test scripts/ci/test-inventory.test.ts scripts/ci/test-lanes.test.ts scripts/ci/test-timings.test.ts scripts/ci/actions-timings.test.ts` | exit 0, all tests pass |
| Package artifact | `bun run test scripts/ci/package-build-artifact.test.ts` | exit 0, all closure/integrity fixtures pass |
| Consumer policy | `bun run test scripts/consumer-smoke.test.ts scripts/install-matrix.test.ts` | exit 0 when smoke opt-in is absent; unit policy tests still execute |
| Opt-in consumer E2E | `ATLCLI_CONSUMER_SMOKE=1 bun run test scripts/consumer-smoke.test.ts scripts/install-matrix.test.ts` | exit 0; every consumer shape passes |
| Full suite | `bun run test` | exit 0, no failed tests |
| Typecheck | `bun run typecheck` | exit 0, no TypeScript errors |
| Build | `bun run build` | exit 0 |
| Neutral browser | `bun run test:browser-export-harness` | exit 0 |
| Packed worker | `bun run --cwd apps/extension test:worker-extension-browser` | exit 0 |
| Packed durable jobs | `bun run --cwd apps/extension test:jobs-extension-browser` | exit 0 |
| Docs | `bun run docs:check && bun run docs:build` | both commands exit 0 |
| Diff hygiene | `git diff --check` | no output, exit 0 |

The executor must use `bun run test`, never bare `bun test`, for the complete
suite.

## Scope

### In scope

The implementation may modify or create files in these areas only:

- `.github/workflows/ci.yml`
- `.github/workflows/reusable-quality.yml`
- `.github/workflows/reusable-consumer-smoke.yml`
- a new `.github/workflows/reusable-package-build.yml`
- a new `.github/workflows/reusable-package-contract.yml`
- a new `.github/workflows/reusable-package-proof.yml` only if the measured
  co-located topology wins
- `.github/workflows/security-attestation.yml`
- `.github/workflows/consumer-smoke.yml`
- `.github/workflows/release-core.yml`
- `.github/workflows/release-cli.yml`
- `.github/workflows/release.yml`, limited to wiring the existing preflight to
  the shared package-build producer
- a new reusable browser or package-proof workflow only if the final topology
  is clearer than extending the files above
- `scripts/ci/**`
- `scripts/ci/classify-changes.ts`
- `scripts/ci/classify-changes.test.ts`
- `scripts/ci/workflow-policy.test.ts`
- `scripts/api-report.test.ts`
- `scripts/dist-hygiene.test.ts`
- `scripts/consumer-smoke.ts`
- `scripts/consumer-smoke-filelink.ts`
- `scripts/consumer-smoke.test.ts`
- `scripts/install-matrix.test.ts`
- new `scripts/ci/run-consumer-leg.ts` and focused consumer-leg test entrypoints
  only if required by the selected bounded parallel topology
- `package.json`
- `turbo.json`
- test/package manifests needed to expose explicit CI commands
- `apps/browser-export-harness/playwright.config.ts`
- browser-harness and packed-extension Playwright configs/tests only when
  needed to remove cross-test state before changing worker topology
- `src/content/docs/contributing.md`
- this spec and a future `specs/github-ci-throughput/EVIDENCE.md`

Every task below further narrows this list. Do not touch all listed files by
default.

### Out of scope

- product implementation under export, Jira, Confluence, DOCX, PDF, extension,
  or Forge adapter source directories;
- public package APIs or generated API reports except when an implementation
  mistake accidentally changes them, in which case stop;
- release behavior, versions, changelog, publishing steps, and publishing
  credentials; only the existing release-quality caller wiring is in scope;
- repository ownership, branch-protection settings, or GitHub billing;
- unrelated dependency upgrades;
- live customer or private test artifacts.

## Git and delivery workflow

- Use branches prefixed `codex/`.
- Use Conventional Commits, for example:
  `perf(ci): balance test lanes by duration`.
- Keep logical changes separately reviewable:
  telemetry, consumer flake, test lanes, routing, draft/ready behavior, and
  browser optimization must not be one opaque commit.
- Do not push until the operator explicitly authorizes it.
- Do not make a release.
- Keep the PR Draft until every promotion gate required by its current phase is
  recorded.
- Each logical implementation task must add or update tests that would catch
  its regression.
- Before committing implementation, run the applicable automated gates and the
  repository-required live/read-only E2E described in T9. Clean every created
  test resource.

## Implementation order

| Task | Title | Depends on |
| --- | --- | --- |
| T0 | Establish exact timing and selection telemetry | none |
| T1 | Make the Bun file-link smoke deterministically retry only the known flake | T0 |
| T2 | Build a fail-closed test inventory and benchmark lane/worker topologies | T0 |
| T3 | Select the fastest verified package-proof and weighted-test topology | T1, T2 |
| T4 | Shadow package/capability-aware change routing | T0 |
| T5 | Promote safe selective routing | T3, T4 |
| T6 | Separate draft-fast feedback from merge-ready proof | T5 |
| T7 | Parallelize and optimize neutral-browser and packed-MV3 provisioning | T3, T5 |
| T8 | Prepare merge-queue support without changing repository ownership | T6 |
| T9 | Document, validate, and record rollout evidence | T1–T8 as selected |

T1 and T2 may be implemented in parallel after T0. T4 may collect shadow data
while T2/T3 are being implemented. T5 must not land before the shadow gate is
met. T8 is conditional and must not activate a queue.

## T0 — Establish exact timing and selection telemetry

### Purpose

Create a trustworthy measurement surface before changing topology. The current
JUnit files are uploaded per shard, but no checked logic reconstructs file
coverage, lane balance, critical path, or selected-versus-skipped gates.

### Changes

1. Add `scripts/ci/test-timings.ts` with pure functions that:
   - parse Bun JUnit XML without evaluating repository content;
   - count leaf `testcase` elements and aggregate duration by their
     repository-relative file;
   - accept Bun 1.3.14's legitimate repetition of the same file on outer and
     nested `testsuite` plus `testcase` elements;
   - retain pass/fail/skip counts;
   - reject absolute paths, paths outside the repository, duplicate file
     assignments across lane artifacts in the same topology namespace,
     duplicate testcase identities within the same leaf scope, invalid numbers,
     and negative durations;
   - allow the same file once in `legacy` and once in `candidate` only when a
     comparison run labels those as separate topology namespaces;
   - emit a versioned JSON schema containing baseline SHA, source run, samples,
     and per-file duration.
2. Add `scripts/ci/test-timings.test.ts` with synthetic XML fixtures covering:
   - normal files and durations;
   - skipped tests;
   - legitimate nested suite/file repetition;
   - duplicate leaf testcases and duplicate file ownership across lanes;
   - malformed XML/numbers;
   - absolute/path-traversal inputs;
   - two shards containing the same file.
   Check in one small, synthetic/redacted Bun 1.3.14 JUnit golden fixture and
   parse it in the tests so the implementation follows Bun's real nesting.
3. Add `scripts/ci/actions-timings.ts` plus API-response fixtures. The script
   uses the same repository/run-attempt Actions Jobs API with
   `actions: read` to calculate:
   - workflow wall time;
   - per-job queue time (`started_at - created_at`);
   - per-job runner time (`completed_at - started_at`);
   - critical path from actual job timestamps/dependencies;
   - total runner-minutes, including started jobs later cancelled.
   Keep skipped/unstarted jobs out of runner-minute totals, and label
   cancelled/failed attempts separately so they cannot enter green-run
   p50/p95 samples.
4. Add a non-required workflow summary job that downloads same-run JUnit artifacts,
   writes:
   - selected proof mode and routes;
   - per-lane setup and test duration;
   - slowest files;
   - total files and test cases;
   - critical-path wall time;
   - total runner time;
   to `$GITHUB_STEP_SUMMARY` and a JSON artifact.
   Do not derive checkout, setup, queue, artifact-transfer, critical-path, or
   runner-minute values from JUnit.
5. Record named phase timings in addition to job totals:
   - checkout, runtime setup, each cache restore, dependency installation,
     fonts, Poppler, browser provisioning, artifact upload/download/verify;
   - filtered publishable-package build, pack hooks, and package-contract;
   - each consumer contract (`file-link`, tarball/Vite, Node/npm, npm/pnpm);
   - neutral browser E2E, packed MV3 build, packed worker proof, packed durable
     jobs proof, and shape parity;
   - final-product-proof completion and aggregate completion.
   Phase names are a versioned schema and must be stable across A/B candidates.
6. Make the timing summary a non-required sibling fan-in with `if: always()`.
   `scripts/ci/workflow-policy.test.ts` must fail if `required`,
   `draft-fast`, `superseded`, or any live PR-state guard declares telemetry as
   a `needs` dependency. Telemetry failure remains visible but can neither
   delay nor satisfy merge proof.
7. Upload JUnit XML on every run. Upload full raw test logs only on failure;
   timing evidence must not depend on retaining successful console logs.
8. Do not automatically commit timings from a PR. A scheduled/manual main run
   may emit a candidate timing artifact for explicit review.
9. Bootstrap the first checked timing snapshot from the final PR #135 artifacts
   if still available. If they have expired, run one complete baseline and use
   that result. Do not fabricate missing durations.
10. At the beginning of each scheduled/manual topology comparison, upload one
    validated timing snapshot as a run-local artifact containing its schema,
    source SHA/run, and content digest. Every candidate lane and rerun in that
    comparison consumes that immutable snapshot. Candidate jobs must not
    independently refresh or redistribute timings during a run. Newly
    discovered files receive T2's conservative fallback weight.
11. Tag every comparison with a topology identifier:
    `legacy-4-shard`, `general-2x1`, `general-3x1`,
    `general-2x2-workers`, `package-self-build`, `package-artifact-fanout`,
    `package-colocated`, `browser-combined-serial`,
    `browser-combined-parallel`, or `browser-split`.
12. Remove the `bun install --frozen-lockfile` step from
   `.github/workflows/security-attestation.yml` after adding a workflow-policy
   assertion that `scripts/security/attest.ts` remains dependency-free. Its
   current imports are all `node:` built-ins and the script reads repository
   files directly. If a future external import is added, that policy test must
   require the install step again.

### Verification

```bash
bun run test scripts/ci/test-timings.test.ts scripts/ci/actions-timings.test.ts scripts/ci/workflow-policy.test.ts
```

Expected: all tests pass; malformed and duplicate timing fixtures fail in the
tested manner, and the attestation workflow has no unnecessary dependency
install while its script remains dependency-free.

Trigger one manual full workflow. Expected:

- all legacy gates still run;
- `required` remains green only when all selected gates pass;
- the telemetry job is not an ancestor of any required/status job;
- the summary lists 405 test files at the planning baseline, subject only to
  legitimate test additions after that baseline;
- phase timings and the frozen timing-snapshot digest are present;
- no source, environment secret, absolute home path, or private identifier
  appears in the timing artifact.

### Commit

`perf(ci): record test and gate timing evidence`

## T1 — Make the Bun file-link smoke retry only the known flake

### Purpose

Prevent a transient, already observed Bun file-link `EEXIST` from invalidating
an otherwise fully green merge candidate while preserving fail-closed behavior
for genuine consumer failures.

### Changes

1. In `scripts/consumer-smoke-filelink.ts`, separate:
   - install execution;
   - output classification;
   - cleanup/recreation;
   - smoke assertions.
2. Add a pure predicate such as `isKnownBunFilelinkEexist(result)` that returns
   true only when all of these are present:
   - the executing Bun version exactly matches the separately reviewed version
     recorded with the retry signature (initially 1.3.14);
   - non-zero install exit;
   - one normalized, anchored line matching a sanitized golden from the real
     PR #135 `EEXIST: File exists: failed to link package @atlcli/...`
     failure;
   - the captured package name is in the allowlist derived from current
     publishable `@atlcli/*` manifests;
   - after known Bun progress/boilerplate lines are removed, no second line
     matches the closed fatal markers `error`, `failed`, `panic`, `fatal`,
     `ENOENT`, integrity/checksum failure, or process signal.
   Do not use a loose collection of `includes()` checks.
3. On the first exact match:
   - log one GitHub warning without copying arbitrary install output;
   - remove and recreate the throwaway consumer root;
   - regenerate its manifest and overrides;
   - execute `bun install` once more.
4. If the second install fails, throw the normal consumer error. Never perform
   a third attempt.
5. For all nonmatching failures, throw immediately without retry.
6. Preserve local self-contained behavior and the current file-link,
   tarball/Node, DOCX, PDF, and resolution assertions.
7. If the underlying duplicate package-identity cause can be removed without
   weakening the direct plus transitive file-link shape, prefer that fix and
   retain the predicate as a regression guard. Do not remove the consumer shape
   merely because Bun is flaky.
8. A Bun version change disables the retry until a real failure on that version
   is classified, a sanitized golden is reviewed, and these tests are updated.

### Tests

Add injectable install execution or a small pure retry coordinator so
`scripts/consumer-smoke.test.ts` can prove:

- success performs one install;
- the exact known signature performs exactly two installs and one cleanup;
- a second exact failure remains fatal;
- generic `EEXIST` without `failed to link package` does not retry;
- an npm/pnpm error does not retry;
- a Bun file-link error for a non-`@atlcli/` target does not retry;
- mixed output containing a second independent error does not retry;
- logged warnings redact the temporary absolute path and package detail beyond
  the safe package name.
- a different Bun version does not retry;
- an `@atlcli/*` name absent from the publishable allowlist does not retry;
- the sanitized real Bun 1.3.14 golden retries, while one-token mutations of its
  error class do not.

### Verification

```bash
bun run test scripts/consumer-smoke.test.ts scripts/install-matrix.test.ts
ATLCLI_CONSUMER_SMOKE=1 bun run test scripts/consumer-smoke.test.ts scripts/install-matrix.test.ts
```

Expected: unit policy and real consumer shapes pass; the injected known failure
retries exactly once.

### Commit

`fix(ci): bound the known Bun filelink retry`

## T2 — Build a fail-closed test inventory and benchmark lane/worker topologies

### Purpose

Replace Bun's file-count shard selection with deterministic longest-processing-
time assignment based on measured test-file duration, then measure GitHub-job
fan-out against bounded Bun worker-process parallelism before choosing the
required topology.

### Changes

1. Add `scripts/ci/test-inventory.ts`:
   - mirror Bun's documented repository test discovery for
     `*.test.{js,jsx,ts,tsx}`, `*_test.{js,jsx,ts,tsx}`,
     `*.spec.{js,jsx,ts,tsx}`, and `*_spec.{js,jsx,ts,tsx}`;
   - normalize paths relative to repository root;
   - exclude dependency, generated, build-output, browser-only Playwright, and
     ignored directories explicitly;
   - expose one pure inventory function and one CLI;
   - sort deterministically.
2. Add `scripts/ci/test-inventory.test.ts` using a synthetic directory tree.
   Prove inclusion, exclusion, normalization, stable ordering, and rejection of
   paths outside the root. Include all four Bun naming families, hidden
   directories, `node_modules`, generated output, and colliding base names.
3. Add a checked `scripts/ci/test-lanes.json` metadata file. It must contain:
   - schema version and timing baseline SHA;
   - per-file historical duration when measured;
   - exactly one optional lane override:
     `general`, `package-contract`, or `pdf-typst`;
   - zero or more orthogonal setup requirements such as `fonts`, `poppler`,
     or `typst-runtime`;
   - an optional atomic-group identifier for files that must share one serial
     process because they intentionally exercise order/global-state behavior;
   - no test outcome or private data.
4. Add `scripts/ci/test-lanes.ts`:
   - assign every inventory file to exactly one lane, defaulting a new
     unannotated file to `general`;
   - assign `package-contract` and `pdf-typst` files to their explicit lanes;
   - accept only the candidate shapes `general-2x1`, `general-3x1`, and
     `general-2x2-workers`;
   - assign remaining files to two or three general jobs with deterministic
     longest-processing-time bin packing;
   - keep atomic groups indivisible and emit them as explicit serial execution
     groups inside the least-loaded candidate job; account for that serial tail
     in job-duration balancing;
   - give a newly discovered file without timing the larger of the historical
     p95 duration and a conservative fixed default;
   - reject duplicate, stale, conflicting, or invalid metadata;
   - emit a compact JSON matrix and human-readable explanation;
   - expose the validated file arrays to an argv-safe runner; never
     shell-evaluate a path.
5. Add `scripts/ci/run-test-lane.ts`. It must:
   - load one already validated lane by identifier;
   - spawn `bun run test -- [--parallel=2] ./repo-relative-file...` with an argv
     array, never a constructed shell string or command substitution;
   - preserve the root `development` condition and JUnit reporter arguments;
   - accept only worker counts `1` or `2`; never omit the value and inherit the
     runner CPU count;
   - never add global `--concurrent`;
   - reject worker count `2` when the selected execution group contains an
     atomic group, package-contract work, real Typst/PDF proof, or any explicit
     stateful override; a `general-2x2-workers` job may run a separate serial
     execution group before/after its worker-safe group;
   - reject an empty, unknown, duplicate, absolute, or escaping path before
     spawning Bun.
6. Add `scripts/ci/test-lanes.test.ts` covering:
   - deterministic assignment;
   - expected balancing;
   - identical output independent of input ordering;
   - new-file conservative weighting and default `general` ownership;
   - duplicate/stale paths;
   - lane conflicts;
   - combined requirements such as `fonts` plus `poppler`;
   - zero-file lanes;
   - spaces/special characters and colliding filename filters;
   - accepted/rejected worker counts and exact `--parallel=2` argv placement;
   - atomic groups remaining serial and indivisible;
   - rejection of `--concurrent`, implicit/default worker counts, and parallel
     package/Typst/stateful lanes;
   - exact union and pairwise-disjoint lane sets.
7. Add a coverage assertion that compares inventory with the union of planned
   lanes before tests start. The assertion must fail before a zero-test lane can
   be accepted.
8. On scheduled/manual runs only, compare the legacy four shards with one
   candidate topology at a time. Every comparison must use the same SHA and the
   frozen T0 timing snapshot. Rotate through:
   - `general-2x1`;
   - `general-3x1`;
   - `general-2x2-workers`.
   Do not execute every candidate in every PR run. Compare file identities and
   JUnit test cases, not only totals.
9. For `general-2x2-workers`, add a stability probe that repeats the complete
   candidate with at least ten fixed, recorded random seeds across the three
   comparison runs and fails on any file/testcase difference, leaked handle,
   port collision, temp/output collision, or order-dependent result. Use Bun's
   `--randomize` only in this non-required probe; required lanes remain
   deterministically ordered.
10. Select the required topology only after at least three green comparisons
    per candidate. Rank candidates by:
    - identical coverage and zero isolation findings first;
    - p50/p95 full-workflow critical path;
    - p50/p95 job queue delay;
    - summed runner-minutes;
    - rerun granularity and debuggability.
    A third GitHub lane may be promoted only if its wall-time improvement
    survives queueing and runner-minute growth. Prefer bounded in-job workers
    when they are equally fast and equally stable because they consume fewer
    runner allocations.

### Initial capability ownership

At minimum, assign:

- `scripts/api-report.test.ts` and `scripts/dist-hygiene.test.ts` as
  lane `package-contract`;
- real Typst/compiler integration and PDF inspection tests requiring the
  compiler runtime as lane `pdf-typst`;
- tests that invoke `pdftotext`, `pdftoppm`, or equivalent proof tools as
  requiring `poppler`;
- tests that resolve pinned PDF fonts as requiring `fonts`;
- all other Bun tests as `general`.

At minimum, inspect the existing registry/auth isolation probes and every test
that spawns a nested Bun test process. Mark only the outer orchestration file
atomic when required; do not broadly serialize an entire package without
evidence.

Search actual imports and subprocess calls before finalizing the list. Do not
infer setup needs from filenames alone. A file may have one lane and multiple
requirements, for example lane `pdf-typst` with both `fonts` and `poppler`.

### Verification

```bash
bun run test scripts/ci/test-inventory.test.ts scripts/ci/test-lanes.test.ts scripts/ci/test-timings.test.ts
bun scripts/ci/test-lanes.ts --check --topology general-2x1
bun scripts/ci/test-lanes.ts --check --topology general-3x1
bun scripts/ci/test-lanes.ts --check --topology general-2x2-workers
```

Expected:

- every discovered test file is assigned exactly once;
- no stale metadata remains;
- every candidate has exact union/pairwise-disjoint coverage;
- every candidate's slowest general job has an estimated duration ratio at or
  below 1.5 compared with its fastest general job;
- every worker-safe group in `general-2x2-workers` emits exactly
  `--parallel=2`, never `--concurrent`; every stateful/atomic file appears once
  in a separately reported serial group, and no Typst/package-contract file is
  present;
- explicit package and Typst lanes contain their known heavy tests.

Run three scheduled/manual legacy-versus-candidate comparisons for each
candidate topology. Record workflow URLs, exact coverage comparison, phase
timings, queue delay, runner-minutes, and the promotion decision in
`specs/github-ci-throughput/EVIDENCE.md`.

### Commit

`perf(ci): benchmark duration-aware test topologies`

## T3 — Select the fastest verified package-proof and weighted-test topology

### Purpose

Remove the measured duplicate publishable-package builds and repeated PDF setup
without replacing them with a longer producer/upload/download chain. Promote
the T2 lane/worker winner and a package-proof topology only after end-to-end
same-SHA comparisons.

### Changes

1. Before changing required CI, use T0 phase telemetry to establish:
   - the current `package-self-build` path from job start through every
     package-contract and consumer assertion;
   - filtered publishable-package build and pack-hook time;
   - each consumer contract time (`file-link`, tarball/Vite, Node/npm,
     npm/pnpm);
   - checkout/install/cache/setup, artifact transfer, verification, queue, and
     aggregate-tail time.
   Keep the current 1 minute 51 second consumer job as the historical reference,
   but compare complete topology critical paths rather than subtracting phases
   arithmetically.
2. Implement two non-required same-SHA candidates behind a
   `workflow_dispatch` topology input:
   - `package-artifact-fanout`: a narrow producer builds/packs publishable
     packages, then package-contract and consumer legs download and verify the
     same artifact in parallel;
   - `package-colocated`: one job builds publishable packages once, verifies a
     local manifest, then runs independent package-contract and consumer legs
     in bounded step/process parallelism within that workspace.
   Compare each candidate with `package-self-build` at least three times. If
   neither candidate shortens the complete merge-ready critical path without a
   correctness or unacceptable runner-minute regression, retain self-build and
   record both candidates as rejected. Do not force artifact reuse merely to
   make a "build once" metric green.
3. For `package-artifact-fanout`, add
   `.github/workflows/reusable-package-build.yml` as a single-purpose,
   caller-level producer directly after `changes`. The producer:
   - installs pinned dependencies and restores existing Bun/Turbo caches;
   - runs the existing narrow publishable-package command
     `bunx turbo run build --filter=./packages/* --output-logs=errors-only`,
     not the full root `bun run build`;
   - does not build private CLI, extension, or browser-harness apps and does not
     run `check:extension-output`;
   - stages the complete generated consumer closure, not only `dist/**`:
     publishable JS/declarations/maps, package `files` assets, PDF fonts and
     licenses, DOCX fonts, compiler vendor/WASM files, and tarballs produced by
     real prepack/pack hooks;
   - derives the closure from publishable manifests and actual pack output,
     with regression fixtures for `packages/pdf`, `packages/docx`, and
     `packages/pdf-compiler-browser`;
   - writes a manifest containing exact workflow SHA, Bun version, `bun.lock`
     digest, package names, artifact role (`workspace-overlay` or `tarball`),
     and SHA-256 for every regular artifact file;
   - uploads the closure and manifest under a unique exact-SHA/run-attempt name
     with `retention-days: 1`;
   - A/B-measures the default compression against `compression-level: 0` for
     already compressed tarball/WASM/font payloads and keeps zero compression
     only when upload plus download wall time improves in at least three
     same-SHA comparisons;
   - exposes the immutable upload's `artifact-id` and `artifact-digest`.
4. Add `scripts/ci/package-build-artifact.ts` and
   `scripts/ci/package-build-artifact.test.ts` for both artifact and
   co-located manifests.
   - Reject a different SHA, Bun version, lock digest, package list, or role.
   - Verify every listed regular file's SHA-256.
   - Reject missing/unexpected package directories, unlisted files, and missing
     JS/declaration output.
   - Reject path traversal, symlinks, sockets, devices, and other special files.
   - Verify before any generated file is imported, packed, linked, or passed to
     a package manager.
   - Artifact consumers accept only the `needs: package-build` same-run
     ID/digest; prohibit cross-run and `workflow_run` downloads.
5. For `package-colocated`, add a single-purpose reusable package-proof
   workflow or equivalent caller-level job. After the narrow filtered build and
   local manifest verification, it:
   - runs package-contract and consumer legs with GitHub `parallel`/`background`
     or a small checked subprocess coordinator;
   - gives every leg a unique temporary root, cache/profile/output paths, JUnit
     file, and raw failure log;
   - aggregates every exit code fail closed and never lets an early success
     hide a later failure;
   - keeps the known T1 retry inside the `file-link` leg only;
   - accepts worse rerun granularity only if the end-to-end wall-time win is
     measured.
6. Refactor `scripts/api-report.test.ts` and
   `scripts/dist-hygiene.test.ts` so local/default execution remains
   self-contained and builds first. CI may skip only their build phase after
   the exact verified manifest is present. Preserve every API report, closure,
   dist-path, Node-import, and publication assertion.
7. Refactor consumer orchestration into independently timed legs:
   - Bun file-link;
   - Bun tarball plus Vite/browser-shaped consumer;
   - Node/npm plus npm/pnpm install matrix.
   File-link overlays verified generated files before linking real package
   directories. Tarball/Node legs consume real pack-hook tarballs. Every leg
   must still prove installed `/dist/` resolution and package contents; build
   reuse must not become a mocked package shape.
8. In artifact mode, add
   `.github/workflows/reusable-package-contract.yml` and make package-contract
   plus consumer legs depend directly on `package-build`. They must not depend
   on complete reusable quality. In co-located mode, do not create empty
   artifact download jobs merely to mimic this DAG.
9. Replace the legacy four `--shard=N/4` jobs with the T2 winner plus one
   explicit serial `pdf-typst-proof` lane:
   - general jobs install neither Poppler nor unrelated fonts;
   - PDF/Typst installs only proved tools/fonts;
   - every job invokes the root test contract with explicit argv-safe files;
   - JUnit uploads always and raw logs only on failure.
10. Use GitHub's native step `parallel` only for independent setup work after
    checkout, for example Bun setup beside disjoint cache restores. Do not
    parallelize two cache actions that mutate the same path or run dependency
    installation before setup/cache completion. Capture a serial and parallel
    comparison over at least ten runs; retain parallel setup only when it is
    faster and stable.
11. Remove the full root build from `static-quality`; it must not sit in front
    of package consumers. Preserve complete build coverage explicitly:
    - the selected package path builds all publishable packages;
    - static/app proof builds the CLI without rebuilding all packages;
    - T7 owns browser-harness and extension builds plus their output checks;
    - T9 still runs the complete local `bun run build`.
    If a direct app build cannot consume current package output without
    rebuilding dependencies, measure that targeted duplication separately; do
    not put an unrelated private-app build into the package producer.
12. Flatten aggregation while changing the topology:
    - remove the inner `quality-complete` runner allocation;
    - expose caller-level single-purpose results to one fail-closed aggregate;
    - permit no more than one required runner job after the slowest selected
      product proof;
    - keep telemetry outside that dependency graph.
    T6 must extend this same aggregate with final live PR-state validation, not
    add another tail job.
13. Update `scripts/ci/workflow-policy.test.ts` to prove:
    - no legacy `--shard=N/4` job remains after promotion;
    - the selected T2 topology and exact worker count are fixed;
    - every planned lane/consumer leg has a unique report;
    - Poppler appears only in the PDF proof lane;
    - a package artifact consumer has a direct producer edge and exact
      same-run manifest verification;
    - no full root/private-app build blocks package consumers;
    - all publishable packages and all three apps retain an owning build gate;
    - one aggregate is the only required tail job;
    - telemetry is not an ancestor of any status job;
    - selected/unselected results remain fail closed.
14. Keep a manual `workflow_dispatch` legacy-full topology independent of the
    new planner and package path. Retain it through T5/T6 promotion and at least
    30 subsequent green merge-ready full runs. Remove it only in a separate PR
    after explicit review.
15. Update every in-repository caller according to the selected topology:
    - `ci.yml` starts build-independent static/unit/PDF proof immediately after
      classification and starts package proof at the earliest safe boundary;
    - release preflights remain self-contained unless the selected verified
      reusable package topology clearly applies; do not serialize release
      quality behind unrelated app builds;
    - `consumer-smoke.yml` keeps the selected `latest` Bun leg as a
      latest-runtime build-and-install canary.
    Workflow-policy tests must enumerate every reusable quality/package/consumer
    caller and reject missing inputs/edges or unnecessary build dependencies.
16. Do not change release publishing jobs or execute a release. Run only the
    documented release dry-run if release-preflight wiring needs end-to-end
    validation.

### Artifact safety tests

Create synthetic manifests covering:

- correct SHA, lock digest, packages, and files;
- correct per-file hashes plus the immutable upload ID/digest;
- stale SHA;
- mismatched Bun version or artifact role;
- changed lock digest;
- missing package or declaration;
- missing PDF/DOCX font, license, compiler vendor/WASM, or tarball required by a
  publishable manifest;
- extra unexpected top-level path;
- extra unmanifested file inside an otherwise valid package directory;
- modified file with a stale manifest hash;
- absolute and `../` paths;
- symlink escape and other special-file types;
- corrupt JSON.

No consumer or contract test may skip its build on any rejected manifest.

### Verification

```bash
bun run test scripts/ci/test-inventory.test.ts scripts/ci/test-lanes.test.ts scripts/ci/package-build-artifact.test.ts scripts/ci/workflow-policy.test.ts scripts/api-report.test.ts scripts/dist-hygiene.test.ts
bun run test scripts/consumer-smoke.test.ts scripts/install-matrix.test.ts
ATLCLI_CONSUMER_SMOKE=1 bun run test scripts/consumer-smoke.test.ts scripts/install-matrix.test.ts
bun run test
bun run typecheck
bun run build
```

Expected: all commands pass. In the first promoted full workflow:

- the lane coverage guard reports every current test file exactly once;
- the selected T2 topology is named and its slowest general job is no more than
  1.5 times the fastest;
- Poppler installation occurs only in its owning lane;
- the chosen package topology beats or matches the retained self-build
  baseline under its promotion constraints;
- package/consumer legs verify the exact manifest and none waits for private
  app builds or complete reusable quality;
- every publishable package and CLI/browser/extension app still has an owning
  build gate;
- exactly one required aggregate follows the final selected product proof;
- telemetry completes independently;
- `required` is green.

### Commit

`perf(ci): select the fastest verified quality topology`

## T4 — Shadow package/capability-aware change routing

### Purpose

Learn what the workflow would safely skip for real pull requests before
allowing any new route to affect the required aggregate.

### Design

Extend the classifier from four broad booleans to an explicit versioned route
object containing at least:

- `proofMode`;
- `full`;
- `affectedPackages`;
- `generalTests`;
- `packageContract`;
- `consumer`;
- `pdfTypst`;
- `macosPdf`;
- `windowsPdf`;
- `browserHarness`;
- `extensionMv3`;
- `docs`;
- `readmeMedia`;
- `reason` and `failOpenReason`.

The classifier should derive workspace ownership and transitive reverse
dependencies from every relevant dependency field in real
`apps/*/package.json` and `packages/*/package.json` manifests, including test
and development edges. Manifest edges alone are not authoritative: current
tests intentionally import across workspace boundaries in ways not fully
described by runtime dependencies. Add a static import scan for test files plus
a small, reviewed test-dependency/capability override registry for dynamic,
generated, root-script, host, and platform edges. Fail open if an import cannot
be resolved or a workspace manifest was deleted.

Do not make Bun `--changed` or Turborepo `--affected` the sole required
selector. They may be recorded as comparison signals, but root scripts,
generated contracts, host gates, and global inputs need explicit fail-open
policy.

### Minimum route policy

| Change | Candidate selected proof |
| --- | --- |
| `packages/jira/**` | Jira-owned tests plus CLI and extension reverse dependents; the current extension imports `@atlcli/jira/browser`, so relevant extension proof is not optional |
| `packages/plugin-api/**` | Package-contract proof and real reverse dependents; the package currently has no owned test file, so do not claim a nonexistent Plugin API unit gate |
| `apps/extension/**` | Extension tests and the affected packed MV3 suite |
| `apps/browser-export-harness/**` | Harness unit/build and neutral-browser E2E |
| common export/PDF packages | Package/reverse-dependent tests, PDF proof, relevant browser/host gates |
| publishable package manifest/export changes | Package contract and consumer smoke |
| CLI PDF sink/build-mode paths | Relevant Linux proof plus macOS/Windows platform gate |
| docs/spec-only paths | Existing docs/media policy; no product proof |
| root dependency/config, workflow, CI scripts, patches, vendored runtime, fonts, unknown paths | Full fail-open matrix |

Mixed changes take the union of every route. An empty or unresolvable diff runs
full.

### Changes

1. Refactor `scripts/ci/classify-changes.ts` into pure path normalization,
   workspace graph, capability mapping, and route-union functions.
2. Change the workflow diff protocol from `git diff --name-only -z` to
   `git diff --name-status -z` and parse additions, modifications, deletions,
   and both sides of renames without shell word splitting. For a deleted or
   renamed workspace manifest, load the base graph as well as the head graph;
   fail open if either side cannot be reconstructed.
3. Preserve a compact CLI that writes GitHub outputs and keep the classifier
   off dependency installation. Replace `fetch-depth: 0` with the minimum
   event-specific checkout/fetch:
   - pull request: exact base and head commits/trees;
   - `merge_group`: exact group base and head;
   - `push`: before/head when valid, otherwise fail open;
   - schedule/manual full mode: HEAD only because no diff is needed.
   Do not fetch complete history merely to reconstruct two workspace graphs.
4. Measure checkout, runtime setup, graph/import scan, GitHub API lookup, and
   output emission separately. Keep the existing pinned Bun setup while total
   classifier p95 remains at or below ten seconds. Only if it breaches that
   budget, A/B a workspace-install-free runner such as a checked,
   reproducibly generated Node-compatible JS entrypoint. Do not add generated
   classifier code and its maintenance cost for an unmeasured one-second win.
5. Add table-driven tests for every workspace/capability family, mixed changes,
   renamed/deleted files, Windows separators, empty input, workflow changes,
   unknown roots, dependency cycles, static cross-package test imports, dynamic
   override edges, and deleted manifests.
6. In shadow mode, workflows continue running the existing full selected
   product proof but display:
   - candidate gates;
   - gates that would have been skipped;
   - affected packages;
   - fail-open reason.
7. For each shadow PR, compare the candidate lane file set against the full
   inventory and package graph. Record any test failure that would have occurred
   outside the candidate set as an under-selection finding.
8. Add counterfactual route tests before collecting passive shadow evidence:
   - for every route family, mutate a synthetic workspace/capability fixture
     so one owning gate is the only failing gate;
   - assert that the candidate route necessarily selects that gate;
   - assert that removing the relevant dependency/capability edge makes the
     regression test fail.
9. Replay the changed-path sets from known historical red commits/runs:
   - PR #135 API report/closure failure
     [run 30515886454](https://github.com/BjoernSchotte/atlcli/actions/runs/30515886454)
     must select package-contract proof;
   - PR #135 corpus/API failure
     [run 30516534738](https://github.com/BjoernSchotte/atlcli/actions/runs/30516534738)
     must select the owning corpus and package gates;
   - PR #135 packed-MV3 regression
     [run 30517692670](https://github.com/BjoernSchotte/atlcli/actions/runs/30517692670)
     must select `extensionMv3` for the actual shared
     Confluence/export-path diff.
   Fetch exact paths/SHAs from the public run/PR evidence; do not encode
   abbreviated or guessed commit IDs.
10. Keep scheduled, manual, and `main` runs full regardless of candidate output.
11. Add a manual `workflow_dispatch` full run as the operator's recovery path.
12. Add workflow-policy checks that every product job still waits only for the
    classifier outputs it needs. Always-required static/package work may start
    immediately only when doing so cannot create a second status path or violate
    draft routing; optional gates remain classifier-controlled.

### Promotion gate

First pass every counterfactual and historical-red replay. Then collect at
least 20 representative product PRs or 14 calendar days, whichever provides
broader surface coverage. The observation window is drift evidence, not proof
by itself that skipped gates would catch a future regression. Evidence must
include CLI, Jira, Confluence/export, publishable-package, extension, browser
harness, PDF, workflow/global, and mixed changes.

The same observation set must show classifier p95 at or below ten seconds.
Selective routing is not promoted if graph/import precision saves jobs but adds
more than the budgeted serial startup latency.

If any under-selection is found:

1. keep shadow mode;
2. add the missing dependency/capability rule and regression fixture;
3. restart the zero-miss observation window for that capability.

### Verification

```bash
bun run test scripts/ci/classify-changes.test.ts scripts/ci/workflow-policy.test.ts
bun scripts/ci/classify-changes.ts --full
```

Expected: full output selects every gate; fixtures produce the documented
candidate routes; unknown inputs fail open; full schedule/manual mode needs
only HEAD; representative base/head fixtures avoid a full-history checkout;
classifier p95 evidence is at most ten seconds before promotion.

### Commit

`perf(ci): shadow dependency-aware gate routing`

## T5 — Promote safe selective routing

### Purpose

Turn the evidence-backed candidate routes into required-job selection while
preserving full proof for global or ambiguous changes.

### Changes

1. Promote only capability families that passed T4's observation gate.
   Unproven families remain full.
2. Update job `if` expressions and the `required` aggregate to consume each
   explicit route output.
3. Keep one stable aggregate and test both sides of every route:
   - selected plus `success` passes;
   - selected plus `skipped`, `cancelled`, or `failure` fails;
   - unselected plus `skipped` passes;
   - unselected plus `success` fails because it indicates classifier/workflow
     disagreement.
4. Make route decisions visible in job summaries, including fail-open reasons.
5. Continue full weekly/manual/main proof.
6. For the first two weeks after promotion, add a nonblocking scheduled
   comparison that exercises full inventory and reports any drift.
7. Do not reduce typecheck/build scope until test/gate routing has met its
   performance and safety targets. That can be a later measured optimization.

### Verification

Use classifier fixtures to run at least:

- docs-only;
- Jira-only;
- plugin-API-only;
- extension-only;
- browser-harness-only;
- common PDF/export;
- publishable manifest;
- lockfile/global;
- workflow;
- unknown;
- mixed docs plus product.

For each fixture, assert exact job selection and `required` behavior in
`scripts/ci/workflow-policy.test.ts`.

Expected on live PR probes:

- docs-only stays lightweight;
- narrow package PRs do not start unrelated browser/PDF/platform/consumer jobs;
- common/global changes still run full;
- no required status is missing or renamed.

### Commit

`perf(ci): run only proven affected product gates`

## T6 — Separate draft-fast feedback from merge-ready proof

### Purpose

Stop spending full-proof runner minutes on every draft synchronization while
ensuring Ready always produces a fresh, complete required result.

### Changes

1. Add an explicit `proofMode` decision:
   - draft PR: `draft-fast`;
   - ready PR: `merge-ready`;
   - main/schedule/manual: `full`.
2. Add `pull-requests: read` and make `changes` compare the event SHA/state to
   the current PR head SHA/draft state through the GitHub API. Emit
   `superseded` when an old synchronize/draft event no longer describes the
   live PR. Fail closed to merge-ready/full if current state cannot be read.
3. Include `converted_to_draft` in the PR event policy so superseded full work
   can be cancelled on a best-effort basis and replaced with the fast lane.
4. Do not add a separate `final-pr-state` runner job. Extend the one
   fail-closed aggregate retained by T3. Its display name is derived from the
   initial live-state-aware `changes` output:
   - `draft-fast` for draft evidence;
   - `superseded` for stale events;
   - `required` only for non-draft merge-ready/full proof.
   A skipped job named `required` is not acceptable because GitHub can treat a
   skipped required check as successful. If a run initially qualifies as
   merge-ready and becomes stale later, its already named `required` must fail;
   a later current run replaces it.
5. `draft-fast` runs:
   - change classification;
   - impacted general unit tests;
   - the complete existing static/typecheck gate initially;
   - docs/media gates when selected;
   - no consumer, platform, real-Typst, or packed MV3 gate unless the operator
     starts a manual full run.
   Affected static/typecheck selection requires its own future shadow and
   promotion evidence; T4/T5 test routing does not prove it.
6. `ready_for_review` always switches to `merge-ready` and selects the complete
   evidence required by T5. It must not reuse the prior draft `required`
   result.
7. Every synchronization while the PR remains non-draft runs merge-ready proof.
8. Inside the merge-ready aggregate, query the PR once more immediately before
   reporting success and require:
   - the same current head SHA;
   - `draft == false`;
   - the run's proof mode is merge-ready;
   - every selected gate succeeded.
   If state changed or cannot be read, fail the already named check. A run that
   became stale after initial classification may therefore produce a red
   `required`, but never a green one. The live race probe must prove that a
   later valid run can replace that red result.
9. Treat GitHub concurrency cancellation as a cost optimization only; GitHub
   does not guarantee run ordering inside one concurrency group. Correctness
   comes from the live-state/head guards and mode-dependent check names. Add
   fixtures for delayed old synchronize/converted events and a live race probe.
10. Document the operational sequence:
   - finish draft commits;
   - synchronize `main`;
   - mark Ready;
   - avoid toggling Ready merely to restart CI;
   - use "rerun failed jobs" only for a classified infrastructure failure.
11. Add workflow-policy fixtures for opened draft, draft synchronization,
    converted-to-draft, ready-for-review, ready synchronization, reopened ready,
    delayed/superseded events, main push, schedule, and dispatch. Assert that:
    - there is no `final-pr-state` job;
    - `quality-complete` has not reappeared;
    - the mode-named aggregate is the only required runner allocation after
      selected proof;
    - telemetry is not in its `needs` graph.

### Acceptance

- A draft push followed immediately by Ready may discard only fast-lane work,
  not a complete full run.
- Ready starts every required merge-proof gate for the current merge candidate.
- A Draft run never creates `required`; a superseded run never creates a green
  `required`; and the PR remains unmergeable from the Ready transition until
  the fresh current-head `required` run succeeds.
- Draft p50 is at most two minutes over ten representative runs.
- The required context name remains `required`.
- The tail from the slowest selected proof completion through aggregate
  completion has p95 at most 15 seconds and contains one runner job.

### Verification

```bash
bun run test scripts/ci/classify-changes.test.ts scripts/ci/workflow-policy.test.ts
```

Open a disposable Draft PR changing a synthetic test fixture:

1. confirm only draft-fast gates run;
2. synchronize `main`;
3. mark Ready;
4. confirm GitHub reports the PR unmergeable/pending until a fresh merge-ready
   run selects all appropriate gates and `required` succeeds;
5. convert back to Draft, then Ready again without a code-SHA change;
6. confirm the earlier success cannot make the PR mergeable before the new
   merge-ready proof;
7. deliver a delayed old-event fixture/probe and confirm it reports
   `superseded` when detected by final state, and never reports a successful
   stale `required`;
8. confirm the workflow graph contains no intermediate aggregate/final-state
   runner and record the proof-to-aggregate tail duration.

Do not use customer data or create remote Atlassian resources for this workflow
probe.

### Commit

`perf(ci): reserve full proof for merge-ready changes`

## T7 — Parallelize and optimize neutral-browser and packed-MV3 provisioning

### Purpose

Reduce browser setup and overlap independent neutral/MV3 proof branches without
confusing system Chrome with hermetic extension proof. This task follows the
Linux critical-path work because the current 1 minute 55 second browser job is
not the initial bottleneck, but it can become the slowest gate after T2/T3.

### Decisions

GitHub-hosted Ubuntu images currently include Google Chrome and Chromium, but
the image changes weekly. Playwright is still required as the runner/API.
Playwright's extension guidance requires bundled Chromium for side-loaded
extensions because stable Chrome/Edge removed the relevant command-line flags.

References:

- [GitHub-hosted runner images](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners#runner-images)
- [GitHub Actions parallel/background steps](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsparallel)
- [Playwright Chrome extension testing](https://playwright.dev/docs/chrome-extensions)
- [Playwright Chromium headless modes](https://playwright.dev/docs/browsers#chromium-new-headless-mode)

### Changes

1. Implement three non-required same-SHA topology candidates:
   - `browser-combined-serial`: today's shared setup and serial proof order;
   - `browser-combined-parallel`: one shared job that overlaps independent
     neutral and packed-MV3 branches with GitHub `background`/`wait`;
   - `browser-split`: separate neutral and MV3 jobs.
   Measure full workflow/browser wall time, every phase, queue delay, and summed
   runner-minutes for full/global, harness-only, and extension-only fixtures.
2. In `browser-combined-parallel`, complete shared checkout, runtime/cache
   setup, dependency install, fonts/vendor setup, and required browser
   provisioning first. Then execute two bounded branches:
   - neutral: harness build/output/conformance, neutral E2E, then shape parity;
   - MV3: one packed extension build, worker proof, then durable-job proof.
   Shape parity remains in the neutral branch because it consumes
   `test-results/digests.json`; it must not wait for or consume MV3 output.
3. Before overlapping those branches, prove they use different:
   - Playwright output/report directories;
   - persistent profile/user-data roots;
   - temporary directories and generated output roots;
   - ports/service processes;
   - JUnit/raw-log artifact names.
   Run at least ten non-required contention probes. Any shared IndexedDB,
   service worker, cache, profile, output cleanup, or fixed-port dependency
   keeps the affected branch serial until isolated.
4. Also A/B native step `parallel` for independent setup actions after checkout,
   such as Bun setup and disjoint cache restores. Do not parallelize actions
   that write the same cache/tool path, dependency installation before runtime
   setup, or browser installation with a cache restore to the same directory.
5. Promote `browser-combined-parallel` only when at least ten comparisons show:
   - identical conformance cases, digests, browser assertions, and artifacts;
   - full/global browser critical path improves by at least 15 seconds;
   - no new flake, leak, collision, or resource-exhaustion signature;
   - runner-minutes increase by no more than 10%.
   Based on PR #135, the neutral E2E payload was about 24 seconds and the MV3
   build/proof branch about 37 seconds, so useful overlap is plausible but not
   assumed.
6. Promote `browser-split` instead only if:
   - it beats both combined candidates for full/global wall time, or does not
     regress full/global wall time;
   - its runner-minute increase is at most 10%;
   - representative narrow harness/extension routes save at least 25% browser
     runner-minutes.
   Otherwise keep the faster combined topology; do not duplicate checkout, Bun
   install, fonts, browser provisioning, and caches for no measured gain.
7. If split wins, use:
   - `browser-neutral`: harness build/output/conformance/E2E followed by shape
     parity;
   - `browser-extension-mv3`: one packed extension build, worker proof, and
     durable-job proof.
   Keep both selected for full/global changes; T5 may select them independently
   for narrow changes.
8. Measure three distinct provisioning contracts rather than treating
   "Playwright" as one browser download:
   - system Google Chrome for a fast, permanently non-required neutral canary;
   - Playwright's matched headless shell for hermetic neutral harness work when
     the pinned Playwright version supports that exact project;
   - Playwright's matched full Chromium for required MV3 extension loading.
   Record browser executable/version/channel per branch.
9. Keep the required MV3 path on `channel: "chromium"` with Playwright's matched
   full Chromium and persistent contexts. Use the supported
   `install --no-shell chromium` form when that path needs full Chromium but not
   the separate headless shell.
10. Benchmark, rather than assume, Playwright browser cache value:
   - cache restore plus dependency install;
   - fresh browser install;
   - `--with-deps` versus runner-provided libraries in a nonblocking canary.
   Do not remove `--with-deps` from the required lane until ten **distinct**
   recorded GitHub runner Image Version values pass.
11. Add a permanently nonblocking neutral-harness compatibility project using
   `ATLCLI_PLAYWRIGHT_CHANNEL=chrome` and the runner's system Google Chrome.
   At the planning baseline Playwright 1.55 is matched to Chromium 140/tested
   stable Chrome 139 while the observed runner image carried Chrome 150.
   Empirical passes do not make that pairing supported. Any proposal to promote
   system Chrome requires a separate Playwright-upgrade PR/plan, full hermetic
   browser proof, and ten distinct runner-image versions. Keep MV3 on bundled
   Chromium regardless.
12. Preserve a visible Playwright, bundled Chromium/headless-shell, system
    Chrome, and runner Image Version summary.
13. Do not increase Playwright workers while packed tests share persistent
   profile, cache, service worker, or IndexedDB state.
14. Branch-level overlap is not permission to increase Playwright's per-project
    worker count. If worker parallelism is pursued later, first create
    independent profile roots and fixtures per test, prove no test depends on
    state established by an earlier test, then increase workers in a separate
    PR.
15. Upload traces only on failure; keep the existing production-build and
    artifact scans.
16. Add workflow-policy checks for the selected topology identifier, unique
    outputs/profile roots, required full Chromium on MV3, non-required system
    Chrome, and the absence of an unnecessary serial dependency between proven
    independent branches.

### Verification

```bash
bun run typecheck:browser-export-harness
bun run build:browser-export-harness
bun run check:browser-export-harness
bun run test:browser-export-harness
bun run --cwd apps/extension test:worker-extension-browser
bun run --cwd apps/extension test:jobs-extension-browser
bun run check:parity
bun run test scripts/ci/workflow-policy.test.ts
```

Expected: all hermetic gates pass on bundled Chromium. The system-Chrome canary
is reported separately and cannot satisfy or replace any required result in
this plan. Record all three topology comparisons. Promote the fastest candidate
that meets its correctness and runner-minute gates; otherwise retain the
combined serial job.

### Commit

`perf(ci): parallelize isolated browser proof`

## T8 — Prepare merge-queue support without changing repository ownership

### Purpose

Eliminate repeated manual main synchronization when daily merge volume becomes
high enough, without weakening strict compatibility proof.

### Constraint

The repository is currently public and personally owned. GitHub merge queues
for public repositories require organization ownership. Repository transfer,
organization policy, billing, and queue activation are external decisions and
are not authorized by this plan.

Reference:
[GitHub merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue).

### Code readiness before queue activation

The workflow support must land on the default branch **before** a merge queue
is enabled; otherwise GitHub cannot request the required check for the merge
group and the queue blocks indefinitely. The inactive trigger is harmless while
the repository has no queue.

1. Add `merge_group: { types: [checks_requested] }` to CI triggers while the
   repository is still personally owned.
2. Resolve comparison SHAs from:
   - `github.event.merge_group.base_sha`;
   - `github.event.merge_group.head_sha`;
   with fail-open full behavior if either is absent.
3. Run full merge-ready proof for every merge group.
4. Keep the exact stable `required` context.
5. Update workflow-policy tests for merge-group routing and aggregation.
6. Merge this code-readiness change to the default branch and prove the
   workflow still behaves identically for PR/main/manual events.
7. Only then may the operator transfer ownership and enable the queue.
8. Retain full `main` push proof until at least ten queue merges demonstrate
   that the tested merge-group SHA and landed main SHA provide equivalent
   evidence.
9. For those ten merges, record the merge-group tree SHA, landed-main tree SHA,
   workflow revision, required result, post-merge result, queue wait, and
   runner-minutes. Any tree/workflow mismatch resets the equivalence window and
   keeps full `main`.
10. Only then run a separate non-required A/B evaluation of:
    - current full post-merge product CI;
    - minimal post-merge exact-SHA evidence containing security attestation,
      docs/deployment ownership, and a lightweight product smoke while weekly,
      manual, release, and every merge group remain full.
    Reduction of `main` product CI is a runner-capacity optimization for the
    next PR, not proof for the PR that already merged.
11. Promote minimal post-merge evidence only when the queue cannot land a tree
    other than the full-proven merge-group tree, branch/ruleset enforcement
    prevents bypass, and at least ten further shadow comparisons show no
    evidence difference. Otherwise keep full `main`.
12. Security attestation, release evidence, and any deployment-specific proof
    remain exact-landed-SHA requirements regardless of product-CI reduction.

### Personal-repository fallback

If the repository stays personally owned:

- retain strict branch protection;
- synchronize `main` immediately before Ready;
- serialize final merge-ready candidates operationally;
- consider a separately reviewed merge-train bot only when manual serialization
  becomes the measured bottleneck.

Do not switch required checks from strict to loose merely to save runs.

### Verification

Before any queue activation, land and test merge-group event fixtures locally
in `scripts/ci/workflow-policy.test.ts`. Confirm the default branch contains
the inactive `checks_requested` trigger.

After activation, record ten queue workflow URLs and prove:

- each group ran full required evidence;
- superseded groups were cancelled safely;
- the merged SHA corresponds to the proven candidate;
- no PR author had to merge/rebase `main` manually;
- the tree/workflow equivalence and post-merge shadow tables are complete
  before any reduction is proposed.

### Commit

`ci: validate merge queue candidates`

This commit is conditional and must not be created before the external
repository decision.

## T9 — Document, validate, and record rollout evidence

### Documentation

Update `src/content/docs/contributing.md` with a concise CI section covering:

- draft-fast versus merge-ready proof;
- the stable `required` check;
- how affected routes fail open;
- the selected lane/worker, package-proof, and browser topology identifiers;
- why Bun worker count is fixed and why `--concurrent` is not used;
- how to run the full suite locally;
- when to synchronize `main`;
- how to start a manual full run;
- what qualifies for a targeted infrastructure retry;
- how to trigger the legacy/manual full fallback;
- how to inspect timing/selection summaries.

Create `specs/github-ci-throughput/EVIDENCE.md` during implementation. It may
contain public workflow URLs, aggregate durations, test counts, and synthetic
route fixtures only. Do not record private repository settings, tokens,
customer identifiers, or local absolute paths.

### Full automated validation

```bash
bun run test scripts/ci/classify-changes.test.ts scripts/ci/workflow-policy.test.ts scripts/ci/test-inventory.test.ts scripts/ci/test-lanes.test.ts scripts/ci/test-timings.test.ts scripts/ci/actions-timings.test.ts scripts/ci/package-build-artifact.test.ts
bun run test scripts/consumer-smoke.test.ts scripts/install-matrix.test.ts
ATLCLI_CONSUMER_SMOKE=1 bun run test scripts/consumer-smoke.test.ts scripts/install-matrix.test.ts
bun run test
bun run typecheck
bun run build
bun run docs:check
bun run docs:build
bun run test:browser-export-harness
bun run --cwd apps/extension test:worker-extension-browser
bun run --cwd apps/extension test:jobs-extension-browser
git diff --check
```

Expected: every command exits 0. Record exact pass/fail/skipped totals and
environment-independent artifact names in `EVIDENCE.md`.

### Required live/read-only E2E before implementation commits

The CI implementation does not alter Atlassian product behavior, and GitHub CI
must never receive live credentials. Repository policy still requires a
pre-commit E2E. Use the retained synthetic/private DOCSY fixture through the
local `mayflower` profile:

```bash
test -n "${ATLCLI_E2E_PAGE_ID:-}"
ATLCLI_E2E=1 \
ATLCLI_E2E_PROFILE=mayflower \
bun run test apps/cli/src/commands/export-pdf.e2e.test.ts
```

The operator must export `ATLCLI_E2E_PAGE_ID` from the private local
environment before running the block. Do not paste it into the command, spec,
evidence, shell history artifact, commit, or PR. Prefer an existing retained
fixture and a read-only export. If a task creates any page, attachment, or Jira
issue, delete it and record cleanup before committing.

If credentials or the retained fixture are unavailable, stop before claiming
the repository's E2E requirement passed. Record the limitation and obtain an
explicit operator decision; do not substitute mocked or neutral-browser proof.

### Rollout evidence

For each promoted phase record:

- baseline and candidate workflow URLs;
- exact SHA and event/proof mode;
- frozen timing-snapshot source SHA/run and content digest;
- lane, package, and browser topology identifiers;
- selected gates and fail-open reason;
- discovered/assigned test files;
- per-lane setup/test/wall duration;
- per-consumer-contract and per-browser-branch duration;
- classifier checkout/runtime/graph/import/API/output phases and p50/p95;
- artifact build/pack/compression/upload/download/verify phases;
- workflow critical path and runner-minutes;
- queue delay for every critical-path job;
- completion time of the last selected product proof, aggregate completion, and
  number of tail runner allocations;
- retries and their exact classification;
- p50/p95 window calculation;
- correctness promotion-gate result;
- decision to promote, hold, or roll back.

## Rollback strategy

| Symptom | Immediate action | Do not do |
| --- | --- | --- |
| Missing or duplicate test file | Restore full legacy topology and fail the planner check | Patch the count or ignore the file |
| Selective route misses a relevant failure | Force that capability to full, add regression fixture, restart shadow window | Leave selective routing active while investigating |
| Package artifact verification fails | Rebuild locally in the owning job or fail | Set a generic skip-build flag |
| Package artifact/producer chain is slower than self-build | Retain self-build or co-located winner and record rejection | Force fan-out to satisfy "build once" |
| Consumer exact retry fails twice | Keep the gate red and diagnose Bun/package identity | Add more retries |
| General lanes remain imbalanced | Refresh real timings and recompute | Add random shards |
| `--parallel=2` changes coverage/state or flakes | Keep sequential lane winner and add isolation evidence | Add retries or global `--concurrent` |
| Native parallel steps race on cache/output/profile state | Restore serial step/branch order | Hide the race with `continue-on-error` |
| System Chrome canary flakes | Keep it nonblocking or remove it | Replace MV3 bundled Chromium |
| Runner queue time rises from job fan-out | Reduce general lane count and keep explicit heavy lanes | Buy larger runners without measurement |
| Classifier p95 exceeds 10 seconds | Hold selective-routing promotion and optimize measured phase | Accept fixed serial latency to save speculative jobs |
| More than one runner follows final product proof | Flatten final guard into the aggregate | Add another summary/status job |
| Ready PR displays only draft proof | Disable merge until event/aggregate policy is fixed | Merge based on stale green status |
| Merge-group SHA cannot be mapped | Keep strict manual synchronization | Turn strict protection off |

Every workflow topology change must be independently revertible without
reverting product code.

## Done criteria

All applicable boxes must be satisfied before this initiative is declared
complete:

- [ ] Timing summaries expose file coverage, slow files, setup/test duration,
      critical path, and runner-minutes.
- [ ] The known Bun file-link `EEXIST` retries exactly once and every other
      error remains fail closed.
- [ ] Every package topology uses exact-SHA manifest verification; if a
      build-reuse candidate wins, it produces publishable output once for its
      consumer branches.
- [ ] Every full-run Bun test file is assigned exactly once.
- [ ] Each of `general-2x1`, `general-3x1`, and
      `general-2x2-workers` has three legacy comparisons with no coverage
      difference.
- [ ] The selected lane/worker topology is recorded with fixed worker count,
      queue/runner-minute evidence, and zero isolation findings.
- [ ] General unit lane duration ratio is at most 1.5.
- [ ] Poppler and font setup occur only in owning lanes.
- [ ] Current package self-build, narrow artifact fan-out, and co-located proof
      have same-SHA comparisons; the fastest topology satisfying every
      correctness/runner-minute gate is selected.
- [ ] Consumer contracts are independently timed and use isolated roots when
      executed concurrently.
- [ ] The full root/private-app build does not block package consumers.
- [ ] Classifier p95 is at most 10 seconds before selective routing is promoted.
- [ ] Selective routing has at least 20 PRs or 14 days of zero-miss shadow
      evidence.
- [ ] Global/unknown changes plus scheduled/manual events run full; `main`
      remains full unless T8's separately proven merge-queue equivalence and
      post-merge shadow gate explicitly select the minimal mode.
- [ ] Draft-fast and merge-ready modes are structurally and live proven.
- [ ] The required branch-protection status remains exactly `required`.
- [ ] Exactly one required runner job follows the final selected product proof,
      its tail p95 is at most 15 seconds, and telemetry is not an ancestor.
- [ ] Packed MV3 proof uses Playwright-matched Chromium.
- [ ] Serial combined, parallel combined, and split browser topologies are
      measured; any promoted overlap has unique profiles/ports/outputs and ten
      stable comparisons.
- [ ] System Chrome, if used, remains a separate compatibility signal until its
      separately planned Playwright-upgrade/compatibility promotion is approved.
- [ ] Merge-queue support is either proven after an approved organization move
      or explicitly recorded as deferred.
- [ ] Merge-ready p50 is at most 3 minutes 30 seconds and p95 at most 5 minutes
      over the required sample windows, or the initiative remains open with
      measured blockers.
- [ ] The 2 minute 30 second p50 / 4 minute p95 stretch result is reported
      honestly as met or missed; missing it does not permit weaker proof.
- [ ] Comparable product PR runner-minutes fall by at least 25%.
- [ ] Full test, typecheck, build, docs, browser, consumer, and required local
      E2E gates pass.
- [ ] `EVIDENCE.md` contains only public/synthetic, privacy-safe evidence.
- [ ] No release was performed.

## STOP conditions

Stop and report instead of improvising if:

- the live workflow/test topology no longer matches the current-state map;
- Bun's discovered test set cannot be reconciled exactly with the inventory;
- a required test depends on execution order or state from a different lane;
- Bun `--parallel=2` changes file/testcase coverage, exposes unexplained
  order/global-state dependence, or requires global `--concurrent`;
- GitHub treats an older same-SHA `required` success as mergeable after a
  Draft-to-Ready transition before the fresh run is pending; do not promote
  draft-fast in that state—retain full draft CI or require a new head SHA;
- weighted selection changes product assertions or test semantics;
- package output cannot be safely reused without weakening local self-contained
  tests;
- all package reuse candidates lengthen the complete critical path; retain the
  measured self-build winner and stop package-topology expansion rather than
  improvising a broader artifact;
- the consumer failure signature is broader or mixed with another real error;
- a route cannot be derived confidently from package/capability ownership;
- classifier p95 exceeds ten seconds during the promotion window;
- shadow mode finds any under-selection;
- the stable `required` context would need to be renamed;
- system Chrome would be required for packed MV3 extension loading;
- Playwright or GitHub runner image drift makes the canary unreliable;
- browser branch overlap shares a profile, port, cache, IndexedDB,
  service-worker, output-cleanup, or temporary-directory boundary that cannot
  be isolated within scope;
- more than one required runner allocation would remain after final product
  proof, or telemetry would become a required ancestor;
- completion requires a remote cache token, larger-runner purchase, repository
  transfer, branch-protection change, or other new external authority;
- live E2E requires committing or logging private identifiers;
- any task changes product output, public API, or release behavior.

## Maintenance notes

- Timing metadata will drift as tests are added or become heavier. Refresh it
  from successful main/scheduled evidence, review the diff, and keep unknown
  files conservatively weighted.
- Freeze one timing snapshot per comparison run. Never let reruns or candidate
  jobs rebalance from different timing data.
- Keep Bun worker count explicit. A runner image with more CPUs must not
  silently increase CI concurrency.
- A package dependency change can expand reverse-dependent tests and gates.
  Classifier tests must be updated in the same PR as new workspaces or
  capabilities.
- Workflow additions are global inputs and must default to full until
  explicitly classified.
- Do not equate green selective CI with permanent completeness. The full weekly
  drift guard is the backstop that detects selector assumptions becoming stale.
- GitHub runner images and system Chrome update independently of this
  repository. Keep the version visible and the MV3 gate hermetic.
- GitHub native `parallel`/`background` steps still share one runner filesystem
  and CPU/memory budget. Revalidate path/profile/cache ownership whenever a
  participating command changes.
- Revisit remote Turbo cache only after local build reuse and routing are
  measured. If the remaining wall time is predominantly repeated uncached
  builds, write a separate threat/cost/availability plan before adding a
  service or secret.

## Unresolved operator decisions

1. **Repository ownership for merge queue** — recommended default: defer the
   organization transfer; implement T0–T7 first and measure whether strict
   manual serialization remains a material bottleneck.
2. **System Chrome promotion** — recommended default: keep runner Chrome as a
   scheduled, nonblocking compatibility canary. Any promotion needs a separate
   Playwright upgrade plus ten distinct runner Image Version values; it is not
   completed by this plan.
3. **Remote Turbo cache** — recommended default: out of scope. Reassess only
   after the selected package topology and weighted lanes have produced at least 20
   merge-ready samples.
4. **Performance threshold adjustment** — recommended default: keep
   3 minutes 30 seconds p50 and 5 minutes p95 as hard completion gates, and add
   2 minutes 30 seconds p50 / 4 minutes p95 as stretch targets for the complete
   safe A/B rollout. Change hard gates only from measured runner availability,
   not to declare an underperforming rollout complete.
