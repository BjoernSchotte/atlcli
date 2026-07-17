# Multi-Host Browser Export Runtime — extension, embedded web, and desktop webview reuse

Status: **Planned**

Planned at: `9a3c950ce36e63a88fbffe2f47172ebaf9cb9a95` (`feat(pdf): adapt inline layout in dense tables (#44)`)

Implementation branch: create a fresh `codex/` branch from the current `main` when execution starts. This plan was authored on `codex/spec-009-multi-host-browser-runtime`; that planning branch is not an implementation baseline.

Depends on:

- `specs/001-browser-ready-core/PLAN.md` — browser-safe package entrypoints and browser-build gate
- `specs/002-extension-workspace/PLAN.md` — extension workspace and MV3 host shell
- `specs/006-isomorphic-export-fup/PLAN.md` — implemented `@atlcli/docx` extraction
- `specs/007-pdf-export/PLAN.md` — implemented PDF preparation/compiler behavior, despite its stale `Planned` status

Sequencing: implement this spec before the final cross-format validation in `specs/008-export-poc-validation/PLAN.md`. Spec 008 must validate the post-009 boundaries rather than only the original extension-owned PDF path.

---

## 1. Outcome

The repository shall expose the existing browser-capable export functionality to more than one browser host without turning DOCX and PDF into one engine and without coupling reusable packages to the Chrome extension.

The implementation must prove three independent facts:

1. `@atlcli/docx` remains its own DOCX engine and can run from a second, non-extension browser host.
2. `@atlcli/pdf` remains its own PDF preparation/orchestration domain, while the Typst-WASM implementation moves into a dedicated browser-only compiler package.
3. The extension still owns its Chrome/WXT/session/job-store/UI policies and produces equivalent DOCX/PDF output after the package moves.

The permanent proof consumer is a private vanilla Vite app under `apps/browser-export-harness`. It is a conformance harness, not a shipped product. It runs one real DOCX export and one real PDF export under headless Chromium, with no extension APIs, no live tenant, and no native Node globals. This proves the public package contracts in a self-controlled Vite/Chromium host; packaging, CSP, iframe, and asset-loading behavior of any managed or embedded target host requires separate host-specific evidence outside this spec.

### 1.1 The non-negotiable engine split

DOCX and PDF are different output systems. They are not combined, wrapped in a common `ExportEngine`, or made dependent on each other.

```text
Confluence storage / fixture input
              |
              v
     @atlcli/confluence ExportBlock[]
        |                         |
        |                         |
        v                         v
 @atlcli/docx                @atlcli/pdf
 OOXML/DOCX engine           prepare + Typst source + PDF runner contracts
        |                         |
        |                         v
        |             PdfCompilePort (injected)
        |                         |
        |                         v
        |            @atlcli/pdf-compiler-browser
        |                  Typst-WASM adapter
        |                         |
        v                         v
     .docx bytes                .pdf bytes
```

What may be shared:

- `ExportBlock[]`, `ExportNote`, and page-detail types from `@atlcli/confluence`;
- the format-neutral Mermaid renderer and theme model from `@atlcli/diagram`;
- build/test tooling that scans browser artifacts;
- host concepts that happen to have the same shape, only when sharing them removes real duplication without erasing format-specific semantics.

What must not be shared as one implementation abstraction:

- DOCX template loading/rendering and PDF Typst source/compilation;
- `ExportReport` and `PdfExportReport`;
- DOCX `OutputSink` and PDF `PdfOutputSink` merely because both emit bytes;
- browser compiler lifecycle and DOCX byte-compatibility bootstrap;
- extension IndexedDB/message topology and a neutral direct-worker topology;
- a generic `@atlcli/export-engine`, `@atlcli/browser-runtime`, or union-shaped `runExport(format, ...)` package.

This explicit split resolves the ambiguity in the earlier phrase “shared DOCX/PDF engine”: the engines are reused across hosts, not shared with each other.

---

## 2. Baseline and drift check

### 2.1 Verified repository state at the planned SHA

| Area | Current implementation | Consequence for this spec |
|---|---|---|
| DOCX engine | `packages/docx/src/**`, browser barrel in `packages/docx/src/index.browser.ts` | Engine ownership is already correct. Do not move OOXML/template logic again. |
| DOCX host seams | `TemplateSource`, `AssetFetcher`, `SvgRasterizer`, `OutputSink`, and `runExport` in `packages/docx/src/env.ts` | Keep these DOCX-specific contracts. |
| DOCX browser bootstrap | `apps/extension/utils/byte-helpers-shim.ts` plus `Buffer.*` Vite rewrites in `apps/extension/wxt.config.ts` | Technically browser-host support, but physically trapped in one host. Extract only this compatibility layer. |
| DOCX browser adapters | `apps/extension/utils/docx/env.ts` combines neutral DOM code with extension storage/session/cache/report policy | Split neutral DOM capability from extension policy. |
| PDF model | `packages/pdf/src/**` owns preparation, serialization, source maps, diagnostics model, template, fonts, and report types | Keep the preparation-only browser barrel lightweight. Add host-neutral runner contracts without importing Typst. |
| PDF compiler | `apps/extension/utils/pdf/compiler.ts` imports no Chrome/WXT/extension API | Wrong physical boundary: move to a dedicated browser compiler package. |
| PDF orchestration | `apps/extension/utils/pdf/run-export.ts` mixes reusable phase/report logic with `LoadedPage`, mention lookup, ambient locale, session auth, IndexedDB jobs, Chrome messaging, and DOM download | Move content-only mention normalization to `@atlcli/confluence`, then split a host-neutral PDF runner from a thin extension page adapter. |
| PDF topology | `job-store.ts`, `compiler-host.ts`, `worker-protocol.ts`, offscreen/background wiring | Preserve in the extension. It is one host's proven cancellation/timeout/quota strategy. |
| Browser proof | `scripts/check-browser-build.ts` bundles source entries with Bun; extension output scan validates only WXT output | Insufficient for a second Vite/Worker/WASM host. Add a real browser harness. |
| Build invalidation | extension artifact helper watches `packages/pdf` but omits other transitive workspace packages | Fix explicit inputs so moved code cannot reuse stale artifacts. |
| Documentation | Specs 006/007 and current engine docs describe browser adapters/compiler as extension-owned; spec 007 still says `Planned` | Annotate only the superseded ownership statements; preserve historical decisions and completion evidence. |

### 2.2 Mandatory drift check before implementation

Before changing code, the implementing session must run:

```bash
git status --short
git rev-parse HEAD
git log -1 --oneline
rg -n "BrowserPdfCompiler|runPdfExport|resolvePdfMentionNames|PdfThemeOptions|byte-helpers-shim|Buffer\.from|PdfCompilerHost" apps packages scripts specs
```

Then compare the result to the ownership map above.

STOP and re-plan if any of the following is true:

- `@atlcli/docx` no longer owns the current DOCX engine;
- the PDF compiler already moved out of `apps/extension` under a different contract;
- spec 008 or another accepted spec introduced a conflicting runtime package;
- the extension no longer uses WXT/Vite source consumption;
- the planned SHA is not an ancestor of the implementation branch and the relevant files changed materially.

Do not “adapt while implementing” across a material architecture drift. Update this plan first.

---

## 3. Scope

### 3.1 In scope

