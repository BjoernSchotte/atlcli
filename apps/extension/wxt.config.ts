import { defineConfig } from "wxt";
// Relative src import (not "@atlcli/docx/vite"): this config is loaded by
// wxt's own config loader (jiti, Node-style resolution) which does not request
// the "development" export condition — the package specifier would resolve to
// dist/ and break `bun install` (postinstall: wxt prepare) on a fresh clone
// before any build exists.
import { DOCX_BROWSER_VITE_DEFINES } from "../../packages/docx/src/vite";

// WXT config for the atlcli Chrome extension (spec 002).
//
// The `manifest` block below declares the normative MV3 fields from PLAN §2.3.
// WXT owns the generated `background.service_worker` path and the sidepanel/
// offscreen HTML asset paths; everything else here is asserted verbatim by the
// manifest-validation test (Task 2) against the built `.output/chrome-mv3/manifest.json`.
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  // WXT auto-imports (unimport): its built-in `storage`/`browser` presets run as
  // a Vite transform over EVERY module in the graph — including the workspace
  // SOURCE we consume (`packages/*`). There the bare `storage` param in the
  // confluence converter gets rewritten to `import { storage } from
  // "wxt/utils/storage"`, which then fails to resolve and breaks the bundle.
  // `imports: false` does NOT stop this (it only disables user-dir scanning), so
  // we exclude workspace source from the transform. Our own code imports
  // everything explicitly, so nothing here relies on auto-imports.
  // `exclude` is honored by the underlying unimport unplugin's file filter but
  // is absent from WXT's narrower `imports` type — cast through it.
  imports: {
    eslintrc: { enabled: false },
    exclude: [/[\\/]packages[\\/]/],
  } as Parameters<typeof defineConfig>[0]["imports"],
  manifest: {
    name: "atlcli",
    // MV3 side panel + offscreen APIs baseline (PLAN §6 risk 1).
    minimum_chrome_version: "116",
    permissions: ["sidePanel", "offscreen", "storage", "tabs"],
    // The toolbar button. Required by the `setPanelBehavior({
    // openPanelOnActionClick: true })` call the service worker already makes,
    // and by `chrome.action.setBadgeText` — the ONLY notification channel spec
    // 010 T5.6 may use, because `chrome.notifications` would need a new
    // permission and this folder ships none. `action` is a manifest KEY, not a
    // permission, so the set asserted by tests/manifest.test.ts is unchanged.
    action: {},
    // api.media.atlassian.com: Cloud 302s attachment downloads to the media
    // CDN, which answers `Access-Control-Allow-Origin: *` — incompatible with
    // the session fetch's `credentials: "include"` unless the host permission
    // exempts that hop from CORS too (spec 005 image embedding, E2E finding).
    host_permissions: ["*://*.atlassian.net/*", "https://api.media.atlassian.com/*"],
    // WASM in extension pages requires 'wasm-unsafe-eval' (Chrome >= 103).
    // Deliberately NOT 'unsafe-eval' — asserted by the Task 2 test.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
  vite: () => ({
    // Belt-and-suspenders for PLAN §6 risk 4: force Vite to resolve the
    // `browser` export condition of @atlcli/core so the Node barrel (with
    // node: imports) is never pulled into the extension bundle.
    resolve: {
      // `development` FIRST (spec 009): resolves the @atlcli/* workspace
      // packages to live src/ (their exports list the development condition
      // first), so `wxt dev` never serves stale dist/ output.
      conditions: ["development", "browser"],
    },
    // Spec 004: PizZip / docxtemplater reference the Node `Buffer.*` globals,
    // which are undefined in the MV3 panel and rejected by the output-scan gate.
    // Rewrite those member expressions to the browser-safe helpers installed by
    // `@atlcli/docx/browser-runtime` (a real shim, not a scan suppression). Bare
    // `typeof Buffer` (not a member access) is left alone — it correctly reads
    // as "undefined", keeping the libs on their Uint8Array feature-branch.
    define: { ...DOCX_BROWSER_VITE_DEFINES },
  }),
});
