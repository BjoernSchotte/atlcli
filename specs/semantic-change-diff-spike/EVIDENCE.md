# Semantic Change Diff Spike — Evidence

Status: **functionally proven; streaming/spill performance gates passed**  
Measured: 2026-08-10  
Decision: **keep the owned matcher; do not promote `jsondiffpatch` into runtime code**

## Contents

- [Decision](#decision)
- [Method and environment](#method-and-environment)
- [Correctness results](#correctness-results)
- [Performance results](#performance-results)
- [Determinism and browser bundle](#determinism-and-browser-bundle)
- [Cloud and Data Center evidence](#cloud-and-data-center-evidence)
- [Verification commands](#verification-commands)
- [Remaining work](#remaining-work)

## Decision

The owned `ChangeSetV1` matcher remains the product path. It passed all 12 small
correctness fixtures, is the only candidate that reports a bounded comparison
count, and mechanically proves exact-source coverage. It also preserves unknown
ADF attributes and Storage elements as opaque source changes instead of silently
discarding them.

`jsondiffpatch` 0.7.6 remains exclusively a `packages/change-set`
`devDependency` used by the bake-off. It passed 10 of 12 small correctness
fixtures, but produced changes for two policy no-ops:

- reordering semantically equivalent ADF marks;
- changing source-only stable identities.

Its generic delta also has no native equivalent of `ChangeSetV1` source
completeness or candidate-comparison diagnostics. An adapter could hide those
differences, but that adapter would itself become an owned semantic matcher and
would need the same contract and regression proof. The candidate is therefore
faster on this synthetic corpus, but not viable as a direct product contract.

Large ADF and Storage inputs use the owned streaming/spill lane. The recorded
10k/100k runtime and RSS gates are green. The retained-tree matcher remains the
small-document reference and parity oracle; it is not used for the large stress
measurements.

Machine-readable observations, including every sample and diagnostic, are in
[semantic-diff-bakeoff.json](./evidence/semantic-diff-bakeoff.json).

## Method and environment

The deterministic fixture generator creates equivalent source bytes for both
candidates. The ADF and Storage 100k cases contain exactly 100,000 source nodes
per side and one text edit. The ADF input is 8,249,889 bytes per side; Storage is
7,899,847 bytes per side. No fixture contains tenant data.

Each candidate runs in an isolated child process with a 45-second hard timeout.
Small correctness fixtures run five times, 10k fixtures three times, and 100k
fixtures twice. The owned stress worker performs one unmeasured same-size
warm-up. Every measured sample then includes bounded source parsing, private
spill creation, record writes, index construction, exact canonical-source
SHA-256, matching, ChangeSet materialization, and verified cleanup. Fixture byte
generation is recorded separately. RSS is the child's
`process.resourceUsage()` maximum minus the resident acquired-source baseline;
it therefore measures additional working-set growth of the complete diff lane.
The sandbox does not permit an external `ps` sampler, so RSS is a post-run gate.

Owned stress gates run before the intentionally memory-heavy generic candidate
workers so the comparison experiment cannot contaminate absolute RSS/time
measurements through host-level memory pressure.

Environment:

| Property | Value |
|---|---:|
| CPU | Apple M5 Max, 18 logical CPUs |
| Memory | 128 GiB |
| OS | Darwin 25.4.0, arm64 |
| Bun | 1.3.14 |
| Node-compatible runtime | Node v22.18.0 |

The external candidate is the maintained
[`jsondiffpatch` package](https://www.npmjs.com/package/jsondiffpatch), pinned to
0.7.6 for reproducibility. Its delta is translated only inside the benchmark;
no candidate type leaks into the public change-set contract.

## Correctness results

| Capability | Owned matcher | `jsondiffpatch` |
|---|---:|---:|
| Small fixtures passed | 12/12 | 10/12 |
| Approved ADF/Storage noise is a no-op | Pass | ADF mark-order case fails |
| Source-only identity change is a no-op | Pass | Fail |
| Text, mark and link-target changes | Pass | Pass |
| Stable block movement | Pass | Pass |
| Ambiguous duplicate movement | 0 false moves; ambiguity diagnostics | 0 false moves in fixture |
| Unknown ADF/Storage source changes | Preserved | Preserved in fixture |
| Exact source completeness | `true` | Not native |
| Bounded candidate comparisons | Reported | Unavailable |

For the generated stress documents, the spill matcher performs 5,002 candidate
comparisons at 10k nodes and 50,002 at 100k nodes. Both stay below the one
million comparison budget and show linear candidate growth for this corpus. The
result contains one semantic modification.

## Performance results

Targets from the plan are p95 below 250 ms at 10k nodes, p95 below 2 s at 100k
nodes, and less than 256 MiB additional peak RSS at 100k nodes.

| Candidate / fixture | p50 | p95 | Preparation | Additional peak RSS | Gate result |
|---|---:|---:|---:|---:|---|
| Owned spill ADF 10k | 181.60 ms | 183.25 ms | 2.79 ms | 92.5 MiB | Pass |
| Owned spill Storage 10k | 148.79 ms | 149.52 ms | 1.62 ms | 79.3 MiB | Pass |
| Owned spill ADF 100k | 1,827.57 ms | 1,836.19 ms | 28.87 ms | 240.1 MiB | Pass |
| Owned spill Storage 100k | 1,526.10 ms | 1,586.88 ms | 12.92 ms | 236.9 MiB | Pass |
| `jsondiffpatch` ADF 10k | 49.40 ms | 52.07 ms | 64.55 ms | 163.3 MiB | Informational pass |
| `jsondiffpatch` Storage 10k | 54.60 ms | 55.79 ms | 33.30 ms | 146.7 MiB | Informational pass |
| `jsondiffpatch` ADF 100k | 422.60 ms | 453.35 ms | 555.56 ms | 1,254.6 MiB | RSS rejection |
| `jsondiffpatch` Storage 100k | 478.09 ms | 500.30 ms | 289.80 ms | 1,051.8 MiB | RSS rejection |

The candidate's stress timing does not overturn the correctness verdict, and its
100k observations are explicitly failed with `rss-gate-exceeded-postrun`.

The retained-tree ADF 100k reference profile records the architecture boundary
that the spill lane removes:

| Phase / measurement | Result |
|---|---:|
| Preparation | 549.02 ms |
| RSS retained after preparation | 478.89 MiB |
| Baseline digest | 517.62 ms |
| Target digest | 519.34 ms |
| RSS retained after both digests | 777.50 MiB |
| Complete diff | 2,274.86 ms |
| Peak RSS | 982.59 MiB |
| Candidate comparisons | 299,998 |

The implemented correction is architectural rather than a matcher shortcut:

- ADF scans the root envelope once and parses/validates bounded top-level
  batches; both complete ADF trees are never retained together.
- Storage uses the shared XML scanner as a top-level visitor and releases each
  completed subtree instead of collecting the complete XML document.
- Source and semantic shards are written into a private mode-`0700` temp
  directory and mode-`0600` SQLite file, one exact version at a time.
- Snapshot SHA-256 consumes canonical source records incrementally. The portable
  core exposes the chunk serializer and injected digest/store ports without
  Node, Bun, filesystem, or SQLite imports.
- The matcher loads only candidate metadata and changed subtrees. Unique stable
  identities authorize moves; ambiguous/unsupported large alignment fails
  closed rather than falling back to the retained-tree path.
- The store uses an ownership nonce, deterministic paths below its private
  directory, `finally` cleanup, and signal cleanup. No raw REST body, temp path,
  page identifier, or tenant artifact enters JSON, logs, fixtures, or evidence.

Small ADF and Storage parity tests reconstruct the reference trees from spill
records. A 2,001-block ADF case and a 2,001-block Storage case produce
byte-identical ChangeSets and identical exact-source changes through both lanes.

## Determinism and browser bundle

Repeated canonical output bytes are identical. Bun and the actual
Node-compatible runtime produced the same digest:
`d9ea6b89bd7da049cf24fc96c2fd703dbd245d96dee017c4ba3908df34b8ba01`.

The isolated browser bundle measurement uses `Bun.build`, ESM, browser target,
dependency bundling, minification, no source map, and gzip level 9:

| Bundle | Minified | Gzip |
|---|---:|---:|
| Owned entry | 26,500 B | 8,292 B |
| Hypothetical promoted candidate adapter | 44,146 B | 13,520 B |
| Signed candidate delta | +17,646 B | +5,228 B |

Both builds were byte-deterministic and the candidate delta is below the 50 KiB
gzip limit. Bundle size is therefore not the rejection reason. The repository's
browser gate separately verifies both change-set entrypoints for host-only
imports and Bun globals.

## Cloud and Data Center evidence

The Cloud proof used the `mayflower` lane and `DOCSY` space with a synthetic
`atlcli-semantic-diff-live-` title prefix. Only these tenant-neutral facts are
retained here; page IDs, URLs, account data and live bodies are not committed.

- Versions 1, 2 and 3 were acquired through documented Cloud ADF / REST v2 on
  both sides; Storage sidecars were also read.
- Adjacent v2 to v3 produced two exact-subtree moves, zero same-path or false
  moves, and complete source coverage after the regression fix.
- Non-adjacent v1 to v3 produced two inserts and one delete. Text, link-target
  and insert changes were visible; ambiguity diagnostics prevented an unsafe
  move claim; source coverage was complete.
- Two semantic JSON runs exited 0 with empty stderr and byte-identical 5,565-byte
  output. SHA-256:
  `20e21f9d6e9a1edfb40407ae673764b5aca55b09bc96850ead3ccc88476ee4af`.
- The unified v1 to v3 compatibility view also succeeded.
- After the streaming implementation, the same resource was extended with
  large synthetic versions 4 and 5. The exact-version ADF pair exceeded the CLI
  spill threshold. Two live semantic JSON runs were byte-identical, complete,
  and reported one modification with zero false moves or opaque operations. The
  unified compatibility view also exited 0.
- A separate existing Cloud page was then used as a real-world readability
  probe without persisting its title, ID, URL, body, attachment IDs, or account
  data. The probe exposed repeated line-break churn and raw media-node dumps in
  the first terminal renderer. Regression fixes now align unchanged repeated
  nodes at the same position, classify private editor upload metadata as
  policy noise, propagate stable media identity to its wrapper, and render
  grouped plain-language changes without AST paths, raw JSON, collection IDs,
  or attachment UUIDs.
- The non-adjacent real-world comparison is complete and presents one named
  image, one named heading, grouped images, and grouped empty paragraphs. The
  adjacent comparison correctly remains degraded where Confluence does not
  expose enough stable media metadata; it emits one grouped review warning
  instead of guessing at image correspondence.
- Before deletion, the synthetic title, `DOCSY` space and version 5 ownership
  markers were re-read. Deletion succeeded; a subsequent read exited 1 with
  empty stdout and confirmed HTTP 404.

Data Center remains **implemented · contract-tested · not project-live-certified**.
No live DC environment was supplied, so the evidence makes no claim about live
DC endpoint behavior.

## Verification commands

```bash
bun scripts/bench/semantic-diff-bakeoff.ts
bun run test packages/change-set/src packages/confluence/src/storage-change-tree.test.ts packages/confluence/src/page-diff-source.test.ts packages/confluence/src/render-semantic-diff.test.ts packages/jira/src/change-set.test.ts apps/cli/src/semantic-diff-spill.test.ts apps/cli/src/commands/page-diff-legacy.test.ts apps/cli/src/commands/page-diff-semantic.test.ts
bun run test
bun run check:adf-pinned
bun run check:browser
bun run typecheck
bun run docs:check
bun run build
bun scripts/api-report.ts
bun scripts/api-closure.ts
```

The machine-readable `gates` object records correctness, determinism, 10k time,
100k time, and 100k RSS as `true`.

The focused semantic-diff suite passed with **119 tests, 0 failures and 538
assertions**. The full repository suite exited 0. ADF drift, all 31 browser
entrypoints, TypeScript, Astro docs, all 27 build packages, API reports and API
closure reports also passed. The focused streaming/spill coverage proves
canonical chunk parity, digest parity, browser-neutral ports, ADF/Storage shard
reconstruction, large-lane ChangeSet parity, validation-failure cleanup, and
the existing typed input budgets.

## Remaining work

The spike gates are complete. Productization beyond the spike still requires:

1. preserve `jsondiffpatch` as benchmark-only unless a separately reviewed
   adapter passes the complete owned contract;
2. add a browser IndexedDB implementation only when a browser consumer needs
   the large-document lane; the current browser-safe core defines the port;
3. preserve Cloud cleanup/privacy gates and keep DC's certification boundary
   explicit until an operator supplies a DC environment;
4. keep apply/CAS, plan signing, audit persistence, and compensation outside
   this read-only ChangeSet spike.

Related topics: [spike plan](./PLAN.md) and
[machine-readable bake-off](./evidence/semantic-diff-bakeoff.json).
