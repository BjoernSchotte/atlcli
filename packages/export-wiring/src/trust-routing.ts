/**
 * Sink-side SSRF enforcement (spec 004): route `trust: "export-view"` asset
 * refs through the external-asset policy, leave everything else on the host's
 * own fetcher.
 *
 * This is the half of the boundary that is easy to forget. Putting the policy
 * into the macro CONTEXT only protects the bytes the macro renderers fetch
 * themselves; the URLs macro HTML *emits* reach the engine as ordinary image
 * blocks and are resolved by the engine's own asset seam. Without these
 * routers, `<img src="http://169.254.169.254/…">` inside third-party
 * `export_view` HTML is fetched by the host's credentialed fetcher — which is
 * exactly the bypass the extension had before this package existed.
 *
 * Rule of thumb for any host: **if an engine env carries `macros`, its asset
 * seam must be wrapped here.** `assertPolicyRoutedPdfAssets` in
 * `@atlcli/export-wiring/fixtures` is the executable form of that rule.
 */
import { ASSET_MAX_BYTES } from "@atlcli/confluence";
import type { AssetFetcher, AssetRef, HostCallContext } from "@atlcli/docx";
import type { PdfAssetResolver, PdfResolvedAsset } from "@atlcli/pdf";
import type { ExternalAssetFetcher } from "@atlcli/export-macros";

/**
 * Trust-routing DOCX asset fetcher. `trust: "export-view"` refs (URLs from
 * third-party-rendered macro HTML, NOT page-author content) go through the
 * policy-checked, redirect-re-checked, byte-capped {@link ExternalAssetFetcher};
 * everything else (page-trust attachments and page-author external images)
 * stays on the host fetcher's existing path, unchanged.
 */
export function trustRoutingAssetFetcher(
  inner: AssetFetcher,
  external: ExternalAssetFetcher
): AssetFetcher {
  return {
    async fetch(ref: AssetRef, context?: HostCallContext): Promise<Uint8Array> {
      if (ref.trust === "export-view") {
        const { bytes } = await external.fetch(ref.url, {
          maxBytes: ASSET_MAX_BYTES,
          ...(context?.signal ? { signal: context.signal } : {}),
        });
        return bytes;
      }
      return inner.fetch(ref, context);
    },
  };
}

/**
 * Trust-routing PDF asset resolver — the same enforcement for the PDF engine's
 * seam.
 *
 * The `signal` is threaded through from the engine's `HostCallContext` so a
 * cancelled export tears down an in-flight external fetch instead of leaving it
 * to the fetcher's own 30 s deadline.
 */
export function trustRoutingPdfAssetResolver(
  inner: PdfAssetResolver,
  external: ExternalAssetFetcher
): PdfAssetResolver {
  return {
    async resolve(ref, context): Promise<PdfResolvedAsset> {
      if (ref.kind === "external" && ref.trust === "export-view") {
        if (!ref.url) throw new Error("external asset ref without url");
        const { bytes, mediaType } = await external.fetch(ref.url, {
          maxBytes: ASSET_MAX_BYTES,
          ...(context?.signal ? { signal: context.signal } : {}),
        });
        return { bytes, mediaType: mediaType ?? "application/octet-stream" };
      }
      return inner.resolve(ref, context);
    },
  };
}
