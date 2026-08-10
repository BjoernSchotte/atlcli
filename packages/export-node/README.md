# @atlcli/export-node

The batteries-included Node consumer package (BASELINE-DESIGN §A5): everything
a plain Node/Bun host needs to drive the DOCX/PDF export engines without
hand-wiring wasm bytes, font bytes, template assets, or filesystem adapters.

- **Entry points:** `.` — `nodePdfEnv`, `nodeDocxEnv`, `confluenceTreeSource`,
  `bundledDefaultTemplate`/`defaultTemplateSource`, `nodePdfCompiler`,
  `tokenPdfAssetResolver`, `tokenAssetFetcher` + `createAssetByteCache`, and
  the re-exported file adapters (`fileTemplateSource`, `fileOutputSink`,
  `resvgSvgRasterizer`).
- **Runtime:** Node ≥ 20 and Bun.
- **Install:** filesystem link or packed tarball — no registry publish today.
  See the [package consumption guide](https://atlcli.sh/reference/package-consumption/).

```ts
import { fetchExportTree, composeChapters } from "@atlcli/confluence";
import { runPdfExport } from "@atlcli/pdf";
import { nodePdfEnv, confluenceTreeSource } from "@atlcli/export-node";

const tree = await fetchExportTree(confluenceTreeSource(profile),
  { kind: "tree", rootPageId: "123" }, { labels: { exclude: ["internal"] } });
const doc = composeChapters(tree.nodes);
await runPdfExport({ blocks: doc.blocks, metadata, filename: "handbook.pdf" },
  nodePdfEnv(profile, { outDir: "dist" }));
```

`nodePdfCompiler()` resolves the compiler WASM once and exposes every installed
canonical font through a hash-bound lazy loader. Each compile reads and
registers only the subset carried by its final `PdfSourceBundle`; reports
include the selected and loaded asset IDs.

DOCX with zero template setup: `runExport(input, nodeDocxEnv({ outPath: "page.docx" }))`
uses a programmatically built default template (no binary asset shipped).

## Durable export jobs

`createFileExportJobPersistence()` provides the Node/Bun adapters used by the
CLI job runtime: one revision-fenced file journal, chunked spool, staged artifact
store, PDF and TypeScript-DOCX ready/result stores, and one shared heavy-render
reservation. State defaults to the private, versioned directory
`~/.atlcli/export-jobs/v1`; tests and managed hosts can override it with
`ATLCLI_EXPORT_JOBS_DIR`.

The adapter persists a request before it can be claimed, uses cross-process
nonce locks and lease epochs to prevent duplicate rendering/commit, and exposes
cursor-paginated events for activity monitors. `reconcileStaleExportJobs()`
finishes prepared artifact commits before reclaiming expired process leases.
`deliverFileExportArtifact()` verifies the committed length and SHA-256, then
delivers atomically with no-clobber semantics unless overwrite is explicit.

The runtime is deliberately foreground-only: it supports durable recovery and
cross-process cancellation, but makes no detached-execution claim.

Versioning: lockstep `@atlcli/*` train, pre-1.0 rules — see
[package versioning](https://atlcli.sh/reference/versioning/).
