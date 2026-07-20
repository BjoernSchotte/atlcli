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

/**
 * Wall-clock budget for ONE `ExternalAssetFetcher.fetch` call — every redirect
 * hop plus the whole body read.
 *
 * Without it a permitted response can hold a reader open forever: `redirect:
 * "manual"` + `credentials: "omit"` bound *what* is fetched, and
 * {@link EXTERNAL_ASSET_MAX_BYTES} bounds *how much*, but nothing bounded *how
 * long*. A host that sends headers, one byte, and then simply never sends
 * another leaves `reader.read()` pending, and — since the caller's
 * `AbortSignal` is optional — an export could sit there until the panel is
 * closed. The cap is deliberately generous: it exists to stop a stall, not to
 * police a slow-but-progressing download of a legitimately large image.
 */
export const EXTERNAL_ASSET_TIMEOUT_MS = 30_000;

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
 * Suffixes that only ever name something on the local network: the ICANN
 * private-use TLD, mDNS, the RFC 8375 home zone, and the de-facto corporate
 * search domains. `metadata.google.internal` — the GCE metadata service, a
 * name-based twin of `169.254.169.254` — falls out of `.internal`.
 */
const PRIVATE_HOST_SUFFIXES: readonly string[] = Object.freeze([
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".home.arpa",
  ".lan",
  ".corp",
  ".private",
]);

/**
 * Expand an IPv6 literal into its eight 16-bit groups, or `undefined` when
 * `value` is not one.
 *
 * A textual check cannot stand in for this. WHATWG `URL` *canonicalizes* an
 * IPv6 host, so `http://[::ffff:127.0.0.1]/` arrives at the policy as
 * `[::ffff:7f00:1]` — the dotted quad the old suffix regex looked for is gone by
 * the time the guard sees it, and `[::]` never had one. Parsing to groups makes
 * every spelling of the same address collapse to the same eight numbers.
 */
