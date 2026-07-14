import { defineConfig } from "wxt";

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
    host_permissions: ["*://*.atlassian.net/*"],
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
      conditions: ["browser"],
    },
    // Spec 004: PizZip / docxtemplater reference the Node `Buffer.*` globals,
    // which are undefined in the MV3 panel and rejected by the output-scan gate.
    // Rewrite those member expressions to the browser-safe helpers installed by
    // `utils/byte-helpers-shim.ts` (a real shim, not a scan suppression). Bare
    // `typeof Buffer` (not a member access) is left alone — it correctly reads
    // as "undefined", keeping the libs on their Uint8Array feature-branch.
    define: {
      "Buffer.from": "globalThis.__atlByteHelpers.from",
      "Buffer.alloc": "globalThis.__atlByteHelpers.alloc",
      "Buffer.isBuffer": "globalThis.__atlByteHelpers.isBuffer",
    },
  }),
});
