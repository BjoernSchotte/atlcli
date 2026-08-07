# Typst 0.15.1 Runtime Forward-Port

Status: **Proposed / prerequisite for PDF Template Capabilities V3**, 2026-08-07

Planning baseline: commit `2bf00066`

Directory: `specs/typst-0151-runtime-forward-port`

## Summary decision

Forward-port `typst.ts` to an exact Typst 0.15.1 compiler and contribute the
generally useful changes upstream. Do not spend this milestone comparing or
building a separate atlcli-owned WASM wrapper. `typst.ts` already supplies the
browser-facing `World`, virtual filesystem, font registration, diagnostics,
compiler lifecycle, and JavaScript/WASM binding required by the extension and
browser hosts; replacing it would duplicate the work this migration needs.

Use one production runtime. Prefer an upstream `typst.ts` release containing
the forward-port. If upstream review or release timing blocks adoption after
the technical work is proven, atlcli may temporarily consume an immutable,
reproducibly built fork commit with full source/toolchain/artifact provenance.
That fallback must retain an explicit upstream issue/PR and exit condition; it
must not become an untracked permanent fork.

An atlcli-owned wrapper prototype is an escalation decision only. Trigger a
new architecture decision instead of building it inside this plan if the
forward-port proves that `typst.ts` cannot support exact Typst 0.15.1, strict
CSP, the required compiler lifecycle, or the PDF binding without a large
unmaintainable fork.

```text
official Typst 0.15.1 crates
           │
           ▼
typst.ts World/compiler integration ─► upstream PR(s)
           │
           ▼
reproducible wasm-bindgen glue + pristine compiler WASM
           │
           ├──► preferred: released upstream artifact
           └──► temporary: immutable fork artifact with exit condition
           │
           ▼
atlcli CSP/vendor adapter ─► Node + browser + MV3 + PDF parity proof
           │
           ▼
single production runtime: Typst 0.15.1
```

## Goals

- Produce a reproducible `typst.ts` web compiler whose embedded compiler is
  exactly Typst 0.15.1, not a release candidate or a relabelled artifact.
- Keep the implementation close enough to upstream `typst.ts` to submit and
  maintain as reviewable upstream changes.
- Preserve atlcli's strict browser and MV3 CSP without `unsafe-eval`, remote
  runtime loading, or a bundled dynamic wasm-pack shim.
- Preserve the existing JavaScript compiler contract or adapt it explicitly
  with focused compile- and runtime-contract tests.
- Move atlcli to one exact 0.15.1 runtime and provide a non-destructive local
  migration path for recipe/pack ranges that exclude 0.15.1.
- Prove source, PDF semantics, browser behavior, package artifacts, memory,
  performance, and a production CLI/LIVE export before merging.

## Non-goals

- Building or benchmarking an atlcli-owned replacement for `typst.ts`.
- Shipping both Typst 0.14.2 and 0.15.1 or selecting compilers per pack.
- Adding PDF-template Catalog V3, recipe V2, canonical revision 5, or new YAML
  capabilities. Those begin only after this plan lands.
- Adding product-facing PDF-standard flags or compliance claims. This plan may
  expose/characterize a low-level compiler option only when needed to keep the
  upstream binding complete; product policy remains a later task.
- Rewriting historical pack archives, catalog digests, or canonical revision
  1-4 source bytes.
- Waiting indefinitely for an upstream release after a proven, reviewable
  forward-port exists.

## Current state and evidence

- `packages/template-pack/src/manifest.ts:50` pins
  `PINNED_TYPST_VERSION = "0.14.2"`; pack loading enforces each manifest's
  `engine.compilerRange` against that global production pin.
- `packages/pdf-compiler-browser/src/compiler.ts:3-21` imports the vendored
  direct `typst.ts` web-compiler glue and identifies the production pair as
  `typst.ts 0.7.0 / Typst 0.14.2`.
- `packages/pdf-compiler-browser/src/compiler.ts:195-264` initializes WASM from
  host-supplied bytes/URL, registers selected fonts, populates the shadow VFS,
  compiles PDF, and maps diagnostics. The adapter also serializes compiler use
  because access-model state is process-global.
