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

## Queued export engine seam

Hosts with a durable background queue split the same TypeScript engine at its
ready-to-render boundary:

```ts
import { prepareDocxExport, renderPreparedDocxExport } from "@atlcli/docx";

// The queue holds its one cross-format heavy-render reservation before prepare.
const prepared = await prepareDocxExport(input);
await checkpointStore.commit(structuredClone(prepared));

// Every attempt materializes a fresh clone. Rendering consumes renderState.
const result = await renderPreparedDocxExport(prepared, { signal });
```

`prepareDocxExport` is itself heavy: template PizZip mutation, asset/diagram
rasterization, and prepared-archive generation all happen there. A queued host
must acquire its global DOCX/PDF heavy reservation before calling it and retain
the reservation through `renderPreparedDocxExport`. The prepared value contains
only browser-serializable data. It deliberately excludes host callbacks and the
attempt's `AbortSignal`; rendering clears `renderState` before docxtemplater can
mutate the archive, so a retry must start from a fresh durable clone.

`TemplateSource.getBytes` and `SvgRasterizer.rasterize` receive an optional
`HostCallContext`. Hosts should honor its cancellation signal so cancellation
during template load, image fetch, or rasterization cannot reach final output.
