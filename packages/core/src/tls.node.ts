/**
 * Node TLS wiring.
 *
 * Reads CA certificate files from disk to build Bun `fetch` TLS options.
 * Node-only (uses `node:fs`); the browser build never reads CA files.
 */

import { readFileSync } from "node:fs";
import type { Profile } from "./types.js";
import type { TlsOptions } from "./tls.js";

// Re-export the browser-safe type so Node consumers get everything from here.
export type { TlsOptions } from "./tls.js";

/**
 * Build TLS options from a profile's TLS configuration.
 * Returns `undefined` when no custom TLS settings are needed.
 *
 * @throws {Error} When the CA certificate file cannot be read.
 */
export function buildTlsOptions(profile: Profile): TlsOptions | undefined {
  const opts: TlsOptions = {};
  let hasOpts = false;

  if (profile.tlsSkipVerify) {
    opts.rejectUnauthorized = false;
    hasOpts = true;
  }

  if (profile.tlsCaFile) {
    try {
      opts.ca = readFileSync(profile.tlsCaFile, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read CA certificate file '${profile.tlsCaFile}': ${msg}`);
    }
    hasOpts = true;
  }

  return hasOpts ? opts : undefined;
}
