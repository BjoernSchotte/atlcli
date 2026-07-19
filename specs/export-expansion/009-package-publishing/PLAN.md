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
    tap trigger, rollback state machine). `scripts/release.ts` itself has no
    npm publish step — **but two independent, already-live workflows do**:
    `.github/workflows/release-core.yml` (`workflow_dispatch`, bumps and
    `npm publish --access public`s `@atlcli/core`/`@atlcli/confluence`/
    `@atlcli/plugin-api` under a `core-v*` tag) and
    `.github/workflows/release-cli.yml` (same pattern for `@atlcli/cli`
    under `cli-v*`, publishing `apps/cli` — which is **not** `private: true`
    today and whose `bin.atlcli` points at raw `src/index.ts`, so an install
    from that publish would not run without a TS runtime). Both use a
    long-lived `NPM_TOKEN` repo secret and bypass every gate this folder
    designs (no pack-check, no dist build, no API report, no consumer
    smoke). They must be retired or folded into the canonical path (see
    Architecture and Tasks) before this plan's guarantees hold.
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

**Maintainer decision (2026-07-19): npm registry publishing is out of active
scope for this folder.** `atlcli` as a product name is likely to be renamed;
publishing real packages under the `@atlcli/*` scope today would burn that
scope on npm for no benefit. The most likely external consumer identified so
far — a Forge app — will probably consume these packages via filesystem
linking (`file:`/`bun link`/workspace) rather than a registry install, though
that is not yet finally decided either. This folder therefore prepares
*everything* (build artifacts, packaging quality, consumability) but does
**not** implement a live publish. The full registry-publish design is
preserved, unimplemented, in the "Deferred: npm registry publishing" section
at the end of this document, for reuse once the product name is settled.

Make the `@atlcli/*` packages consumable by **external consumers** — any repo
outside this monorepo that wants to build export functionality on top of our
engines — **without requiring a package registry** — by:

1. Producing real build artifacts (compiled JS + `.d.ts`, not `src/*.ts`
   exports) for the eight packages: `core`, `confluence`, `jira`,
   `plugin-api`, `diagram`, `docx`, `pdf`, `pdf-compiler-browser` (and later
   `export-macros` once T1.7 lands) — installable via two supported paths:
   **filesystem/workspace linking** (`file:` protocol, `bun link`) for a
   consumer developed alongside this repo or a sibling checkout, and
   **packed-tarball install** (`bun pm pack` output installed with `bun add
   ./pkg.tgz` / `npm install ./pkg.tgz`) for a consumer that wants an
   isolated, versioned artifact without a registry round-trip.
2. A semver discipline for the packages themselves (version numbers, tarball
   naming, breaking-change policy) — decoupled from any publish pipeline,
   since there is currently nowhere to publish *to*.
3. Solving the three consumability blockers no ordinary packaging handles:
   the **patched** typst.ts wasm glue, the **gitignored, build-time
   downloaded** PDF fonts, and the **wasm/font `?url` asset contracts** for
   consumer bundlers — all of which matter identically for filesystem-linked,
   tarball-installed, or (later) registry-installed consumers.
4. Freezing and guarding the public API (T4.2) so external consumers can
   depend on versioned packages without being broken silently, regardless of
   how they installed them.
5. **Making it structurally hard to publish by accident.** Today three
   independent paths could already run `npm publish` for overlapping package
   sets (see Reference) using a long-lived `NPM_TOKEN`, with none of this
   folder's quality gates in the way. Neutralizing those paths — not
   building a new one — is this folder's most urgent task (see Tasks:
   Publish prevention).

Value: unblocks Track 2 of the Umsetzungsplan (an externally developed host —
most likely the Forge app — consuming these packages via workspace/filesystem
linking or packed tarballs; registry publish deferred) whose only coupling to
this repo is T4.1/T4.2. Also improves our own hygiene: today `@atlcli/core`,
`@atlcli/confluence`, `@atlcli/jira`, `@atlcli/plugin-api` are *not*
`private: true` and would publish broken src-exports if anyone ran
`npm publish` today — closing that hole is part of this work, and is now the
primary reason the classification exists (a protective default, not a
publish pipeline — see Architecture: Package graph).

## Dependencies

- **M1 is NOT required for the infrastructure work.** Build pipeline,
  manifests, registry auth, patch vendoring, font shipping, and the consumer
  smoke harness only touch packaging concerns and can start immediately, in
  parallel to the feature lanes (disjoint file ownership: `packages/*/package.json`
  build/exports fields, new `tsconfig.build.json` files, `scripts/`,
  `.github/workflows/`).
- **Split T4.1 into infra (build/pack/local smoke) — the active scope of
  this folder — and the first live registry publish, which is deferred
  entirely (see Goal and the Deferred appendix).** Everything described
  above (build, pack-check, patch vendoring, font shipping, local `bun pm
  pack`/tarball-install smoke, filesystem-link smoke, dry-runs) is
  packaging-only, has no dependency on a registry, and can run immediately —
  none of it is gated on M1. The **first publish to a public registry**
  would have been a different, effectively irreversible event gated on both
  an M1 acceptance record and a T4.7 security review (`UMSETZUNGSPLAN.md`
  places T4.1 at "Sync-Punkt 1", after M1, `UMSETZUNGSPLAN.md:111-150`;
  T4.7 requires a `/security-review` "vor jedem Release",
  `UMSETZUNGSPLAN.md:174-179`) — that gating design is preserved in the
  Deferred appendix for reuse if/when registry publishing resumes, but does
  not block anything in this folder's active Tasks or Definition of Done.
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
- Exports maps are rewritten to `dist/` with `types` **nested inside each
  runtime condition**, never hoisted above them, e.g. for
  `@atlcli/confluence`:

  ```jsonc
  "exports": {
    ".": {
      "browser": { "types": "./dist/index.browser.d.ts", "default": "./dist/index.browser.js" },
      "default": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
    },
    "./browser": { "types": "./dist/index.browser.d.ts", "default": "./dist/index.browser.js" },
    "./node": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  }
  ```

  A shared top-level `"types"` (a plausible first draft) lets TypeScript pick
  the Node `.d.ts` for a browser consumer even though the runtime resolver
  loads `index.browser.js` — TypeScript only honors extra resolution
  conditions via `customConditions`, per the
  [TSConfig reference](https://www.typescriptlang.org/tsconfig/customConditions.html),
  so `types` must travel with its own condition, not sit above them. This is
  not theoretical here: the two barrels are not near-identical re-exports of
  one surface. `packages/confluence/src/index.ts` re-exports 23 modules
  including `sync-db`, `webhook-server`, `atlcli-dir` (Node/Bun-only), while
  `index.browser.ts` re-exports 5 (`client`, `markdown`, `export-blocks`,
  `resolve-mentions`, `page-properties`); `@atlcli/core` and `@atlcli/docx`
  have the same shape (`index.ts` = browser barrel + Node-only adapters). A
  hoisted `types` field would let a bundler consumer type-check against
  Node-only symbols that don't exist at runtime in their build.
- **`@atlcli/confluence`'s default (Node) entrypoint is not portable to
  plain Node today.** `packages/confluence/src/index.ts:20` re-exports
  `./sync-db/index.js`, which statically imports `SqliteAdapter`
  (`packages/confluence/src/sync-db/sqlite-adapter.ts:7`), which does
  `import { Database, Statement } from "bun:sqlite"` — a Bun-only builtin
  with no Node equivalent. This is invisible today because the workspace
  only ever runs under Bun. Once `dist/index.js` ships to npm, any plain
  Node (not Bun) consumer doing `import { runExport } from
  "@atlcli/confluence"` — the exact minimal-import shape the consumer-smoke
  and install-docs tasks below promise — throws at import time on
  `Cannot find module 'bun:sqlite'`. Fix before the exports rewrite lands
  (see Build artifacts tasks): move `sync-db`/`webhook-server`/`atlcli-dir`
  out of the barrel that becomes the published `.`/`./node` export, or
  lazy-import `bun:sqlite` so only constructing the adapter — not importing
  the package — touches it. Then declare and test the actual Node/Bun
  support matrix (see Tasks) instead of asserting "Node/Bun/bundlers can
  load it" as given fact.
- Workspace development keeps working without a watch step: bun resolves
  `workspace:*` to the package root, and we keep the source TS reachable via
  a `development` condition listed **first** (`"development": "./src/index.ts"`)
  which Bun honors by default; publish artifacts are unaffected. If this
  proves flaky in practice, fallback is `turbo build --watch` during dev —
  decide in the first PR, do not block on it.
- **The `development` condition must not survive into the published
  manifest.** It points at `./src/index.ts`, which the `files` allowlist
  (`["dist", "fonts", "licenses", "README.md"]`) deliberately excludes from
  every tarball — so a `package.json` that ships `development` as-is has an
  `exports` target that can never resolve for an installed consumer, which
  directly contradicts the pack-check requirement below that "exports
  targets all exist inside the tarball". Keep two manifest shapes distinct:
  the **workspace** `package.json` (with `development` first, for in-repo
  DX) and the **published** manifest, from which a `prepack` step
  deterministically strips the `development` condition before `bun pm pack`
  runs. `pack-check.test.ts` validates only the manifest actually inside
  the tarball, so it never sees — and never has to special-case — the
  workspace-only condition.

### Package graph & what gets published

**What "published"/"publish set" means in this section today: fail-closed
distribution classification, not an active registry push.** No package in
this folder's active scope is pushed to a registry (see Goal). The
classification below still does real, immediate work: it is the source list
`pack-check`, the filesystem-link smoke, and the tarball-install smoke
iterate over, and — just as importantly — it is the mechanism that keeps
every package without an explicit decision from being publishable at all if
someone runs `npm publish` by hand tomorrow. Read every "publish"/
"publishable" below as "classified for external distribution (file-link/
tarball today, registry only if the Deferred appendix is revived)".