- `packages/pdf-compiler-browser/src/vendor.d.ts:1-24` declares atlcli's narrow
  binding contract: runtime initialization/memory, builder/font registration,
  VFS operations, compile, diagnostics, reset, and free.
- `packages/pdf-compiler-browser/scripts/vendor-typst.ts:1-28` explains why the
  direct glue is vendored and why `wasm-pack-shim.mjs` is excluded. The shim
  contains a dynamic import implemented through `new Function`.
- `packages/pdf-compiler-browser/scripts/vendor-typst.ts:35-69` pins the wrapper
  version plus patched-glue and pristine-WASM SHA-256 values. The repository
  patches JavaScript glue, not the compiler WASM.
- Root `package.json:93-96`, workspace manifests, and `bun.lock` contain both
  the production `0.7.0` wrapper and an isolated `0.8.0-rc3` benchmark alias.
  The RC alias is not a stable Typst 0.15.1 production artifact.
- `specs/issue-118-adaptive-browser-pdf-memory/RATCHET.md` qualifies the
  existing 0.15 release-candidate lane for forward-port evaluation but does
  not authorize a production pin change.
- Upstream describes `typst.ts` as a JavaScript/browser integration providing
  a Typst `World` implementation and web compiler/renderer packages:
  <https://github.com/Myriad-Dreamin/typst.ts>.
- The exact target compiler release and language/export contract are documented
  by Typst at <https://typst.app/docs/changelog/0.15.1/>.

## Architecture contract

### Upstream-first ownership

| Layer | Owner after this plan | Responsibility |
|---|---|---|
| Typst language/compiler/PDF exporter | `typst/typst` 0.15.1 source | compilation and output semantics |
| Browser `World`, VFS, fonts, lifecycle, wasm-bindgen API | upstream `typst.ts` | reusable JavaScript/browser integration |
| CSP-safe distribution and host adapter | atlcli | exact vendoring, local assets, diagnostics mapping, cancellation, evidence |
| Template/compiler compatibility | atlcli pack registry | exact compiler range, rejection, non-destructive migration |

Changes that are generally required to run Typst 0.15.1 in `typst.ts` belong
upstream. Atlcli-specific paths, package exports, evidence hooks, compiler
locks, font-demand policy, and pack migration remain local.

### Contribution slices

Prefer small upstream PRs with independent tests:

1. update the typst.ts compiler dependency/fork to exact Typst 0.15.1 while
   retaining the existing web feature set and public API;
2. adapt changed compiler/PDF APIs and generated TypeScript declarations;
3. remove or deterministically harden dynamic-function glue at its most
   upstream-maintainable source/build boundary;
4. expose PDF export options only if this is a generic missing compiler binding,
   without adding atlcli policy or names.

Do not hold the core forward-port hostage to an unrelated output-option PR.
Record dependencies between upstream PRs and keep the atlcli consumer commit
capable of pinning the reviewed combined fork commit until releases exist.

### Temporary fork policy

A fork is acceptable only when all of these are true:

- the exact source commits and upstream base are immutable and recorded;
- the build recipe and toolchain are pinned and produce byte-identical outputs
  in two clean environments;
- every carried change has an upstream PR/issue URL or a written explanation
  why it is atlcli-only;
- atlcli pins the fork artifact by source and artifact digests, not a mutable
  branch name;
- the evidence records an exit condition: upstream release version or a dated
  re-evaluation if the contribution is rejected.

## Commands executors will need

Always run tests through the root `bun run test` script, never bare `bun test`.

| Purpose | Command | Expected on success |
|---|---|---|
| Install/apply patch | `rtk bun install` | exit 0; lockfile and patched dependency resolve |
| Vendor compiler | `rtk bun run vendor:typst` | exit 0; exact files, hashes, markers, and licences pass |
| Compiler package | `rtk bun run --cwd packages/pdf-compiler-browser build` | exit 0 |
| Focused compiler tests | `rtk bun run test packages/pdf-compiler-browser/src` | exit 0; real WASM tests pass |
| Pack migration | `rtk bun run test packages/template-pack/src/manifest.test.ts packages/pdf/src/template-pack.test.ts packages/pdf/src/template-recipe.test.ts apps/cli/src/commands/pdf-template-yaml.test.ts` | exit 0 |
| Packed-consumer gate | `rtk bun run test scripts/pack-check.test.ts` | exit 0; tarball imports and CSP scans pass |
| Browser closure | `rtk bun run check:browser` | exit 0 |
| Browser harness | `rtk bun run build:browser-export-harness && rtk bun run check:browser-export-harness && rtk bun run assert:conformance-cases && rtk bun run check:parity && rtk bun run test:browser-export-harness` | all exit 0 |
| Extension | `rtk bun run --cwd apps/extension build && rtk bun run --cwd apps/extension check:output && rtk bun run --cwd apps/extension test:worker-extension-browser:prebuilt` | all exit 0; real MV3 worker compiles PDF |
| Type safety | `rtk bun run typecheck` | exit 0 |
| Build | `rtk bun run build` | exit 0 |
| Full offline suite | `rtk bun run test` | exit 0 |
| Diff hygiene | `rtk git diff --check` | exit 0 |

