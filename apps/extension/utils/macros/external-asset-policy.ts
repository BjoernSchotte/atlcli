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
  ExternalAssetBlockedError,
  type ExternalAssetPolicy,
} from "@atlcli/export-wiring";
import type { AssetFetcher } from "@atlcli/docx/browser";
import type { PdfAssetResolver } from "@atlcli/pdf/browser";

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

function isAbsoluteUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function assertManifestScopedPageAsset(
  policy: ExternalAssetPolicy,
  url: string,
): void {
  if (isAbsoluteUrl(url) && !policy.allow(url)) {
    throw new ExternalAssetBlockedError(
      url,
      "the extension has no host permission for this origin",
    );
  }
}

/**
 * Guard page-authored DOCX assets with the extension's manifest-scoped policy.
 *
 * The shared trust router deliberately only diverts `export-view` refs because
 * non-browser hosts may support arbitrary page-authored external images. The
 * extension does not: without a matching `host_permissions` entry Chrome falls
 * back to CORS and emits a console error before the engine can degrade the
 * image. Rejecting here keeps relative/same-origin attachment traffic on the
 * authenticated session path while turning unsupported absolute origins into
 * the engines' existing `image-embed-failed` fallback without a network call.
 */
export function extensionPageAssetFetcher(
  inner: AssetFetcher,
  policy: ExternalAssetPolicy,
): AssetFetcher {
  return {
    async fetch(ref, context): Promise<Uint8Array> {
      assertManifestScopedPageAsset(policy, ref.url);
      return inner.fetch(ref, context);
    },
  };
}

/** PDF counterpart of {@link extensionPageAssetFetcher}. */
export function extensionPagePdfAssetResolver(
  inner: PdfAssetResolver,
  policy: ExternalAssetPolicy,
): PdfAssetResolver {
  return {
    async resolve(ref, context) {
      if (ref.kind === "external" && ref.url) {
        assertManifestScopedPageAsset(policy, ref.url);
      }
      return inner.resolve(ref, context);
    },
  };
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
