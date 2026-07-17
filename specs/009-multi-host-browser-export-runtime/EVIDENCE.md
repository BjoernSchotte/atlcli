# Spec 009 implementation evidence

Recorded: 2026-07-17

Status: automated implementation gates pass. The user-assisted load-unpacked extension E2E in
`PLAN.md` §8.6 remains pending.

## Implementation chain

- `e925d1e` — merge the current `origin/main` baseline into the draft branch
- `dc58daf` — extract the DOCX browser runtime and neutral DOM adapters
- `65147bd` — extract reusable PDF contracts and the browser compiler package
- `e676190` — add the production Vite/Worker/Chromium conformance harness and CI gates
- `fd7160a` — document ownership boundaries and separate root DOM/Worker type programs

No package was published and no release was created. Runtime fonts remain in the gitignored
`packages/pdf/.fonts/` cache; no font binary is tracked by these commits.

## Environment

| Tool | Version |
|---|---|
| Bun runtime used for verification | 1.3.8 |
| TypeScript | 5.9.3 |
| WXT | 0.20.27 |
| Vite | 8.1.4 |
| Playwright test package | 1.55.0 |
| Chromium | 140.0.7339.16 (Playwright build 1187) |
| Typst browser wrapper / engine | 0.7.0 / 0.14.2 |

## Automated results

| Gate | Result |
|---|---|
| `bun test` | 1,872 pass, 0 fail across 119 files |
| `bun run typecheck` | pass; root, extension, compiler package, and three harness TS programs |
| `bun run check:browser` | pass; 10 browser entrypoints |
| `bun run build` | pass; CLI, extension, and harness rebuilt |
| `bun run check:extension-output` | pass; complete local MV3 PDF runtime and CSP-safe output |
| `bun run check:browser-export-harness` | pass; complete local, relative nested-path artifact |
| `bun run test:browser-export-harness` | pass; final Chromium production E2E in 1.4 seconds |
| `bun run docs:check` / `bun run docs:build` | pass; 0 diagnostics, 59 pages built |
| `bun ./dist/index.js --help` | pass; atlcli 0.17.2 command shape rendered |

The Chromium case loads production `dist/` below `/conformance/nested/` and proves a real DOCX
canvas/Mermaid export plus a real PDF module Worker, WASM and font compile. It also verifies
byte-identical warm PDF output and abort-without-emission. The harness imports only public
workspace package exports and observes `globalThis.Buffer === undefined`.

The first sandboxed full-suite attempt could not bind `Bun.serve({ port: 0 })`, producing 12
WebhookServer failures. Re-running the identical suite with local socket access produced the
1,868/0 pre-hardening result above; the final suite including artifact-cleanup regressions is
1,872/0. The export tests themselves did not fail in either run.

The first GitHub Actions run exposed a stale-output merge between an on-demand WXT test build
and a restored Turbo build artifact. The artifact scanner correctly rejected two compiler-worker
files. Browser output roots are now removed through an exact-path, regression-tested cleaner
before direct and Turbo build routes; neighboring source directories are explicitly preserved.

## Output parity

DOCX focused evidence:

- pre-extraction golden output reproduced exactly;
- Node consumer output equals the extension golden structure;
- browser bootstrap order, namespaced byte helpers, absent global `Buffer`, memory template
  source, and real canvas adapter are covered;
- 13 focused DOCX golden/consumer/runtime tests pass.

PDF fixture before and after extraction:

```text
SHA-256  b74b9c8ed82cbe437aa6dfb5316bd361bea562e9363a1c0d758da647df500a16
Bytes    308752
Pages    8 (A4)
Tagged   yes
Outline  yes
Fonts    9 embedded font files
```

The raw SHA-256 is unchanged from the captured pre-extraction baseline.

## Pending user-assisted evidence

Load `apps/extension/.output/chrome-mv3/` in Chrome and complete `PLAN.md` §8.6: representative
DOCX export, PDF export, navigation/abort with no stale download, and warm repeat. This gate is
kept separate because the neutral harness cannot certify extension permissions, session auth,
Chrome offscreen lifecycle, or the final human inspection of exported documents.
