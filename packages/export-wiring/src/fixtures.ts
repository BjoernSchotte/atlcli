/**
 * The cross-host parity contract for the external-asset boundary.
 *
 * These fixtures are the reason this package exists. They were written for the
 * extension, against an adversarial review that found an IPv4-mapped-IPv6
 * bypass, a `::` bypass, a NAT64 bypass and a missing stream deadline — and
 * they were, at that point, provably stronger than the CLI's copy of the same
 * policy. Sharing them makes "the CLI and the panel reject the same URL" a
 * thing a test can fail on rather than a thing a reviewer has to remember.
 *
 * A host adds cases HERE, never inline in one host's test file.
 */
import type { PdfAssetRef, PdfAssetResolver } from "@atlcli/pdf";
import { isExternalAssetBlockedError } from "./asset-policy.js";

/** Site origin every URL fixture below is evaluated against. */
export const POLICY_FIXTURE_SITE_ORIGIN = "https://fixture.atlassian.net";

/**
 * The one extra origin the fixture policy vouches for, standing in for a host's
 * own allowlist (the extension's manifest-granted Atlassian media CDN). The
 * shared policy allows NOTHING beyond the site origin by default, so a consumer
 * must pass this explicitly — which is the point: the fixtures exercise a
 * two-origin allowlist without the package shipping one.
 */
export const POLICY_FIXTURE_EXTRA_ORIGIN = "https://api.media.atlassian.com";

/** Convenience for `createExternalAssetPolicy({ siteOrigin, allowedOrigins })`. */
export const POLICY_FIXTURE_ALLOWED_ORIGINS: readonly string[] = Object.freeze([
  POLICY_FIXTURE_EXTRA_ORIGIN,
]);

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
   * When set, a fetch of {@link url} is answered with a 302 to the first entry,
   * that hop with a 302 to the second, and so on; the LAST entry answers 200.
   * The final outcome is {@link allowedAfterRedirect}.
   *
   * A chain rather than a single location because the interesting bypass is
   * multi-hop: allowed → allowed → private. A one-hop fixture set cannot tell a
   * per-hop policy check apart from one that only re-checks the first bounce.
   *
   * Every fixture that sets this MUST also set {@link allowedAfterRedirect};
   * the consumer suites fail if one does not, because a redirect expectation
   * nothing consumes is how this fixture set previously gave false confidence.
   */
  redirectChain?: readonly string[];
  /** Final fetch outcome when {@link redirectChain} is set. */
  allowedAfterRedirect?: boolean;
}

/** A hostname and the `isPrivateHost` verdict it must produce. */
export interface PrivateHostFixture {
  host: string;
  private: boolean;
  reason: string;
}

/**
 * The SSRF-guard contract, asserted against `isPrivateHost` DIRECTLY.
 *
 * Separate from {@link EXTERNAL_ASSET_POLICY_FIXTURES} on purpose. A URL fixture
 * runs through `allow()`, which rejects a private host and an off-allowlist
 * origin with the same `false`; every private-host URL is off-allowlist, so a
 * URL fixture can never prove the guard fired. These do.
 */
