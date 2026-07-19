# PDF Template Contract v1 — reusable templates, curated settings, and host-neutral management

Status: **Planned — review draft**

Spec ID: `pdf-template-contract-v1`

Contract identifier: **`wiki.pdf-template/v1`**

Depends on:

- `007-pdf-export` — implemented semantic PDF serializer, standard template, compiler job flow, and extension UI;
- `009-multi-host-browser-export-runtime` — implemented host-neutral PDF runner, browser compiler package, and neutral Chromium harness;
- [`TEMPLATE-UX.md`](./TEMPLATE-UX.md) — governing product direction for curated templates, generated settings, future package import, and later stationery support.

This plan makes the `wiki.pdf-template/v1` wording in `TEMPLATE-UX.md` normative. The contract
identifier is deliberately not a product name and is never shown as UI branding. If the future
product family receives a different name, a later contract may alias or migrate
`wiki.pdf-template/v1`; persisted manifests must never infer behavior from a package name,
application name, npm scope, or host.

---

## 1. Outcome

The first slice turns the current hard-coded Typst document design into a versioned,
host-neutral template contract without changing the default PDF output.

At completion:

1. `wiki.pdf-template/v1` defines a small Typst runtime contract around
   `render(meta, body, settings)`.
2. A new private workspace package, `packages/wiki-pdf-template` /
   `@atlcli/wiki-pdf-template`, owns the reusable template domain:
   - contract and manifest types;
   - runtime/font compatibility declarations;
   - page, document-feature, branding, localization, typography, token, semantic-palette,
     component-metric, and asset-slot definitions;
   - typed bindings from user-facing settings to validated manifest targets;
   - parsing and structural validation;
   - path, file, asset, and settings validation;
   - deterministic canonicalization and digests;
   - structured lint diagnostics;
   - setting default resolution;
   - catalog and repository ports for later management surfaces;
   - an in-memory catalog for tests and neutral consumers;
   - the curated built-in template packages.
3. `@atlcli/pdf` remains the PDF document engine. It resolves a selected template through
   the template package, serializes the semantic body, assembles the virtual source bundle,
   and runs the existing compiler/output ports.
4. The current Editorial Indigo output becomes the default built-in
   `wiki.pdf-template/v1` package and preserves the current PDF output contract. Its current
   design literals move out of `@atlcli/pdf` hardcoding and into its manifest only after the
   complete manifest/resolver/runtime machinery has been proven with synthetic fixtures.
5. A second genuinely distinct curated template proves that the contract is not merely a
   wrapper around one hard-coded file.
6. The extension renders template selection and settings from the manifest, persists local
   preferences outside the reusable packages, and exports through the same neutral runner.
7. The browser compiler accepts a deterministic set of virtual source files instead of
   hard-coding `/atlcli.typ`.
8. The neutral browser harness compiles both built-in templates through public package
   surfaces with real Worker, WASM, fonts, validation, warm-repeat determinism, and abort
   behavior.

This slice creates the reusable contract and the first management seams. It does not yet
accept arbitrary third-party packages or expose create/update/delete management UI.

---

## 2. Naming and compatibility decisions

### 2.1 Contract identity

The exact v1 contract value is:

```text
wiki.pdf-template/v1
```

Rules:

- It is a machine identifier, not a product label.
- It is persisted in manifests and included in deterministic package identity.
- UI surfaces display the locale-resolved `localization.locales.*.template.name`, never the
  contract identifier.
- Code must compare the full identifier exactly. Unknown identifiers fail as unsupported;
  they never fall through to the current implementation.
- A future product rename does not mutate existing manifests in place. It introduces an
  explicit alias/migration or a new versioned identifier.
- The identifier does not imply Confluence, Chrome, CLI, desktop, cloud, or server ownership.

### 2.2 Workspace package identity

The first implementation lives at:

```text
packages/wiki-pdf-template
package name: @atlcli/wiki-pdf-template
private: true
```

The npm scope is a repository ownership detail only. It must not appear in:

- manifests;
- template IDs;
- saved settings;
- virtual source paths;
- compiler diagnostics exposed to users;
- archive formats added by later work.

The package stays private until a separate publication decision covers ownership,
versioning, compatibility, licenses, and support policy. Renaming or extracting the package
later must not require changing `wiki.pdf-template/v1` manifests.

### 2.3 Built-in IDs

Built-in template IDs use a non-domain product-neutral namespace:

```text
builtin.editorial-indigo
builtin.<second-template-id>
```

IDs are stable machine keys. Display names and descriptions may change without changing
the ID. Reusing an ID for semantically incompatible template behavior is forbidden.

---

## 3. Baseline and required drift check

### 3.1 Verified current baseline

At planning time:

- `@atlcli/pdf` is private and browser-safe. It owns preparation, serialization, the
  neutral runner, diagnostics, validation, themes, and runtime-asset metadata.
- `PdfSourceBundle` contains one `main` string, one `template` string, document assets,
  source maps, and notes.
- `BrowserPdfCompiler` mounts `/main.typ` and hard-codes the template at `/atlcli.typ`.
- `serializePdfDocument()` imports `atlcli-doc`, `callout`, `status-badge`, table helpers,
  dense-table helpers, and task helpers from that single file.
- Extension PDF jobs persist the complete `PdfSourceBundle` in IndexedDB and count
  `main`, `template`, and binary assets against job quotas.
- The neutral harness imports `ATLCLI_TYPST_TEMPLATE` directly for its invalid-source probe.
- The runner already carries `PdfThemeOptions`, PDF profile, compiler, output, asset, abort,
  phase, validation, and report seams.
- Spec 009's fixed PDF fixture is 308,752 bytes, eight A4 pages, tagged, outlined, and has
  nine embedded font files. Its recorded SHA-256 is
  `b74b9c8ed82cbe437aa6dfb5316bd361bea562e9363a1c0d758da647df500a16`.

### 3.2 Mandatory pre-implementation drift check

Before Task 1 changes source:

- [ ] Record the implementation base SHA.
- [ ] Re-read `packages/pdf/src/{types,serialize,template,theme,run-export}.ts`.
- [ ] Re-read `packages/pdf-compiler-browser/src/compiler.ts`.
- [ ] Re-read the extension PDF job store, compile port, worker protocol, and `PdfSection`.
- [ ] Re-read the neutral harness PDF case and worker protocol.
- [ ] Capture the current fixed fixture source bundle, PDF bytes, structural inspection,
      and SHA-256.
- [ ] Confirm whether any package has become public or acquired external consumers.
- [ ] Search for every import of `ATLCLI_TYPST_TEMPLATE`, `createAtlcliTypstTemplate`,
      `PdfSourceBundle.template`, and `/atlcli.typ`.
- [ ] Update this plan before implementation if the current ownership or public contracts
      have drifted materially.

---

## 4. Scope

### 4.1 In scope

- A private host-neutral `@atlcli/wiki-pdf-template` workspace package.
- Exact `wiki.pdf-template/v1` manifest and Typst runtime contracts.
- Manifest-owned runtime compatibility, required fonts, page model, document features,
  branding, localization labels, typography roles, design tokens, semantic palettes,
  component metrics, asset slots, and typed setting bindings.
- Contract, manifest, file, path, source, asset, setting, catalog, and diagnostic types.
- Pure structural validation and linting with stable diagnostic codes.
- Settings defaults, normalization, validation, and Typst-safe value encoding inputs.
- Deterministic package canonicalization and SHA-256 identity.
- Read-only catalog plus future-facing repository ports.
- In-memory catalog/repository test implementation and conformance tests.
- Migration of Editorial Indigo into a validated built-in package.
- A dedicated late migration of all existing template-design hardcoding from the PDF engine
  into the Editorial Indigo manifest, backed by an explicit migration ledger and allowlist
  for the few remaining engine invariants.
- One additional curated template with meaningfully different page and typographic design.
- Manifest-generated settings for the curated templates.
- A generic multi-source `PdfSourceBundle` and compiler VFS mount.
- Host-neutral selection and template resolution in `runPdfExport`.
- Extension-local selection/settings/asset persistence and UI.
- Neutral browser harness coverage for both templates.
- Default-output parity, diagnostics, security, browser artifact, and manual E2E gates.
- Documentation and narrow supersession notes in Specs 007, 009, and `TEMPLATE-UX.md`.

### 4.2 Explicitly out of scope

- No public template marketplace or remote catalog.
- No organization distribution or synchronized settings.
- No arbitrary third-party template import in the extension.
- No public archive suffix or deterministic ZIP format in this slice.
- No `init`, `pack`, `unpack`, `publish`, `install`, or remote update commands.
- No visual template editor, free-form canvas, arbitrary text boxes, layers, or shapes.
- No PDF stationery/background import or PDF-to-Typst conversion.
- No custom font upload or runtime font installation.
- No untrusted Typst execution surface presented to users.
- No remote imports, package-registry imports, network loaders, or runtime downloads.
- No custom JavaScript hooks in manifests or template packages.
- No DOCX contract or Word-template behavior changes.
- No new CLI, desktop, server, or hosted UI product surface in this slice.
- No publishing of private workspace packages.
- No PDF/A claim and no new PDF/UA claim.
- No automatic migration between future contract identifiers.

### 4.3 Behavioral invariants

1. Omitting template selection produces the existing Editorial Indigo result.
2. DOCX and PDF remain separate engines and template systems.
3. Confluence storage parsing and `ExportBlock[]` remain presentation-neutral.
4. Template selection never changes authenticated asset resolution or host permissions.
5. The reusable packages import no Chrome, WXT, DOM, IndexedDB, filesystem, keychain,
   process, or application UI modules.
6. Compiler implementations know virtual files, not catalogs, settings UI, or built-in IDs.
7. Hosts own persistence, authentication, output, lifecycle, and user interaction.
8. Template packages never shadow engine runtime sources or document assets.
9. User values are encoded as data; they are never concatenated into Typst code without
   context-specific escaping.
10. The default template keeps the current tagged output, outline, fonts, links, table
    contrast policy, dense-table behavior, and report semantics.
