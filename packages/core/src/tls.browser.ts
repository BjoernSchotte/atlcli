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
import { getLogger } from "./logger.js";

// Re-export the browser-safe type.
export type { TlsOptions } from "./tls.js";

/**
 * Warn at most once per process so profile authors get a signal that their TLS
 * settings have no effect here, without spamming a line per request.
 */
let warnedIgnoredTls = false;

/**
 * Browser stub: always returns `undefined` (no custom TLS in the browser).
 *
 * Browsers manage TLS natively and cannot read CA files, so profile-level TLS
 * settings (`tlsSkipVerify`, `tlsCaFile`) are silently inert here. When a
 * profile actually carries such settings, emit a one-time warning so the author
 * knows they are being ignored.
 */
export function buildTlsOptions(profile: Profile): TlsOptions | undefined {
  if (!warnedIgnoredTls && (profile.tlsSkipVerify || profile.tlsCaFile)) {
    warnedIgnoredTls = true;
    getLogger().warn(
      "Profile TLS settings (tlsSkipVerify/tlsCaFile) are ignored in the browser context; browsers manage TLS natively and cannot read CA files.",
    );
  }
  return undefined;
}
