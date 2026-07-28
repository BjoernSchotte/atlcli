# `@atlcli/docx-template-intake`

Browser-compatible, byte-in/facts-out DOCX design intake. The package reuses
the hardened `@atlcli/docx` archive boundary, parses OOXML by namespace, emits
portable facts and typed diagnostics, and performs no filesystem or network
I/O.

## Usage

```ts
import {
  analyzeDocxTemplate,
  canonicalDocxTemplateFactsJson,
} from "@atlcli/docx-template-intake";

const facts = await analyzeDocxTemplate(docxBytes, {
  progress(event) {
    hostProgress.update(event);
  },
});

const portableJson = canonicalDocxTemplateFactsJson(facts);
```

To resolve Word styles and create PDF candidates, inject the renderer-owned
catalog and the font families that renderer can actually embed:

```ts
import { analyzeDocxTemplateForCatalog } from "@atlcli/docx-template-intake";

const analysis = await analyzeDocxTemplateForCatalog(docxBytes, {
  catalog: pdfCatalog,
  bundledFontFamilies: pdfFontFamilies,
  progress: hostProgress.update,
});

for (const candidate of analysis.matching.candidates) {
  reviewModel.add(candidate);
}
```

The catalog pipeline resolves `docDefaults`, `basedOn` chains, styles, direct
formatting, theme fonts/colors, section geometry, header/footer inheritance,
and page-number scope. It emits business concept codes and structured
explanations; hosts decide how to render copy and how users accept, reject, or
override each candidate.

Visual intake is a separate, explicitly consent-gated path. Inject the PDF
renderer's asset limits and a host-owned private asset store:

```ts
import { analyzeDocxVisualAssets } from "@atlcli/docx-template-intake";
import {
  InMemoryTemplateAssetStore,
} from "@atlcli/pdf-template-authoring";
import {
  PDF_TEMPLATE_ASSET_CAPABILITIES_V1,
} from "@atlcli/pdf";

const { analysis: visuals, privateSource } =
  await analyzeDocxVisualAssets(docxBytes, {
    capabilities: PDF_TEMPLATE_ASSET_CAPABILITIES_V1,
    assetStore: new InMemoryTemplateAssetStore(),
    sections: analysis.sections,
  });
```

`visuals` contains deduplicated safe handles, sanitized scenes, role
suggestions, inventory, and review descriptors. Every descriptor starts at
**Do not include** with rights, accessibility, role, and placement unanswered.
`privateSource` is a separate sidecar for source names and confirmed alt-text
authoring; never serialize it into portable analysis or a runtime template
pack. External images are fingerprinted and ignored, never fetched.

The same byte-in/facts-out API is exported from the default, `./browser`, and
`./node` entry points. Hosts own file pickers, filesystem access, persistence,
localized copy, and progress presentation.

## Security and privacy boundary

- All archives enter through `@atlcli/docx` `unzipDocx()` with the stricter
  template-intake budget.
- Only relationship-allowlisted semantic XML parts are streamed. Unsupported
  binary payloads and external targets are classified without being read or
  fetched.
- XML limits cover bytes, decoded characters, elements, depth, attributes,
  attribute length, and total nodes. `DOCTYPE` and malformed XML fail closed.
- Portable facts contain structural counts, fingerprints, typed diagnostics,
  and stable locators—not document text, raw XML, asset bytes, or full external
  URLs.
- PNG/JPEG dimensions and SVG complexity are checked against the injected PDF
  template-asset capability descriptor before a handle is created. SVGs also
  pass the export pipeline's shared hostile-content policy.
