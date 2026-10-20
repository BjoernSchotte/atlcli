# TypeScript 7 Migration

Status: **Planned**, 2026-10-20

Planning baseline: commit `b0bc2218`

Directory: `specs/typescript-7-migration`

## Summary decision

Move atlcli's type-checking and package declaration emit from TypeScript 5.9.3
to the stable TypeScript 7 native compiler (`typescript@7.0.2`, the Go port).
Keep a TypeScript 6 compiler API installed next to it for the tools that import
`typescript` programmatically. Microsoft documents this side-by-side layout for
7.0, because 7.0 ships no programmatic API:

```json
{
  "devDependencies": {
    "@typescript/native": "npm:typescript@^7.0.2",
    "typescript": "npm:@typescript/typescript6@^6.0.2"
  }
}
```

- `tsc` (from `@typescript/native`) is TypeScript 7. It runs every
  `typecheck`, `typecheck:root` and `tsc -p tsconfig.build.json` script
  unchanged.
- `import ts from "typescript"` resolves to the TypeScript 6 API. Our
  API-based guards (`scripts/api-report.ts`, `scripts/api-closure.ts`,
  `scripts/check-browser-build.ts`,
  `apps/extension/tests/docx/phase1-sync-guard.ts`) and the Volar-based
  `@astrojs/check` keep working without a rewrite.

The migration is deliberately small. The probe below shows that atlcli
already type-checks cleanly under TypeScript 7 once three narrow
incompatibilities are fixed. This is a dependency and config migration, not a
source migration.

