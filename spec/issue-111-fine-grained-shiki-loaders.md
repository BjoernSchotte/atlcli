# Issue 111: fine-grained Shiki loaders

Status: implemented
Baseline: `origin/main` at `004cb29`
Measurement date: 2026-07-27
Issue: <https://github.com/BjoernSchotte/atlcli/issues/111>

## Goal

Remove the aggregate Shiki runtime catalogue edges while keeping the same public
language/theme catalogue and the existing host-specific regex engines:

- Node/Bun and the compiled CLI use Oniguruma.
- Browsers, MV3, and embedded browser hosts use the JavaScript engine.
- Runtime code loads only the effective theme and canonical languages after
  explicit highlighting or export intent.

## Implementation plan

1. Generate direct, typed language and theme loaders from the pinned Shiki
   catalogues.
2. Replace the aggregate runtime maps without changing caches, concurrency,
   retry, fallback, timing, or public registry behavior.
3. Scan package, CLI, browser-harness, and MV3 artifacts for aggregate catalogue
   code and forbidden browser WASM.
4. Exercise a one-language cold path, the existing 22-language cold/warm path,
   and cross-host DOCX/PDF parity.
5. Record the output graph, sizes, timings, and design decisions.

## Design decisions

### Loader source

The generator reads Shiki's aggregate catalogues only at build/dev time, then
emits literal imports from the pinned package exports:

- `@shikijs/langs/<canonical-language>`
- `@shikijs/themes/<theme-id>`

The generated runtime registry contains all 235 canonical language IDs and all
65 theme IDs exactly once. Public alias metadata remains in the separate
generated catalogue.

`@shikijs/langs`, `@shikijs/themes`, and `shiki` are exact direct dependencies
at `4.3.1`. Generation and `catalogue:check` fail if those installed versions,
the package manifest, a direct module resolution, or either generated file
drifts.

### Default theme

There is no dedicated default-theme fast path. The generated theme loader gives
`github-light` the same direct import behavior as every other theme, and the
cold trace shows that only the effective theme is requested.

### Bundler chunk grouping

No application-specific grouping was added. The comparable 22-language request
trace is unchanged, while the aggregate loader-map chunk and total artifacts
are smaller. A one-language request contains five JavaScript files because
Shiki's TypeScript registration has a tiny wrapper plus its grammar payload;
combining those files would not remove an aggregate request wave. Keeping the
neutral package free of WXT-, Vite-, or Forge-specific chunk policy is the
smaller and more portable result.

## Before/after evidence

The baseline and current artifacts were built from isolated source trees with
the same installed lockfile and the repository's production build commands.
Byte counts are uncompressed unless the row says ZIP.

| Artifact | Baseline | Current | Delta |
|---|---:|---:|---:|
| CLI minified bundle | 13,593,086 B | 13,581,118 B | -11,968 B |
| CLI compiled executable | 79,000,418 B | 78,983,906 B | -16,512 B |
| MV3 unpacked output | 48,238,466 B / 362 files / 337 JS or MJS | 48,226,012 B / 362 files / 337 JS or MJS | -12,454 B; graph count unchanged |
| MV3 packed ZIP | 17,041,712 B | 17,039,375 B | -2,337 B |
| Browser-harness output | 45,949,299 B / 380 files / 358 JS or MJS | 45,936,926 B / 380 files / 358 JS or MJS | -12,373 B; graph count unchanged |
| Browser `code-highlighting` implementation chunk | 61,017 B | 48,563 B | -12,454 B |

CLI startup used 40 interleaved `--version` runs per executable after ten
warm-ups per executable. This is a startup guard, not an export throughput
benchmark.

| CLI startup | Baseline | Current |
|---|---:|---:|
| Median | 102.250 ms | 101.043 ms |
| p95 | 112.559 ms | 110.351 ms |

The comparable 22-language browser preparation path remained at 53 requests:
three initialization modules, 49 grammar modules (including Shiki dependency
wrappers), and the local code font. Both builds transferred 2,599,256 B
(2,583,356 decoded B), issued zero requests on the warm repeat, and produced the
same 133,452-byte DOCX with SHA-256
`23722da1f9d09d529639122c542883025d88f3dbf39808daf912f4aaf459b278`.
Single-run cold preparation was 663.5 ms on the baseline and 743.2 ms on the
current build; that local timing is noise-sensitive and is not evidence of a
latency improvement. The request graph and byte parity are the stable
comparison.

The new one-language `typescript` / `github-light` cold trace requested only:

- Shiki core;
- the JavaScript engine;
- `github-light`;
- the TypeScript wrapper and grammar payload.

That is five requests, 362,716 transferred B (361,216 decoded B), 54.0 ms cold
in the recorded local run, 0 ms warm, and no aggregate catalogue, unrelated
grammar/theme, Oniguruma, or WASM request. Nothing from that set was requested
before explicit preparation intent.

## Verification contract

- Generated loader coverage, aliases, exact version pins, module resolution,
  caches, concurrency, retries, fallbacks, timings, and public APIs are covered
  by `@atlcli/code-highlight` tests.
- Package, CLI, browser-harness, and extension scans reject aggregate Shiki
  catalogue symbols/imports. Browser scans also reject Oniguruma and Shiki WASM.
- The CLI artifact smoke test compiles and runs a monolithic executable using
  Oniguruma.
- Browser highlighting E2E covers one-language and multi-language cold/warm
  preparation. Browser conformance cases exercise a non-default theme through
  both the direct and durable-job DOCX/PDF paths.
- Existing package consumers, extension settings, DOCX/PDF goldens, and
  browser-vs-CLI parity gates remain authoritative for cross-host fidelity.
- A read-only live E2E against one existing `mayflower` / `DOCSY` fixture page
  produced a valid DOCX archive and a tagged seven-page PDF with an outline.
  It created or changed no remote resource.

The final local gate results were 5,490 passing repository tests, 12
environment-gated skips, and zero failures; four browser Playwright E2Es; and
byte/report parity for the six browser-vs-CLI digest fixtures.

## Unresolved questions

None.
