/**
 * Browser TLS wiring.
 *
 * Browsers cannot read CA files and manage TLS natively, so there are no
 * custom TLS options to build. This no-op keeps the clients' `buildTlsOptions`
 * import resolvable under the `browser` export condition; `applyTls` in each
 * client already treats `undefined` as "no custom TLS" and omits the `tls`
 * field from the `fetch` init.
 */

import type { Profile } from "./types.js";
import type { TlsOptions } from "./tls.js";

// Re-export the browser-safe type.
export type { TlsOptions } from "./tls.js";

/**
 * Browser stub: always returns `undefined` (no custom TLS in the browser).
 */
export function buildTlsOptions(_profile: Profile): TlsOptions | undefined {
  return undefined;
}