11. Switching templates never mutates source page data or `ExportBlock[]`.
12. A failed template validation or compilation emits no PDF.
13. Template and settings identity are recorded in the report without storing sensitive
    setting values in logs.
14. Warm repeated compilation of fixed inputs remains deterministic.
15. No implementation in this slice makes later management depend on one host's storage
    technology.
16. All user-visible design defaults live in the selected template manifest. The PDF engine
    may retain only documented semantic, safety, compiler, and accessibility invariants.
17. A setting can affect rendering only through a declared, type-checked binding to an
    allowlisted manifest target; no setting provides a source path or executable expression.
18. Missing runtime features or required fonts fail before compilation with structured
    compatibility diagnostics; the compiler never substitutes a visually different font
    silently.

---

## 5. Target architecture and ownership

### 5.1 Dependency direction

```text
"depends on" direction:  consumer --> dependency

@atlcli/pdf --> @atlcli/confluence
@atlcli/pdf --> @atlcli/diagram
@atlcli/pdf --> @atlcli/wiki-pdf-template

@atlcli/pdf-compiler-browser --> @atlcli/pdf

apps/extension --> @atlcli/pdf
apps/extension --> @atlcli/pdf-compiler-browser
apps/extension --> @atlcli/wiki-pdf-template

apps/browser-export-harness --> @atlcli/pdf
apps/browser-export-harness --> @atlcli/pdf-compiler-browser
apps/browser-export-harness --> @atlcli/wiki-pdf-template

host catalog/repository adapters --> @atlcli/wiki-pdf-template
```

Normative dependency rules:

- `@atlcli/wiki-pdf-template` has no dependency on `@atlcli/pdf` or application code.
- `@atlcli/pdf` may depend on `@atlcli/wiki-pdf-template`.
- `@atlcli/pdf-compiler-browser` continues to depend on `@atlcli/pdf`, not on catalogs or
  template management.
- Applications depend on packages; packages never depend on applications.
- Catalog and repository adapters depend inward on the template ports.
- No reusable package imports WXT/Chrome APIs or owns IndexedDB lifecycle.
- No browser package imports Node built-ins.

### 5.2 Ownership table

| Owner | Owns | Does not own |
|---|---|---|
| `@atlcli/wiki-pdf-template` | contract types, manifest schema, package validation, lint diagnostics, setting resolution, canonicalization/digest, catalog/repository ports, memory implementations, curated package definitions | PDF serialization, Typst compilation, browser storage, auth, UI, downloads |
| `@atlcli/pdf` | semantic PDF preparation, engine-owned Typst runtime, template selection orchestration, body serialization, VFS bundle assembly, source maps, report mapping, output validation | persistent template storage, compiler implementation, host UI |
| `@atlcli/pdf-compiler-browser` | generic browser Typst compiler, VFS source/asset mounting, raw-to-normalized compiler result mapping | template identity, manifest parsing, settings, catalogs, UI |
| `apps/extension` | tenant/space context, local preferences and setting assets, generated form, job/offscreen/worker lifecycle, download and report presentation | contract validation rules, bundled template source, generic compiler implementation |
| `apps/browser-export-harness` | memory adapters and independent conformance proof | extension APIs, production preference policy |
| future hosts | their own catalog/repository adapter, auth, output, persistence, lifecycle, and UI | changes to the contract semantics for host convenience |

### 5.3 Why this is a separate package

Template management has a different lifecycle from document rendering. It needs stable
operations such as list, inspect, validate, lint, compare, digest, save, remove, and later
pack/import/update. Those operations must be reusable without loading the PDF serializer or a
Typst compiler. Conversely, PDF rendering must consume a validated template without knowing
which management surface supplied it.

The package boundary is proven when:

- the extension uses the package through public exports;
- the neutral browser harness uses the same validation and memory catalog;
- `@atlcli/pdf` accepts the package's resolved contract rather than importing application
  state;
- package tests run without DOM, Chrome, IndexedDB, filesystem, or compiler globals.

---

## 6. `wiki.pdf-template/v1` contract

### 6.1 Manifest

Normative TypeScript shape:

```ts
export interface WikiPdfTemplateManifestV1 {
  schemaVersion: 1;
  contract: "wiki.pdf-template/v1";
  id: string;
  version: string;
  engine: {
    kind: "typst";
    entry: string;
  };
  compatibility: WikiPdfTemplateCompatibilityV1;
  requiredFonts: WikiPdfTemplateRequiredFontV1[];
  design: WikiPdfTemplateDesignV1;
  localization: WikiPdfTemplateLocalizationV1;
  assetSlots: WikiPdfTemplateAssetSlotV1[];
  settingGroups: WikiPdfTemplateSettingGroupV1[];
  settings: WikiPdfTemplateSettingDefinitionV1[];
  bindings: WikiPdfTemplateSettingBindingV1[];
}

export interface WikiPdfTemplateCompatibilityV1 {
  runtime: "wiki.pdf-runtime/v1";
  typst: {
    minimum: string;
    maximumExclusive?: string;
  };
  requiredFeatures: WikiPdfRuntimeFeatureV1[];
}

export interface WikiPdfTemplateRequiredFontV1 {
  id: string;
  family: string;
  styles: Array<{
    weight: number;
    style: "normal" | "italic";
  }>;
  purpose: string;
}
```

Validation rules:

- `schemaVersion` is exactly `1`.
- `contract` is exactly `wiki.pdf-template/v1`.
- `id` matches `^[a-z0-9]+(?:[._-][a-z0-9]+)*$`, maximum 128 characters.
- `version` is a strict SemVer value without a leading `v`.
- `engine.kind` is exactly `typst`.
- `engine.entry` is a validated package-relative `.typ` path.
- `compatibility.runtime` is exact and every required runtime feature is known to the engine.
- `compatibility.typst` uses normalized SemVer ranges. The active compiler must satisfy the
  range before sources are mounted.
- Every font family/style used by a typography role appears once in `requiredFonts`. The
  compiler/runtime font inventory must satisfy all requirements before compilation; silent
  font substitution is forbidden.
- `design`, `localization`, and all referenced asset slots are complete and internally
  consistent.
- Every `settingGroups` key is unique and every setting's group reference resolves.
- Every setting key is unique and stable.
- Every binding refers to one declared setting and one allowlisted, type-compatible target.
- Two settings cannot bind the same scalar target. A single setting may bind multiple
  compatible targets deliberately.
- Unknown manifest keys produce a warning during the review phase and an error before public
  package import is introduced. Built-ins keep the manifest exact from the first slice.

The manifest contains no npm package name, host, tenant, storage key, download URL, compiler
URL, UI component name, or executable JavaScript.

#### 6.1.1 Runtime features and font requirements

The initial `WikiPdfRuntimeFeatureV1` allowlist covers only features already supplied by the
engine-owned runtime, such as semantic callouts, status badges, tasks, normal/dense tables,
table-cell contrast, source links, headings/outline anchors, and resolved asset references.
Feature names are capability identifiers, not import paths. An unknown or unavailable feature
returns `compat-runtime-feature-unsupported` before compile.

`requiredFonts` is both documentation and a hard render precondition. Editorial Indigo records
the exact Source Sans 3, Source Serif 4, and Source Code Pro faces/weights it currently uses.
Typography roles refer to font IDs, not repeat family strings. Bundled runtime font metadata is
the authoritative availability inventory. Custom font files remain out of scope, but a later
font provider can satisfy the same requirement contract without changing template semantics.

#### 6.1.2 Complete design model

```ts
export interface WikiPdfTemplateDesignV1 {
  page: WikiPdfPageDesignV1;
  features: WikiPdfDocumentFeaturesV1;
  branding: WikiPdfBrandingV1;
  typography: WikiPdfTypographyRolesV1;
  tokens: WikiPdfDesignTokensV1;
  semanticPalettes: WikiPdfSemanticPalettesV1;
  components: WikiPdfComponentDesignV1;
}

export type WikiPdfLengthV1 =
  | `${number}pt`
  | `${number}mm`
  | `${number}cm`
  | `${number}in`
  | `${number}em`;
```

The design model is required even when none of its values are user-editable. It is the static
rendering source of truth and contains these v1 areas:

- `page`: default and supported sizes (`a4`, `us-letter`), default and supported orientation
  (`portrait`, `landscape`), and top/right/bottom/left margins;
- `features`: enabled/default policy and relevant options for cover, outline/TOC (including
  depth), closing page, header, footer, and page numbers (placement, first-page visibility,
  numbering start, and format);
- `branding`: organization/header/footer defaults, source-product label, generator
  attribution text, attribution URL, and whether each branding element is shown on cover,
  interior pages, or closing page;
- `typography`: named roles for body, paragraph, heading levels 1–3, cover title, cover
  metadata, closing title, code, table, list marker/number, callout, status badge, and page
  chrome. Each role declares font ID, size, weight, style, color-token reference, and where
  applicable line height/tracking;
- `tokens.colors`: at least `ink`, `paper`, `accent`, `muted`, `border`, `heading-subtle`,
  `code-background`, `table-header-background`, `mention`, `task-checked`, and
  `task-unchecked`;
- `tokens.layout`: shared radii, stroke widths, and spacing-scale values used by more than one
  component. A literal that is component-specific stays with that component;
- `tokens.contrast`: `mode`, `onDark`, `onLight`, and `minimumContrast` for colored table
  cells. The engine enforces the rule; the manifest supplies the selected template's values;
- `semanticPalettes.callouts`: exact background/foreground pairs for `info`, `note`,
  `warning`, `tip`, and `panel`;
- `semanticPalettes.statuses`: exact base/text pairs for `grey`, `red`, `yellow`, `green`, and
  `blue`, including the current spelling aliases handled by the engine;
- `components.paragraph`: alignment, leading, and block spacing;
- `components.headings`: before/after spacing and sticky behavior per heading level;
- `components.lists`: bullet marker, checked/unchecked task marker, indent, body inset,
  item spacing, and ordered-list numbering pattern;
- `components.codeBlock`: padding, corner radius, background token, font role, and spacing;
- `components.callout`: border width, padding, radius, spacing, icon/label treatment, and
  semantic-palette mapping;