- A DOCX-specific browser compatibility subpath inside `@atlcli/docx`.
- Extraction of browser-neutral DOCX DOM capability currently trapped under `apps/extension`.
- A new private workspace package `@atlcli/pdf-compiler-browser`.
- Host-neutral mention normalization over `ExportBlock[]` in `@atlcli/confluence`, with authenticated lookup remaining host-owned.
- A host-neutral PDF runner and compile-port contract in `@atlcli/pdf`.
- Normalized compiler diagnostics at the public package boundary.
- A canonical PDF font/license asset manifest with host-parity checks.
- Rewiring the extension to consume the new package surfaces without behavior change.
- A permanent private `apps/browser-export-harness` Vite app.
- Production-build artifact scans and a real Chromium E2E for the harness.
- Turbo, TypeScript, root scripts, CI, dependency-boundary tests, and stale-build inputs.
- Current public engine/reference docs and narrow supersession notes in older specs.

### 3.2 Out of scope

- Any hosted product or tenant integration.
- Any vendor-specific embedded application implementation.
- A concrete desktop-webview application, native save dialog, or native Typst process.
- Server-side compilation or a self-hosted service.
- Template Studio UI, template database, authentication, billing, licensing, or distribution-channel packaging.
- Publishing `@atlcli/docx`, `@atlcli/pdf`, or `@atlcli/pdf-compiler-browser` to npm.
- Moving the extension job store, Chrome messaging, offscreen lifecycle, session authentication, or UI into reusable packages.
- Unifying DOCX and PDF result types, runners, sinks, errors, reports, or engines.
- Changing document layout, template semantics, supported Confluence blocks, fonts, or export UX.
- Replacing WXT, Typst, docxtemplater, PizZip, or the current pinned font set.

### 3.3 Behavioral invariants

1. Existing DOCX golden structural equality remains green. Raw ZIP byte equality is not required because ZIP timestamps are not stable.
2. Existing PDF semantic fixture checks and warm-repeat byte identity remain green.
3. The extension's visible phases, cancellation behavior, timeout, job quotas, stale-result protection, and cleanup remain unchanged.
4. No reusable package imports from `apps/extension`, `wxt`, `chrome.*`, or an extension URL scheme.
5. The harness imports only public workspace package exports, never relative paths into another package and never extension source.
6. The default/browser barrels of `@atlcli/pdf` do not import the Typst compiler wrapper. Preparation-only consumers must not bundle WASM/compiler code.
7. The root CSP-safe patch for `@myriaddreamin/typst-ts-web-compiler@0.7.0` remains active and covered.
8. WASM, fonts, and license URLs remain statically discoverable in each host bundle; a shared manifest validates parity but does not hide bundler-specific `?url` imports behind dynamic strings.
9. No browser artifact contains `node:`/`bun:` imports, bare `Buffer.*`, dynamic `Function`, `eval`, remote executable code, or extension-runtime references unless an existing, narrowly documented scan exception already applies.
10. In the PDF lane, aborting an export never starts emission/download after the abort is observed. DOCX cancellation is unchanged and out of scope because the current DOCX `RunExportInput` has no abort contract.
11. Mention resolution preserves existing display names, traverses nested inline/block content, retains unresolved technical identifiers, and never requires a reusable package to know tenant auth or user API response types.

---

## 4. Target ownership and dependency direction

### 4.1 Workspace dependency graph

```text
@atlcli/confluence   @atlcli/diagram
        ^                ^
        |                |
        +------ @atlcli/docx
        |
        +------ @atlcli/pdf <------ @atlcli/pdf-compiler-browser
                      ^                         ^
                      |                         |
                      +----- host adapters -----+
                               /       \
                              /         \
                   apps/extension   apps/browser-export-harness
```

Forbidden dependency edges:

- `@atlcli/docx -> @atlcli/pdf` or the reverse;
- either engine package -> `@atlcli/pdf-compiler-browser`;
- any package -> `apps/*`;
- `apps/browser-export-harness -> apps/extension`;
- reusable packages -> WXT/Chrome APIs;
- `@atlcli/pdf` default/browser barrel -> Typst wrapper or WASM assets.

### 4.2 Ownership table

| Owner | Owns after 009 | Does not own |
|---|---|---|
| `@atlcli/confluence` | `ExportBlock`, page/storage normalization, host-neutral mention normalization | authenticated user lookup, DOCX/PDF rendering |
| `@atlcli/diagram` | format-neutral Mermaid-to-SVG/theme logic | DOCX PNG embedding or PDF Typst compilation |
| `@atlcli/docx` | DOCX engine, DOCX env ports, DOCX browser bootstrap/config, neutral canvas/memory adapters | PDF contracts, Chrome/session/IndexedDB policy |
| `@atlcli/pdf` | PDF preparation, serializer, source map, normalized diagnostics, output validation, font/license manifest, PDF runner contracts/orchestration | Typst implementation, WASM loading, worker topology, Chrome/session policy |
| `@atlcli/pdf-compiler-browser` | pinned Typst-WASM adapter, private raw Typst schema, normalized result mapping, compiler lifecycle tests | fonts/download URL policy, IndexedDB jobs, Chrome messaging, UI |
| `apps/extension` | page/session/profile adapter, extension template/job stores, WXT config, static asset URL imports, background/offscreen/worker topology, DOM download, UI/report presentation | reusable compiler implementation or DOCX browser bootstrap implementation |
| `apps/browser-export-harness` | neutral Vite config, fixture adapters, direct Worker transport, in-memory sinks, browser conformance UI/E2E | live auth, production UI, extension code, native desktop code |
| root scripts/CI | cross-host boundary and artifact policies | runtime product behavior |

### 4.3 Narrow supersession rules

This spec supersedes only future-facing ownership statements, not historical implementation records:

| Earlier statement | Replacement rule |
|---|---|
| Spec 006 says the byte shim stays in the extension because there is one browser host. | The concern remains host/browser-specific, but its implementation/config becomes a DOCX-owned browser-support subpath because multiple browser hosts now require it. |
| Spec 006/current DOCX docs point browser adapters at `apps/extension`. | Extension-only storage/session policy stays there; neutral memory/canvas capability moves to `@atlcli/docx/browser-runtime`. |
| Spec 007 assigns compiler lifecycle wholly to the extension. | The pinned low-level browser compiler moves to `@atlcli/pdf-compiler-browser`; extension worker/job/offscreen lifecycle stays extension-owned. |
| Spec 007/current PDF docs describe only an extension offscreen compiler host. | That remains the extension topology; a second direct-worker harness proves the compiler package is not tied to it. |
| Spec 002 mentions a future remote-hosted UI. | No hosted UI is implemented or implied by 009. Supported terminology is extension, embedded web host, desktop webview, and neutral browser harness. |

---

## 5. Public contracts

The names below are normative. An executor may adjust internal filenames, but changing a public type/name or collapsing the format boundaries requires updating this plan before implementation.

### 5.1 DOCX browser support

Add these package subpaths to `packages/docx/package.json`:

```json
{
  "exports": {
    "./browser": "./src/index.browser.ts",
    "./browser-runtime": "./src/browser-runtime.ts",
    "./vite": "./src/vite.ts"
  }
}
```

`packages/docx/src/browser-runtime.ts` owns:

