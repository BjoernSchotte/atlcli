/**
 * The external-asset security boundary shared by every export host.
 *
 * ## Why this is in a package and not in a host
 *
 * `export_view`-rendered HTML is written by third-party macro apps and page
 * editors — a different trust boundary from CLI flags or panel input. Any image
 * URL it carries must go through ONE allow/reject decision and ONE fetch path,
 * or the same URL renders in one host, silently vanishes in a second, and gets
 * fetched with ambient credentials in a third. That is exactly what happened
 * while this logic lived in `apps/cli/src/commands/export-macros-wiring.ts`:
 * the extension could not import it and grew a second, divergent copy.
 *
 * ## The decision
 *
 * {@link createExternalAssetPolicy} allows the site's own origin plus an
 * explicit, host-supplied `allowedOrigins` list (default: NOTHING beyond the
 * site origin — a host widens the policy by passing origins, never by
 * inheriting a default it did not ask for), and rejects everything else, plus —
 * regardless of origin — non-http(s) schemes, credentials embedded in the URL,
 * and loopback / private / link-local / unique-local hosts (SSRF guard).
 *
 * {@link createExternalAssetFetcher} enforces that decision across the whole
 * request: `redirect: "manual"` so every `Location` hop is re-checked (an
 * allowed origin must not be usable as an open redirector into a disallowed
 * one), `credentials: "omit"` on EVERY hop, a streaming byte cap, and a
 * wall-clock deadline.
 *
 * Isomorphic by construction: `URL`, `fetch`, `AbortController` and nothing
 * else. `scripts/check-browser-build.ts` proves it.
 */
import type { ExternalAssetFetcher, ExternalAssetPolicy } from "@atlcli/export-macros";

/**
 * Byte cap for one `export_view`-sourced asset. Deliberately smaller than the
 * engines' whole-document asset budget: a single third-party image has no
 * legitimate reason to be this large, and the cap is the only thing standing
 * between a hostile response and the host's heap.
 */
export const EXTERNAL_ASSET_MAX_BYTES = 8 * 1024 * 1024;

/** Maximum redirect hops followed before giving up. */
export const EXTERNAL_ASSET_MAX_REDIRECTS = 5;

/**
 * Wall-clock budget for ONE {@link ExternalAssetFetcher.fetch} call — every
 * redirect hop plus the whole body read.
 *
 * Without it a permitted response can hold a reader open forever:
 * `redirect: "manual"` + `credentials: "omit"` bound *what* is fetched and
 * {@link EXTERNAL_ASSET_MAX_BYTES} bounds *how much*, but nothing bounded *how
 * long*. A host that sends headers, one byte, and then never sends another
 * leaves `reader.read()` pending, and — since the caller's `AbortSignal` is
 * optional — an export could sit there indefinitely. The cap is deliberately
 * generous: it exists to stop a stall, not to police a slow-but-progressing
 * download of a legitimately large image.
 */
export const EXTERNAL_ASSET_TIMEOUT_MS = 30_000;

export interface ExternalAssetPolicyOptions {
  /**
   * The site's own origin (e.g. `https://acme.atlassian.net`). Accepts a full
   * URL — only its origin is used. An unparseable value yields a policy that
   * allows nothing but the explicitly configured {@link allowedOrigins}.
   */
  siteOrigin: string;
  /**
   * Extra origins the host vouches for (e.g. the Atlassian media CDN the
   * extension manifest already grants). Defaults to NONE: widening is always an
   * explicit, reviewable act by the host, never a shared-package default.
   */
  allowedOrigins?: readonly string[];
}

/**
 * Thrown when a URL fails {@link ExternalAssetPolicy.allow}. Both engines
 * already degrade a thrown asset-resolution error into a placeholder plus a
 * report note (`pdf-image-skipped` / `image-embed-failed`), so throwing this is
 * exactly the "visible placeholder + report note" outcome — no engine change
 * required.
 */
export class ExternalAssetBlockedError extends Error {
  readonly url: string;
  constructor(url: string, reason = "not on the allowed origin list") {
    super(externalAssetBlockedMessage(url, reason));
    this.name = "ExternalAssetBlockedError";
    this.url = url;
  }
}

