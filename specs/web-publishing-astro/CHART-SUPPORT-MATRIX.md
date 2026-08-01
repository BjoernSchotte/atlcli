# Chart support matrix

This matrix is the implementation-level support contract for the first-class
`ExportBlock` chart surface. It intentionally separates source normalization,
static publication, document export, and optional client interaction. A chart
does not become unsupported merely because no client island is selected.

Status keys: ✅ proven for the stated surface; 🟡 implemented baseline but the
world-class semantic/visual gate is still open; — intentionally static.

| Shape | Cloud ADF normalization | DC Storage normalization | Astro static visual | Accessible data table | DOCX/PDF visual | Client interaction |
| --- | --- | --- | --- | --- | --- | --- |
| `pie` | ✅ fixture/adapter | ✅ fixture/adapter | 🟡 paths + legend; labels pending | ✅ | 🟡 SVG + table; visual proof pending | — |
| `bar` | ✅ fixture/adapter | ✅ fixture/adapter | 🟡 vertical baseline; horizontal/mixed-sign pending | ✅ | 🟡 one vertical-style path only | ✅ bounded TanStack baseline |
| `line` | ✅ fixture/adapter | ✅ fixture/adapter | 🟡 line baseline; full axes pending | ✅ | 🟡 SVG + table; visual proof pending | — |
| `area` | ✅ fixture/adapter | ✅ fixture/adapter | 🟡 area baseline; mixed-sign baseline pending | ✅ | 🟡 SVG + table; visual proof pending | — |
| `xyArea` | ✅ fixture/adapter | ✅ fixture/adapter | 🟡 numeric path; full axes pending | ✅ | 🟡 SVG + table; visual proof pending | — |
| `xyBar` | ✅ fixture/adapter | ✅ fixture/adapter | ✅ one provider-valid positive series | ✅ | ✅ one provider-valid positive series | ✅ bounded TanStack baseline |
| `xyLine` | ✅ fixture/adapter | ✅ fixture/adapter | 🟡 numeric path; full axes pending | ✅ | 🟡 SVG + table; visual proof pending | — |
| `xyStep` | ✅ fixture/adapter | ✅ fixture/adapter | 🟡 Astro step baseline | ✅ | 🟡 document renderer is not stepped yet | — |
| `xyStepArea` | ✅ fixture/adapter | ✅ fixture/adapter | 🟡 Astro stepped-area baseline | ✅ | 🟡 document renderer is not stepped yet | — |
| `scatter` | ✅ fixture/adapter | ✅ fixture/adapter | 🟡 point baseline; full axes pending | ✅ | 🟡 SVG + table; visual proof pending | — |
| `timeSeries` | ✅ fixture/adapter | ✅ fixture/adapter | 🟡 raw timestamp path; locale/timezone pending | ✅ | 🟡 locale/timezone and visual proof pending | — |
| `gantt` | ✅ fixture/adapter | ✅ fixture/adapter | 🟡 timeline/list; dependency edges pending | ✅ | 🟡 progress/dependencies and visual proof pending | — |

## Shared guarantees

- Cloud ADF and DC Storage adapters normalize into the same closed
  `ChartModelV1`; source-specific XML/ADF and provider URLs do not cross the
  renderer boundary.
- Invalid options, skipped rows, strict-mode rejection, unsupported kinds, and
  approximations such as flattened 3D are represented by bounded diagnostic
  codes. Lenient charts remain visibly marked in Astro and continue through
  document table projections.
- Every current static chart retains a title/description and aligned data
  table. Complete semantic axes, option fidelity, responsive layout, and
  keyboard/accessibility proof remain acceptance work except for the proven
  XY-bar path.
- DOCX and PDF use the same source order and union X keys for sparse point
  series, so a missing point in one series never shifts another series' value.
  Both targets call the shared dependency-free SVG renderer; DOCX additionally
  stores a bounded PNG compatibility rendition, while PDF keeps the chart as
  vector content through Typst. The one visually verified XY-bar path reserves
  a separated title/legend header band and plot-edge padding. All-shapes visual
  quality remains open. The semantic table is retained in both files.
- The interactive adapter is intentionally closed and bounded: it accepts
  only categorical `bar` and provider-valid `xyBar` data, with explicit row,
  series, point, and payload limits. All other shapes remain JavaScript-off
  complete.

## Evidence

- Shared tenant-free all-shapes acceptance corpus:
  `packages/export-fixtures/src/chart-world-class-corpus.ts`
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

The live provider page proves one pinned `tanstack-v0.3/bar` XY-bar island and
the corresponding polished DOCX/PDF projection. It does not prove the other
eleven shapes. A live DC
tenant is not available in this workspace; DC coverage is therefore fixture-
and contract-proven rather than falsely reported as a provider E2E. A
multi-macro Cloud fixture was also attempted and produced provider-side
`Hibernate/StaleStateException` responses; it was reverted to the clean
single-XY-bar fixture so the live page remains a trustworthy provider proof.
