# DOCX Shiki engine separation and preload

Status: implemented and verified
Baseline: `a6b4c42` (`origin/main`), 2026-07-26

## Goal

Browser consumers must use Shiki's JavaScript RegExp engine without emitting
the Oniguruma engine or its WASM payload. Node/Bun consumers keep Oniguruma.
The selection must happen at the package-entry/host boundary so a browser
bundler never discovers the Node engine module.

DOCX hosts also get an awaitable, idempotent language preload and structured
highlight timing. Typst compilation and the PDF compiler/runtime contracts stay
unchanged.

## Current architecture and measured baseline

The active code path no longer uses `packages/docx/src/highlight.ts`.
`packages/docx/src/serialize.ts` imports highlighting from the shared
`@atlcli/code-highlight` package, which is also used by `@atlcli/pdf`.
The old DOCX-local module is reached only by its local regression test.

`packages/code-highlight/src/index.ts` currently contains both dynamic imports:

- `shiki/engine/oniguruma` plus `shiki/wasm`
- `shiki/engine/javascript`

It selects between them with a runtime WebAssembly compilation probe. A Vite
browser build therefore sees both dependency graphs even when the eventual
runtime branch chooses JavaScript.

The current shared package exposes Shiki's full pinned language and theme
catalogues. This work must preserve that public catalogue and must not restore
the older 22-language DOCX-local registry.

Baseline commands:

```bash
bun run test packages/code-highlight/src/index.test.ts packages/docx/src/highlight.test.ts packages/docx/src/serialize.test.ts
bun run build:browser-export-harness
bun run check:browser-export-harness
```

After installing the lockfile-pinned dependencies, the focused baseline passed
132 tests. The production harness build emitted all of the following:

| Artifact | Baseline size | Meaning |
| --- | ---: | --- |
| `engine-oniguruma-*.js` | about 6.5 KB | unwanted in browser DOCX |
| large `wasm-*.js` payload | about 608 KB | unwanted Oniguruma WASM |
| `engine-javascript-*.js` | about 56 KB | required browser engine |
| `typst_ts_web_compiler_bg-*.wasm` | about 27 MiB | expected PDF compiler; out of scope |

The output scanner currently accepts this state. A new gate must reject
Oniguruma by engine filename and content signatures. It must not reject every
`wasm-*.js` file because Shiki also ships a legitimate WebAssembly language
grammar under that name.

## Architecture

### Engine boundary

`@atlcli/code-highlight` will have three layers:

1. `highlight.ts`: catalogue lookup, aliases, token/source contract, theme and
   grammar/highlighter caches, timing hooks, and engine registration. It imports
   no concrete RegExp engine.
2. `highlight-engine-javascript.ts`: imports and registers only
   `createJavaScriptRegexEngine`.
3. `highlight-engine-oniguruma.ts`: imports and registers only
   `createOnigurumaEngine` and `shiki/wasm`.

Conditional package entries select one wrapper:

- browser entry installs JavaScript and re-exports the shared contract;
- default Node/Bun entry installs Oniguruma and re-exports the shared contract.

This preserves direct `@atlcli/code-highlight` consumers, including the shared
PDF preparation code, without adding an unconfigured state to existing host
paths. `@atlcli/docx/browser-runtime` and the DOCX Node entry also make their
host choice explicit and idempotent. Importing a different engine is allowed
only before the first highlighter use; a later switch throws.

The extension offscreen document is a separate realm from the side panel and
must bootstrap the browser runtime before dynamically loading its DOCX
executor.

### Preload

The low-level package adds:

```ts
prepareCodeHighlighting(languages, theme): Promise<void>
```

It canonicalizes aliases, ignores unknown languages, shares the existing
per-theme/per-language promises, awaits only the requested grammars, and is
idempotent across concurrent and repeated calls. `warmHighlight` stays as the
fire-and-forget compatibility wrapper.

DOCX adds:

```ts
prepareDocxCodeHighlighting(
  blocks,
  options?: { codeTheme?: CodeThemeId },
): Promise<void>
```

The recursive collector covers nested lists, layouts, tables, callouts,
expands, blockquotes, and orientation regions. It excludes Mermaid because that
uses the diagram seam. With no known highlighted language it resolves without
initializing Shiki.

### Timing

`ExportTimings` gains additive fields:

- `highlightEngineInitMs`
- `highlightGrammarLoadMs`
- `highlightTokenizeMs`
- `highlightCodeBlocks`
- `highlightLanguageCount`

Engine initialization is the one-time highlighter/core/theme/engine setup.
Grammar time covers the wall time of the parallel requested-grammar batch:
imports, Shiki loads, and deterministic dummy compiles. It is not the sum of
overlapping per-grammar waits. Tokenization time covers only real source
blocks. Initialization and grammar metrics report newly performed work, so an
export after an external preload correctly reports zero for those phases while
retaining tokenization time.

One export-wide collector covers both the main document and included-page
occurrences. Code-block count follows actual occurrences; language count is
distinct across the export. These values are diagnostic sub-phases and are not
added to `bodyMs` when calculating total time.

Historic prepared `/1` checkpoints may not contain the new additive timing
fields, so render-time normalization supplies zero defaults.

## Verification gates

- Browser DOCX build contains JavaScript engine only.
- No `engine-oniguruma-*` chunk or Oniguruma runtime signature in harness or
  extension output.
- Node/Bun highlighting still initializes Oniguruma.
- Typst/PDF compiler code and expected Typst WASM inventory are unchanged.
- Alias and canonical IDs share one grammar promise.
- Unknown languages and missing languages retain their current plain fallback.
- First and repeated tokenization are identical.
- Source text, including every trailing empty line, is exact.
- The full pinned Shiki catalogue remains available; representative language
  fixtures preserve source and produce tokens.
- Cold export and preload-plus-warm export run in separate fresh browser
  contexts and produce byte-identical DOCX output for the same pinned export
  date.
- Focused tests, browser checks, typecheck, browser harness, extension output
  scan, and real DOCX artifact validation pass.

## Unresolved questions

None. The current shared `@atlcli/code-highlight` package requires conditional
entries in addition to explicit DOCX runtime installation so PDF-only consumers
retain their existing configured behavior without changing the Typst path.

## Final verification

The final production harness and MV3 extension outputs contain
`engine-javascript-*.js` and no `engine-oniguruma-*` chunk or Oniguruma loader
signature. The remaining `wasm-*.js` file is Shiki's WebAssembly-language
grammar; the expected Typst compiler remains
`typst_ts_web_compiler_bg-*.wasm`.

The fresh-context Chromium benchmark covers 22 representative languages:

| Measurement | Cold export | Explicit preload + export |
| --- | ---: | ---: |
| Engine | JavaScript | JavaScript |
| Preload | 0 ms | 864.6 ms |
| Export wall time | 1,318.4 ms | 262.3 ms |
| Engine initialization in export | 8.1 ms | 0 ms |
| Grammar batch in export | 1,171.2 ms | 0 ms |
| Real-source tokenization | 268.0 ms | 223.1 ms |
| Code blocks / languages | 22 / 22 | 22 / 22 |

Both runs emitted 132,165-byte DOCX files with SHA-256
`099d9a72e42221982ea79f2c5157e2066a8c83d05a07565b1d4da41d98baaf66`.
The full browser conformance suite, packed MV3 offscreen DOCX E2E, Bun tarball
consumer, plain Node 22 consumer, and packed Vite consumer passed.
