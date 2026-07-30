# GitHub CI throughput and merge-ready latency

- Status: proposed
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
3. avoid rebuilding the same publishable packages in isolated jobs;
4. give draft pull requests fast feedback and reserve full proof for
   merge-ready commits;
5. run only impact-relevant gates after the selector has proved that it fails
   open safely;
6. keep a full scheduled drift guard and a manual full-run escape hatch;
7. retain Playwright and a Playwright-matched Chromium for packed MV3 tests;
8. keep the stable `required` status name used by branch protection.

This plan changes CI and test orchestration only. It does not change product
behavior.

## Executive decision

Implement the work in evidence-gated stages:

1. add timing and selection observability without skipping any existing gate;
2. eliminate the known Bun file-link flake and duplicate package builds;
3. replace the four file-count shards with deterministic duration-aware lanes;
4. shadow a package/dependency-aware change selector before allowing it to
   skip work;
5. split draft feedback from merge-ready proof;
6. optimize browser provisioning after the Linux test critical path has moved;
7. prepare, but do not activate, GitHub merge-queue support until the
   repository ownership requirement is resolved.

Do **not** begin with more shards, larger runners, remote Turbo cache, removing
Playwright, disabling strict branch protection, or broad test retries. Those
changes either fail to address the measured bottleneck, add unproven external
state, or weaken the evidence contract.

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
| Browser job | 1 min 55 s |
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
| `.github/workflows/reusable-quality.yml` | Static quality, four Bun shards, security attestation | Four shards repeat install, Poppler, and font setup |
| `.github/workflows/reusable-consumer-smoke.yml` | Pinned and latest external-consumer matrix | Rebuilds packages and has no bounded known-flake recovery |
| `.github/workflows/security-attestation.yml` | Exact-SHA attestation on every main push | Installs the full workspace although `attest.ts` imports only Bun/Node built-ins |
| `scripts/ci/classify-changes.ts` | Conservative path classifier | One broad `code` bit covers all `apps/`, `packages/`, and product scripts |
| `scripts/ci/classify-changes.test.ts` | Classifier regression tests | Unknown and workflow paths deliberately fail open |
| `scripts/ci/workflow-policy.test.ts` | Structural CI contract | Protects the stable aggregate and fail-closed skip behavior |
| `package.json` | Root test/typecheck/build commands | Root `test` is not a Turbo task and discovers the whole repository |
| `turbo.json` | Build/typecheck caching and dependencies | No test task exists |
| `scripts/api-report.test.ts` | Builds packages and validates public API reports/closures | Build runs inside a general Bun shard |
| `scripts/dist-hygiene.test.ts` | Builds packages and validates emitted artifacts | Performs a second isolated package build |
| `scripts/consumer-smoke-filelink.ts` | Creates a throwaway `file:` consumer | One un-retried `bun install` can fail with the known Bun `EEXIST` signature |
| `apps/browser-export-harness/playwright.config.ts` | Neutral ordinary-browser contract | Supports `chrome` or `chromium`, currently one worker |
| `apps/extension/tests/jobs/packed/job-recovery.e2e.ts` | Packed MV3 durable-job behavior | Requires persistent extension context and `channel: "chromium"` |

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
- Strict up-to-date protection remains enabled unless a separately approved
  merge-queue migration replaces the manual update workflow.

### Consumer and publication

- Local consumer tests remain self-contained: without a verified CI build
  manifest they build packages exactly as today.
- CI may reuse a package artifact only when its manifest matches the exact
  workflow SHA, lockfile digest, package list, and expected `dist` files.
- A missing, stale, incomplete, or mismatched build manifest must trigger a
  rebuild or fail; it must never make publication tests vacuous.
- The Bun `EEXIST` retry is limited to the exact known file-link signature,
  recreates the throwaway consumer, and runs at most once.
- No other package-manager, build, resolution, or smoke failure is retried.

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
- suppressing the full weekly drift guard.

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
   PR-state validity, and fail-open overrides.