export function parseIpv6(value: string): number[] | undefined {
  // A zone id (`fe80::1%25eth0`) never changes which range the address is in.
  let text = value.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (!text.includes(":")) return undefined;

  // A trailing dotted quad is shorthand for the last two groups; rewrite it to
  // hex so the group parser below has a single form to deal with.
  const dotted = /(?:^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted) {
    const octets = dotted[1]!.split(".").map(Number);
    if (octets.some((octet) => octet > 255)) return undefined;
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    text = `${text.slice(0, text.length - dotted[1]!.length)}${hi}:${lo}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const groups = (part: string): number[] | undefined => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !tail) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return undefined;
  return [...head, ...Array.from({ length: fill }, () => 0), ...tail];
}

/**
 * The IPv4 address an IPv6 address embeds, for every prefix that makes an IPv6
 * literal reach an IPv4 destination: IPv4-mapped (`::ffff:0:0/96`),
 * IPv4-compatible (`::/96`, deprecated but still routed by some stacks),
 * IPv4-translated (`::ffff:0:0:0/96`, RFC 2765) and the RFC 6052 NAT64
 * well-known prefix (`64:ff9b::/96`). Each of them turns `[::ffff:7f00:1]` into
 * a packet at `127.0.0.1`, so each has to be run through the IPv4 rules.
 */
function embeddedIpv4(groups: readonly number[]): string | undefined {
  const zeroUpTo = (count: number): boolean => groups.slice(0, count).every((g) => g === 0);
  const mapped = zeroUpTo(5) && groups[5] === 0xffff;
  const compatible = zeroUpTo(6);
  const translated = zeroUpTo(4) && groups[4] === 0xffff && groups[5] === 0;
  const nat64 =
    groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0);
  if (!mapped && !compatible && !translated && !nat64) return undefined;
  const hi = groups[6]!;
  const lo = groups[7]!;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** The IPv4 rules, applied to a dotted quad. */
function isPrivateIpv4(a: number, b: number): boolean {
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  // Carrier-grade NAT + benchmarking ranges, both reachable inside a corp LAN.
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

/** The IPv6 rules, applied to eight expanded groups. */
function isPrivateIpv6(groups: readonly number[]): boolean {
  // `::` (unspecified — routes to the local host) and `::1` (loopback).
  if (groups.every((g) => g === 0)) return true;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  // Unique-local fc00::/7 and link-local fe80::/10.
  if ((groups[0]! & 0xfe00) === 0xfc00) return true;
  if ((groups[0]! & 0xffc0) === 0xfe80) return true;
  const embedded = embeddedIpv4(groups);
  if (embedded) {
    const octets = embedded.split(".").map(Number);
    if (isPrivateIpv4(octets[0]!, octets[1]!)) return true;
  }
  return false;
}

/**
 * Loopback / private / link-local / unique-local target check (SSRF guard).
 * Exported so the tests — and any future host adapter — assert on the same
 * predicate rather than re-deriving the rule set.
 *
 * Assert against THIS function, not against `policy.allow()`, when what is
 * under test is the guard: `allow()` also rejects on origin mismatch, so a
 * private host that the guard misses still comes back `false` and the test
 * passes for the wrong reason. That is exactly how the IPv4-mapped IPv6 hole
 * survived review.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "" || host === "localhost") return true;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;

  // A hostname cannot contain a colon, so a colon means "meant to be IPv6". One
  // that will not parse is not a target we can reason about — block it rather
  // than fall through to the name rules, which would read it as a public host.
  if (host.includes(":")) {
    const groups = parseIpv6(host);
    return groups ? isPrivateIpv6(groups) : true;
  }

  const v4 = host.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4 && isPrivateIpv4(Number(v4[1]), Number(v4[2]))) return true;
  // A bare hostname with no dot resolves against the local search domain.
  if (!host.includes(".")) return true;
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
  /** Overrides {@link EXTERNAL_ASSET_TIMEOUT_MS}. `0` disables the deadline. */
  timeoutMs?: number;
}

/** Thrown when one asset fetch outlives {@link EXTERNAL_ASSET_TIMEOUT_MS}. */
export class ExternalAssetTimeoutError extends Error {
  readonly url: string;
  constructor(url: string, timeoutMs: number) {
    super(`External image fetch timed out after ${timeoutMs} ms: ${redactUrl(url)}`);
    this.name = "ExternalAssetTimeoutError";
    this.url = url;
  }
}

/** True for the error a fetch that outlived its deadline raises. */
export function isExternalAssetTimeoutError(error: unknown): error is ExternalAssetTimeoutError {
  return error instanceof Error && error.name === "ExternalAssetTimeoutError";
}

interface Deadline {
  /** Aborts on the caller's signal OR on the internal timeout, whichever first. */
  signal: AbortSignal;
  /** Rejects with the abort reason; never resolves. Race body reads against it. */
  expired: Promise<never>;
  dispose(): void;
}

/**
 * The caller's optional `AbortSignal` combined with an internal deadline.
 *
 * `expired` exists because aborting the *fetch* signal is not, on its own,
 * enough: a `Response` handed back by a host adapter (or by a test) is an
 * ordinary object whose body stream owes nothing to the signal the request was
 * made with, so a `reader.read()` that never settles keeps not settling. Racing
 * each read against this promise is what actually bounds the read.
 */
function createDeadline(caller: AbortSignal | undefined, timeoutMs: number, url: string): Deadline {
  const controller = new AbortController();
  let reject: (reason: unknown) => void = () => {};
  const expired = new Promise<never>((_, r) => {
    reject = r;
  });
  // Nothing races `expired` once the fetch has settled, so an abort that lands
  // after the last read would otherwise surface as an unhandled rejection.
  expired.catch(() => {});

  const abort = (reason: unknown): void => {
    if (controller.signal.aborted) return;
    controller.abort(reason);
    reject(reason);
  };
  const timer =
    timeoutMs > 0
      ? setTimeout(() => abort(new ExternalAssetTimeoutError(url, timeoutMs)), timeoutMs)
      : undefined;
  const onCallerAbort = (): void => abort(caller?.reason ?? new Error("Aborted"));
  if (caller) {
    if (caller.aborted) onCallerAbort();
    else caller.addEventListener("abort", onCallerAbort, { once: true });
  }
  return {
    signal: controller.signal,
    expired,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    },
  };
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
  const timeoutMs = deps.timeoutMs ?? EXTERNAL_ASSET_TIMEOUT_MS;
  return {
    async fetch(url, opts) {
      // One deadline for the WHOLE call, redirect hops included — a per-hop
      // timer would let `maxRedirects` slow hops multiply into a stall the cap
      // was supposed to prevent.
      const deadline = createDeadline(opts.signal, timeoutMs, url);
      try {
        let current = url;
        for (let hop = 0; hop <= maxRedirects; hop++) {
          if (!policy.allow(current)) {
            throw new ExternalAssetBlockedError(
              current,
              hop === 0 ? "not on the allowed origin list" : "redirected to a disallowed origin"
            );
          }
          const res = await Promise.race([
            fetchFn(current, {
              redirect: "manual",
              credentials: "omit",
              signal: deadline.signal,
            }),
            deadline.expired,
          ]);
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
          const bytes = await readCapped(
            res,
            opts.maxBytes ?? EXTERNAL_ASSET_MAX_BYTES,
            current,
            deadline
          );
          const mediaType = res.headers.get("content-type") ?? undefined;
          return { bytes, ...(mediaType ? { mediaType } : {}) };
        }
        throw new ExternalAssetBlockedError(url, `more than ${maxRedirects} redirects`);
      } finally {
        deadline.dispose();
      }
    },
  };
}

/**
 * Read a response body, aborting as soon as `maxBytes` is exceeded or the
 * call's deadline expires. The declared `Content-Length` is checked first so an
 * oversize body costs zero bytes of heap; the streaming check then catches an
 * undeclared/lying one, and the deadline catches a body that simply stops
 * arriving without ever ending.
 */
async function readCapped(
  res: Response,
  maxBytes: number,
  url: string,
  deadline: Deadline
): Promise<Uint8Array> {
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
    const buf = new Uint8Array(await Promise.race([res.arrayBuffer(), deadline.expired]));
    if (buf.byteLength > maxBytes) throw tooLarge();
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await Promise.race([reader.read(), deadline.expired]);
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
    const { done, value } = chunk;
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
   * When set, a fetch of {@link url} is answered with a 302 to the first entry,
   * that hop with a 302 to the second, and so on; the LAST entry answers 200.
   * The final outcome is {@link allowedAfterRedirect}.
   *
   * A chain rather than a single location because the interesting bypass is
   * multi-hop: allowed → allowed → private. A one-hop fixture set cannot tell a
   * per-hop policy check apart from one that only re-checks the first bounce.
   *
   * Every fixture that sets this MUST also set {@link allowedAfterRedirect};
   * `external-asset-policy.test.ts` fails the suite if one does not, because a
   * redirect expectation nothing consumes is how this fixture set previously
   * gave false confidence.
   */
  redirectChain?: readonly string[];
  /** Final fetch outcome when {@link redirectChain} is set. */
  allowedAfterRedirect?: boolean;
}

/** A hostname and the {@link isPrivateHost} verdict it must produce. */
export interface PrivateHostFixture {
  host: string;
  private: boolean;
  reason: string;
}

/**
 * The SSRF-guard contract, asserted against {@link isPrivateHost} DIRECTLY.
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
  { host: "api.media.atlassian.com", private: false, reason: "the configured media origin" },
  { host: "8.8.8.8", private: false, reason: "ordinary public IPv4" },
  { host: "2606:4700::1111", private: false, reason: "ordinary public IPv6" },
  { host: "::ffff:8.8.8.8", private: false, reason: "IPv4-mapped PUBLIC address stays allowed" },
]);

/**
 * The cross-engine parity fixture set (spec 010 T5.4).
 *
 * A wave-2 agent extends the consumer test to run these same fixtures through
 * BOTH `utils/pdf/run-export.ts#pageResolver` and
 * `utils/docx/env.ts#sessionAssetFetcher` and assert identical outcomes — so
 * keep this an exported, self-describing array, and add cases here rather than
 * inline in any single test.
 *
 * **Every field must drive an assertion.** `external-asset-policy.test.ts`
 * iterates the whole array — `allowed` for every entry, and `redirectChain` /
 * `allowedAfterRedirect` for every entry that declares them — and fails if a
 * fixture carries a redirect expectation nothing consumes. The earlier version
 * of this array excluded redirect fixtures from the loop and hand-picked two by
 * name, so `allowedAfterRedirect` was decorative and the set looked far more
 * thorough than it was. A parity contract that does not run is not a contract.
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
      redirectChain: ["https://third-party-app.example.com/render/chart.png"],
      allowedAfterRedirect: false,
    },
    {
      name: "redirect within the allowlist",
      url: `${POLICY_FIXTURE_SITE_ORIGIN}/wiki/redirector?to=media`,
      allowed: true,
      reason: "site origin bouncing to a configured media origin stays allowed",
      redirectChain: ["https://api.media.atlassian.com/file/abc/binary"],
      allowedAfterRedirect: true,
    },
    {
      name: "multi-hop redirect ending at a private target",
      url: `${POLICY_FIXTURE_SITE_ORIGIN}/wiki/redirector?to=chain`,
      allowed: true,
      reason:
        "two allowed hops then the metadata service — the check must run on EVERY hop, not just the first bounce",
      redirectChain: [
        "https://api.media.atlassian.com/file/abc/binary?next=1",
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
      url: "https://user:secret@api.media.atlassian.com/file/abc/binary",
      allowed: false,
      reason: "never forward embedded credentials",
    },
  ]);
