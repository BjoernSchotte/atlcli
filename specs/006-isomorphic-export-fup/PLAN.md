# Isomorphic Export Engine — extract `@atlcli/docx` for CLI / MCP / Studio / Server reuse

Status: **Planned**

Spec ID: `006-isomorphic-export-fup`
Depends on: `002-extension-workspace`, `003-page-detection-read-path`, `004-docx-export` (must be merged — this extracts code that lands there), `001-browser-ready-core` (the conditional-exports + injectable-side-effects pattern this mirrors)
Sequencing: **before `007-pdf-export`** (Björn 2026-07-16) — do the isomorphic extraction first so PDF's Typst serializer is built directly into the reusable engine established here, not extracted a second time. Spec order: 004-docx → 005-docx-image-module → **006 (this)** → 007-pdf-export → 008-export-poc-validation.
Related strategy: `~/code/rovo-skills/FAHRPLAN.md` Phase 5 (Org-Server / Export-Zentrale), Phase 6 (Tauri Studio) · `~/code/rovo-skills/research/TYPST-EXPORT-ANGLE.md` §7.6 (server-side rendering with "the same isomorphic code")
Origin: raised by Björn 2026-07-16 during the 004 DOCX cycle — the export code landed in `apps/extension/utils/docx/` (extension-only) but the pipeline is meant for reuse across surfaces.

---

## 1. Overview

The v1 DOCX export engine ships inside the Chrome extension (`apps/extension/utils/docx/`).
Its pure transforms — `ExportBlock[]` → OOXML, placeholder resolution, template scan, the
docxtemplater orchestration — are host-agnostic, but they currently live behind the
extension's imperative shell (IndexedDB, session-auth fetch, browser download, React UI).
This spec **extracts the pure engine into a new isomorphic package** so the CLI, an MCP
server, the planned Tauri Studio (FAHRPLAN Phase 6), and a future Org-Server (Phase 5) can
all render the same output from the same code, differing only in their injected side effects.

This is a **move-not-rewrite** refactor: the pure modules already contain no `chrome.*`/DOM
dependencies (verified in the 004 Codex review). Its value is decoupling and injection seams,
not new behavior — the extension's exports must be byte-identical before and after.

### What this spec must prove

1. **A browser-safe, Node-safe engine package** — `@atlcli/docx` exposes the export pipeline
   via `exports` conditions (mirroring `@atlcli/core` / `@atlcli/confluence` from spec 001),
   buildable for both targets, enforced by the existing `check:browser` gate.
2. **Injectable side effects** — the three places hosts genuinely differ (template source,
   asset fetch, output sink) become injected interfaces with no default that assumes a browser.
3. **No behavior change for the extension** — the extension keeps its shell, imports the
   engine, and produces identical `.docx` output (golden-file test).
4. **A second consumer proves reuse** — the CLI (or a thin harness) drives the same engine
   with Node-side implementations of the three interfaces and produces an equivalent `.docx`.

### Goals

- New package `packages/docx` (`@atlcli/docx`) holding the pure engine.
- Three injected interfaces: `TemplateSource`, `AssetFetcher`, `OutputSink`.
- Extension refactored to inject its browser implementations; its export output unchanged
  (golden-file equality against a pre-refactor fixture export).
- One non-extension consumer (CLI subcommand or documented harness) rendering the same
  fixture through Node-side implementations.
- `check:browser` covers the engine's browser entry; repo-wide tests/typecheck/build green.

### Non-goals

