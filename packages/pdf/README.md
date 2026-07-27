# @atlcli/pdf

The isomorphic PDF export engine: `ExportBlock` trees → Typst source →
compiled, tagged PDF via an injected compiler port (`PdfCompilePort`).

- **Entry points:**
  - `.` / `./browser` — `runPdfExport` + `PdfExportEnv`, the resumable
    `preparePdfExport` / `renderPreparedPdfExport` stages, the compiler port
    contract (`PdfCompilePort`/`PdfCompileResult`), the runtime asset manifest
    `PDF_RUNTIME_ASSETS`, and the shared types.
  - `./template` — the raw Typst template (`ATLCLI_TYPST_TEMPLATE`).
  - `./internal` — **non-frozen** prepare/serialize/theme/validate internals.
  - `./fonts/*` — the ten sha256-pinned Source Sans/Serif/Code Pro TTFs.
  - `./licenses/*` — their SIL OFL 1.1 license texts.
- **Runtime:** Node ≥ 20, Bun, and browsers (fully isomorphic).
- **Install:** filesystem link or packed tarball — no registry publish today.
  See the [package consumption guide](https://atlcli.sh/reference/package-consumption/).

```ts
import { runPdfExport, PDF_RUNTIME_ASSETS } from "@atlcli/pdf";
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";

await runPdfExport(
  { blocks, metadata: { title, exportedAt: new Date() }, filename: "page.pdf" },
  { assets, compiler: new BrowserPdfCompiler({ wasm, fonts }), output },
);
```

PDF template packs use three fail-closed validation phases:

```ts
import { loadPdfTemplatePack, runPdfExport } from "@atlcli/pdf";

const templatePack = await loadPdfTemplatePack(archiveBytes);

await runPdfExport(
  {
    blocks,
    metadata: { title, exportedAt: new Date() },
    filename: "page.pdf",
    templatePack,
  },
  { assets, compiler, output },
);
```

The shared template-pack validator first checks portable JSON shape. The PDF
manifest validator then enforces the renderer-owned slot, writer, scope, font,
and geometry allowlists. Finally, pack-integrity validation verifies each
payload's actual hash, media signature, dimensions, complexity budgets,
references, and compiler-owned VFS path before Typst sees any bytes.

PDF V1 supports a meaning-bearing PNG/SVG logo, page and cover backgrounds,
header/footer decorations, and one uniform four-sided page-relative border.
Decorations are emitted as PDF artifacts. Cropped or translucent image
decorations, image watermarks, side-specific or art borders,
text-relative borders, and section-specific decorations remain unsupported
rather than being approximated.

`PdfTemplatePreviewCompiler` implements the host-neutral authoring preview
port. An injected resolver supplies the baseline/current model; the adapter
returns PDF bytes, digests, page counts, and typed page/region references with
no filesystem paths or DOM values. The same adapter can therefore be used by
the CLI, browser studio, and extension.

Background hosts use the same engine without duplicating PDF semantics:

```ts
import {
  preparePdfExport,
  renderPreparedPdfExport,
} from "@atlcli/pdf";

const prepared = await preparePdfExport(input, { assets });
await readyToRenderStore.commit(prepared);

async function renderFromCheckpoint() {
  const reservation = await heavyRenderReservations.acquire();
  try {
    const resumed = await readyToRenderStore.materialize();
    return await renderPreparedPdfExport(
      resumed,
      { signal },
      { compiler, output: captureSink },
    );
  } finally {
    await reservation.release();
  }
}

const report = await renderFromCheckpoint();
```

`PreparedPdfExportV1` is the complete render state. Hosts should persist it
behind an opaque reference and materialize a fresh clone of its Typst VFS bytes
only while the heavy-render reservation is held. Rendering consumes that clone
by moving out its `bundle`; a failed attempt cannot reuse the consumed value.

Wasm/font wiring per host: [export asset contract](https://atlcli.sh/reference/asset-contract/).
Versioning: [package versioning](https://atlcli.sh/reference/versioning/).
