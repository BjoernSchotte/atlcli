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

DOCX with zero template setup: `runExport(input, nodeDocxEnv({ outPath: "page.docx" }))`
uses a programmatically built default template (no binary asset shipped).

Versioning: lockstep `@atlcli/*` train, pre-1.0 rules — see
[package versioning](https://atlcli.sh/reference/versioning/).
