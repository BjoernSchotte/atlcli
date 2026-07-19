# 009 — Package publishing & public API freeze

## Reference

- `specs/export-expansion/UMSETZUNGSPLAN.md` — Sync-Punkt 1, tasks **T4.1**
  (publishing pipeline for `@atlcli/*`) and **T4.2** (API stabilization with
  breaking-change policy). This folder details both.
- `specs/export-expansion/BASELINE-DESIGN.md` — engine contracts referenced by
  the API freeze (spec 006 §2.3 `ExportEnv`, spec 007 PDF ports).
- Verified current state (all read, not assumed):
  - Root `package.json`: `private: true`, version `0.17.2`, Bun workspaces
    (`apps/*`, `packages/*`), `patchedDependencies` maps
    `@myriaddreamin/typst-ts-web-compiler@0.7.0` to
    `patches/@myriaddreamin%2Ftypst-ts-web-compiler@0.7.0.patch`, scripts
    `version:core` / `version:cli` (`npm version -w …`) already exist.
  - `turbo.json`: `build` task with outputs `dist/**` and `../../dist/**`; no
    package under `packages/*` currently has a `build` script — only
    `apps/cli/build.ts` (bundles the CLI to the repo-root `dist/`).
  - Package manifests (`packages/*/package.json`) — **not** uniformly
    `private: true`:
    | Package | version | private | exports today |
    |---|---|---|---|
    | `@atlcli/core` | 0.6.0 | no | `.` with `browser`/`default` conditions → `./src/*.ts`, plus `./browser`, `./node` |
    | `@atlcli/confluence` | 0.6.0 | no | same condition pattern → `./src/*.ts` |
    | `@atlcli/jira` | 0.6.0 | no | `.` → `./src/index.ts` |
    | `@atlcli/plugin-api` | 0.6.0 | no | `.` → `./src/index.ts` |
    | `@atlcli/docx` | 0.6.0 | **yes** | conditions + `./browser-runtime`, `./vite`, `./scan`, `./fixtures`, `./fonts/*` (committed TTFs, 2.6 MB) |
    | `@atlcli/pdf` | 0.6.0 | **yes** | conditions + `./template`, `./fonts/*` → `./.fonts/*` (gitignored!), `./licenses/*` |
    | `@atlcli/pdf-compiler-browser` | 0.1.0 | **yes** | `.` → `./src/index.ts` |
    | `@atlcli/diagram` | 0.6.0 | **yes** | `.` → `./src/index.ts` |
    Every export points at TypeScript **source**, which only works inside this
    Bun/TS-aware workspace. Nothing is publishable as-is.
  - `patches/@myriaddreamin%2Ftypst-ts-web-compiler@0.7.0.patch` (40 lines):
    patches only `pkg/typst_ts_web_compiler.mjs`, replacing both
    `new Function(...)` call sites in the wasm-bindgen glue with an allowlist
    of static closures and throwing on any unexpected dynamic function body.
    This is CSP/security hardening (no `unsafe-eval`), applied by Bun's
    `patchedDependencies` at install time in **this repo only**.
  - `packages/pdf/scripts/ensure-fonts.ts`: downloads 10 TTFs (Source Sans 3 /
    Source Serif 4 / Source Code Pro) pinned by commit + sha256 from
    `raw.githubusercontent.com/adobe-fonts/...` into `packages/pdf/.fonts/`
    (gitignored via `.gitignore` line `packages/pdf/.fonts/`); asset list lives
    in `packages/pdf/src/runtime-assets.ts`; OFL license texts are committed in
    `packages/pdf/licenses/`. Root `prebuild` runs `fonts:ensure`.
  - `scripts/release.ts`: single root-version release train (git-cliff
    changelog, `v*` tag, GitHub Release with compiled CLI binaries, Homebrew
    tap trigger, rollback state machine). No npm publish step exists today.
  - Public API symbols: `ExportEnv`/`runExport` in
    `packages/docx/src/env.ts`; `PdfExportEnv`/`runPdfExport` in
    `packages/pdf/src/run-export.ts`; `PdfCompilePort`/`PdfCompileResult` in
    `packages/pdf/src/compiler.ts`; `BrowserPdfCompiler` +
    `BrowserPdfCompilerAssets` in `packages/pdf-compiler-browser/src/compiler.ts`.
    `TreeSource` (T1.1, `packages/confluence`) and `MacroRendererRegistry`
    (T1.7, `packages/export-macros`) do not exist yet — they land via folders
    002/004 of this spec series.
  - `?url` asset contract in practice: `apps/browser-export-harness/src/pdf-worker.ts`
    imports `@myriaddreamin/typst-ts-web-compiler/wasm?url` and
    `@atlcli/pdf/fonts/*.ttf?url` (Vite), with ambient declarations in
    `apps/browser-export-harness/src/worker-assets.d.ts`.
  - `packages/pdf-compiler-browser/src/compiler.test.ts` already runs the real
    wasm compiler under Bun by resolving `@myriaddreamin/typst-ts-web-compiler/wasm`
    to a file and passing an `ArrayBuffer` — proof that no DOM is required.

