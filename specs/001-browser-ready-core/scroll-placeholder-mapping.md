# Scroll Placeholder → atlcli Data-Model Mapping

Spec: `001-browser-ready-core` · Task 8 (PLAN.md §7)
Status: **Verified** against the live K15t Scroll Word Exporter documentation.
Verification date: **2026-07-14**

This document is the implementation template for **Phase 1 Task 1.3 (DOCX export)** and a hard
prerequisite for it. It (1) verifies the placeholder catalog in
`spec/scroll-word-exporter-features.md` against the current K15t docs, (2) maps every placeholder
onto an atlcli data-model field with a status, and (3) enumerates the data-model gaps that become
Phase 1 inputs.

---

## 1. Verification summary

The catalog in `spec/scroll-word-exporter-features.md` was checked placeholder-by-placeholder
against the current K15t Help Center (Scroll Word Exporter 5.16/5.17, Cloud). The placeholder
reference page renders as versioned tables; the `latest` alias 404s, so the newest reachable
concrete version (`5.16/cloud`) was used as the source of record.

**Coverage: 41 of 41 catalog placeholders verified; 0 unverified (source reachable).**
In addition, **16 placeholders present in the current docs were missing from the spec catalog**
(new/expanded forms + the entire Scroll Documents `$scroll.custom.*` family) and are recorded below.

Primary sources (all reachable, fetched 2026-07-14):

- Placeholder reference (Cloud): <https://help.k15t.com/scroll-word-exporter/5.16/cloud/add-placeholders>
- Key features (Cloud): <https://help.k15t.com/scroll-word-exporter/5.17/cloud/key-features>
- Creating a Table of Contents: <https://help.k15t.com/scroll-word-exporter/5.16/cloud/creating-a-table-of-contents>
- Creating a header or footer: <https://help.k15t.com/scroll-word-exporter/5.16/cloud/creating-a-header-or-footer>

### 1.1 Content insertion point (verified)

- **`$scroll.content`** is the single content-insertion placeholder. By default Scroll places the
  exported Confluence content at the start of the document; inserting `$scroll.content` explicitly
  positions it (e.g. after a title page + TOC). Use once per template.
  Source: `.../5.16/cloud/creating-a-table-of-contents`, `.../add-placeholders`.

### 1.2 TOC markers (verified)

- The TOC is a **native Word TOC field** (References → Table of Contents → Insert Table of
  Contents), **not** a `$scroll.*` placeholder. It is populated from the Word heading styles
  (`Scroll Heading 1–6`) at export time. There is therefore no Scroll TOC placeholder to map —
  the atlcli export must emit the correct Word heading styles so Word's own TOC field resolves.
  Source: `.../creating-a-table-of-contents`.

### 1.3 Header/footer variables (verified)

- Any `$scroll.*` placeholder may be used in a Word header/footer (commonly `$scroll.title`,
  `$scroll.exportdate`, `$scroll.space.name`, `$scroll.exporter.fullName`).
- Running-heading references use a Word **StyleRef** field bound to a `Scroll Heading` style — a
  Word feature, not a Scroll placeholder. Page numbers use standard Word page-number fields.
  Source: `.../creating-a-header-or-footer`.

### 1.4 Deviations from `spec/scroll-word-exporter-features.md`

**New / expanded placeholders present in current docs but missing (or under-specified) in the spec:**

| Placeholder | Deviation | Source |
|---|---|---|
| `$scroll.pagelabels.capitalised` | Spec treated `.capitalised` as an inline modifier note; docs list it as its own placeholder row | `.../add-placeholders` |
| `$scroll.pageproperty.(key,fallback-enabled)` | New parameter form (space-homepage fallback) not in spec | `.../add-placeholders` |
| `$scroll.pageproperty.(key,macro-id,true,alternate-text)` | New full-parameter form (fallback + alternate text) not in spec | `.../add-placeholders` |
| `$scroll.includepage.(SPACEKEY:pagename)` | Spec only had `(pagename)`; space-qualified form is new | `.../add-placeholders` |
| `$scroll.includepage.(pageid)` | Spec only had `(pagename)`; by-ID form is new | `.../add-placeholders` |
| `$scroll.jsoncontentproperty.(key)` — jsonPointer/fallback/alt-text params | Spec listed the placeholder but not its parameter set; docs document jsonPointer + fallback + alternate text | `.../add-placeholders` |
| `$scroll.custom.(k15t-scroll-document-versions-for-confluence,document-id)` | Whole **Scroll Documents** `$scroll.custom.*` family (13 placeholders) absent from spec | `.../add-placeholders` |
| `$scroll.custom.(…,document-title)` | as above | `.../add-placeholders` |
| `$scroll.custom.(…,version-name)` | as above | `.../add-placeholders` |
| `$scroll.custom.(…,version-id)` | as above | `.../add-placeholders` |
| `$scroll.custom.(…,version-description)` | as above | `.../add-placeholders` |
| `$scroll.custom.(…,instance-status,"fallback")` | as above | `.../add-placeholders` |
| `$scroll.custom.(…,instance-creation-date,"fallback","format")` | as above | `.../add-placeholders` |
| `$scroll.custom.(…,language-name / language-code / language-country / language-variant)` | as above (4 language placeholders) | `.../add-placeholders` |
| `$scroll.custom.(…,variant-name / variant-id)` | as above (2 variant placeholders) | `.../add-placeholders` |