2. A caller-level `package-build` job, or a single-purpose reusable workflow
   called directly by `ci.yml`, builds publishable outputs once and emits an
   exact-SHA artifact manifest.
3. `static-quality` performs offline contract checks and typecheck in parallel
   with the build.
4. `package-contract` and `consumer-smoke` depend directly on the caller-level
   build job and consume its same-run artifact in parallel. Neither waits for
   the complete reusable-quality workflow.
5. `unit-tests` runs two deterministic, duration-balanced lanes without
   Poppler.
6. `pdf-typst-proof` runs real Typst/PDF tests with only their required fonts
   and Poppler tools.
7. macOS PDF, Windows sink, neutral browser, and packed MV3 gates are selected
   by affected capabilities or by full-run policy.
8. The aggregate job uses a mode-dependent name: `draft-fast` for draft
   feedback, `superseded` for stale events, and the stable `required` name only
   for merge-ready/full evidence.

Two general-purpose unit lanes are the starting point, not an immutable count.
The measured payload remaining after package-contract and real-Typst work is
removed is expected to be about 269 seconds, or about 135 seconds per balanced
lane. This preserves current job-count pressure while moving the outliers into
explicit lanes. Increase the lane count only if post-change measurements prove
that runner availability, rather than job fan-out, is not the limiting factor.

## Performance and safety acceptance gates

Evaluate performance only on successful, non-cancelled, merge-ready product
runs. Keep correctness gates independent from performance gates.

### Promotion gates

| Gate | Required evidence |
| --- | --- |
| Weighted-lane completeness | Three consecutive scheduled/manual comparisons with identical discovered file sets, zero duplicates, and zero missing test cases |
| Weighted-lane balance | Slowest general unit lane no more than 1.5 times the fastest general unit lane |
| Selective routing | At least 20 representative product PRs or 14 calendar days in shadow mode, zero under-selection findings |
| Consumer retry | Synthetic signature tests pass; exact known failure retries once; every adjacent/nonmatching failure does not retry |
| System Chrome canary | Nonblocking only in this plan; record ten distinct runner Image Version values, and require a separate Playwright-upgrade/compatibility plan before any promotion |
| Merge queue | Repository is organization-owned, queue is enabled, `merge_group` full proof is green for at least ten merges |

### Outcome targets

| Metric | Target |
| --- | ---: |
| Merge-ready p50 wall time over at least 10 product PRs | at most 3 min 30 s |
| Merge-ready p95 wall time over at least 20 product PRs | at most 5 min |
| Slowest required Linux test lane p95 | at most 2 min 45 s |
| Draft-fast p50 wall time | at most 2 min |
| Runner-minute reduction for comparable product PRs | at least 25% |
| Classified infrastructure false failures over 30 merge-ready runs | zero |
| Selective-routing misses | zero |
| Test files omitted or duplicated in a full run | zero |
| Typical targeted product jobs after routing promotion | at most 6 |

If the correctness promotion gates pass but the performance target does not,
stop and measure job setup, runner queue time, and artifact transfer separately.
Do not add shards or caches based only on intuition.

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
- `.github/workflows/security-attestation.yml`
- `.github/workflows/consumer-smoke.yml`
- `.github/workflows/release-core.yml`
- `.github/workflows/release-cli.yml`
- `.github/workflows/release.yml`, limited to wiring the existing preflight to
  the shared package-build producer
- a new reusable browser or package-build workflow only if the final topology
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
| T2 | Build a fail-closed test inventory and duration-aware lane planner | T0 |
| T3 | Reuse one package build and promote weighted full-test lanes | T1, T2 |
| T4 | Shadow package/capability-aware change routing | T0 |
| T5 | Promote safe selective routing | T3, T4 |
| T6 | Separate draft-fast feedback from merge-ready proof | T5 |
| T7 | Optimize neutral-browser and packed-MV3 provisioning | T3, T5 |
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
4. Add a workflow summary job or step that downloads same-run JUnit artifacts,
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
5. Upload JUnit XML on every run. Upload full raw test logs only on failure;
   timing evidence must not depend on retaining successful console logs.