```ts
export interface DocxByteHelpers {
  from(value: ArrayLike<number> | ArrayBuffer | string, encoding?: string): Uint8Array;
  alloc(size: number): Uint8Array;
  isBuffer(value: unknown): boolean;
}

export function installDocxBrowserRuntime(): void;

export function memoryTemplateSource(bytes: ArrayBuffer | Uint8Array): TemplateSource;

export interface CanvasRasterizerTiming {
  decodeMs: number;
  drawMs: number;
  encodeMs: number;
}

export interface CanvasSvgRasterizerOptions {
  document?: Document;
  decodeTimeoutMs?: number;
  onTiming?: (timing: CanvasRasterizerTiming) => void;
}

export function canvasSvgRasterizer(options?: CanvasSvgRasterizerOptions): SvgRasterizer;
```

Rules:

- Importing `@atlcli/docx/browser-runtime` performs the idempotent installation as a deliberate side effect; `installDocxBrowserRuntime()` remains exported for explicit/test use. It installs only a namespaced helper such as `globalThis.__atlDocxByteHelpers` and never defines a fake global `Buffer`.
- `packages/docx/src/vite.ts` exports one frozen `DOCX_BROWSER_VITE_DEFINES` object mapping the three required `Buffer.*` expressions to that namespaced helper.
- The extension and harness spread that object into their own Vite `define` configuration. WXT/Vite configuration itself remains host-owned.
- Bootstrap-before-import is normative, not merely bootstrap-before-call. A browser host's entry imports `@atlcli/docx/browser-runtime` first and only then loads `@atlcli/docx/browser` with `await import(...)`. Preserve the extension's current shim-first/dynamic-engine-import ordering and reproduce it in the harness.
- Add a module-evaluation-order regression test. Removing/reordering the bootstrap must fail that test before an export is accepted; do not rely on static import source order across two dependency graphs.
- The current global rasterizer statistics remain extension-owned. The extension aggregates the neutral `onTiming` callback into its existing `RasterizerStats` model.
- `idbTemplateSource`, `sessionAssetFetcher`, its versioned cache, profile resolution, and DOM download policy stay in `apps/extension`.
- The browser runtime subpath must not be re-exported by the Node/default barrel.
- `memoryTemplateSource` snapshots exactly the supplied view range at construction and returns a fresh copy for each `getBytes()` call. A non-zero-offset `Uint8Array.subarray(...)` must not expose prefix/suffix bytes, and caller/result mutation must not alter later reads.

### 5.2 Confluence mention normalization

Move the content-only traversal currently implemented as `resolvePdfMentionNames` into a browser-safe public surface of `@atlcli/confluence`. The contract is format-neutral because it enriches `ExportBlock[]`, not PDF output:

```ts
export interface ExportMentionResolution {
  blocks: ExportBlock[];
  unresolved: number;
}

export type ExportMentionLookup = (
  accountIds: string[]
) => Promise<ReadonlyMap<string, string | null>>;

export function resolveExportMentions(
  blocks: ExportBlock[],
  lookup: ExportMentionLookup
): Promise<ExportMentionResolution>;
```

Contract rules:

- The helper deduplicates unresolved account IDs, performs one injected batch lookup, recursively handles links and nested block containers, and leaves already populated display names unchanged.
- The lookup returns only display-name strings or `null`; tenant clients, auth profiles, `UserInfo`, browser globals, and vendor response types never cross into `@atlcli/confluence`.
- Missing or blank lookup results retain the original technical identifier and increment `unresolved` once per unique account ID, matching current behavior.
- Lookup failures are not swallowed by the helper. Each host decides whether a failed lookup is fatal or becomes a warning while retaining the original blocks.
- The extension keeps its authenticated user loader and its current warning-note policy. Its page adapter passes walker notes followed by mention notes to the PDF runner as `sourceNotes`.
- The helper is available from the normal and browser-safe Confluence barrels and has no dependency on either export engine.

### 5.3 PDF host-neutral compile and runner contracts

Add `packages/pdf/src/compiler.ts`, `packages/pdf/src/run-export.ts`, and `packages/pdf/src/validate.ts`. Export them from both `index.ts` and `index.browser.ts`; none may import the compiler implementation.

Normative shape:

```ts
export interface PdfCompileResult {
  pdf?: Uint8Array;
  diagnostics: PdfCompilerDiagnostic[];
  compilerVersion: string;
}

export interface PdfCompileContext {
  signal?: AbortSignal;
}

export interface PdfCompilePort {
  compile(bundle: PdfSourceBundle, context?: PdfCompileContext): Promise<PdfCompileResult>;
}

export interface PdfOutputSink {
  emit(
    name: string,
    bytes: Uint8Array,
    context?: { signal?: AbortSignal }
  ): Promise<void>;
}

export interface PdfExportTimings {
  prepareMs: number;
  compileMs: number;
  emitMs: number;
  totalMs: number;
}

export type PdfExportPhase =
  | "preparing"
  | "fetching"
  | "compiling"
  | "validating"
  | "emitting";

export interface RunPdfExportInput {
  blocks: ExportBlock[];
  sourceNotes?: ExportNote[];
  metadata: PdfExportMetadata;
  profile?: PdfProfile;
  theme?: PdfThemeOptions;
  filename: string;
  signal?: AbortSignal;
  onPhase?: (phase: PdfExportPhase) => void;
}

export interface PdfExportEnv {
  assets: PdfAssetResolver;
  compiler: PdfCompilePort;
  output: PdfOutputSink;
  now?: () => number;
}

export type PdfExportErrorPhase =
  | "prepare"
  | "compile"
  | "validate"
  | "emit";

export class PdfExportError extends Error {
  readonly phase: PdfExportErrorPhase;
  readonly diagnostics: PdfCompilerDiagnostic[];
  readonly cause?: unknown;
  constructor(
    message: string,
    options: {
      phase: PdfExportErrorPhase;
      diagnostics?: PdfCompilerDiagnostic[];
      cause?: unknown;
    }
  );
}

export function runPdfExport(
  input: RunPdfExportInput,
  env: PdfExportEnv
): Promise<PdfExportReport>;
```

Contract rules:

- The runner accepts already-normalized `ExportBlock[]`. It never imports extension `LoadedPage` or calls `storageToBlocks` itself.
- The page adapter passes walker/conversion and mention notes as `sourceNotes`. The runner builds report notes in the existing order: walker notes, mention notes, then serializer/bundle notes.
- Metadata, profile, theme, filename, clock, assets, compiler, output, and phase observer are explicit inputs. Locale is part of explicit metadata; there are no ambient `document`/`navigator` defaults.
- The runner forwards `profile` and `theme` unchanged to `serializePdfDocument`. Its report records the selected profile or the serializer's existing `tagged` default; extraction must not silently discard the current extension theme input.
- The runner owns `preparePdfDocument`, serialization, prepared-block counts, report timings, validation, and output emission.
- Rename `PdfExportTimings.downloadMs` to the host-neutral `emitMs` in `@atlcli/pdf`. The extension report view continues to label that value **Download**; this is an internal contract cleanup, not a visible UX change.
- It checks abort before and after every awaited phase, passes the signal to the output sink, and never starts emission after observing abort. A sink must check the signal immediately before its irreversible write/click. Once that atomic action begins, cancellation is no longer promised; document this as the emission boundary.
- A `PdfCompilePort` that can hard-cancel must bind the signal to its worker/process lifecycle. A port that cannot interrupt a synchronous compiler must still reject pre-aborted work and the runner must discard a result if the signal becomes aborted.
- Compiler failures throw `PdfExportError` with phase `compile` and normalized `PdfCompilerDiagnostic[]`; infrastructure failures use the same PDF-specific error with an empty diagnostic array and preserved `cause`. A host using only `runPdfExport` can therefore render structured diagnostics. Third-party raw diagnostic fields never appear in the host-neutral contract.
- `validatePdfOutput` and `PdfOutputInspection` move unchanged from the extension to `@atlcli/pdf`.
- `normalizePdfLocale(value)` may move to `@atlcli/pdf` as a pure string helper, but reading `document.documentElement.lang` or `navigator.language` remains a host responsibility.
- The caller supplies the complete `.pdf` filename. Filename sanitization remains host policy.

