import { readFileSync } from "node:fs";
import type { Profile } from "./config.js";

/**
 * TLS options passed to Bun's non-standard `tls` field on `fetch()` options.
 */
export type TlsOptions = {
  /** Custom CA certificate(s) in PEM format */
  ca?: string;
  /** When false, skips TLS certificate verification. Not recommended for production. */
  rejectUnauthorized?: boolean;
};

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
