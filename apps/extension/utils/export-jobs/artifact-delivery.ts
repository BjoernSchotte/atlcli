import { pdfBytesFromBlob, type PdfBytesHandle } from "@atlcli/pdf/browser";

/**
 * Assemble a delivery handle straight from artifact chunks (issue #118
 * Phase 0.5).
 *
 * Every chunk becomes its own `Blob` part immediately, so Chrome moves the
 * bytes out of the V8 heap at chunk granularity: the panel never materializes
 * the whole artifact as one `Uint8Array`, and `downloadBytes` hands the SAME
 * `Blob` to the download anchor instead of building a second copy — the
 * pattern `packages/pdf/src/bytes-handle.ts` measured at +64.0 MiB for a
 * 64 MiB document. The composite `Blob` references its parts without
 * re-copying, so peak panel heap during delivery is one chunk, not one
 * artifact.
 */
export async function collectArtifactHandleV1(
  source: AsyncIterable<Uint8Array>,
  options: {
    mediaType: string;
    expectedByteLength: number;
    signal?: AbortSignal;
  },
): Promise<PdfBytesHandle> {
  const parts: Blob[] = [];
  let byteLength = 0;
  for await (const chunk of source) {
    options.signal?.throwIfAborted();
    byteLength += chunk.byteLength;
    if (byteLength > options.expectedByteLength) {
      throw new Error("Retained artifact exceeds its committed length.");
    }
    parts.push(new Blob([chunk as BlobPart]));
  }
  if (byteLength !== options.expectedByteLength) {
    throw new Error("Retained artifact is truncated.");
  }
  return pdfBytesFromBlob(new Blob(parts, { type: options.mediaType }), {
    mimeType: options.mediaType,
  });
}