/** The single user-facing wording every host emits for a blocked asset. */
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

/**
 * Strip query/fragment before a URL lands in a report note: `export_view` image
 * URLs routinely carry signed-media tokens, and export reports are saved,
 * uploaded to CI artifacts, and shared.
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
 * `[::ffff:7f00:1]` — the dotted quad a suffix regex would look for is gone by
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
 * Exported so tests — and any host adapter — assert on the same predicate
 * rather than re-deriving the rule set.
 *
 * Assert against THIS function, not against `policy.allow()`, when what is
 * under test is the guard: `allow()` also rejects on origin mismatch, so a
 * private host that the guard misses still comes back `false` and the test
 * passes for the wrong reason. That is exactly how the IPv4-mapped IPv6 hole
 * survived review once already.
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
 * resolver's {@link ExternalAssetFetcher}.
 */
export function createExternalAssetPolicy(
  options: ExternalAssetPolicyOptions
): ExternalAssetPolicy {
  const siteOrigin = normalizeOrigin(options.siteOrigin);
  const extra = new Set(
    (options.allowedOrigins ?? []).map(normalizeOrigin).filter((o) => o !== "")
  );
  return {
    allow(url: string): boolean {
      let parsed: URL;
      try {
        // Relative refs resolve against the SITE origin. Never against the
        // host's own origin (`chrome-extension://…`, `file://…`), which would
        // be meaningless — and never implicitly allowed when there is no site.
        parsed = siteOrigin ? new URL(url, siteOrigin) : new URL(url);
      } catch {
        return false;
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
      // `https://user:pass@host/` — never forward embedded credentials.
      if (parsed.username !== "" || parsed.password !== "") return false;
      if (isPrivateHost(parsed.hostname)) return false;
      if (siteOrigin !== "" && parsed.origin === siteOrigin) return true;
      return extra.has(parsed.origin);
    },
  };
}

/**
 * Same-origin-only policy over a site base URL — the CLI default, and the
 * safe floor for any host that has no extra origins to vouch for.
 */
export function defaultExternalAssetPolicy(siteBaseUrl: string): ExternalAssetPolicy {
  return createExternalAssetPolicy({ siteOrigin: siteBaseUrl });
}

export interface ExternalAssetFetcherDeps {
  fetchFn?: typeof fetch;
  maxRedirects?: number;
  /** Overrides {@link EXTERNAL_ASSET_TIMEOUT_MS}. `0` disables the deadline. */
  timeoutMs?: number;
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
 * A policy-checked, redirect-re-checked, byte-capped, deadline-bounded fetcher
 * for `export_view`-sourced bytes.
 *
 * `credentials: "omit"` on every hop is not a browser-only nicety: third-party
 * macro-rendered URLs must never ride the user's Atlassian session cookies, and
 * a host that fetches them with ambient credentials turns a rendered macro into
 * a confused-deputy request.
 */
export function createExternalAssetFetcher(
  policy: ExternalAssetPolicy,
  deps: ExternalAssetFetcherDeps = {}
): ExternalAssetFetcher {
  // Late-bound on purpose. `deps.fetchFn ?? fetch` would capture whatever
  // `globalThis.fetch` was when the fetcher was CONSTRUCTED, and hosts replace
  // it afterwards — the CLI's TLS/proxy setup does, and every test that swaps
  // it does. Capturing pinned the pre-replacement implementation, which shows
  // up as a real network call from a suite that thought it had stubbed one.
  // Typed as the CALL signature, not `typeof fetch`: Bun's `fetch` carries a
  // `preconnect` static that a plain arrow cannot satisfy, and nothing here
  // needs it.
  const fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> =
    deps.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
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
            throw new Error(`External image fetch failed (${res.status}) for ${redactUrl(current)}`);
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

/** The redirect-checked, byte-capped fetcher over a policy — the host default. */
export function defaultExternalAssetFetcher(
  policy: ExternalAssetPolicy,
  deps: ExternalAssetFetcherDeps = {}
): ExternalAssetFetcher {
  return createExternalAssetFetcher(policy, deps);
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
    new Error(`External image exceeded the ${maxBytes}-byte export limit: ${redactUrl(url)}`);
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