## Goal & user value

Make the `@atlcli/*` packages consumable by **external consumers** — any repo
outside this monorepo that wants to build export functionality on top of our
engines — by:

1. Publishing real build artifacts (compiled JS + `.d.ts`, not `src/*.ts`
   exports) for the eight packages: `core`, `confluence`, `jira`,
   `plugin-api`, `diagram`, `docx`, `pdf`, `pdf-compiler-browser` (and later
   `export-macros` once T1.7 lands).
2. A semver discipline and publish pipeline aligned with the existing
   `scripts/release.ts` release train.
3. Solving the three consumability blockers no ordinary publish handles:
   the **patched** typst.ts wasm glue, the **gitignored, build-time
   downloaded** PDF fonts, and the **wasm/font `?url` asset contracts** for
   consumer bundlers.
4. Freezing and guarding the public API (T4.2) so external consumers can
   depend on versioned packages without being broken silently.

Value: unblocks Track 2 of the Umsetzungsplan (an externally developed host
consuming the published packages) whose only coupling to this repo is
T4.1/T4.2. Also improves our own hygiene: today `@atlcli/core`,
`@atlcli/confluence`, `@atlcli/jira`, `@atlcli/plugin-api` are *not*
`private: true` and would publish broken src-exports if anyone ran
`npm publish` — closing that hole is part of this work.

## Dependencies

- **M1 is NOT required for the infrastructure work.** Build pipeline,
  manifests, registry auth, patch vendoring, font shipping, and the consumer
  smoke harness only touch packaging concerns and can start immediately, in
  parallel to the feature lanes (disjoint file ownership: `packages/*/package.json`
  build/exports fields, new `tsconfig.build.json` files, `scripts/`,
  `.github/workflows/`).
- **The API freeze (T4.2) comes last**: it must wait until the sibling
  folders 001–008 of this spec series have landed, because they add or reshape
  the very surfaces being frozen (`TreeSource` from 002, macro registry from
  004, `ExportBlock` extensions from T0.1, PDF `settings` from Lane P).
  Freezing earlier would mean freezing an API we know is about to change.
- Consumer smoke for PDF depends on nothing new: `BrowserPdfCompiler` already
  compiles under Bun (see `packages/pdf-compiler-browser/src/compiler.test.ts`).
  The CLI E2E gate additionally benefits from T3.1/T3.2 (PDF via CLI) but the
  DOCX CLI path exists today.
- Coordination note: this lane owns `packages/*/package.json`. Other lanes add
  dependencies to those files; keep changes here mechanical (exports/files/
  scripts blocks) and rebase frequently, per the Umsetzungsplan merge rules.

## Architecture

### Build output model: per-package `dist/` via `tsc`, no bundling

Decision: **`tsc` (emit + declarations), not `bun build`.**

- These packages are plain ESM TypeScript libraries with no bundle-time
  requirements; consumers bring their own bundler. What they need is JS that
  Node/Bun/bundlers can load **plus `.d.ts`**, preserving the module graph so
  every existing subpath (`./browser`, `./template`, `./scan`, …) and the
  `browser`/`default` export conditions keep working file-for-file
  (`src/index.browser.ts` → `dist/index.browser.js` + `dist/index.browser.d.ts`).
- `bun build` produces bundles but no declarations, flattens the module graph
  (breaking the 1:1 condition mapping), and would inline cross-package
  imports unless carefully configured external. Rejected.