Publish set (dependency order): `plugin-api`, `core`, `diagram`, `jira`,
`confluence`, `docx`, `pdf`, `pdf-compiler-browser` (+ `export-macros` when it
exists, + `template-pack` once folder 007 lands — the new isomorphic
`packages/template-pack/` pack/unpack/validate package,
`007-pdf-template-settings/PLAN.md:137-140,293-338`, is exactly the kind of
shared byte-in/byte-out utility external template-contract consumers will
need, and folder 007 does not itself decide whether it's public). `apps/*`
stay private **by design, not by accident** — this must be enforced, not
assumed: `apps/cli/package.json` is *not* `private: true` today (see
Reference) and would be swept into any "publish everything non-private"
derivation. Internal deps switch from `workspace:*` to real semver ranges
**at pack time** (bun rewrites `workspace:*` to the current version on
`bun pm pack` — verify; if not, a prepack script rewrites them).

**Publish-set derivation is a positive classification, not "absence of
`private: true`".** A workspace package with no `private` field is a
demonstrated failure mode in this repo already, not a hypothetical: four of
today's eight publishable packages (`docx`, `pdf`, `diagram`,
`pdf-compiler-browser`) are `private: true` and need it removed, while
`apps/cli` has no `private` field and must *not* publish under this scope.
Add an explicit, required classification the publish pipeline reads (e.g. a
`"atlcli": { "publish": "public-stable" | "public-0.x" | "private" }` field
per `package.json`, or a single source-of-truth list owned by
`scripts/release.ts`); a package with neither an explicit `private: true`
nor an explicit publish classification fails the pipeline closed instead of
being silently included or excluded. `pack-check.test.ts` additionally
walks the publish set's runtime `dependencies` closure and fails if any
resolves to a `workspace:*` package missing a classification — catches a
forgotten `template-pack`-style addition before it becomes a silent leak or
a silent omission.

Each published package carries a `files` allowlist (e.g. `["dist", "fonts",
"licenses", "README.md"]`) so tarballs are deterministic. (`publishConfig.access`
is part of the registry setup and stays in the Deferred appendix — it has no
effect on filesystem-link or tarball consumption.) `README.md` does not exist
yet for any of the eight packages — creating it is a task below, not an
assumption.

### Versioning: lockstep train on the existing release script, no changesets

Decision: **fixed/lockstep versioning for all `@atlcli/*` packages** — not
changesets. (The extended-`scripts/release.ts` **publish** step described in
earlier drafts of this section is deferred along with the registry — see the
Deferred appendix. What remains active here is the version-numbering policy
itself, which every packed tarball and filesystem-linked consumer still
needs regardless of whether anything is ever pushed to a registry.)

- **Precondition: no path in the repo may be able to `npm publish` today.**
  Three independent paths currently *could* `npm publish` overlapping
  package sets: `scripts/release.ts` (no publish step today — and this
  folder does not add one), `.github/workflows/release-core.yml` (`core-v*`,
  publishes core/confluence/plugin-api), and
  `.github/workflows/release-cli.yml` (`cli-v*`, publishes `apps/cli`) — see
  Reference. Retiring or converting both `.yml` workflows into non-publishing
  wrappers (build+test only), and making every package's classification fail
  closed, is this folder's **highest-priority** task (see Tasks: Publish
  prevention) — not cleanup-later: every pack-check, API-report, and
  consumer-smoke gate this folder builds is meaningless as a *safeguard*
  while a maintainer can still trigger a raw `npm publish` from the old
  workflows without touching any of it.
- The repo already runs a single-version release train (root `version`,
  git-cliff changelog from Conventional Commits, one tag). Changesets would
  introduce a second changelog system, per-package version drift, and a bot
  workflow sized for many independent maintainers — none of which this repo
  has. Conventional Commit scopes (`feat(confluence):`) already give us the
  per-package story inside one changelog. This reasoning holds independent of
  publish target, so the decision stands even with registry publish deferred.
- Semver policy pre-1.0: breaking changes to the public API bump **minor** and
  must be listed under a "Breaking" changelog heading; patch releases are
  strictly non-breaking. At API freeze (T4.2 complete) the packages' own
  `package.json` versions jump to `1.0.0` and standard semver applies:
  breaking = major — this is a version-number and changelog commitment only;
  publishing `1.0.0` to a registry is deferred (see Goal and the Deferred
  appendix).

### Registry: deferred

The full registry design (npmjs.org vs. GitHub Packages, OIDC/Trusted
Publishing, the `publish-packages` CI job, resumable-publish verification via
`dist.integrity`) is preserved verbatim in the **Deferred: npm registry
publishing** section at the end of this document. It is not part of this
folder's active architecture — no package is published to any registry
today, and none of the build/pack/consumer-smoke architecture above depends
on it.

### Batteries-included Node consumer: `@atlcli/export-node` (new package)

Decision: **ship a ninth package, `@atlcli/export-node`**, gated on folders
002 and 008 landing (needs `fetchExportTree`/`composeChapters`/
`confluenceTreeSource` from T1.1–T1.3 and the Bun/Node PDF compile port from
T3.1) — additive to this folder's DoD, not a blocker for it.

- `BASELINE-DESIGN.md` §A5 (lines 163-184) already specifies this package by
  name with a concrete target DX (`nodePdfEnv`/`confluenceTreeSource`
  bundling wasm/font/output-sink wiring so a consumer goes from a page tree
  to a PDF/DOCX file in ~6 lines). Folder 002 implements
  `confluenceTreeSource` inside `packages/confluence` (T1.1) and the CLI
  headless story, but neither 002 nor this folder currently creates the
  packaging layer BASELINE-DESIGN promises.