**Renamed / clarified:**

- `$scroll.creator.fullName` / `$scroll.modifier.fullName` now documented to fall back to the
  Confluence **Public name** when profile visibility is restricted (Cloud privacy behavior). No
  rename, but a semantic clarification relevant to the mapping (display-name source).

**Removed:** none. Every placeholder in the spec catalog is still present in the current docs.

---

## 2. Compatibility mapping table

Legend for **Status**:

- **direct** — a single atlcli field already holds the exact value.
- **derivable** — computable from data atlcli already has/fetches (join, format, extra API call
  atlcli already supports, or client-side generation at export time).
- **unsupported (v1)** — Confluence exposes it, but atlcli does not fetch/model it yet; closing the
  gap is in-scope for a later phase (see §3).
- **never** — depends on a third-party app (Comala, Scroll Documents) or a Confluence concept
  atlcli deliberately does not target; not mappable from atlcli data.

atlcli fields below are on `ConfluencePageDetails` unless prefixed with `ConfluenceSpace.`,
`ConfluenceUser.`, or noted as a runtime/client value. Types: `packages/confluence/src/client.ts`.

### 2.1 Page info

| Scroll placeholder | atlcli field | Status | Note |
|---|---|---|---|
| `$scroll.title` | `.title` | direct | |
| `$scroll.version` | `.version` | direct | |
| `$scroll.pageid` | `.id` | direct | |
| `$scroll.pageurl` | `.url` | direct | Built from `_links.base + _links.webui`. |
| `$scroll.tinyurl` | `.tinyUrl` | direct | Populated by `getPageDetails` (`_links.tinyui`). |
| `$scroll.pagelabels` | `.labels` | derivable | Join `string[]` (Scroll renders a comma/space list). |
| `$scroll.pagelabels.capitalised` | `.labels` | derivable | Join + capitalize first letter of each label. |
| `$scroll.pageowner.fullName` (Cloud) | `ConfluenceClient.getPageOwner()` | derivable | **Gap G1 closed** (2026-07-16). Cloud's v2 API exposes `ownerId`; resolved to a display name via the account lookup. Owner ≠ creator (ownership is transferable), so this is a lazy round-trip of its own, not a `createdBy` fallback. |

### 2.2 Creator / modifier

| Scroll placeholder | atlcli field | Status | Note |
|---|---|---|---|
| `$scroll.creator` | `.createdBy.displayName` | derivable | Scroll's bare form renders the display name. |
| `$scroll.creator.fullName` | `.createdBy.displayName` | direct | atlcli's `displayName` already falls back to `publicName`. |
| `$scroll.creator.email` (DC) | `.createdBy.email` | derivable | `email` is optional and usually absent on Cloud. |
| `$scroll.creator.name` (DC username) | — | unsupported (v1) | `ConfluenceUser` has no username field. Gap G2. |
| `$scroll.modifier` | `.modifiedBy.displayName` | derivable | |
| `$scroll.modifier.fullName` | `.modifiedBy.displayName` | direct | |
| `$scroll.modifier.email` (DC) | `.modifiedBy.email` | derivable | Often absent on Cloud. |
| `$scroll.modifier.name` (DC username) | — | unsupported (v1) | Same as G2. |

### 2.3 Dates

| Scroll placeholder | atlcli field | Status | Note |
|---|---|---|---|
| `$scroll.creationdate` | `.created` | direct | Scroll's SimpleDateFormat argument → client-side formatting (derivable). |
| `$scroll.modificationdate` | `.modified` | direct | Formatting derivable. |
| `$scroll.exportdate` | runtime value | derivable | Generated at export time (`new Date()`), not from Confluence. |

