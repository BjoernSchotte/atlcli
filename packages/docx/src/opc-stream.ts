import type PizZip from "pizzip";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";

const ZIP32_MAX = 0xffff_ffff;
const ZIP_ENTRY_COUNT_MAX = 4096;
const ZIP_SINGLE_ENTRY_MAX_BYTES = 256 * 1024 * 1024;
const ZIP_TOTAL_UNCOMPRESSED_MAX_BYTES = 512 * 1024 * 1024;
const ZIP_OUTPUT_MAX_BYTES = 512 * 1024 * 1024;
export const DOCX_ZIP_INPUT_CHUNK_BYTES = 64 * 1024;

const EMPTY_BYTES = new Uint8Array();
const PRECOMPRESSED_RASTER_RE = /\.(?:gif|jpe?g|png)$/i;

export interface DocxZipTextSpanV1 {
  value: string;
  start: number;
  end: number;
}

export interface DocxZipPartFragmentsV1 {
  path: string;
  /**
   * Ordered UTF-8 fragments for one replacement part. Keeping the body as its
   * own fragment is what prevents prefix + body + suffix from becoming another
   * complete body-sized string.
   */
  fragments: readonly (string | DocxZipTextSpanV1)[];
}

export interface DocxZipPartSourceV1 {
  /** Exact uncompressed bytes expected from `chunks`. */
  byteLength: number;
  chunks: AsyncIterable<Uint8Array>;
}

export interface StreamDocxOpcOptionsV1 {
  signal?: AbortSignal;
  replacement?: DocxZipPartFragmentsV1;
  /** Deferred binary/text parts, keyed by their existing placeholder entry. */
  partSources?: ReadonlyMap<string, DocxZipPartSourceV1>;
}

/**
 * Structural subset shared by the package and extension PizZip declarations.
 * The extension owns a narrower ambient declaration, so keep the streaming
 * implementation independent of declaration-merging order.
 */
interface DocxZipEntry {
  asUint8Array(): Uint8Array;
  name: string;
  dir: boolean;
  date: Date;
  comment?: string;
  dosPermissions?: number;
  options: {
    compression?: "STORE" | "DEFLATE";
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("DOCX packaging was cancelled.", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** PNG/JPEG/GIF already carry compressed payloads and should use ZIP STORE. */
export function isPrecompressedRasterPart(path: string): boolean {
  return PRECOMPRESSED_RASTER_RE.test(path);
}

/**
 * PizZip forgets a file's original compression choice after reopening an
 * archive and a later global `compression: "DEFLATE"` recompresses everything.
 * Reassert STORE immediately before every PizZip generation boundary.
 */
export function applyDocxZipCompressionPolicy(zip: PizZip): void {
  const entries = zip.files as unknown as Record<string, DocxZipEntry>;
  for (const [path, entry] of Object.entries(entries)) {
    if (!entry.dir && isPrecompressedRasterPart(path)) {
      entry.options.compression = "STORE";
    }
  }
}

function utf8Chunks(
  value: string,
  start = 0,
  endLimit = value.length,
): Iterable<Uint8Array> {
  const encoder = new TextEncoder();
  return {
    *[Symbol.iterator](): Iterator<Uint8Array> {
      for (let offset = start; offset < endLimit;) {
        let end = Math.min(offset + DOCX_ZIP_INPUT_CHUNK_BYTES, endLimit);
        // Do not split a UTF-16 surrogate pair between TextEncoder calls.
        if (
          end < endLimit &&
          end > offset &&
          value.charCodeAt(end - 1) >= 0xd800 &&
          value.charCodeAt(end - 1) <= 0xdbff
        ) {
          end += 1;
        }
        yield encoder.encode(value.slice(offset, end));
        offset = end;
      }
    },
  };
}

function byteChunks(bytes: Uint8Array): Iterable<Uint8Array> {
  return {
    *[Symbol.iterator](): Iterator<Uint8Array> {
      for (let offset = 0; offset < bytes.byteLength; offset += DOCX_ZIP_INPUT_CHUNK_BYTES) {
        yield bytes.subarray(
          offset,
          Math.min(offset + DOCX_ZIP_INPUT_CHUNK_BYTES, bytes.byteLength),
        );
      }
    },
  };
}

async function* boundedSourceChunks(
  source: AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError("A deferred DOCX part yielded a non-Uint8Array chunk.");
    }
    for (let offset = 0; offset < chunk.byteLength; offset += DOCX_ZIP_INPUT_CHUNK_BYTES) {
      yield chunk.subarray(
        offset,
        Math.min(offset + DOCX_ZIP_INPUT_CHUNK_BYTES, chunk.byteLength),
      );
    }
  }
}

function partChunks(
  entry: DocxZipEntry,
  replacement: DocxZipPartFragmentsV1 | undefined,
): Iterable<Uint8Array> {
  if (!replacement) return byteChunks(entry.asUint8Array());
  return {
    *[Symbol.iterator](): Iterator<Uint8Array> {
      for (const fragment of replacement.fragments) {
        if (typeof fragment === "string") yield* utf8Chunks(fragment);
        else yield* utf8Chunks(fragment.value, fragment.start, fragment.end);
      }
    },
  };
}

function compressionStream(path: string): ZipPassThrough | ZipDeflate {
  return isPrecompressedRasterPart(path)
    ? new ZipPassThrough(path)
    : new ZipDeflate(path, { level: 1 });
}

function applyEntryMetadata(
  stream: ZipPassThrough | ZipDeflate,
  entry: DocxZipEntry,
): void {
  stream.mtime = entry.date;
  stream.os = 0;
  if (entry.dir) stream.attrs = 0x10;
  else if (Number.isSafeInteger(entry.dosPermissions)) stream.attrs = entry.dosPermissions;
  if (entry.comment) stream.comment = entry.comment;
}

/**
 * Emit a deterministic browser-safe OPC ZIP as bounded chunks.
 *
 * fflate's streaming ZIP API writes data descriptors and the final Central
 * Directory. ZIP64 is deliberately unnecessary: the stricter DOCX budgets
 * below reject an entry, archive, or output long before ZIP32's 4 GiB limit.
 */
export async function* streamDocxOpc(
  zipArchive: PizZip,
  options: StreamDocxOpcOptionsV1 = {},
): AsyncIterable<Uint8Array> {
  throwIfAborted(options.signal);
  const entries = Object.entries(
    zipArchive.files as unknown as Record<string, DocxZipEntry>,
  );
  if (entries.length === 0 || entries.length > ZIP_ENTRY_COUNT_MAX) {
    throw new RangeError(`DOCX ZIP entry count must be between 1 and ${ZIP_ENTRY_COUNT_MAX}.`);
  }
  const replacementEntry = options.replacement
    ? zipArchive.file(options.replacement.path) as unknown as DocxZipEntry | null
    : undefined;
  if (options.replacement && (!replacementEntry || replacementEntry.dir)) {
    throw new Error(`DOCX streaming replacement part is missing: ${options.replacement.path}`);
  }
  for (const [path, source] of options.partSources ?? []) {
    const entry = entries.find(([entryPath]) => entryPath === path)?.[1];
    if (!entry || entry.dir) {
      throw new Error(`DOCX deferred part is missing its placeholder entry: ${path}`);
    }
    if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 0) {
      throw new RangeError(`DOCX deferred part has an invalid byte length: ${path}`);
    }
  }