Commands in the external typst.ts checkout must come from the pinned upstream
commit's own contributor/build documentation. Record the exact resolved
commands and tool versions in the provenance manifest before relying on them;
do not invent a parallel undocumented build flow in atlcli.

## Scope

### Upstream/fork checkout

In scope:

- the minimum typst.ts Rust dependency/fork, compiler integration, web binding,
  generated-declaration, build, and test files required for Typst 0.15.1;
- upstream tests proving web compiler initialization, fonts/VFS, PDF compile,
  diagnostics, lifecycle, and CSP-safe glue behavior;
- upstream contribution documentation and PR descriptions.

Out of scope:

- renderer/UI packages unrelated to compiling PDF;
- a new JavaScript API design when the existing contract can be adapted;
- an atlcli-specific template model, file layout, or product policy.

### Atlcli checkout

In scope:

- root/workspace dependency manifests, `bun.lock`, and the version-specific
  patch under `patches/`;
- `packages/pdf-compiler-browser/` adapter, vendor script, declarations,
  tests, package exports, licence/NOTICE, and artifact pins;
- runtime benchmark scripts and #118 ratchet evidence;
- compiler-range checks, built-in/curated packs, recipe-V1 migration, fixtures,
  CLI help, and migration documentation;
- browser harness, extension output checks, API reports, and relevant docs.

Out of scope:

- Catalog V3, recipe V2, revision 5, or new template-capability YAML;
- changes to the outer `wiki.pdf-template/v1` archive schema unless the
  existing render-hook contract is proven impossible;
- a second bundled compiler or automatic compiler download.

## Git and contribution workflow

- Use a dedicated typst.ts fork branch based on an immutable upstream commit.
  Do not push or open upstream PRs without operator authorization.
- Keep upstream-generic commits free of atlcli names and artifacts.
- Keep the atlcli migration on its own `codex/typst-0151-runtime-forward-port`
  branch/PR, separate from PDF Template Capabilities V3.
- Use conventional commits in atlcli, for example
  `build(pdf): migrate browser compiler to typst 0.15.1`.
- Do not merge the capability branch until the atlcli runtime PR has passed all
  gates and its production artifact provenance is final.

## Implementation tasks

### U0 — Freeze the 0.14.2 baseline and exact compatibility fixtures

**Depends on:** none.

- [ ] Record the atlcli and typst.ts upstream/fork base commits, dependency
      manifests, compiler version string, glue/WASM hashes, tool versions, and
      benchmark alias in a versioned provenance schema under this spec.
- [ ] Add neutral, immutable fixtures for catalog V1, catalog V2 standard,
      catalog V2 Type Cut/brand lockup, and one recipe-V1/revision-4 pack.
- [ ] Pin archive, manifest, canonical source, PDF, and relevant font/runtime
      hashes before changing dependencies. Keep tenant/customer material out.
- [ ] Characterize the current `tagged` versus `pdf-ua-1` byte behavior,
      diagnostics, page count, text, outline, links, language, fonts, tags, and
      selected raster regions.
- [ ] Run the three existing runtime corpora three times on baseline and store
      normalized aggregate evidence in the already ignored benchmark output;
      commit only the redacted aggregate/provenance data approved by review.

**Verify**