The extension may retain its UI-only phase label `queued`; its adapter can emit `queued` while persisting the job before delegating to the compile port. Do not pollute the neutral runner with an IndexedDB-specific phase.

### 5.4 Browser compiler package

Create `packages/pdf-compiler-browser` with package name `@atlcli/pdf-compiler-browser`, `private: true`, and a single browser-focused public barrel.

Required dependencies:

```json
{
  "dependencies": {
    "@atlcli/pdf": "workspace:*",
    "@myriaddreamin/typst-ts-web-compiler": "0.7.0"
  }
}
```

Required public shape:

```ts
export const PDF_BROWSER_COMPILER_VERSION: string;

export interface BrowserPdfCompilerAssets {
  wasm: ArrayBuffer | URL | Response;
  fonts: Uint8Array[];
}

export class BrowserPdfCompiler {
  readonly version: string;
  constructor(assets: BrowserPdfCompilerAssets);
  compile(bundle: PdfSourceBundle): Promise<PdfCompileResult>;
  getLoadedFonts(): Promise<string[]>;
  reset(): Promise<void>;
}
```

Rules:

- Move the implementation from `apps/extension/utils/pdf/compiler.ts`; do not rewrite the algorithm while moving it.
- The raw Typst result/range type is private to this package. Normalize it via the existing `mapPdfDiagnostics` and source map before returning.
- A no-PDF result retains structured diagnostics; formatting a user-facing message lives in a pure PDF-domain helper, not in a Chrome adapter.
- Move the narrow ambient declaration for `typst_ts_web_compiler.mjs` beside this package. Do not move unrelated markdown plugin or `?url` declarations out of `apps/extension/types/vendor.d.ts`.
- Keep the root `patchedDependencies` entry exactly pinned. Add a test that fails if the patch disappears or dynamic `Function` construction becomes necessary again.
- Do not import `?url`, `?url&no-inline`, `chrome`, IndexedDB, WXT, or DOM download APIs.
- The extension remains a direct dependency owner of the Typst package while its worker imports the package's WASM `?url` asset directly. A host that statically imports that asset must declare the dependency it imports; workspace transitivity is not a substitute.

### 5.5 Extension compile-port adapter

Keep the existing extension job topology and wrap it behind `PdfCompilePort`:

```ts
export function extensionPdfCompilePort(options?: {
  makeJobId?: () => string;
  sourceIdentity: string;
  sendMessage?: (...args: never[]) => Promise<unknown>;
}): PdfCompilePort;
```

The exact option typing should reuse existing extension message types rather than the illustrative `never[]` above. Required behavior:

1. Persist the `PdfSourceBundle` in the existing bounded IndexedDB job store.
2. Send the correlated `pdf:compile` message.
3. On abort, send `pdf:cancel`; active work continues to be terminated by `PdfCompilerHost` and queued work removed.
4. Read completed bytes/compiler version on success and read normalized failed-job diagnostics before cleanup on compiler failure, returning them through the compile result so `PdfExportError` can preserve them.
5. Delete the job in `finally`, including abort/error paths.
6. Preserve current cleanup of stale jobs, job/store quotas, single-worker FIFO, timeout, and fatal reset behavior.

`apps/extension/utils/pdf/run-export.ts` becomes the page adapter:

- convert `LoadedPage.details.storage` with `storageToBlocks`;
- resolve missing mention display names with `resolveExportMentions` and an extension-owned authenticated lookup, retaining the current warning-note behavior;
- derive explicit metadata/locale;
- pass the caller's theme and selected/default profile through the neutral runner;
- create the session-aware `PdfAssetResolver`;
- sanitize the filename;
- create the extension compile port and DOM output sink;
- map neutral phases to existing UI phases;
- call `@atlcli/pdf/browser`'s runner.

The following remain under `apps/extension` unless a separate future spec proves a second consumer of the topology itself:

- `job-store.ts`;
- `compiler-host.ts` and its IndexedDB defaults;
- `worker-protocol.ts`;
- extension message/router/listener types;
- `background.ts` and offscreen document lifecycle;
- `workers/pdf-compiler.ts` static asset imports;
- DOM download and page/session/profile policy.

### 5.6 Canonical PDF runtime asset manifest

Add a browser-safe manifest under `packages/pdf/src/runtime-assets.ts` containing only data:

- ten canonical font filenames;
- family/style metadata;
- immutable SHA-256 values already used by `ensure-fonts.ts`/output checks;
- three font license filenames;
- logical compiler license requirement.

Consumers:

- `packages/pdf/scripts/ensure-fonts.ts` uses the manifest rather than a duplicate list;
- compiler tests load the manifest's exact fonts;
- extension and harness retain explicit static `?url` imports, then a parity test proves the imported filenames equal the manifest;
- extension/harness artifact checks use the same manifest for expected fonts/licenses/hashes.

Do not generate dynamic asset import strings from the manifest. Vite must see every WASM/font/license import statically.

---

## 6. Permanent browser conformance harness

### 6.1 Purpose and constraints

Create `apps/browser-export-harness` as a private workspace app. Its only purpose is to prove that public package surfaces work in a second browser host.

This is package conformance evidence under a self-controlled Vite/Chromium runtime, not certification for every embedded or managed browser host. Host-specific packaging, CSP, iframe, bridge, and static-resource behavior must be validated by that host's own integration E2E outside this spec.

It must:

- use vanilla TypeScript + Vite; React is unnecessary;
- set Vite `base: "./"` so the production artifact does not assume deployment at an origin root;
- use a dedicated module Worker for PDF compilation;
- run from a production `dist/` build, not only Vite dev mode;
- have no network dependency after the local page/assets load;
- use only committed/generated local fixtures and pinned runtime assets;
- use no `chrome.*`, WXT, extension storage/message types, extension URL, or live Atlassian session;
- expose deterministic `data-testid` states so Chromium automation asserts outcomes rather than screenshots;
- remain obviously non-product UI.

Suggested files:

```text
apps/browser-export-harness/
  index.html
  package.json
  tsconfig.json
  turbo.json
  vite.config.ts
  playwright.config.ts
  src/
    main.ts
    docx-case.ts
    pdf-case.ts
    pdf-worker.ts
    pdf-worker-client.ts
    fixture.ts
    memory-output.ts
    style.css
  tests/
    exports.e2e.ts
    boundaries.test.ts
    output-scan.test.ts
  scripts/
    check-output.ts
```

