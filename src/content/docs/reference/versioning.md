---
title: "Package Versioning"
description: "Product CalVer and library SemVer: release numbering, API compatibility, and deferred registry publishing"
---

# Package Versioning

Version-numbering policy for the eight publishable `@atlcli/*` packages. **This governs
packed-tarball and filesystem-linked artifacts only** — publishing to a package registry is
deliberately deferred (product rename pending; see the "Deferred: npm registry publishing"
appendix in `specs/export-expansion/009-package-publishing/PLAN.md`), and no CI path in this
repo can publish.

## In this page

- [Product releases: CalVer](#product-releases-calver)
- [Lockstep versioning](#lockstep-versioning)
- [Pre-1.0 semver rules](#pre-10-semver-rules)
- [1.0 and the API freeze](#10-and-the-api-freeze)
- [What counts as breaking](#what-counts-as-breaking)
- [Post-freeze contract changes](#post-freeze-contract-changes)
- [Per-package changelog](#per-package-changelog)
- [Why lockstep, not changesets](#why-lockstep-not-changesets)
- [Related topics](#related-topics)

## Product releases: CalVer

The CLI and Chrome extension share one calendar version, `YYYY.M.N`:

- `YYYY` is the four-digit year and `M` the month, both from **UTC**.
- `N` counts releases in that month, starting at 1. It is not the day of the month.
- No leading zeroes: `2026.9.12` precedes `2026.10.1`; the next October release is `2026.10.2`.
- Git tags are `v<version>`, for example `v2026.10.1`. Existing `v0.x` tags remain valid history.

The root `package.json` owns the product version. The release script allocates
the next number from reserved stable tags and requires the tag and package
version to match. A tag reserved by a failed release still consumes its number.
Dev tags retain their `dev-YYYYMMDD.<run>.<attempt>-<sha8>` format and use the
root product version as their CLI prerelease base.

**CalVer does not signal API compatibility.** Breaking product changes appear
under **Breaking changes** in the changelog with migration instructions.
Existing JSON/schema contracts keep their own versioning rules.

The examples above illustrate numbering; they are not a release announcement.
See [Contributing: Releasing](/contributing/#releasing) for a minimal dry-run
and a complete release workflow.

## Lockstep versioning

The `@atlcli/*` libraries retain **SemVer**, independently of product CalVer.
They are developed and tested together and share the scoped git-cliff changelog;
there is no independent registry release schedule. A product release updates
only the root version, not every workspace manifest. Since the API freeze there
are **two version tiers**: the frozen set at `1.0.0`
(`confluence`, `docx`, `pdf`, `pdf-compiler-browser`, `export-macros`) and the rest still at
`0.x` (see the [freeze table](#10-and-the-api-freeze)). Internal `@atlcli/*` dependencies use
`workspace:*`, which `bun pm pack` rewrites to each dependency's **concrete current version**
at pack time — so a packed tarball resolves its siblings to whatever version they carry at
that commit (mixed `1.0.0`/`0.x` today), not to a single train number.

What the tooling actually verifies: `scripts/pack-check.test.ts` asserts no `workspace:` range
survives into a packed manifest and that every `exports` target exists in the tarball; the
consumer-smoke suites additionally assert no `workspace:` leakage in the *installed* manifests
and that the packages build and export end-to-end. Neither asserts a single uniform version
across packages — that uniformity is a development-process convention, not a checked invariant.

## Pre-1.0 semver rules

While a package is `0.x`:

- **Breaking changes bump the minor** and must appear under a "Breaking" changelog heading.
- **Patch releases are strictly non-breaking.**

## 1.0 and the API freeze

**The freeze (spec 009 T4.2) is executed** — the export-expansion folders 001–008 landed and
five packages froze at `1.0.0` with reviewed closure classifications (committed at
`packages/<p>/etc/<p>.closure.md`, CI-guarded together with the api reports). Standard semver
applies to frozen packages (breaking = major, with one `@deprecated` minor first); the pre-1.0
rules keep applying to the rest. A registry publish remains deferred either way.

| Package | Version | Frozen | Why |
|---|---|---|---|
| `@atlcli/confluence` | 1.0.0 | yes | Core v1 seams: `ExportBlock`/`storageToBlocks`, `ExportNoteCode` registry, client, `TreeSource`/`fetchExportTree`/`composeChapters` |
| `@atlcli/docx` | 1.0.0 | yes | `ExportEnv`/`runExport` seams, proven across three hosts; internals behind `./scan`/`./internal` |
| `@atlcli/pdf` | 1.0.0 | yes | `PdfExportEnv`/`runPdfExport` + `PdfCompilePort` contract; internals behind `./internal` |
| `@atlcli/pdf-compiler-browser` | 1.0.0 | yes | Tiny stable surface over the sha256-pinned vendored compiler |
| `@atlcli/export-macros` | 1.0.0 | yes | `MacroRendererRegistry`/`resolveMacroBlocks` contract is embedded in the frozen docx/pdf surfaces; the renderer *set* may grow additively |
| `@atlcli/core` | 0.6.0 | no | Barrel is largely CLI/Bun-internal; frozen packages freeze only their *use* of its types (frozen-by-closure) |
| `@atlcli/diagram` | 0.6.0 | no | Renderer-internal beyond `renderDiagram`/`DiagramTheme` (frozen-by-closure via docx) |
| `@atlcli/jira` | 0.6.0 | no | Never API-reviewed; Bun-only engines |
| `@atlcli/plugin-api` | 0.6.0 | no | Never API-reviewed |
| `@atlcli/template-pack` | 0.6.0 | no | Spec 007 did not decide public-API status; the byte format has its own manifest versioning |
| `@atlcli/export-node` | 0.6.0 | no | Days old; convenience surface should harden against real consumers first |
| `@atlcli/export-wiring` | 0.1.0 | no | Created in spec 010 by promoting the CLI's host-wiring module so the extension stops carrying a second copy; its shape still follows the hosts |

## What counts as breaking

- Removed or renamed exports from a published entrypoint
- Narrowed input types or widened output types of the frozen seams
- Changed or removed `exports` subpaths (including asset subpaths — see the
  [Export Asset Contract](/reference/asset-contract/))
- Changed asset filenames (fonts, wasm)
- Tightened `engines` (dropping a supported runtime)

Deprecations get one minor release with `@deprecated` JSDoc before removal.

## Post-freeze contract changes

Changes that break a frozen v1 seam **without** the usual `@deprecated`-minor cycle are
recorded here, with the reasoning, so the exception stays visible instead of being rediscovered
from a diff. The cycle is skippable today for exactly one reason: **nothing is published**, so a
frozen package has no installed base to migrate — there are no consumers outside this repo and
its consumer-smoke matrix. Once a registry publish happens, this list closes and the normal
policy applies without exception.

### `PdfOutputSink.emit` takes a `PdfBytesHandle` (spec 010)

`@atlcli/pdf` — `emit(name, bytes, context?)`'s second parameter changed from `Uint8Array` to
[`PdfBytesHandle`](/reference/export-api/#emitting-compiled-bytes-pdfoutputsink--pdfbyteshandle).

- **Why.** Every layer that wanted a different shape of the finished document built its own
  copy of it. The extension's download path held `new Blob([bytes])` while the caller's
  `Uint8Array` was still reachable — a measured +64.0 MiB for a 64 MiB PDF, both copies live at
  once. A handle owns one representation and converts on demand, so the same document is never
  materialized twice in two shapes.
- **Migration.** A sink that wants bytes calls `await bytes.asUint8Array()`; for the default
  array-backed handle that is the compiler's own buffer, not a copy. A sink that wants a `Blob`
  or an object URL asks for one directly instead of constructing it.
- **Why no deprecation minor.** An overload accepting both shapes would have kept every
  consumer's `new Blob([...])` path — the exact allocation the change removes — alive and
  type-legal for a release, in exchange for migrating an installed base of zero.
- **Guarded by.** The consumer-smoke suites (`scripts/consumer-smoke.ts`,
  `scripts/consumer-smoke-vite.ts`) assert the handle contract from an external consumer's
  position against the packed tarballs — both the runtime shape and, under
  `moduleResolution: NodeNext` with `skipLibCheck: false`, that a consumer can name
  `PdfBytesHandle` and type a sink against it.

## Per-package changelog

There is one `CHANGELOG.md`, generated from Conventional Commits. The **commit scope is the
per-package story**: `feat(confluence): …`, `fix(pdf): …`, `feat(docx)!: …` — filtering the
changelog by scope yields each package's history without a second changelog system.

## Why lockstep, not changesets

Considered and **rejected** (decision recorded here so it isn't re-litigated blindly):

- The repo already runs a single product release train with one changelog and one tag;
  changesets would add a second changelog system and a bot workflow sized for many
  independent maintainers, which this repo doesn't have.
- Independent release schedules would add compatibility combinations between
  sibling packages that are developed and tested together. The existing API-freeze
  version tiers remain intentional.
- Conventional-Commit scopes already deliver the per-package changelog story.

This reasoning is independent of the publish target, so it holds while registry publishing is
deferred. Consequently there is no `.changeset/` directory in this repo.

## `apps/cli` stays internal

`apps/cli` (`@atlcli/cli`) is **not** part of the publishable set: it stays this repo's own
CLI entry point (`private: true`), bundled by its existing `apps/cli/build.ts` into the
repo-root `dist/` for the GitHub-release binaries. It has no external package-consumption
story; the earlier `npm install -g @atlcli/cli` path is retired with the registry deferral.

## Related topics

- [Consuming the @atlcli Packages](/reference/package-consumption/)
- [Export Asset Contract](/reference/asset-contract/)
- [Updating](/reference/updating/) — how the CLI itself is released and updated
