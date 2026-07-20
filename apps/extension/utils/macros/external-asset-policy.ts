/**
 * `ExternalAssetPolicy` / `ExternalAssetFetcher` for the extension host
 * (spec 010 T5.4, Architecture point 6 — "External-asset security boundary").
 *
 * ## Why this module exists
 *
 * Before T5.4 the two engines disagreed about `export_view`-sourced images:
 *
 * - the PDF resolver (`utils/pdf/run-export.ts#pageResolver`) threw for EVERY
 *   `ref.kind === "external"` ref, so once macro rendering lands, every image a
 *   third-party macro renders would silently degrade to a skip note;
 * - the DOCX `sessionAssetFetcher` (`utils/docx/env.ts`) fetched ANY absolute
 *   URL with `credentials: "include"` and no allowlist at all.
 *
 * Same URL, two opposite outcomes — one an invisible omission, the other an
 * unauthenticated (worse: cookie-bearing) fetch of a third-party host. This
 * module is the single decision point both resolvers call, so an
 * `export_view`-sourced image either renders in both formats or degrades
 * identically in both, with a visible placeholder + report note.
 *
 * ## The decision
 *
 * {@link createExternalAssetPolicy} allows:
 *  - the active site's own origin (the tab's Atlassian Cloud origin), and
 *  - the explicitly configured Atlassian media origins
 *    ({@link ATLASSIAN_MEDIA_ORIGINS} — the exact set already granted by
 *    `wxt.config.ts` `host_permissions`; the policy never widens what the
 *    manifest permits).
 *
 * and rejects everything else, plus — regardless of origin — non-http(s)
 * schemes, credentials embedded in the URL, and loopback / private / link-local
 * / unique-local hosts (SSRF guard: macro-rendered HTML is page-editor- and
 * third-party-app-controlled, i.e. a different trust boundary than CLI flags).
 *
 * {@link createExternalAssetFetcher} then enforces that decision across the
 * whole request: `redirect: "manual"` so every `Location` hop is re-checked
 * against the policy (an allowed origin must not be usable as an open
 * redirector into a disallowed one), and a streaming byte cap so a hostile or
 * merely huge response cannot be buffered into the panel's memory.
 *
 * Isomorphic-by-construction: this is a host adapter (extension shell), but it
 * takes no `chrome.*` API and no DOM — only `fetch` — so it is unit-testable
 * with hand-constructed real `Response` objects.
 */
import type { ExternalAssetFetcher, ExternalAssetPolicy } from "@atlcli/export-macros";

/**
 * Atlassian media origins the manifest already grants
 * (`apps/extension/wxt.config.ts` → `host_permissions`). Kept as an explicit,
 * enumerable list rather than a wildcard so widening the policy is a visible,
 * reviewable diff that must be matched by a manifest change.
 */
export const ATLASSIAN_MEDIA_ORIGINS: readonly string[] = Object.freeze([
  "https://api.media.atlassian.com",
]);

/**
 * Byte cap for one `export_view`-sourced asset. Deliberately smaller than the
 * engines' whole-document asset budget: a single third-party image has no
 * legitimate reason to be this large, and the cap is the only thing standing
 * between a hostile response and the panel's heap.
 */
export const EXTERNAL_ASSET_MAX_BYTES = 8 * 1024 * 1024;

/** Maximum redirect hops followed before giving up. */
export const EXTERNAL_ASSET_MAX_REDIRECTS = 5;

