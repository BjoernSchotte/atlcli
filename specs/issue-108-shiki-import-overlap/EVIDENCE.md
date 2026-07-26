# Issue 108: Shiki grammar import overlap

Baseline: `52a5abb` (`origin/main`), 2026-07-26

The production Vite browser-export harness ran the same 22-language DOCX
fixture in fresh Chromium contexts before and after the scheduling change.
Resource Timing entries were cleared immediately before explicit export intent.
The generated artifacts stayed byte-identical.

| Measurement | Before | After |
| --- | ---: | ---: |
| Cold export wall time | 891.8 ms | 871.3 ms |
| Explicit preload wall time | 738.2 ms | 655.5 ms |
| Export after preload | 223.7 ms | 207.9 ms |
| Cold engine initialization | 6.4 ms | 17.1 ms |
| Cold grammar-ready wall time | 784.5 ms | 792.5 ms |
| Cold source tokenization | 183.4 ms | 172.2 ms |
| First grammar request relative to final initialization response | 3.7 ms after | 9.9 ms before |
| Grammar JavaScript requests | 47 | 47 |
| DOCX size | 132,165 bytes | 132,165 bytes |

Both versions produced SHA-256
`099d9a72e42221982ea79f2c5157e2066a8c83d05a07565b1d4da41d98baaf66`.
The wall times are single local runs and are not a performance budget. The
acceptance signal is the resource ordering: before the change, the first
grammar request began only after core, JavaScript engine, and theme responses
completed; after the change, it began while those responses were still in
flight.

The permanent Playwright regression also verifies that none of the observed
runtime, theme, or requested grammar chunks loaded before explicit highlighting
intent.

## Commands

```bash
bun run test packages/code-highlight/src/index.test.ts
bun run build:browser-export-harness -- --force
bun run --cwd apps/browser-export-harness test:e2e -- highlight-performance.e2e.ts
```
