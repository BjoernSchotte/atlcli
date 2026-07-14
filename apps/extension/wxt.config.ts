import { defineConfig } from "wxt";

// WXT config for the atlcli Chrome extension (spec 002).
//
// The `manifest` block below declares the normative MV3 fields from PLAN §2.3.
// WXT owns the generated `background.service_worker` path and the sidepanel/
// offscreen HTML asset paths; everything else here is asserted verbatim by the
// manifest-validation test (Task 2) against the built `.output/chrome-mv3/manifest.json`.
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
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
  }),
});