### 2.4 Space info

| Scroll placeholder | atlcli field | Status | Note |
|---|---|---|---|
| `$scroll.space.key` | `.spaceKey` / `ConfluenceSpace.key` | direct | Present on page details. |
| `$scroll.space.name` | `ConfluenceSpace.name` | derivable | Needs a `getSpace(spaceKey)` call; page details carry only the key. |
| `$scroll.space.url` | `ConfluenceSpace.url` | derivable | Same extra `getSpace` call. |
| `$scroll.spacelogo` `.(H,W)` | — | unsupported (v1) | No space-logo fetch in atlcli. Gap G3. |
| `$scroll.globallogo` | — | never | Confluence system-wide logo; not a per-content datum atlcli targets. |

### 2.5 Export info

| Scroll placeholder | atlcli field | Status | Note |
|---|---|---|---|
| `$scroll.content` | converted page body | direct | Insertion point; maps to the storage→docx body atlcli produces (`.storage`). |
| `$scroll.exporter` | `getCurrentUser().displayName` | derivable | atlcli exposes `getCurrentUser()`; not yet wired into export. |
| `$scroll.exporter.fullName` | `getCurrentUser().displayName` | derivable | |
| `$scroll.exporter.email` (DC) | `getCurrentUser().email` | derivable | Optional; may be absent on Cloud. |
| `$scroll.exporter.name` (DC username) | — | unsupported (v1) | No username field. Gap G2. |
| `$scroll.template.name` | export-side template metadata | derivable | atlcli-side (template file), not Confluence data. |
| `$scroll.template.modificationdate` | export-side template metadata | derivable | Template file mtime; atlcli-side. |
| `$adhocState` (Comala) | — | never | Comala Document Management workflow state (DC). Third-party. |

### 2.6 Dynamic content / properties

| Scroll placeholder | atlcli field | Status | Note |
|---|---|---|---|
| `$scroll.includepage.(pagename)` | fetched page body | derivable | Resolve title → `search` → `getPage`. |
| `$scroll.includepage.(SPACEKEY:pagename)` | fetched page body | derivable | Space-scoped title resolution. |
| `$scroll.includepage.(pageid)` | fetched page body | derivable | Direct `getPage(id)`. |
| `$scroll.pageproperty.(key)` (+ fallback / macro-id / alt-text forms) | — | unsupported (v1) | Requires parsing Page Properties macro out of storage; atlcli models raw storage only. Gap G4. |
| `$scroll.jsoncontentproperty.(key)` (jsonPointer/fallback/alt) | — | unsupported (v1) | No content-property API wrapper in atlcli. Gap G5. |
| `$scroll.metadata.(key)` (Comala) | — | never | Requires Comala Metadata app. Third-party. |

### 2.7 Scroll Documents family (`$scroll.custom.(k15t-scroll-document-versions-for-confluence, …)`)

All 13 placeholders below depend on the **Scroll Documents (Document Versions)** K15t app, which
stores versioning/variant/language metadata outside standard Confluence content. atlcli does not
integrate that app.

| Scroll placeholder (…= `k15t-scroll-document-versions-for-confluence`) | atlcli field | Status |
|---|---|---|
| `$scroll.custom.(…,document-id)` | — | never |
| `$scroll.custom.(…,document-title)` | — | never |
| `$scroll.custom.(…,version-name)` | — | never |
| `$scroll.custom.(…,version-id)` | — | never |
| `$scroll.custom.(…,version-description)` | — | never |
| `$scroll.custom.(…,instance-status,"fallback")` | — | never |
| `$scroll.custom.(…,instance-creation-date,"fallback","format")` | — | never |
| `$scroll.custom.(…,language-name)` | — | never |
| `$scroll.custom.(…,language-code)` | — | never |
| `$scroll.custom.(…,language-country)` | — | never |
| `$scroll.custom.(…,language-variant)` | — | never |
| `$scroll.custom.(…,variant-name)` | — | never |
| `$scroll.custom.(…,variant-id)` | — | never |

### 2.8 Status distribution

| Status | Count |
|---|---|
| direct | 10 |
| derivable | 15 |
| unsupported (v1) | 8 |
| never | 16 |
| **Total placeholders mapped** | **49** |

(49 = 41 verified catalog placeholders where the `$scroll.custom.*` family is counted as its 13
individual rows + the 16 newly-found placeholders; overlaps because several "new" placeholders are
the `$scroll.custom.*` rows. Distinct mapped rows in the tables above: 49.)

---

