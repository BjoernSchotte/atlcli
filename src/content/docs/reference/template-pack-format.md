---
title: "Template Pack Format (.wiki-pdf-template)"
description: "The deterministic .wiki-pdf-template container: manifest schema, deterministic packing, payload vs archive hashing, size caps, traversal protections, the import gate, and the DOCX scan policy"
---

# Template Pack Format — `.wiki-pdf-template`

A `.wiki-pdf-template` file is a deterministic ZIP container that carries a
template so it can be built in one place and imported in another. One container
format serves **both** engines: a Typst PDF template (`engine.kind: "typst"`,
API [`wiki.pdf-template/v1`](pdf-template-contract.md)) and a Word template
(`engine.kind: "docx"`, API `wiki.docx-template/v1`). Only the *container* is
shared — never the render contract.

The reader, packer, and validator live in the isomorphic package
`@atlcli/template-pack` (browser-safe, pure byte-in/byte-out functions). This
package is the canonical owner of the size-cap constants.

## On this page

- [Prerequisites](#prerequisites)
- [Container layout](#container-layout)
- [Manifest schema](#manifest-schema)
- [Deterministic packing](#deterministic-packing)
- [Payload hash vs archive hash](#payload-hash-vs-archive-hash)
- [Size caps](#size-caps)
- [Traversal and structural protections](#traversal-and-structural-protections)
- [The import gate](#the-import-gate)
- [DOCX scan policy](#docx-scan-policy)
- [Minimal example (Typst)](#minimal-example-typst)
- [Advanced example (DOCX)](#advanced-example-docx)
- [Related topics](#related-topics)

## Prerequisites

- The [PDF Template Contract](pdf-template-contract.md) for the `typst` engine
  API the manifest pins.
- For the `docx` engine, the existing DOCX template scanner (`scanTemplate`)
  from the DOCX engine.

## Container layout

Every pack contains a manifest as its first entry, followed by the template
payload files:

```text
wiki-pdf-template.json     ← the manifest (always first)
template.typ               ← engine.entry for a typst pack
…any additional assets…
```

For a `docx` pack the entry is `template.docx` instead.

## Manifest schema

The manifest file is `wiki-pdf-template.json`:

```json
{
  "schemaVersion": 1,
  "id": "com.acme.tech-doc",
  "name": "Acme Tech Doc",
  "version": "1.0.0",
  "engine": { "kind": "typst", "api": "wiki.pdf-template/v1", "entry": "template.typ", "compilerRange": ">=0.14 <0.15" },
  "requiredFonts": [{ "family": "Source Sans 3", "style": "normal", "weight": 400 }],
  "settings": { "cover": { "type": "boolean", "default": true } },
  "provenance": { "payloadSha256": "…", "createdWith": "atlcli 0.x" }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `schemaVersion` | `number` | Yes | Only `1` is recognized at ship time. |
| `id` | `string` | Yes | Reverse-DNS-style pack id. |
| `name` | `string` | Yes | Human-readable name. |
| `version` | `string` | Yes | Pack version. |
| `engine.kind` | `"typst" \| "docx"` | Yes | Selects the render contract. |
| `engine.api` | `string` | Yes | `wiki.pdf-template/v1` (typst) or `wiki.docx-template/v1` (docx). |
| `engine.entry` | `string` | Yes | Payload file to render; must exist in the archive. |
| `engine.compilerRange` | `string` | Typst only | Semver range, e.g. `">=0.14 <0.15"`. |
| `requiredFonts` | `RequiredFont[]` | Optional | `{ family, style, weight }` per face. Declarative only — availability is **not** cross-checked in this format. |
| `settings` | `Record<string, ManifestSetting>` | Optional | Open, typed dictionary of Level-B settings. Setting `type` is one of `text \| boolean \| choice \| color \| number \| asset`. |
| `provenance.payloadSha256` | `string` | Optional | Digest of the payload members (see below). |
| `provenance.createdWith` | `string` | Optional | Tool identifier. |

The manifest's open `settings` map is **not** the same shape as the built-in
`PdfTemplateSettings` (the fixed Level-A fields documented in
[PDF Template Settings](pdf-template-settings.md)). The two stay separate in
v1: threading manifest-declared settings into a render call needs host-side
Level-B loading glue that is out of scope for this format.

## Deterministic packing

`packTemplate(contents)` produces a **byte-deterministic** archive: packing the
same inputs twice yields byte-identical bytes. Determinism comes from three
controls:

- a fixed DOS-epoch timestamp (1980-01-01 00:00:00) on every entry, built from
  local calendar components so it is timezone-independent;
- a fixed `DOS` platform so version/attribute fields are stable;
- an explicit file order — manifest first, then payload paths ascending — and a
  sorted-key manifest serialization.

ASCII entry paths carry no Info-ZIP unicode-path extra field, so no
platform-dependent extra fields are emitted.

## Payload hash vs archive hash

Two different hashes answer two different questions; do not conflate them.

| Hash | What it covers | Where it lives |
|------|----------------|----------------|
| `provenance.payloadSha256` | The pack's **payload members** — everything *except* the manifest | Inside the manifest |
| `TemplateLibraryEntry.sha256` | The delivered **archive bytes as stored** | Library entry metadata, outside the archive |

`provenance.payloadSha256` is deliberately **not self-referential**: it cannot
be the hash of the very archive it lives in (that value is unknowable before the
manifest is written). It is defined precisely as the digest of a canonicalized,
**delimiter-safe** payload description: for every payload member in ascending
path order, emit one self-delimiting record

```text
<P>:<path>,<byteLength>,<sha256hex>;
```

where `<P>` is the decimal UTF-8 byte length of `<path>`, `<byteLength>` is the
member's decimal byte count, and `<sha256hex>` is its lowercase-hex SHA-256
(always exactly 64 characters). Concatenate all records (no join separator) and
SHA-256 the UTF-8 bytes of the result. The netstring length prefix frames the
path, so the encoding is injective by construction — no member path can forge
record boundaries, independent of path validation. The manifest is excluded
because it is the carrier of the value.

`TemplateLibraryEntry.sha256` is the separate, unambiguous integrity check used
when a template is downloaded — it hashes the archive bytes exactly as
delivered.

## Size caps

`unpackTemplate` enforces hard caps before and during extraction. These are the
literal exported constants of `@atlcli/template-pack`:

| Constant | Value | Guards |
|----------|-------|--------|
| `MAX_TEMPLATE_PACK_BYTES` | 30 MiB | Outer archive size, checked before unzip. |
| `MAX_TEMPLATE_PACK_UNCOMPRESSED_BYTES` | 64 MiB | Cumulative **declared** uncompressed payload — accounted before any inflation (zip-bomb guard). |
| `MAX_TEMPLATE_PACK_FILE_BYTES` | 32 MiB | Any single member's declared uncompressed size. |
| `MAX_TEMPLATE_PACK_ENTRIES` | 2048 | Number of archive entries. |

The cumulative and per-file caps are measured from each entry's **declared**
uncompressed size and abort extraction *before* inflating — counting compressed
bytes alone would not stop a zip bomb.

The inner DOCX cap (`MAX_TEMPLATE_BYTES` = 20 MiB in the DOCX engine) is
unrelated and unchanged. It still applies once a `kind: "docx"` container's
`template.docx` is scanned, and is smaller than the outer caps above, so a
compliant container can never smuggle an over-cap DOCX payload through size
checks alone.

## Traversal and structural protections

`unpackTemplate` rejects (throwing a typed `TemplatePackError`) any archive that
is unsafe or malformed:

- **Path traversal** — `..` segments, absolute paths, backslashes, or
  drive-letter paths (`too-large-archive`, `path-traversal`).
- **Control characters in member paths** — any ASCII control character
  (0x00–0x1F, 0x7F), including newline/CR/NUL, is rejected (`invalid-path`).
  `packTemplate` enforces the same rule at pack time, so a compliant packer can
  never produce an archive the reader rejects.
- **Symlink entries** — detected via unix permission bits (`symlink`).
- **Missing manifest** or a manifest that is not valid JSON
  (`missing-manifest`, `bad-manifest`).
- **Missing entry** — `engine.entry` must be present in the archive
  (`missing-entry`).

Each rejection carries a typed `kind` so a host can present specific feedback
instead of a generic parse error.

## The import gate

`validateManifest` is not merely a shape check — it is the **import gate**. It
rejects incompatible packs with a typed `ManifestValidationError.reason` so a
host can render an upgrade/downgrade hint:

| Reason | Trigger |
|--------|---------|
| `unknown-schema-version` | `schemaVersion` is anything other than `1`. |
| `unknown-api` | `engine.api` is not the known value for the declared `engine.kind`. |
| `compiler-range-mismatch` | For a `typst` pack, the pinned Typst compiler version does not satisfy `engine.compilerRange`. |
| `shape-error` | A required field is missing or mistyped, or `compilerRange` uses an unsupported form. |

The compiler-range check is a pure semver comparison against the pinned compiler
version; actually compiling the template against the canonical feature set stays
a deferred Level-B host follow-up.

`validatePack(bytes)` combines unpack + import gate + an engine-specific hook and
returns a typed report `{ ok, manifest?, scanReport?, issues }`. It throws
**only** on package corruption (the `TemplatePackError`s above); manifest-gate
failures and engine-hook problems are surfaced as `issues` with `ok: false`.

## DOCX scan policy

For a `kind: "docx"` pack, `validatePack` runs the DOCX template scanner and
applies the same policy as the live product — no stricter:

- A package-level failure (a scan/unzip error on a corrupt inner `.docx`) is
  **fatal**: `ok: false` with the error surfaced in `issues`
  (`docx-scan-failed`).
- `never`-classified placeholders are a **warning** (`never-placeholders`), not
  a rejection — those placeholders render empty, an accepted case in the product.
- A missing content placeholder is **not** a rejection — the exporter appends
  content before the final section break as a documented fallback.

Warnings keep `ok: true`; only errors flip it to `false`.

## Minimal example (Typst)

A minimal Typst pack manifest — one entry, no custom settings:

```json
{
  "schemaVersion": 1,
  "id": "com.example.minimal",
  "name": "Minimal",
  "version": "1.0.0",
  "engine": {
    "kind": "typst",
    "api": "wiki.pdf-template/v1",
    "entry": "template.typ"
  }
}
```

Packed and read back:

```ts
import { packTemplate, validatePack } from "@atlcli/template-pack";

const bytes = await packTemplate({
  manifest,
  files: { "template.typ": templateSource },
});

const report = validatePack(bytes);
// report.ok === true, report.issues === []
```

## Advanced example (DOCX)

A branded DOCX pack that pins the API, declares required fonts and a Level-B
setting, and carries provenance:

```json
{
  "schemaVersion": 1,
  "id": "com.acme.tech-doc",
  "name": "Acme Tech Doc",
  "version": "2.1.0",
  "engine": {
    "kind": "docx",
    "api": "wiki.docx-template/v1",
    "entry": "template.docx"
  },
  "requiredFonts": [
    { "family": "Source Sans 3", "style": "normal", "weight": 400 },
    { "family": "Source Sans 3", "style": "normal", "weight": 700 }
  ],
  "settings": {
    "accent": { "type": "color", "default": "#0052CC" },
    "cover": { "type": "boolean", "default": true }
  },
  "provenance": { "payloadSha256": "…", "createdWith": "atlcli 0.x" }
}
```

```ts
const report = validatePack(docxPackBytes);
// A pack whose inner .docx uses only `never`-classified placeholders:
//   report.ok === true, report.issues === [{ severity: "warning", code: "never-placeholders", … }]
// A pack with a corrupt inner .docx:
//   report.ok === false, report.issues === [{ severity: "error", code: "docx-scan-failed", … }]
```

## Related topics

- [PDF Template Contract](pdf-template-contract.md) — the `wiki.pdf-template/v1`
  render surface the `typst` engine pins.
- [PDF Template Settings](pdf-template-settings.md) — the fixed Level-A settings
  (distinct from a manifest's open `settings` map).
- [PDF Export Engine](pdf-engine.md) — the pipeline that consumes a resolved
  template.