- `components.statusBadge`: horizontal/vertical padding, radius, font role, and color-lighten
  amount;
- `components.table`: normal and dense font roles, horizontal/vertical cell padding, header
  fill, border color/width, hyphenation, repeated-header presentation, and layout metrics;
- `components.header`, `components.footer`, `components.cover`, and
  `components.closingPage`: all currently fixed offsets, rules, gaps, widths, alignments, and
  text-role references.

Lengths must use one of the validated units above and be finite, positive where required, and
within conservative per-field bounds. Ratios such as contrast, leading, and lightening use
bounded finite numbers. Colors are canonical `#RRGGBB` or references to declared color tokens;
Typst expressions and arbitrary source fragments are forbidden.

The design schema intentionally includes more values than the initial settings form exposes.
Manifest ownership and user editability are separate decisions: a value can be declarative,
validated, linted, and reusable without becoming end-user configurable.

#### 6.1.3 Localization

```ts
export interface WikiPdfTemplateLocalizationV1 {
  defaultLocale: string;
  fallbackLocale: string;
  locales: Record<string, WikiPdfTemplateLocaleV1>;
}

export interface WikiPdfTemplateLocaleV1 {
  template?: {
    name?: string;
    description?: string;
  };
  document?: Partial<WikiPdfTemplateDocumentLabelsV1>;
  settingGroups?: Record<string, {
    label?: string;
    description?: string;
  }>;
  settings?: Record<string, {
    label?: string;
    help?: string;
    options?: Record<string, string>;
  }>;
}

export interface WikiPdfTemplateDocumentLabelsV1 {
  version: string;
  exported: string;
  exporter: string;
  contents: string;
  end: string;
  pages: string;
  generatedFrom: string;
  spaceEyebrow: string;
}
```

Localization is the sole source for user-visible template text. Top-level `name` and
`description`, setting labels/help, option labels, and group labels are therefore not duplicated
elsewhere in the manifest. Stable machine keys remain outside localization: template ID,
setting key, group key, and choice-option value never change across languages.

The locale identified by `fallbackLocale` must be complete:

- non-empty template name and description;
- every `WikiPdfTemplateDocumentLabelsV1` field;
- label for every declared setting group;
- label for every setting; help text and group descriptions are optional presentation fields;
- label for every option of every choice setting.

Other locale bundles may be partial. Missing fields fall back individually and produce a
deterministic lint warning rather than forcing an entire locale to be duplicated. Unknown
setting/group/option keys are validation errors because they normally indicate stale
translations.

Locale keys are canonical BCP 47 tags. Resolution for each field is:

1. exact requested locale including region, for example `de-CH`;
2. requested base language, for example `de`;
3. `defaultLocale`;
4. `fallbackLocale`.

The UI locale and document locale are independent inputs. Catalog summaries and generated
controls use the host UI locale; PDF document labels use the source/export document locale.
The selected template package and settings remain identical when only UI locale changes.

Template localization owns only template-domain copy. Hosts continue to own and localize
application actions and system messages such as Export, Cancel, Reset, upload errors, security
diagnostics, and compiler failures. A template cannot rewrite a validator error or impersonate
a host action through its locale bundle.

Empty/whitespace-only translations count as missing. Names are maximum 120 characters,
descriptions and help text maximum 500 characters, and labels/options maximum 200 characters.
All localized strings are data and receive the same hostile-string Typst encoding as user
settings. Dates, times, and numbers are formatted by the host/runtime using the resolved
document locale; manifests provide labels, not executable formatting rules.

The initial Editorial Indigo manifest moves every current user-visible fixed PDF label plus
its template name/description and all generated-settings UI copy into locale bundles. At least
the complete fallback locale ships in v1; additional built-in translations may be partial only
when their lint warnings are reviewed explicitly.

Example manifest fragment:

```ts
localization: {
  defaultLocale: "en",
  fallbackLocale: "en",
  locales: {
    en: {
      template: {
        name: "Editorial Indigo",
        description: "Editorial document layout for wiki exports",
      },
      document: {
        version: "Version",
        exported: "Exported",
        exporter: "Exporter",
        contents: "Contents",
        end: "End of document",
        pages: "Pages",
        generatedFrom: "Generated from Confluence with atlcli",
        spaceEyebrow: "Confluence space",
      },
      settingGroups: {
        layout: {
          label: "Layout",
        },
        branding: {
          label: "Branding",
          description: "Organization, header, footer, and logo",
        },
      },
      settings: {
        pageSize: {
          label: "Page size",
          help: "Select the physical page format.",
          options: {
            a4: "A4",
            "us-letter": "US Letter",
          },
        },
        cover: {
          label: "Cover page",
          help: "Add a title page before the document contents.",
        },
        accent: {
          label: "Accent color",
        },
        logo: {
          label: "Organization logo",
          help: "PNG or SVG, maximum 5 MiB.",
        },
      },
    },
    de: {
      template: {
        name: "Editorial Indigo",
        description: "Redaktionelles Dokumentlayout für Wiki-Exporte",
      },
      document: {
        version: "Version",
        exported: "Exportiert",
        exporter: "Exportiert von",
        contents: "Inhalt",
        end: "Ende des Dokuments",
        pages: "Seiten",
        generatedFrom: "Aus Confluence mit atlcli erstellt",
        spaceEyebrow: "Confluence-Bereich",
      },
      settingGroups: {
        layout: {
          label: "Layout",
        },
        branding: {
          label: "Branding",
          description: "Organisation, Kopfzeile, Fußzeile und Logo",
        },
      },
      settings: {
        pageSize: {
          label: "Papierformat",
          help: "Legt das physische Seitenformat fest.",
          options: {
            a4: "A4",
            "us-letter": "US Letter",
          },
        },
        cover: {
          label: "Deckblatt",
          help: "Fügt vor dem Inhalt eine Titelseite ein.",
        },
        accent: {
          label: "Akzentfarbe",
        },
        logo: {
          label: "Organisationslogo",
          help: "PNG oder SVG, maximal 5 MiB.",
        },
      },
    },
  },
}
```

In this example `pageSize`, `us-letter`, `branding`, and `builtin.editorial-indigo` remain
stable machine values. Only their presentation copy is localized.

#### 6.1.4 Asset slots

```ts
export interface WikiPdfTemplateAssetSlotV1 {
  key: string;
  role: "logo" | "decoration";
  source: "bundled" | "setting";
  required: boolean;
  mediaTypes: Array<"image/png" | "image/svg+xml">;
  maximumBytes: number;
  placements: Array<"cover" | "header" | "footer" | "closing-page">;
  maximumWidth: WikiPdfLengthV1;
  maximumHeight: WikiPdfLengthV1;
  fit: "contain" | "cover";
  fallback: "omit" | "organization-text";
  altPolicy: "decorative" | "required" | "optional";
}
```

Asset settings reference a slot key instead of repeating layout and safety policy. Slots
define valid media, size, placements, maximum dimensions, fit, fallback, and alternative-text
policy. The manifest cannot supply filesystem or network locations. Bundled assets must match
one declared bundled slot; host-provided assets are mounted only after their setting and slot
both validate.

### 6.2 Setting definitions

Supported v1 definitions:

```ts
export interface WikiPdfTemplateSettingGroupV1 {
  key: string;
  order: number;
}

export type WikiPdfTemplateSettingDefinitionV1 =
  | WikiPdfBooleanSettingV1
  | WikiPdfTextSettingV1
  | WikiPdfChoiceSettingV1
  | WikiPdfColorSettingV1
  | WikiPdfNumberSettingV1
  | WikiPdfAssetSettingV1;
```

All definitions carry:

```ts
interface WikiPdfSettingBaseV1 {
  key: string;
  group?: string;
  required?: boolean;
  order?: number;
}
```

Type-specific rules:

- `boolean`: boolean default.
- `text`: string default, `minLength`, `maxLength` (hard maximum 2,000), no regex or code.
- `choice`: non-empty stable option values; default must be an option. Visible option labels
  come only from localization.
- `color`: canonical `#RRGGBB`; alpha is not supported in v1.
- `number`: finite default and bounded `min`, `max`, optional positive `step`.
- `asset`: declared `slot` key and optional alternative-text setting key; media, byte, role,
  placement, dimensions, and fallback come from that slot.

Initial curated settings may use:

- accent color;
- A4 or US Letter;
- cover on/off;
- outline on/off;
- header text;
- footer text;
- organization name;
- logo asset;
- optional logo alternative text.

The engine does not assume that every template exposes every setting. Hosts generate controls
from structural definitions plus locale-resolved UI copy. A setting absent from the manifest
cannot be persisted or passed to the template. A setting without complete fallback copy is an
invalid built-in package rather than a control with hardcoded host text.

#### 6.2.1 Explicit setting bindings

```ts
export interface WikiPdfTemplateSettingBindingV1 {
  setting: string;
  targets: WikiPdfTemplateBindingTargetV1[];
  transform?:
    | { kind: "identity" }
    | { kind: "choice-map"; values: Record<string, string | number | boolean> };
}
```

Binding targets use a versioned allowlist of semantic paths, not arbitrary JSONPath. Initial
targets include:

| Setting | Manifest target |
|---|---|
| accent color | `design.tokens.colors.accent` |
| page size | `design.page.defaultSize` |
| cover on/off | `design.features.cover.enabled` |
| outline on/off | `design.features.outline.enabled` |
| outline depth, if exposed | `design.features.outline.depth` |
| header/footer text | `design.branding.headerText` / `design.branding.footerText` |
| organization name | `design.branding.organizationName` |
| logo asset | `resolvedAssets.<declared-slot>` |
| logo alternative text | `resolvedAssets.<declared-slot>.alt` |

The validator checks setting type, target type, choice-map completeness, duplicate target
writes, and asset-slot compatibility. V1 supports only `identity` and explicit `choice-map`;
there are no expressions, callbacks, computed paths, conditional code, or generic object
merge. Settings are applied to an immutable manifest design copy in manifest order, producing
one fully resolved render configuration.

