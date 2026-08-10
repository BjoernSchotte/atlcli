import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureExtensionBuilt, MANIFEST_PATH, OUTPUT_DIR } from "./build-helper.js";

const EXTENSION_BUILD_TIMEOUT_MS = 180_000;

/**
 * The exact, normative extension-pages CSP from PLAN §2.3. The test asserts the
 * built manifest carries THIS string verbatim — no extra sources permitted
 * (an appended `https://cdn…` would silently widen the trust boundary).
 */
export const NORMATIVE_CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";

/**
 * Pure predicate: is `csp` byte-for-byte the normative policy? Exposed so both
 * the positive assertion and a negative fixture (appended remote source) can
 * exercise it without a real build.
 */
export function isNormativeCsp(csp: unknown): boolean {
  return csp === NORMATIVE_CSP;
}

/**
 * Manifest correctness (spec 002 Task 2). Parses the BUILT
 * `.output/chrome-mv3/manifest.json` and asserts the normative PLAN §2.3 fields,
 * guarding against WXT config drift / upgrade regressions.
 */
describe("built manifest.json", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let manifest: any;

  beforeAll(() => {
    ensureExtensionBuilt();
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  }, EXTENSION_BUILD_TIMEOUT_MS);

  it("is Manifest V3", () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it("is named atlcli", () => {
    expect(manifest.name).toBe("atlcli");
  });

  it("declares the normative permissions", () => {
    expect(new Set(manifest.permissions)).toEqual(
      new Set(["sidePanel", "offscreen", "storage", "tabs"])
    );
  });

  it("declares only Atlassian, media-CDN and Anthropic host permissions", () => {
    // api.media.atlassian.com: attachment downloads 302 to the media CDN;
    // without this host permission the redirect hop falls back to normal CORS
    // and its wildcard ACAO rejects the credentialed session fetch (spec 005).
    expect(manifest.host_permissions).toEqual([
      "*://*.atlassian.net/*",
      "https://api.media.atlassian.com/*",
      "https://api.anthropic.com/*",
    ]);
  });

  it("uses a module service worker whose file exists in the output", () => {
    expect(manifest.background.type).toBe("module");
    const sw: unknown = manifest.background.service_worker;
    expect(typeof sw).toBe("string");
    expect((sw as string).length).toBeGreaterThan(0);
    // The declared SW file must actually be emitted, or Chrome errors on load.
    expect(existsSync(join(OUTPUT_DIR, sw as string))).toBe(true);
  });

  it("registers a side panel whose default_path is a real emitted html file", () => {
    const path: unknown = manifest.side_panel.default_path;
    expect(typeof path).toBe("string");
    expect(path).toMatch(/\.html$/);
    // Assert the path points at the file WXT actually produced (not merely any
    // non-empty .html string) — the file must exist in the built output.
    expect(existsSync(join(OUTPUT_DIR, path as string))).toBe(true);
  });

  it("registers the Rovo content script only on Confluence Cloud wiki pages", () => {
    const scripts: unknown = manifest.content_scripts;
    expect(Array.isArray(scripts)).toBe(true);
    const rovo = (scripts as Array<Record<string, unknown>>).find(
      (entry) =>
        Array.isArray(entry.matches) &&
        entry.matches.includes("https://*.atlassian.net/wiki/*")
    );
    expect(rovo).toBeDefined();
    expect(rovo?.matches).toEqual(["https://*.atlassian.net/wiki/*"]);
    expect(rovo?.run_at).toBe("document_start");
    expect(rovo?.world).toBe("ISOLATED");

    for (const kind of ["js", "css"] as const) {
      const files = rovo?.[kind];
      expect(Array.isArray(files)).toBe(true);
      expect((files as string[]).length).toBeGreaterThan(0);
      for (const file of files as string[]) {
        expect(existsSync(join(OUTPUT_DIR, file))).toBe(true);
      }
    }
  });

  it("sets the exact normative CSP — no extra sources", () => {
    const csp: unknown = manifest.content_security_policy.extension_pages;
    expect(csp).toBe(NORMATIVE_CSP);
    expect(isNormativeCsp(csp)).toBe(true);
  });

  it("pins the oldest Chrome version exercised by the MV3 PDF.js worker test", () => {
    expect(manifest.minimum_chrome_version).toBe("140");
  });
});

/**
 * Negative fixtures on the CSP predicate: guard specifically against an
 * appended remote source silently passing. These would go green under a
 * `.toContain("wasm-unsafe-eval")`-style loose check.
 */
describe("isNormativeCsp negative fixtures", () => {
  it("rejects an appended remote script source", () => {
    expect(
      isNormativeCsp(
        "script-src 'self' 'wasm-unsafe-eval' https://cdn.evil.example; object-src 'self'"
      )
    ).toBe(false);
  });

  it("rejects an appended object-src source", () => {
    expect(
      isNormativeCsp(
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self' https://cdn.evil.example"
      )
    ).toBe(false);
  });

  it("rejects an added unsafe-eval source", () => {
    expect(
      isNormativeCsp(
        "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; object-src 'self'"
      )
    ).toBe(false);
  });

  it("rejects trailing whitespace / near-miss variants", () => {
    expect(isNormativeCsp(NORMATIVE_CSP + " ")).toBe(false);
    expect(isNormativeCsp("script-src 'self'; object-src 'self'")).toBe(false);
  });

  it("accepts exactly the normative string", () => {
    expect(isNormativeCsp(NORMATIVE_CSP)).toBe(true);
  });
});