- Without it, the publish set only ships low-level ports (`ExportEnv`,
  `PdfExportEnv`, `PdfCompilePort`) and external Node consumers must
  hand-wire wasm bytes, font bytes, and file-system adapters themselves —
  exactly the ceremony `fileOutputSink`/`fileTemplateSource`
  (`packages/docx/src/node-adapters.ts:21-38`, already proven isomorphic in
  `packages/docx/src/node-consumer.test.ts`) and the CLI's internal token
  asset resolution (`apps/cli/src/commands/export-internals.ts:118-159`)
  already solve once, just not publicly. Rebuilding it per-consumer is the
  gap between "technically consumable" and the "zero-egress, no job-polling"
  positioning this plan's Goal section claims against ScrollOffice.
- Mechanics: extract `fileOutputSink`/`fileTemplateSource` and the CLI's
  token `AssetFetcher` into `packages/export-node/src/{docx-env,pdf-env,
  tree-source}.ts`; add it to the publish set with its own
  `tsconfig.build.json`/exports/`files`; document the BASELINE-DESIGN A5
  target snippet as the package's minimal example in the consumer install
  docs (Tasks: Packaging documentation).
- **Default DOCX template.** `TemplateSource.getBytes(id)`
  (`packages/docx/src/env.ts:15-17`) has no built-in default — every host
  today supplies its own template bytes — yet a "batteries-included"
  package and the consumer-smoke DOCX test both need a working template
  with zero setup. No committed `.docx` template exists anywhere under
  `packages/docx` today (the package's own tests build minimal packages
  in-memory via `packages/docx/src/fixtures.ts`'s `buildDocx`, using
  PizZip, not a binary fixture). Prefer that same technique for
  `export-node`: a `bundledDefaultTemplate(): Uint8Array` built
  programmatically from `buildDocx`-style OOXML parts (headings, body,
  minimal styles) — this sidesteps font/branding licensing questions
  entirely, since nothing binary is shipped or redistributed. If a richer,
  branded starter template is wanted instead, that requires a licensed,
  committed `.docx` asset at a stable subpath (`@atlcli/export-node/
  templates/default.docx`) with its sha256 pinned in `runtime-assets.ts`-
  style code and verified by `pack-check`, same pattern as the PDF fonts.
  Decide which in the implementation PR; either way `pack-check` must
  structurally assert the default template resolves and produces a valid
  DOCX via `runExport`, not just that a file exists.

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

**This top-level list is necessary but not sufficient — the frozen surface
is whatever these seams transitively reach, not just their own names.**
Verified today: `PdfExportEnv` (`packages/pdf/src/run-export.ts:16-38`)
embeds `PdfCompilePort`, which in turn requires `PdfSourceBundle` and
`PdfCompilerDiagnostic` (`packages/pdf/src/compiler.ts:1,13`) — a consumer
cannot implement the frozen `PdfCompilePort` without those types also being
stable; `RunPdfExportInput` additionally reaches `PdfExportMetadata`,
`PdfProfile`, `PdfThemeOptions` (`packages/pdf/src/run-export.ts:5-13`,
`packages/pdf/src/types.ts`). `RunExportInput extends Omit<ExportInput, …>`
(`packages/docx/src/env.ts:75`) reaches `ConfluencePageDetails`,
`TemplateMeta`, `ResolveDeps` (`packages/docx/src/export.ts:112-118`). None
of these second-tier types is named above, so freezing only the top-level
list would leave the guard blind to breaking changes in the types the v1
seams are actually built from. Before the freeze release: for each
entrypoint, generate its reachable declaration closure from the built
`dist/*.d.ts` (the api-report generator below already flattens per-package
declarations; reuse it per-entrypoint rather than per-package) and
classify every reachable named type as `stable` (documented, frozen,
covered by the api-report diff), `experimental` (exported, documented as
unstable, excluded from the breaking-change policy), or `private` (not
reachable from a v1 entrypoint at all — move it out of the barrel). Commit
the classification next to each package's api-report. `@atlcli/core` and
`@atlcli/diagram` currently have no freeze decision even though both are
implicitly bound for 1.0: `core`'s barrel (`packages/core/src/index.ts`)
re-exports `auth.node`, `keychain`, `tls.node`, `templates/index` — CLI/Bun
internals, not seams any external export consumer needs — and `diagram`'s
(`packages/diagram/src/index.ts`) re-exports render internals alongside
`renderDiagram`. Classify both explicitly in the same pass; a package with
no reviewed classification stays 0.x at freeze time rather than jumping to
1.0 by default.

**The root barrels are far wider than this v1 list today** — publishing `.`
as specified in Build artifacts would make all of it part of the public
surface the moment it ships, guard or no guard:
`packages/docx/src/index.browser.ts` re-exports `scan.js`, `resolver.js`,
`serialize.js`, and `ooxml.js` helpers alongside `env.js`/`export.js`;
`packages/pdf/src/index.ts` re-exports `escape.js`, `compiler.js`,
`prepare.js`, `theme.js`, `validate.js` alongside `run-export.js`;
`packages/confluence/src/index.ts` re-exports all 23 modules including
`sync-db`/`webhook-server` (see Build output model above). A docs page
saying "internal" does not change what `import()` can reach. Before the
freeze release, each package's root `exports["."]` must be trimmed to the
documented v1 seams (re-export only those from the published entrypoint;
move the rest behind `./internal/*` or drop them from the barrel, still
reachable in-repo via the `development` condition) — the api-report guard
then reports exactly the surface the docs promise, instead of also silently
freezing every current implementation-detail export at 1.0.

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

### Publish prevention (do first — see Goal and Versioning precondition)

- [x] **Make every publishable package fail closed today, including
      `apps/cli`.** Add explicit `private: true` to every `package.json`
      under `packages/*` and `apps/*` that has neither `private: true` nor
      an `"atlcli": { "publish": … }` classification yet — concretely
      `apps/cli/package.json` today (see Reference: it has no `private`
      field and its `bin.atlcli` points at raw `src/index.ts`). Add a test
      (`scripts/publish-classification.test.ts`) that walks every workspace
      `package.json` and fails if any has neither `private: true` nor a
      recognized `atlcli.publish` value — the same fail-closed rule
      Architecture: Package graph specifies for the (currently inert)
      classification, enforced as a standing regression test starting now,
      not only once a publish pipeline exists.
- [x] Retire or convert `.github/workflows/release-core.yml` and
      `.github/workflows/release-cli.yml` into non-publishing wrappers
      (build+test only); remove or invalidate the `NPM_TOKEN` repo secret
      path they use. This is the acute risk while registry publishing is
      deferred: these two workflows can `npm publish` today, right now,
      bypassing every gate this folder builds (no pack-check, no dist
      build, no API report, no consumer smoke) — see Reference and
      Versioning precondition. CI-DoD: exactly **zero** workflow jobs in the
      repo may run `npm publish`, `npm stage publish`, or `bun publish`
      (earlier drafts of this section said "exactly one" for a canonical
      publish job; with registry publish deferred, the correct number today
      is zero — the canonical-publish-job design is preserved in the
      Deferred appendix for reuse later).

### Build artifacts

