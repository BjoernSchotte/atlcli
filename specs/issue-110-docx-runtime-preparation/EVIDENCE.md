# Issue 110 verification evidence

Verified on 2026-07-27.

## Runtime contract

- Focused DOCX font/runtime tests: 19 passed. Covers single-flight loading,
  rejection retry, loader replacement race, caller-only cancellation, nested
  grammar discovery, and warm repeated preparation.
- Browser Chromium trace: 2 passed. A fresh context emitted one same-origin
  `JetBrainsMono-Regular-*.ttf` request after intent and before export; the
  export and warm repeat emitted none. Cold/prepared DOCX bytes were equal.
  A failed first font request was retryable in the same realm.
- Full workspace suite: 5,475 passed, 12 environment-gated tests skipped,
  0 failed.

## Host boundaries

- Production build: all 17 build tasks passed. Harness and MV3 output each
  contained exactly one 273,900-byte DOCX code-font asset.
- Browser/isomorphism gate: all 21 entry points passed.
- Harness and MV3 output scans passed with the code-font count and SHA-256
  inventory requirement.
- Packed MV3 Chromium test passed through side panel message, service worker,
  productive offscreen preparation, durable DOCX execution, PizZip,
  docxtemplater, Mermaid/canvas rasterization, and syntax highlighting.
- Workspace, extension, PDF compiler, and browser-harness typechecks passed.

## Package and CLI consumers

- Frozen API report and transitive closure guards passed from fresh `dist/`.
- A packed npm project under Node 22.18 imported every supported entry point,
  passed NodeNext typechecking with `skipLibCheck: false`, prepared DOCX
  runtime without a network fetch, and produced real DOCX/PDF files.
- A packed Bun project performed the same real DOCX/PDF consumer smoke.
- Source, bundled, and compiled-executable CLI font modes all passed.

## Live E2E

- A read-only single-page export from the required DOCSY environment completed
  through the durable TypeScript DOCX job with the requested dark code theme.
  The job fetched, composed, rendered, validated, staged, delivered, and
  acknowledged one real DOCX with no warnings.
- `unzip -t` accepted every generated part. The no-code page correctly omitted
  font parts even though runtime preparation warmed the font unconditionally.
- No remote resource was created or modified, so no tenant cleanup was needed.
