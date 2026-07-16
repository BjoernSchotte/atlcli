---
title: "DOCX Export Engine"
description: "The isomorphic @atlcli/docx export engine and how a new surface plugs in"
---

# DOCX Export Engine (`@atlcli/docx`)

`packages/docx` holds atlcli's isomorphic DOCX export engine: the pure pipeline that turns a
Confluence page plus a Word template with Scroll placeholders (`$scroll.*`) into a finished
`.docx`. It runs unchanged in the browser (the Chrome extension's "Export to Word") and under
Node/Bun (`atlcli wiki export --engine ts`) — the hosts differ only in the side effects they
inject.

## In this page

- [Architecture](#architecture)
- [The three injected interfaces](#the-three-injected-interfaces)
- [Plugging in a new surface](#plugging-in-a-new-surface)
- [Guarantees and gates](#guarantees-and-gates)
- [Related topics](#related-topics)

## Architecture

The engine follows the repo's "functional core, imperative shell" rule:

| Layer | Where | Examples |
|-------|-------|----------|
| Pure engine | `packages/docx/src` | template scan, placeholder resolution, `ExportBlock[]` → OOXML serialization, docxtemplater orchestration, Shiki highlighting |
| Host shells | each consumer | extension: IndexedDB store, session fetch, browser download · CLI: `readFile`/`writeFile`, token-auth client |

Entry points (package `exports` conditions, mirroring `@atlcli/core`):

| Import | Resolves to | Use |
|--------|-------------|-----|
| `@atlcli/docx` | Node barrel | engine + Node filesystem adapters |
| `@atlcli/docx/browser` | browser barrel | engine only (no `node:` imports, CI-gated) |
| `@atlcli/docx/scan` | scan module | lightweight template scan without pulling the full engine |

## The three injected interfaces

`runExport(input, env)` is the cross-host entry. `env` is an `ExportEnv` with exactly the three
places hosts differ:

```ts
interface TemplateSource {
  getBytes(id: string): Promise<Uint8Array>;   // extension: IndexedDB · CLI: readFile
}
interface AssetFetcher {
  fetch(ref: AssetRef): Promise<Uint8Array>;   // extension: session fetch · CLI: token client
}
interface OutputSink {
  emit(name: string, bytes: Uint8Array): Promise<void>; // extension: download · CLI: writeFile
}
interface ExportEnv { templates: TemplateSource; assets: AssetFetcher; output: OutputSink; }
```

`AssetFetcher` is reserved for image embedding (spec 005) — v1 never calls it, and hosts without
an asset path can inject `unsupportedAssetFetcher()`.

## Plugging in a new surface

A new consumer (MCP server, Tauri Studio, Org-Server) implements the three interfaces and calls
`runExport`. Minimal Node example:

```ts
import { runExport, fileTemplateSource, fileOutputSink, unsupportedAssetFetcher } from "@atlcli/docx";

const report = await runExport(
  {
    details,                              // ConfluencePageDetails (title, storage, …)
    template: { name: "corporate.docx", modificationDate: new Date() },
    deps: {                               // lazy resolver round-trips, all optional
      getSpace: (key) => client.getSpace(key),
      getCurrentUser: () => client.getCurrentUser(),
      getPageOwner: (id) => client.getPageOwner(id),
      getSpaceHomepageStorage: (key) => client.getSpaceHomepageStorage(key),
    },
  },
  {
    templates: fileTemplateSource("./corporate.docx"),
    assets: unsupportedAssetFetcher(),
    output: fileOutputSink("./out.docx"),
  }
);
```

A browser surface supplies its own implementations instead (see
`apps/extension/utils/docx/env.ts` for the extension's adapters). Browser bundling note: PizZip
and docxtemplater reference `Buffer.*`; that is a **host** bundling concern — the extension
installs a `Uint8Array` shim + Vite `define`, a Node host has the real `Buffer`, and the engine
itself never touches either.

## Guarantees and gates

- **Isomorphism:** `packages/docx/src/index.browser.ts` is one of the CI-gated browser
  entrypoints (`bun run check:browser`) — a `node:`/`bun:` specifier anywhere in its graph fails CI.
- **Golden-file equality:** `packages/docx/src/golden.test.ts` pins the engine's output to the
  pre-extraction extension export; `node-consumer.test.ts` proves the identical output under Node
  filesystem adapters.
- **Determinism:** highlighting warms the Shiki grammar on load, so the same input always yields
  the same OOXML (a first-call tokenization drift would otherwise break golden equality).
- **Roadmap:** the PDF export (spec 007) builds its Typst serializer directly into this engine —
  same `ExportBlock` model, same env contract, no second extraction.

## Related topics

- [DOCX Export](../confluence/export.md) — the `atlcli wiki export` command (both engines)
- [CLI Commands](cli-commands.md) — full command reference
