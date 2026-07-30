# Issue #134 verification evidence

All committed fixtures use synthetic tenant, page, space, account, and
Whiteboard values. The live run used temporary private DOCSY resources; their
identifiers and derived artifacts were not retained.

## Functional contract

- Exact `com.atlassian.confluence.macro.core` /
  `native-embed:whiteboard` ADF matching is covered for valid, invalid,
  repeated, nested, and ordered nodes.
- Valid same-origin routes produce one block Smart Card titled
  `Atlassian Whiteboard`, one `macro-rendered-via` note, and no degraded note.
- Unsafe or malformed destinations produce a visible non-clickable fallback
  without retaining the rejected URL or identifiers in diagnostics.
- DOCX relationship XML and a real tagged-PDF link annotation contain the
  canonical target. Serializer-input assertions are not used as their
  substitute.
- Embedded Whiteboards remain part of page/tree exports. A direct Whiteboard
  tree child remains an honest redacted `unsupported-child-type`.

## Host and dependency contract

- CLI/Node/Bun and extension-session builders pass the trusted site origin and
  make zero Whiteboard endpoint requests.
- The neutral production browser harness exports the card under strict CSP and
  records zero foreign requests.
- The production-packed MV3 side-panel/offscreen job succeeds, retains the PDF
  and report, records `macro-rendered-via`, and makes zero Whiteboard requests.
- A Forge-shaped consumer injects only its page-read adapter. The shared
  package graph contains no Forge, WXT, React, or WebExtension dependency.

## Executed gates

- Focused unit, wiring, serializer, artifact, browser-compiler, and host tests:
  green.
- Full workspace test: 5,902 passed, 15 environment-gated skips, 0 failed
  across 405 files.
- Workspace build and TypeScript typecheck: green.
- Browser-entrypoint build gate: 27 entrypoints green.
- Production browser harness build, CSP/output scan, export parity, and
  Whiteboard export E2E: green.
- Production WXT build, packed-output scan, extension typecheck, and packed MV3
  Whiteboard job E2E: green.
- API report, API closure, and M1 corpus structural goldens: regenerated and
  green.
- Live `mayflower` / `DOCSY` E2E: one temporary real Whiteboard embedded in a
  temporary ADF page exported successfully to both DOCX and tagged PDF. Each
  report contained exactly one `macro-rendered-via`, no warning, no
  `macro-degraded`, and a complete result. The page, Whiteboard, and local
  artifacts were deleted immediately afterward.
