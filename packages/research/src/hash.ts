/**
 * Package-private digest helpers; not exported from any entrypoint.
 *
 * The FNV-1a fingerprints are correlation IDs, never a security boundary.
 * Two encodings exist because both are already persisted: changing one would
 * change stored fingerprints for non-ASCII input.
 */
function fnv1a32Hex(units: Iterable<number>): string {
  let hash = 0x811c9dc5;
  for (const unit of units) {
    hash ^= unit;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** FNV-1a over UTF-8 bytes, eight lowercase hex digits. */
export function fnv1a32Utf8Hex(value: string): string {
  return fnv1a32Hex(new TextEncoder().encode(value));
}

/** FNV-1a over UTF-16 code units, eight lowercase hex digits. */
export function fnv1a32Utf16Hex(value: string): string {
  const units = new Uint16Array(value.length);
  for (let index = 0; index < value.length; index += 1) units[index] = value.charCodeAt(index);
  return fnv1a32Hex(units);
}

/** SHA-256 of the UTF-8 encoding, lowercase hex. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