### 6.2 DOCX conformance case

The DOCX case must:

1. install `@atlcli/docx/browser-runtime`;
2. consume `runExport` only through `@atlcli/docx/browser`;
3. use an engine-owned browser-safe template/page fixture, not an import from extension tests;
4. use `memoryTemplateSource` and an in-memory DOCX `OutputSink`;
5. include at least one Mermaid diagram and use the real neutral canvas rasterizer in Chromium;
6. assert that `globalThis.Buffer` is absent;
7. return the report and bytes to the harness state.

Assertions:

- bytes start with the ZIP signature;
- the existing structural golden assertion or a browser-safe equivalent confirms required DOCX parts/content;
- report counts/notes match the engine fixture;
- diagram output is embedded rather than silently downgraded;
- no page error or unhandled rejection occurs.

Do not require raw byte identity for DOCX.

If the current golden helper is Node-only, split fixture data and structural expectations into a browser-safe test-support subpath; keep filesystem/ZIP inspection adapters in their respective test environments.

### 6.3 PDF conformance case

The PDF case must:

1. create a fixed `ExportBlock[]`, metadata, filename, source notes, asset resolver, and in-memory output sink;
2. call `runPdfExport` from `@atlcli/pdf/browser` twice, using one warm harness-owned Worker client as its `PdfCompilePort`;
3. load the WASM/fonts/licenses through explicit static Vite imports in `pdf-worker.ts`;
4. instantiate `BrowserPdfCompiler` from `@atlcli/pdf-compiler-browser` inside the Worker;
5. inspect the reports and bytes captured by the in-memory sink after each runner call;
6. independently validate captured bytes with `validatePdfOutput` from `@atlcli/pdf`;
7. preserve the Worker/compiler instance between calls so the same input is compiled twice warm.

Assertions:

- both outputs start with `%PDF-` and pass structural validation;
- outputs are byte-identical on the warm repeat;
- tagged structure, outline, and embedded fonts remain present;
- compiler version is reported;
- diagnostics are normalized and source-mapped;
- no IndexedDB, extension message, or extension source import is used;
- aborting a queued/active harness request terminates or replaces its Worker and never emits bytes.

The harness protocol transfers the `PdfSourceBundle` and PDF bytes directly. It must not copy the extension's job-ID-only/IndexedDB protocol.

### 6.4 CSP and artifact policy

Serve the production harness with a restrictive local CSP that permits the required local Worker and WebAssembly execution but does not allow `unsafe-eval` or remote scripts. Mirror the relevant intent of the extension CSP without copying its manifest mechanics.

The harness output checker must inspect `dist/` and fail with the exact output file when it finds:

- `node:` or `bun:` import specifiers;
- bare `Buffer.*`, `process.*`, or CommonJS `require(` runtime references;
- `eval(`, dynamic `Function`, or remote executable code;
- `chrome.*`, `chrome-extension://`, WXT runtime imports, or extension message literals;
- missing worker, WASM, any manifest font/license, or local entry HTML;
- root-relative JavaScript, Worker, WASM, font, or license asset URLs that break when the artifact is mounted below an origin path;
- a remote URL used for executable/runtime assets.

Seeded negative-fixture tests must prove each scanner category actually fails.

### 6.5 Browser automation

Use a pinned `@playwright/test` dependency and Chromium only. The E2E must serve the production Vite output below a non-root path and run both cases in one browser context so relative asset loading and warm compiler behavior are observable.

Required root scripts:

```json
{
  "scripts": {
    "typecheck:pdf-compiler-browser": "turbo run typecheck --filter=@atlcli/pdf-compiler-browser",
    "typecheck:browser-export-harness": "turbo run typecheck --filter=@atlcli/browser-export-harness",
    "build:browser-export-harness": "turbo run build --filter=@atlcli/browser-export-harness",
    "check:browser-export-harness": "bun run --cwd apps/browser-export-harness check:output",
    "test:browser-export-harness": "bun run --cwd apps/browser-export-harness test:e2e"
  }
}
```

The harness package mirrors the extension's clean-checkout font provisioning:

```json
{
  "scripts": {
    "pretypecheck": "bun run --cwd ../.. fonts:ensure",
    "prebuild": "bun run --cwd ../.. fonts:ensure",
    "pretest:e2e": "bun run --cwd ../.. fonts:ensure"
  }
}
```

Its build/output/E2E scripts may assume fonts only because these hooks are present. CI must also run `bun run fonts:ensure` explicitly before the filtered harness gates so correctness does not depend on package-manager pre-script behavior.

CI installs only Playwright Chromium and runs, in order:

1. `bun run fonts:ensure`;
2. harness typecheck;
3. harness production build;
4. harness output scan;
5. harness Chromium E2E.

Keep Bun package/unit tests as the faster first line. The Chromium gate is the built-runtime proof, not a replacement.

---

## 7. Ordered implementation plan

Each task is a separately reviewable working-tree checkpoint. Repository policy requires the configured extension E2E before every commit, so do not commit an intermediate checkpoint unless that E2E has run and its resources were cleaned. The default execution path is to keep the checkpoints uncommitted, complete Task 8, then create logical commits only after the full E2E passes. Do not combine package extraction, extension rewiring, and browser-harness proof into one unreviewable final commit.

### Task 0 — Capture baselines and characterize current behavior

Files changed: tests/fixtures only if a missing stable baseline must be added; no production moves yet.

Actions:

1. Run the drift check from section 2.2.
2. Install the exact lockfile dependencies with `bun install --frozen-lockfile` if the worktree has no `node_modules`.
3. Run the current DOCX golden/node-consumer tests and PDF compiler/run-export/validation tests, including the existing PDF theme-passthrough and mention-resolution cases.
4. Render the current PDF fixture to an explicit temporary path and record its SHA-256, byte count, structural inspection, and compiler version in the implementation notes.
5. Build/scan the current extension and record the artifact inventory.
6. Verify the existing extension behavior in Chrome against the configured test profile only if credentials are available. If credentials are not available, record that as an environment limitation; do not claim E2E.

Commands:

```bash
bun test packages/docx/src/golden.test.ts packages/docx/src/node-consumer.test.ts
bun test apps/extension/tests/pdf/compiler.test.ts apps/extension/tests/pdf/run-export.test.ts apps/extension/tests/pdf/validate.test.ts
bun run --cwd apps/extension pdf:fixture -- /tmp/atlcli-spec009-before.pdf
shasum -a 256 /tmp/atlcli-spec009-before.pdf
bun run build
bun run check:extension-output
```

Acceptance:

- current tests are green, or every pre-existing failure is recorded before code moves;
- a reproducible pre-move PDF fixture exists outside the repo;
- no production code changed.

STOP if the baseline itself fails for a suspected product defect. Fixing export behavior is outside this move-only task and requires a separate regression change/spec update.

### Task 1 — Add content normalization plus PDF-domain contracts, validation, and asset manifest

Files:

- add `packages/confluence/src/resolve-mentions.ts`, export it from the normal/browser barrels, and add focused traversal/lookup tests;
- add `packages/pdf/src/compiler.ts`;
- add `packages/pdf/src/run-export.ts`;
- move `apps/extension/utils/pdf/validate.ts` to `packages/pdf/src/validate.ts`;
- add `packages/pdf/src/runtime-assets.ts`;
- update `packages/pdf/src/index.ts`, `index.browser.ts`, `package.json`, tests, and font provisioning;
- add package-level runner/abort/diagnostic/validation/manifest tests.

