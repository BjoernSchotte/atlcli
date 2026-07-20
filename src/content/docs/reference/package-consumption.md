---
title: "Consuming the @atlcli Packages"
description: "How external projects install and use the @atlcli/* export packages without a package registry"
---

# Consuming the `@atlcli/*` Packages

The eleven publishable packages — `@atlcli/plugin-api`, `@atlcli/core`, `@atlcli/diagram`,
`@atlcli/jira`, `@atlcli/confluence`, `@atlcli/export-macros`, `@atlcli/template-pack`,
`@atlcli/docx`, `@atlcli/pdf`, `@atlcli/pdf-compiler-browser`, and `@atlcli/export-node` —
ship compiled ESM (`dist/*.js` + `.d.ts`) and can be consumed by any repo outside this
monorepo through **two supported install paths**, neither of which needs a package registry.

> **Node host? Start with `@atlcli/export-node`.** It bundles the seams the engines need —
> token-auth asset fetching with a verified disk cache, the wasm/font-wired PDF compiler, a
> zero-setup default DOCX template, and filesystem adapters — so a pipeline goes from page
> tree to finished file in a few lines (see the example below).

> **No registry install today.** `npm install @atlcli/pdf` from a public registry is **not**
> available: npm publishing is deliberately deferred until the product rename is settled (see
> the "Deferred: npm registry publishing" appendix in
> `specs/export-expansion/009-package-publishing/PLAN.md`). CI enforces that no workflow can
> publish. Use one of the two paths below.

## In this page

