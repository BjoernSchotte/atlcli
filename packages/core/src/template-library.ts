/**
 * Host-neutral template library (spec 007 T2.4).
 *
 * A tiny, browser-safe abstraction shared by every host (CLI, extension,
 * further hosts) for resolving and integrity-checking uploaded PDF/DOCX
 * templates. It owns exactly three concerns:
 *
 *  1. `resolveTemplate` — a pure, engine-aware, conflict-checked two-level
 *     lookup (space-scoped entry beats global entry of the same id).
 *  2. `sha256Hex` / `verifyTemplateBytes` — WebCrypto integrity helpers.
 *  3. `resolveAndLoadTemplate` — the single convenience path that performs
 *     selection + declared-size check + byte loading + verification as one
 *     inseparable call so a host adapter cannot hand unverified bytes to a
 *     caller by construction.
 *
 * Storage adapters (IndexedDB, `~/.atlcli/templates/`, attachment-backed) are
 * host code and live with their hosts — this module never touches IO beyond
 * the `TemplateLibrary` port it is handed.
 *
 * Browser-safety: this file is exported from both `index.ts` and
 * `index.browser.ts` and MUST NOT import any `node:`/`bun:` module. `crypto`
 * is the Web Crypto global (available in browsers, Bun, and Node >= 18).
 *
 * Scan verdicts for DOCX templates (see `@atlcli/template-pack` `validatePack`
 * / `@atlcli/docx` `scanTemplate`) are **never** persisted on a
 * {@link TemplateLibraryEntry}. A scan is always re-derived from the bytes at
 * the point of use, so a persisted verdict can never drift from the bytes it
 * once described.
 */

/** One catalog entry describing a stored template, without its bytes. */
export interface TemplateLibraryEntry {
  /** Stable identifier a host references, e.g. `"com.acme.tech-doc"`. */
  id: string;
  /** Human-facing label for pickers. */
  displayName: string;
  /** Which engine the template targets. A wrong-engine entry never resolves. */
  engine: "docx" | "typst";
  /** `"global"` (whole instance) or `"space"` (one Confluence space). */
  scope: "global" | "space";
  /** Required when `scope === "space"`; the space the entry is scoped to. */
  spaceKey?: string;
  /**
   * Lowercase hex SHA-256 of the **delivered archive bytes as stored** — the
   * integrity check on download. This is a different quantity from a
   * template-pack manifest's `provenance.payloadSha256` (which digests the
   * archive's *payload members*, not the archive bytes); see
   * `@atlcli/template-pack` `pack.ts` for that distinction.
   */
  sha256: string;
  /** Declared byte length of the delivered archive; cross-checked on load. */
  size: number;
  /** ISO-8601 upload timestamp. */
  uploadedAt: string;
}

/**
 * Host-provided storage port. Implementers own persistence; the library owns
 * resolution and verification.
 */
export interface TemplateLibrary {
  /**
   * All entries for `engine`, optionally including the `spaceKey` overrides a
   * caller may resolve against. Implementers may return a superset (e.g. all
   * spaces) — {@link resolveTemplate} filters defensively.
   */
  list(
    engine: TemplateLibraryEntry["engine"],
    spaceKey?: string
  ): Promise<TemplateLibraryEntry[]>;
  /**
   * Load the raw archive bytes for `entry`. Contract obligation: the returned
   * bytes MUST match `entry.sha256` — but a host cannot be trusted to have
   * wired that check, which is exactly why {@link resolveAndLoadTemplate}
   * re-verifies unconditionally.
   */
  getBytes(entry: TemplateLibraryEntry): Promise<Uint8Array>;
}

/**
 * Thrown when two entries could each legitimately win the same lookup — same
 * engine + same id + same resolvable scope bucket (both global, or both
 * scoped to the requested space). This is a data-integrity bug in the library
 * contents, not an ordering question, so it is surfaced rather than silently
 * resolved to the first array match.
 */
export class TemplateResolutionConflictError extends Error {
  constructor(
    readonly id: string,
    readonly engine: TemplateLibraryEntry["engine"],
    readonly scope: TemplateLibraryEntry["scope"],
    readonly spaceKey: string | undefined,
    readonly count: number
  ) {
    super(
      `Ambiguous template "${id}" (${engine}): ${count} ${scope} entries` +
        (scope === "space" ? ` for space "${spaceKey}"` : "") +
        ` share the same id — remove the duplicate.`
    );
    this.name = "TemplateResolutionConflictError";
  }
}

