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