### 6.3 Resolved settings

The package exports:

```ts
export type WikiPdfTemplateScalar = string | number | boolean | null;

export interface WikiPdfTemplateAssetInput {
  bytes: Uint8Array;
  mediaType: "image/png" | "image/svg+xml";
  filename?: string;
  alt?: string;
}

export interface ResolvedWikiPdfTemplateSettingsV1 {
  values: Record<string, WikiPdfTemplateScalar>;
  design: WikiPdfTemplateDesignV1;
  documentLocale: string;
  labels: WikiPdfTemplateDocumentLabelsV1;
  assets: WikiPdfTemplateResolvedAsset[];
  notes: WikiPdfTemplateDiagnostic[];
}

export interface LocalizedWikiPdfTemplateUiV1 {
  locale: string;
  template: {
    name: string;
    description: string;
  };
  settingGroups: Record<string, {
    label: string;
    description?: string;
  }>;
  settings: Record<string, {
    label: string;
    help?: string;
    options?: Record<string, string>;
  }>;
  notes: WikiPdfTemplateDiagnostic[];
}
```

Resolution order:

1. manifest defaults;
2. persisted host values;
3. per-export invocation overrides, when a host exposes them;
4. validation and canonical normalization;
5. application of declared, type-checked bindings to an immutable design copy;
6. document-locale selection and complete document-label resolution;
7. asset-slot validation and deterministic virtual-path assignment.

Unknown setting keys are errors. Invalid persisted values do not silently become Typst code:
the resolver returns a structured error and the host offers reset-to-default. Missing optional
values become the manifest default or `null`. The resolved dictionary has stable key order.

Binary assets are never embedded in the Typst settings dictionary. The resolver mounts them
under a deterministic template-setting asset path and passes only that path plus safe metadata
to Typst.

The Typst `settings` dictionary contains four namespaces: `values`, `design`, `labels`, and
`assets`. Template source consumes resolved design values and labels rather than declaring a
second set of defaults. `values` remains available only for template-specific conditional
presentation; it cannot override a design field without a manifest binding.

UI localization is resolved separately through `localizeWikiPdfTemplateUi(pkg, uiLocale)` and
never enters Typst or the package digest as host state. The locale bundles themselves remain
part of canonical package identity; only the selected UI locale is host state.

### 6.4 Template package

Normative in-memory shape:

```ts
export interface WikiPdfTemplateTextFile {
  path: string;
  text: string;
}

export interface WikiPdfTemplateBinaryFile {
  path: string;
  bytes: Uint8Array;
  mediaType: string;
}

export interface WikiPdfTemplatePackageV1 {
  manifest: WikiPdfTemplateManifestV1;
  sources: WikiPdfTemplateTextFile[];
  assets: WikiPdfTemplateBinaryFile[];
}
```

This is an in-memory contract, not an archive format. A later pack/import spec may define how
the same logical package is stored without changing v1 rendering semantics.

Package limits for v1:

- maximum 64 source files;
- maximum 64 binary assets;
- maximum 1 MiB per Typst source;
- maximum 5 MiB per binary asset;
- maximum 16 MiB total package bytes;
- UTF-8 text only;
- source paths end in `.typ`;
- bundled binary assets are limited to explicitly declared safe media types;
- custom font binaries are rejected in this slice.

### 6.5 Path and namespace rules

Package paths:

- use POSIX `/` separators;
- are relative and NFC-normalized;
- contain no empty, `.`, or `..` segment;
- contain no control character, backslash, drive prefix, URL scheme, query, or fragment;
- are unique under exact and case-folded comparison;
- are maximum 240 characters with maximum 100-character segments;
- cannot begin with a reserved engine namespace.

Final compiler VFS layout:

```text
/main.typ                         generated document entry
/wiki/runtime/v1.typ              engine-owned semantic runtime
/template/template.typ            selected template entry
/template/partials/...             selected template sources
/template/assets/...               bundled template assets
/template/settings-assets/...      validated host-provided logo/assets
/document/assets/...               resolved page images and diagrams
```

The package validator works with package-relative paths. `@atlcli/pdf` alone assigns the
`/template/` prefix during bundle assembly. Template packages can never provide `/main.typ`,
`/wiki/...`, or `/document/...`.

### 6.6 Typst entry contract

The manifest entry must export:

```typst
#let render(meta, body, settings: (:)) = {
  body
}
```

Normative semantics:

- `meta` is a dictionary with the keys in §6.7.
- `body` is the engine-generated semantic document content.
- `settings` is the fully resolved dictionary for this template.
- `render` returns document content and includes `body` exactly once.
- Templates may set page masters, typography, heading presentation, cover, outline,
  header, footer, and template-owned decoration.
- Engine-owned semantic helpers remain in `/wiki/runtime/v1.typ` so missing template-local
  helper functions cannot break generated body semantics.
- Templates may import only relative files inside `/template/` and the documented
  `/wiki/runtime/v1.typ` surface.
- Imports using URLs, Typst package registries, absolute host paths, or parent traversal are
  rejected.
- Template source cannot access the network or host filesystem through the compiler.
- V1 does not expose arbitrary component replacement hooks. A later compatible extension may
  add explicitly typed style tokens or component hooks after two templates prove the need.

Built-ins are compiled against short, long, hostile, dense-table, and feature-zoo fixtures.
The compiler-backed contract test proves that the required `render` export exists and does not
drop the body.

### 6.7 Metadata contract

`meta` contains:

| Key | Type | Required | Meaning |
|---|---|---:|---|
| `title` | string | yes | source page title |
| `space` | string | yes | display space name or stable fallback |
| `space-key` | string or `none` | no | source space key |
| `version` | string | yes | display version such as `v17` or `—` |
| `author` | string | yes | source author or deterministic fallback |
| `exporter` | string | yes | current exporter or fallback |
| `language` | string | yes | normalized ISO language |
| `region` | string or `none` | no | normalized region |
| `exported-at` | Typst datetime | yes | injected deterministic export time |
| `exported-label` | string | yes | localized display date |

Adding optional metadata is backward-compatible. Removing or changing an existing key requires
a new contract version. Hosts do not add host-specific keys directly; future extension points
must use a namespaced optional metadata dictionary.

### 6.8 Resolved design and engine invariants

The old `renderTheme` concept is absorbed into `design.tokens`,
`design.semanticPalettes`, and `design.components`. There must not be two manifest-level theme
models. In v1:

- the selected manifest supplies the complete design defaults;
- declared setting bindings produce a validated resolved design;
- a programmatic `RunPdfExportInput.theme` override remains temporarily supported for current
  consumers and maps onto the same resolved token fields;
- precedence is manifest design, declared user-setting bindings, then explicit programmatic
  override, followed by engine safety validation;
- the extension never exposes raw `PdfThemeOptions`;
- a setting may change a contrast-related token only when the binding target is explicitly
  allowlisted, and the engine still rejects a result below the required contrast policy.

The following are engine invariants rather than template design and therefore remain outside
the manifest:

- dense-table detection and overflow algorithms, including the threshold decision itself;
- URL compaction while preserving the full link target;
- user-ID/mention resolution;
- semantic row/column grid construction and repeated-header semantics;
- contrast enforcement, although the selected colors and minimum target are manifest values;
- source maps, diagnostics, output tagging/profile validation, and accessibility fallbacks;
- worker/VFS/compiler isolation, path security, asset resolution, and output lifecycle;
- heading promotion rules and any behavior required to retain content semantics.

Every retained literal in these areas must be listed in a reviewed engine-invariant allowlist
with owner, reason, and regression test. Presentation values such as font names, sizes, colors,
padding, radii, margins, cover offsets, header/footer rules, labels, or attribution copy are
never accepted into that allowlist.

---

## 7. Reusable package API

### 7.1 Public exports

Proposed exports:

```text
@atlcli/wiki-pdf-template
@atlcli/wiki-pdf-template/browser
@atlcli/wiki-pdf-template/builtins
@atlcli/wiki-pdf-template/testing
```

The default and browser barrels expose the same host-neutral contract. `testing` contains only
fixtures, memory adapters, and conformance helpers; production code must not depend on it.

No export may import Node, DOM, Chrome, WXT, IndexedDB, or a Typst compiler.

### 7.2 Validation and lint APIs

Required helpers:

```ts
parseWikiPdfTemplateManifest(input: unknown): WikiPdfTemplateParseResult
validateWikiPdfTemplatePackage(input: unknown): WikiPdfTemplateValidationResult
lintWikiPdfTemplatePackage(pkg: WikiPdfTemplatePackageV1): WikiPdfTemplateDiagnostic[]
resolveWikiPdfTemplateSettings(...): WikiPdfTemplateSettingsResult
localizeWikiPdfTemplateUi(
  pkg: WikiPdfTemplatePackageV1,
  uiLocale: string
): LocalizedWikiPdfTemplateUiV1
canonicalizeWikiPdfTemplatePackage(pkg: WikiPdfTemplatePackageV1): Uint8Array
digestWikiPdfTemplatePackage(pkg: WikiPdfTemplatePackageV1): Promise<string>
summarizeWikiPdfTemplate(
  pkg: WikiPdfTemplatePackageV1,
  options?: { locale?: string }
): WikiPdfTemplateSummary
compareWikiPdfTemplatePackages(
  left: WikiPdfTemplatePackageV1,
  right: WikiPdfTemplatePackageV1
): WikiPdfTemplatePackageDiff
```

Validation answers whether the contract is safe and structurally usable. Linting returns
review guidance that may be non-fatal for curated development but is never used as a security
bypass.

Required stable diagnostic families:

- `manifest-*` — schema, contract, IDs, versions, fields;
- `path-*` — traversal, separators, collisions, limits;
- `source-*` — UTF-8, size, entry, required export, imports;
- `asset-*` — type, signature, size, SVG safety, orphaned asset;
- `setting-*` — duplicate keys, bad defaults, invalid bounds/options;
- `binding-*` — unknown settings/targets, type mismatch, collisions, incomplete choice maps;
- `design-*` — page, feature, typography, token, palette, and component constraints;
- `font-*` — missing declarations, faces, weights, styles, and unavailable runtime fonts;
- `locale-*` — invalid tags, unknown translation keys, missing fallback copy, partial locale
  fields, and broken fallback chains;