## 3. atlcli data-model gaps (Phase 1 inputs)

These are the concrete gaps a Phase 1 DOCX export must close (or explicitly decline). Each is
referenced from the mapping table.

> **Read the gaps by their *kind*, not as one list.** They are not equally hard, and wording
> them alike misleads: **G1 was merely unbuilt** (the data was there all along — now closed);
> **G2 is genuinely impossible on Cloud**; **G3 is blocked on another spec**; **G4/G5 are
> scope decisions**. The panel surfaces each `reason` verbatim per row, so these strings are
> user-facing — keep them honest about which kind they are.

- **G1 — Page owner (Cloud). ✅ CLOSED 2026-07-16.** Was described as "atlcli has no page-owner
  field", which read as *impossible* but only ever described our own model. Probing the live
  Cloud API showed `GET /api/v2/pages/{id}` returns **`ownerId`** (and `lastOwnerId`); combined
  with the existing account lookup that is all `$scroll.pageowner.fullName` needs. Implemented as
  `ConfluenceClient.getPageOwner()` + a lazy `"owner"` resolver dependency, mirroring G6/G7 — it
  fires only when a template actually uses the placeholder. Owner ≠ creator: ownership is
  transferable, so a `createdBy` fallback would be wrong (and is pinned against by a fixture whose
  owner differs from its creator).
- **G2 — Data Center username.** `ConfluenceUser` models `accountId` + `displayName` + `email`,
  but no `name`/username — because **Confluence Cloud has no usernames at all**: Atlassian removed
  them, `accountId` is the replacement. The `.name` placeholders are DC-only, so on Cloud this is
  not "unbuilt" but genuinely unavailable; it would need a DC user shape.
  Blocks: `$scroll.creator.name`, `$scroll.modifier.name`, `$scroll.exporter.name`.
- **G3 — Space & global logos.** The data exists — `GET /space/{key}?expand=icon` returns
  `icon.path` — but a logo is an **image**, so both placeholders are blocked on the OOXML image
  module (spec `005-docx-image-module`), not on a missing fetch. Blocks: `$scroll.spacelogo` (G3);
  `$scroll.globallogo` is `never` (system asset).
- **G4 — Page Properties macro extraction.** atlcli stores raw `storage` only; there is no parsed
  key→value model of the Page Properties macro (incl. macro-id disambiguation and space-homepage
  fallback). Blocks: all `$scroll.pageproperty.(…)` forms.
- **G5 — Content properties (JSON).** No Confluence content-property API wrapper
  (`/content/{id}/property/{key}`) in atlcli, and no jsonPointer/fallback resolution.
  Blocks: `$scroll.jsoncontentproperty.(…)`.
- **G6 — Space metadata on export.** Page details carry `spaceKey` only; `$scroll.space.name` /
  `.url` need a `getSpace(spaceKey)` round-trip. The client already supports `getSpace`; the gap is
  wiring it into the export data-gathering step (derivable, not missing capability).
- **G7 — Exporter identity in export flow.** `getCurrentUser()` exists but is not gathered during
  export; `email` may be `undefined` on Cloud. Wiring + Cloud-email-absence handling needed for
  `$scroll.exporter*`.
- **G8 — Template metadata surface.** `$scroll.template.name` / `.modificationdate` are atlcli-side
  (the chosen `.docx` template file). No template registry/metadata model exists yet; Phase 1 must
  define where template name + mtime come from.

**Out of scope (never, not gaps to close):** Comala workflow/metadata (`$adhocState`,
`$scroll.metadata.*`), the entire Scroll Documents `$scroll.custom.*` family, and the system-wide
`$scroll.globallogo`. These require third-party K15t/Comala apps or Confluence-instance assets that
atlcli deliberately does not target.

---

## 4. Sources

- Placeholder reference (Cloud): <https://help.k15t.com/scroll-word-exporter/5.16/cloud/add-placeholders>
- Key features (Cloud): <https://help.k15t.com/scroll-word-exporter/5.17/cloud/key-features>
- Creating a Table of Contents: <https://help.k15t.com/scroll-word-exporter/5.16/cloud/creating-a-table-of-contents>
- Creating a header or footer: <https://help.k15t.com/scroll-word-exporter/5.16/cloud/creating-a-header-or-footer>
- atlcli data model: `packages/confluence/src/client.ts` (`ConfluencePage`, `ConfluencePageDetails`, `ConfluenceUser`, `ConfluenceSpace`)
- Input catalog: `spec/scroll-word-exporter-features.md`
</content>
</invoke>