```bash
rtk bun run test packages/pdf-compiler-browser/src/template-migration-parity.test.ts packages/pdf-compiler-browser/src/pdf-accessibility-claims.test.ts packages/pdf/src/template-pack.test.ts
rtk bun run bench:runtime-lane --repeat 3 --candidate baseline --corpus image-heavy
rtk bun run bench:runtime-lane --repeat 3 --candidate baseline --corpus text-heavy
rtk bun run bench:runtime-lane --repeat 3 --candidate baseline --corpus mixed
```

Expected: exit 0; every fixture and baseline result is keyed by compiler/glue/
WASM digest and can detect a later semantic or performance change.

### U1 — Reproduce the upstream typst.ts candidate from source

**Depends on:** U0.

- [ ] In a disposable or dedicated typst.ts checkout, select the closest
      upstream compiler source commit. The existing npm `0.8.0-rc3` artifact
      may guide comparison but must not be renamed or treated as Typst 0.15.1.
- [ ] Inventory all Typst/Fork Git dependencies and patches used by that commit.
      Explain each difference from official Typst before changing versions.
- [ ] Pin Rust, wasm-pack/wasm-bindgen CLI, wasm-opt/Binaryen, Node, package
      manager, build flags, target, and feature set. Preserve the upstream web
      compiler feature set for the first reproduction.
- [ ] Build the unchanged candidate twice from clean checkouts/caches. Compare
      generated glue, WASM, `.d.ts`, package metadata, and licence output.
- [ ] Match the official candidate artifact's API and behavior. Byte identity
      is preferred; if upstream release production is non-reproducible, explain
      every byte difference and require the two local clean builds to match.

**Verify**: Run the exact pinned upstream build/test commands and a deterministic
hash command over glue, WASM, declarations, and package metadata.

Expected: both clean source builds produce identical recorded hashes and pass
upstream web-compiler tests. No Typst 0.15.1 code change starts before this
reproduction baseline exists.

### U2 — Forward-port typst.ts to exact Typst 0.15.1

**Depends on:** U1.

- [ ] Update the typst.ts Typst dependency/fork to exact official 0.15.1 source
      while preserving and documenting only the still-required Myriad changes.
      Port fork changes as reviewable commits; do not point at a mutable branch.
- [ ] Resolve compiler, `World`, PDF exporter, diagnostics, font, and lifecycle
      API changes without changing the public JavaScript API unnecessarily.
- [ ] Regenerate and review TypeScript declarations. Add a compile-time contract
      test covering every member atlcli uses.
- [ ] Add upstream runtime tests for initialization/memory, builder, raw-font
      registration, shadow VFS mapping/reset, PDF compile, diagnostics shape,
      loaded-font reporting, compiler reset/free/disposal, and repeated compile.
- [ ] Add a version assertion produced from the compiled core so a wrapper
      package cannot claim 0.15.1 while embedding another compiler version.
- [ ] Characterize the low-level PDF-standard option surface. Bind missing
      generic 0.15.1 options in a separate commit/PR when small and auditable;
      otherwise record them for the later atlcli output-policy task.

**Verify**: Run the pinned typst.ts build/test suite twice from clean state and
compile neutral PDFs exercising imports, fonts, assets, diagnostics, repeated
compile, and PDF option canaries.

Expected: the runtime self-identifies as Typst 0.15.1; all tests pass; repeated
clean builds are byte-identical; no atlcli-specific code exists upstream.

### U3 — Make CSP hardening upstream-maintainable

**Depends on:** U2.

- [ ] Inventory all string-to-code constructs in generated glue and loader
      files: `new Function`, direct `Function`, `eval`, and dynamic import shims.
- [ ] Trace each construct to its Rust/wasm-bindgen/build origin and enumerate
      the exact function bodies requested by the built WASM imports.
- [ ] Prefer a source- or build-level typst.ts change that emits static dispatch
      and throws on unknown bodies. Submit this as a separate upstreamable
      change with positive and negative behavior tests.
- [ ] If generated glue cannot be made CSP-safe upstream without unreasonable
      scope, create a deterministic, version-bound post-processing step in
      typst.ts. Use atlcli's narrow patch only as the final fallback, regenerated
      against the exact new glue; never apply the 0.7.0 diff mechanically.
- [ ] Keep the direct glue import and explicit WASM injection. Exclude
      `wasm-pack-shim.mjs` from package/product artifacts.

