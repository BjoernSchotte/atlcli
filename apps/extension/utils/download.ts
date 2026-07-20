import { isPdfBytesHandle, type PdfBytesHandle } from "@atlcli/pdf/browser";

export interface DownloadOptions {
  name: string;
  /**
   * The document to download.
   *
   * A {@link PdfBytesHandle} is preferred (spec 010, T5.6): the handle owns one
   * `Blob` and memoizes it, so a PDF that was already turned into a `Blob`
   * elsewhere — the preview cache, a retained background job — is downloaded
   * without a second full-size copy being built here. Measured cost of the copy
   * this avoids (`packages/pdf/scripts/bytes-memory.bench.ts`): **+32.0 MiB for
   * a 32 MiB PDF, +64.0 MiB for a 64 MiB one**, live while the caller's array is
   * still reachable.
   *
   * `Uint8Array` stays accepted because the DOCX path has no handle: its engine
   * emits a plain array, and inventing a handle there would be a change to a
   * second engine for no measured gain.
   */
  bytes: Uint8Array | PdfBytesHandle;
  mimeType: string;
  document?: Document;
  signal?: AbortSignal;
}

export function sanitizeDownloadName(title: string, extension: string): string {
  const cleanExtension = extension.replace(/^\.+/, "").toLowerCase();
  const base = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim();
  return `${base || "Confluence export"}.${cleanExtension}`;
}

export async function downloadBytes(options: DownloadOptions): Promise<void> {
  throwIfAborted(options.signal);
  const doc = options.document ?? document;
  const view = doc.defaultView ?? window;
  // A handle hands back the Blob it already owns; only a raw array needs one
  // built here.
  const blob = isPdfBytesHandle(options.bytes)
    ? await options.bytes.asBlob()
    : new view.Blob([options.bytes as BlobPart], { type: options.mimeType });
  throwIfAborted(options.signal);
  const url = view.URL.createObjectURL(blob);
  let anchor: HTMLAnchorElement | undefined;
  try {
    anchor = doc.createElement("a");
    anchor.href = url;
    anchor.download = options.name;
    doc.body.appendChild(anchor);
    throwIfAborted(options.signal);
    anchor.click();
  } finally {
    anchor?.remove();
    view.setTimeout(() => view.URL.revokeObjectURL(url), 1_000);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Export was cancelled.", "AbortError");
}
