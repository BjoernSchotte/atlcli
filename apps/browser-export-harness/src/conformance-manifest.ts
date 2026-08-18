/**
 * The conformance-case MANIFEST — pure metadata, no DOM and no engine imports,
 * so both the browser app (`app.ts`), the Playwright spec (`exports.e2e.ts`),
 * and the CI drift check (`scripts/assert-case-manifest.ts`) can import it.
 *
 * Spec 011, T4.6 sync point: each feature-lane PR adds exactly ONE entry here
 * plus its own `*-case.ts` and one registry line — it never edits `app.ts`,
 * `index.html`, or `exports.e2e.ts` again. The generic UI/test loops iterate
 * this array, so parallel lanes stop colliding in the same three files.
 *
 * `emitsDigests` marks the cases whose JSON result carries sha256 digests +
 * a report-note projection that `check-parity.ts` compares against the CLI run.
 */
export type ConformanceEngine = "docx" | "pdf";
export type ConformanceMediaPolicy = "raster" | "exact" | "none";

export interface ConformanceCaseMeta {
  /** Stable case id; drives the `run-<id>` / `<id>-state` / `<id>-result` testids. */
  id: string;
  /** Human label for the section heading. */
  title: string;
  /** Which feature-folder tasks this case is the acceptance test for. */
  folderTaskIds: string[];
  engines: ConformanceEngine[];
  mediaPolicy: ConformanceMediaPolicy;
  emitsDigests: boolean;
}

export const CONFORMANCE_MANIFEST: readonly ConformanceCaseMeta[] = [
  {
    id: "activity-monitor",
    title: "Generic-browser Activity and queue monitor (013)",
    folderTaskIds: ["013/T7.7"],
    engines: ["pdf", "docx"],
    mediaPolicy: "none",
    emitsDigests: false,
  },
  {
    id: "asset-spool-recovery",
    title: "Generic-browser checkpointed asset recovery (013)",
    folderTaskIds: ["013/T7.2"],
    engines: ["pdf", "docx"],
    mediaPolicy: "none",
    emitsDigests: false,
  },
  {
    id: "source-spool-recovery",
    title: "Generic-browser ordered source spool recovery (013)",
    folderTaskIds: ["013/T7.2"],
    engines: ["pdf", "docx"],
    mediaPolicy: "none",
    emitsDigests: false,
  },
  {
    id: "pdf-abort",
    title: "PDF abort",
    folderTaskIds: ["harness/pdf-abort"],
    engines: ["pdf"],
    mediaPolicy: "none",
    emitsDigests: false,
  },
  {
    id: "docx",
    title: "DOCX browser contract",
    folderTaskIds: ["harness/docx"],
    engines: ["docx"],
    mediaPolicy: "raster",
    emitsDigests: false,
  },
  {
    id: "docx-job-parity",
    title: "DOCX direct vs background-job parity (013)",
    folderTaskIds: ["013/T7.2"],
    engines: ["docx"],
    mediaPolicy: "exact",
    emitsDigests: false,
  },
  {
    id: "pdf",
    title: "PDF warm-repeat",
    folderTaskIds: ["harness/pdf"],
    engines: ["pdf"],
    mediaPolicy: "none",
    emitsDigests: false,
  },
  {
    id: "pdf-job-parity",
    title: "PDF direct vs background-job parity (013)",
    folderTaskIds: ["013/T7.2"],
    engines: ["pdf"],
    mediaPolicy: "none",
    emitsDigests: false,
  },
  {
    id: "import-pdf",
    title: "PDFium import Worker contract",
    folderTaskIds: ["import-pdf-mvp/PDF-10"],
    engines: ["pdf"],
    mediaPolicy: "none",
    emitsDigests: false,
  },
  {
    id: "pdf-settings",
    title: "PDF settings & watermark (007)",
    folderTaskIds: ["007/T2.1", "007/T2.2", "007/T2.4"],
    engines: ["pdf"],
    mediaPolicy: "none",
    emitsDigests: true,
  },
  {
    id: "pdf-v5",
    title: "Catalog V3 / canonical revision 5 PDF runtime",
    folderTaskIds: ["pdf-template-capabilities-v3/T10"],
    engines: ["pdf"],
    mediaPolicy: "none",
    emitsDigests: true,
  },
  {
    id: "docx-template-intake",
    title: "DOCX to PDF template intake",
    folderTaskIds: ["pdf-template-docx-intake/T10"],
    engines: ["pdf"],
    mediaPolicy: "raster",
    emitsDigests: true,
  },
  {
    id: "blocks",
    title: "Block model (001)",
    folderTaskIds: ["001/T0.1", "001/T0.2"],
    engines: ["pdf", "docx"],
    mediaPolicy: "none",
    emitsDigests: true,
  },
  {
    id: "charts",
    title: "All-shapes TanStack chart export",
    folderTaskIds: ["web-publishing-astro/PLAN-CHART"],
    engines: ["pdf", "docx"],
    mediaPolicy: "raster",
    emitsDigests: false,
  },
  {
    id: "adf-source",
    title: "ADF-primary source to DOCX/PDF",
    folderTaskIds: ["adf-export/WP9"],
    engines: ["pdf", "docx"],
    mediaPolicy: "none",
    emitsDigests: false,
  },
  {
    id: "scope",
    title: "Scope / tree compose (002)",
    folderTaskIds: ["002/T1.1", "002/T1.2", "002/T1.3"],
    engines: ["pdf", "docx"],
    mediaPolicy: "none",
    emitsDigests: true,
  },
  {
    id: "content-compat",
    title: "Content-feature compat (003)",
    folderTaskIds: ["003/T1.4", "003/T1.5", "003/T1.6"],
    engines: ["pdf", "docx"],
    mediaPolicy: "none",
    emitsDigests: true,
  },
  {
    id: "macros",
    title: "Macro renderer registry (004)",
    folderTaskIds: ["004/T1.7", "004/T1.8", "004/T1.9", "004/T1.10"],
    engines: ["pdf", "docx"],
    mediaPolicy: "none",
    emitsDigests: true,
  },
  {
    id: "placeholders",
    title: "Includepage + metadata placeholders (005)",
    folderTaskIds: ["005/T1.11", "005/T1.12"],
    engines: ["docx"],
    mediaPolicy: "none",
    emitsDigests: false,
  },
  {
    id: "docx-quality",
    title: "Word quality: numbering, tblGrid, svgBlip, STYLEREF (006)",
    folderTaskIds: ["006/T1.13", "006/T1.14", "006/T1.15", "006/T1.16"],
    engines: ["docx"],
    mediaPolicy: "raster",
    emitsDigests: false,
  },
  {
    id: "m1",
    title: "M1 acceptance corpus (50-page integrated story)",
    folderTaskIds: ["011/bench-m1"],
    engines: ["pdf", "docx"],
    mediaPolicy: "none",
    emitsDigests: true,
  },
  {
    id: "manuscript",
    title: "Second curated PDF template: Manuscript (012)",
    folderTaskIds: ["012/T6.5"],
    engines: ["pdf"],
    mediaPolicy: "none",
    emitsDigests: true,
  },
];