/** Thrown when a resolved template id has no matching entry. */
export class TemplateNotFoundError extends Error {
  constructor(
    readonly id: string,
    readonly engine: TemplateLibraryEntry["engine"],
    readonly spaceKey: string | undefined
  ) {
    super(
      `No ${engine} template "${id}"` +
        (spaceKey ? ` for space "${spaceKey}"` : "") +
        " found in the library."
    );
    this.name = "TemplateNotFoundError";
  }
}

/**
 * Thrown when loaded bytes do not match an entry's declared integrity — a
 * length or SHA-256 disagreement. The template was modified (or corrupted) in
 * storage and must be re-uploaded; there is deliberately no silent fallback.
 */
export class TemplateIntegrityError extends Error {
  constructor(
    readonly id: string,
    readonly kind: "size" | "sha256",
    readonly expected: string,
    readonly actual: string
  ) {
    super(
      `Template "${id}" failed its ${kind} check (expected ${expected}, ` +
        `got ${actual}) — template was modified, re-upload.`
    );
    this.name = "TemplateIntegrityError";
  }
}

/**
 * Pure two-level resolver. Selects the entry a host should load for
 * `(id, engine, spaceKey)`:
 *
 *  - Only entries whose `engine` matches are ever considered, so a mixed-engine
 *    `entries` array (stale cache, accidental concat) can never resolve a
 *    wrong-engine entry — even when it is the only id match.
 *  - A space-scoped entry for the requested `spaceKey` beats the global entry
 *    of the same id; the global entry is the fallback when the space has no
 *    override.
 *
 * Conflicts are checked per resolvable bucket: more than one global entry, or
 * more than one space entry for the requested `spaceKey`, sharing an id is a
 * {@link TemplateResolutionConflictError}. (Two space entries for *different*
 * spaces are not a conflict — they never compete.)
 *
 * @returns the winning entry, or `undefined` when no entry matches.
 * @throws {TemplateResolutionConflictError} on an ambiguous bucket.
 */
export function resolveTemplate(
  entries: TemplateLibraryEntry[],
  id: string,
  engine: TemplateLibraryEntry["engine"],
  spaceKey?: string
): TemplateLibraryEntry | undefined {
  const matching = entries.filter((e) => e.id === id && e.engine === engine);

  const globals = matching.filter((e) => e.scope === "global");
  const spaced =
    spaceKey === undefined
      ? []
      : matching.filter((e) => e.scope === "space" && e.spaceKey === spaceKey);

  if (spaced.length > 1) {
    throw new TemplateResolutionConflictError(id, engine, "space", spaceKey, spaced.length);
  }
  if (globals.length > 1) {
    throw new TemplateResolutionConflictError(id, engine, "global", undefined, globals.length);
  }

  return spaced[0] ?? globals[0];
}

/** Lowercase hex SHA-256 of `bytes` via WebCrypto (`crypto.subtle.digest`). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh, ArrayBuffer-backed view so the digest input is a plain
  // `BufferSource` regardless of the caller's backing store (e.g. a subarray
  // over a SharedArrayBuffer).
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verify that `bytes` hash to `entry.sha256`. Throws a typed
 * {@link TemplateIntegrityError} on mismatch — never a silent fallback.
 */
export async function verifyTemplateBytes(
  entry: TemplateLibraryEntry,
  bytes: Uint8Array
): Promise<void> {
  const actual = await sha256Hex(bytes);
  if (actual.toLowerCase() !== entry.sha256.toLowerCase()) {
    throw new TemplateIntegrityError(entry.id, "sha256", entry.sha256, actual);
  }
}

/**
 * The single public "select and load verified bytes" path. Performs selection,
 * the entry's declared-`size` check, byte loading via `library.getBytes`, and
 * hash verification as one inseparable call, so unverified bytes are never
 * exposed to the caller: if any check fails the function rejects and returns
 * nothing.
 *
 * @throws {TemplateNotFoundError} when no entry matches.
 * @throws {TemplateResolutionConflictError} on an ambiguous bucket.
 * @throws {TemplateIntegrityError} on a size or SHA-256 mismatch.
 */
export async function resolveAndLoadTemplate(
  library: TemplateLibrary,
  id: string,
  engine: TemplateLibraryEntry["engine"],
  spaceKey?: string
): Promise<{ entry: TemplateLibraryEntry; bytes: Uint8Array }> {
  const entries = await library.list(engine, spaceKey);
  const entry = resolveTemplate(entries, id, engine, spaceKey);
  if (!entry) throw new TemplateNotFoundError(id, engine, spaceKey);

  const bytes = await library.getBytes(entry);
  if (bytes.byteLength !== entry.size) {
    throw new TemplateIntegrityError(
      entry.id,
      "size",
      String(entry.size),
      String(bytes.byteLength)
    );
  }
  await verifyTemplateBytes(entry, bytes);
  return { entry, bytes };
}
