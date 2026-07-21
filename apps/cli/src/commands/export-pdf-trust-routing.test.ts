/**
 * The CLI PDF path's external-asset boundary (spec 010 W2-0).
 *
 * ## What went wrong, and what this pins
 *
 * `trustRoutingPdfAssetResolver` was written for spec 004, unit-tested through
 * the real `preparePdfDocument` seam — and then composed NOWHERE. Only the DOCX
 * path wired its sibling; `exportPdf` handed `runPdfExport` a bare token
 * resolver. It was harmless only because the CLI PDF path resolves no macros,
 * so nothing could mint a `trust: "export-view"` ref. The moment `macros` is
 * passed to a PDF env — which spec 010 does for the extension — an unwrapped
 * resolver turns `<img src="http://169.254.169.254/…">` inside third-party
 * macro HTML into a request the host makes on the attacker's behalf.
 *
 * Two distinct claims, both needing a test:
 *  1. the resolver `exportPdf` builds IS policy-routed (behavioural), and
 *  2. no future construction site can quietly bypass it (structural).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfluenceClient } from "@atlcli/confluence";
import type { MacroResolutionOptions } from "@atlcli/export-macros";
import {
  assertPdfEnvMacroAssetRule,
  assertPolicyRoutedPdfAssets,
  TRUST_ROUTING_PROBE_REF,
} from "@atlcli/export-wiring/fixtures";
import { cliPdfAssetResolver, cliPdfAssets } from "./export-pdf.js";

const BASE = "https://acme.atlassian.net";
const NO_CACHE = { noCache: true } as const;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** A client stub; the router must decide before it is ever consulted. */
function client(onList: () => void = () => {}): ConfluenceClient {
  return {
    async listAttachments() {
      onList();
      return [];
    },
  } as unknown as ConfluenceClient;
}

/**
 * Record every outbound request and fail it immediately. The link-local
 * metadata address is unroutable, so an UNWRAPPED resolver would otherwise sit
 * in a connect timeout — and "slow" is not the property under test. What is:
 * whether the request is attempted at all.
 */
function recordingFetch(): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    throw new Error("connect ECONNREFUSED (stubbed transport)");
  }) as unknown as typeof fetch;
  return urls;
}

describe("CLI PDF asset resolver — trust routing", () => {
  test("the resolver the export env receives refuses an export_view-trust metadata ref", async () => {
    const urls = recordingFetch();
    await assertPolicyRoutedPdfAssets(cliPdfAssets(client(), BASE, NO_CACHE));
    // Blocked BEFORE the transport: the metadata service sees nothing at all.
    expect(urls).toEqual([]);
  });

  test("guard-the-guard: the bare token resolver attempts the request and FAILS the assertion", async () => {
    const urls = recordingFetch();
    const bare = cliPdfAssetResolver(client(), BASE, NO_CACHE);
    await expect(assertPolicyRoutedPdfAssets(bare)).rejects.toThrow(
      /not wrapped in trustRoutingPdfAssetResolver|NOT with an ExternalAssetBlockedError/
    );
    // The reason the wrapper matters, stated as an assertion: without it the
    // host really does reach out to whatever the macro HTML named.
    expect(urls.some((u) => u.includes("169.254.169.254"))).toBe(true);
  });

  test("an env that resolves macros satisfies the shared wiring rule — non-vacuously", async () => {
    recordingFetch();
    // The rule is "macros present ⇒ assets policy-routed". The CLI PDF path
    // passes no macros today, so asserting the rule against TODAY's env would
    // be vacuous; asserting it against the env the CLI would build the moment
    // macros are wired is what actually protects the seam.
    expect(
      await assertPdfEnvMacroAssetRule({
        assets: cliPdfAssets(client(), BASE, NO_CACHE),
        macros: {} as MacroResolutionOptions,
      })
    ).toBe("routed");

    await expect(
      assertPdfEnvMacroAssetRule({
        assets: cliPdfAssetResolver(client(), BASE, NO_CACHE),
        macros: {} as MacroResolutionOptions,
      })
    ).rejects.toThrow();
  });

  test("the probe ref is the shape only third-party macro HTML can produce", () => {
    // If this ever loses its `trust` marker the probe stops testing the router.
    expect(TRUST_ROUTING_PROBE_REF).toMatchObject({ kind: "external", trust: "export-view" });
  });

  test("attachment refs are untouched by the router and reach the token path", async () => {
    recordingFetch();
    let listed = 0;
    const assets = cliPdfAssets(
      client(() => {
        listed += 1;
      }),
      BASE,
      NO_CACHE
    );
    await assets
      .resolve({ kind: "attachment", filename: "a.png", pageId: "1" })
      .catch(() => undefined);
    // The attachment listing lookup is proof it reached the INNER resolver
    // rather than being diverted into the external fetcher.
    expect(listed).toBe(1);
  });
});

describe("no PDF env construction site bypasses the router", () => {
  const source = readFileSync(join(import.meta.dir, "export-pdf.ts"), "utf8");

  test("runPdfExport is only ever handed cliPdfAssets", () => {
    // The structural half. `cliPdfAssets` is the single composition point; an
    // `assets:` naming the bare resolver is the exact regression that left this
    // path unprotected for two specs.
    const assetsFields = [...source.matchAll(/\n\s*assets:\s*([A-Za-z0-9_]+)\(/g)].map((m) => m[1]);
    expect(assetsFields.length).toBeGreaterThan(0);
    expect([...new Set(assetsFields)]).toEqual(["cliPdfAssets"]);
  });

  test("cliPdfAssets composes the shared router, not a hand-rolled check", () => {
    expect(source).toContain("trustRoutingPdfAssetResolver(");
    expect(source).toContain("@atlcli/export-wiring");
  });
});