- [x] Add `tsconfig.build.json` + `"build": "tsc -p tsconfig.build.json"` +
      `"clean"` to each of `packages/{plugin-api,core,diagram,jira,confluence,docx,pdf,pdf-compiler-browser}/`;
      exclude `**/*.test.ts` (and `packages/docx/src/fixtures.ts` from the
      published `.` surface only if tests don't need it packaged — verify:
      it's an exported subpath today, keep `./fixtures` but mark it explicitly
      non-frozen dev API). Root `tsconfig.json` sets `noEmit: true`,
      `types: ["bun-types"]`, and monorepo-wide `include`
      (`apps/**/src/**/*.ts`, `packages/**/src/**/*.ts`) — a
      `tsconfig.build.json` that merely `extends` it inherits all three, so
      it must explicitly override: `noEmit: false` (otherwise `tsc` emits
      nothing regardless of `outDir`); a package-local `rootDir`/`include`
      (e.g. `["src/**/*.ts"]` relative to the package) so the compiled
      `dist/` and its `.d.ts`/`.map` files cannot pull in a sibling
      package's or an app's source path; and `lib`/`types` scoped to the
      package's actual runtime — do not blanket-inherit `bun-types` into a
      package whose declared `engines` (see below) include plain Node,
      since ambient Bun globals leaking into a public `.d.ts` break
      type-checking for consumers who never install `bun-types`. Regression
      test: after build, grep each package's `dist/**/*.{js,d.ts,map}` for
      any `../` path segment escaping the package root or another
      package's `src/`.
- [x] Rewrite `exports` in all eight `packages/*/package.json` to `dist/`
      targets, nesting `types` **inside** each of `browser`/`default`
      (never a shared top-level `types` — see Architecture: Build output
      model) so a browser consumer's type-checker cannot pick up Node-only
      declarations; keep raw-asset subpaths (`packages/docx`: `./fonts/*`;
      `packages/pdf`: `./fonts/*`, `./licenses/*`; `packages/pdf-compiler-browser`:
      new `./wasm`). Add a `development` condition pointing at `src/` for
      in-repo DX and verify `bun test` + `apps/cli` still run from source.
      Add the matching `prepack` step (`scripts/strip-dev-condition.ts`,
      reused by every publishable package) that deletes the `development`
      condition from the packed manifest before `bun pm pack` runs — see
      Architecture: Build output model — so the published `exports` never
      contains a target (`./src/index.ts`) that the `files` allowlist
      excludes from the tarball.
- [x] Fix `@atlcli/confluence`'s default (Node) entrypoint so it doesn't
      statically pull in `bun:sqlite` (see Architecture: Build output
      model): move `sync-db`/`webhook-server`/`atlcli-dir`
      (`packages/confluence/src/index.ts:1-24`) out of the barrel that
      becomes the published `.`/`./node` export, or lazy-import
      `SqliteAdapter` so constructing it — not importing the package —
      touches `bun:sqlite`. Regression test: importing the packed tarball's
      entrypoint under plain Node must not throw
      `Cannot find module 'bun:sqlite'`.
- [x] Trim each package's root `exports["."]` to the documented v1 seams
      (see Architecture: API freeze & guard architecture) — move
      implementation-detail modules (`scan.js`, `resolver.js`, `ooxml.js`
      helpers in `@atlcli/docx`; `escape.js`, `compiler.js`, `prepare.js`,
      `theme.js`, `validate.js` in `@atlcli/pdf`) behind `./internal/*` or
      out of the barrel, still reachable in-repo via the `development`
      condition.
- [x] Add `files` allowlists and remove `private: true` from
      `packages/{docx,pdf,diagram,pdf-compiler-browser}/package.json`;
      add `"sideEffects": false` where true (verify per package — the docx
      browser runtime mutates `globalThis.__atlDocxByteHelpers`, see
      `packages/docx/src/vite.ts`, so audit before claiming it).
- [x] Confirm `turbo.json` `build` inputs/outputs still describe reality
      (add `tsconfig.build.json` to `inputs`; keep `dist/**` outputs) and that
      `bun run build` builds packages in dependency order via `^build`.
- [x] Verify `apps/extension` and `apps/browser-export-harness` (Vite) resolve
      the new conditions correctly (Vite prefers `browser`); run
      `bun run check:browser` and the harness build
      (`bun run build:browser-export-harness`) as regression gates. Both
      apps still depend on `@atlcli/{confluence,docx,pdf,pdf-compiler-browser}`
      via `workspace:*` (`apps/extension/package.json`,
      `apps/browser-export-harness/package.json`), so this only proves the
      privileged in-repo resolution path — it does **not** prove Vite
      resolves the packed tarball's `exports`/`?url` conditions the way an
      external consumer's bundler would. See Consumer smoke below for the
      tarball-based Vite check that closes this gap.
- [x] Tests: a `bun test` suite (`scripts/pack-check.test.ts`) that runs
      `bun pm pack` per package into the scratch dir and asserts tarball
      contents — `dist/*.js`, `dist/*.d.ts` present; no `src/**/*.ts` leaked;
      asset files present (see Special cases); `exports` targets all exist
      inside the tarball (catches the classic broken-subpath publish).
- [x] Declare and test a Node/Bun/package-manager support matrix: add
      `engines` to each publishable `package.json` reflecting the real
      constraint (Bun-only vs. Node-LTS-compatible per package, after the
      `bun:sqlite` fix above), and extend `pack-check.test.ts` (or a sibling
      `install-matrix.test.ts`) to install the same tarballs with npm and
      pnpm, not only `bun add` — the Consumer smoke design below only
      proves the Bun path.

### Versioning & release