6. Do not automatically commit timings from a PR. A scheduled/manual main run
   may emit a candidate timing artifact for explicit review.
7. Bootstrap the first checked timing snapshot from the final PR #135 artifacts
   if still available. If they have expired, run one complete baseline and use
   that result. Do not fabricate missing durations.
8. Remove the `bun install --frozen-lockfile` step from
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
- the summary lists 405 test files at the planning baseline, subject only to
  legitimate test additions after that baseline;
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

## T2 — Build a fail-closed test inventory and duration-aware lane planner

### Purpose

Replace Bun's file-count shard selection with deterministic longest-processing-
time assignment based on measured test-file duration.

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
   - no test outcome or private data.
4. Add `scripts/ci/test-lanes.ts`:
   - assign every inventory file to exactly one lane, defaulting a new
     unannotated file to `general`;
   - assign `package-contract` and `pdf-typst` files to their explicit lanes;
   - assign remaining files to two general lanes with deterministic
     longest-processing-time bin packing;
   - give a newly discovered file without timing the larger of the historical
     p95 duration and a conservative fixed default;
   - reject duplicate, stale, conflicting, or invalid metadata;
   - emit a compact JSON matrix and human-readable explanation;
   - expose the validated file arrays to an argv-safe runner; never
     shell-evaluate a path.
5. Add `scripts/ci/run-test-lane.ts`. It must:
   - load one already validated lane by identifier;
   - spawn `bun run test -- ./repo-relative-file...` with an argv array, never a
     constructed shell string or command substitution;
   - preserve the root `development` condition and JUnit reporter arguments;
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
   - exact union and pairwise-disjoint lane sets.
7. Add a coverage assertion that compares inventory with the union of planned
   lanes before tests start. The assertion must fail before a zero-test lane can
   be accepted.
8. On scheduled/manual runs only, run the legacy four shards and candidate lanes
   side by side until the promotion gate is satisfied. Compare file identities
   and JUnit test cases, not only totals.

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

Search actual imports and subprocess calls before finalizing the list. Do not
infer setup needs from filenames alone. A file may have one lane and multiple
requirements, for example lane `pdf-typst` with both `fonts` and `poppler`.

### Verification

```bash
bun run test scripts/ci/test-inventory.test.ts scripts/ci/test-lanes.test.ts scripts/ci/test-timings.test.ts
bun scripts/ci/test-lanes.ts --check
```

Expected:

- every discovered test file is assigned exactly once;
- no stale metadata remains;
- two general lanes have an estimated duration ratio at or below 1.5;
- explicit package and Typst lanes contain their known heavy tests.

Run three scheduled/manual legacy-versus-candidate comparisons. Record workflow
URLs and exact coverage comparison in
`specs/github-ci-throughput/EVIDENCE.md`.

### Commit

`perf(ci): plan tests by measured duration`

## T3 — Reuse one package build and promote weighted full-test lanes

### Purpose

Remove repeated package builds and repeated PDF tool setup from general unit
workers, then make the duration-aware lanes the required full proof.

### Changes

1. Add `.github/workflows/reusable-package-build.yml` as the single-purpose
   build producer. `ci.yml` calls it as a top-level `package-build` job directly
   after `changes`. Build-independent reusable quality starts after `changes`
   in parallel; only package-contract and consumer jobs declare
   `needs: [changes, package-build]`. The producer:
   - installs pinned dependencies;
   - restores the existing Bun and Turbo caches;
   - owns the workflow's single full `bun run build` invocation;
   - runs build-dependent output checks such as
     `bun run check:extension-output`;
   - stages the complete generated consumer closure, not only `dist/**`:
     publishable JS/declarations/maps, package `files` assets, PDF fonts and
     licenses, DOCX fonts, compiler vendor/WASM files, and the tarballs produced
     by real prepack/pack hooks;
   - derives that closure from the publishable package manifests and actual
     pack output, with explicit regression fixtures for
     `packages/pdf`, `packages/docx`, and
     `packages/pdf-compiler-browser`;
   - writes a manifest containing exact workflow SHA, Bun version, `bun.lock`
     digest, package names, artifact role (`workspace-overlay` or `tarball`),
     and a SHA-256 for every regular artifact file;
   - uploads the closed closure plus the manifest under an exact-SHA artifact
     name;
   - exposes the immutable v4 upload's `artifact-id` and `artifact-digest` as
     caller outputs.
