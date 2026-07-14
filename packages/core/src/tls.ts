/**
 * Browser-safe TLS types.
 *
 * Only the `TlsOptions` type lives here so this module has zero Node imports.
 * The file-reading `buildTlsOptions` implementation is Node-only
 * (`tls.node.ts`); the browser build uses a no-op (`tls.browser.ts`).
 */

/**
 * TLS options passed to Bun's non-standard `tls` field on `fetch()` options.
 */
export type TlsOptions = {
  /** Custom CA certificate(s) in PEM format */
  ca?: string;
  /** When false, skips TLS certificate verification. Not recommended for production. */
  rejectUnauthorized?: boolean;
};
