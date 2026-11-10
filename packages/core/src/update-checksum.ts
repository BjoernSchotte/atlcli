/**
 * Checksum verification for the self-updater. Kept out of `update.ts` because
 * that module is `export *`-ed from the public barrel; these are internal.
 */

/** Look up an asset's digest in a `checksums.txt` ("<hash>  <filename>" per line). */
export function findChecksum(checksumsText: string, assetName: string): string | null {
  for (const line of checksumsText.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === assetName) return parts[0]!;
  }
  return null;
}

/**
 * The published digest for `assetName`, or a thrown error: an update that
 * cannot be verified is not installed. `checksumsText` is null when the
 * release has no `checksums.txt` or it could not be downloaded.
 */
export function requireChecksum(checksumsText: string | null, assetName: string): string {
  if (checksumsText === null) {
    throw new Error(
      `Cannot verify the update: checksums.txt is missing from the release or could not be downloaded. Nothing was installed.`
    );
  }
  const expected = findChecksum(checksumsText, assetName);
  if (!expected) {
    throw new Error(
      `Cannot verify the update: checksums.txt has no entry for ${assetName}. Nothing was installed.`
    );
  }
  return expected;
}

/** Throw unless `actualDigest` (hex SHA-256) is the published digest for `assetName`. */
export function verifyAssetChecksum(
  checksumsText: string | null,
  assetName: string,
  actualDigest: string
): void {
  if (requireChecksum(checksumsText, assetName) !== actualDigest) {
    throw new Error("Checksum verification failed. Download may be corrupted.");
  }
}
