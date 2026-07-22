/**
 * The extension's origin allowlist over the SHARED external-asset boundary.
 *
 * ## What is left here, and why so little
 *
 * The policy itself — the SSRF guard, the redirect-re-checking / byte-capped /
 * deadline-bounded fetcher, the blocked/timeout error taxonomy — lives in
 * `@atlcli/export-wiring`. It used to live twice: once under `apps/cli/` (where
 * this host could not import it) and once here. Spec 010 W2-0 promoted it into
 * a package, so `apps/extension` and `apps/cli` now reject the same URL for the
 * same reason, and the parity fixtures that prove it are shared too
 * (`@atlcli/export-wiring/fixtures`).
 *
 * What is genuinely host-specific — and therefore all that remains — is WHICH
 * origins this shell vouches for beyond the site itself. That is a manifest
 * decision (`wxt.config.ts` `host_permissions`), not a policy decision, so it
 * belongs to the extension and to nothing else. The shared policy allows
 * nothing extra by default, which is what makes widening it a visible,
 * reviewable diff here rather than an inherited default nobody chose.
 */
import {
  createExternalAssetPolicy,
  type ExternalAssetPolicy,
} from "@atlcli/export-wiring";

export {
  createExternalAssetFetcher,
  externalAssetBlockedMessage,
  isExternalAssetBlockedError,
  isExternalAssetTimeoutError,
  isPrivateHost,
  parseIpv6,
  ExternalAssetBlockedError,
  ExternalAssetTimeoutError,
  EXTERNAL_ASSET_MAX_BYTES,
  EXTERNAL_ASSET_MAX_REDIRECTS,
  EXTERNAL_ASSET_TIMEOUT_MS,
} from "@atlcli/export-wiring";
export type { ExternalAssetFetcherDeps } from "@atlcli/export-wiring";

/**
 * Atlassian media origins the manifest already grants
 * (`apps/extension/wxt.config.ts` → `host_permissions`). Kept as an explicit,
 * enumerable list rather than a wildcard so widening the policy is a visible,
 * reviewable diff that must be matched by a manifest change.
 */
export const ATLASSIAN_MEDIA_ORIGINS: readonly string[] = Object.freeze([
  "https://api.media.atlassian.com",
]);

export interface ExtensionAssetPolicyOptions {
  /**
   * The active site's own origin (e.g. `https://acme.atlassian.net`). Accepts a
   * full URL — only its origin is used. An unparseable value yields a policy
   * that allows nothing but the configured media origins.
   */
  siteOrigin: string;
  /** Defaults to {@link ATLASSIAN_MEDIA_ORIGINS}. */
  allowedMediaOrigins?: readonly string[];
}

/**
 * The shared policy, widened by exactly the origins this extension's manifest
 * permits. Named distinctly from the shared `createExternalAssetPolicy` on
 * purpose: `apps/extension/tests/boundaries.test.ts` fails the build if a file
 * under `utils/` DECLARES a symbol the shared package already owns, and a
 * wrapper that shadows the shared name is exactly how a re-implementation
 * starts looking legitimate.
 */
export function createExtensionAssetPolicy(
  options: ExtensionAssetPolicyOptions
): ExternalAssetPolicy {
  return createExternalAssetPolicy({
    siteOrigin: options.siteOrigin,
    allowedOrigins: options.allowedMediaOrigins ?? ATLASSIAN_MEDIA_ORIGINS,
  });
}

/** Convenience: derive the policy from the active tab's page URL. */
export function extensionAssetPolicyFromPageUrl(
  pageUrl: string,
  options?: Omit<ExtensionAssetPolicyOptions, "siteOrigin">
): ExternalAssetPolicy {
  return createExtensionAssetPolicy({ siteOrigin: pageUrl, ...options });
}
