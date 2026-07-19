# @atlcli/docx

The isomorphic DOCX export engine: Confluence page + Word template with
Scroll placeholders (`$scroll.*`) → finished `.docx`. Runs unchanged in the
browser and under Node/Bun; hosts inject template/asset/output seams via
`ExportEnv`.

- **Entry points:**
  - `.` — `runExport`/`exportDocx`, the `ExportEnv` seams, placeholder
    classification, image handling, plus the Node filesystem adapters
    (`fileTemplateSource`, `fileOutputSink`, `resvgSvgRasterizer`).
  - `./browser` — the same engine without Node adapters.
  - `./browser-runtime` — browser bootstrap (installs the byte helpers;
    import before PizZip/docxtemplater run in a browser host).
  - `./vite` — build-time define map for browser bundlers.
  - `./scan` — template scanning (`scanTemplate`, `unzipDocx`).
  - `./fixtures` — programmatic minimal-docx builders (dev/test API).
  - `./internal` — **non-frozen** resolver/serializer/OOXML internals.
  - `./fonts/*` — committed Inter/JetBrains Mono TTFs (rasterizer fonts).
- **Runtime:** Node ≥ 20, Bun, and browsers.
- **Install:** filesystem link or packed tarball — no registry publish today.
  See the [package consumption guide](https://atlcli.sh/reference/package-consumption/).

```ts
import { runExport, fileTemplateSource, fileOutputSink } from "@atlcli/docx";

await runExport(
  { details, template: { name: "corporate.docx", modificationDate: new Date() } },
  { templates: fileTemplateSource("template.docx"), output: fileOutputSink("out.docx") },
);
```

Full engine reference: [DOCX export engine](https://atlcli.sh/reference/docx-engine/).
Versioning: [package versioning](https://atlcli.sh/reference/versioning/).
