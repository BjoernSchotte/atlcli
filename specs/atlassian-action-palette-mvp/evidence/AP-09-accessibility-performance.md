# AP-09 accessibility and performance matrix

**Status:** COMPLETE

**Date:** 2026-08-12

**Source commit:** `a10403f172abbf2e06f466e3494608e53b180f8c`

The machine-readable result is stored in
`AP-09-accessibility-performance.json`. It contains no tenant identifier, page
body, customer document, credential, generated export, or downloaded artifact.
The test used only a controlled synthetic Atlassian-shaped page.

## Regression found by visual proof

The initial screenshots exposed a real defect that DOM and Axe assertions had
not caught: the WXT shadow document occupied the viewport, but its `body` and
extension iframe retained the browser default height of 150 CSS pixels. The
result list existed and was keyboard-reachable but was visually clipped below
the header.

Commit `a10403f1` makes the shadow `html`, `body`, and iframe fill the viewport
and adds a packed-browser regression assertion for exact viewport geometry.
Before the fix the iframe measured `1424 × 150` at `(8, 8)` in a `1440 × 1000`
viewport. The final production build measures `1440 × 1000` at `(0, 0)`.

## Accessibility matrix

The production WXT directory was loaded unpacked into Chromium and exercised
in default rendering, at 150% browser zoom, with forced colors, and with reduced
motion. In all four modes:

- the labelled dialog exposed eight results;
- the search combobox owned the focus and identified the active PDF option;
- eleven visible interactive targets measured at least 48 by 44 CSS pixels;
- the complete result surface remained visible in the viewport.

Forced-colors media was active and projected Canvas/CanvasText/Highlight
styling. Reduced-motion media was active and reduced the frame animation to
`0.01 ms`. The packed Axe scan covered root, empty, action-panel, input,
loading, bounded-error, and missing-capability states with zero palette WCAG
A/AA violations and zero serious/critical page violations.

## Performance matrix

The final packed run retained 30 samples after five warmups. Cold open p95 was
`113.483 ms`, warm open p95 was `13.275 ms`, the maximum palette long task was
`0 ms`, and local search made zero requests. Eager palette code was 6,773 gzip
bytes and the lazy UI was 81,851 gzip bytes. Every metric remains below its
approved budget.

## Screenshot boundary

Four PNGs were written to the task visualization directory, displayed in the
task, and intentionally kept outside Git. The JSON receipt records their file
names and SHA-256 hashes so the displayed/downloaded files can be matched to
this run. Screenshots are not committed.

## Re-proof after the fix

```bash
bun run test
bun run typecheck
bun run build
bun run check:browser
bun run check:extension-output
bun run --cwd apps/extension test:palette-extension-browser:prebuilt
```

Results: 7,971 root tests passed with 16 intentional skips and zero failures;
all 30 build tasks and all 34 browser entrypoints passed; typecheck and output
scan passed; and all seven packed-browser cases passed.
