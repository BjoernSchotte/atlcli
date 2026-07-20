/**
 * `.wiki-pdf-template` import validator (spec 007 T2.4).
 *
 * `validatePack` = unpack (structural) + {@link validateManifest} (import gate)
 * + an engine-specific hook. It returns a typed report and throws ONLY on
 * package corruption (an unreadable/oversized/unsafe outer archive — the
 * {@link TemplatePackError}s from `unpack`). Manifest-gate failures and
 * engine-hook problems are surfaced as `issues` with `ok: false`, so a host can
 * present actionable feedback instead of catching exceptions.
 *
 * DOCX policy (deliberately no stricter than the live product,
 * `apps/extension/entrypoints/sidepanel/TemplateSection.tsx`):
 *   - a `DocxError` from `scanTemplate`/`unzipDocx` is fatal → `ok: false`, the
 *     error surfaced in `issues`;
 *   - `never`-classified placeholders are a WARNING, not a rejection;
 *   - a missing `$scroll.content` placeholder is NOT a rejection (the documented
 *     append-before-final-section-break fallback).
 *
 * Typst policy: structural checks only in this folder (compile-against-feature-
 * zoo stays the deferred Level-B follow-up).
 *
 * Browser-safe: imports the narrow `@atlcli/docx/scan` subpath (PizZip + pure
 * OOXML text walk), not the full engine. No `node:`/`bun:` imports.
 */
import { scanTemplate, DocxError, type ScanResult } from "@atlcli/docx/scan";
import {
  validateManifest,
  ManifestValidationError,
  type TemplateManifest,
  type ValidateManifestOptions,
} from "./manifest.js";
import { unpackTemplate } from "./unpack.js";

export type PackIssueSeverity = "error" | "warning";

/** One finding from {@link validatePack}. Errors flip `ok` to false; warnings do not. */
export interface PackIssue {
  severity: PackIssueSeverity;
  /** Stable machine code, e.g. `"docx-scan-failed"`, `"never-placeholders"`, or a manifest reason. */
  code: string;
  message: string;
}

export interface ValidatePackResult {
  ok: boolean;
  /** The gated manifest when it passed the import gate; otherwise undefined. */
  manifest?: TemplateManifest;
  /** The DOCX scan report, when the engine hook ran a scan. */
  scanReport?: ScanResult;
  issues: PackIssue[];
}

export type ValidatePackOptions = ValidateManifestOptions;

/**
 * Validate a `.wiki-pdf-template` archive for import.
 *
 * @throws {TemplatePackError} only on package corruption (from `unpackTemplate`).
 */
export function validatePack(bytes: Uint8Array, options: ValidatePackOptions = {}): ValidatePackResult {
  const unpacked = unpackTemplate(bytes); // throws TemplatePackError on corruption

  const issues: PackIssue[] = [];

  let manifest: TemplateManifest;
  try {
    manifest = validateManifest(unpacked.manifest, options);
  } catch (err) {
    if (err instanceof ManifestValidationError) {
      return {
        ok: false,
        issues: [{ severity: "error", code: err.reason, message: err.message }],
      };
    }
    throw err;
  }

  let scanReport: ScanResult | undefined;
  if (manifest.engine.kind === "docx") {
    const docxBytes = unpacked.files[manifest.engine.entry];
    try {
      scanReport = scanTemplate(docxBytes);
    } catch (err) {
      if (err instanceof DocxError) {
        issues.push({
          severity: "error",
          code: "docx-scan-failed",
          message: `Inner .docx could not be scanned (${err.kind}): ${err.message}`,
        });
        return { ok: false, manifest, issues };
      }
      throw err;
    }
    // never-classified placeholders are a warning, not a rejection.
    if (scanReport.never.length > 0) {
      const names = scanReport.never.map((h) => h.base).join(", ");
      issues.push({
        severity: "warning",
        code: "never-placeholders",
        message: `Template uses ${scanReport.never.length} unsupported placeholder(s) that will render empty: ${names}`,
      });
    }
    // A missing $scroll.content placeholder is intentionally NOT an issue.
  }

  const ok = issues.every((i) => i.severity !== "error");
  return { ok, manifest, scanReport, issues };
}