**Verify**: Scan the upstream package and an actual browser bundle; execute the
real WASM import-object behavior tests plus negative fixtures for every banned
string-to-code form under a CSP without `unsafe-eval`.

Expected: compilation succeeds in a real browser under strict CSP; unexpected
dynamic bodies throw; no banned form or shim reaches the consumed package.

### U4 — Prepare upstream contributions and the temporary-fork decision

**Depends on:** U2 and U3.

- [ ] Rebase/split changes into the contribution slices above and run upstream
      formatting, tests, licence, and generated-artifact checks.
- [ ] Write PR descriptions with exact source versions, compatibility impact,
      reproducibility steps, CSP rationale, tests, and deliberately excluded
      atlcli concerns. Do not publish until authorized.
- [ ] Record upstream PR/issue URLs once created. If a release containing all
      required work exists, select its immutable package artifact.
- [ ] Otherwise record a temporary fork decision with immutable commit,
      upstream base/PRs, artifact hashes, owner, reason, and exit condition.
      Rejection alone does not authorize an atlcli-owned wrapper; it triggers a
      maintainability review of the carried fork delta.

**Verify**: A fresh checkout following only the contribution instructions
reproduces the candidate and passes U2/U3 gates.

Expected: every generic change is ready for or attached to an upstream review;
the selected consumption source is immutable and has an explicit exit path.

### U5 — Consume the exact 0.15.1 artifact in atlcli

**Depends on:** U4.

- [ ] Update root, CLI, and compiler-package manifests, `patchedDependencies`,
      `bun.lock`, patch filename, compiler version string, generated declarations,
      vendor version, SHA-256 pins, licences, and NOTICE atomically.
- [ ] Update `vendor-typst.ts` and packed-consumer gates to validate source
      provenance plus glue/WASM/declaration hashes and reject `new Function`,
      direct `Function`, `eval`, remote runtime loading, or the excluded shim.
- [ ] Keep the public `./wasm` and `./vendor/*` package subpaths stable unless a
      separately reviewed API change is unavoidable.
- [ ] Check generated upstream types against an explicit local
      `AtlcliTypstCompilerContract`; do not let a hand-written ambient type hide
      upstream API drift.
- [ ] Retain the RC alias only for the final isolated comparison, then remove it
      or make the benchmark consume an explicit non-production artifact.

**Verify**

```bash
rtk bun install
rtk bun run vendor:typst
rtk bun run --cwd packages/pdf-compiler-browser build
rtk bun run test packages/pdf-compiler-browser/src/vendor.test.ts packages/pdf-compiler-browser/src/compiler.test.ts scripts/pack-check.test.ts
```

Expected: exit 0; installed, vendored, packed, and runtime-reported versions and
hashes all describe the same exact Typst 0.15.1 artifact.

### U6 — Cut over compiler ranges and local packs non-destructively

**Depends on:** U5 and revision 1-4 source parity on 0.15.1.

- [ ] Change the global production pin to `0.15.1` only after exact revision
      1-4 source compiles and passes semantic/visual review on the new runtime.
- [ ] Preserve all old archives, catalog digests, presentation digests,
      canonical source hashes, and compiler ranges as immutable fixtures.
- [ ] Reject old `<0.15` archives with a stable error containing detected range,
      required runtime, and the exact migration/rebuild command.
- [ ] Add a non-destructive recipe-V1 range migration that writes a distinct
      recipe-V1 output with `>=0.15.1 <0.16`, proves design/localization/asset
      equality, and builds a new catalog-V2/revision-4 pack. Never overwrite.
- [ ] If only an archive exists and lossless reconstruction is not proven,
      fail before writing and request the original recipe/design source.
- [ ] Regenerate bundled/curated current packs and examples only after the
      fixture rejection and migration tests pass. Do not widen old fixtures.

**Verify**

```bash
rtk bun run test packages/template-pack/src/manifest.test.ts packages/pdf/src/template-pack.test.ts packages/pdf/src/template-recipe.test.ts apps/cli/src/commands/pdf-template-yaml.test.ts
```

Expected: exit 0; old fixtures remain byte-exact and fail production loading
with the expected reason; migrated recipes build deterministic rev4 packs that
load and compile under exactly 0.15.1.

### U7 — Prove PDF, browser, extension, memory, and package parity