- Each package gets a `tsconfig.build.json` (extends root config;
  `outDir: dist`, `declaration: true`, `declarationMap: true`,
  `sourceMap: true`, excludes `*.test.ts` and `fixtures.ts`-style dev-only
  entries where applicable) and a `build` script `tsc -p tsconfig.build.json`.
  Turbo's existing `build` task (`dependsOn: ["^build"]`, outputs `dist/**`)
  already orchestrates this correctly once the scripts exist.
- Exports maps are rewritten to `dist/` with `types` + `browser` + `default`
  conditions, e.g. for `@atlcli/confluence`:

  ```jsonc
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "browser": "./dist/index.browser.js",
      "default": "./dist/index.js"
    },
    "./browser": { "types": "./dist/index.browser.d.ts", "default": "./dist/index.browser.js" },
    "./node": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  }
  ```

  Non-JS subpaths (`./fonts/*`, `./licenses/*`, `./wasm`) stay raw file
  exports so `?url` imports keep working.
- Workspace development keeps working without a watch step: bun resolves
  `workspace:*` to the package root, and we keep the source TS reachable via
  a `development` condition listed **first** (`"development": "./src/index.ts"`)
  which Bun honors by default; publish artifacts are unaffected. If this
  proves flaky in practice, fallback is `turbo build --watch` during dev —
  decide in the first PR, do not block on it.

### Package graph & what gets published

Publish set (dependency order): `plugin-api`, `core`, `diagram`, `jira`,
`confluence`, `docx`, `pdf`, `pdf-compiler-browser` (+ `export-macros` when it
exists). `apps/*` stay private. Internal deps switch from `workspace:*` to
real semver ranges **at pack time** (bun rewrites `workspace:*` to the current
version on `bun pm pack` — verify; if not, a prepack script rewrites them).

Each published package carries a `files` allowlist (e.g. `["dist", "fonts",
"licenses", "README.md"]`) so tarballs are deterministic, and
`publishConfig.access` set per the registry decision below.

### Versioning: lockstep train on the existing release script, no changesets

Decision: **fixed/lockstep versioning for all `@atlcli/*` packages, driven by
an extended `scripts/release.ts`** — not changesets.

- The repo already runs a single-version release train (root `version`,
  git-cliff changelog from Conventional Commits, one tag). Changesets would
  introduce a second changelog system, per-package version drift, and a bot
  workflow sized for many independent maintainers — none of which this repo
  has. Conventional Commit scopes (`feat(confluence):`) already give us the
  per-package story inside one changelog.
- Concretely: `release.ts` gains a step that sets every publishable package to
  the release version (reusing the existing `npm version --no-git-tag-version -w …`
  pattern from root `version:core`), packs, and publishes after the GitHub
  Release artifacts are confirmed. Publishing is **idempotent and resumable**
  (skip versions already on the registry) so a half-failed release can be
  re-run, matching the script's existing rollback philosophy.
- Semver policy pre-1.0: breaking changes to the public API bump **minor** and
  must be listed under a "Breaking" changelog heading; patch releases are
  strictly non-breaking. At API freeze (T4.2 complete) the packages jump to
  `1.0.0` and standard semver applies: breaking = major.

### Registry: npmjs.org under `@atlcli`, GitHub Packages as documented fallback

Decision: **public npm registry (registry.npmjs.org), scope `@atlcli`,
`publishConfig.access: "public"`.**

- The code is Apache-2.0 in a public repo; there is no secrecy to protect,
  and the external consumer track should not need registry auth just to
  *install*.
- GitHub Packages has a hard constraint: npm packages must be scoped to the
  **repo owner's** user/org namespace. The repo owner is `BjoernSchotte`, so
  `@atlcli/*` cannot be published to GitHub Packages unless a GitHub org named
  `atlcli` is created and the repo (or a publishing mirror) lives there.
  That makes GitHub Packages the fallback, not the default — see open
  questions.
- Auth is still documented for both directions (see Registry & auth tasks):
  publishing needs an npm automation token in CI / `NPM_TOKEN`; the GitHub
  Packages fallback needs the classic `.npmrc` /
  `bunfig.toml` scoped-registry + token setup, which we document even if
  unused, because some external consumers may proxy through it.

