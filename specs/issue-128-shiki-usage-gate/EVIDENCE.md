# Issue #128 verification evidence

Verified locally on 2026-07-29. Timings and heap values are single-run
diagnostics, not performance budgets.

## Runtime boundary

- A fresh Bun process imported the real DOCX and PDF entries, prepared a
  no-code document through both engines, and kept the selected highlight engine
  `null` before and after preparation.
- The production Chromium no-code trace kept the engine `null`, requested zero
  highlight-runtime/theme/grammar chunks, and requested zero DOCX code-font
  assets. DOCX preparation took 1.8 ms and PDF preparation took 1.7 ms.
- After explicit TypeScript intent, the browser requested exactly one lazy
  runtime adapter, one Shiki core, one JavaScript engine, one selected theme,
  and the two direct TypeScript modules. A warm repeat requested no JavaScript.
- The current combined DOCX entry resolved in one request wave versus two for
  the retained legacy topology. Runtime-ready time was 51.9 ms versus 79.4 ms;
  the measured peak JS-heap deltas were 2,784,376 and 2,782,260 bytes
  respectively.
- The 22-language browser fixture selected the JavaScript engine and stayed
  byte-deterministic between cold and explicitly preloaded contexts. The cold
  export took 878 ms; explicit preparation plus export took 658.5 + 208.6 ms.

## Host and package gates

- Production build, workspace typecheck, browser-isomorphism scan, MV3 output
  scan, browser-harness scan, catalogue drift check, and browser-harness unit
  tests passed.
- Chromium highlight-performance E2E passed 5/5.
- Packed MV3 recovery E2E passed 22/22, including service-worker restart,
  offscreen-document recreation, persistent browser restart, and deterministic
  DOCX recovery.
- Fresh package API/closure reports passed. Packed DOCX and PDF consumers have
  no static edge to the concrete highlighter or generated runtime loaders.
- The CLI highlighting artifact retained the Node/Bun Oniguruma path without
  aggregate Shiki initializers.
- The full workspace suite passed 5,842 tests with 14 explicitly gated skips
  and zero failures.

## Live CLI E2E

A temporary page containing TypeScript and Python code was created in the
required `mayflower` / `DOCSY` test environment, exported through the durable
TypeScript DOCX and Typst PDF production paths with the `dracula` theme, and
then deleted. A follow-up read returned 404, proving cleanup.

- DOCX: exit 0, complete, zero warnings, two code blocks/two languages, valid
  ZIP, embedded code font, and theme-colored OOXML runs.
- PDF: exit 0, complete, zero warnings, tagged four-page PDF, and both source
  snippets present in extracted text.

No tenant URL, page identifier, job identifier, or generated private artifact
is retained in this repository.

## Remaining external proof

The Forge consumer lives outside this repository. Its pinned staging and
production traces remain required before closing the GitHub issue: same-origin
request inventory, runtime-ready and first-export timings, byte totals, and
heap measurement or explicitly labelled proxies.