- [ ] **Decide `@atlcli/cli`'s fate as a *local* concern, not a publish
      decision — publishing it is deferred regardless of which way this
      goes.** `apps/cli/package.json` has no `private` field today (see
      Reference); the Publish prevention task above already makes this safe
      by adding an explicit `private: true`. What's left here: decide
      whether `apps/cli` still gets a real `build`/`dist` bin (it already has
      `apps/cli/build.ts`) as groundwork for a future filesystem-linked/
      tarball-installed Track 2 consumer story, or stays purely this repo's
      own CLI entry point with no external-consumption story at all. Either
      way, no npm registry publish of `@atlcli/cli` happens under this
      folder's active scope — the original "integrate vs. deprecate the `npm
      install -g @atlcli/cli` path" framing assumed a live publish and is
      preserved, unimplemented, in the Deferred appendix for whichever way
      the product rename lands.
- [x] Ensure `workspace:*` ranges are rewritten to concrete semver in packed
      tarballs; add a regression test in `scripts/release.test.ts` (inspect a
      packed manifest, assert no `workspace:` protocol survives). (Covered by
      `scripts/pack-check.test.ts` — it inspects every packed manifest and
      fails on any surviving `workspace:` range — plus the consumer-smoke and
      install-matrix suites, which assert the same on the *installed*
      manifests; a separate `release.test.ts` duplicate is unnecessary.)
- [ ] Document the semver policy (pre-1.0 minor-may-break, 1.0 at API freeze,
      Conventional-Commit scopes as the per-package changelog) as a new page
      under `src/content/docs/reference/` (sibling to the existing
      `docx-engine.md`/`pdf-engine.md`), registered in the `sidebar` array
      in `astro.config.mjs`, gated by `bun run docs:check`/`docs:build`
      (the repo's actual docs gates — there is no generic `docs/` folder)
      and link it from `CHANGELOG.md` generation notes; state explicitly
      that this is a version-numbering policy for packed/filesystem-linked
      artifacts today, and that registry publish is deferred (link to Goal
      and the Deferred appendix).
- [ ] Decide and implement the changesets question as **rejected** in code:
      no `.changeset/`; add a short "why lockstep" note to the same
      reference page so future contributors don't re-litigate it blindly.

### Packaging documentation

- [ ] Consumer install documentation page under `src/content/docs/reference/`
      (per docs standards: intro → prerequisites → steps → examples →
      troubleshooting, registered in `astro.config.mjs`'s `sidebar`):
      document the two supported install paths — **workspace/filesystem
      linking** (`file:` protocol or `bun link`, for a consumer checked out
      alongside this repo) and **packed-tarball install** (`bun pm pack`
      output installed with `bun add ./pkg.tgz` / `npm install ./pkg.tgz`) —
      with a minimal `runExport` example (DOCX) and an advanced
      `runPdfExport` example (PDF incl. wasm/fonts wiring for both Node-ish
      and Vite hosts), plus the `@atlcli/export-node` batteries-included
      snippet (Architecture: Batteries-included Node consumer) as the
      recommended Node starting point. Explicitly state that a package
      registry install (`npm install @atlcli/pdf` from a public registry) is
      **not** available today and link to the Deferred appendix for why.
- [ ] Add a short `README.md` to each of the eight publishable package
      roots (package role, stable entry points, runtime support — see
      support-matrix task above — minimal import example via filesystem
      linking or tarball install, link to the canonical reference page);
      include it in every package's `files` allowlist. None of the eight
      packages has one today.

### Batteries-included Node package (post folders 002/008 — additive, not a blocker)

- [ ] Scaffold `packages/export-node/` (own `package.json`,
      `tsconfig.build.json`, `exports`, `files` allowlist, `README.md`)
      following the same build/pack/publish contract as the other eight
      packages (Build artifacts, above); add it to the publish-set
      classification (Architecture: Package graph) so `pack-check`/
      `api-report`/consumer-smoke pick it up without a hardcoded list edit.
- [ ] Extract `fileOutputSink`/`fileTemplateSource`
      (`packages/docx/src/node-adapters.ts:21-38`, already isomorphic per
      `packages/docx/src/node-consumer.test.ts`) and the CLI's token
      `AssetFetcher` (`apps/cli/src/commands/export-internals.ts:118-159`)
      into `packages/export-node/src/{docx-env,pdf-env,tree-source}.ts`;
      the CLI switches to importing from the new package instead of
      duplicating the logic (regression: CLI DOCX/PDF export behavior
      unchanged, `bun test apps/cli`).
- [ ] Implement `nodePdfEnv(profile, opts)` / `confluenceTreeSource(profile)`
      matching the BASELINE-DESIGN A5 target snippet (§A5, lines 163-184)
      so it becomes a real, tested example rather than aspirational prose;
      wire folder 002's `fetchExportTree`/`composeChapters` (T1.1–T1.3) and
      folder 008's Bun/Node PDF compile port (T3.1) once both land.
- [ ] Implement the default DOCX template per Architecture (Batteries-
      included Node consumer): `bundledDefaultTemplate()` and wire it into
      `fileTemplateSource`'s default id resolution; `pack-check` asserts it
      produces a valid DOCX via a real `runExport` call, not just presence.
- [ ] Add `packages/export-node` to the Node-LTS and Bun consumer-smoke
      suites (Consumer smoke, below): the BASELINE-DESIGN A5 six-line
      snippet, run verbatim against the installed tarballs, must produce a
      real PDF.
- [ ] Update Build artifacts / Definition of Done package counts from
      eight to nine once this lands (kept separate here because it is
      gated on 002/008, per Architecture: Batteries-included Node
      consumer).

### Special cases (wasm/patch/fonts)

- [x] `@atlcli/pdf-compiler-browser`: add `scripts/vendor-typst.ts` (in
      `packages/pdf-compiler-browser/scripts/`) that copies the **patched**
      `pkg/` from this repo's installed
      `@myriaddreamin/typst-ts-web-compiler` into
      `packages/pdf-compiler-browser/vendor/typst-ts-web-compiler/`, asserts
      the patch markers (`Blocked unexpected dynamic function`) and a pinned
      sha256 of the `.mjs` + `.wasm`, and copies upstream's Apache-2.0
      LICENSE + NOTICE attribution.
- [x] Switch `packages/pdf-compiler-browser/src/compiler.ts` (and
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
- [x] Regression test (`packages/pdf-compiler-browser/src/vendor.test.ts`,
      no mocks): load the vendored `.mjs` under Bun, initialize with the
      vendored wasm bytes, compile a minimal bundle (reuse the pattern from
      `packages/pdf-compiler-browser/src/compiler.test.ts`), and assert the
      patch behavior directly — the glue must **throw** on an unexpected
      dynamic function body (unit-test the exported wrapper contract, not by
      grep alone).
- [x] `@atlcli/pdf` fonts: add `prepack` script that runs
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
- [x] Keep `runtime-assets.ts` as the single source of truth: `pack-check`
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
- [ ] **Classify the full reachable declaration closure, not just the named
      seams** (see Architecture: API freeze & guard architecture — the v1
      list is necessary but not sufficient). For each frozen entrypoint,
      generate its transitive `.d.ts` closure from `dist/` and mark every
      reachable type `stable`/`experimental`/`private`; confirmed gaps to
      resolve in this pass: `PdfSourceBundle`/`PdfCompilerDiagnostic`
      (`packages/pdf/src/compiler.ts`), `PdfExportMetadata`/`PdfProfile`/
      `PdfThemeOptions` (`packages/pdf/src/types.ts`),
      `ConfluencePageDetails`/`TemplateMeta`/`ResolveDeps`
      (`packages/docx/src/export.ts`). Explicitly decide and record
      `@atlcli/core` and `@atlcli/diagram`'s freeze status — their barrels
      are broad and largely CLI/Bun-internal (`packages/core/src/index.ts`)
      or renderer-internal (`packages/diagram/src/index.ts`) today; a
      package with no recorded decision stays 0.x rather than defaulting to
      1.0 with the rest.
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
      **Preserve, don't strip, `@deprecated`/`@since` JSDoc** in the
      normalized report (the flattener otherwise strips all comments) so a
      symbol silently losing its deprecation tag between releases shows up
      as a report diff — the breaking-change policy's "one minor with
      `@deprecated` before removal" promise is otherwise enforced only by
      reviewer memory, not by the guard.
- [ ] **Stabilize `ExportNote.code`.** It is typed as plain `string`
      (`packages/confluence/src/export-blocks.ts:119`, despite the doc
      comment "Stable machine code") — renaming or removing a code today
      produces no type error and no api-report diff. Introduce a central
      `ExportNoteCode` string-literal union (or const registry) in
      `packages/confluence`, exported as part of the v1 `ExportBlock`
      surface, and change `ExportNote.code` to that type. Add a test that
      walks every real emission site (`grep`-driven or a lint rule) and
      asserts each emitted code is a member of the registry — catches a
      code renamed at the call site without updating the union.
- [ ] Add regression coverage for the guard itself: a test fixture package
      surface where a removed export / changed signature produces a failing
      diff (guards the guard; no mocks — run the real generator on a tiny
      fixture entrypoint under the scratch of the test).
- [ ] Bump all frozen packages' `package.json` version to `1.0.0`; changelog
      entry documents the frozen surface and links the docs pages. This is a
      version-number and changelog commitment, verified via the tarball and
      filesystem-link consumer smoke — publishing `1.0.0` to a registry is
      deferred (see Goal and the Deferred appendix).

### Consumer smoke

- [x] `scripts/consumer-smoke.ts` (+ `scripts/consumer-smoke.test.ts` wiring
      it into `bun test` behind an env flag for CI): creates a temp project
      via `bun init` in the scratch dir, runs `bun pm pack` for every
      publishable package, installs the **local tarballs** (`bun add
      ./atlcli-core-<v>.tgz …` in dependency order, with internal ranges
      resolving to the sibling tarballs), and asserts installation succeeds
      with no `workspace:` leakage. Real packages, real wasm, no registry —
      and no mocks anywhere in this suite.
- [x] **Filesystem-link smoke** (`scripts/consumer-smoke-filelink.ts`, wired
      into `bun test` next to the tarball suite): scaffold a throwaway
      consumer project that declares `@atlcli/docx`/`@atlcli/pdf` (and their
      transitive `@atlcli/*` deps) as `file:`-protocol dependencies pointing
      directly at the package directories (built `dist/`, not `src/`),
      installs via `bun install`, and repeats the DOCX/PDF smoke assertions
      from the two bullets below against the linked packages. This is
      currently the most likely Track 2 consumption path (a Forge app
      linking against this repo or a sibling checkout, see Goal) and is not
      exercised by the tarball-install suite, which only proves `bun pm
      pack` output.
- [x] DOCX smoke inside the temp project: a script that imports `runExport`
      from the installed `@atlcli/docx`, provides a minimal real `ExportEnv`
      (template bytes from the installed package's shipped default template
      path — verify what `TemplateSource` needs and ship a usable default;
      in-memory `OutputSink`), feeds a storage-XML fixture through
      `storageToBlocks` from installed `@atlcli/confluence`, and asserts the
      emitted bytes are a valid DOCX (unzip, check `word/document.xml`
      contains the fixture heading).
- [x] PDF smoke inside the temp project: imports `runPdfExport` from installed
      `@atlcli/pdf` and `BrowserPdfCompiler` from installed
      `@atlcli/pdf-compiler-browser`, loads wasm bytes from the installed
      package's `./wasm` subpath and fonts from installed
      `@atlcli/pdf/fonts/*` via `import.meta.resolve` (the exact pattern
      already proven in `packages/pdf-compiler-browser/src/compiler.test.ts`,
      but now against `node_modules`, not the workspace), compiles a fixture,
      and asserts `%PDF-` magic bytes + `validatePdfOutput` passes.
- [x] Type-consumption check in the temp project: `tsc --noEmit` against a
      consumer `main.ts` importing from `@atlcli/{docx,pdf,confluence,pdf-compiler-browser}`
      with `"skipLibCheck": false` — proves shipped `.d.ts` are self-contained
      (catches leaked `src/` type imports and missing declaration deps).
- [x] **Node-LTS tarball smoke** (`scripts/consumer-smoke-node.ts`), separate
      from the Bun-based suite above: a fresh `npm init` project on the
      oldest supported Node LTS (per the `engines` support-matrix task in
      Build artifacts), `"moduleResolution": "NodeNext"`,
      `"skipLibCheck": false`, installs the same local tarballs with `npm
      install`, imports every stable entrypoint the support matrix marks
      Node-compatible, and runs a real `runExport` — this is the check that
      actually proves the `bun:sqlite` fix (Build artifacts) holds for a
      plain-Node consumer, not just that `pack-check` didn't find the
      string `bun:sqlite` in the tarball.
- [ ] **Vite tarball smoke** (`scripts/consumer-smoke-vite/`, a throwaway
      Vite project scaffolded in the scratch dir, not `apps/extension` or
      `apps/browser-export-harness` — those still resolve `workspace:*`,
      see Build artifacts): install the packed tarballs, configure Vite
      with the same `browser` condition preference the harness uses, import
      `@atlcli/pdf-compiler-browser/wasm?url` and `@atlcli/pdf/fonts/*.ttf?url`
      exactly as `apps/browser-export-harness/src/pdf-worker.ts` does today,
      run `vite build` (production, not dev-server) to prove the assets
      survive bundling, and — reusing
      `packages/pdf-compiler-browser/src/compiler.test.ts`'s pattern —
      compile a fixture inside a Worker to real PDF bytes. Fails if any
      resolution falls through to a `src/` path or a `workspace:` symlink.
- [x] CI job (`.github/workflows/`): run the consumer smoke on every PR that
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
  `tsc --noEmit` type-consumption check, plus the Node-LTS (`NodeNext`) and
  Vite production-build tarball smokes pass, **plus the filesystem-link
  smoke** (a consumer project depending on `@atlcli/docx`/`@atlcli/pdf` via
  `file:` protocol produces the same real DOCX/PDF output) — proving both
  supported external-consumption paths (tarball install and filesystem/
  workspace linking), not only the privileged in-repo workspace resolution.
- **No live publish path exists in the repo.** `release-core.yml` and
  `release-cli.yml` are non-publishing wrappers (or retired); no CI job or
  script in the repo calls `npm publish`, `npm stage publish`, or
  `bun publish`; the `publish-classification.test.ts` regression test
  (Tasks: Publish prevention) confirms every workspace `package.json` has
  either explicit `private: true` or a recognized `atlcli.publish`
  classification, and that classification resolves to "not published" for
  every package today — verified by asserting no workflow YAML invokes a
  publish command and that a manual `npm publish` from any package
  directory fails without first reconfiguring registry credentials that
  don't exist in this repo. Reviving publishing requires deliberately
  implementing the Deferred appendix, not flipping a flag.
- `bun scripts/release.ts minor --dry-run` prints the packaging-readiness
  plan (version bump across publishable packages, pack-check, consumer
  smoke including the filesystem-link smoke) with **no publish step** —
  consistent with the deferred status. (The extended dry-run output that
  included a `publish-packages` trigger and sign-off check is preserved in
  the Deferred appendix.)
- Docs (first-class, same PR as behavior changes): consumer install guide
  covering filesystem/workspace linking and tarball install (no registry
  install documented — see the Deferred appendix for that), `?url`
  asset-contract reference, public API reference with breaking-change
  policy — all following the `docs/` standards (TOC, related topics,
  minimal + advanced examples).
- API reports committed for every package, including preserved
  `@deprecated`/`@since` tags and a classified declaration closure (not just
  the top-level seams) per entrypoint; `api-report.test.ts` fails CI on any
  unreviewed public-surface diff; frozen packages bump their `package.json`
  version to `1.0.0` (this last bullet only after folders 001–008 land) —
  registry publish of that `1.0.0` remains deferred.
- `@atlcli/export-node` ships with a working `bundledDefaultTemplate()` and
  passes its own tarball and filesystem-link smoke, once folders 002 and 008
  land (additive — not a blocker for the rest of this DoD, per Architecture:
  Batteries-included Node consumer).
- E2E gate executed against DOCSY/mayflower with the packed CLI; test
  resources cleaned up.

## Risks & open questions

- **Product name / npm scope not final; registry publish deliberately
  deferred.** `atlcli` is likely to be renamed, which would make any
  `@atlcli/*` npm publish today a wasted, unrecoverable scope claim (see
  Goal). The most likely Track 2 consumer (a Forge app) will probably
  install these packages via filesystem/workspace linking rather than a
  registry, but that consumption path is not yet finally decided either.
  Practical implication: everything in this folder's active scope (build,
  packaging, classification, consumer smoke, API freeze) must work without
  assuming a registry exists, and nothing here may create a live publish
  path (see Tasks: Publish prevention). When the product name and the
  Forge-app consumption path are both decided, resuming this work means
  reviewing the **Deferred: npm registry publishing** section below against
  whatever the new name/scope is — the OIDC/workflow/sign-off-artifact
  design there was written against `@atlcli/*` and the current CI topology
  and should be re-verified, not blindly re-enabled, before any first
  publish.
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
  pipeline must still pick it up automatically once it lands, via its
  positive `"atlcli": { "publish": … }` classification (see Architecture:
  Package graph & what gets published) — **not** via "absence of `private:
  true`", which that same section explicitly rejects as unsafe
  (`apps/cli/package.json` already demonstrates why: no `private` field,
  not meant to publish under this scope). Concretely: `export-macros`'
  first commit must add the classification field in the same PR that adds
  the package, or the fail-closed publish-set derivation refuses to
  include it and CI catches the omission — never a hardcoded list, but
  also never implicit inclusion by default.

Two further risks (lockstep-publish atomicity on a public registry, and the
missing owner for a formal "M1 acceptance record") apply only once registry
publishing is implemented; they are preserved in the Deferred appendix below
rather than listed here as live concerns.

---

## Deferred: npm registry publishing (DO NOT IMPLEMENT — blocked on product rename decision)

**This section is preserved design work, not an active task list.
Implementation agents must NOT build anything in this section.** It exists so
the design effort already spent on registry publishing is not lost, and can
be picked up again once the `atlcli` product-name/rename decision and the
Forge app's consumption path (filesystem linking vs. registry) are both
settled (see Goal and Risks). Every checkbox below is intentionally written
as a plain bullet, not `- [ ]`, so it cannot be mistaken for an open task in
this folder's Definition of Done or counted by any task tracker.

Before reviving any of this: re-verify it against the then-current product
name/npm scope and CI topology — this design was written against `@atlcli/*`
and the workflow files as they exist as of 2026-07-19; it should not be
re-enabled blindly.

### Architecture (deferred)

**Registry: npmjs.org under `@atlcli`, GitHub Packages as documented
fallback.**

Decision (as originally designed): public npm registry (registry.npmjs.org),
scope `@atlcli`, `publishConfig.access: "public"`.

- [DEFERRED] The code is Apache-2.0 in a public repo; there is no secrecy to
  protect, and the external consumer track should not need registry auth
  just to *install*.
- [DEFERRED] GitHub Packages has a hard constraint: npm packages must be
  scoped to the **repo owner's** user/org namespace. The repo owner is
  `BjoernSchotte`, so `@atlcli/*` cannot be published to GitHub Packages
  unless a GitHub org named `atlcli` is created and the repo (or a
  publishing mirror) lives there. That makes GitHub Packages the fallback,
  not the default.
- [DEFERRED] Auth is documented for both directions: publishing needs an
  npm automation token in CI / `NPM_TOKEN`; the GitHub Packages fallback
  needs the classic `.npmrc`/`bunfig.toml` scoped-registry + token setup,
  documented even if unused, because some external consumers may proxy
  through it.
- [DEFERRED] **Publish auth: prefer npm Trusted Publishing (OIDC) over a
  long-lived `NPM_TOKEN`.** npm's GitHub Actions OIDC integration issues
  short-lived, per-run credentials and can auto-attach provenance
  ([npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/));
  npm's staged publishing additionally holds a package invisible until an
  explicit promote step
  ([npm Staged Publishing](https://docs.npmjs.com/staged-publishing/)). A
  static `NPM_TOKEN` repo secret is exactly the pattern the two legacy
  workflows (`release-core.yml`/`release-cli.yml`) already use — do not
  repeat it for the canonical path. Bootstrap exception: the very first
  publish of a brand-new package name cannot use OIDC (npm requires the
  package to already exist to link a Trusted Publisher), so document a
  one-time manual bootstrap publish (2FA, scoped token, revoked immediately
  after) per new package name, then switch that package to OIDC for every
  subsequent release.
- [DEFERRED] **OIDC forces the actual `npm publish` call into a GitHub
  Actions job — it cannot happen from `scripts/release.ts` itself.** npm's
  Trusted Publishing verifies the *GitHub Actions* OIDC token
  (`permissions: id-token: write` on the job), which only exists inside a
  workflow run; a short-lived credential is never available to a script
  invoked from a developer's terminal (`bun scripts/release.ts <type>`, per
  the CLAUDE.md release workflow — "always dry-run first" implies a human
  runs it locally). The two retired-or-converted legacy workflows
  (`release-core.yml`, `release-cli.yml`) sidestep this by using a static
  `NPM_TOKEN`; the canonical path cannot repeat that and also claim OIDC.
  Resolution, mirroring the pattern `waitForRelease()` already uses for
  GitHub release artifacts: `release.ts` pushes the `v*` tag as today, then
  a new `publish-packages` job in `.github/workflows/release.yml` — gated
  on that exact tag, `permissions: { id-token: write }`, an explicit
  required GitHub `environment` (same mechanism `docs.yml:59` already uses
  in this repo) — checks out the tagged commit, re-runs pack-check/
  api-report/consumer-smoke as blocking steps, and OIDC-publishes in
  dependency order; `release.ts` triggers/polls that job (`gh api
  repos/.../actions/runs`, same idiom as `waitForRelease`) instead of
  calling `npm publish` in-process. This makes the CI job — not the local
  script — the sole technically-enforceable publish authority.
- [DEFERRED] **The publish gates must not depend on `release.ts`'s existing
  free-text test check.** `runTests()` in `scripts/release.ts` treats `bun
  test` as passed by string-matching stdout/stderr for `"fail"` /
  `"0 fail"` rather than checking the process exit code, and is skippable
  entirely via `--skip-tests`. Neither property may leak into the publish
  gate: the `publish-packages` job's pack-check/api-report/consumer-smoke
  steps must run as ordinary `bun test` invocations under `$` (which throws
  on non-zero exit) inside CI, independently of whatever flags were passed
  to the local `release.ts` invocation that triggered the tag push —
  `--skip-tests` skips only `release.ts`'s own local pre-flight, never the
  CI publish gate.
- [DEFERRED] **Resumable publish must verify, not just skip.** The "skip
  versions already on the registry" resumability described below is only
  safe if a skipped version is guaranteed identical to what would have been
  published. Store each package's packed-tarball **SRI sha512** (not
  sha256 — `npm view <pkg>@<version> dist.shasum` is a legacy **sha1** of
  the tarball, so a sha256 comparison against it would always mismatch;
  `dist.integrity` is the modern SRI field and is what `npm pack`/`bun pm
  pack` can both produce) in `ReleaseState` at pack time; on resume, before
  skipping an already-present registry version, compare it against `npm
  view <pkg>@<version> dist.integrity` and hard-abort the release on
  mismatch instead of silently treating "present" as "correct".
- [DEFERRED] `release.ts` gains a step that sets every publishable package
  to the release version (reusing the existing `npm version
  --no-git-tag-version -w …` pattern from root `version:core`), packs, and
  publishes after the GitHub Release artifacts are confirmed. Publishing is
  **idempotent and resumable** (skip versions already on the registry) so a
  half-failed release can be re-run, matching the script's existing
  rollback philosophy.

### Tasks (deferred — do not implement)

- [DEFERRED] **Decide `@atlcli/cli`'s fate as a live, promoted npm install
  path.** `release-cli.yml:77-105` publishes `@atlcli/cli` and its GitHub
  Release body advertises `npm install -g @atlcli/cli` and
  `bunx @atlcli/cli`. Original framing, preserved for reuse: (a)
  **Integrate** — set `apps/cli` up with a real `build`/`dist` bin, add it
  to the canonical publish set with its own npm/bunx tarball-install smoke,
  keep `npm install -g @atlcli/cli` working; or (b) **Deprecate** — ship one
  final `@atlcli/cli` release whose README/postinstall notice points at the
  successor (Homebrew tap / standalone binaries from `release.yml`),
  document a support window in `CHANGELOG.md` and the consumer install
  docs, then set `apps/cli` to explicit `private: true` and stop publishing
  it. (The active-scope version of this task — making `apps/cli` fail
  closed today regardless of which way this eventually goes — lives in
  Tasks: Publish prevention and Versioning & release.)
- [DEFERRED] **Add a tag-gated `publish-packages` job to
  `.github/workflows/release.yml`**: triggered by the same `v*` tag push as
  the existing `build`/`release` jobs, `permissions: { id-token: write }`, a
  required GitHub `environment` (same mechanism already used in
  `docs.yml:59`), `actions/checkout` pinned to the exact tagged commit SHA
  (never a branch). Steps, all blocking: rebuild every publishable package,
  re-run `pack-check.test.ts`/`api-report.test.ts`/consumer-smoke as real
  `bun test` invocations, verify the sign-off artifact (next item) matches
  `GITHUB_SHA`, then `npm publish` each package via OIDC in dependency
  order. Any gate failure fails the job and leaves nothing published for
  that package.
- [DEFERRED] **Define the machine-checked release sign-off artifact — the
  canonical schema.** Add a committed schema
  (`specs/export-expansion/009-package-publishing/release-signoff.schema.json`
  or a `scripts/release-signoff.ts` type) for the record the
  `publish-packages` job (and `release.ts`'s pre-flight) validate before a
  **first-ever** public-registry publish runs without `--dry-run`: commit
  SHA it's bound to, M1 acceptance reference (the M1 conformance run has no
  artifact today; this task would define the shape it must produce, not
  just what 009 consumes), reviewed tarball SHA-512/SRI digests, a named
  reviewer, structured T4.7 scope/result, and an embedded `security`
  sub-object carrying exactly 011-quality-gates' `security-attestation.json`
  fields (`{commit, date, veraPdfDigestOk, veraPdfBaselineDelta,
  securityReviewNote, m1AcceptanceOk}` — `011-quality-gates/PLAN.md`,
  PDF/UA — "HEAD-bound security attestation artifact"), unchanged shape.
  This would be the canonical release sign-off artifact: 011's
  `scripts/security/attest.ts` job keeps emitting that sub-object on every
  push to `main` and on release tags regardless of this section's status
  (independently useful outside a release — see 011-quality-gates'
  cross-plan note); this validator — assembling and checking the whole
  record, top-level fields plus the embedded `security` sub-object — is
  what's deferred. The validator would hard-fail (not warn) on a missing
  file, a SHA mismatch against `GITHUB_SHA`, a stale/mismatched
  `security.commit`, or a schema violation.
- [DEFERRED] Extend `scripts/release.ts` with a package-publish stage that
  **triggers and polls** the `publish-packages` workflow run for the pushed
  tag (mirroring the existing `waitForRelease()` polling pattern — `gh api
  repos/.../actions/runs?...`), rather than calling `npm publish` itself:
  set all publishable packages to the release version locally first (reuse
  the `npm version --no-git-tag-version -w` pattern from root
  `version:core`), commit that alongside `package.json`/`CHANGELOG.md`
  (extend `commitRelease()`'s `git add` to include every publishable
  `packages/*/package.json` and `bun.lock`, and extend `rollback()`'s `git
  restore --source` list to match), push the tag, then wait for
  `publish-packages` to finish. Registry publishes inside that job are
  non-rollbackable — treat like `mainPushed`: warn, never rewrite.
- [DEFERRED] **Post-publish full-graph registry smoke.** After
  `publish-packages` succeeds, add a final step that installs the
  just-published versions of every package from the registry (not the local
  tarballs) into a scratch project and repeats the DOCX/PDF consumer smoke
  against them. A sequential per-package publish on the public registry has
  no atomic "promote the whole lockstep set" step (unlike npm's opt-in
  staged-publishing beta, which this plan does not adopt), so a failure
  partway through can leave some packages at the new `latest` and others at
  the old one; this step would be the loud, automated check that the
  *complete* graph is installable and mutually compatible at the tagged
  version before the release is considered done.
- [DEFERRED] Update `showDryRunPlan()` in `scripts/release.ts` so
  `--dry-run` prints the publish steps (including the `publish-packages`
  trigger and the sign-off check).
- [DEFERRED] Register/verify ownership of the `@atlcli` scope on
  registry.npmjs.org; set `"publishConfig": { "access": "public" }` in
  every publishable `packages/*/package.json`.
- [DEFERRED] Set up npm Trusted Publishing (OIDC) for the canonical release
  workflow: `id-token: write` permission, GitHub Actions OIDC linked as a
  Trusted Publisher per package on npmjs.org, automatic provenance.
  Document the one-time manual bootstrap publish (2FA, short-lived scoped
  token, revoked immediately after) required for each brand-new package
  name before OIDC can be linked. No long-lived `NPM_TOKEN` in the
  canonical path once bootstrapped; keep a documented, revoked-by-default
  `NPM_TOKEN` procedure only as an emergency/local fallback (`~/.npmrc`
  guidance).
- [DEFERRED] Document the GitHub Packages fallback as a new page under
  `src/content/docs/reference/`: scoped-registry `.npmrc`/`bunfig.toml`
  (`@atlcli:registry=…` + `//…/:_authToken`), the owner-scope constraint
  (requires an `atlcli` GitHub org), and consumer-side read auth — labeled
  clearly as the non-default path.
- [DEFERRED] Extend the consumer install documentation with an npm-install
  guide (`npm install`/`bun add`/`pnpm add` against the public registry,
  `bunx @atlcli/cli`) once registry publish exists, alongside the
  filesystem-link/tarball guidance that ships in this folder's active scope.

### Definition of Done (deferred — for when registry publishing resumes)

- Exactly one path in the repo can publish to the registry: the tag-gated
  `publish-packages` job in `.github/workflows/release.yml` — with
  `id-token: write`, a required environment, and OIDC — is the sole
  `npm publish` caller; `scripts/release.ts` only triggers and polls it.
  `apps/cli`/`@atlcli/cli` has an explicit, deliberate publish outcome
  (integrated with a working bin, or deprecated with a documented migration
  path).
- A real release publishes all packages via the CI publish job in
  dependency order, is resumable after partial failure (verified against
  `dist.integrity`), and a post-publish full-graph registry smoke confirms
  every package is installable at the tagged version before the release is
  considered done.
- The first-ever public-registry publish is blocked by the release
  sign-off artifact (commit-bound M1 acceptance + T4.7 security-review
  record) failing to validate.
- Registry/auth reference docs (npm primary, GitHub Packages fallback) are
  published alongside the filesystem-link/tarball guide.

### Risks (deferred)

- **`@atlcli` npm scope ownership** — is the scope free/owned by us on
  registry.npmjs.org? If squatted, options are: GitHub org `atlcli` + GitHub
  Packages (fallback design above) or a scope rename (`@atlcli-dev/*`),
  which would ripple through every import. Would need resolving before any
  publish; the rest of this plan is scope-agnostic.
- **GitHub Packages owner-scope constraint** — confirmed blocker for
  `@atlcli/*` under owner `BjoernSchotte`; only relevant if npm falls
  through.
- **Lockstep publish is not atomic on the public registry.** This design
  deliberately does not adopt npm's staged-publishing beta (its
  availability and fit with the "no changesets, minimal tooling" decision
  are unverified). Publishing the lockstep set would be a sequence of
  independent `npm publish` calls; a mid-sequence failure could leave some
  packages at the new `latest` and others at the previous version until the
  release is retried. Mitigation: the post-publish full-graph registry
  smoke makes this loud immediately instead of via an external bug report,
  and resumability (verified via `dist.integrity`) means retrying only
  publishes the missing packages. If staged publishing later proves
  available and worthwhile, adopting it would be a follow-up.
- **No folder in this spec series currently owns producing a formal "M1
  acceptance record."** `UMSETZUNGSPLAN.md:111-131` defines M1's acceptance
  criteria narratively (byte-stable goldens across CLI and harness for a
  50-page tree) but not as a committed artifact, and M1 spans multiple
  lanes/folders with no single owner file. This folder's deferred sign-off
  schema validates that record but does not itself produce the M1 half of
  it — whoever revives this section still needs to resolve that ownership
  gap first.