- `package-*` — totals, duplicates, canonicalization;
- `compat-*` — unknown contract/runtime/Typst/feature requirement;
- `lint-*` — unused source/asset, missing optional help/group descriptions, suspicious literal.

Diagnostics contain:

```ts
interface WikiPdfTemplateDiagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  path?: string;
  line?: number;
  column?: number;
  settingKey?: string;
}
```

Ordering is deterministic: manifest, paths, sources, assets, settings, package summary; then
lexicographic path/key within each family.

### 7.3 Catalog and repository ports

Read-only rendering consumes:

```ts
export interface WikiPdfTemplateSummary {
  contract: "wiki.pdf-template/v1";
  id: string;
  version: string;
  digest: string;
  locale: string;
  name: string;
  description: string;
  // compatibility, font, feature, setting, and asset-slot capabilities
}

export interface WikiPdfTemplateCatalog {
  list(options?: { locale?: string }): Promise<WikiPdfTemplateSummary[]>;
  get(ref: { id: string; version?: string }): Promise<WikiPdfTemplatePackageV1 | undefined>;
}
```

Future management adapters can implement:

```ts
export interface WikiPdfTemplateRepository extends WikiPdfTemplateCatalog {
  save(
    pkg: WikiPdfTemplatePackageV1,
    options: { mode: "create" } | { mode: "replace"; expectedDigest: string }
  ): Promise<WikiPdfTemplateSummary>;
  remove(
    ref: { id: string; version?: string },
    options: { expectedDigest: string }
  ): Promise<boolean>;
}
```

Rules:

- `mode: "create"` fails if the exact ID/version already exists.
- `mode: "replace"` and `remove` require the current digest and fail on stale state.
- `save` validates before mutation.
- Catalog ordering is stable by locale-resolved display name, ID, then version. The same
  locale input must produce the same ordering; omitted locale uses `defaultLocale` and then
  `fallbackLocale`.
- Summary `locale`, `name`, and `description` are resolved presentation data, not canonical
  package fields. `get()` always returns the unchanged package, independent of locale.
- No storage location, URL, tenant, filesystem path, or IndexedDB key leaks into summaries.
- Summaries include compatibility/runtime requirements, required font families, supported page
  sizes/orientations, feature flags, setting keys/types, and asset-slot capabilities so a
  management UI can inspect a template without parsing Typst source.
- The first slice ships memory and built-in catalog implementations only.
- The extension preference store is not a template repository; it stores selection/settings,
  not template source.
- Node/filesystem, browser persistence, remote service, or organization adapters are later
  host-owned packages or application modules.

### 7.4 Canonicalization and digest

Canonical identity covers:

1. normalized manifest with stable key order;
2. sources sorted by normalized path with exact UTF-8 bytes;
3. binary assets sorted by normalized path with exact bytes and media type.

It excludes:

- storage timestamps;
- host metadata;
- host UI locale selection and any host copy outside the template domain;
- compiler version;
- selected user settings;
- source page content.

The digest is lowercase SHA-256 hex over the canonical byte representation. The package uses
Web Crypto or an injected test digest implementation without importing Node crypto. The digest
is reported by render jobs and later supports caching, optimistic updates, and archive
verification.

---

## 8. PDF engine integration

### 8.1 Runner input and environment

`RunPdfExportInput` gains:

```ts
interface WikiPdfTemplateSelection {
  id: string;
  version?: string;
  settings?: Record<string, unknown>;
  settingAssets?: Record<string, WikiPdfTemplateAssetInput>;
}

interface RunPdfExportInput {
  // existing fields remain
  template?: WikiPdfTemplateSelection;
}
```

`PdfExportEnv` gains an optional template catalog. If selection and catalog are both omitted,
the runner uses the built-in Editorial Indigo package. If a non-default selection is provided
without a catalog, resolution fails before preparation.

The runner order becomes:

1. resolve template package;
2. validate package and exact contract;
3. resolve defaults/settings/assets;
4. prepare document assets;
5. serialize semantic body against the engine runtime;
6. assemble deterministic VFS bundle;
7. compile;
8. validate output;
9. emit;
10. report template identity, digest, and timings.

Template resolution and setting validation belong to the existing `preparing` phase. A later
UI may expose a separate `resolving-template` label without changing the neutral phase enum.

### 8.2 Generic source bundle

The singleton bundle is replaced by:

```ts
export interface PdfSourceFile {
  path: string;
  text: string;
}

export interface PdfSourceBundle {
  entryPath: string;
  sources: PdfSourceFile[];
  assets: PreparedPdfAsset[];
  sourceMap: PdfSourceMapEntry[];
  notes: ExportNote[];
}
```

Migration rules:

- `entryPath` is `main.typ` for generated exports.
- Paths are VFS-relative without a leading slash.
- `sources` are sorted by canonical path.
- `assets` use distinct template/document namespaces and cannot collide with sources.
- The compiler maps every source generically; it does not special-case template names.
- The extension job-store byte count includes every source and asset.
- Worker protocols continue to structured-clone one bundle.
- Diagnostics retain file paths and map `/main.typ` ranges to `ExportBlock` paths.
- Template/runtime diagnostics remain file/line diagnostics and are labeled as template or
  engine-runtime failures rather than falsely mapped to page content.

This plan narrowly supersedes Spec 009 only for the `PdfSourceBundle.template` singleton and
the compiler's hard-coded `/atlcli.typ` mount. Spec 009's runner/compiler/host ownership,
abort, asset, output, and harness boundaries remain unchanged.

### 8.3 Engine-owned Typst runtime

The current monolithic `template.ts` is split conceptually into:

```text
wiki runtime v1
  semantic helper functions used by generated body
  table/dense-table helpers
  callout/status/task helpers
  semantic safety enforcement over resolved manifest design inputs

selected template
  page masters
  document-level typography
  cover and outline policy
  header/footer
  decorative layout
  manifest-resolved design, labels, branding, and asset placement
  required render(meta, body, settings)
```

Generated `main.typ` imports runtime helpers from `/wiki/runtime/v1.typ` and `render` from the
selected entry. It serializes metadata plus resolved `values`, `design`, `labels`, and asset
descriptors through context-specific Typst encoders. Template source reads all presentation
defaults from these resolved structures; it must not recreate manifest defaults as Typst
literals.

The runtime source version is tied to the contract implementation, not to the package display
version. Contract/runtime incompatibility returns `compat-runtime-unsupported` before compile.

### 8.4 Report contract

`PdfExportReport` adds:

```ts
template: {
  contract: "wiki.pdf-template/v1";
  id: string;
  name: string;
  version: string;
  digest: string;
}
```

The report may list applied setting keys but never raw text, asset bytes, organization names,
or other values. `template.name` is the fallback-locale name for stable provenance and does
not change with the host UI language; the extension may display the independently localized
catalog name. Timing includes template resolution within `prepareMs`; detailed internal
timings may add `templateResolveMs` without breaking current consumers.

### 8.5 Theme compatibility

`PdfThemeOptions` remains a low-level programmatic override during v1 migration so existing
consumers and table-contrast tests do not regress. Resolution is:

1. template manifest `design.tokens` and relevant `design.components` fields;
2. declared user-setting bindings;
3. explicit `RunPdfExportInput.theme` override mapped to the equivalent design-token fields;
4. contrast validation and complete engine theme resolution.

The extension does not expose raw `PdfThemeOptions`. Curated user-facing settings are manifest
settings and cannot bypass contrast validation. After all current programmatic consumers have
migrated to the manifest resolver, deprecation/removal of `PdfThemeOptions` is a separate
compatibility decision rather than a hidden part of this slice.

---

## 9. Curated templates

### 9.1 Editorial Indigo migration

The existing design becomes a built-in package with:

- ID `builtin.editorial-indigo`;
- contract `wiki.pdf-template/v1`;
- fixed package version `1.0.0` for the first migration;
- exact current Source font requirements;
- current page, paper, ink, table contrast, cover, TOC, header/footer, closing page, links,
  code, callout, status, list, badge, and spacing behavior;
- settings exposed only when they can preserve current defaults exactly.

Default setting values reproduce today's output. Omitting template selection and selecting
Editorial Indigo with defaults are equivalent.

The legacy `ATLCLI_TYPST_TEMPLATE` export may remain as a deprecated compatibility alias for
one repository release cycle, but all in-repo consumers migrate to the built-in catalog during
this slice. No new code may import the alias.

### 9.2 Hardcoding migration ledger

Before implementation changes the current template, Task 0 records every presentation literal
in `packages/pdf/src/template.ts`, `serialize.ts`, `theme.ts`, and their active callers. The
ledger starts with the following mandatory areas and is updated by the drift check:

| Current hardcoded area | Current examples to preserve | Destination in Editorial Indigo manifest |
|---|---|---|
| Runtime compatibility | assumed runtime helpers, Typst behavior, and compiler feature set | `compatibility.runtime`, `compatibility.typst`, `compatibility.requiredFeatures` |
| Fonts | Source Sans 3, Source Serif 4, Source Code Pro and used faces/weights | `requiredFonts`, referenced by `design.typography.*` |
| Page model | A4; 23 mm top, 20 mm bottom, 22 mm side margins; current orientation | `design.page` |
| Document features | cover, TOC depth 3, closing page, interior header, footer after page 1, page numbers | `design.features` plus component layout fields |
| Branding/attribution | current source/product wording, `Generated from Confluence with atlcli`, and `https://atlcli.sh/` | `design.branding` and localized `generatedFrom` label |
| Document localization | cover metadata, contents, closing-page, page, export, version, and exporter labels | `localization.locales.*.document` |
| Management/UI localization | template name/description, setting-group labels/descriptions, setting labels/help, and choice labels | `localization.locales.*.{template,settingGroups,settings}` |
| Typography roles | body 10 pt; H1 18 pt; H2 14 pt; H3 11.5 pt; cover title 31 pt; closing title 24 pt; code 8.5 pt; table 9 pt; page chrome 8 pt; current weights/leading | `design.typography` |
| Core colors | indigo `#4B57A3`, ink `#202A44`, muted `#74727A`, paper, border `#DFE1E6`, code/table-header `#F4F5F7`, mention `#0747A6`, task colors | `design.tokens.colors` |
| Contrast | current colored-cell mode, light/dark text choices, and minimum ratio | `design.tokens.contrast`; enforcement remains engine-owned |
| Semantic palettes | info/note/warning/tip/panel callouts and grey/red/yellow/green/blue statuses | `design.semanticPalettes` |
| Paragraph/headings | body alignment/leading/spacing; heading spacing and sticky behavior | `design.components.paragraph`, `design.components.headings` |
| Lists/tasks | marker glyphs, 0.7 em indent, body inset, 8 pt spacing, enumeration pattern, task marker presentation | `design.components.lists` and typography/token references |
| Code/callout/badge | code fill/inset/radius; callout border/inset/radius/spacing; status padding/radius/lightening | corresponding `design.components.*` sections |
| Tables | normal/dense typography, padding, border/header colors, hyphenation, repeated-header presentation | `design.components.table` |
| Cover/header/footer/closing layout | all offsets, grids, rule widths, gaps, alignment, first/interior-page conditions | corresponding `design.components.*` sections |
| Asset/logo usage | accepted media, placements, maximum dimensions, fit, fallback, and alt policy | `assetSlots` plus asset setting/binding |
| User-editable mapping | currently implicit connections between exporter options and rendering values | `settings` plus explicit `bindings` |

This ledger is exhaustive by category, not frozen to the examples shown. If the drift audit
finds any additional user-visible color, font, label, layout length, spacing, radius, rule,
feature default, palette entry, or attribution value, it is added to the manifest schema or a
typed extension of an existing field before migration.

After migration:

- Editorial Indigo's manifest is the only source of its presentation defaults;
- template Typst source may contain structural logic and consume resolved values, but cannot
  repeat fallback presentation literals from the manifest;
- `serialize.ts` emits semantic content and runtime operations, not template styling;
- remaining engine literals must appear in the reviewed §6.8 allowlist;
- a regression audit fails on undeclared font-family strings, hex colors, branding URLs/copy,
  or presentation dimensions in engine/template source outside the built-in manifest and a
  narrowly documented structural allowlist.

### 9.3 Migration sequence — manifest machinery first, production migration last

The migration is deliberately not combined with initial schema implementation:

1. capture the current source/PDF baseline and complete the hardcoding ledger;
2. implement and test the full manifest parser, validator, linter, compatibility/font checks,
   localization, asset slots, setting bindings, resolver, canonicalization, and catalog using
   synthetic contract fixtures;
3. implement the generic source bundle, engine runtime inputs, and browser compiler path using
   synthetic manifests whose values are intentionally unlike Editorial Indigo;
4. prove generated settings, host persistence, neutral harness behavior, and management
   summaries against those fixtures;
5. only then migrate Editorial Indigo in one dedicated production task, moving every ledger
   entry out of hardcoded exporter/template defaults and into its manifest;
6. run the hardcoding audit, default-byte comparison, structural PDF checks, heavy-page E2E,
   and explicit review of any unavoidable baseline change;
7. add/finish the second curated built-in through the same manifest path without adding
   template-ID conditionals or duplicating runtime semantics.

This order keeps the current exporter stable while the abstraction is built and ensures the
manifest contract is not reverse-engineered solely around the old template's implementation.

### 9.4 Second curated template

The second template must prove a real abstraction. It must differ in at least:

- cover treatment;
- page master/header/footer;
- heading typography and rhythm;
- accent usage;
- optional outline/cover settings.

It must not fork or duplicate the engine-owned semantic runtime. Both templates render the
same prepared document and pass the same correctness fixture.

The final visual direction and display name are a Task 0 review decision. A superficial color
swap does not satisfy the second-template acceptance criterion.

### 9.5 Initial settings behavior

The first UI supports the subset declared by each built-in manifest. Recommended Editorial
Indigo settings:

- accent color;
- page size (`a4`, `us-letter`);
- cover on/off;
- outline on/off;
- header text;
- footer text;
- organization name;
- optional PNG/SVG logo plus alternative text.

All defaults exist in the manifest from the Editorial Indigo migration onward. Only the subset
declared in `settings` and `bindings` is editable in the first UI. If exposing a setting changes
the default bytes, it is not exposed until that intentional output change has its own reviewed
fixture; the value itself must not move back into engine hardcoding.

Logo rules:

- PNG or sanitized SVG only;
- maximum 5 MiB;
- no external SVG references, scripts, event handlers, foreign objects, or network fonts;
- deterministic asset path derived from setting key and content digest;
- organization name remains semantic text even when a logo is decorative;
- meaningful logos require alternative text before any accessibility claim.

---

## 10. Extension integration

### 10.1 UI shape

The PDF section gains:

- a template selector populated from the built-in catalog;
- locale-resolved template name and short description using the current host UI locale;
- a generated settings form grouped by structural manifest order/group and labeled from the
  same locale bundle;
- locale-resolved option labels and help text plus host-localized inline validation errors;
- logo upload/replace/remove and a small safe preview;
- reset current template settings to defaults;
- existing Export and Cancel actions;
- report display of selected template name/version.

There is no source editor, raw Typst field, package upload, marketplace, or stationery wizard.
Changing a setting never compiles automatically. The current page export is the
compiler-backed preview for this slice.

### 10.2 Persistence

Persistence is host-owned and separate from PDF jobs.

Recommended first-slice scope:

- local to the browser profile;
- keyed by exact tenant origin plus Confluence space key;
- fallback to the built-in Editorial Indigo defaults when no record exists;
- no sync and no organization-wide distribution;
- separate saved values per template ID;
- binary setting assets stored in IndexedDB, not `chrome.storage` JSON;
- source template packages are not stored because the first slice contains built-ins only.

Persisted record shape includes:

- contract identifier;
- template ID;
- last-seen template version;
- scalar settings;
- references to local setting assets;
- updated timestamp for host UX only.

UI locale is not persisted as template preference and does not alter package or settings
identity. Changing browser language relocalizes catalog summaries and controls without
changing the selected template, saved values, or a running export snapshot.

On built-in version changes, values are revalidated against the new manifest. Unknown or
invalid values are reported and require reset/confirmation; no arbitrary migration code runs
from the template package.

### 10.3 State and concurrency

- Template/settings state is tied to tenant + space, not the current page version.
- Active page navigation continues to abort only the running export, not delete preferences.
- The selection and resolved settings are snapshotted at export start.
- Settings changed during an export affect only the next export.
- Job persistence stores the fully assembled bundle, so a worker restart does not re-resolve
  a newer template or changed setting.
- Delete/reset operations cannot affect a stored in-flight job.

### 10.4 Host adapter seam

Extension code implements thin adapters for:

- `WikiPdfTemplateCatalog` — built-in package catalog;
- preference load/save/delete;
- setting-asset load/save/delete;
- current tenant/space scope;
- existing PDF compile and output ports.

No extension adapter is imported by `@atlcli/wiki-pdf-template` or `@atlcli/pdf`.

---

## 11. Ordered implementation plan

### Task 0 — Ratify decisions and capture baselines **[decision gate]**

- [ ] Confirm `wiki.pdf-template/v1` as the provisional machine contract identifier.
- [ ] Confirm `@atlcli/wiki-pdf-template` as private workspace implementation name only.
- [ ] Confirm first-slice preference scope (recommended: local tenant + space).
- [ ] Confirm the second curated template's visual direction; reject a color-only variant.
- [ ] Confirm that custom fonts, public imports, archives, and stationery remain out of scope.
- [ ] Execute §3.2 drift check.
- [ ] Capture default fixture bundle, PDF bytes, SHA-256, inspection, and screenshots.
- [ ] Complete the §9.2 hardcoding ledger from the active source/caller path, including every
      presentation literal and every current exporter option that affects output.
- [ ] Classify every current literal as manifest-owned design or a §6.8 engine invariant;
      review the initial invariant allowlist before code moves.
- [ ] Record current built extension and neutral harness artifact sizes.

**Gate:** do not change the compiler bundle or template source before baseline artifacts and
decisions are recorded.

### Task 1 — Scaffold `@atlcli/wiki-pdf-template`

- [ ] Add private workspace package with strict ESM/TypeScript configuration.
- [ ] Add browser/default exports with no host-specific dependencies.
- [ ] Define manifest, compatibility, font, page, feature, branding, localization, typography,
      token, palette, component, asset-slot, setting, binding, resolved-design, file, package,
      diagnostic, summary, selection, catalog, and repository types.
- [ ] Add exact contract constant `WIKI_PDF_TEMPLATE_CONTRACT_V1`.
- [ ] Add negative browser-build fixtures for Node/DOM/Chrome leakage.
- [ ] Wire package into root workspaces, typecheck, build inputs, and `check:browser`.
- [ ] Export test fixtures only from `./testing`.

### Task 2 — Implement validation, linting, settings, and management primitives

- [ ] Implement strict manifest parser and all §6 validation rules.
- [ ] Validate runtime/Typst compatibility and runtime-feature requirements against an
      injected engine capability inventory.
- [ ] Validate required font IDs/faces and typography references against an injected compiler
      font inventory; reject missing faces before compile.
- [ ] Validate page sizes/orientations/margins, feature combinations, typography roles,
      tokens, semantic palettes, component metrics, and bounded units/ratios.
- [ ] Validate canonical BCP 47 tags, complete fallback copy, known group/setting/option keys,
      partial-locale warnings, deterministic field-level fallback, and hostile strings.
- [ ] Validate asset-slot media, size, placement, dimensions, fallback, and alt policies.
- [ ] Validate binding target allowlist, setting/target types, choice maps, collisions, and
      asset-slot references.
