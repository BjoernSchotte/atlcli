/**
 * Shared digest + report-projection helpers for the feature-lane conformance
 * cases (spec 011). A case that emits digests exposes `{ compilerVersion,
 * digests, reportNotes }` in its JSON result; the Playwright run collects them
 * into `test-results/digests.json` and `check-parity.ts` compares them against
 * the identical Bun/CLI run (byte + report parity).
 */

/** SHA-256 hex of the exact output bytes (crypto.subtle in the browser host). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface ReportNoteProjection {
  code: string;
  severity: string;
}

/**
 * Canonical projection of an engine report's notes: code + severity only (drops
 * timing and host-specific free text). Matches `parity-compare.ts`'s
 * `projectNotes` input shape so the CLI side compares identically.
 */
export function projectReportNotes(
  notes: ReadonlyArray<{ code: string; level?: string; severity?: string }>,
): ReportNoteProjection[] {
  return notes.map((n) => ({ code: n.code, severity: n.severity ?? n.level ?? "info" }));
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