  const pending: Uint8Array[] = [];
  let streamError: unknown;
  let finalSeen = false;
  let outputBytes = 0;
  let totalUncompressedBytes = 0;
  const writer = new Zip((error, chunk, final) => {
    if (error) {
      streamError = error;
      return;
    }
    if (chunk.byteLength > 0) pending.push(chunk);
    if (final) finalSeen = true;
  });

  const drain = async function* (): AsyncIterable<Uint8Array> {
    if (streamError) throw streamError;
    while (pending.length > 0) {
      throwIfAborted(options.signal);
      const chunk = pending.shift()!;
      outputBytes += chunk.byteLength;
      if (!Number.isSafeInteger(outputBytes) || outputBytes > ZIP_OUTPUT_MAX_BYTES) {
        throw new RangeError(`DOCX ZIP output exceeds ${ZIP_OUTPUT_MAX_BYTES} bytes.`);
      }
      yield chunk;
    }
    if (streamError) throw streamError;
  };

  try {
    for (const [path, entry] of entries) {
      throwIfAborted(options.signal);
      if (new TextEncoder().encode(path).byteLength > 0xffff) {
        throw new RangeError(`DOCX ZIP entry name is too long: ${path}`);
      }
      const file = entry.dir ? new ZipPassThrough(path) : compressionStream(path);
      applyEntryMetadata(file, entry);
      writer.add(file);
      yield* drain();

      let entryBytes = 0;
      const replacement =
        options.replacement?.path === path ? options.replacement : undefined;
      const deferred = options.partSources?.get(path);
      const chunks = entry.dir
        ? [EMPTY_BYTES]
        : deferred
          ? boundedSourceChunks(deferred.chunks)
          : partChunks(entry, replacement);
      for await (const chunk of chunks) {
        throwIfAborted(options.signal);
        entryBytes += chunk.byteLength;
        totalUncompressedBytes += chunk.byteLength;
        if (
          !Number.isSafeInteger(entryBytes) ||
          entryBytes > ZIP_SINGLE_ENTRY_MAX_BYTES ||
          !Number.isSafeInteger(totalUncompressedBytes) ||
          totalUncompressedBytes > ZIP_TOTAL_UNCOMPRESSED_MAX_BYTES ||
          entryBytes > ZIP32_MAX ||
          totalUncompressedBytes > ZIP32_MAX
        ) {
          throw new RangeError("DOCX ZIP exceeds its validated non-Zip64 size bounds.");
        }
        if (chunk.byteLength > 0) {
          file.push(chunk);
          yield* drain();
        }
      }
      if (deferred && entryBytes !== deferred.byteLength) {
        throw new Error(
          `DOCX deferred part length changed (${path}: ${entryBytes} != ${deferred.byteLength}).`,
        );
      }
      file.push(EMPTY_BYTES, true);
      yield* drain();
    }

    writer.end();
    yield* drain();
    if (!finalSeen) throw new Error("DOCX ZIP writer ended without a final Central Directory.");
  } finally {
    pending.length = 0;
    writer.terminate();
  }
}
