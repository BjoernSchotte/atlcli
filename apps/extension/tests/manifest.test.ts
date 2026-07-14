import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { ensureExtensionBuilt, MANIFEST_PATH } from "./build-helper.js";

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
  });

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

  it("declares atlassian.net host permissions", () => {
    expect(manifest.host_permissions).toEqual(["*://*.atlassian.net/*"]);
  });

  it("uses a module service worker", () => {
    expect(manifest.background.type).toBe("module");
    expect(typeof manifest.background.service_worker).toBe("string");
    expect(manifest.background.service_worker.length).toBeGreaterThan(0);
  });

  it("registers a side panel whose default_path is a real bundled html file", () => {
    expect(typeof manifest.side_panel.default_path).toBe("string");
    expect(manifest.side_panel.default_path).toMatch(/\.html$/);
  });

  it("sets a CSP that allows wasm-unsafe-eval but NOT unsafe-eval", () => {
    const csp: string = manifest.content_security_policy.extension_pages;
    expect(csp).toContain("wasm-unsafe-eval");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'self'");
    // Must not grant full unsafe-eval — only the wasm-scoped variant.
    expect(/(^|[^-])\bunsafe-eval\b/.test(csp.replace(/wasm-unsafe-eval/g, ""))).toBe(false);
  });

  it("pins a minimum chrome version for sidePanel/offscreen APIs", () => {
    expect(manifest.minimum_chrome_version).toBe("116");
  });
});
