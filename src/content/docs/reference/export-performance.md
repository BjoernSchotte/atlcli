---
title: "Export Performance Envelope"
description: "Measured wall-clock and peak-RSS envelope for large exports, reported separately for the engine tier and the end-to-end tier"
---

# Export Performance Envelope

What a large export actually costs, measured — not estimated. The numbers below come from
two benchmark tiers that are **reported separately on purpose**, because they answer
different questions and conflating them would overstate what has been verified.

This page is the reference for capacity planning and the precondition for any future
chapter-streaming work: you cannot argue that streaming is needed without a measured
baseline to compare against.

## On this page

- [The two tiers](#the-two-tiers)
- [How the numbers are measured](#how-the-numbers-are-measured)
- [Measured envelope: engine tier](#measured-envelope-engine-tier)
- [Measured envelope: end-to-end tier](#measured-envelope-end-to-end-tier)
- [Browser code-highlighting trace](#browser-code-highlighting-trace)
- [Browser host-versus-WASM attribution](#browser-host-versus-wasm-attribution)
- [What the numbers mean](#what-the-numbers-mean)
- [Reproducing a measurement](#reproducing-a-measurement)
- [Trend tracking in CI](#trend-tracking-in-ci)
- [Troubleshooting](#troubleshooting)
- [Related topics](#related-topics)

## The two tiers

| | Engine tier | End-to-end tier |
|---|---|---|
| Script | `scripts/bench/run-bench.ts` | `scripts/bench/run-e2e-bench.ts` |
| Input | Pre-parsed `ExportBlock[]` | Confluence **storage XHTML** |
| **Exercises** | `composeChapters`, DOCX serialize + zip, PDF serialize + real Typst WASM compile, image embedding | everything in the engine tier **plus** the tree walk (`fetchExportTree`), per-page `storageToBlocks`, and the full `MacroRendererRegistry` resolver pass (live Jira renderer, draw.io renderer, `scroll-*` macros) |
| **Does NOT exercise** | storage parsing, macro resolution, tree traversal, asset fetch over the network | real HTTP (auth, pagination, rate limits, retry), real attachment downloads, a browser host (heap limits, module-worker transfer cost) |

:::caution[Do not quote an engine-tier number as an export time]
The engine tier starts from blocks that are already parsed. Reporting its total as
"atlcli exports a 500-page tree in X seconds" is a category error — it skips the traversal,
the parse, and the resolver entirely. Quote the end-to-end tier for that claim, and state
that the network is excluded.
:::

The full 500-page Chromium-hosted variant (browser heap and module-worker transfer cost) is
**out of scope** for both tiers today. A focused browser-harness trace does cover code
highlighting module requests and cold/warm initialization; do not present that narrower
measurement as the full export envelope.

## How the numbers are measured

### Wall clock

Each phase is timed in-process around the phase work only. Setup (fixture generation, wasm
and font loading, template loading) sits outside every reported `ms`. Reported values are
the **median of 3 runs**, each in a fresh process.

The end-to-end tier additionally reports **cold** and **warm**: the same work run twice
inside one process.

:::danger[The warm column is not throughput — do not quote it as an export time]
Warm runs the **byte-identical** input a second time, so it is dominated by Typst's
incremental compilation cache hitting almost completely. It also does *not* mean "cold
minus setup": wasm and font loading already sit outside every measured `ms`, in both
columns. Read warm as *"how much of the cold number is one-time work that a second run of
the very same document can skip"* — nothing more. Exporting a genuinely different document
will not be the warm number. See [What the numbers mean](#what-the-numbers-mean).
:::

### Peak RSS

`/usr/bin/time` reports the peak resident set size of **one whole process**. There is no
way to ask it for "the peak RSS of phase 2", and an in-process `process.memoryUsage()`
sample is not a substitute — it measures the heap at an instant, is contaminated by the
previous phase's uncollected garbage, and misses the wasm linear memory the Typst compiler
owns.

So the runners do this instead:

- **`wholeProcessPeakRssBytes`** — one child process runs *every* phase; its peak is the
  run-level number.
- **`peakRssBytes` per phase** — each phase also runs in its **own** child process, so its
  peak is still a whole-process number, phase-scoped only because the process was.

A per-phase number therefore **includes** the runtime baseline, the fixture, and (for the
PDF phase) the wasm and font bytes. The `baseline` phase — load everything, do no work —
is measured so that floor is visible rather than guessed at. No number on this page is
derived from in-process heap sampling.

:::caution[`baseline` is the PDF phase's floor, not every phase's]
The `baseline` child loads the Typst wasm and the font set, because the PDF phase needs
them. The `compose` and `docx` phases do not, so their floor is **lower** — which is why
the tables below show `baseline` (183 MB) *above* `compose` (152 MB). Subtracting
`baseline` from `compose` is meaningless and would produce a negative number. Use it as
the floor under `pdf`; for the lighter phases, their own peak is already close to their
floor, since the work they do is small.
:::

`/usr/bin/time` comes in two incompatible flavours: GNU (`-v`, kbytes) on Linux/CI and BSD
(`-l`, bytes) on macOS. Every record carries which one produced it as `rssMethod`, and the
trend comparison refuses to compare across them.

## Measured envelope: engine tier

**Fixture:** 500 pages, 3,590 blocks, seed `0x9e3779b9` — per page ~3 headings, prose, one
list; every 10th page a 200-row table; every 25th page a code block and an embedded PNG.

**Machine:** Apple M5 Max (18 cores), macOS `darwin 25.4.0` arm64, Bun 1.3.8,
`typst.ts 0.7.0 / Typst 0.14.2`, RSS via `bsd-time-l`. Median of 3.

| Phase | Wall clock | Peak RSS (whole process) | Output |
|---|---:|---:|---:|
| `baseline` (load only, no work) | — | 183 MB | — |
| `compose` | 9 ms | 152 MB | 5.0 MB (block JSON) |
| `docx` (serialize + zip) | 222 ms | 336 MB | 523 KB |
| `pdf` (serialize + Typst compile) | 7,952 ms | 3,035 MB | 16.2 MB |
| **whole run** (all phases, one process) | **8,142 ms** | **3,114 MB** | — |

## Measured envelope: end-to-end tier

**Fixture:** the same 500 pages generated as storage XHTML, yielding 4,779 composed blocks.
Adds `scroll-title`/`scroll-pagebreak` macros (every 8th page), a resolvable Jira JQL macro
(every 12th), and a draw.io macro that settles on the placeholder floor (every 20th).

**Machine:** identical to above. Median of 3.

Read the **Cold** column as the export cost. **Warm†** is a cache-hit repeat of identical
input, not throughput — see the warning under [Wall clock](#wall-clock).

| Phase | Cold | Warm† | Peak RSS (whole process) | Output |
|---|---:|---:|---:|---:|
| `baseline` (load only, no work) | — | — | 187 MB | — |
| `fetch` (tree walk + `storageToBlocks`) | 33 ms | 26 ms | 197 MB | 5.1 MB |
| `resolve` (macro registry pass) | 6 ms | 3 ms | 200 MB | 5.1 MB |
| `compose` | 13 ms | 7 ms | 221 MB | 5.1 MB |
| `docx` (serialize + zip) | 236 ms | 126 ms | 441 MB | 546 KB |
| `pdf` (serialize + Typst compile) | 7,677 ms | 577 ms | 3,351 MB | 17.1 MB |
| **whole run** (all phases, one process) | **8,127 ms** | — | **3,400 MB** | — |

† **Warm re-runs byte-identical input**, so Typst's incremental cache absorbs most of the
work. It is a lower bound on one-time setup cost, never a steady-state export time.

## Browser code-highlighting trace

The browser export harness records Shiki's active request path separately from the large
export envelope. A fresh Chromium context first proves that no core, RegExp engine, theme,
grammar, or code-font resource is requested before explicit preparation/export intent. A
one-language `typescript` / `github-light` preparation then records request names, transfer
and decoded bytes, and cold/warm initialization time. The warm repeat must issue no new
JavaScript request.

The generated registry contains a literal loader for every supported canonical language
and theme, but one selected loader is not necessarily one HTTP request: Shiki registrations
can reference another grammar and a bundler can factor a small wrapper or shared runtime
chunk. The Chromium trace therefore asserts the complete selected request set and rejects
unrelated language/theme or aggregate catalogue chunks instead of assuming a universal
chunk count.

```bash
bun run build:browser-export-harness
bun run --cwd apps/browser-export-harness test:e2e --grep "one-language preparation"
```

The run writes `apps/browser-export-harness/test-results/highlight-performance/one-language-cold.json`.
The broader 22-language case in the same suite proves concurrent grammar/core/engine/theme
loading, cold/warm DOCX byte parity, and deterministic repeat output.

## Browser host-versus-WASM attribution

The Chrome/V8 memory harness splits the PDF compiler worker's footprint per
phase into **Typst WASM linear memory** versus **host bytes** (V8 heap plus
backing storage outside the WASM instance). This is the Phase 0 gate input of
`specs/issue-118-adaptive-browser-pdf-memory/PLAN.md`: host-side transport
work can only ever reduce the host share, so the split decides whether that
work is justified.

```bash
bun run bench:memory-chrome
```

The report's `workerAttribution` section carries the split. Measured on the
deterministic 8.33 MiB mixed fixture (6 chapters, two 1200 x 1200 PNGs,
8.30 MiB PDF), Chromium `140.0.7339.16` / V8 `14.0.365.1`, reproduced
byte-identically across two consecutive runs:

| Phase | WASM linear (MiB) | Host outside WASM (MiB) | Total (MiB) | WASM share |
|---|---|---|---|---|
| warm | 15.56 | 33.67 | 49.23 | 31.6% |
| bundle-received | 15.56 | 42.04 | 57.59 | 27.0% |
| vfs-ready | 32.31 | 42.05 | 74.36 | 43.5% |
| **compiled-held (peak)** | **87.31** | **50.62** | **137.93** | **63.3%** |
| complete | 87.31 | 33.98 | 121.29 | 72.0% |

How to read this:

- The WASM linear memory is read through a benchmark-only `Symbol.for` hook
  that `BrowserPdfCompiler` invokes during initialization; production hosts
  never install it. Linear memory only grows, so the post-compile value is the
  high-water mark, and the harness asserts monotonic growth.
- Whether CDP `backingStorageSize` includes the WASM memory is **detected**
  from the samples and reported as `basis` (`backing-includes-wasm` on this
  runtime), never assumed — a runtime change alters the report instead of
  silently double-counting.
- At the peak phase, **63.3% of the worker footprint is inside the WASM
  instance** and out of reach of host-side descriptor/lease transport. The
  36.7% host share on this small mixed fixture clears the plan's 25% working
  threshold, but the gate decision requires the image-heavy corpus, which this
  fixture is not. Do not quote these shares as the gate verdict.

The attribution math is pure and unit-tested
(`apps/extension/tests/pdf/memory/attribution.ts`); the harness README
documents the probe protocol.

## What the numbers mean

**PDF compilation is the entire cost.** It is ~94% of wall clock in both tiers. Optimising
anything else — the parser, the resolver, compose — cannot move the total meaningfully at
this scale. Work aimed at export speed should target the Typst compile or the document
size handed to it.

**The parsing/resolver gap is real but small — at this fixture.** The three phases the
engine tier cannot see (`fetch`, `resolve`, `compose`) total ~52 ms of ~8.1 s: well under
1%. That is an empirical result for *this* corpus, not a licence to assume the engine tier
is always a good proxy. It notably does **not** hold for memory — the end-to-end tier peaks
~9% higher (3,400 MB vs 3,114 MB) because the parsed tree is resident alongside the
compile — and it says nothing about a real tenant, where network latency and attachment
downloads dominate everything measured here.

**Peak RSS exceeds the planning placeholder.** Spec 011's provisional budget was
"500-page PDF compile < 2 GB RSS". The measured figure is **3.0–3.4 GB**. The placeholder
was a guess made before measurement; this page is the measurement. Any absolute budget
frozen into `scripts/bench/budgets.json` must start from these numbers, and a
memory-constrained host (a browser tab, a small CI runner, a container with a 2 GB limit)
should be assumed to fail a 500-page PDF export until proven otherwise.

**The warm PDF number is a lower bound, not a second-export cost.** Cold 7,677 ms vs warm
577 ms is a ~13× gap, most of which is Typst's incremental compilation cache hitting on
*byte-identical* input. Exporting a genuinely different document will not be 577 ms. Read
the warm column as "how much of the cold number is one-time setup", not as "steady-state
throughput".

## Reproducing a measurement

```bash
# Engine tier: 500 pages, median of 3 runs per phase
bun run bench:engine -- --pages 500 --repeat 3

# End-to-end tier
bun run bench:e2e -- --pages 500 --repeat 3
```

Records land in `scripts/bench/out/bench-engine.json` and `bench-e2e.json` (both
gitignored). Each record carries the fixture digest, the Typst wasm digest, the font-set
digest, OS/arch/runner, Bun version, and `rssMethod`, so a number is always attributable to
an environment.

Useful flags:

| Flag | Default | Meaning |
|---|---|---|
| `--pages <n>` | `500` | Fixture size |
| `--seed <n>` | `0x9e3779b9` | PRNG seed; same seed → byte-identical fixture |
| `--repeat <n>` | `1` | Runs per phase; the median is reported |
| `--phase <name>` | — | Run one phase in *this* process (used internally by the parent) |
| `--out <path>` | `scripts/bench/out/…` | Where to write the record |

A quick smoke run:

```bash
bun run bench:engine -- --pages 30 --repeat 1
```

## Trend tracking in CI

`.github/workflows/bench.yml` runs both tiers nightly (and on manual dispatch). It is
`continue-on-error: true` and **never** runs per PR — CI wall clock is too noisy to gate
merges on, and a gate people re-run until it passes is not a gate.

The workflow restores the previous records via `actions/cache`, compares each phase against
the **rolling median** of comparable prior records, and emits a GitHub `::warning::` when
wall clock regresses **>20%** or peak RSS **>15%**.

"Comparable" is strict: same tier, page count, fixture digest, Typst wasm digest, font-set
digest, OS, arch, runner, and `rssMethod`. A deliberate compiler or font bump therefore
resets the baseline instead of firing a false alarm — and a warning names the phase, the
tier, and the machine, so a regression localizes rather than showing up as an unexplained
total.

The `runner` field identifies a runner **class**, never an instance. In CI it is built from
`RUNNER_ENVIRONMENT`, `RUNNER_OS` and `RUNNER_ARCH` (e.g. `ci:github-hosted:Linux:X64`);
locally it is the hostname. This matters more than it looks: GitHub-hosted runners set
`RUNNER_NAME` to a per-instance value (`GitHub Actions 2`, `GitHub Actions 14`, …) that
changes between runs, so keying on it would make every nightly non-comparable with every
other nightly — the trend would report "no comparable history yet" forever and never warn,
silently, behind `continue-on-error: true`. Set `ATLCLI_BENCH_RUNNER` to declare your own
class label on a self-hosted bench rig.

Absolute budgets stay unfrozen until roughly two weeks of trend data exist. Only then
should `scripts/bench/budgets.json` be written and the workflow flipped to failing.

## Troubleshooting

**Peak RSS is `null` in the record.**
Neither `/usr/bin/time -v` (GNU) nor `/usr/bin/time -l` (BSD) was available. The runners
report `rssMethod: "unavailable"` and record `null` rather than inventing a number. Timing
is unaffected. On Debian/Ubuntu, install `time` (the shell builtin is not enough).

**A phase child fails with "Cannot find module '@atlcli/…'".**
Phase children need in-repo workspace resolution. Run through `bun run bench:engine` /
`bench:e2e`, which pass `--conditions=development`; invoking `bun scripts/bench/run-bench.ts`
directly without that flag resolves the packages' unbuilt `dist` barrels.

**Numbers swing between runs on a laptop.**
Thermal throttling and background load both move wall clock by tens of percent. Raise
`--repeat`, and treat cross-machine comparisons as invalid — that is exactly what the
environment fingerprint on each record exists to prevent.

**The nightly warns after a Typst or font bump.**
It should not: a changed `compilerWasmDigest` or `fontSetDigest` makes prior records
non-comparable, so the trend restarts. If a warning does appear across such a bump, the
digest was not recorded — check the `environment` block of the record.

**The nightly always says "no comparable history yet".**
Every run is being treated as a new environment. Compare the `environment` blocks of two
consecutive records and find the field that moved — most likely `runner`, if something
reintroduced an instance-specific value there (see above), or `datasetDigest`, if the
fixture generator stopped being deterministic.

## Related topics

- [PDF Export Engine](/reference/pdf-engine/) — the compile path these numbers measure
- [DOCX Export Engine](/reference/docx-engine/) — the serialize + zip path
- [Export Asset Contract](/reference/asset-contract/) — how wasm and fonts are loaded
- [Public Export API (v1)](/reference/export-api/) — the seams the benchmarks drive