The Rust port [tsrs](https://blog.cloudflare.com/typescript-rust-port) is
**out of scope** as the production compiler. It tracks TypeScript 7
semantics, so this migration is also its prerequisite. Today it is
experimental (`0.18.0-ts7.1.0-dev`) and still diverges from `tsc` on this
repository (see evidence). Adopting it is a follow-up decision once it is
stable.

```text
TypeScript 5.9.3 (tsc + JS API)
          │
          ├─ tsc ───────► @typescript/native = typescript@7.0.2  (typecheck + build emit)
          │
          └─ JS API ────► typescript = @typescript/typescript6    (api-report/closure,
                                                                   browser-build guard,
                                                                   phase1 guard, astro check)
          │
          ▼  later, separate decision
     tsrs as an optional non-blocking typecheck lane → drop-in once stable
```

## Goals

- `bun run typecheck`, `bun run build`, `bun run test`, `bun run docs:check`
  and every CI job pass with TypeScript 7 as the only `tsc`.
- Published `dist/` output (`.js`, `.d.ts`) is unchanged or every difference
  is reviewed and explained. API reports (`packages/*/etc/*.api.md`) stay
  byte-identical, or their regeneration diff is reviewed.
- API-consuming guards keep their current behavior on the TypeScript 6 API.
  Their mutation and sabotage tests still fail when they should.
- Record cold typecheck and build timings before and after as adoption
  evidence.
- Contributor docs say which compiler runs where, and how to switch the
  editor to the TypeScript 7 language server.

## Non-goals

- Making tsrs the production compiler, or adding it to CI as a blocking gate.
- Porting the API-based scripts to the unstable TypeScript 7 API
  (`typescript/unstable/*`). Revisit when 7.1 ships a stable API.
- Adopting new TS 7 features (`--isolatedDeclarations`, `--builders`,
  `--checkers` tuning, project references). Each is a separate optimization
  with its own evidence.
- Tightening compiler options beyond what TS 7 forces.
- Changing bundlers: `apps/cli/build.ts` (Bun), WXT/Vite and Astro do not use
  `tsc` to emit, so they are unaffected.

## Current state and evidence

Probed on 2026-10-20 in a fresh worktree at `b0bc2218` after a clean
`bun install` (hoisted linker, `bunfig.toml`).

> **Gotcha:** a stale `node_modules` (missing workspace symlinks such as
> `apps/cli/node_modules/@atlcli/import-core`) made **both** tsc 5.9 and
> TS 7 report about 1,850 bogus resolution errors. Always probe on a fresh
> install.

### Compiler usage inventory

| Consumer | Where | TS 7 impact |
|---|---|---|
| Root typecheck | `package.json` `typecheck:root` = `bunx tsc --noEmit` | uses the TS 7 `tsc` bin |
| Package builds | 30 × `tsc -p tsconfig.build.json` (`.js` + `.d.ts` + maps) | TS 7 emit |
| Workspace typechecks | `apps/extension` (`wxt prepare && tsc --noEmit`), `apps/browser-export-harness` (3 configs), `packages/pdf-compiler-browser` | TS 7 |
| Compiler API | `scripts/api-report.ts`, `scripts/api-closure.ts` (`createProgram`, `TypeChecker`, printer), `scripts/check-browser-build.ts`, `apps/extension/tests/docx/phase1-sync-guard.ts` (parser/AST) | **no API in TS 7** → TS 6 alias |
| Third-party peers | `@astrojs/check@0.9.9` (peer `typescript ^5 \|\| ^6`, via `@volar/kit`), `wxt@0.21.4` (optional `>=5.4`), `i18next` (optional) | must resolve `typescript` to 6 |
| Pinned versions | root `typescript ^5.9.3`, `apps/browser-export-harness` `typescript 5.9.3`, root `bun-types ^1.3.5` (locked 1.3.5) | align |
| tsconfigs | 79 files; 74 extend root; `moduleResolution: Bundler`, `module: ESNext`, `target: ES2022`, `strict: true`; no `baseUrl`, `downlevelIteration`, `node10`, `esModuleInterop:false`; every emitting config sets `rootDir` | no removed options hit |

### Probe results

| Check | Compiler | Result |
|---|---|---|
| `typecheck:root` | tsc 5.9.3 | 0 errors, 14.4 s wall |
| `typecheck:root` | TS 7 (`tsgo` 7.0.0-dev / `typescript@7.0.2`) | 51 errors, all inside `bun-types@1.3.5` (`ffi.d.ts` duplicate identifiers, `wasm.d.ts` vs. `lib.dom` WebAssembly descriptors); about 1.5 s wall |
| `typecheck:root` + `bun-types@1.4.3` | tsc 5.9.3 **and** TS 7 | identical 4 errors: `apps/cli/src/commands/export-source-contract.test.ts:284,461,644,889`. `proc.signalCode` is now `number \| Signals \| null` (a Bun API typing change, not a TS 7 change) |
| `apps/extension` | tsc 5.9.3 | 0 errors |
| `apps/extension` | TS 7 | 341 errors (`Cannot find name 'chrome'` and follow-up implicit-any errors). TS 7 changed the default to `types: []`, so `@types/chrome` is no longer auto-included |
| `apps/extension` + `"types": ["chrome"]` | tsc 5.9.3 **and** TS 7 | 0 errors |
| `packages/pdf-compiler-browser`, `apps/browser-export-harness` (all 3 configs) | TS 7 | 0 errors |
| `packages/core` emit (97 files) | tsc 5.9.3 vs. `typescript@7.0.2` | every `.js` and `.d.ts` byte-identical. 18 `.map` files differ (`mappings`, and `sources` computed relative to the probe's out-of-tree `outDir`); re-check in place |
| `typecheck:root` + `bun-types@1.4.3` | tsrs 0.18.0 | the same 4 Bun errors **plus 2 tsrs-only** errors: `TS5115` infinite instantiation in `zod/v4/classic/schemas.d.cts:804`, `TS7031` implicit any in `packages/export-wiring/src/jobs/pdf-job-executor.test.ts:1468`. Not yet a drop-in |

The timings are single warm runs, so they are indicative only. T5 records
proper evidence.

### TypeScript 7 changes that matter here

Source: [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/?p=5246).

- No programmatic API in 7.0. The JS API returns in 7.1 in a different shape.
  Volar-based tools (Astro) stay on 6.
- `types` defaults to `[]`. This affects only configs that relied on
  automatic `@types/*` inclusion: `apps/extension` (via `.wxt/tsconfig.json`).
  The other two configs without `types` inherit it from the root.
- `rootDir` defaults to `./`. No emitting config is affected (all set
  `rootDir`).
- `noUncheckedSideEffectImports` is now `true` and `stableTypeOrdering` is
  forced on. Neither changed any diagnostic in the probe, but
  `stableTypeOrdering` can change `.d.ts` union order. The `dist/` parity
  gate covers this.
- Removed options (`baseUrl`, `node10`, `es5`, `downlevelIteration`,
  `esModuleInterop:false`, and others) are unused here.

## Architecture contract

- **One `tsc`.** After migration, `node_modules/.bin/tsc` is TypeScript 7
  everywhere, including `apps/browser-export-harness`. No script may call a
  TypeScript 5 or 6 `tsc`. `tsc6` exists only as the compat package's bin
  and is not wired into any script.
- **One API.** Every `import ... from "typescript"` resolves to the single
  hoisted `@typescript/typescript6`. No second TypeScript 5 copy remains in
  `bun.lock`.
- **Guards keep failing loudly.** Moving the API guards to TS 6 must not
  weaken them. Their existing mutation/sabotage tests are the proof.
- **Emit parity is a gate, not an assumption.** Package `dist/` output is
  compared before and after. Every non-map difference is explained in the
  evidence.

## Commands executors will need

Always run tests through the root `bun run test` script, never bare `bun test`.

| Purpose | Command | Expected on success |
|---|---|---|
| Clean install | `rm -rf node_modules && bun install` | exit 0; no stale workspace symlinks |
| Compiler identity | `bunx tsc -v` / `bun -e 'console.log(require("typescript").version)'` | `Version 7.0.x` / `6.0.x` |
| Root typecheck | `bun run typecheck:root` | exit 0 |
| All typechecks | `bunx turbo run typecheck typecheck:root --force --filter=// --filter=@atlcli/extension --filter=@atlcli/pdf-compiler-browser --filter=@atlcli/browser-export-harness` | exit 0, no cache hits |
| Build | `bunx turbo run build --force` | exit 0 |
| API reports | `bun run test scripts/api-report.test.ts` (also exercises `api-closure.ts`) | exit 0 without `--update` |
| Browser guard | `bun run check:browser` | exit 0 |
| Phase-1 guard | `bun run test apps/extension/tests/docx/template-store-migration.test.ts` | exit 0, mutation cases still caught |
| Docs | `bun run docs:check && bun run docs:build` | exit 0 |
| Packed consumer | `bun run test scripts/pack-check.test.ts` | exit 0 |
| Full suite | `bun run test` | exit 0 |

## Scope

In scope:

- root and `apps/browser-export-harness` `package.json`, `bun.lock`;
- `bun-types` bump and the four `signalCode` typing fixes in
  `apps/cli/src/commands/export-source-contract.test.ts`;
- `apps/extension/tsconfig.json` explicit `types`;
- `CLAUDE.md` and `src/content/docs/contributing.md` (the "TypeScript"
  section and typecheck instructions);
- adoption evidence under this spec.

Out of scope:

- the tsrs evaluation lane (follow-up, see open questions);
- TS 7 performance features, project references, `isolatedDeclarations`;
- runtime or bundler changes.

## Git workflow

- Two PRs, each on a dedicated branch separate from feature work:
  1. `build/ts7-prep`: T0 (baseline), T1 and T2, all green on TS 5.9.
  2. `build/typescript-7-migration`: T3–T6, based on `main` after PR 1 is
     merged.
- One logical commit per task where practical, using Conventional Commits,
  for example `build: adopt typescript 7 native compiler side-by-side with ts6 api`.
- Do not push, open a PR or release without explicit operator authorization.

## Implementation tasks

### T0 — Freeze the TypeScript 5.9 baseline

**Depends on:** none.

- [ ] On a fresh install, run the full command table on TS 5.9.3 and record
      exit codes.
- [ ] Build every package (`turbo run build --force`) and snapshot all
      `packages/*/dist` trees (path list plus SHA-256 per file) into ignored
      scratch output.
- [ ] Record three cold timings each for all typechecks
      (`turbo ... --force`) and `turbo run build --force`, with machine and
      Bun version.

Expected: a reproducible baseline that later tasks diff against.

### T1 — Bump `bun-types` and fix the Bun typing change

**Depends on:** T0. Independent of TS 7, and can land first on its own.

- [ ] Update `bun-types` to the release matching the pinned Bun line
      (probe: `1.4.3`).
- [ ] Fix the four `signalCode: proc.signalCode` call sites in
      `export-source-contract.test.ts`. Prefer widening `cliFailureMessage`'s
      parameter type over casting at each call site.
- [ ] `bun run typecheck` and the affected test pass on **TS 5.9**.

Expected: TS 5.9 still green, and the `bun-types` TS 7 incompatibility is
gone.

### T2 — Make `apps/extension` independent of automatic `@types` inclusion

**Depends on:** T0. Can land before TS 7.

- [ ] Add `"types": ["chrome"]` (plus anything else the TS 7 run reports) to
      `apps/extension/tsconfig.json`. Check whether the WXT-generated
      `.wxt/tsconfig.json` already contributes `types` and merge correctly.
- [ ] `wxt prepare && tsc --noEmit` passes on TS 5.9, and on TS 7 via
      `bunx -p typescript@7.0.2 tsc --noEmit`.

Expected: the extension type-checks identically on both compilers.

### T3 — Install TypeScript 7 side by side with the TypeScript 6 API

**Depends on:** T1, T2.

- [ ] Root `devDependencies`: replace `typescript` with
      `"typescript": "npm:@typescript/typescript6@^6.0.2"` and add
      `"@typescript/native": "npm:typescript@^7.0.2"`.
- [ ] `apps/browser-export-harness`: drop its own `typescript` pin, or align
      it to the same two aliases. There must be exactly one TS 7 and one TS 6
      in `bun.lock`.
- [ ] Verify bin wiring under Bun's hoisted linker: `node_modules/.bin/tsc`
      is TS 7, `tsc6` is TS 6, and `bunx tsc` resolves the local TS 7. If Bun
      mis-links aliased bins, STOP (see below).
- [ ] Verify `@astrojs/check`'s peer resolves to the TS 6 alias without peer
      warnings that fail CI.

Expected: compiler identity commands print 7.0.x and 6.0.x.

### T4 — Green every gate on TypeScript 7

**Depends on:** T3.

- [ ] Run the full command table. Fix only what TS 7 forces. Each source
      change cites the TS 7 rule that requires it.
- [ ] API guards on the TS 6 API: `api-report`/`api-closure` reports are
      byte-identical without `--update`. If the TS 6 printer changes output,
      regenerate, review the diff and record why it is cosmetic.
- [ ] `check:browser` and the phase-1 guard's mutation tests still fail on
      the sabotaged fixtures.
- [ ] `docs:check` (Astro/Volar on TS 6) passes. Handle any TS 6
      deprecation diagnostics in `tsconfig.docs.json` explicitly, not with a
      blanket `ignoreDeprecations`.

Expected: everything green with TypeScript 7 as the only `tsc`.

### T5 — Prove emit parity and record performance

**Depends on:** T4.

- [ ] Rebuild all packages and diff against the T0 snapshot. `.js` and
      `.d.ts` must be identical, or each difference is listed and justified
      (for example union order from `stableTypeOrdering`). For `.map` files,
      check that `sources` resolve to existing files and that the
      packed-consumer test passes.
- [ ] Repeat the T0 timing protocol and store `adoption-evidence.json` under
      this spec: compiler versions, lockfile digest, gate results, parity
      verdict, timings (median of three, cold).
- [ ] Run the CLI E2E smoke against DOCSY (profile `mayflower`) using the
      built CLI, and clean up test pages.

Expected: a reviewer can see from the evidence alone that output did not
regress.

### T6 — Docs and contributor guidance

**Depends on:** T4.

- [ ] Update `CLAUDE.md` (build/typecheck notes) and
      `src/content/docs/contributing.md`. Cover the compiler split (TS 7 `tsc` vs. TS 6 API)
      and the fresh-install gotcha. Add a short "switching the editor to the
      TS 7 language server" note.
- [ ] Add a guard test (or extend `scripts/dev-resolution.test.ts`) that
      fails if `tsc` is not 7.x or the `typescript` API is not 6.x. This
      keeps a future `bun add typescript` from silently undoing the split.

Expected: the split is documented and protected by a test.

## Test matrix

| Layer | Required evidence |
|---|---|
| Compiler identity | `tsc` = 7.x, `require("typescript")` = 6.x, single copy each in `bun.lock` |
| Type safety | every typecheck target green on TS 7, `--force` (no Turbo cache) |
| Emit | `dist/` `.js`/`.d.ts` parity with the TS 5.9 baseline, maps resolvable, packed consumer passes |
| API surface | `api-report`/`api-closure` unchanged, or reviewed regeneration |
| Guards | browser-build and phase-1 guards still catch their sabotage cases |
| Docs site | `docs:check` + `docs:build` on the TS 6 API |
| Performance | median cold typecheck and build before/after |
| E2E | built CLI smoke on DOCSY with cleanup |

## Definition of done

- [ ] TypeScript 7 is the only `tsc`. TypeScript 6 is the only compiler API.
      TypeScript 5.9 is gone from `bun.lock`.
- [ ] All gates in the command table pass in CI and locally on a fresh install.
- [ ] Emit parity and timings are recorded in `adoption-evidence.json`.
- [ ] Docs and the identity guard test are merged in the same PR.
- [ ] Nothing is pushed or released without authorization.

## STOP conditions

Stop and report instead of improvising if:

- Bun cannot link the two aliased packages so that `tsc` is TS 7 and
  `typescript` is TS 6, for example because of bin collisions or broken
  hoisting;
- a third-party tool (`@astrojs/check`, `wxt`, Turbo plugins) hard-requires
  TS 7 or TS 5 in a way the alias layout cannot satisfy;
- TS 7 `.js` emit differs from the baseline in any way other than source maps;
- `.d.ts` differences change the public API (not just ordering), or API
  reports change semantically;
- the TS 6 API changes guard behavior so that a sabotage test no longer fails;
- fixing TS 7 diagnostics would require source changes beyond typing fixes;
- a gate fails twice after a reasonable scoped correction.

## Follow-ups (not part of this spec)

1. **tsrs lane.** After T5, optionally add a non-blocking CI job running
   `tsrs --noEmit` on the root config, and report the two divergences found
   here (zod `TS5115`, the `TS7031` in `pdf-job-executor.test.ts`) upstream
   with a minimal reproduction. Promote it to a drop-in only once tsrs is
   stable and its diagnostics match `tsc` on the full gate set.
2. **TS 7.1 API.** When 7.1 ships a stable programmatic API, port
   `api-report`, `api-closure`, `check-browser-build` and the phase-1 guard,
   then drop the TS 6 alias once Astro/Volar support TS 7.
3. **TS 7 performance features.** Evaluate `--isolatedDeclarations` and
   project references with `--builders` for the 30 package builds.

## Resolved planning questions

1. The tsrs lane (follow-up 1) gets its own spec after TS 7 lands. It is not
   part of this migration. (Operator, 2026-10-20.)
2. T1 and T2 (`bun-types` bump, extension `types`) ship first as their own
   small PR on TS 5.9. T3–T6 follow in the TypeScript 7 PR.
   (Operator, 2026-10-20.)