Actions:

1. Add `resolveExportMentions` from section 5.2 with deep traversal, deduplicated lookup, immutability, unresolved-count, existing-name, empty-input, and lookup-failure tests; keep it free of tenant clients, auth, browser globals, and export-format dependencies.
2. Add the PDF contracts from section 5.3 with no defaults that touch ambient browser state.
3. Move prepared-block counting, phase/timing/report construction, validation, and emission into the neutral runner.
4. Move locale normalization only as a pure function; keep ambient locale discovery in the extension.
5. Preserve explicit `profile` and `theme` through serialization and report construction; add a regression test that would fail if either is dropped during extraction.
6. Rename the PDF-domain timing field from `downloadMs` to `emitMs`; update type/tests while keeping the extension's visible **Download** label later in Task 4.
7. Move output validation and its tests from the extension.
8. Create the data-only runtime asset manifest and make `ensure-fonts.ts` consume it.
9. Add compile-port/sink fakes covering success, structured failure, pre-abort, abort during compile, post-compile abort, validation failure, output-sink failure, and abort while a deliberately pending sink is still before its irreversible emission boundary.
10. Assert that a preparation-only import does not import/resolve the Typst package.

Acceptance:

- `@atlcli/pdf/browser` still builds with no Typst/WASM dependency in its transitive emitted graph;
- `@atlcli/confluence` mention tests prove nested traversal and lookup behavior without importing a tenant API type or either export engine;
- neutral runner tests do not import `LoadedPage`, Chrome messages, IndexedDB, DOM, or extension files;
- non-default PDF theme/profile inputs survive the neutral runner and the report reflects the effective profile;
- every failure and every abort observed before the emission boundary emits zero bytes;
- existing serializer/source-map tests remain unchanged and green.

### Task 2 — Extract the dedicated browser PDF compiler package

Files:

- add `packages/pdf-compiler-browser/package.json`, `tsconfig.json`, `src/index.ts`, implementation, private vendor declaration, and tests;
- migrate `apps/extension/tests/pdf/compiler.test.ts` and compiler-specific fixture logic into the new package;
- update `apps/extension/workers/pdf-compiler.ts`, `apps/extension/scripts/render-pdf-fixture.ts`, `apps/extension/utils/pdf/job-store.ts`, and their tests to consume the new normalized compiler surface;
- update root browser-build inputs, TypeScript/Turbo inputs, and `bun.lock`;
- delete `apps/extension/utils/pdf/compiler.ts` only after all consumers use the package.

Actions:

1. Move the current adapter without changing initialization/VFS/reset semantics.
2. Normalize raw diagnostics before returning the public result.
3. Preserve the exact compiler version and root patch.
4. Move real-WASM, all-fonts, invalid-Typst, source-map, CSP, and deterministic-repeat coverage with the compiler; add a package-level `BrowserPdfCompiler.reset()` lifecycle test.
5. Rewire every active compiler consumer—the extension worker and fixture renderer included—to the new package in this task; migrate the ephemeral job diagnostic field/tests from raw to normalized diagnostics.
6. Keep the worker's host-specific static `?url` imports in the extension and keep equivalent imports out of the compiler package.
7. Add the compiler package's entrypoint to `scripts/check-browser-build.ts` and its test expectations.
8. Add package-local `typecheck`/Turbo wiring and chain `typecheck:pdf-compiler-browser` into the root typecheck gate; add a coverage regression proving the package program is invoked.
9. Delete the old compiler only after `rg` proves no active consumer remains.

Acceptance:

- real compilation tests pass from `packages/pdf-compiler-browser`;
- isolated `typecheck:pdf-compiler-browser` passes and is covered by the root gate;
- the package imports only `@atlcli/pdf` plus the pinned wrapper;
- no raw Typst diagnostic type escapes the package barrel;
- `bun run check:browser` includes and passes the new package;
- deleting the old extension compiler file leaves no stale imports.

### Task 3 — Extract DOCX browser bootstrap and neutral DOM capability

Files:

- add `packages/docx/src/browser-runtime.ts`, `packages/docx/src/vite.ts`, and package tests;
- update `packages/docx/package.json` exports;
- refactor `apps/extension/utils/docx/env.ts`, `apps/extension/utils/byte-helpers-shim.ts`, `apps/extension/wxt.config.ts`, side-panel bootstrap, and tests;
- delete the local shim only after both package and extension gates pass.

Actions:

1. Move the helper implementation and Vite define map under the DOCX package.
2. Rename the global to a DOCX-specific namespace and make installation idempotent.
3. Extract memory template and canvas rasterization as specified; keep extension stats via the timing hook.
4. Keep extension IDB/session/cache/download adapters in place.
5. Rewire WXT to import/spread `DOCX_BROWSER_VITE_DEFINES`; keep the side-panel entry's bootstrap as its first import and keep the engine behind a subsequent dynamic import.
6. Add module-evaluation-order tests plus a boundary test rejecting a static engine import in a browser host bootstrap; prove no native/global `Buffer` is created.
7. Add `memoryTemplateSource` tests for a non-zero-offset subarray, caller mutation, result mutation, and repeated reads.
8. Before replacing the current rasterizer singleton, add extension regression tests for reset between exports, per-call and summed decode/draw/encode timings, call count, and conditional `perf-timing` report-note aggregation in `TemplateSection`.

Acceptance:

- DOCX golden structural output is unchanged;
- the newly added extension canvas timing/report characterization tests remain green through extraction;
- Node consumer never imports browser runtime/bootstrap;
- browser runtime entry passes `check:browser`;
- extension artifact contains neither bare `Buffer.*` nor a fake global `Buffer`.

### Task 4 — Rewire the extension around the neutral PDF runner

Files:

- refactor `apps/extension/utils/pdf/run-export.ts` into page adapter plus compile-port adapter;
- update tests under `apps/extension/tests/pdf/**`, router/listener/host/store tests, side-panel code, manifests as necessary;
- retain all Chrome/WXT/IndexedDB files in `apps/extension`.

Actions:

1. Implement `extensionPdfCompilePort` over the current job/message system.
2. Make the page adapter derive blocks plus walker notes, resolve mentions through the Confluence helper using its authenticated host lookup, then derive explicit metadata, locale, theme/profile, asset resolver, sanitized filename, and output sink; pass walker plus mention notes as `sourceNotes` so report ordering remains unchanged.
3. Preserve the current `queued` phase at the adapter layer and map neutral `emitting` back to the existing UI's `downloading` label.
4. Update the report view to read neutral `emitMs` while preserving its visible **Download** label.
5. Update the DOM PDF sink to check the supplied signal immediately before the anchor click and cover abort while the sink is pending.
6. If the Task-2 normalized diagnostic migration requires a DB version change, clear/version the ephemeral store safely rather than reading mixed raw/normalized records.
7. Keep hard cancellation in the extension compiler host; test queued, active, navigation-abort, timeout, fatal-worker, cleanup, and no-download-after-abort paths.
8. Keep explicit static WASM/font/license imports in the worker and add manifest parity coverage.