**Depends on:** U5 and U6.

- [ ] Run revision 1-4 source through diagnostics, page count, extracted text,
      links, outline, language, fonts, tags/structure tree, accessibility,
      pathological convergence, cancellation, reset/reuse, and VFS cleanup.
- [ ] Review raster-region deltas with negative controls. Never update a golden
      merely because the compiler version changed; classify each accepted delta.
- [ ] Run Node, packed consumer, browser worker, and MV3 extension against the
      exact same WASM hash. Assert source/manifest/evidence parity.
- [ ] Run image-heavy, text-heavy, and mixed lanes three isolated times for
      baseline and 0.15.1. Record raw/gzip/Brotli runtime size, compile time,
      peak RSS, and WASM high-water keyed by exact artifact digest.
- [ ] Require no unexplained semantic drift, at most 5% median WASM high-water
      or peak-RSS regression per corpus, at most 10% median compile-time
      regression, and peak-RSS run spread at or below 1.5%. Rerun wider spread.

**Verify**: Run the focused compiler/pack commands, complete browser harness,
extension build/output/worker E2E, runtime lanes, `typecheck`, `build`, full
offline suite, and `git diff --check` from the command table.

Expected: every gate exits 0; one exact compiler/WASM digest serves every host;
all differences and thresholds have a reviewed evidence record.

### U8 — Run production CLI and LIVE DOCSY acceptance

**Depends on:** U7.

- [ ] Use the public production build/export path, not a compiler-only harness.
- [ ] Build a neutral migrated recipe-V1 pack twice and compare its digest.
- [ ] Export a retained read-only or ownership-tracked disposable `DOCSY` page
      with the `mayflower` profile through the normal CLI.
- [ ] Inspect page count, text, links, outline, language, fonts, tags, selected
      raster regions, compiler identity, and output report.
- [ ] Keep credentials, tenant URL, page IDs, private content, absolute paths,
      and generated private PDFs out of committed evidence. Clean all owned
      remote/local resources in `finally` and verify zero residue.

**Live command**

```bash
rtk env ATLCLI_E2E=1 \
ATLCLI_E2E_PAGE_ID=<retained-or-owned-DOCSY-page> \
ATLCLI_E2E_PROFILE=mayflower \
bun run test apps/cli/src/commands/export-pdf.e2e.test.ts
```

Expected: exit 0; the public export reports Typst 0.15.1 and the pinned artifact
digest, semantic/raster checks pass, and cleanup reports zero owned residue.

### U9 — Finalize adoption evidence and merge order

**Depends on:** U8 and a selected upstream-release or temporary-fork source.

- [ ] Update the #118 runtime ratchet with exact source/toolchain/artifact
      provenance, benchmark aggregates, semantic/visual verdict, CSP result,
      upstream contribution state, and temporary-fork exit condition if used.
- [ ] Add a redacted evidence manifest under this spec containing only public
      source versions/commits/PRs, digests, tool versions, gate results,
      benchmark aggregates, and cleanup outcome.
- [ ] Run the complete command table once on the final candidate commit.
- [ ] Commit the coherent atlcli migration and stop. Do not push, open a PR,
      publish upstream changes, or release unless explicitly authorized.
- [ ] Only after this runtime PR merges may
      `specs/pdf-template-capabilities-v3/PLAN.md` begin T1.

Expected: a reviewer can reproduce the compiler artifact, connect every local
delta to upstream or atlcli ownership, verify all gates, and identify the exact
future event that removes any temporary fork.

## Test matrix

| Layer | Required evidence |
|---|---|
| Source provenance | immutable Typst/typst.ts commits, patches, features, licences, toolchain, two clean identical builds |
| Upstream contract | `World`, fonts, VFS, diagnostics, lifecycle, generated declarations, runtime version assertion |
| CSP | no `unsafe-eval`; no string-to-code form or shim in package/browser/extension; real WASM behavior tests |
| Atlcli adapter | exact version/hash agreement, serialized lifecycle, cancellation, reset/free, demand-aware fonts |
| Pack migration | immutable old fixtures, stable rejection, non-destructive V1 range migration, deterministic rev4 rebuild |
| PDF semantics | pages, text, links, outline, language, fonts, tags, accessibility, convergence, reviewed raster deltas |
| Hosts | Node, packed consumer, browser worker, MV3 extension use the same artifact digest |
| Performance | image/text/mixed compile time, peak RSS, WASM high-water, artifact sizes within ratchets |
| LIVE | public CLI, mayflower/DOCSY, redacted evidence, ownership-safe cleanup |
| Upstreamability | small contribution slices, test evidence, PR/issue state, temporary-fork exit condition |

