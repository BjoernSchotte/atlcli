import { defineConfig } from "vite";
// Relative src import (not "@atlcli/docx/vite"): Vite loads this config with
// Node-style resolution that does not request the "development" export
// condition, so the package specifier would resolve to dist/ and break on a
// fresh clone before any build exists.
import { DOCX_BROWSER_VITE_DEFINES } from "../../packages/docx/src/vite";

export default defineConfig({
  base: "./",
  resolve: {
    // `development` FIRST (spec 009): resolves the @atlcli/* workspace
    // packages to live src/ (their exports list the development condition
    // first), so the dev server never serves stale dist/ output. `browser`
    // keeps the browser barrels (never the Node ones) in the bundle.
    conditions: ["development", "browser"],
  },
  define: {
    ...DOCX_BROWSER_VITE_DEFINES,
  },
  worker: {
    format: "es",
  },
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