The existing fatal-worker termination/replacement test remains under `apps/extension/tests/pdf/compiler-host.test.ts`; it verifies host topology, not the low-level compiler package.

Acceptance:

- current extension phase order and UI messages remain equivalent;
- current mention warnings, theme customization, and default PDF profile behavior remain equivalent;
- current IndexedDB quotas and cleanup tests remain green;
- the extension compiler worker imports the new package but no reusable package imports extension files;
- after-move PDF fixture hash equals the Task-0 fixture hash. If a deliberate normalized metadata change makes raw bytes differ, STOP: this is no longer a move-only refactor and needs a reviewed exception;
- extension build/output scan passes.

### Task 5 — Add the neutral Vite/Worker/Chromium harness

Files: all files listed in section 6 plus root workspace scripts/dependencies.

Actions:

1. Scaffold the private vanilla Vite app with explicit TypeScript/Turbo coverage and `base: "./"`.
2. Add the DOCX case and independent assertions.
3. Add the PDF direct-worker case and independent assertions.
4. Add local CSP headers for dev/preview/production E2E server.
5. Add the generic artifact scan and seeded negative tests, including rejection of root-relative JS/Worker/WASM/font/license URLs.
6. Add dependency-boundary tests that reject extension/WXT imports and package-direction violations.
7. Add Playwright Chromium automation against the production build served below a non-root path.

Acceptance:

- both buttons/cases pass in Chromium with `globalThis.Buffer === undefined`;
- PDF runs in a real Worker with real WASM/fonts and deterministic warm output;
- DOCX uses the package bootstrap and real canvas path;
- output scan proves all assets are local and no extension/runtime leaks exist;
- the production artifact loads all entry, Worker, WASM, font, and license assets correctly from a nested path;
- disabling the DOCX Vite defines or removing one PDF font causes a targeted harness gate to fail.

### Task 6 — Harden build graph, artifact gates, and CI

Files:

- root `package.json`, `turbo.json`, `tsconfig.json`, `bun.lock`;
- `apps/extension/turbo.json`, `tests/build-helper.ts`, typecheck coverage tests;
- harness Turbo/tsconfig/config/scripts;
- `scripts/check-browser-build.ts` and tests;
- generic artifact/boundary scripts if extracted;
- `.github/workflows/ci.yml`.

Actions:

1. Add every new source entry to browser-build gates.
2. Ensure root/typecheck scripts explicitly cover app TS/TSX, Vite configs, workers, and tests that root `tsconfig.json` currently skips.
3. Expand extension stale-build inputs to all actual workspace dependencies: at minimum core, confluence, diagram, docx, pdf, and pdf-compiler-browser.
4. Give the harness a local `turbo.json` whose inputs include `src/**`, tests, scripts, `index.html`, styles, Vite/Playwright config, package, tsconfig, font/license inputs, and dependent package sources; output is `dist/**` plus Playwright results only when intentionally cached.
5. Parameterize generic artifact scanning without weakening the extension-specific manifest/CSP/inventory checks; retain the harness's relative-asset deployment rule as a harness-specific assertion.
6. Add Chromium installation and harness gates to CI.
7. Preserve the complete existing final gate set.

Acceptance:

- changing a shared package source invalidates both extension and harness artifacts;
- a seeded TSX/type error in the harness is caught by the root typecheck path;
- a seeded forbidden dependency or built artifact token names the exact source/output file;
- CI ordering prevents E2E from running against a stale/dev build.

### Task 7 — Documentation, supersession notes, and cleanup

Files:

- `src/content/docs/reference/docx-engine.md`;
- `src/content/docs/reference/pdf-engine.md`;
- `apps/extension/README.md`;
- root `README.md` project structure/spec path references;
- narrow notes in specs 002, 006, 007, and dependency update in 008;
- package/harness READMEs as needed.

Actions:

1. Document separate DOCX/PDF pipelines and the shared `ExportBlock` seam.
2. Document the browser compiler package versus host-owned worker/job topology.
3. Mark spec 007's implemented baseline accurately without rewriting its historical task record.
4. Add explicit supersession notes at the affected clauses named in section 4.3.
5. Update spec 008 to depend on 009 and validate both extension and neutral browser evidence.
6. Update project structure to include extension, docx, pdf, pdf-compiler-browser, harness, and `specs/`.
7. Search for and remove stale imports/comments claiming all browser adapters/compiler code belongs in the extension.

Acceptance:

- docs never describe DOCX and PDF as one engine;
- no public doc mentions a vendor-specific embedded product in this public architecture spec;
- historical specs remain understandable and point to the narrowly superseding rule;
- `rg` finds no stale path to the deleted compiler/shim implementations;
- `bun run docs:check` and `bun run docs:build` pass.

### Task 8 — Final verification and implementation handoff

Run the full matrix in section 8. Perform the configured user-assisted extension E2E, clean all created test resources, and record:

- implementation SHA;
- Bun/Chromium versions;
- DOCX structural parity result;
- pre/post PDF fixture hashes;
- extension artifact result;
- neutral harness artifact result;
- neutral Chromium DOCX/PDF results;
- any environment limitations or accepted deviations.

Do not release or publish packages. Do not push until explicitly requested.

---

## 8. Verification matrix

### 8.1 Fast package and boundary tests

```bash
bun test packages/docx/src
bun test packages/pdf/src
bun test packages/pdf-compiler-browser/src
bun test apps/extension/tests/docx apps/extension/tests/pdf
bun test apps/browser-export-harness/tests/boundaries.test.ts apps/browser-export-harness/tests/output-scan.test.ts
bun run check:browser
```

Required assertions:

- package direction is legal;
- mention normalization traverses nested content without importing host auth/client types;
- no compiler dependency leaks into PDF preparation barrel;
- no Node/extension import leaks into browser entries;
- diagnostics are normalized;
- abort paths never emit;
- theme/profile inputs survive neutral PDF orchestration;
- asset manifest parity is exact.

### 8.2 Type and build gates

```bash
bun run typecheck
bun run typecheck:extension
bun run typecheck:pdf-compiler-browser
bun run typecheck:browser-export-harness
bun run build
bun run build:browser-export-harness
```

All commands must be run from a clean implementation worktree with lockfile dependencies installed. Do not treat a Turbo cache hit as sufficient after changing build inputs; run once with the relevant cache removed or forced according to Turbo's supported non-destructive option.

### 8.3 Artifact gates

```bash
bun run check:extension-output
bun run check:browser-export-harness
```

Both real artifacts must be scanned. A source-only `bun build --target=browser` pass is necessary but insufficient.

### 8.4 Real browser gate

```bash
bun run test:browser-export-harness
```

This gate must run against production `dist/`, under Chromium, with real Worker/WASM/canvas behavior and no live network/auth dependency.

### 8.5 Full suite

```bash
bun run fonts:ensure
bun test
bun run typecheck
bun run check:browser
bun run build
bun run check:extension-output
bun run check:browser-export-harness
bun run test:browser-export-harness
bun run docs:check
bun run docs:build
```

Apply the repository's documented Bun/Linux zero-failure workaround only in CI and only when Bun reports exactly zero failures. Never mask named errors or non-zero failure counts.

### 8.6 User-assisted extension E2E

Using the configured test profile/space from repository instructions:

1. Open a representative feature-zoo page in Chrome.
2. Export DOCX with a known template; inspect placeholders, images, diagram, headings, table, code, and TOC/update behavior.
3. Export PDF; inspect tags/outline/fonts/images/diagram and phase/report UI.
4. Start a PDF export and navigate/abort; verify no download and no stale completion.
5. Repeat a warm PDF export; verify deterministic output contract.
6. Clean any page/attachment/test resources created by the E2E.

If credentials or browser access are unavailable, mark this gate **not executed**, leave the implementation uncommitted, and report Task 8/Definition of Done as blocked. Tests read or harness E2E are not substitutes for the extension E2E claim.

---

## 9. Definition of done

The implementation is complete only when all of the following are true:

- [ ] DOCX and PDF remain separate engines/packages with no dependency between them.
- [ ] `@atlcli/confluence` owns reusable mention normalization while authenticated lookup and warning policy remain host-owned.
- [ ] `@atlcli/docx/browser-runtime` owns the reusable DOCX browser bootstrap/config and neutral DOM capability.
- [ ] `@atlcli/pdf` owns neutral PDF runner contracts, validation, normalized diagnostics, and the asset manifest without importing Typst.
- [ ] The neutral PDF runner preserves explicit theme/profile options and reports the effective profile.
- [ ] `@atlcli/pdf-compiler-browser` exists as a private, browser-only implementation package.
- [ ] The extension consumes all new public surfaces and retains Chrome/session/job/offscreen/UI policy.
- [ ] The old extension-local compiler and byte-helper implementations are deleted after migration.
- [ ] Raw Typst diagnostics do not cross the compiler package boundary.
- [ ] PDF preparation consumers do not bundle compiler/WASM code.
- [ ] Static host asset imports match the canonical manifest.
- [ ] The permanent Vite harness runs DOCX and PDF independently in Chromium.
- [ ] The harness proves real Worker/WASM and real canvas behavior without extension APIs or native `Buffer`.
- [ ] The harness artifact uses relative asset URLs and passes production Chromium E2E when served below a non-root path.
- [ ] Harness evidence is described only as package conformance; host-specific packaging/CSP/iframe claims require separate host evidence.
- [ ] DOCX structural golden parity and PDF pre/post byte parity pass.
- [ ] PDF abort/cancel/timeout/cleanup behavior remains covered and no PDF export starts emission after observing abort.
- [ ] Browser source, extension artifact, and harness artifact gates all pass.
- [ ] Typecheck/Turbo/CI inputs cover TSX, workers, configs, fixtures, fonts, licenses, and transitive workspace sources.
- [ ] Current docs and narrow historical supersession notes are updated.
- [ ] Full automated suite passes.
- [ ] User-assisted extension E2E passes and all created resources are cleaned; if it cannot run, implementation remains blocked and uncommitted rather than being declared done.
- [ ] No package is published, no release is made, and no push occurs without explicit instruction.

---

## 10. Risks and STOP conditions

| Risk | Detection | Mitigation / STOP rule |
|---|---|---|
| DOCX bootstrap still depends on host import order | neutral Chromium case fails with missing helper | Keep an actionable runtime assertion and one documented install call; do not create global `Buffer`. STOP if third-party code executes the helper during module evaluation before installation; then evaluate a prebuilt DOCX browser entry as a separate reviewed design. |
| Compiler move changes PDF bytes | pre/post fixture hash differs | STOP and isolate the first differing source/asset/metadata/compiler input. Do not accept a “likely harmless” output change in this refactor. |
| Typst wrapper typing still comes from extension ambient declarations | package typecheck fails or succeeds only in extension program | Move only the narrow compiler declaration beside the new package and add isolated package typecheck. |
| Host asset list drifts | manifest parity/output scan fails | Keep static imports per host plus manifest equality test; never hide imports behind runtime-generated paths. |
| Neutral runner recreates extension topology | imports include job store/message/LoadedPage | Reject the change. Runner accepts blocks and ports; extension adapter owns topology. |
| Mention normalization remains format- or host-bound | PDF/extension types or tenant clients appear in the traversal helper | Keep only `ExportBlock[]` plus a display-name lookup port in `@atlcli/confluence`; authenticated lookup and warning notes remain host-owned. |
| Generic abstraction erases formats | new union report/format switch/shared engine appears | Reject the change and restore sibling DOCX/PDF lanes. Shared tooling is allowed; a shared export engine is not. |
| Generic harness is mistaken for target-host certification | plan/docs claim portability without target packaging/CSP/iframe evidence | Treat it only as self-controlled package conformance. Keep target-specific E2E separate and do not grow the public harness into a vendor implementation. |
| Browser E2E becomes flaky/slow | repeated CI retries/timeouts | Use one Chromium project, production build, local assets, one browser context, warm compiler reuse, and explicit timeouts. Do not weaken assertions to hide flakes. |
| Turbo serves stale artifact | changed package source does not rebuild host | Expand declared inputs and add stale-build regression coverage before trusting artifact tests. |
| Extension cancellation regresses after neutral runner split | active/queued abort test downloads or leaks job | Preserve hard cancel in the extension compile-port adapter; STOP before UI migration if the old semantics cannot be represented. |
| Desktop/native concerns leak into current browser package | Node/native imports or save-dialog API appears | Keep future native compiler/output adapters out of scope. The compile/output ports are the only planned seam. |
| Package extraction silently becomes publication API | packages lose `private: true` or public semver work begins | STOP; publication is a separate product/release decision. |

---

## 11. Maintenance notes for future hosts

A future browser-based host should implement two independent integrations:

- DOCX: install the DOCX browser runtime, supply `TemplateSource`, `AssetFetcher`, optional `SvgRasterizer`, and DOCX `OutputSink`, then call `@atlcli/docx`'s `runExport`.
- PDF: normalize content to `ExportBlock[]`, optionally enrich mentions through `resolveExportMentions` with a host-owned lookup, supply PDF metadata and any theme/profile choice, `PdfAssetResolver`, a host-specific `PdfCompilePort`, and PDF `PdfOutputSink`, then call `@atlcli/pdf`'s `runPdfExport`.

A future desktop webview may reuse both browser lanes. It may replace only output with a native save sink, and it may later replace the PDF compile port with a native Typst adapter. That does not justify combining the engines today.

A future server host should use the same PDF runner contract with a server compiler port and the same DOCX engine with server env adapters. It must not import `@atlcli/pdf-compiler-browser` unless it intentionally runs a browser/WASM runtime.

When updating compiler/fonts:

1. update the exact compiler dependency and root patch deliberately;
2. update the compiler version constant;
3. update the canonical asset manifest/checksums/licenses;
4. update every host's explicit static imports;
5. run package real-compiler tests, both artifact scans, and Chromium conformance;
6. review output parity as an intentional export change, not a dependency-only chore.

---

## 12. Unresolved questions

No blocking architecture questions remain for implementation.

Deferred product/release questions, explicitly outside this spec:

1. Whether any private workspace package should later be published independently.
2. Whether a desktop application uses the browser compiler or a native Typst adapter for final output.
3. Whether a self-hosted service adopts the neutral PDF runner and which server compiler implementation it uses.
4. Whether future product hosts share any UI components; this plan shares runtime contracts and proof only.
