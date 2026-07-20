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
    id: "pdf",
    title: "PDF warm-repeat",
    folderTaskIds: ["harness/pdf"],
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
];

/**
 * The exact set of case ids expected to be registered given the feature folders
 * that have LANDED (001, 002, 003, 004, 007, 008). The drift check
 * (`assert-case-manifest.ts`) fails if the manifest's id set diverges — an
 * unregistered or duplicated case is caught before merge. When a pending
 * folder's case lands (002 `scope`, 003 `content-compat`, 004 `macros`, 001
 * `blocks`, plus the parallel 005 `placeholders` / 006 `docx-quality`), add its
 * id here in the same PR.
 */
export const EXPECTED_LANDED_CASE_IDS: readonly string[] = [
  "pdf-abort",
  "docx",
  "pdf",
  "pdf-settings",
];