export interface ExternalAssetPolicyOptions {
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
 * Thrown when a URL fails {@link ExternalAssetPolicy.allow}. Both engines
 * already degrade a thrown asset-resolution error into a placeholder plus a
 * report note (`pdf-image-skipped` / `image-embed-failed`), so throwing this is
 * exactly the "visible placeholder + report note" outcome the plan asks for —
 * no engine change required.
 */
export class ExternalAssetBlockedError extends Error {
  readonly url: string;
  constructor(url: string, reason = "not on the allowed origin list") {
    super(externalAssetBlockedMessage(url, reason));
    this.name = "ExternalAssetBlockedError";
    this.url = url;
  }
}

/** The single user-facing wording both engines emit for a blocked asset. */
export function externalAssetBlockedMessage(
  url: string,
  reason = "not on the allowed origin list"
): string {
  return `External image blocked by the export asset policy (${reason}): ${redactUrl(url)}`;
}

/** True for the error {@link createExternalAssetFetcher} raises on rejection. */
export function isExternalAssetBlockedError(error: unknown): error is ExternalAssetBlockedError {
  return error instanceof Error && error.name === "ExternalAssetBlockedError";
}

/**
 * Strip query/fragment before a URL lands in a report note: `export_view` image
 * URLs routinely carry signed-media tokens, and export reports are saved and
 * shared.
 */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

/**
 * Loopback / private / link-local / unique-local target check (SSRF guard).
 * Exported so the tests — and any future host adapter — assert on the same
 * predicate rather than re-deriving the regex set.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  // IPv4 (incl. IPv4-mapped IPv6 such as ::ffff:127.0.0.1).
  const v4 = host.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    // Carrier-grade NAT + benchmarking ranges, both reachable inside a corp LAN.
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
  }
  // A bare hostname with no dot resolves against the local search domain.
  if (!host.includes(".") && !host.includes(":")) return true;
  return false;
}

/**
 * Build the shared allow/reject decision. Pure and synchronous — the same
 * instance is safe to hand to both engines' resolvers and to the macro
 * resolver's `ExternalAssetFetcher`.
 */
export function createExternalAssetPolicy(
  options: ExternalAssetPolicyOptions
): ExternalAssetPolicy {
  const siteOrigin = normalizeOrigin(options.siteOrigin);
  const media = new Set(
    (options.allowedMediaOrigins ?? ATLASSIAN_MEDIA_ORIGINS)
      .map(normalizeOrigin)
      .filter((o) => o !== "")
  );
  return {
    allow(url: string): boolean {
      let parsed: URL;
      try {
        // Relative refs are resolved against the site origin, never against the
        // extension origin (`chrome-extension://…`), which would be meaningless.
        parsed = siteOrigin ? new URL(url, siteOrigin) : new URL(url);
      } catch {
        return false;
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
      // `https://user:pass@host/` — never forward embedded credentials.
      if (parsed.username !== "" || parsed.password !== "") return false;
      if (isPrivateHost(parsed.hostname)) return false;
      if (siteOrigin !== "" && parsed.origin === siteOrigin) return true;
      return media.has(parsed.origin);
    },
  };
}

/** Convenience: derive the policy from the active tab's page URL. */
export function externalAssetPolicyFromPageUrl(
  pageUrl: string,
  options?: Omit<ExternalAssetPolicyOptions, "siteOrigin">
): ExternalAssetPolicy {
  return createExternalAssetPolicy({ siteOrigin: pageUrl, ...options });
}

export interface ExternalAssetFetcherDeps {
  fetchFn?: typeof fetch;
  maxRedirects?: number;
}

/**
 * A policy-checked, redirect-re-checked, byte-capped fetcher for
 * `export_view`-sourced bytes. Mirrors the CLI's
 * `defaultExternalAssetFetcher` (`apps/cli/src/commands/export-macros-wiring.ts`)
 * so both hosts behave identically; the extension differs only in sending
 * `credentials: "omit"` — third-party macro-rendered URLs must never ride the
 * user's Atlassian session cookies, which is precisely what today's
 * `sessionAssetFetcher` does for any absolute URL.
 */
export function createExternalAssetFetcher(
  policy: ExternalAssetPolicy,
  deps: ExternalAssetFetcherDeps = {}
): ExternalAssetFetcher {
  const fetchFn = deps.fetchFn ?? fetch;
  const maxRedirects = deps.maxRedirects ?? EXTERNAL_ASSET_MAX_REDIRECTS;
  return {
    async fetch(url, opts) {
      let current = url;
      for (let hop = 0; hop <= maxRedirects; hop++) {
        if (!policy.allow(current)) {
          throw new ExternalAssetBlockedError(
            current,
            hop === 0 ? "not on the allowed origin list" : "redirected to a disallowed origin"
          );
        }
        const res = await fetchFn(current, {
          redirect: "manual",
          credentials: "omit",
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        // `redirect: "manual"` surfaces a cross-origin bounce either as a raw
        // 3xx or as an opaque redirect (status 0, no readable Location). The
        // opaque case is unfollowable by construction — treat it as blocked
        // rather than as an empty asset.
        if (res.type === "opaqueredirect") {
          throw new ExternalAssetBlockedError(current, "opaque cross-origin redirect");
        }
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          if (!location) {
            throw new ExternalAssetBlockedError(current, "redirect without a Location header");
          }
          current = new URL(location, current).toString();
          continue;
        }
        if (!res.ok) {
          throw new Error(
            `External image fetch failed (${res.status}) for ${redactUrl(current)}`
          );
        }
        const bytes = await readCapped(res, opts.maxBytes ?? EXTERNAL_ASSET_MAX_BYTES, current);
        const mediaType = res.headers.get("content-type") ?? undefined;
        return { bytes, ...(mediaType ? { mediaType } : {}) };
      }
      throw new ExternalAssetBlockedError(url, `more than ${maxRedirects} redirects`);
    },
  };
}

/**
 * Read a response body, aborting as soon as `maxBytes` is exceeded. The
 * declared `Content-Length` is checked first so an oversize body costs zero
 * bytes of heap; the streaming check then catches an undeclared/lying one.
 */
async function readCapped(res: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  const tooLarge = (): Error =>
    new Error(
      `External image exceeded the ${maxBytes}-byte export limit: ${redactUrl(url)}`
    );
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();

  const reader = res.body?.getReader();
  if (!reader) {
    // Defensive fallback for runtimes that expose no stream body; the
    // Content-Length pre-check above already rejected a declared oversize.
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw tooLarge();
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared fixtures — the cross-engine parity contract
// ---------------------------------------------------------------------------

/** Site origin every fixture below is evaluated against. */
export const POLICY_FIXTURE_SITE_ORIGIN = "https://fixture.atlassian.net";

export interface ExternalAssetPolicyFixture {
  /** Stable name, used as the test case title in every consumer. */
  name: string;
  /** URL handed to `ExternalAssetPolicy.allow` / `ExternalAssetFetcher.fetch`. */
  url: string;
  /** Expected `allow()` verdict for {@link url} itself. */
  allowed: boolean;
  /** Why — surfaced in assertion messages, not parsed. */
  reason: string;
  /**
   * When set, a fetch of {@link url} is answered with a 302 to this location;
   * the FINAL outcome is then `allowedAfterRedirect`. Lets one fixture array
   * cover both the synchronous `allow()` decision and the redirect-re-check.
   */
  redirectsTo?: string;
  /** Final fetch outcome when {@link redirectsTo} is set. */
  allowedAfterRedirect?: boolean;
}

/**
 * The cross-engine parity fixture set (spec 010 T5.4).
 *
 * A wave-2 agent extends the consumer test to run these same fixtures through
 * BOTH `utils/pdf/run-export.ts#pageResolver` and
 * `utils/docx/env.ts#sessionAssetFetcher` and assert identical outcomes — so
 * keep this an exported, self-describing array, and add cases here rather than
 * inline in any single test.
 */
export const EXTERNAL_ASSET_POLICY_FIXTURES: readonly ExternalAssetPolicyFixture[] =
  Object.freeze([
    {
      name: "site origin",
      url: `${POLICY_FIXTURE_SITE_ORIGIN}/wiki/download/attachments/1/diagram.png`,
      allowed: true,
      reason: "the active site's own origin is always allowed",
    },
    {
      name: "site-relative reference",
      url: "/wiki/download/attachments/1/diagram.png",
      allowed: true,
      reason: "resolved against the site origin, not the extension origin",
    },
    {
      name: "allowed Atlassian media origin",
      url: "https://api.media.atlassian.com/file/abc/binary?token=xyz",
      allowed: true,
      reason: "explicitly configured Atlassian media origin (granted by the manifest)",
    },
    {
      name: "disallowed third-party origin",
      url: "https://third-party-app.example.com/render/chart.png",
      allowed: false,
      reason: "third-party app host is not on the allowlist",
    },
    {
      name: "look-alike Atlassian host",
      url: "https://api.media.atlassian.com.evil.example/file/abc/binary",
      allowed: false,
      reason: "suffix look-alike must not match the media origin",
    },
    {
      name: "other Atlassian site",
      url: "https://other-tenant.atlassian.net/wiki/download/attachments/1/x.png",
      allowed: false,
      reason: "a different tenant is not the active site",
    },
    {
      name: "redirect to a disallowed origin",
      url: `${POLICY_FIXTURE_SITE_ORIGIN}/wiki/redirector?to=evil`,
      allowed: true,
      reason: "starts on the site origin but bounces off the allowlist",
      redirectsTo: "https://third-party-app.example.com/render/chart.png",
      allowedAfterRedirect: false,
    },
    {
      name: "redirect within the allowlist",
      url: `${POLICY_FIXTURE_SITE_ORIGIN}/wiki/redirector?to=media`,
      allowed: true,
      reason: "site origin bouncing to a configured media origin stays allowed",
      redirectsTo: "https://api.media.atlassian.com/file/abc/binary",
      allowedAfterRedirect: true,
    },
    {
      name: "loopback target",
      url: "http://127.0.0.1:8080/internal.png",
      allowed: false,
      reason: "SSRF guard: loopback",
    },
    {
      name: "localhost target",
      url: "http://localhost:9000/internal.png",
      allowed: false,
      reason: "SSRF guard: loopback by name",
    },
    {
      name: "private RFC1918 target",
      url: "http://10.0.0.5/internal.png",
      allowed: false,
      reason: "SSRF guard: private network",
    },
    {
      name: "link-local metadata target",
      url: "http://169.254.169.254/latest/meta-data/",
      allowed: false,
      reason: "SSRF guard: cloud metadata service",
    },
    {
      name: "non-http scheme",
      url: "file:///etc/passwd",
      allowed: false,
      reason: "only http(s) is fetchable",
    },
    {
      name: "credentials embedded in the URL",
      url: "https://user:secret@api.media.atlassian.com/file/abc/binary",
      allowed: false,
      reason: "never forward embedded credentials",
    },
  ]);
