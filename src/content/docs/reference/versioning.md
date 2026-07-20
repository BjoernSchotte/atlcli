---
title: "Package Versioning"
description: "Semver policy for the @atlcli/* packages: lockstep versions, pre-1.0 rules, and the deferred registry publish"
---

# Package Versioning

Version-numbering policy for the eight publishable `@atlcli/*` packages. **This governs
packed-tarball and filesystem-linked artifacts only** — publishing to a package registry is
deliberately deferred (product rename pending; see the "Deferred: npm registry publishing"
appendix in `specs/export-expansion/009-package-publishing/PLAN.md`), and no CI path in this
repo can publish.

## In this page

- [Lockstep versioning](#lockstep-versioning)
- [Pre-1.0 semver rules](#pre-10-semver-rules)
- [1.0 and the API freeze](#10-and-the-api-freeze)
- [What counts as breaking](#what-counts-as-breaking)
- [Per-package changelog](#per-package-changelog)
- [Why lockstep, not changesets](#why-lockstep-not-changesets)
- [Related topics](#related-topics)

## Lockstep versioning

All `@atlcli/*` packages move as one **fixed/lockstep version train** on the existing release
tooling (`scripts/release.ts`, git-cliff changelog, one tag). A consumer never mixes package
versions from different trains: when you pack or link at commit X, every internal
`@atlcli/*` dependency range resolves to the same train (verified by
`scripts/pack-check.test.ts` and the consumer-smoke suites).

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

## What counts as breaking

- Removed or renamed exports from a published entrypoint
- Narrowed input types or widened output types of the frozen seams
- Changed or removed `exports` subpaths (including asset subpaths — see the
  [Export Asset Contract](/reference/asset-contract/))
- Changed asset filenames (fonts, wasm)
- Tightened `engines` (dropping a supported runtime)

Deprecations get one minor release with `@deprecated` JSDoc before removal.

## Per-package changelog

There is one `CHANGELOG.md`, generated from Conventional Commits. The **commit scope is the
per-package story**: `feat(confluence): …`, `fix(pdf): …`, `feat(docx)!: …` — filtering the
changelog by scope yields each package's history without a second changelog system.

## Why lockstep, not changesets

Considered and **rejected** (decision recorded here so it isn't re-litigated blindly):

- The repo already runs a single-version release train with one changelog and one tag;
  changesets would add a second changelog system and a bot workflow sized for many
  independent maintainers, which this repo doesn't have.
- Per-package version drift would force consumers (and the consumer-smoke matrix) to reason
  about version compatibility between sibling packages that are developed and tested only in
  lockstep.
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