export const EXTERNAL_ASSET_PRIVATE_HOST_FIXTURES: readonly PrivateHostFixture[] = Object.freeze([
  { host: "localhost", private: true, reason: "loopback by name" },
  { host: "app.localhost", private: true, reason: "loopback subdomain" },
  { host: "intranet", private: true, reason: "dotless name resolves via the search domain" },
  { host: "127.0.0.1", private: true, reason: "IPv4 loopback" },
  { host: "127.1.2.3", private: true, reason: "the whole 127/8 block is loopback" },
  { host: "0.0.0.0", private: true, reason: "unspecified IPv4 routes to the local host" },
  { host: "10.1.2.3", private: true, reason: "RFC1918 10/8" },
  { host: "172.16.0.1", private: true, reason: "RFC1918 172.16/12" },
  { host: "192.168.1.1", private: true, reason: "RFC1918 192.168/16" },
  { host: "169.254.169.254", private: true, reason: "AWS/Azure link-local metadata service" },
  { host: "100.64.0.1", private: true, reason: "carrier-grade NAT" },
  { host: "198.18.0.1", private: true, reason: "benchmarking range, reachable on a corp LAN" },
  { host: "::1", private: true, reason: "IPv6 loopback" },
  { host: "0:0:0:0:0:0:0:1", private: true, reason: "IPv6 loopback, uncompressed" },
  {
    host: "::",
    private: true,
    reason: "IPv6 unspecified — connects to the local host, and carries no dotted quad to match",
  },
  { host: "fd00::1", private: true, reason: "IPv6 unique-local fc00::/7" },
  { host: "fd00:ec2::254", private: true, reason: "IPv6 metadata service (EC2 unique-local)" },
  { host: "fe80::1", private: true, reason: "IPv6 link-local fe80::/10" },
  { host: "febf::1", private: true, reason: "top of the fe80::/10 link-local block" },
  { host: "fe80::1%25eth0", private: true, reason: "a zone id does not change the range" },
  {
    host: "::ffff:7f00:1",
    private: true,
    reason: "IPv4-mapped loopback AS WHATWG URL CANONICALIZES IT — no dotted quad survives",
  },
  { host: "::ffff:127.0.0.1", private: true, reason: "IPv4-mapped loopback, dotted spelling" },
  {
    host: "::ffff:a9fe:a9fe",
    private: true,
    reason: "IPv4-mapped 169.254.169.254 — the metadata service behind an IPv6 literal",
  },
  { host: "::7f00:1", private: true, reason: "IPv4-compatible loopback (deprecated, still routed)" },
  { host: "::ffff:0:7f00:1", private: true, reason: "IPv4-translated loopback (RFC 2765)" },
  { host: "64:ff9b::7f00:1", private: true, reason: "NAT64 well-known prefix to loopback" },
  { host: "0:0:0:0:0:ffff:a9fe:a9fe", private: true, reason: "IPv4-mapped metadata, uncompressed" },
  { host: "metadata.google.internal", private: true, reason: "GCE metadata service by name" },
  { host: "printer.local", private: true, reason: "mDNS names are local-network only" },
  { host: "wiki.corp", private: true, reason: "de-facto corporate search domain" },
  { host: "host.home.arpa", private: true, reason: "RFC 8375 home network zone" },
  { host: ":::1", private: true, reason: "an unparseable IPv6 literal is not a target we can vet" },
  { host: "fixture.atlassian.net", private: false, reason: "ordinary public host" },
  { host: "api.media.atlassian.com", private: false, reason: "the configured extra origin" },
  { host: "8.8.8.8", private: false, reason: "ordinary public IPv4" },
  { host: "2606:4700::1111", private: false, reason: "ordinary public IPv6" },
  { host: "::ffff:8.8.8.8", private: false, reason: "IPv4-mapped PUBLIC address stays allowed" },
]);

/**
 * The cross-host policy fixture set.
 *
 * **Every field must drive an assertion.** The consumer suites iterate the
 * whole array — `allowed` for every entry, and `redirectChain` /
 * `allowedAfterRedirect` for every entry that declares them — and fail if a
 * fixture carries a redirect expectation nothing consumes. An earlier version
 * of this array excluded redirect fixtures from the loop and hand-picked two by
 * name, so `allowedAfterRedirect` was decorative and the set looked far more
 * thorough than it was. A parity contract that does not run is not a contract.
 */