## Definition of done

- [ ] The production compiler self-identifies as exact Typst 0.15.1 and is
      reproducible from immutable source/toolchain inputs.
- [ ] Generic forward-port and CSP changes are submitted upstream or ready for
      authorized submission as reviewable slices.
- [ ] Any temporary fork is commit-pinned, reproducible, fully attributed, and
      has an explicit upstream-linked exit condition.
- [ ] No atlcli-owned replacement wrapper or dual runtime was introduced.
- [ ] Glue, WASM, declarations, packages, browser bundle, and extension bundle
      pass CSP/provenance/hash gates; the WASM remains upstream-derived and
      unmodified unless a separately approved necessity is documented.
- [ ] Old archive fixtures remain byte-exact; old ranges fail clearly; migrated
      recipe-V1 sources build deterministic 0.15.1-compatible rev4 packs.
- [ ] PDF semantic, visual, lifecycle, memory, performance, browser, extension,
      package-consumer, typecheck, build, and full offline tests pass.
- [ ] The public CLI and LIVE DOCSY proof pass with redacted evidence and
      verified cleanup.
- [ ] The final atlcli migration is committed separately before Capability V3
      implementation begins; nothing is pushed or released automatically.

## STOP conditions

Stop and report instead of improvising if:

- exact Typst 0.15.1 source or the typst.ts dependency/fork delta cannot be
  pinned and explained;
- two clean builds do not reproduce artifact hashes and the variance cannot be
  eliminated or fully attributed;
- the forward-port requires a large permanent divergence from typst.ts that is
  neither upstreamable nor bounded by a credible temporary-fork exit condition;
- strict CSP requires `unsafe-eval`, generic dynamic execution, remote runtime
  loading, or shipping `wasm-pack-shim.mjs`;
- compiler API/global-state changes cannot preserve serialized, resettable,
  cancellation-safe operation;
- revision 1-4 source cannot compile under 0.15.1 without changing immutable
  source bytes. Decide a new canonical revision/migration architecture first;
- old pack compatibility would require silently widening historical ranges or
  rewriting archives;
- any page/text/link/outline/language/font/tag/accessibility drift remains
  unexplained, pathological layout does not converge, or performance exceeds
  the ratchets after a valid rerun;
- the task starts implementing an atlcli-owned wrapper comparison. That is a
  new architecture decision requiring its own evidence and authorization;
- upstream publication, external push, release, or destructive migration would
  occur without explicit operator authorization;
- a required verification fails twice after a reasonable scoped correction.

## Maintenance and review notes

- Review the typst.ts fork delta and CSP mechanism before reviewing generated
  hashes; reproducible bad architecture is still bad architecture.
- Keep upstream-generic fixes upstream-shaped. Do not solve an atlcli packaging
  concern by adding atlcli concepts to typst.ts.
- Treat every future compiler bump as a rendering migration: re-run source,
  semantic, visual, browser, package, memory, and LIVE gates.
- Never update the local glue patch by context alone. Re-inventory generated
  imports and behavior for each wrapper/compiler/toolchain version.
- If upstream later releases the carried changes, replace the temporary fork in
  a dedicated dependency-only PR and prove artifact/API parity again.

## Unresolved questions

These are implementation-time discoveries, not reasons to build an alternative
wrapper in parallel:

1. Is a stable typst.ts release with exact Typst 0.15.1 available before U1?
   **Recommendation:** consume it only after reproducing and proving it; otherwise
   continue with the upstream-first fork branch.
2. Can the dynamic-function glue be removed at source/build level upstream?
   **Recommendation:** prefer that; retain the narrow atlcli patch only when an
   upstream-maintainable solution is not feasible within this migration.
3. Will upstream accept the core bump, CSP hardening, and PDF binding together?
   **Recommendation:** prepare separate slices so review/release timing of one
   does not block the proven core forward-port.
