import { defineConfig } from "vite";
import { DOCX_BROWSER_VITE_DEFINES } from "@atlcli/docx/vite";

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
