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
  type ArchiveBudget,
} from "@atlcli/docx/scan";

export interface BatchZipEntry {
  /** Normalized archive-relative path (forward slashes). */
  path: string;
  bytes: Uint8Array;
}

const MAX_OUTER_ZIP_BYTES = 200 * 1024 * 1024;

/**
 * Budget for the OUTER batch archive. `DOCX_ARCHIVE_BUDGET` is sized for one
 * 20 MB document (128 MiB inflated) and rejects an ordinary batch: DOCX
 * members are already compressed, so a 200 MB batch declares about 200 MB.
 * 512 MiB leaves headroom over the compressed cap and still stops a bomb.
 */
const BATCH_ZIP_BUDGET: ArchiveBudget = {
  ...DOCX_ARCHIVE_BUDGET,
  maxEntryCount: 10_000,
  maxUncompressedBytes: 512 * 1024 * 1024,
};

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
  assertArchiveBudget(zip, BATCH_ZIP_BUDGET);

  const entries: BatchZipEntry[] = [];
  for (const [name, file] of Object.entries(zip.files) as Array<
    [string, { dir: boolean; asUint8Array(): Uint8Array }]
  >) {
    if (file.dir) continue;
    assertSafeDocxEntryName(name);
    const normalized = name.replace(/\\/g, "/");
    const base = normalized.slice(normalized.lastIndexOf("/") + 1);
    // macOS archives carry an AppleDouble twin (`__MACOSX/…/._name.docx`) per
    // file: resource-fork metadata, not a document.
    if (base.startsWith("._") || normalized.split("/").includes("__MACOSX")) continue;
    if (!base.toLowerCase().endsWith(".docx") || base.startsWith("~$")) continue;
    entries.push({ path: normalized, bytes: new Uint8Array(file.asUint8Array()) });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  if (entries.length === 0) throw new Error("Batch ZIP contains no .docx entries.");
  return entries;
}