- [ ] Implement normalized safe path handling and collision detection.
- [ ] Validate source entry, required render export, and allowed imports conservatively.
- [ ] Validate PNG signatures and sanitize SVG setting assets through a reusable pure path.
- [ ] Implement package byte/file limits.
- [ ] Implement stable structured diagnostics and deterministic ordering.
- [ ] Implement setting defaults, normalization, unknown-key rejection, immutable binding
      application, locale resolution, and asset-slot resolution.
- [ ] Produce stable resolved `values`, `design`, document `labels`, and `assets` dictionaries
      suitable for context-specific Typst encoding.
- [ ] Implement independent UI localization for template metadata, setting groups, settings,
      help, and choice options without adding UI state to render identity.
- [ ] Implement canonicalization and SHA-256 digest.
- [ ] Implement a structural package diff for manifest, source, asset, and digest changes.
- [ ] Implement summary creation and SemVer-aware catalog ordering.
- [ ] Define catalog/repository ports plus memory implementations.
- [ ] Add repository conformance tests for list/get/save/remove and optimistic digest checks.
- [ ] Add adversarial fixtures: traversal, case collisions, malformed Unicode, oversized
      sources/assets, bad defaults/bindings, invalid units/colors/locales, missing fonts,
      unsupported features, unknown contract, invalid SemVer, remote imports, and active SVG.
- [ ] Use synthetic manifests with deliberately non-Editorial page, type, color, label,
      palette, and component values to prove the schema independently of current hardcoding.

### Task 3 — Generalize `PdfSourceBundle` and browser compiler VFS

- [ ] Replace `main`/`template` singleton fields with `entryPath`/`sources`.
- [ ] Add generic PDF VFS source/path validation in `@atlcli/pdf`.
- [ ] Update browser compiler to mount every source and asset deterministically.
- [ ] Remove the hard-coded `/atlcli.typ` mount.
- [ ] Preserve raw diagnostic file paths and content source-map mapping.
- [ ] Update extension job byte accounting, storage fixtures, worker messages, compile port,
      and cleanup behavior.
- [ ] Update neutral harness worker protocol and invalid-source probe.
- [ ] Add collisions, missing entry, duplicate path, oversized bundle, and reset cleanup tests.
- [ ] Prove abort still replaces/terminates the active Worker and emits no PDF.

### Task 4 — Implement the resolved runtime/template seam with synthetic fixtures

- [ ] Extract semantic helpers into engine-owned `wiki/runtime/v1.typ` source without yet
      migrating Editorial Indigo's production presentation literals.
- [ ] Define generated `main.typ` imports and exact `render(meta, body, settings)` call.
- [ ] Encode resolved `values`, `design`, `labels`, and asset descriptors through typed Typst
      encoders and expose them to the selected template.
- [ ] Map `PdfThemeOptions` onto resolved design tokens while preserving override and contrast
      behavior for existing consumers.
- [ ] Add pre-compile runtime-feature, Typst-version, and font-inventory checks.
- [ ] Compile synthetic templates whose page, labels, branding, typography, palettes,
      component metrics, and asset slots visibly differ.
- [ ] Add compile-backed contract tests proving body appears exactly once.
- [ ] Keep the current production default path and captured output unchanged throughout this
      task; any default drift is a STOP condition.

### Task 5 — Add generic settings UI and host preference adapters

- [ ] Add tenant+space preference and setting-asset store with fake-indexeddb tests.
- [ ] Add generated controls for every v1 setting type used by the synthetic fixtures.
- [ ] Render controls from manifest summaries/definitions and locale-resolved UI copy without
      template-ID branches or host-hardcoded fallback strings.
- [ ] Relocalize catalog and controls when host UI locale changes without modifying selection,
      persisted setting values, or in-flight export snapshots.
- [ ] Add template selection, description, reset, validation, logo lifecycle, and errors.
- [ ] Develop against injected synthetic/memory catalogs; do not switch production default
      resolution to Editorial Indigo's manifest yet.
- [ ] Preserve current one-click production PDF export when no preference exists.
- [ ] Snapshot selection/settings/assets at export start.
- [ ] Pass selection through the neutral runner; do not assemble Typst in the component.
- [ ] Show template name/version in the report.
- [ ] Cover panel reload, template switch, per-space isolation, invalid persisted values,
      missing assets, replace/delete, navigation during export, abort, retry, and successful
      export.

### Task 6 — Extend neutral browser conformance and artifact gates

- [ ] Use `@atlcli/wiki-pdf-template` memory catalog in the harness.
- [ ] Compile at least two synthetic contract fixtures with real Worker/WASM/fonts below the
      existing nested path.
- [ ] Prove settings/bindings, localization fallback, compatibility rejection, font rejection,
      semantic palettes, component metrics, and logo assets through public package surfaces.
- [ ] Add invalid manifest, invalid source, and template compile diagnostic probes.
- [ ] Require all runtime/template sources and declared assets in extension and harness output.
- [ ] Reject remote import/loader strings and forbidden host imports.
- [ ] Prove no template management code pulls extension/WXT topology into reusable packages.
- [ ] Keep abort-without-emission and warm compiler reuse gates.

### Task 7 — Migrate production hardcoding and add curated templates **[late migration gate]**

- [ ] Create the complete Editorial Indigo manifest from the reviewed §9.2 ledger, including
      compatibility, fonts, page, features, branding, labels, typography, tokens, palettes,
      component metrics, asset slots, settings, and bindings.
- [ ] Move Editorial Indigo template name/description and all group/setting/help/choice UI copy
      into a complete fallback locale bundle; add reviewed additional locales separately.
- [ ] Replace Editorial Indigo Typst presentation literals with reads from resolved manifest
      design/labels/assets; retain only structural Typst logic.
- [ ] Remove template styling from `serialize.ts` so it emits semantic runtime calls only.
- [ ] Make omitted selection resolve to Editorial Indigo defaults and migrate all in-repo
      imports away from direct `ATLCLI_TYPST_TEMPLATE` use.
- [ ] Add initial Editorial Indigo settings/bindings for page size, cover, outline, header,
      footer, organization, accent, and logo without changing defaults.
- [ ] Add/finish a second curated template using the same complete manifest and engine runtime,
      with no template-ID branches.
- [ ] Add the automated hardcoding regression audit and its reviewed engine-invariant
      allowlist; fail on undeclared fonts, colors, labels, attribution, URLs, and dimensions.
- [ ] Compile both curated templates against short, long, feature-zoo, dense-table, hostile,
      image, Mermaid, localization, branding, and logo fixtures.
- [ ] Assert tags, outline policy, links, embedded fonts, page size/orientation, margins,
      repeated table headers, source-cell contrast, and no content loss.
- [ ] Assert deterministic warm output for each fixed template/settings combination and record
      template package digests/output hashes.
- [ ] Run Editorial Indigo default golden parity and structural inspection.
- [ ] STOP if default bytes change. Diagnose source/VFS/value-encoding effects; accept a new
      baseline only after explicit review of rendered pages, tags, outline, links, fonts, text
      extraction, all ledger values, and the precise reason byte parity is impossible.

**Gate:** Task 7 cannot begin until Tasks 1–6 prove the manifest and runtime path without using
Editorial Indigo as the only successful fixture. No subsequent implementation task may move
presentation defaults back into engine hardcoding.

### Task 8 — Documentation, final E2E, and handoff **[E2E: user]**

- [ ] Keep `TEMPLATE-UX.md` aligned with the accepted contract and implementation scope.
- [ ] Add narrow supersession notes to Specs 007 and 009.
- [ ] Document the template contract, manifest/settings fields, package API, diagnostics,
      limits, host adapter pattern, and non-goals.
- [ ] Document every manifest design area, compatibility/font precondition, localization
      fallback, asset slot, binding rule, and the engine-invariant boundary.
- [ ] Document the separation of host UI locale, document locale, stable machine keys, and
      field-level fallback behavior.
- [ ] Publish the completed hardcoding migration ledger and remaining invariant allowlist as
      maintainer documentation.
- [ ] Document built-in templates and user settings in the PDF export guide.
- [ ] Document how a future host supplies catalog, compiler, assets, output, and persistence
      independently.
- [ ] Run full repo tests, typecheck, build, browser checks, both artifact scans, docs checks,
      and Chromium harness.
- [ ] Load the production extension in Chrome.
- [ ] Export a representative heavy page with Editorial Indigo defaults and compare it to the
      captured baseline.
- [ ] Export the same page with the second template and at least one non-default setting.
- [ ] Verify logo, cover, outline, header/footer, dense tables, mentions, links, images,
      Mermaid, tags, fonts, search/copy, and cancellation.
- [ ] Record output hashes, package digests, Chrome/compiler versions, and screenshots of
      intentional visual differences.
- [ ] Remove temporary live resources and local test artifacts.

---

## 12. Verification matrix

### 12.1 Template package unit tests

- exact/unknown contract;
- manifest required/unknown fields;
- ID, SemVer, entry path, and absence of duplicate top-level user-facing copy;
- runtime/Typst/feature compatibility and injected capability inventory;
- required font IDs, families, faces, weights, styles, purpose, typography references, and
  missing compiler inventory entries;
- page size/orientation/margins and document-feature combinations;
- branding fields and attribution URL validation;
- typography roles, colors/token references, bounded units, layout tokens, contrast values,
  semantic palettes, and every component metric group;
- complete fallback-locale template/document/group/setting/option copy, BCP 47 normalization,
  exact-region/base-language/default/fallback resolution, partial-locale warnings, unknown
  translation keys, empty fields, and hostile localized strings;
- independent UI/document locale resolution and stable machine keys across locales;
- asset-slot media, limits, placements, dimensions, fit, fallback, and alt policies;
- every setting kind, default, bounds, option, and required behavior;
- binding allowlist, setting/target type compatibility, choice-map completeness, duplicate
  writes, multi-target bindings, and asset-slot references;
