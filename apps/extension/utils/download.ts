export interface DownloadOptions {
  name: string;
  bytes: Uint8Array;
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
  const blob = new view.Blob([options.bytes as BlobPart], { type: options.mimeType });
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
