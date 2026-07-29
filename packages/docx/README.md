# @atlcli/docx

The isomorphic DOCX export engine: Confluence page + Word template with
Scroll placeholders (`$scroll.*`) → finished `.docx`. Runs unchanged in the
browser and under Node/Bun; hosts inject template/asset/output seams via
`ExportEnv`.

- **Entry points:**
  - `.` — `runExport`/`exportDocx`, the `ExportEnv` seams, placeholder
    classification, image handling, plus the Node filesystem adapters
    (`fileTemplateSource`, `fileOutputSink`, `resvgSvgRasterizer`).
  - `./browser-entry` — canonical browser-intent entry: installs the runtime
    before the engine evaluates and exposes preparation, export, template-scan,
    memory-template, and canvas-rasterizer capabilities in one graph.
  - `./browser` — compatibility engine barrel without Node adapters.
  - `./browser-runtime` — browser bootstrap (installs the byte helpers;
    import before PizZip/docxtemplater run in a browser host), the
    JavaScript-only Shiki engine, and the runtime-preparation API.
  - `./vite` — build-time define map for browser bundlers.
  - `./scan` — template scanning (`scanTemplate`, `unzipDocx`).
  - `./fixtures` — programmatic minimal-docx builders (dev/test API).
  - `./internal` — **non-frozen** resolver/serializer/OOXML internals.
  - `./fonts/*` — committed OFL Inter/JetBrains Mono TTFs (diagram
    rasterization and portable DOCX code-face embedding).
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

## Intent-time runtime preparation

Browser hosts should load the ordered entry only after explicit DOCX intent:

```ts
const {
  prepareDocxExportRuntime,
  runExport,
} = await import("@atlcli/docx/browser-entry");
```

The entry installs the byte runtime before PizZip/docxtemplater evaluate, so
hosts do not maintain their own sequential runtime-to-engine chain. They can
then warm the complete first-render runtime:

```ts
const preparation = await prepareDocxExportRuntime(blocks, {
  codeTheme: "github-light",
  preloadCodeFont: true,
  signal: dialogSignal,
});
```

The call always warms known Shiki grammars. It validates the bundled
`JetBrainsMono-Regular.ttf` concurrently only when `preloadCodeFont: true` is
explicit. Otherwise the renderer stages it after macro/include resolution and
only when completed OOXML uses the code face; `prepareDocxExportRuntime([])`
therefore reports zero font bytes/time. Both paths share one awaitable,
concurrent-safe, retryable cache. Cancellation stops only that caller's wait;
shared initialization continues for the next caller. Starting it from a DOCX
modal, Word-template selection, or explicit export action keeps ordinary page
loads untouched. The returned timings cover only intent-to-ready preparation;
`ExportReport.timings` still describes render work. Browser builds use Shiki's
JavaScript RegExp engine; Node/Bun imports use Oniguruma.

`./browser` and `./browser-runtime` remain available for compatibility and
specialized bundles. New intent hosts should use `./browser-entry`.

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

Queued browser hosts use an adaptive packaging boundary. Prepared payloads
below 1 MiB keep the established in-memory render; larger text or media
payloads detach `word/media/*` into hash-bound spool objects and finalize OPC
through `renderPreparedDocxExportStream`. The stream emits bounded chunks,
hashes them incrementally, uses ZIP `STORE` for PNG/JPEG/GIF and DEFLATE for
XML/text, and writes the Central Directory only after every part succeeds.
Cancellation, size/count limits, and sink failures abort the stream without
publishing a partial artifact. Customer templates stay on the same
PizZip/docxtemplater path: a unique sentinel splits the actual content part
into prefix, verbatim body, and suffix, including the supported
header/footer-content case.

The durable checkpoint owns media either as bytes or as an opaque `sourceRef`,
never both. A `DocxReadyToRenderStoreV1` must implement `readMedia` for the
latter so final packaging reads each media object from its spool rather than
rehydrating the aggregate image set. Direct `exportDocx` calls do not opt into
this queue-only split and retain their compatible in-memory behavior.

`TemplateSource.getBytes` and `SvgRasterizer.rasterize` receive an optional
`HostCallContext`. Hosts should honor its cancellation signal so cancellation
during template load, image fetch, or rasterization cannot reach final output.