- unknown, missing, stale, and hostile setting values;
- immutable resolved `values`, `design`, `labels`, and `assets` ordering;
- path traversal, case collisions, Unicode normalization, controls, URLs, drive paths;
- source/file/package limits;
- required `render` export and disallowed imports;
- PNG/SVG validation and active-content rejection;
- deterministic diagnostics;
- canonical bytes and digest stability;
- package digest remains unchanged when only the requested UI/document locale changes;
- structural package comparison for manifest, source, asset, and digest changes;
- locale-resolved catalog ordering, default/fallback behavior, exact version lookup, and
  missing templates;
- repository create-only semantics, optimistic replace/remove concurrency, and
  validation-before-save.

### 12.2 PDF engine unit/integration tests

- default selection and explicit Editorial Indigo equivalence;
- template resolution failure before document emission;
- manifest design, bound settings, programmatic override, and safety-validation precedence;
- metadata plus resolved values/design/labels/assets Typst encoding;
- missing runtime feature, incompatible Typst version, and missing font fail before compile;
- generic source bundle ordering and namespace collisions;
- runtime/template/content diagnostics remain distinguishable;
- report template identity without setting-value leakage;
- source maps still resolve nested block failures;
- all existing dense-table, mention, image, Mermaid, escaping, and theme tests stay green;
- hardcoding audit detects an undeclared design color/font/label/dimension and accepts only the
  reviewed engine-invariant allowlist.

### 12.3 Compiler and job tests

- arbitrary valid source set mounts correctly;
- missing/duplicate/invalid source path fails;
- template partial imports work inside `/template/`;
- forbidden imports fail with normalized diagnostics;
- job byte quota includes all sources and assets;
- worker restart compiles the stored exact bundle;
- cleanup, timeout, cancellation, failure-between-successes, and no late emission;
- compiler shadow filesystem resets between templates/jobs.

### 12.4 Extension tests

- generated controls and accessible labels/help/errors;
- controls derive from settings/bindings without template-ID conditionals;
- template metadata, groups, settings, help, and options resolve through the host UI locale;
- UI-locale changes preserve selection, values, assets, and active export snapshot;
- default export requires no settings interaction;
- tenant+space isolation;
- per-template values survive reload and switching;
- invalid/stale preferences require reset rather than silent coercion;
- logo upload/replace/remove, type/size/SVG failures;
- template/settings snapshot under concurrent UI changes;
- active-page change cancellation;
- report identity and no sensitive values in errors/logs.

### 12.5 Real compiler and document checks

For each curated template:

- valid PDF parse;
- expected A4/Letter page size, orientation, and margins;
- tags present;
- outline present when enabled and absent/adjusted only when intentionally disabled;
- cover/closing-page/header/footer/page-number policies match the resolved feature model;
- branding, attribution, and localized labels match the resolved locale without stale product
  copy from engine source;
- document-locale changes affect document labels/formatting only, while UI-locale changes do
  not alter fixed render bytes;
- internal/external links preserved;
- exactly required font families/faces are embedded and no fallback substitution occurs;
- typography roles, design tokens, semantic palettes, and component metrics visibly resolve
  from the selected manifest;
- text extraction retains content;
- table headers repeat;
- dense values do not paint across cell boundaries;
- images and Mermaid remain correct;
- fixed inputs compile byte-identically after warm initialization;
- template package digest and report identity match the selected package.

### 12.6 Artifact and privacy gates

- all compiler, font, runtime, template, and template-asset files are local;
- no remote source, font, package, or image loader is introduced;
- extension CSP remains unchanged except for no new permissions;
- browser source scan rejects Node/Bun/Chrome imports in reusable packages;
- extension and harness production artifacts contain the canonical runtime files;
- production source audit finds no Editorial Indigo presentation hardcoding outside its
  manifest and the reviewed engine-invariant allowlist;
- nested-path harness remains functional;
- no network permission is added for template functionality.

---

## 13. Definition of done

- [ ] `wiki.pdf-template/v1` is the only v1 contract identifier in current specs/code.
- [ ] `@atlcli/wiki-pdf-template` exists as a private host-neutral package.
- [ ] Contract parsing, validation, linting, settings/bindings, canonicalization, digest,
      catalog, and repository ports are implemented and documented.
- [ ] Runtime/Typst compatibility, required fonts, page model, document features, branding,
      localization, typography, design tokens, semantic palettes, component metrics, and asset
      slots are required validated manifest areas.
- [ ] Localization is the only source for template name/description, document labels, setting
      group copy, setting labels/help, and choice labels; the fallback locale is complete.
- [ ] Host UI locale and document locale resolve independently without changing stable IDs,
      setting values, or package identity.
- [ ] No package API depends on Chrome, WXT, IndexedDB, DOM, filesystem, or compiler details.
- [ ] Editorial Indigo is a validated built-in package and remains the default.
- [ ] The §9.2 ledger is complete; every Editorial Indigo presentation default has moved out
      of exporter/template hardcoding and into its manifest.
- [ ] Remaining engine constants are restricted to the reviewed §6.8 allowlist with a reason,
      owner, and regression test; the automated hardcoding audit passes.
- [ ] Default output is byte-identical to baseline, or an explicitly reviewed and documented
      baseline transition satisfies Task 7's STOP rule.
- [ ] A second genuinely distinct curated template passes the same semantic fixture suite.
- [ ] Manifest-generated settings work, including safe logo handling.
- [ ] Setting effects use explicit type-checked bindings; no host or template-ID branch
      performs an equivalent hidden override.
- [ ] `PdfSourceBundle` and browser compiler use generic deterministic VFS sources.
- [ ] Extension selection/preferences are host-owned and scoped as ratified in Task 0.
- [ ] Neutral harness proves both templates through real Worker/WASM/fonts.
- [ ] Reports contain contract, template ID/name/version/digest and no sensitive setting values.
- [ ] Existing PDF correctness, theme, dense-table, mention, asset, cancellation, and output
      validation behavior remains green.
- [ ] Full automated gates and user-assisted Chrome E2E pass.
- [ ] Docs and supersession notes are current.
- [ ] No package is published and no release is made automatically.

---

## 14. Risks and STOP conditions

| Risk | Signal | Mitigation / STOP condition |
|---|---|---|
| Contract is merely the old monolith renamed | second template copies runtime helpers or serializer branches by template ID | STOP; move semantics back into engine runtime before continuing |
| Package name leaks into persisted format | manifest/VFS/settings contain `@atlcli` or app names | STOP; keep workspace identity outside contract data |
| Default output drifts | fixture hash or visual/structural output changes in Task 7 | STOP and review exact cause; never refresh golden silently |
| Manifest becomes an untyped dumping ground | arbitrary objects/Typst expressions or duplicated defaults appear | STOP; add a named typed field with bounds and diagnostics, or leave a justified semantic invariant in the engine |
| Engine invariants absorb presentation choices | fonts/colors/spacing/labels remain on allowlist | reject the allowlist entry and move it into the manifest before production migration completes |
| Settings bypass the design contract | UI or template source branches directly on a value | require an allowlisted typed binding and test the resolved design |
| Runtime/font compatibility is discovered at compile time | missing helper or fallback font changes output | fail during preparing against explicit capability/font inventories |
| Localization is incomplete | missing label leaks an engine English literal or empty text | reject built-in manifest; require complete fallback locale and resolution tests |
| Template can shadow runtime/content | path collision reaches compiler | reject during package and bundle validation; defense-in-depth test compiler reset |
| Linter is mistaken for security | regex scan passes unsafe package | validation is authoritative; first slice accepts bundled curated sources only |
| Settings become code injection | hostile string breaks Typst source | use context encoders and compile hostile fixtures; no raw snippets or expressions |
| Template management becomes host-bound | package imports IDB/fs/Chrome/UI | STOP and move adapter outward behind catalog/repository ports |
| Catalog changes make jobs non-deterministic | worker restart resolves newer template | store fully assembled bundle in job; report exact package digest |
| User logo introduces active/network content | SVG contains external refs/scripts | sanitize/reject before persistence and bundle assembly |
| Customization weakens contrast/tags | non-default output fails contrast/tag inspection | resolve manifest tokens first, then enforce engine safety policy; block unsafe setting or template |
| Generic VFS weakens compiler cleanup | source from prior job affects next | reset shadow FS before/after every compile and alternate-template regression |
| Package API is published prematurely | external compatibility obligations appear | keep private; separate publication review required |
| Scope expands into full management/import | archive, remote, marketplace, editor work appears | stop and split a follow-up spec after v1 built-ins prove the contract |

---

## 15. Follow-up boundaries

The following become separate specs after this slice:

1. deterministic folder/archive pack and unpack;
2. developer CLI for init, validate, lint, preview, and pack;
3. third-party package import and isolated compiler-backed preview;
4. local/organization template repositories and management UI;
5. update channels, signatures, trust, and policy;
6. custom fonts plus license evidence;
7. PDF stationery embedding and calibration wizard;
8. additional runtime/component hook versions;
9. public package publication or extraction under a future product namespace.

Each follow-up consumes `wiki.pdf-template/v1` or introduces an explicit new contract. None may
silently reinterpret v1 packages.

---

## 16. Unresolved review questions

These are the decisions to resolve during review or Task 0:

1. **Preference scope:** confirm the recommended local `tenant origin + space key` scope, or
   choose browser-global defaults for the first slice.
2. **Second curated design:** choose the visual direction and final display name. It must be a
   real page/typography alternative, not an accent-color variant.
3. **Initially editable subset:** all current defaults migrate into the manifest; confirm
   whether logo, header/footer text, page size, cover, outline, organization, and accent should
   all receive first-slice `settings`/`bindings`, or whether some remain manifest-owned but not
   yet user-editable.
4. **Legacy compatibility alias:** keep `ATLCLI_TYPST_TEMPLATE` for one repository release
   cycle as deprecated, or remove it immediately after all in-repo consumers migrate.
5. **Unknown manifest fields:** retain the proposed built-in error / development-warning split,
   or reject unknown keys unconditionally from day one.
6. **Initially shipped locales:** recommended baseline is complete English fallback plus a
   complete German bundle for Editorial Indigo; confirm whether the second curated template
   must ship both immediately or only the complete fallback locale.

Recommended defaults are the options stated in the plan. No other blocking architecture
question is known.
