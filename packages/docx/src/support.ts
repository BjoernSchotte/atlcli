/** Small runtime helpers shared across the DOCX engine's modules. */

/** Lowercase hex SHA-256 of `bytes` (WebCrypto; never aliases the caller's buffer view). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const source =
    bytes.buffer instanceof ArrayBuffer
    && bytes.byteOffset === 0
    && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The signal's own reason, or an `AbortError` carrying `message` when it has none. */
export function abortReason(signal: AbortSignal, message: string): unknown {
  return signal.reason ?? new DOMException(message, "AbortError");
}

/** Throw the abort reason when `signal` is already aborted. */
export function throwIfAborted(signal: AbortSignal | undefined, message = "DOCX export was cancelled."): void {
  if (signal?.aborted) throw abortReason(signal, message);
}
