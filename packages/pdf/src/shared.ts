/** Package-private helpers; not part of any export map entry. */

/** Lowercase hex SHA-256 of `bytes` via WebCrypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // A fresh ArrayBuffer-backed copy: a plain `BufferSource` whatever the
  // caller's backing store is.
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("PDF export was cancelled.", "AbortError");
}

/** True for a cancellation error, from either the DOM or Node abort surface. */
export function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}
