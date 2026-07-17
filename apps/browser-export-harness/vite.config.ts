import { defineConfig } from "vite";
import { DOCX_BROWSER_VITE_DEFINES } from "@atlcli/docx/vite";

export default defineConfig({
  base: "./",
  resolve: {
    conditions: ["browser"],
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