/**
 * The exact set of conformance-CASE ids registered so far. The drift check
 * (`assert-case-manifest.ts`) fails if the manifest's id set diverges — an
 * unregistered or duplicated case is caught before merge.
 *
 * The general `docx`/`pdf`/`pdf-abort` contracts, the DOCX/PDF job parity gates (013),
 * the `pdf-settings` (007)
 * feature case, and all six feature-lane cases 001–006 (`blocks`, `scope`,
 * `content-compat`, `macros`, `placeholders`, `docx-quality`) have landed now
 * that every feature spec is merged. `manuscript` (012) landed once the second
 * curated template merged; `m1` is the browser leg of the spec 011 M1
 * acceptance corpus. Cases 001–004, 007, `m1` and 012 emit digests consumed by
 * the shape-parity gate; 005/006 are DOCX-only and assert their invariants
 * in-case. Add each new id here in the same PR that adds its case + registry
 * entry.
 */
export const EXPECTED_LANDED_CASE_IDS: readonly string[] = [
  "activity-monitor",
  "asset-spool-recovery",
  "source-spool-recovery",
  "pdf-abort",
  "docx",
  "docx-job-parity",
  "pdf",
  "pdf-job-parity",
  "import-pdf",
  "pdf-settings",
  "pdf-v5",
  "docx-template-intake",
  "blocks",
  "charts",
  "adf-source",
  "scope",
  "content-compat",
  "macros",
  "placeholders",
  "docx-quality",
  "m1",
  "manuscript",
];