### Special-case architecture (details in Tasks)

1. **Patched typst.ts** — decision: **vendor the patched `pkg/` files into
   `@atlcli/pdf-compiler-browser`**, drop the external dependency.
   Analysis: Bun's `patchedDependencies` is applied by the **top-level app's**
   install from *its* root `package.json`; a dependency's patch config is
   ignored, npm/pnpm/yarn consumers can't consume the Bun patch format at all,
   and an unpatched install *silently works* while reintroducing
   `new Function` — losing the CSP hardening with no error. Documenting a
   "please configure patchedDependencies" requirement therefore fails open.
   Vendoring fails closed: consumers always get the patched glue.
   Mechanics: a build script copies `node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/`
   (post-patch, since this repo's install applies the patch) into the package,
   asserts the patch markers are present (`Blocked unexpected dynamic
   function`), ships upstream's Apache-2.0 LICENSE alongside (already
   referenced as `compilerLicense` in `packages/pdf/src/runtime-assets.ts`),
   and exposes `./wasm` + the `.mjs` glue as package subpaths. The version pin
   (`0.7.0`) is encoded in `PDF_BROWSER_COMPILER_VERSION`.
2. **PDF fonts** — decision: **ship the fonts inside the `@atlcli/pdf`
   tarball**. The 10 TTFs are SIL OFL 1.1 (redistribution explicitly allowed;
   license texts already committed in `packages/pdf/licenses/` and exported
   via `./licenses/*`); size is ~3 MB (the committed DOCX font set is 2.6 MB,
   same ballpark) — acceptable for a PDF engine package. Shipping means
   consumers get a deterministic, offline install with no postinstall network
   fetch (postinstall scripts are increasingly blocked by default — Bun
   doesn't run them for unlisted packages). `ensure-fonts` remains the
   *repo-side* mechanism that populates `.fonts/` before pack; a `prepack`
   guard fails the pack if any TTF is missing or its sha256 (from
   `runtime-assets.ts`) mismatches. Consumer-side `ensure-fonts` stays
   available (it's exported logic) for hosts that want to re-verify or
   re-fetch, but is not required.
3. **Wasm/font `?url` contract** — published packages keep raw asset files at
   stable subpaths (`@atlcli/pdf/fonts/<name>.ttf`,
   `@atlcli/pdf-compiler-browser/wasm`) so Vite-style `?url` imports work
   against the installed package exactly as the harness does today. The
   contract (which subpaths exist, that they resolve to real files, and the
   `BrowserPdfCompilerAssets` shape `{ wasm: ArrayBuffer | URL | Response;
   fonts: Uint8Array[] }`) is documented for consumer bundlers, including a
   copy-paste ambient-types snippet modeled on
   `apps/browser-export-harness/src/worker-assets.d.ts`.

### API freeze & guard architecture

Public API v1 = the host-facing seams, documented in `docs/`:

- `ExportEnv`, `runExport`, `RunExportInput`, `TemplateSource`, `AssetFetcher`,
  `OutputSink`, `SvgRasterizer`, `ExportReport` (`packages/docx/src/env.ts`)
- `PdfExportEnv`, `runPdfExport`, `RunPdfExportInput`, `PdfExportError`,
  `PdfExportPhase` (`packages/pdf/src/run-export.ts`)
- `PdfCompilePort`, `PdfCompileResult`, `PdfCompileContext`
  (`packages/pdf/src/compiler.ts`) and its shipped implementation
  `BrowserPdfCompiler` (`packages/pdf-compiler-browser/src/compiler.ts`)
- Planned, frozen once folders 002/004 land: `TreeSource`
  (`packages/confluence`), `MacroRendererRegistry` (`packages/export-macros`)
- `ExportBlock` and `storageToBlocks` (`packages/confluence/src/export-blocks.ts`)
  as the shared document model.

Guard: a **type-snapshot (api-report) test** rather than adopting
`@microsoft/api-extractor` wholesale. The tsc build already emits rollup-able
`.d.ts`; a bun test flattens each package's public entrypoint declarations
into a normalized report file committed under `specs/export-expansion/009-package-publishing/api-reports/`
(or `packages/<p>/etc/<p>.api.md` — pick one location in the first PR) and
diffs against it. Any surface change fails CI until the report is
intentionally regenerated and the diff reviewed — exactly api-extractor's
workflow, minus the toolchain weight. If the hand-rolled flattener proves
brittle, swapping in api-extractor is a drop-in upgrade (same committed-report
model); note it as the designated fallback.

## Tasks

### Build artifacts

- [ ] Add `tsconfig.build.json` + `"build": "tsc -p tsconfig.build.json"` +
      `"clean"` to each of `packages/{plugin-api,core,diagram,jira,confluence,docx,pdf,pdf-compiler-browser}/`;
      exclude `**/*.test.ts` (and `packages/docx/src/fixtures.ts` from the
      published `.` surface only if tests don't need it packaged — verify:
      it's an exported subpath today, keep `./fixtures` but mark it explicitly
      non-frozen dev API).
- [ ] Rewrite `exports` in all eight `packages/*/package.json` to `dist/`
      targets with `types` + `browser`/`default` conditions preserved 1:1;
      keep raw-asset subpaths (`packages/docx`: `./fonts/*`; `packages/pdf`:
      `./fonts/*`, `./licenses/*`; `packages/pdf-compiler-browser`: new
      `./wasm`). Add a `development` condition pointing at `src/` for
      in-repo DX and verify `bun test` + `apps/cli` still run from source.
- [ ] Add `files` allowlists and remove `private: true` from
      `packages/{docx,pdf,diagram,pdf-compiler-browser}/package.json`;
      add `"sideEffects": false` where true (verify per package — the docx
      browser runtime mutates `globalThis.__atlDocxByteHelpers`, see
      `packages/docx/src/vite.ts`, so audit before claiming it).
- [ ] Confirm `turbo.json` `build` inputs/outputs still describe reality
      (add `tsconfig.build.json` to `inputs`; keep `dist/**` outputs) and that
      `bun run build` builds packages in dependency order via `^build`.
- [ ] Verify `apps/extension` and `apps/browser-export-harness` (Vite) resolve
      the new conditions correctly (Vite prefers `browser`); run
      `bun run check:browser` and the harness build
      (`bun run build:browser-export-harness`) as regression gates.
- [ ] Tests: a `bun test` suite (`scripts/pack-check.test.ts`) that runs
      `bun pm pack` per package into the scratch dir and asserts tarball
      contents — `dist/*.js`, `dist/*.d.ts` present; no `src/**/*.ts` leaked;
      asset files present (see Special cases); `exports` targets all exist
      inside the tarball (catches the classic broken-subpath publish).

### Versioning & release

- [ ] Extend `scripts/release.ts` with a package-publish stage: set all
      publishable packages to the release version (reuse the
      `npm version --no-git-tag-version -w` pattern from root `version:core`),
      build, pack, publish in dependency order; make it resumable (skip
      versions already present on the registry) and wire it into the existing
      `ReleaseState`/rollback model (registry publishes are non-rollbackable —
      treat like `mainPushed`: warn, never rewrite).
- [ ] Update `showDryRunPlan()` in `scripts/release.ts` so `--dry-run` prints
      the publish steps, per the workflow rule "always dry-run first".
- [ ] Ensure `workspace:*` ranges are rewritten to concrete semver in packed
      tarballs; add a regression test in `scripts/release.test.ts` (inspect a
      packed manifest, assert no `workspace:` protocol survives).
- [ ] Document the semver policy (pre-1.0 minor-may-break, 1.0 at API freeze,
      Conventional-Commit scopes as the per-package changelog) in
      `docs/` (reference page under the docs standards) and link it from
      `CHANGELOG.md` generation notes.
- [ ] Decide and implement the changesets question as **rejected** in code:
      no `.changeset/`; add a short "why lockstep" note to the docs page so
      future contributors don't re-litigate it blindly.

### Registry & auth

- [ ] Register/verify ownership of the `@atlcli` scope on registry.npmjs.org
      (manual step, tracked here); set
      `"publishConfig": { "access": "public" }` in every publishable
      `packages/*/package.json`.
- [ ] Add `NPM_TOKEN`-based publish auth to the release path: local
      (`~/.npmrc` guidance) and CI (`.github/workflows/` release workflow env,
      repo secret). Never commit tokens; document token scope = automation,
      2FA-safe.
- [ ] Document the GitHub Packages fallback in `docs/`: scoped-registry
      `.npmrc`/`bunfig.toml` (`@atlcli:registry=…` + `//…/:_authToken`),
      the owner-scope constraint (requires an `atlcli` GitHub org), and
      consumer-side read auth — labeled clearly as the non-default path.
- [ ] Consumer install documentation page in `docs/` (per docs standards:
      intro → prerequisites → steps → examples → troubleshooting): install
      with bun/npm/pnpm, minimal `runExport` example (DOCX) and advanced
      `runPdfExport` example (PDF incl. wasm/fonts wiring for both Node-ish
      and Vite hosts).

### Special cases (wasm/patch/fonts)

- [ ] `@atlcli/pdf-compiler-browser`: add `scripts/vendor-typst.ts` (in
      `packages/pdf-compiler-browser/scripts/`) that copies the **patched**
      `pkg/` from this repo's installed
      `@myriaddreamin/typst-ts-web-compiler` into
      `packages/pdf-compiler-browser/vendor/typst-ts-web-compiler/`, asserts
      the patch markers (`Blocked unexpected dynamic function`) and a pinned
      sha256 of the `.mjs` + `.wasm`, and copies upstream's Apache-2.0
      LICENSE + NOTICE attribution.
- [ ] Switch `packages/pdf-compiler-browser/src/compiler.ts` (and
      `vendor.d.ts`) from the `@myriaddreamin/...` import to the vendored
      path; remove the dependency from
      `packages/pdf-compiler-browser/package.json`; add exports `./wasm` →
      `./vendor/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm`
      (exact filename verified during implementation) and include `vendor/`
      in `files`. Keep the root `patchedDependencies` entry for the remaining
      in-repo consumers (`apps/extension`, harness) or migrate them to the
      vendored subpath — prefer migrating so the patch exists in exactly one
      delivery channel; then retire `patches/` (follow-up, only after both
      apps are migrated and green).
- [ ] Regression test (`packages/pdf-compiler-browser/src/vendor.test.ts`,
      no mocks): load the vendored `.mjs` under Bun, initialize with the
      vendored wasm bytes, compile a minimal bundle (reuse the pattern from
      `packages/pdf-compiler-browser/src/compiler.test.ts`), and assert the
      patch behavior directly — the glue must **throw** on an unexpected
      dynamic function body (unit-test the exported wrapper contract, not by
      grep alone).
- [ ] `@atlcli/pdf` fonts: add `prepack` script that runs
      `packages/pdf/scripts/ensure-fonts.ts` and then verifies every
      `PDF_RUNTIME_ASSETS.fonts` file exists in `packages/pdf/.fonts/` with
      matching sha256, failing the pack otherwise; add `.fonts` and
      `licenses` to `files`. Verify empirically that `bun pm pack` includes
      the gitignored `.fonts/` when allowlisted (npm-compat rule says `files`
      wins over `.gitignore` — do not trust, test in `pack-check.test.ts` by
      listing tarball entries).
- [ ] Document the `?url` asset contract in `docs/` reference: stable subpaths
      (`@atlcli/pdf/fonts/<file>.ttf`, `@atlcli/pdf/licenses/<file>`,
      `@atlcli/docx/fonts/<file>`, `@atlcli/pdf-compiler-browser/wasm`), the
      `BrowserPdfCompilerAssets` input shape, a Vite `?url` example matching
      `apps/browser-export-harness/src/pdf-worker.ts`, and the ambient-types
      snippet from `apps/browser-export-harness/src/worker-assets.d.ts`.
- [ ] Keep `runtime-assets.ts` as the single source of truth: `pack-check`
      asserts tarball font list == `PDF_RUNTIME_ASSETS.fonts` (no drift
      between code, downloads, and shipped files).

### API freeze & guards

- [ ] (After folders 001–008 land) Write the public API reference in `docs/`
      (one page per seam, per docs standards): `ExportEnv`/`runExport`
      (`packages/docx/src/env.ts`), `PdfExportEnv`/`runPdfExport`
      (`packages/pdf/src/run-export.ts`), `PdfCompilePort`
      (`packages/pdf/src/compiler.ts`), `BrowserPdfCompiler`
      (`packages/pdf-compiler-browser/src/compiler.ts`), `TreeSource`
      (`packages/confluence`, from folder 002), `MacroRendererRegistry`
      (`packages/export-macros`, from folder 004), `ExportBlock`/
      `storageToBlocks` (`packages/confluence/src/export-blocks.ts`).
      Mark everything else (e.g. `@atlcli/docx/scan`, `./fixtures`,
      template internals) explicitly **unstable/internal**.
- [ ] Write the breaking-change policy into the same docs section: what
      counts as breaking (removed/renamed exports, narrowed input types,
      widened output types, changed `exports` subpaths, changed asset
      filenames), deprecation window (one minor with `@deprecated` JSDoc
      before removal), and the pre-1.0 vs post-1.0 rules from Architecture.
- [ ] Implement the api-report guard: `scripts/api-report.ts` generates a
      normalized public-surface report per package from the built `dist/*.d.ts`
      (public exports of each `exports` entrypoint, sorted, comments
      stripped); committed reports live in `packages/<p>/etc/<p>.api.md`;
      `scripts/api-report.test.ts` (plain `bun test`, runs in CI) fails on
      any diff with a message telling the author to regenerate via
      `bun scripts/api-report.ts --update` and get the diff reviewed.
- [ ] Add regression coverage for the guard itself: a test fixture package
      surface where a removed export / changed signature produces a failing
      diff (guards the guard; no mocks — run the real generator on a tiny
      fixture entrypoint under the scratch of the test).
- [ ] Bump all published packages to `1.0.0` in the freeze release; changelog
      entry documents the frozen surface and links the docs pages.

### Consumer smoke

- [ ] `scripts/consumer-smoke.ts` (+ `scripts/consumer-smoke.test.ts` wiring
      it into `bun test` behind an env flag for CI): creates a temp project
      via `bun init` in the scratch dir, runs `bun pm pack` for every
      publishable package, installs the **local tarballs** (`bun add
      ./atlcli-core-<v>.tgz …` in dependency order, with internal ranges
      resolving to the sibling tarballs), and asserts installation succeeds
      with no `workspace:` leakage. Real packages, real wasm, no registry —
      and no mocks anywhere in this suite.
- [ ] DOCX smoke inside the temp project: a script that imports `runExport`
      from the installed `@atlcli/docx`, provides a minimal real `ExportEnv`
      (template bytes from the installed package's shipped default template
      path — verify what `TemplateSource` needs and ship a usable default;
      in-memory `OutputSink`), feeds a storage-XML fixture through
      `storageToBlocks` from installed `@atlcli/confluence`, and asserts the
      emitted bytes are a valid DOCX (unzip, check `word/document.xml`
      contains the fixture heading).
- [ ] PDF smoke inside the temp project: imports `runPdfExport` from installed
      `@atlcli/pdf` and `BrowserPdfCompiler` from installed
      `@atlcli/pdf-compiler-browser`, loads wasm bytes from the installed
      package's `./wasm` subpath and fonts from installed
      `@atlcli/pdf/fonts/*` via `import.meta.resolve` (the exact pattern
      already proven in `packages/pdf-compiler-browser/src/compiler.test.ts`,
      but now against `node_modules`, not the workspace), compiles a fixture,
      and asserts `%PDF-` magic bytes + `validatePdfOutput` passes.
- [ ] Type-consumption check in the temp project: `tsc --noEmit` against a
      consumer `main.ts` importing from `@atlcli/{docx,pdf,confluence,pdf-compiler-browser}`
      with `"skipLibCheck": false` — proves shipped `.d.ts` are self-contained
      (catches leaked `src/` type imports and missing declaration deps).
- [ ] CI job (`.github/workflows/`): run the consumer smoke on every PR that
      touches `packages/**` or the publish tooling (path filter), Linux
      runner, no registry credentials needed.
- [ ] **E2E final gate** (before the freeze release, per CLAUDE.md workflow
      rules): build the CLI from the packed packages (temp checkout of
      `apps/cli` with `@atlcli/*` deps pointing at the packed tarballs
      instead of `workspace:*`), then export a real page from space `DOCSY`
      with profile `mayflower` to DOCX (and PDF once T3.2 exists) into
      `~/wikisynctest/docs`; assert non-empty valid output; **clean up** any
      test pages/files created, per the cleanup rule.

## Definition of Done

- `bun run build` produces `dist/` (JS + `.d.ts` + maps) for all eight
  packages; `bun run typecheck` and `bun test` green; harness and extension
  builds green (`check:browser`, `check:extension-output`).
- `bun pm pack` tarballs for all packages pass `pack-check.test.ts`: correct
  files, working `exports` targets, no `workspace:` ranges, fonts present in
  `@atlcli/pdf`, patched vendored typst glue + wasm present in
  `@atlcli/pdf-compiler-browser` (patch markers verified by test, not
  eyeball).
- Consumer smoke suite passes in CI: fresh `bun init` project installs the
  local tarballs and produces real DOCX bytes via `runExport` and real PDF
  bytes via `runPdfExport` + `BrowserPdfCompiler`, plus a clean
  `tsc --noEmit` type-consumption check.
- `bun scripts/release.ts minor --dry-run` prints the extended plan including
  the publish stage; a real release publishes all packages to the chosen
  registry in dependency order and is resumable after partial failure.
- Docs (first-class, same PR as behavior changes): consumer install guide,
  registry/auth reference (npm primary, GitHub Packages fallback), `?url`
  asset-contract reference, public API reference with breaking-change policy —
  all following the `docs/` standards (TOC, related topics, minimal +
  advanced examples).
- API reports committed for every package; `api-report.test.ts` fails CI on
  any unreviewed public-surface diff; frozen packages released as `1.0.0`
  (this last bullet only after folders 001–008 land).
- E2E gate executed against DOCSY/mayflower with the packed CLI; test
  resources cleaned up.

## Risks & open questions

- **`@atlcli` npm scope ownership** — is the scope free/owned by us on
  registry.npmjs.org? If squatted, options are: GitHub org `atlcli` +
  GitHub Packages (fallback already designed above) or a scope rename
  (`@atlcli-dev/*`), which would ripple through every import. Resolve before
  any publish; everything else in this plan is scope-agnostic.
- **GitHub Packages owner-scope constraint** — confirmed blocker for
  `@atlcli/*` under owner `BjoernSchotte`; only relevant if npm falls
  through.
- **`bun pm pack` semantics** — two behaviors this plan *tests instead of
  trusts*: `workspace:*` rewriting in packed manifests, and `files`
  overriding `.gitignore` for `packages/pdf/.fonts/`. If either fails, the
  prepack scripts compensate (explicit rewrite / temporary un-ignore).
- **Vendoring typst.ts pkg** — upstream is Apache-2.0 so redistribution with
  LICENSE/NOTICE is fine, but upgrades now require re-vendoring
  (`vendor-typst.ts` re-run + patch re-validation against the new glue —
  the allowlisted function bodies may change between typst.ts versions).
  Mitigation: the sha256 pin plus the behavioral vendor test make a stale or
  half-upgraded vendor loud. Residual risk accepted; the failing-open
  alternative (consumer-side `patchedDependencies`) was rejected on security
  grounds.
- **Dev-time DX after dist-exports switch** — the `development` condition
  approach needs empirical verification across Bun (tests, CLI-from-source)
  and Vite (harness, extension). If any resolver mis-prioritizes conditions,
  fall back to `turbo build --watch`; decide in the first PR.
- **Font licensing** — OFL 1.1 permits redistribution but requires the
  license texts to accompany the fonts; `files` must always include
  `licenses/` next to `.fonts/` (pack-check asserts it). Reserved-font-name
  rules only bite if we modified the fonts — we don't.
- **API freeze timing** — folders 001–008 land on their own schedules; if the
  freeze needs to slip, the packages can ship 0.x indefinitely (pre-1.0
  policy applies). Do not publish `1.0.0` early just to close this folder.
- **`@atlcli/plugin-api` and `@atlcli/jira` surfaces** — publishable already
  today (not `private:true`) but their API stability was never reviewed;
  decide during T4.2 whether they join the v1 freeze or stay explicitly 0.x.
- **`export-macros` package (T1.7)** — does not exist yet; the publish
  pipeline must pick it up automatically (derive the publish set from
  `packages/*` manifests without `private: true`, not from a hardcoded list).