2. Add `scripts/ci/package-build-artifact.ts` and
   `scripts/ci/package-build-artifact.test.ts`.
   - Reject a different SHA or lock digest.
   - Verify every listed regular file's SHA-256.
   - Reject missing/unexpected package directories, files not listed in the
     closed manifest, and missing JS/declaration output.
   - Reject path traversal, symlinks, sockets, devices, and other special files.
   - Verify before any artifact file is imported, packed, linked, or passed to
     `bun install`.
   - Accept artifacts only by the `needs: package-build` same-run ID/digest;
     prohibit cross-run and `workflow_run` downloads.
3. Refactor `scripts/api-report.test.ts` and
   `scripts/dist-hygiene.test.ts` so:
   - local/default execution still builds packages first;
   - the `package-contract` CI job may skip only the build step after the
     verified artifact is present;
   - all API report, closure, dist-path, Node-import, and publication
     assertions remain unchanged.
4. Apply the same verified-prebuilt contract to consumer helpers. Do not
   recognize a bare boolean such as `CI=1` as proof; require the manifest.
   `ci.yml` must make reusable package-contract and reusable consumer calls
   depend directly on `package-build` and pass the artifact ID/digest. The
   build-independent quality caller must not depend on package-build. Do not
   express this as `consumer-smoke needs: test`, which would serialize the
   consumer behind the complete reusable quality workflow.
   - File-link tests overlay the verified generated package files onto their
     checkout before linking the real package directories.
   - Tarball/Node tests consume the verified tarballs produced by the real pack
     hooks.
   - Consumer assertions still prove installed `/dist/` resolution and package
     contents; reuse must not turn packaging into a mocked shape.
5. Add `.github/workflows/reusable-package-contract.yml` to consume and verify
   the build artifact before running API reports, closure, dist hygiene, and
   package assertions. Replace the four `--shard=N/4` jobs in
   `.github/workflows/reusable-quality.yml` with:
   - two general unit lanes;
   - one `pdf-typst-proof` lane.
   Package-contract is a separate caller-level reusable job so it can wait for
   the build without delaying static, unit, or PDF lanes.
6. General lanes:
   - do not install Poppler;
   - do not provision fonts unless their exact file list requires them;
   - invoke the root test contract with explicit file arguments;
   - upload JUnit XML always and raw logs on failure.
7. The PDF/Typst lane installs only its proved OS tools and fonts.
8. The package-contract reusable workflow downloads/verifies the build artifact
   before running its explicit files.
9. Consumer smoke downloads/verifies the same exact-run artifact instead of
   rebuilding it.
10. Remove the full build from `static-quality`; otherwise the new build owner
    would still duplicate publishable builds on another runner. Keep its
    non-build static/type checks parallel with package build, unit, and PDF
    lanes whenever there is no artifact dependency.
11. Update `scripts/ci/workflow-policy.test.ts` to prove:
    - there are no legacy `--shard=N/4` required jobs after promotion;
    - the selected full topology contains exactly one `bun run build` owner;
    - each planned lane has a unique report;
    - Poppler appears only in the PDF proof lane;
    - package/consumer jobs depend directly on the caller-level build and
      require same-run manifest verification;
    - aggregates remain fail closed.
12. Keep a manual `workflow_dispatch` legacy-full topology that is independent
    of the new planner and artifact path. Retain it through T5/T6 promotion and
    at least 30 subsequent green merge-ready full runs. Remove it only in a
    separate PR after its rollback value is explicitly reviewed.