- [Prerequisites](#prerequisites)
- [Runtime support matrix](#runtime-support-matrix)
- [Path 1: Filesystem linking (`file:` directories)](#path-1-filesystem-linking-file-directories)
- [Path 2: Packed tarballs](#path-2-packed-tarballs)
- [Minimal example: DOCX export](#minimal-example-docx-export)
- [Advanced example: PDF export](#advanced-example-pdf-export)
- [Troubleshooting](#troubleshooting)
- [Related topics](#related-topics)

## Prerequisites

- A checkout of this repository (for filesystem linking) or its packed `.tgz` tarballs.
- `bun install` executed at the repo root at least once (applies the typst.ts CSP patch that
  the vendored PDF compiler is regenerated from).
- `bun run build` (or `bunx turbo run build --filter=./packages/*`) so every package has its
  `dist/` output; the `@atlcli/pdf` prepack additionally verifies the sha256-pinned font set
  and `@atlcli/pdf-compiler-browser` vendors the patched typst.ts glue + wasm.

## Runtime support matrix

Declared per package via `engines` and verified by the consumer-smoke suites
(`scripts/consumer-smoke*.ts`):

| Package | Runtime | Notes |
|---|---|---|
| `@atlcli/plugin-api` | Node ≥ 20, Bun | Pure types + helpers |
| `@atlcli/core` | Node ≥ 20, Bun | Node barrel uses `node:` builtins only |
| `@atlcli/diagram` | Node ≥ 20, Bun, browsers | Isomorphic; mermaid renderer lazy-loaded |
| `@atlcli/jira` | **Bun only** (≥ 1.3) | The barrel's webhook server is `Bun.serve`-native |
| `@atlcli/confluence` | Node ≥ 20, Bun, browsers | The default barrel is isomorphic; the non-frozen `./internal` subpath (sync-db, webhook-server, …) is **Bun-only** |
| `@atlcli/docx` | Node ≥ 20, Bun, browsers | Browser hosts import `./browser-runtime` first |
| `@atlcli/pdf` | Node ≥ 20, Bun, browsers | Fully isomorphic |
| `@atlcli/pdf-compiler-browser` | Node ≥ 20, Bun, browsers | Needs `WebAssembly`; wasm/fonts supplied by the host |
| `@atlcli/export-macros` | Node ≥ 20, Bun, browsers | Isomorphic; hosts inject walker/client ports |
| `@atlcli/template-pack` | Node ≥ 20, Bun, browsers | Pure byte-in/byte-out (PizZip + WebCrypto) |
| `@atlcli/export-node` | Node ≥ 20, Bun | The batteries-included Node starting point |

## Path 1: Filesystem linking (`file:` directories)

Best when your project lives next to a checkout of this repo (the expected Forge-app setup).
Point `file:` dependencies at the package **directories** and pin every transitive `@atlcli/*`
range with `overrides` so nothing ever resolves against a registry:

```jsonc
// package.json of your consumer project
{
  "type": "module",
  "dependencies": {
    "@atlcli/docx": "file:../atlcli/packages/docx",
    "@atlcli/pdf": "file:../atlcli/packages/pdf",
    "@atlcli/pdf-compiler-browser": "file:../atlcli/packages/pdf-compiler-browser",
    "@atlcli/confluence": "file:../atlcli/packages/confluence",
    "@atlcli/core": "file:../atlcli/packages/core",
    "@atlcli/diagram": "file:../atlcli/packages/diagram"
  },
  // bun + npm read "overrides"; pnpm reads "pnpm.overrides" — declare both.
  "overrides": { "@atlcli/confluence": "file:../atlcli/packages/confluence", "@atlcli/core": "file:../atlcli/packages/core", "@atlcli/diagram": "file:../atlcli/packages/diagram", "@atlcli/pdf": "file:../atlcli/packages/pdf" },
  "pnpm": { "overrides": { "@atlcli/confluence": "file:../atlcli/packages/confluence", "@atlcli/core": "file:../atlcli/packages/core", "@atlcli/diagram": "file:../atlcli/packages/diagram", "@atlcli/pdf": "file:../atlcli/packages/pdf" } }
}
```

Then `bun install`. The linked manifests carry a workspace-only `development` export
condition (resolving to TypeScript sources for in-repo DX), but resolvers only apply it when
explicitly requested (`bun --conditions=development`, or a bundler dev server such as `vite
dev`) — plain `bun run` / `node` / production bundler builds resolve the built `dist/` output.
`scripts/consumer-smoke-filelink.ts` verifies exactly that (and additionally sets
`NODE_ENV=production` as a defensive belt). Avoid `--conditions=development` and dev-server
mode against linked packages unless you want to consume their live sources.

## Path 2: Packed tarballs

Best for an isolated, versioned artifact. Pack each package (from the repo root):

```bash
bun run build
cd packages/docx && bun pm pack --destination ~/atlcli-tarballs && cd -
# …repeat per package, or see scripts/consumer-smoke.ts which packs the whole set
```

The `prepack`/`postpack` hooks strip the workspace-only `development` condition, verify the
PDF fonts and the vendored compiler, and `bun pm pack` rewrites `workspace:*` ranges to
concrete versions. Install the tarballs with the same `overrides` technique:

```jsonc
{
  "dependencies": {
    "@atlcli/docx": "file:./tarballs/atlcli-docx-0.6.0.tgz",
    "@atlcli/confluence": "file:./tarballs/atlcli-confluence-0.6.0.tgz",
    "@atlcli/core": "file:./tarballs/atlcli-core-0.6.0.tgz",
    "@atlcli/diagram": "file:./tarballs/atlcli-diagram-0.6.0.tgz"
  },
  "overrides": { /* same map */ }
}
```

Works with `bun install`, `npm install`, and `pnpm install` (all three are exercised by
`scripts/consumer-smoke.test.ts` and `scripts/install-matrix.test.ts`).

## Minimal example: DOCX export

The engine is driven through injected host seams (`ExportEnv`) — no filesystem or network
assumptions:

```ts
import { runExport } from "@atlcli/docx";
import { readFile, writeFile } from "node:fs/promises";

const report = await runExport(
  {
    details: pageDetails, // ConfluencePageDetails from @atlcli/confluence's client
    template: { name: "corporate.docx", modificationDate: new Date() },
  },
  {
    templates: { getBytes: async () => new Uint8Array(await readFile("template.docx")) },
    output: { emit: (name, bytes) => writeFile(name, bytes) },
  },
);
console.log(report.filename, report.notes);
```

Node hosts can use the ready-made adapters `fileTemplateSource(path)` / `fileOutputSink(path)`
from the `@atlcli/docx` barrel instead of hand-rolling the seams.

## Recommended Node starting point: `@atlcli/export-node`

The BASELINE-DESIGN §A5 story, verbatim (tested by the consumer-smoke suites against
installed tarballs):

```ts
import { fetchExportTree, composeChapters } from "@atlcli/confluence";
import { runPdfExport } from "@atlcli/pdf";
import { nodePdfEnv, confluenceTreeSource } from "@atlcli/export-node";

const tree = await fetchExportTree(confluenceTreeSource(profile),
  { kind: "tree", rootPageId: "123" }, { labels: { exclude: ["internal"] } });
const doc = composeChapters(tree.nodes);
await runPdfExport({ blocks: doc.blocks, metadata, filename: "handbook.pdf" },
  nodePdfEnv(profile, { outDir: "dist" }));
```

`nodePdfEnv` wires the token-auth asset resolver (verified disk cache under
`~/.atlcli/cache/assets`), the CSP-patched wasm compiler with the ten canonical fonts (all
resolved from the installed packages), and a directory output sink. For DOCX with zero
template setup, `nodeDocxEnv({ outPath })` resolves a programmatically built default template
(`bundledDefaultTemplate()` — no binary asset shipped); pass `templatePath` to use your own.

## Advanced example: PDF export

PDF needs a compiler port plus wasm + font bytes. In a **Node-ish host**, resolve them from
the installed packages:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPdfExport, PDF_RUNTIME_ASSETS } from "@atlcli/pdf";
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";
import { storageToBlocks } from "@atlcli/confluence";

const bytesOf = (spec: string) =>
  new Uint8Array(readFileSync(fileURLToPath(import.meta.resolve(spec))));

const wasm = bytesOf("@atlcli/pdf-compiler-browser/wasm");
const fonts = PDF_RUNTIME_ASSETS.fonts.map((f) => bytesOf(`@atlcli/pdf/fonts/${f.fileName}`));
const compiler = new BrowserPdfCompiler({ wasm: wasm.buffer, fonts });

const { blocks } = storageToBlocks(page.storage);
await runPdfExport(
  { blocks, metadata: { title: page.title, exportedAt: new Date() }, filename: "page.pdf" },
  {
    assets: { resolve: async () => { throw new Error("no attachments wired"); } },
    compiler,
    output: { emit: async (name, bytes) => { /* write or stream */ } },
  },
);
```

In a **Vite host**, load the same assets through `?url` imports (see the
[Export Asset Contract](/reference/asset-contract/) for the full pattern and the ambient-types
snippet):

```ts
import wasmUrl from "@atlcli/pdf-compiler-browser/wasm?url";
import sansRegularUrl from "@atlcli/pdf/fonts/SourceSans3-Regular.ttf?url";
// …one import per font in PDF_RUNTIME_ASSETS.fonts, fetched at runtime
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Cannot find module '@atlcli/core'` during install | An internal range hit the registry (where `@atlcli/*` does not exist) | Add the package to `overrides` (and `pnpm.overrides`) pointing at your local dir/tarball |
| Imports resolve to `src/*.ts` under Bun | You ran with `--conditions=development` (or a bundler dev server applied the `development` condition) | Drop the flag / use a production build, or consume tarballs (their manifests are stripped) |
| `Cannot find module 'bun:sqlite'` under Node | You imported `@atlcli/confluence/internal` | Only the default barrel is Node-clean; the internal sync machinery is Bun-only |
| PDF compile throws `Blocked unexpected dynamic function` | Working as designed — the CSP-hardened compiler refuses non-allowlisted dynamic code | Report it; do not swap in the unpatched upstream glue |
| Missing fonts at pack time | `packages/pdf/.fonts/` not populated | Run `bun run fonts:ensure` at the repo root (prepack does this automatically) |

## Related topics

- [Export Asset Contract](/reference/asset-contract/) — stable asset subpaths and `?url` wiring
- [Package Versioning](/reference/versioning/) — semver policy for these artifacts
- [DOCX Export Engine](/reference/docx-engine/) · [PDF Export Engine](/reference/pdf-engine/)