export const EXTERNAL_ASSET_POLICY_FIXTURES: readonly ExternalAssetPolicyFixture[] = Object.freeze([
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
    reason: "resolved against the site origin, not the host's own origin",
  },
  {
    name: "allowed Atlassian media origin",
    url: `${POLICY_FIXTURE_EXTRA_ORIGIN}/file/abc/binary?token=xyz`,
    allowed: true,
    reason: "explicitly configured extra origin (granted by the host)",
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
    reason: "suffix look-alike must not match the configured origin",
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
    redirectChain: ["https://third-party-app.example.com/render/chart.png"],
    allowedAfterRedirect: false,
  },
  {
    name: "redirect within the allowlist",
    url: `${POLICY_FIXTURE_SITE_ORIGIN}/wiki/redirector?to=media`,
    allowed: true,
    reason: "site origin bouncing to a configured extra origin stays allowed",
    redirectChain: [`${POLICY_FIXTURE_EXTRA_ORIGIN}/file/abc/binary`],
    allowedAfterRedirect: true,
  },
  {
    name: "multi-hop redirect ending at a private target",
    url: `${POLICY_FIXTURE_SITE_ORIGIN}/wiki/redirector?to=chain`,
    allowed: true,
    reason:
      "two allowed hops then the metadata service — the check must run on EVERY hop, not just the first bounce",
    redirectChain: [
      `${POLICY_FIXTURE_EXTRA_ORIGIN}/file/abc/binary?next=1`,
      "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    ],
    allowedAfterRedirect: false,
  },
  {
    name: "multi-hop redirect ending at a mapped-IPv6 loopback",
    url: `${POLICY_FIXTURE_SITE_ORIGIN}/wiki/redirector?to=mapped`,
    allowed: true,
    reason: "the last hop is loopback spelled as WHATWG URL canonicalizes it",
    redirectChain: [
      `${POLICY_FIXTURE_SITE_ORIGIN}/wiki/redirector/hop2`,
      "http://[::ffff:7f00:1]:8080/admin",
    ],
    allowedAfterRedirect: false,
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
    name: "mapped-IPv6 loopback target",
    url: "http://[::ffff:7f00:1]/internal.png",
    allowed: false,
    reason:
      "SSRF guard: `http://[::ffff:127.0.0.1]/` reaches the policy in this canonical hex form",
  },
  {
    name: "mapped-IPv6 metadata target",
    url: "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
    allowed: false,
    reason: "SSRF guard: 169.254.169.254 behind an IPv4-mapped IPv6 literal",
  },
  {
    name: "unspecified IPv6 target",
    url: "http://[::]:8080/internal.png",
    allowed: false,
    reason: "SSRF guard: `::` connects to the local host and has no dotted quad to match",
  },
  {
    name: "unique-local IPv6 metadata target",
    url: "http://[fd00:ec2::254]/latest/meta-data/",
    allowed: false,
    reason: "SSRF guard: the EC2 IPv6 metadata endpoint",
  },
  {
    name: "GCE metadata hostname",
    url: "http://metadata.google.internal/computeMetadata/v1/",
    allowed: false,
    reason: "SSRF guard: the metadata service reached by name rather than by address",
  },
  {
    name: "non-http scheme",
    url: "file:///etc/passwd",
    allowed: false,
    reason: "only http(s) is fetchable",
  },
  {
    name: "credentials embedded in the URL",
    url: `https://user:secret@api.media.atlassian.com/file/abc/binary`,
    allowed: false,
    reason: "never forward embedded credentials",
  },
]);

// ---------------------------------------------------------------------------
// Trust-routing probe — the executable form of "macros ⇒ policy-wrapped assets"
// ---------------------------------------------------------------------------

/**
 * The ref a policy-wrapped PDF asset resolver MUST refuse: an absolute URL that
 * only third-party `export_view` HTML could have produced, pointing at the
 * cloud metadata service.
 */
export const TRUST_ROUTING_PROBE_REF: PdfAssetRef = Object.freeze({
  kind: "external",
  url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
  trust: "export-view",
}) as PdfAssetRef;

/**
 * Assert that a `PdfExportEnv`'s asset resolver routes `trust: "export-view"`
 * refs through the external-asset policy.
 *
 * Written as a runtime probe rather than an `instanceof` check on purpose: it
 * asserts the OUTCOME (the metadata service is never contacted, and the failure
 * is a policy block rather than a network error), so it holds for any host's
 * resolver however it is composed. Throws with an explanation on failure, which
 * is what makes it usable straight from a host's test.
 */
export async function assertPolicyRoutedPdfAssets(assets: PdfAssetResolver): Promise<void> {
  let error: unknown;
  try {
    await assets.resolve(TRUST_ROUTING_PROBE_REF);
  } catch (caught) {
    error = caught;
  }
  if (error === undefined) {
    throw new Error(
      "PDF asset resolver RESOLVED an export_view-trust ref pointing at the cloud metadata " +
        "service — it is not wrapped in trustRoutingPdfAssetResolver."
    );
  }
  if (!isExternalAssetBlockedError(error)) {
    throw new Error(
      "PDF asset resolver rejected the export_view-trust metadata probe, but NOT with an " +
        "ExternalAssetBlockedError — the request was attempted rather than blocked by policy. " +
        `Got: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
    );
  }
}

/**
 * The wiring rule, applied to a whole PDF env: **if it resolves macros, its
 * asset resolver must be policy-routed.**
 *
 * Returns which branch it took so the caller can assert the check was not
 * vacuous. That matters: a host whose env carries no `macros` passes this rule
 * trivially, and a test that cannot tell "routed" from "nothing to check" is
 * exactly how `trustRoutingPdfAssetResolver` sat with zero call sites while
 * looking covered.
 */
export async function assertPdfEnvMacroAssetRule(env: {
  macros?: unknown;
  assets: PdfAssetResolver;
}): Promise<"routed" | "no-macros"> {
  if (env.macros === undefined) return "no-macros";
  await assertPolicyRoutedPdfAssets(env.assets);
  return "routed";
}
