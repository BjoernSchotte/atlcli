/**
 * Pure filesystem/path logic for the PDF export command (spec 008 T3.2/T3.3):
 * the strict atomic output sink, filename sanitization, and the `--out-dir`
 * containment guarantee.
 *
 * DELIBERATELY DEPENDENCY-FREE: this module must never import
 * `export-pdf-assets.ts` (or anything else that statically imports the typst
 * wasm / font files) — its tests run on Windows CI where the gitignored
 * `packages/pdf/.fonts/` tree is not materialized, so any transitive
 * `@atlcli/pdf/fonts/*` import would fail at module-resolution time. Only
 * `node:` builtins and a type-only `@atlcli/pdf` import are allowed here
 * (enforced by a static-import scan in `export-pdf-sink.test.ts`).
 */
import { lstat, open, rename, link, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { PdfBytesHandle, PdfOutputSink } from "@atlcli/pdf";

/**
 * A thrown error that maps to a specific usage/config exit (1) — for local input
 * mistakes (bad page ref, sink containment/clobber) that are not remote errors.
 */
export class PdfUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfUsageError";
  }
}

/**
 * The strict PDF filesystem sink (T3.2). Deliberately stricter than the DOCX
 * `fileOutputSink`, which writes directly:
 *   - temp file created exclusively (`wx`) with a random suffix (collision-safe
 *     under concurrent invocations) and 0600 perms, in the SAME directory so the
 *     commit never crosses a filesystem boundary;
 *   - refuses to commit through a symlink, directory, or special file at the
 *     target path;
 *   - commits via an atomic no-replace primitive (`link` + `unlink`), so two
 *     racing writers never clobber each other — the loser fails cleanly;
 *   - `force` overwrites ONLY a pre-existing regular file (never a symlink or
 *     directory), via an atomic replacing `rename`;
 *   - the temp file is always removed in a `finally` on failure, so a
 *     killed/failed export never leaves a partial file for a CI artifact step.
 */
export function filePdfOutputSink(targetPath: string, opts: { force?: boolean } = {}): PdfOutputSink {
  return {
    async emit(
      _name: string,
      source: PdfBytesHandle,
      context?: { signal?: AbortSignal }
    ): Promise<void> {
      context?.signal?.throwIfAborted();
      // For the default array-backed handle this is the compiler's own buffer,
      // not a copy (spec 010, T5.6).
      const bytes = await source.asUint8Array();
      const path = resolve(targetPath);
      const dir = dirname(path);

      // Inspect any existing target WITHOUT following symlinks.
      let existing: Awaited<ReturnType<typeof lstat>> | null = null;
      try {
        existing = await lstat(path);
      } catch {
        existing = null;
      }
      if (existing) {
        if (existing.isSymbolicLink()) {
          throw new PdfUsageError(`Refusing to write through a symlink at ${path}.`);
        }
        if (existing.isDirectory()) {
          throw new PdfUsageError(`Output path ${path} is a directory.`);
        }
        if (!existing.isFile()) {
          throw new PdfUsageError(`Output path ${path} is not a regular file.`);
        }
        if (!opts.force) {
          throw new PdfUsageError(`Output file already exists: ${path} (use --force to overwrite).`);
        }
      }

      const unique = `${process.pid.toString(36)}${Date.now().toString(36)}${Math.random()
        .toString(36)
        .slice(2)}`;
      const tmp = join(dir, `.${basename(path)}.${unique}.tmp`);
      const handle = await open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.close();
        context?.signal?.throwIfAborted();
        if (existing && opts.force) {
          // Overwrite an existing regular file atomically.
          await rename(tmp, path);
        } else {
          // No-replace commit: link fails with EEXIST if someone raced us, so
          // no-clobber holds under concurrency. Then drop the temp name.
          await link(tmp, path);
          await unlink(tmp);
        }
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(tmp).catch(() => {});
        throw error;
      }
    },
  };
}

/**
 * Reduce ONE filename component to a safe charset (spec 008 review, path-escape
 * hardening). Every derived-name input — pageId, spaceKey, title — goes through
 * this: anything outside `[a-z0-9_-]` (incl. `/`, `\\`, `..`, NUL, drive
 * colons) collapses to `-`, leading/trailing dashes are stripped, and an empty
 * or fully-hostile input degrades to `"export"` rather than an empty segment.
 */
export function sanitizePathComponent(input: string, maxLength = 60): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/^-+|-+$/g, "");
  if (!cleaned) return "export";
  // Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) are
  // invalid filenames even with an extension — prefix rather than reject.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(cleaned)) return `x-${cleaned}`;
  return cleaned;
}

/**
 * Derive the `--out-dir` output path with a containment guarantee: every name
 * component is sanitized (no separators, no dot-dot, no drive/UNC forms
 * survive), and the resolved result is asserted to live strictly inside the
 * resolved `outDir` before any file creation. Throws {@link PdfUsageError} on
 * violation — defense in depth; sanitization alone should already prevent it.
 */
export function derivePdfOutputPath(outDir: string, key: string, title: string): string {
  const safeKey = sanitizePathComponent(key, 40);
  const safeSlug = sanitizePathComponent(title, 60);
  const filename = `${safeKey}${safeSlug !== "export" ? `-${safeSlug}` : ""}.pdf`;
  const root = resolve(outDir);
  const candidate = resolve(root, filename);
  if (candidate !== join(root, filename) || !candidate.startsWith(root + sep)) {
    throw new PdfUsageError(`Derived output name escapes --out-dir: ${filename}`);
  }
  return candidate;
}
