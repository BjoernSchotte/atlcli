# Chart support matrix

This matrix is the implementation-level support contract for the first-class
`ExportBlock` chart surface. It intentionally separates source normalization,
static publication, document export, and optional client interaction. A chart
does not become unsupported merely because no client island is selected.

| Shape | Cloud ADF | DC Storage | Astro static SVG/list | Accessible data table | DOCX/PDF | Client interaction |
| --- | --- | --- | --- | --- | --- | --- |
| `pie` | ✅ | ✅ | ✅ SVG paths + legend | ✅ | ✅ SVG + table | Static fallback |
| `bar` | ✅ | ✅ | ✅ vertical/horizontal/stacked bars | ✅ | ✅ SVG + table | ✅ TanStack `tanstack-v0.3/bar` when bounded |
| `line` | ✅ | ✅ | ✅ polylines + point labels | ✅ | ✅ SVG + table | Static fallback |
| `area` | ✅ | ✅ | ✅ line + filled area | ✅ | ✅ SVG + table | Static fallback |
| `xyArea` | ✅ | ✅ | ✅ numeric/date x + filled area | ✅ | ✅ SVG + table | Static fallback |
| `xyBar` | ✅ | ✅ | ✅ x/y bars | ✅ | ✅ SVG + table | ✅ TanStack `tanstack-v0.3/bar` when bounded |
| `xyLine` | ✅ | ✅ | ✅ numeric/date x + lines | ✅ | ✅ SVG + table | Static fallback |
| `xyStep` | ✅ | ✅ | ✅ stepped lines | ✅ | ✅ SVG + table | Static fallback |
| `xyStepArea` | ✅ | ✅ | ✅ stepped filled area | ✅ | ✅ SVG + table | Static fallback |
| `scatter` | ✅ | ✅ | ✅ point marks | ✅ | ✅ SVG + table | Static fallback |
| `timeSeries` | ✅ | ✅ | ✅ ISO timestamp x + labels | ✅ | ✅ SVG + table | Static fallback |
| `gantt` | ✅ | ✅ | ✅ semantic timeline/list | ✅ | ✅ SVG + table | Static fallback |

## Shared guarantees

- Cloud ADF and DC Storage adapters normalize into the same closed
  `ChartModelV1`; source-specific XML/ADF and provider URLs do not cross the
  renderer boundary.
- Invalid options, skipped rows, strict-mode rejection, unsupported kinds, and
  approximations such as flattened 3D are represented by bounded diagnostic
  codes. Lenient charts remain visibly marked in Astro and continue through
  document table projections.
- Every static chart has a title/description, a semantic visual, an aligned
  data table, responsive overflow behavior, and keyboard-safe labels. The
  TanStack island adds focus navigation, tooltips, ResizeObserver-based width
  updates, and the static table remains available after hydration.
- DOCX and PDF use the same source order and union X keys for sparse point
  series, so a missing point in one series never shifts another series' value.
  Both targets call the shared dependency-free SVG renderer; DOCX additionally
  stores a bounded PNG compatibility rendition, while PDF keeps the chart as
  vector content through Typst. The semantic table is retained in both files.
- The interactive adapter is intentionally closed and bounded: it accepts
  only categorical `bar` and provider-valid `xyBar` data, with explicit row,
  series, point, and payload limits. All other shapes remain JavaScript-off
  complete.

## Evidence

- Cloud/DC all-shape normalization tests:
  `packages/confluence/src/chart-macro.test.ts`
- Shared validator and diagnostic tests:
  `packages/export-blocks/src/charts.test.ts` and `schema.test.ts`
- Plain Astro all-shape static consumer test:
  `packages/export-blocks-astro/src/astro-renderer.test.ts`
- DOCX/PDF all-shape and sparse-series projection tests:
  `packages/docx/src/serialize.test.ts` and
  `packages/pdf/src/serialize.test.ts`
- Mayflower provider-live proof page (non-private fixture, generated output
  excluded from Git):
  `http://127.0.0.1:4391/publish/atlcli-chart-provider-live-20260801-195515/`

The live provider page proves the pinned `tanstack-v0.3/bar` island. A live DC
tenant is not available in this workspace; DC coverage is therefore fixture-
and contract-proven rather than falsely reported as a provider E2E. A
multi-macro Cloud fixture was also attempted and produced provider-side
`Hibernate/StaleStateException` responses; it was reverted to the clean
single-XY-bar fixture so the live page remains a trustworthy provider proof.
