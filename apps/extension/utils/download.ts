export interface DownloadOptions {
  name: string;
  bytes: Uint8Array;
  mimeType: string;
  document?: Document;
}

export function sanitizeDownloadName(title: string, extension: string): string {
  const cleanExtension = extension.replace(/^\.+/, "").toLowerCase();
  const base = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim();
  return `${base || "Confluence export"}.${cleanExtension}`;
}

export async function downloadBytes(options: DownloadOptions): Promise<void> {
  const doc = options.document ?? document;
  const view = doc.defaultView ?? window;
  const blob = new view.Blob([options.bytes as BlobPart], { type: options.mimeType });
  const url = view.URL.createObjectURL(blob);
  try {
    const anchor = doc.createElement("a");
    anchor.href = url;
    anchor.download = options.name;
    doc.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    view.setTimeout(() => view.URL.revokeObjectURL(url), 1_000);
  }
}
