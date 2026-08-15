/**
 * Safe outer-ZIP batch source (specs/import-docx/010-batch-import task 1).
 *
 * Reuses the hardened archive guards from `@atlcli/docx/scan` — entry-name
 * safety (traversal/absolute paths) and the zip-bomb budget run over the
 * central directory BEFORE any member is inflated. Only `*.docx` members
 * are extracted; each still passes through `unzipDocx`'s own package
 * preflight when parsed. Discovery is sorted so a directory tree and its
 * equivalent ZIP produce the same canonical order.
 */
import PizZip from "pizzip";
import {
  DOCX_ARCHIVE_BUDGET,
  assertArchiveBudget,
  assertSafeDocxEntryName,
} from "@atlcli/docx/scan";

export interface BatchZipEntry {
  /** Normalized archive-relative path (forward slashes). */
  path: string;
  bytes: Uint8Array;
}

const MAX_OUTER_ZIP_BYTES = 200 * 1024 * 1024;

/** Extract every `.docx` member of an outer batch ZIP, sorted by path. */
export function extractDocxEntriesFromZip(bytes: Uint8Array): BatchZipEntry[] {
  if (bytes.byteLength > MAX_OUTER_ZIP_BYTES) {
    throw new Error(`Batch ZIP exceeds ${MAX_OUTER_ZIP_BYTES} bytes.`);
  }
  let zip: PizZip;
  try {
    zip = new PizZip(bytes);
  } catch (err) {
    throw new Error(`Not a valid ZIP archive: ${(err as Error).message}`);
  }
  assertArchiveBudget(zip, DOCX_ARCHIVE_BUDGET);

  const entries: BatchZipEntry[] = [];
  for (const [name, file] of Object.entries(zip.files) as Array<
    [string, { dir: boolean; asUint8Array(): Uint8Array }]
  >) {
    if (file.dir) continue;
    assertSafeDocxEntryName(name);
    const normalized = name.replace(/\\/g, "/");
    const base = normalized.slice(normalized.lastIndexOf("/") + 1);
    if (!base.toLowerCase().endsWith(".docx") || base.startsWith("~$")) continue;
    entries.push({ path: normalized, bytes: new Uint8Array(file.asUint8Array()) });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  if (entries.length === 0) throw new Error("Batch ZIP contains no .docx entries.");
  return entries;
}
