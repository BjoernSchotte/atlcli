import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: fileURLToPath(new URL("../export-baseline/public", import.meta.url)),
  base: "./",
  resolve: { conditions: ["development", "browser"] },
  build: {
    outDir: fileURLToPath(
      new URL("../../.output/chrome-export-job-baseline-mv3", import.meta.url),
    ),
    emptyOutDir: true,
    target: "es2022",
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