- **No new export features** — not images (that's the deferred OOXML image-module task), not
  mermaid, not multi-page. Pure extraction + injection.
- **No replacement of the Python `packages/export`** in this spec — the naming is chosen so
  the TS engine *can* supersede it later (see §2.1), but that migration is out of scope here.
- **No PDF path move** — the PDF export (spec `007-pdf-export`) Typst serializer consumes the same `ExportBlock` model
  but is not part of THIS extraction; because this spec is sequenced BEFORE PDF, spec 007 builds its Typst serializer directly into the isomorphic engine established here — no second extraction.
- No API redesign of the transforms themselves — signatures stay as-is unless an injection
  seam demands a minimal change.

---

## 2. Architecture

### 2.1 Package placement and naming

- **New package: `packages/docx`** (`@atlcli/docx`). Deliberately **not** `packages/export` —
  that name is taken by the existing Python `docxtpl` path (`packages/export`, `uv`/`pytest`).
  The TS engine could supersede the Python path in a future migration; keeping a distinct
  name avoids collision now and leaves that door open.
- Depends on `@atlcli/confluence` (for the `ExportBlock` model + `storageToBlocks` walker,
  already isomorphic) and `@atlcli/core` (types). No dependency on `apps/extension`.
- `exports` conditions exactly like `@atlcli/core`:
  ```jsonc
  { "exports": {
      ".":        { "browser": "./src/index.browser.ts", "default": "./src/index.ts" },
      "./browser": "./src/index.browser.ts",
      "./node":    "./src/index.ts" } }
  ```

### 2.2 What moves (pure) vs. what stays (shell)

| Current location (`apps/extension/utils/docx/`) | Destination | Notes |
|---|---|---|
| `serialize.ts` (ExportBlock[] → OOXML) | `@atlcli/docx` | pure |
| `ooxml.ts`, `ooxml-text.ts` (fragment builders, run normalization) | `@atlcli/docx` | pure |
| `scan.ts` (placeholder scan over the docx zip) | `@atlcli/docx` | pure (PizZip) |
| `resolver.ts`, `dateformat.ts`, `placeholder-map.ts` | `@atlcli/docx` | pure |
| `export.ts` (docxtemplater orchestration, sentinel splice, settings) | `@atlcli/docx` | pure; takes injected deps |
| `highlight.ts` (Shiki) | `@atlcli/docx` | pure; keep lazy-load |
| `byte-helpers-shim.ts` + `wxt.config.ts` Buffer define | **stays in extension** | host bundling concern (PizZip/docxtemplater Buffer refs); a Node consumer has real `Buffer` and needs no shim |
| `template-store.ts` (IndexedDB) | **stays** → implements `TemplateSource` | browser-only |
| session-auth attachment fetch | **stays** → implements `AssetFetcher` | browser-only |
| browser download trigger | **stays** → implements `OutputSink` | browser-only |
| `TemplateSection.tsx`, `ReportView` | **stays** | React UI |

### 2.3 Injected interfaces (the imperative shell contract)

```ts
export interface TemplateSource {
  getBytes(id: string): Promise<Uint8Array>;   // extension: IndexedDB blob · CLI: readFile
}
export interface AssetFetcher {
  // v1 images are deferred, but the seam exists for the image-module follow-up
  fetch(ref: AssetRef): Promise<Uint8Array>;    // extension: session fetch · CLI: token client
}
export interface OutputSink {
  emit(name: string, bytes: Uint8Array): Promise<void>; // extension: download · CLI: writeFile
}
export interface ExportEnv { templates: TemplateSource; assets: AssetFetcher; output: OutputSink; }
```

- The engine's top-level `runExport(input, env): Promise<ExportReport>` takes `ExportEnv`.
- No interface has a browser-assuming default — a Node caller supplies filesystem-backed
  implementations; the extension supplies its existing browser ones.
- Mirrors spec 001's `TokenResolver`/`LogSink` injection exactly.

### 2.4 Buffer/bundling boundary (important)

The Buffer shim is a **host** concern, not an engine concern. PizZip/docxtemplater reference
`Buffer.*`; in the browser the extension installs a `Uint8Array` shim + Vite `define`. In
Node those globals exist for real. Therefore the shim **stays in the extension**, and the
engine must not import it — the engine uses `Uint8Array` at its own boundaries and lets the
host resolve `Buffer`. The `check:extension-output` node-globals scan continues to guard the
browser bundle.

---

## 3. Task breakdown (ordered)

### Task 1 — Scaffold `packages/docx`
- [ ] Package created (`@atlcli/docx`, private), `exports` conditions per §2.1, deps on `@atlcli/confluence` + `@atlcli/core`; wired into workspaces/Turbo/typecheck.
- [ ] `src/index.browser.ts` + `src/index.ts` skeletons; added to `scripts/check-browser-build.ts` as a gated entrypoint.
- [ ] Repo-wide `bun test` / `typecheck` / `build` green (empty package builds).

### Task 2 — Move pure modules (no behavior change)
- [ ] All §2.2 "pure" modules moved into `packages/docx/src`, imports rewired; extension imports them from `@atlcli/docx`.
- [ ] Their existing tests move with them (or import-path-only edits) and stay green **unchanged** — this is the move-not-rewrite guardrail.
- [ ] `bun run check:browser` green (engine browser entry has zero `node:`/`bun:`/bare-node-global leaks).

### Task 3 — Introduce injected interfaces
- [ ] `TemplateSource` / `AssetFetcher` / `OutputSink` / `ExportEnv` defined; `runExport(input, env)` entry.
- [ ] Extension implements the three interfaces (IndexedDB / session-fetch / download) as thin adapters; no engine code references `chrome.*` / DOM / `window`.
- [ ] Unit tests for each adapter using real infra per the repo directive (fake-indexeddb for the template source; mock only `chrome.*`/network).

### Task 4 — Golden-file equality (extension output unchanged)
- [ ] A pre-refactor fixture export (the 004 §2.1 feature-zoo page + fixture template) is captured as a golden `.docx`; post-refactor output is byte-equal (or structurally equal after normalizing non-deterministic parts like timestamps). This is the proof the refactor changed nothing observable.

### Task 5 — Second consumer proves reuse
- [ ] A Node-side consumer (a CLI subcommand `atlcli export docx`, or a documented `bun` harness if a full command is out of scope) drives `runExport` with filesystem `TemplateSource`/`OutputSink` and the token-auth client as `AssetFetcher`.
- [ ] It renders the same fixture to an equivalent `.docx` (same structural assertions as Task 4), proving the engine runs outside the browser with no shim.
- [ ] Runs under Node/Bun with real `Buffer` (no extension shim imported).

### Task 6 — Docs + cleanup
- [ ] `docs/` updated: the export engine is a reusable package; how a new surface plugs in (implement the three interfaces).
- [ ] Extension's now-removed pure modules deleted (no dead copies); dependency list corrected.
- [ ] Note that PDF export (spec 007-pdf-export) is built next, directly on the isomorphic engine this spec establishes (not a later re-extraction).

---

## 4. Test plan

- **Move-not-rewrite guardrail:** moved modules' tests pass unchanged — the strongest signal the extraction altered no behavior.
- **Golden file (Task 4):** extension output byte/structure-equal before vs after.
- **Cross-host (Task 5):** the Node consumer's output structurally equals the extension's for the same input — the reuse proof.
- **Isomorphism:** `check:browser` covers the engine browser entry; a bare-node-global (`Buffer.`) in the engine's browser graph must fail the gate.
- **Real infra (repo directive):** fake-indexeddb for the browser `TemplateSource`; real filesystem for the Node one; mock only `chrome.*`/network.
- Repo-wide `bun test` / `typecheck` / `build` / `check:browser` / `check:extension-output` green.

## 5. Definition of done

- `@atlcli/docx` exists, isomorphic, gated; extension imports it and its output is unchanged (golden file).
- Three injected interfaces; no browser assumptions in the engine.
- A non-extension consumer renders the same fixture through Node-side implementations.
- No dead export code left in the extension; docs updated.

## 6. Risks and open questions

1. **Hidden browser assumptions.** A "pure" module might transitively touch a browser global (e.g. `atob`/`btoa`, `crypto`) — inventory during Task 2; use the isomorphic helpers from `@atlcli/core` (spec 001) instead of host globals. The `check:browser`/output-scan gates are the backstop.
2. **PizZip/docxtemplater in Node vs browser.** They already run in both; the only divergence is `Buffer` (real in Node, shimmed in the browser). Keep the shim strictly host-side (§2.4).
3. **CLI scope.** A full `atlcli export docx` command may be more than this spec wants; the fallback is a documented harness that still exercises the Node path — Task 5 accepts either, but the engine must be genuinely driven outside the extension.
4. **Determinism for the golden file.** OOXML carries timestamps/rIds that vary; normalize those before equality, or assert structural landmarks — decide in Task 4, document which.
5. **Sequencing.** This depends on 004 merging first (it extracts 004's code). If 004 changes during review, rebase this spec's extraction onto the final 004 shape.

### Decisions log

- **Package name** `packages/docx` (not `packages/export`, taken by the Python path) — 2026-07-16.
- **Scope** extraction + injection only; images/mermaid/PDF-move/Python-replacement explicitly deferred — 2026-07-16.