13. Update every in-repository caller atomically:
    - `ci.yml` starts build-independent reusable quality beside the pinned
      package build, then passes build outputs only to reusable
      package-contract and pinned consumer smoke;
    - `release-core.yml`, `release-cli.yml`, and `release.yml` start
      build-independent quality beside the pinned producer and make their
      package-contract/preflight aggregate depend on both;
    - `consumer-smoke.yml` adds a producer using the selected `latest` Bun leg
      so the floating canary remains a latest-runtime build and install test.
    Add workflow-policy tests that enumerate every `uses:
    ./.github/workflows/reusable-quality.yml` and
    `uses: ./.github/workflows/reusable-package-contract.yml` or
    `uses: ./.github/workflows/reusable-consumer-smoke.yml` caller. Fail if a
    package-contract/consumer caller lacks its build inputs/`needs` edge, or if
    build-independent quality incorrectly waits for package-build.
14. Do not change release publishing jobs or execute a release. Run only the
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
bun run test
bun run typecheck
bun run build
```

Expected: all commands pass. In the first promoted full workflow:

- the lane coverage guard reports every current test file exactly once;
- the slowest general lane is no more than 1.5 times the fastest;
- Poppler installation occurs only in its owning lane;
- package build executes once;
- the consumer and package-contract jobs verify and reuse that artifact;
- `required` is green.

### Commit

`perf(ci): reuse package builds across balanced lanes`

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
3. Preserve a compact CLI that writes GitHub outputs.
4. Add table-driven tests for every workspace/capability family, mixed changes,
   renamed/deleted files, Windows separators, empty input, workflow changes,
   unknown roots, dependency cycles, static cross-package test imports, dynamic
   override edges, and deleted manifests.
5. In shadow mode, workflows continue running the existing full selected
   product proof but display:
   - candidate gates;
   - gates that would have been skipped;
   - affected packages;
   - fail-open reason.
6. For each shadow PR, compare the candidate lane file set against the full
   inventory and package graph. Record any test failure that would have occurred
   outside the candidate set as an under-selection finding.
7. Add counterfactual route tests before collecting passive shadow evidence:
   - for every route family, mutate a synthetic workspace/capability fixture
     so one owning gate is the only failing gate;
   - assert that the candidate route necessarily selects that gate;
   - assert that removing the relevant dependency/capability edge makes the
     regression test fail.
8. Replay the changed-path sets from known historical red commits/runs:
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
9. Keep scheduled, manual, and `main` runs full regardless of candidate output.
10. Add a manual `workflow_dispatch` full run as the operator's recovery path.

### Promotion gate

First pass every counterfactual and historical-red replay. Then collect at
least 20 representative product PRs or 14 calendar days, whichever provides
broader surface coverage. The observation window is drift evidence, not proof
by itself that skipped gates would catch a future regression. Evidence must
include CLI, Jira, Confluence/export, publishable-package, extension, browser
harness, PDF, workflow/global, and mixed changes.

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
candidate routes; unknown inputs fail open.

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
4. Add a `final-pr-state` job after selected proof gates and immediately before
   the aggregate. It re-reads current head/draft state and exposes the final
   display mode. Use one always-running aggregate with a name derived from this
   final-state output:
   - `draft-fast` for draft evidence;
   - `superseded` for stale events;
   - `required` only for non-draft merge-ready/full proof.
   A skipped job named `required` is not acceptable because GitHub can treat a
   skipped required check as successful.
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
   became stale in the narrow interval after `final-pr-state` may therefore
   produce a red `required`, but never a green one. The live race probe must
   prove that a later valid run can replace that red result.
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
   delayed/superseded events, main push, schedule, and dispatch.

### Acceptance

- A draft push followed immediately by Ready may discard only fast-lane work,
  not a complete full run.
- Ready starts every required merge-proof gate for the current merge candidate.
- A Draft run never creates `required`; a superseded run never creates a green
  `required`; and the PR remains unmergeable from the Ready transition until
  the fresh current-head `required` run succeeds.
- Draft p50 is at most two minutes over ten representative runs.
- The required context name remains `required`.

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
   stale `required`.

Do not use customer data or create remote Atlassian resources for this workflow
probe.

### Commit

`perf(ci): reserve full proof for merge-ready changes`

## T7 — Optimize neutral-browser and packed-MV3 provisioning

### Purpose

Reduce browser setup and allow neutral and extension-specific contracts to run
independently without confusing system Chrome with hermetic extension proof.
This task follows the Linux critical-path work because the current 1 minute
55 second browser job is not the bottleneck.

### Decisions

GitHub-hosted Ubuntu images currently include Google Chrome and Chromium, but
the image changes weekly. Playwright is still required as the runner/API.
Playwright's extension guidance requires bundled Chromium for side-loaded
extensions because stable Chrome/Edge removed the relevant command-line flags.

References:

- [GitHub-hosted runner images](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners#runner-images)
- [Playwright Chrome extension testing](https://playwright.dev/docs/chrome-extensions)
- [Playwright Chromium headless modes](https://playwright.dev/docs/browsers#chromium-new-headless-mode)

### Changes

1. First implement a non-required same-SHA A/B experiment:
   - A keeps the current combined browser job;
   - B separates neutral and MV3 setup.
   Measure workflow wall time, each setup/test phase, and summed runner-minutes
   for full/global, harness-only, and extension-only route fixtures.
2. Promote the split only if all hold over at least ten comparisons:
   - full/global browser critical path does not regress;
   - full/global browser runner-minutes increase by no more than 10%;
   - representative narrow harness/extension routes save at least 25% browser
     runner-minutes.
   Otherwise keep one job and use step-level route selection; do not duplicate
   checkout, Bun install, fonts, browser provisioning, and caches for no
   measured gain.
3. If the split passes, use:
   - `browser-neutral`: harness build/output/conformance/E2E followed by shape
     parity, because `check:parity` consumes the harness-produced
     `test-results/digests.json`;
   - `browser-extension-mv3`: one packed extension build, worker proof, and
     durable-job proof.
   Do not place shape parity in the MV3 job or run it without the neutral digest
   artifact.
4. Keep both jobs selected for full/global changes. T5 may select them
   independently for narrow changes.
5. Keep the required MV3 job on `channel: "chromium"` with Playwright's matched
   full Chromium and persistent contexts.
6. Use Playwright's supported `install --no-shell chromium` form when the job
   needs the full browser for extension loading and does not need the separate
   headless shell.
7. Benchmark, rather than assume, Playwright browser cache value:
   - cache restore plus dependency install;
   - fresh browser install;
   - `--with-deps` versus runner-provided libraries in a nonblocking canary.
   Do not remove `--with-deps` from the required lane until ten **distinct**
   recorded GitHub runner Image Version values pass.
8. Add a permanently nonblocking neutral-harness compatibility project using
   `ATLCLI_PLAYWRIGHT_CHANNEL=chrome` and the runner's system Google Chrome.
   At the planning baseline Playwright 1.55 is matched to Chromium 140/tested
   stable Chrome 139 while the observed runner image carried Chrome 150.
   Empirical passes do not make that pairing supported. Any proposal to promote
   system Chrome requires a separate Playwright-upgrade PR/plan, full hermetic
   browser proof, and ten distinct runner-image versions. Keep MV3 on bundled
   Chromium regardless.
9. Preserve a visible Playwright, bundled Chromium, system Chrome, and runner
   Image Version summary.
10. Do not increase Playwright workers while packed tests share persistent
   profile, cache, service worker, or IndexedDB state.
11. If parallelism is pursued later, first create independent profile roots and
   fixtures per test, prove no test depends on state established by an earlier
   test, then increase workers in a separate PR.
12. Upload traces only on failure; keep the existing production-build and
    artifact scans.

### Verification

```bash
bun run typecheck:browser-export-harness
bun run build:browser-export-harness
bun run check:browser-export-harness
bun run test:browser-export-harness
bun run --cwd apps/extension test:worker-extension-browser
bun run --cwd apps/extension test:jobs-extension-browser
bun run check:parity
```

Expected: all hermetic gates pass on bundled Chromium. The system-Chrome canary
is reported separately and cannot satisfy or replace any required result in
this plan. If the split does not meet its A/B gate, the combined job remains.

### Commit

`perf(ci): separate neutral and MV3 browser proof`

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
9. Only then evaluate whether redundant post-merge product jobs can be reduced.
   Security attestation and release evidence remain exact-SHA requirements.

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
- no PR author had to merge/rebase `main` manually.

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
- how to run the full suite locally;
- when to synchronize `main`;
- how to start a manual full run;
- what qualifies for a targeted infrastructure retry;
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
- selected gates and fail-open reason;
- discovered/assigned test files;
- per-lane setup/test/wall duration;
- workflow critical path and runner-minutes;
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
| Consumer exact retry fails twice | Keep the gate red and diagnose Bun/package identity | Add more retries |
| General lanes remain imbalanced | Refresh real timings and recompute | Add random shards |
| System Chrome canary flakes | Keep it nonblocking or remove it | Replace MV3 bundled Chromium |
| Runner queue time rises from job fan-out | Reduce general lane count and keep explicit heavy lanes | Buy larger runners without measurement |
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
- [ ] Package build output is produced once and consumed only after exact-SHA
      manifest verification.
- [ ] Every full-run Bun test file is assigned exactly once.
- [ ] Three legacy-versus-weighted comparisons show no coverage difference.
- [ ] General unit lane duration ratio is at most 1.5.
- [ ] Poppler and font setup occur only in owning lanes.
- [ ] Selective routing has at least 20 PRs or 14 days of zero-miss shadow
      evidence.
- [ ] Global, unknown, scheduled, manual, and main events run full.
- [ ] Draft-fast and merge-ready modes are structurally and live proven.
- [ ] The required branch-protection status remains exactly `required`.
- [ ] Packed MV3 proof uses Playwright-matched Chromium.
- [ ] System Chrome, if used, remains a separate compatibility signal until its
      separately planned Playwright-upgrade/compatibility promotion is approved.
- [ ] Merge-queue support is either proven after an approved organization move
      or explicitly recorded as deferred.
- [ ] Merge-ready p50 is at most 3 minutes 30 seconds and p95 at most 5 minutes
      over the required sample windows, or the initiative remains open with
      measured blockers.
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
- GitHub treats an older same-SHA `required` success as mergeable after a
  Draft-to-Ready transition before the fresh run is pending; do not promote
  draft-fast in that state—retain full draft CI or require a new head SHA;
- weighted selection changes product assertions or test semantics;
- package output cannot be safely reused without weakening local self-contained
  tests;
- the consumer failure signature is broader or mixed with another real error;
- a route cannot be derived confidently from package/capability ownership;
- shadow mode finds any under-selection;
- the stable `required` context would need to be renamed;
- system Chrome would be required for packed MV3 extension loading;
- Playwright or GitHub runner image drift makes the canary unreliable;
- completion requires a remote cache token, larger-runner purchase, repository
  transfer, branch-protection change, or other new external authority;
- live E2E requires committing or logging private identifiers;
- any task changes product output, public API, or release behavior.

## Maintenance notes

- Timing metadata will drift as tests are added or become heavier. Refresh it
  from successful main/scheduled evidence, review the diff, and keep unknown
  files conservatively weighted.
- A package dependency change can expand reverse-dependent tests and gates.
  Classifier tests must be updated in the same PR as new workspaces or
  capabilities.
- Workflow additions are global inputs and must default to full until
  explicitly classified.
- Do not equate green selective CI with permanent completeness. The full weekly
  drift guard is the backstop that detects selector assumptions becoming stale.
- GitHub runner images and system Chrome update independently of this
  repository. Keep the version visible and the MV3 gate hermetic.
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
   after single-build reuse and weighted lanes have produced at least 20
   merge-ready samples.
4. **Performance threshold adjustment** — recommended default: keep the
   proposed 3 minute 30 second p50 and 5 minute p95. Change them only from
   measured runner availability, not to declare an underperforming rollout
   complete.
